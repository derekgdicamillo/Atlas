/**
 * Atlas — Evolution Conversation Audit (Phase 2)
 *
 * Replaces the regex-based reviewConversations() from evolve.ts with actual
 * LLM-powered analysis of yesterday's conversations. Sonnet reads conversation
 * transcripts and evaluates Atlas's performance on multiple dimensions.
 *
 * Runs in parallel with the scout (Phase 1) since they're independent.
 */

import { readFile, readdir } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { info, warn } from "../logger.ts";
import { reviewConversations, type ConversationReview } from "../evolve.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const CONVERSATIONS_DIR = join(PROJECT_DIR, "data", "conversations");
const MEMORY_DIR = join(PROJECT_DIR, "memory");
const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";

// ============================================================
// TYPES
// ============================================================

export interface ConversationGrade {
  /** Session key */
  session: string;
  /** Overall grade A-F */
  grade: string;
  /** Numerical score 0-100 */
  score: number;
  /** What Atlas did well */
  strengths: string[];
  /** Where Atlas fell short */
  weaknesses: string[];
  /** Specific behavioral issues */
  issues: Array<{
    type: string;
    description: string;
    severity: "critical" | "warning" | "minor";
    suggestedFix: string;
  }>;
}

export interface ConversationAudit {
  /** When the audit ran */
  timestamp: string;
  /** How many conversations were audited */
  conversationsAudited: number;
  /** Aggregate score (0-100) */
  overallScore: number;
  /** Per-conversation grades */
  grades: ConversationGrade[];
  /** Top 5 actionable improvements (aggregated across all conversations) */
  improvements: string[];
  /** Regex-based review as fallback/supplement */
  regexReview: ConversationReview;
  /** Duration of the audit */
  durationMs: number;
}

// ============================================================
// AUDIT PROMPT
// ============================================================

