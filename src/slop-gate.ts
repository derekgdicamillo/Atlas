/**
 * Atlas — Slop Gate
 *
 * Pre-send text filter enforcing communication style rules from SOUL.md /
 * behavioral-fixes.md. Pure regex, no LLM calls, target under 5 ms.
 *
 * Rules applied in order:
 *  1. Em dash replacement   — catches anything output-sanitizer missed
 *  2. Trailing question     — strips "Want me to X?" / "Let me know if X" tails
 *  3. Deliberation preamble — strips "Let me pull X." / "Searching now." openers
 *  4. Emoji cap             — strips excess emoji beyond 2 per message
 *  5. Rule citation         — strips "Per the IMAGE_OBSERVATION_RULE..." patterns
 *  6. System narration      — strips "Not a Google Suite task, so answering directly."
 */

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

// ============================================================
// LOG
// ============================================================

const LOG_DIR = join(dirname(dirname(import.meta.path)), "data");
const LOG_FILE = join(LOG_DIR, "slop-gate-log.jsonl");

export function logSlopViolation(entry: {
  timestamp: string;
  violations: string[];
  originalLength: number;
  rewrittenLength: number;
}): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // non-critical — never crash the send path
  }
}

// ============================================================
// RESULT TYPE
// ============================================================

export interface SlopCheckResult {
  score: number;
  violations: string[];
  rewritten: string;
}

// ============================================================
// SHARED: operate outside code spans (fenced blocks + backtick inline)
// ============================================================

function outsideCode(text: string, transform: (seg: string) => string): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return segments
    .map((seg) =>
      seg.startsWith("`") || seg.startsWith("```") ? seg : transform(seg)
    )
    .join("");
}

// ============================================================
// RULE 1: Em Dash (code-span-aware)
// output-sanitizer.ts handles spaced em dashes and " -- " already;
// this catches unspaced variants and any that slipped through.
// ============================================================

function applyEmDashRule(text: string): { changed: boolean; text: string } {
  const before = text;
  const result = outsideCode(text, (seg) =>
    seg
      // Spaced em dash (U+2014) → comma
      .replace(/\s*—\s*/g, ", ")
      // Unspaced em dash between word chars → comma
      .replace(/(\w)—(\w)/g, "$1, $2")
      // Double hyphen between word chars without spaces → comma
      .replace(/(\w)--(\w)/g, "$1, $2")
      // Spaced double hyphen (fallback for any remaining) → comma
      .replace(/\s+--\s+/g, ", ")
  );
  return { changed: result !== before, text: result };
}

// ============================================================
// RULE 2: Trailing question / offer strip
// Only fires when there is substantial content before the match (>120 chars),
// so the question is not the entire response.
// ============================================================

const TRAILING_Q_PATTERNS: RegExp[] = [
  // "Want me to X?" / "Do you want me to X?"
  /[ \t\n]+(?:Do you )?[Ww]ant me to [\s\S]{3,180}?\?\s*$/,
  // "Let me know if X."
  /[ \t\n]+Let me know if [\s\S]{3,120}?[.!?]?\s*$/,
  // "I'm here when you need me."
  /[ \t\n]+I'm here when you need me\.?\s*$/,
  // "Ready for the next X" trailing offer
  /[ \t\n]+Ready for (?:the )?next [\s\S]{3,120}?[.!?]?\s*$/,
  // "Feel free to X."
  /[ \t\n]+Feel free to [\s\S]{3,100}?[.!?]?\s*$/,
  // "What are you working on? ..."
  /[ \t\n]+What are you working on\?[^\n]*\s*$/,
];

// Minimum chars of real content that must precede a trailing question before we strip it.
// Low enough to catch short completions ("Here's the draft. Want me to tweak?") but high
// enough to avoid stripping "Want me to X?" when it IS the entire response.
const TRAILING_Q_MIN_BEFORE = 30;

function applyTrailingQRule(text: string): { changed: boolean; text: string } {
  for (const pattern of TRAILING_Q_PATTERNS) {
    const match = text.match(pattern);
    // match.index is the position where the trailing clause starts (leading whitespace included)
    if (match && typeof match.index === "number" && match.index > TRAILING_Q_MIN_BEFORE) {
      return { changed: true, text: text.slice(0, match.index).trim() };
    }
  }
  return { changed: false, text };
}

// ============================================================
// RULE 3: Deliberation preamble strip (start of message)
// Strips "Let me pull X." / "Searching now." / "Found X. Let me confirm." etc.
// Only fires at the START of the text so mid-response prose is untouched.
// ============================================================

