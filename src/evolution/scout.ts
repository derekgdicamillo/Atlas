/**
 * Atlas — Evolution Scout (Phase 1)
 *
 * Fast intelligence synthesis layer that replaces dumping raw source data
 * into the code agent prompt. Reads all intelligence sources, analyzes them
 * through Haiku, and produces a prioritized brief of actionable findings.
 *
 * The scout's output becomes the input for the architect (Phase 3), making
 * the entire pipeline more focused and cost-effective.
 */

import { info, warn } from "../logger.ts";
import {
  scanSources,
  scanErrors,
  scanJournals,
  type EvolutionSources,
  type EvolutionErrors,
  type JournalFriction,
} from "../evolve.ts";
import { buildHistoryContext, getPendingFollowUps } from "./history.ts";

// ============================================================
// TYPES
// ============================================================

export interface ScoutFinding {
  /** Priority rank (1 = highest) */
  priority: number;
  /** Category: error_fix, security, feature, optimization, behavioral, cleanup */
  category: string;
  /** What was found and where */
  description: string;
  /** Which source produced this finding */
  source: string;
  /** Specific files/lines to investigate (if known) */
  targets: string[];
  /** Estimated effort: low, medium, high */
  effort: string;
  /** Estimated risk: low, medium, high */
  risk: string;
  /** Recommended action */
  action: string;
}

export interface ScoutReport {
  /** When the scout ran */
  timestamp: string;
  /** Total number of sources scanned */
  sourcesScanned: number;
  /** Total findings before filtering */
  rawFindingsCount: number;
  /** Curated top findings (max 10) */
  findings: ScoutFinding[];
  /** Brief executive summary */
  summary: string;
  /** Raw source data (for fallback if architect needs more detail) */
  rawSources: EvolutionSources;
  rawErrors: EvolutionErrors;
  rawJournals: JournalFriction;
  /** Evolution history context */
  historyContext: string;
}

// ============================================================
// SCOUT PROMPT
// ============================================================

