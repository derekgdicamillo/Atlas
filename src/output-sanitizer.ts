/**
 * Atlas — Outbound Response Sanitizer
 *
 * Last line of defense between model output and Telegram. Enforces, in code,
 * the style/quality rules that advisory prompts kept failing to hold
 * (behavioral-fixes.md documents each failure class 5-30+ times):
 *
 *  1. Deliberation leakage  — scratchpad preambles ("The user just said…",
 *     "Per the IMAGE OBSERVATION RULE…", "I'm Ishtar, not Atlas…") stripped.
 *  2. Raw system errors     — spend-limit / API error strings replaced with a
 *     short human message; repeats within a window collapse to silence.
 *  3. Em dashes             — banned by SOUL.md/USER.md; replaced outside
 *     code spans.
 *
 * Everything here is deterministic and unit-tested (output-sanitizer.test.ts).
 */

// ============================================================
// 1. DELIBERATION / SCRATCHPAD LEAK FILTER
// ============================================================

/**
 * Paragraph-level heuristics for leaked internal reasoning. Applied only to
 * LEADING paragraphs — mid-response prose that happens to start with "I
 * should…" is left alone once real content has begun.
 */
const DELIBERATION_PARAGRAPH_PATTERNS: RegExp[] = [
  /^The user (just |)(said|says|wants|sent|is asking|asked)\b/i,
  /^This is (conversational|a simple|a casual|not a task)\b/i,
  /^I should (respond|answer|just|reply)\b/i,
  /^Let me (re-read|think|figure out) /i,
  /^Per the [A-Z][A-Z_ -]+ (RULE|rule)[,:]? /,
  /^I'm (Ishtar|Atlas|Annabeth), not (Ishtar|Atlas|Annabeth)\b/i,
  /^(Okay|OK|Alright)[,.]? (so |)the user\b/i,
  /^Wait[,—-] no\b/i,
];

/** Inline internal-state commentary that should never surface. */
const INLINE_INTERNAL_PATTERNS: RegExp[] = [
  /\(Quick note: the workflow keyword flag[^)]*\)/gi,
  /\(verified: [^)]{0,120}\)/gi,
  /\[REORIENTED\]/g,
];

function stripDeliberation(text: string): string {
  const paragraphs = text.split(/\n\n+/);
  let start = 0;
  while (
    start < paragraphs.length - 1 && // never strip the entire response
    DELIBERATION_PARAGRAPH_PATTERNS.some((p) => p.test(paragraphs[start].trim()))
  ) {
    start++;
  }
  let result = paragraphs.slice(start).join("\n\n");
  for (const p of INLINE_INTERNAL_PATTERNS) {
    p.lastIndex = 0;
    result = result.replace(p, "");
  }
  return result;
}

// ============================================================
// 2. RAW SYSTEM-ERROR HUMANIZATION
// ============================================================

interface ErrorRule {
  pattern: RegExp;
  replacement: string;
  /** Key used for repeat suppression */
  key: string;
}

const ERROR_RULES: ErrorRule[] = [
  {
    pattern: /You've hit your (monthly |)(spend|usage) limit[^\n]*/gi,
    replacement:
      "I've hit my monthly usage limit. Once it's raised at claude.ai/settings/usage, resend your message.",
    key: "spend-limit",
  },
  {
    pattern: /(Claude AI usage limit reached|usage limit reached\|\d+)[^\n]*/gi,
    replacement:
      "I've hit a usage limit. Give it a bit and resend your message.",
    key: "usage-limit",
  },
  {
    pattern: /API Error: \d{3}[^\n]*/g,
    replacement: "I hit a temporary system error. Give me a moment and try again.",
    key: "api-error",
  },
  {
    pattern: /\b\d{3} \{"type":"error"[^\n]*/g,
    replacement: "I hit a temporary system error. Give me a moment and try again.",
    key: "api-error",
  },
  {
    pattern: /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/g,
    replacement: "I'm having a connection hiccup. Give me a moment and try again.",
    key: "network-error",
  },
];

/**
 * Detect whether a response is *nothing but* a raw error (after trimming).
 * Those get fully replaced; embedded matches get replaced inline.
 */
function humanizeErrors(text: string): { text: string; errorKey: string | null } {
  let errorKey: string | null = null;
  let result = text;
  for (const rule of ERROR_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(result)) {
      errorKey = rule.key;
      rule.pattern.lastIndex = 0;
      result = result.replace(rule.pattern, rule.replacement);
    }
  }
  // Collapse duplicate adjacent replacement lines left by multi-line errors
  result = result.replace(/^(.+)(\n\1)+$/gm, "$1");
  return { text: result, errorKey };
}

// ============================================================
// 3. EM-DASH FILTER (code-span aware)
// ============================================================

/**
 * Replace em dashes outside code fences/inline code. Spaced em dashes become
 * commas (reads naturally); unspaced become hyphens (ranges like 3—5).
 */
function stripEmDashes(text: string): string {
  // Split on fenced blocks and inline code, transform only prose segments.
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith("```") || (seg.startsWith("`") && seg.endsWith("`"))) continue;
    segments[i] = seg
      .replace(/\s+—\s+/g, ", ")
      .replace(/—/g, "-")
      .replace(/(\w) -- (\w)/g, "$1, $2");
  }
  return segments.join("");
}

// ============================================================
// REPEAT-ERROR SUPPRESSION
// ============================================================

const REPEAT_WINDOW_MS = 10 * 60 * 1000;
const lastErrorByChat = new Map<string, { key: string; at: number }>();

/**
 * True when the same error class already went to this chat within the window.
 * Callers should skip delivery entirely (silence beats spam — the 06-15
 * spend-limit string went out 5x in a row).
 */
export function isRepeatErrorForChat(chatId: string, errorKey: string, now = Date.now()): boolean {
  const prev = lastErrorByChat.get(chatId);
  lastErrorByChat.set(chatId, { key: errorKey, at: now });
  return !!prev && prev.key === errorKey && now - prev.at < REPEAT_WINDOW_MS;
}

/** Reset suppression state (tests). */
export function resetErrorSuppression(): void {
  lastErrorByChat.clear();
}

// ============================================================
// PUBLIC API
// ============================================================

export interface SanitizeResult {
  text: string;
  /** Non-null when a raw system error was detected and humanized */
  errorKey: string | null;
}

export function sanitizeOutbound(text: string): SanitizeResult {
  if (!text) return { text, errorKey: null };
  let result = stripDeliberation(text);
  const { text: humanized, errorKey } = humanizeErrors(result);
  result = stripEmDashes(humanized);
  // Tidy whitespace artifacts left by stripping
  result = result.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return { text: result, errorKey };
}