const PREAMBLE_PATTERNS: RegExp[] = [
  // "Let me/I'll/I will <action verb> X."
  /^(?:Let me|I'll|I will) (?:pull|grab|check|look|fetch|verify|search|confirm|read|get|load|build|try|use|run|compile|review|find|scan)\b[^.!?]{5,200}[.!]\s*/,
  // "Found X. Let me confirm/verify/check Y."
  /^Found [^.!]{5,100}[.!] Let me (?:confirm|verify|check)[^.!]{0,100}[.!]\s*/,
  // "Searching now." / "Pulling X now."
  /^(?:Searching|Pulling) now[.!]\s*/,
  // "Pulling X from Y."
  /^Pulling [^.!]{5,100}[.!]\s*/,
  // "Verifying against X."
  /^Verifying (?:against )?[^.!]{5,100}[.!]\s*/,
  // "Building X now."
  /^Building [^.!]{5,100}[.!]\s*/,
];

function applyPreambleRule(text: string): { changed: boolean; text: string } {
  const trimmed = text.trimStart();
  for (const pattern of PREAMBLE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      if (rest.length > 0) {
        // Only strip when there is real content after the preamble
        return { changed: true, text: rest };
      }
    }
  }
  return { changed: false, text };
}

// ============================================================
// RULE 4: Emoji cap — strip excess beyond 2 per message
// Uses Unicode property escapes (Bun/V8 full Unicode support).
// Matches emoji characters shown as emoji (Emoji_Presentation) plus
// text characters forced into emoji presentation by U+FE0F.
// ============================================================

const EMOJI_RE = /\p{Emoji_Presentation}|\p{Emoji}️/gu;
const EMOJI_CAP = 2;

function applyEmojiCapRule(text: string): { changed: boolean; text: string } {
  let count = 0;
  let changed = false;
  const result = text.replace(EMOJI_RE, (match) => {
    count++;
    if (count > EMOJI_CAP) {
      changed = true;
      return "";
    }
    return match;
  });
  return { changed, text: changed ? result : text };
}

// ============================================================
// RULE 5: Internal rule citation strip
// Catches "Per the IMAGE_OBSERVATION_RULE, ..." anywhere in the message.
// output-sanitizer only strips these when they are a leading paragraph;
// this handles mid-message occurrences too.
// ============================================================

const RULE_CITE_PATTERNS: RegExp[] = [
  // Match "Per the X RULE, sentence." — stop at first sentence boundary (., !, ?)
  // so subsequent content on the same line is preserved.
  /Per the [A-Z][A-Z_\s-]{3,50} RULE[^.!?]*[.!?]\s*/gi,
  // Parenthesised form "(Per the X RULE ...)"
  /\(Per the [A-Z][A-Z_\s-]{3,50} RULE[^)]*\)\s*/gi,
];

function applyRuleCiteRule(text: string): { changed: boolean; text: string } {
  let result = text;
  let changed = false;
  for (const pattern of RULE_CITE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(result)) {
      changed = true;
      pattern.lastIndex = 0;
      result = result.replace(pattern, "");
    }
  }
  return { changed, text: result };
}

// ============================================================
// RULE 6: System narration strip
// Catches "Not a Google Suite task, so answering directly." and similar
// internal routing commentary that leaks into user-facing messages.
// ============================================================

const SYSTEM_NARRATION_PATTERNS: RegExp[] = [
  /Not a Google Suite task, so answering directly\.?\s*/gi,
  /Not a [A-Za-z\s]{3,30} task, so answering directly\.?\s*/gi,
];

function applySystemNarrationRule(text: string): { changed: boolean; text: string } {
  let result = text;
  let changed = false;
  for (const pattern of SYSTEM_NARRATION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(result)) {
      changed = true;
      pattern.lastIndex = 0;
      result = result.replace(pattern, "");
    }
  }
  return { changed, text: result };
}

// ============================================================
// PUBLIC: slopCheck
// ============================================================

/**
 * Check `text` for communication slop and return a cleaned version.
 *
 * @param text  Raw outbound message text
 * @returns     score (number of rule violations), violations (names), rewritten (cleaned text)
 *
 * Pure — no side effects. Caller is responsible for logging via logSlopViolation().
 */
export function slopCheck(text: string): SlopCheckResult {
  if (!text) return { score: 0, violations: [], rewritten: text };

  const violations: string[] = [];
  let result = text;

  const r1 = applyEmDashRule(result);
  if (r1.changed) { violations.push("em-dash"); result = r1.text; }

  const r2 = applyTrailingQRule(result);
  if (r2.changed) { violations.push("trailing-question"); result = r2.text; }

  const r3 = applyPreambleRule(result);
  if (r3.changed) { violations.push("deliberation-preamble"); result = r3.text; }

  const r4 = applyEmojiCapRule(result);
  if (r4.changed) { violations.push("emoji-overflow"); result = r4.text; }

  const r5 = applyRuleCiteRule(result);
  if (r5.changed) { violations.push("rule-citation"); result = r5.text; }

  const r6 = applySystemNarrationRule(result);
  if (r6.changed) { violations.push("system-narration"); result = r6.text; }

  // Tidy whitespace artifacts left by stripping
  result = result
    .replace(/[ \t]+$/gm, "")   // trailing whitespace per line
    .replace(/\n{3,}/g, "\n\n") // excess blank lines
    .replace(/[ \t]{2,}/g, " ") // internal double spaces (emoji removal artifact)
    .trim();

  return { score: violations.length, violations, rewritten: result };
}