function buildScoutPrompt(
  sources: EvolutionSources,
  errors: EvolutionErrors,
  journals: JournalFriction,
  historyContext: string,
  pendingFollowUps: string[],
): string {
  const sections: string[] = [];

  sections.push(
    "You are an intelligence analyst for Atlas, an AI assistant bot (Telegram + Claude CLI + Supabase).",
    "Your job: read all the intelligence below and produce a PRIORITIZED BRIEF of actionable findings.",
    "",
    "Output format (JSON array, max 10 findings, ordered by priority):",
    "```json",
    '[{"priority":1,"category":"error_fix|security|feature|optimization|behavioral|cleanup",',
    '"description":"What was found","source":"Which source","targets":["file:line if known"],',
    '"effort":"low|medium|high","risk":"low|medium|high","action":"Specific recommended action"}]',
    "```",
    "",
    "RULES:",
    "- Focus on HIGH-VALUE, LOW-RISK items. Skip noise.",
    "- Error fixes and security patches are always highest priority.",
    "- If a follow-up from a previous night is still pending, prioritize it.",
    "- Skip papers/releases that have no concrete applicability to Atlas.",
    "- Skip changelog entries that don't affect Atlas's usage patterns.",
    "- Be specific about file targets (e.g., 'src/relay.ts:processMessage').",
    "- After the JSON array, add a 2-sentence summary.",
    "",
  );

  // History context
  if (historyContext) {
    sections.push("## Previous Evolution History");
    sections.push(historyContext);
    sections.push("");
  }

  // Pending follow-ups
  if (pendingFollowUps.length > 0) {
    sections.push("## Pending Follow-Ups (from previous nights)");
    for (const fu of pendingFollowUps) {
      sections.push(`- ${fu}`);
    }
    sections.push("");
  }

  // Errors (highest priority data)
  if (errors.failures.length > 0 || errors.errorLogLines.length > 0) {
    sections.push("## Errors & Failures");
    if (errors.failureSummary) sections.push(errors.failureSummary);
    if (errors.errorLogLines.length > 0) {
      const unique = [...new Set(errors.errorLogLines.map((l) => l.substring(0, 150)))];
      sections.push("Recent error log:");
      for (const line of unique.slice(0, 20)) {
        sections.push(`  ${line}`);
      }
    }
    sections.push("");
  }

  // Journal friction
  if (journals.problems.length > 0 || journals.ideas.length > 0) {
    sections.push("## Journal Friction & Ideas");
    if (journals.problems.length > 0) {
      sections.push("Problems:");
      for (const p of journals.problems.slice(0, 10)) sections.push(`- ${p}`);
    }
    if (journals.ideas.length > 0) {
      sections.push("Ideas:");
      for (const idea of journals.ideas.slice(0, 10)) sections.push(`- ${idea}`);
    }
    sections.push("");
  }

  // OpenClaw
  if (sources.openclaw.newRelease) {
    sections.push("## OpenClaw New Release");
    sections.push(`Tag: ${sources.openclaw.newRelease.tag} | Name: ${sources.openclaw.newRelease.name}`);
    if (sources.openclaw.releaseNotes) {
      sections.push(sources.openclaw.releaseNotes.substring(0, 2000));
    }
    sections.push("");
  }
  if (sources.openclaw.commits.length > 0) {
    sections.push("## OpenClaw Commits");
    for (const c of sources.openclaw.commits.slice(0, 15)) {
      sections.push(`- ${c.sha} ${c.message}`);
    }
    sections.push("");
  }

  // Anthropic changelog
  if (sources.anthropicChangelog.length > 0) {
    sections.push("## Anthropic Changelog");
    for (const e of sources.anthropicChangelog) sections.push(`- ${e}`);
    sections.push("");
  }

  // Claude Code releases
  if (sources.claudeCodeReleases.length > 0) {
    sections.push("## Claude Code CLI Releases");
    for (const r of sources.claudeCodeReleases) sections.push(r.substring(0, 400));
    sections.push("");
  }

  // Agent papers
  if (sources.agentPapers.length > 0) {
    sections.push("## AI Agent Papers");
    for (const p of sources.agentPapers.slice(0, 10)) sections.push(`- ${p}`);
    sections.push("");
  }

  // Anthropic research
  if (sources.anthropicResearch.length > 0) {
    sections.push("## Anthropic Research");
    for (const r of sources.anthropicResearch) sections.push(`- ${r}`);
    sections.push("");
  }

  // HF daily papers
  if (sources.hfDailyPapers.length > 0) {
    sections.push("## HuggingFace Agent Papers");
    for (const p of sources.hfDailyPapers.slice(0, 8)) sections.push(`- ${p}`);
    sections.push("");
  }

  // LangGraph
  if (sources.langGraphReleases.length > 0) {
    sections.push("## LangGraph Releases");
    for (const r of sources.langGraphReleases) sections.push(r.substring(0, 400));
    sections.push("");
  }

  // Community feeds
  if (sources.communityFeeds.length > 0) {
    sections.push("## AI Community Feeds");
    for (const f of sources.communityFeeds.slice(0, 8)) sections.push(`- ${f}`);
    sections.push("");
  }

  // Agent Zero
  if (sources.agentZeroReleases.length > 0) {
    sections.push("## Agent Zero Releases");
    for (const r of sources.agentZeroReleases) sections.push(r.substring(0, 400));
    sections.push("");
  }

  // Self-audit
  if (sources.selfAudit.fixmes.length > 0 || sources.selfAudit.todos.length > 0) {
    sections.push("## Codebase Self-Audit");
    if (sources.selfAudit.fixmes.length > 0) {
      sections.push("FIXMEs:");
      for (const f of sources.selfAudit.fixmes.slice(0, 10)) sections.push(`- ${f}`);
    }
    if (sources.selfAudit.todos.length > 0) {
      sections.push("TODOs:");
      for (const t of sources.selfAudit.todos.slice(0, 10)) sections.push(`- ${t}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

// ============================================================
// PARSE SCOUT RESPONSE
// ============================================================

function parseScoutResponse(raw: string): { findings: ScoutFinding[]; summary: string } {
  // Extract JSON array from response
  const jsonMatch = raw.match(/\[[\s\S]*?\]/);
  let findings: ScoutFinding[] = [];

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        findings = parsed.map((f: any, i: number) => ({
          priority: f.priority || i + 1,
          category: f.category || "cleanup",
          description: String(f.description || ""),
          source: String(f.source || "unknown"),
          targets: Array.isArray(f.targets) ? f.targets.map(String) : [],
          effort: f.effort || "medium",
          risk: f.risk || "medium",
          action: String(f.action || ""),
        }));
      }
    } catch (err) {
      warn("evolution:scout", `Failed to parse scout JSON: ${err}`);
    }
  }

  // Extract summary (text after the JSON block)
  const afterJson = jsonMatch
    ? raw.substring((jsonMatch.index || 0) + jsonMatch[0].length).trim()
    : raw.trim();
  const summary = afterJson.substring(0, 500) || "Scout analysis complete.";

  return { findings, summary };
}

// ============================================================
// MAIN ENTRY
// ============================================================

/**
 * Run the scout phase. Gathers all intelligence sources and synthesizes
 * them into a prioritized brief via Haiku.
 *
 * @param runPrompt Callback to run a prompt through Claude (haiku)
 * @returns ScoutReport with prioritized findings
 */
export async function runScout(
  runPrompt: (prompt: string) => Promise<string>,
): Promise<ScoutReport> {
  const startTime = Date.now();
  info("evolution:scout", "Starting intelligence scan...");

  // Gather all sources in parallel
  const [sources, errors, journals, historyContext, followUps] = await Promise.all([
    scanSources(),
    Promise.resolve(scanErrors(48)),
    Promise.resolve(scanJournals(3)),
    buildHistoryContext(),
    getPendingFollowUps(),
  ]);

  // Count sources with data
  let sourcesScanned = 0;
  if (sources.openclaw.commits.length > 0 || sources.openclaw.newRelease) sourcesScanned++;
  if (sources.anthropicChangelog.length > 0) sourcesScanned++;
  if (sources.claudeCodeReleases.length > 0) sourcesScanned++;
  if (sources.agentPapers.length > 0) sourcesScanned++;
  if (sources.anthropicResearch.length > 0) sourcesScanned++;
  if (sources.hfDailyPapers.length > 0) sourcesScanned++;
  if (sources.langGraphReleases.length > 0) sourcesScanned++;
  if (sources.communityFeeds.length > 0) sourcesScanned++;
  if (sources.agentZeroReleases.length > 0) sourcesScanned++;
  if (sources.selfAudit.todos.length > 0 || sources.selfAudit.fixmes.length > 0) sourcesScanned++;
  if (errors.failures.length > 0 || errors.errorLogLines.length > 0) sourcesScanned++;
  if (journals.problems.length > 0 || journals.ideas.length > 0) sourcesScanned++;

  const rawFindingsCount = (
    sources.openclaw.commits.length +
    sources.anthropicChangelog.length +
    sources.claudeCodeReleases.length +
    sources.agentPapers.length +
    sources.anthropicResearch.length +
    sources.hfDailyPapers.length +
    sources.langGraphReleases.length +
    sources.communityFeeds.length +
    sources.agentZeroReleases.length +
    sources.selfAudit.todos.length +
    sources.selfAudit.fixmes.length +
    errors.failures.length +
    journals.problems.length +
    journals.ideas.length
  );

  // If nothing at all, skip the LLM call
  if (rawFindingsCount === 0 && followUps.length === 0) {
    info("evolution:scout", "No findings from any source. Skipping synthesis.");
    return {
      timestamp: new Date().toISOString(),
      sourcesScanned: 0,
      rawFindingsCount: 0,
      findings: [],
      summary: "All quiet. No new activity, errors, or improvements found.",
      rawSources: sources,
      rawErrors: errors,
      rawJournals: journals,
      historyContext,
    };
  }

  // Build and run the synthesis prompt
  const prompt = buildScoutPrompt(sources, errors, journals, historyContext, followUps);
  info("evolution:scout", `Synthesizing ${rawFindingsCount} raw findings from ${sourcesScanned} sources...`);

  const response = await runPrompt(prompt);
  const { findings, summary } = parseScoutResponse(response);

  const durationMs = Date.now() - startTime;
  info("evolution:scout", `Scout complete: ${findings.length} prioritized findings in ${(durationMs / 1000).toFixed(1)}s`);

  return {
    timestamp: new Date().toISOString(),
    sourcesScanned,
    rawFindingsCount,
    findings: findings.slice(0, 10), // cap at 10
    summary,
    rawSources: sources,
    rawErrors: errors,
    rawJournals: journals,
    historyContext,
  };
}

/**
 * Format the scout report into a human-readable string for Telegram/email.
 */
export function formatScoutReport(report: ScoutReport): string {
  if (report.findings.length === 0) {
    return "Scout: No actionable findings tonight.";
  }

  const lines: string[] = [
    `SCOUT REPORT (${report.sourcesScanned} sources, ${report.rawFindingsCount} raw findings)`,
    "",
  ];

  for (const f of report.findings) {
    const risk = f.risk === "high" ? "[HIGH RISK]" : f.risk === "low" ? "" : "[MED RISK]";
    lines.push(
      `${f.priority}. [${f.category.toUpperCase()}] ${f.description} ${risk}`.trim(),
    );
    if (f.action) lines.push(`   Action: ${f.action}`);
    if (f.targets.length > 0) lines.push(`   Targets: ${f.targets.join(", ")}`);
  }

  lines.push("");
  lines.push(report.summary);

  return lines.join("\n");
}