function buildAuditPrompt(conversations: Array<{ session: string; entries: any[] }>): string {
  const sections: string[] = [
    "You are evaluating Atlas (an AI assistant bot) on its conversational quality.",
    "Atlas assists Derek (a med spa owner) via Telegram. Atlas should be: direct, helpful,",
    "proactive, personality-rich, and complete tasks without dropping them.",
    "",
    "For each conversation below, grade on these dimensions:",
    "1. Task completion (did Atlas finish what was asked?)",
    "2. Understanding (did Atlas correctly interpret the request?)",
    "3. Response quality (concise, helpful, on-topic, not over-explaining?)",
    "4. Personality (casual, direct, dry wit, not robotic or filler-heavy?)",
    "5. Proactiveness (did Atlas take initiative or just wait for instructions?)",
    "",
    "Output format (JSON):",
    "```json",
    "{",
    '  "grades": [',
    "    {",
    '      "session": "session_key",',
    '      "grade": "A|B|C|D|F",',
    '      "score": 0-100,',
    '      "strengths": ["what went well"],',
    '      "weaknesses": ["what fell short"],',
    '      "issues": [{"type":"dropped_task|misunderstanding|context_loss|went_silent|premature_cant|over_explaining|filler_heavy","description":"specific issue","severity":"critical|warning|minor","suggestedFix":"how to fix it"}]',
    "    }",
    "  ],",
    '  "improvements": ["top 5 actionable improvements across all conversations"]',
    "}",
    "```",
    "",
    "Grading scale: A=90-100, B=80-89, C=70-79, D=60-69, F=<60",
    "Be honest and specific. Derek wants to know where Atlas fails, not get praised.",
    "",
  ];

  for (const conv of conversations) {
    sections.push(`## Session: ${conv.session}`);
    const entries = conv.entries.slice(-20); // last 20 entries
    for (const e of entries) {
      const time = e.timestamp
        ? new Date(e.timestamp).toLocaleTimeString("en-US", { timeZone: TIMEZONE, hour: "numeric", minute: "2-digit" })
        : "?";
      const role = e.role === "user" ? "User" : e.role === "system" ? "System" : "Atlas";
      const content = (e.content || "").substring(0, 500);
      sections.push(`[${time}] ${role}: ${content}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

// ============================================================
// PARSE AUDIT RESPONSE
// ============================================================

function parseAuditResponse(raw: string): { grades: ConversationGrade[]; improvements: string[] } {
  // Extract JSON from response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    warn("evolution:audit", "No JSON found in audit response");
    return { grades: [], improvements: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    const grades: ConversationGrade[] = (parsed.grades || []).map((g: any) => ({
      session: String(g.session || "unknown"),
      grade: String(g.grade || "C"),
      score: typeof g.score === "number" ? g.score : 70,
      strengths: Array.isArray(g.strengths) ? g.strengths.map(String) : [],
      weaknesses: Array.isArray(g.weaknesses) ? g.weaknesses.map(String) : [],
      issues: Array.isArray(g.issues)
        ? g.issues.map((i: any) => ({
            type: String(i.type || "unknown"),
            description: String(i.description || ""),
            severity: i.severity || "minor",
            suggestedFix: String(i.suggestedFix || ""),
          }))
        : [],
    }));

    const improvements: string[] = Array.isArray(parsed.improvements)
      ? parsed.improvements.map(String).slice(0, 5)
      : [];

    return { grades, improvements };
  } catch (err) {
    warn("evolution:audit", `Failed to parse audit JSON: ${err}`);
    return { grades: [], improvements: [] };
  }
}

// ============================================================
// MAIN ENTRY
// ============================================================

/**
 * Run the conversation audit. Reads yesterday's conversation ring buffers
 * and sends them to Sonnet for quality analysis.
 *
 * @param runPrompt Callback to run a prompt through Claude (sonnet)
 * @returns ConversationAudit with grades and improvements
 */
export async function runAudit(
  runPrompt: (prompt: string) => Promise<string>,
): Promise<ConversationAudit> {
  const startTime = Date.now();
  info("evolution:audit", "Starting conversation audit...");

  // Also run the regex-based review as supplement
  const regexReview = reviewConversations(1);

  // Load yesterday's conversation ring buffers
  const conversations: Array<{ session: string; entries: any[] }> = [];

  try {
    if (existsSync(CONVERSATIONS_DIR)) {
      const files = await readdir(CONVERSATIONS_DIR);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      for (const file of jsonFiles) {
        try {
          const filePath = join(CONVERSATIONS_DIR, file);
          const content = await readFile(filePath, "utf-8");
          const entries = JSON.parse(content);

          if (!Array.isArray(entries) || entries.length === 0) continue;

          // Check if this conversation has entries from yesterday
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStr = yesterday.toLocaleDateString("en-CA", { timeZone: TIMEZONE });

          const hasYesterdayEntries = entries.some((e: any) => {
            if (!e.timestamp) return false;
            const entryDate = new Date(e.timestamp).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
            return entryDate === yesterdayStr;
          });

          if (hasYesterdayEntries && entries.length >= 2) {
            conversations.push({
              session: file.replace(".json", ""),
              entries,
            });
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch (err) {
    warn("evolution:audit", `Failed to read conversation files: ${err}`);
  }

  // Also read yesterday's journal for additional context
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const journalPath = join(MEMORY_DIR, `${yesterdayStr}.md`);
  let journalContent = "";
  if (existsSync(journalPath)) {
    try {
      journalContent = readFileSync(journalPath, "utf-8");
    } catch { /* skip */ }
  }

  // If no conversations to audit, return minimal result
  if (conversations.length === 0) {
    info("evolution:audit", "No conversations from yesterday to audit.");
    return {
      timestamp: new Date().toISOString(),
      conversationsAudited: 0,
      overallScore: -1, // -1 = no data
      grades: [],
      improvements: [],
      regexReview,
      durationMs: Date.now() - startTime,
    };
  }

  // Cap at 5 conversations to keep cost reasonable
  const toAudit = conversations.slice(0, 5);
  info("evolution:audit", `Auditing ${toAudit.length} conversations from yesterday...`);

  // Build and run the audit prompt
  const prompt = buildAuditPrompt(toAudit);
  const response = await runPrompt(prompt);
  const { grades, improvements } = parseAuditResponse(response);

  // Calculate overall score
  const scoredGrades = grades.filter((g) => g.score >= 0);
  const overallScore = scoredGrades.length > 0
    ? Math.round(scoredGrades.reduce((s, g) => s + g.score, 0) / scoredGrades.length)
    : -1;

  const durationMs = Date.now() - startTime;
  info("evolution:audit", `Audit complete: ${grades.length} graded, overall score: ${overallScore}/100 (${(durationMs / 1000).toFixed(1)}s)`);

  return {
    timestamp: new Date().toISOString(),
    conversationsAudited: toAudit.length,
    overallScore,
    grades,
    improvements,
    regexReview,
    durationMs,
  };
}

/**
 * Format the audit into a human-readable string for the architect prompt.
 */
export function formatAuditForArchitect(audit: ConversationAudit): string {
  if (audit.conversationsAudited === 0 && !audit.regexReview.hasIssues) {
    return "CONVERSATION AUDIT: No conversations from yesterday to audit.";
  }

  const sections: string[] = [];

  // LLM audit results
  if (audit.grades.length > 0) {
    sections.push(`CONVERSATION AUDIT (${audit.conversationsAudited} conversations, score: ${audit.overallScore}/100)`);

    for (const g of audit.grades) {
      sections.push(`\n  ${g.session}: ${g.grade} (${g.score}/100)`);
      if (g.weaknesses.length > 0) {
        for (const w of g.weaknesses) sections.push(`    - ${w}`);
      }
      for (const issue of g.issues) {
        const sev = issue.severity === "critical" ? "!!!" : issue.severity === "warning" ? "!!" : "!";
        sections.push(`    ${sev} [${issue.type}] ${issue.description}`);
        if (issue.suggestedFix) sections.push(`       Fix: ${issue.suggestedFix}`);
      }
    }

    if (audit.improvements.length > 0) {
      sections.push("\n  Top improvements:");
      for (const imp of audit.improvements) sections.push(`    - ${imp}`);
    }
  }

  // Supplement with regex findings
  if (audit.regexReview.hasIssues) {
    sections.push("\n  Regex-detected issues (supplement):");
    for (const issue of audit.regexReview.issues.slice(0, 10)) {
      sections.push(`    [${issue.type}] [${issue.date}] ${issue.evidence}`);
    }
  }

  return sections.join("\n");
}

/**
 * Format a compact audit summary for Telegram notification.
 */
export function formatAuditSummary(audit: ConversationAudit): string {
  if (audit.conversationsAudited === 0) return "No conversations to audit.";

  const gradeDistribution = new Map<string, number>();
  for (const g of audit.grades) {
    gradeDistribution.set(g.grade, (gradeDistribution.get(g.grade) || 0) + 1);
  }
  const dist = [...gradeDistribution.entries()].map(([g, n]) => `${n}x${g}`).join(", ");

  const issueCount = audit.grades.reduce((s, g) => s + g.issues.length, 0);

  return `Conversation audit: ${audit.overallScore}/100 (${dist}) | ${issueCount} issue(s)`;
}
