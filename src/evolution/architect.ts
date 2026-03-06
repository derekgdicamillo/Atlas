/**
 * Atlas — Evolution Architect (Phase 3)
 *
 * Receives the scout's prioritized brief + conversation audit results +
 * evolution history, and designs a concrete implementation plan for the
 * code agent (implementer). Sonnet-powered, read-only (no file edits).
 *
 * The architect's output is a structured plan that tells the implementer
 * exactly what files to modify, what changes to make, and in what order.
 */

import { info, warn } from "../logger.ts";
import type { ScoutReport, ScoutFinding } from "./scout.ts";
import type { ConversationAudit } from "./audit.ts";

// ============================================================
// TYPES
// ============================================================

export interface ArchitectChange {
  /** Sequential order of implementation */
  order: number;
  /** What to change */
  description: string;
  /** Target file(s) */
  files: string[];
  /** What function/section to modify */
  target: string;
  /** Specific instructions for the implementer */
  instructions: string;
  /** Risk level */
  risk: "low" | "medium" | "high";
  /** How to verify this change works */
  verification: string;
  /** Which scout finding this addresses */
  addressesFinding: number;
}

export interface ArchitectPlan {
  /** When the plan was created */
  timestamp: string;
  /** High-level summary of what the plan does */
  summary: string;
  /** Ordered list of changes */
  changes: ArchitectChange[];
  /** Items explicitly skipped and why */
  skipped: Array<{ finding: number; reason: string }>;
  /** Rollback strategy if things go wrong */
  rollbackPlan: string;
  /** Estimated total risk */
  overallRisk: "low" | "medium" | "high";
  /** Duration of architect phase */
  durationMs: number;
}

// ============================================================
// ARCHITECT PROMPT
// ============================================================

function buildArchitectPrompt(
  scoutReport: ScoutReport,
  audit: ConversationAudit,
  historyContext: string,
): string {
  const sections: string[] = [
    "You are the evolution architect for Atlas, a Telegram bot built on Claude CLI + Supabase.",
    "The scout has analyzed intelligence sources and the auditor has graded conversation quality.",
    "Your job: design a CONCRETE implementation plan for the code agent.",
    "",
    "CONSTRAINTS:",
    "- Only plan changes that are clearly beneficial and low-risk.",
    "- Do NOT plan changes to .env, credentials, or security-sensitive files.",
    "- Do NOT plan changes to external behavior (Telegram messages, CRM actions) without feature flags.",
    "- Focus on: bug fixes, error handling, code quality, internal improvements, prompt tuning.",
    "- The implementer has full file access (Bash, Read, Write, Edit) and runs `bun build` to verify.",
    "- Budget: the implementer has 60 min and $5. Plan accordingly (max 5-7 changes).",
    "",
    "Output format (JSON):",
    "```json",
    "{",
    '  "summary": "1-2 sentence plan summary",',
    '  "changes": [',
    "    {",
    '      "order": 1,',
    '      "description": "What to change",',
    '      "files": ["src/file.ts"],',
    '      "target": "functionName or section",',
    '      "instructions": "Specific implementation instructions",',
    '      "risk": "low|medium|high",',
    '      "verification": "How to verify this works",',
    '      "addressesFinding": 1',
    "    }",
    "  ],",
    '  "skipped": [{"finding": 3, "reason": "Too risky without tests"}],',
    '  "rollbackPlan": "If build fails, revert changes to X and Y",',
    '  "overallRisk": "low|medium|high"',
    "}",
    "```",
    "",
  ];

  // Scout findings
  if (scoutReport.findings.length > 0) {
    sections.push("## Scout Findings (prioritized)");
    for (const f of scoutReport.findings) {
      sections.push(`${f.priority}. [${f.category}] ${f.description}`);
      sections.push(`   Source: ${f.source} | Effort: ${f.effort} | Risk: ${f.risk}`);
      if (f.targets.length > 0) sections.push(`   Targets: ${f.targets.join(", ")}`);
      sections.push(`   Action: ${f.action}`);
    }
    sections.push("");
  }

  // Conversation audit
  if (audit.overallScore >= 0) {
    sections.push("## Conversation Audit");
    sections.push(`Overall score: ${audit.overallScore}/100`);

    for (const g of audit.grades) {
      sections.push(`  ${g.session}: ${g.grade} (${g.score})`);
      for (const issue of g.issues) {
        sections.push(`    [${issue.severity}] ${issue.type}: ${issue.description}`);
        if (issue.suggestedFix) sections.push(`    Fix: ${issue.suggestedFix}`);
      }
    }

    if (audit.improvements.length > 0) {
      sections.push("  Top improvements:");
      for (const imp of audit.improvements) sections.push(`    - ${imp}`);
    }
    sections.push("");
  }

  // Regex review supplement
  if (audit.regexReview?.hasIssues) {
    sections.push("## Regex-Detected Issues (supplement)");
    for (const issue of audit.regexReview.issues.slice(0, 10)) {
      sections.push(`  [${issue.type}] ${issue.evidence}`);
    }
    sections.push("");
  }

  // History context
  if (historyContext) {
    sections.push("## Evolution History");
    sections.push(historyContext);
    sections.push("");
  }

  return sections.join("\n");
}

// ============================================================
// PARSE ARCHITECT RESPONSE
// ============================================================

function parseArchitectResponse(raw: string): Omit<ArchitectPlan, "timestamp" | "durationMs"> {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    warn("evolution:architect", "No JSON found in architect response");
    return {
      summary: "Architect failed to produce a structured plan.",
      changes: [],
      skipped: [],
      rollbackPlan: "No rollback plan generated.",
      overallRisk: "high",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      summary: String(parsed.summary || ""),
      changes: Array.isArray(parsed.changes)
        ? parsed.changes.map((c: any, i: number) => ({
            order: c.order || i + 1,
            description: String(c.description || ""),
            files: Array.isArray(c.files) ? c.files.map(String) : [],
            target: String(c.target || ""),
            instructions: String(c.instructions || ""),
            risk: (["low", "medium", "high"].includes(c.risk) ? c.risk : "medium") as "low" | "medium" | "high",
            verification: String(c.verification || ""),
            addressesFinding: c.addressesFinding || 0,
          }))
        : [],
      skipped: Array.isArray(parsed.skipped)
        ? parsed.skipped.map((s: any) => ({
            finding: s.finding || 0,
            reason: String(s.reason || ""),
          }))
        : [],
      rollbackPlan: String(parsed.rollbackPlan || "Revert all changed files."),
      overallRisk: (["low", "medium", "high"].includes(parsed.overallRisk)
        ? parsed.overallRisk
        : "medium") as "low" | "medium" | "high",
    };
  } catch (err) {
    warn("evolution:architect", `Failed to parse architect JSON: ${err}`);
    return {
      summary: "Architect response could not be parsed.",
      changes: [],
      skipped: [],
      rollbackPlan: "No rollback plan.",
      overallRisk: "high",
    };
  }
}

// ============================================================
// MAIN ENTRY
// ============================================================

/**
 * Run the architect phase. Takes scout report + audit results and designs
 * an implementation plan.
 *
 * @param runPrompt Callback to run a prompt through Claude (sonnet)
 * @param scoutReport Output from Phase 1
 * @param audit Output from Phase 2
 * @returns ArchitectPlan with ordered changes
 */
export async function runArchitect(
  runPrompt: (prompt: string) => Promise<string>,
  scoutReport: ScoutReport,
  audit: ConversationAudit,
): Promise<ArchitectPlan> {
  const startTime = Date.now();
  info("evolution:architect", "Designing implementation plan...");

  // Skip if no findings
  if (scoutReport.findings.length === 0 && audit.overallScore < 0) {
    info("evolution:architect", "No findings to plan for. Skipping.");
    return {
      timestamp: new Date().toISOString(),
      summary: "Nothing to implement tonight.",
      changes: [],
      skipped: [],
      rollbackPlan: "N/A",
      overallRisk: "low",
      durationMs: Date.now() - startTime,
    };
  }

  const prompt = buildArchitectPrompt(scoutReport, audit, scoutReport.historyContext);
  const response = await runPrompt(prompt);
  const plan = parseArchitectResponse(response);

  const durationMs = Date.now() - startTime;
  info("evolution:architect", `Plan complete: ${plan.changes.length} changes, ${plan.skipped.length} skipped, risk: ${plan.overallRisk} (${(durationMs / 1000).toFixed(1)}s)`);

  return {
    ...plan,
    timestamp: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Format the architect plan into a code agent prompt.
 * This becomes the input for the implementer (Phase 4).
 */
export function formatPlanForImplementer(plan: ArchitectPlan): string {
  if (plan.changes.length === 0) return "";

  const sections: string[] = [
    "You are Atlas's nightly evolution implementer. The architect has designed a plan.",
    "Execute each change IN ORDER. After all changes, run `bun build` to verify.",
    "",
    `PLAN SUMMARY: ${plan.summary}`,
    `OVERALL RISK: ${plan.overallRisk}`,
    `ROLLBACK: ${plan.rollbackPlan}`,
    "",
    "IMPORTANT RULES:",
    "- Only implement changes that are clearly beneficial and low-risk",
    "- Do NOT break existing functionality",
    "- Do NOT modify .env, credentials, or security-sensitive files",
    "- Do NOT change external behavior without feature flags",
    "- Write clean TypeScript matching existing codebase style",
    "- After implementing, write a summary to data/task-output/nightly-evolution.md",
    "",
    "CHANGES TO IMPLEMENT:",
    "",
  ];

  for (const c of plan.changes) {
    sections.push(`### Change ${c.order}: ${c.description}`);
    sections.push(`Files: ${c.files.join(", ")}`);
    sections.push(`Target: ${c.target}`);
    sections.push(`Risk: ${c.risk}`);
    sections.push(`Instructions: ${c.instructions}`);
    sections.push(`Verification: ${c.verification}`);
    sections.push("");
  }

  if (plan.skipped.length > 0) {
    sections.push("SKIPPED (do not implement these):");
    for (const s of plan.skipped) {
      sections.push(`- Finding #${s.finding}: ${s.reason}`);
    }
    sections.push("");
  }

  sections.push(
    "OUTPUT:",
    "After making changes, write a markdown report to data/task-output/nightly-evolution.md with:",
    "- Date and summary",
    "- What you implemented (file, line, what changed, why)",
    "- What errors you fixed",
    "- What you skipped and why",
    "- Build status (pass/fail)",
  );

  return sections.join("\n");
}
