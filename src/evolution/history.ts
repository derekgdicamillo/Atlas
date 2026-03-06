/**
 * Atlas — Evolution History (Cross-Night Memory)
 *
 * Persistent append-only log of nightly evolution results. Enables compound
 * learning: the architect/implementer see what was tried before, what worked,
 * what keeps breaking, and what follow-ups are pending.
 *
 * Stored at data/evolution-history.json (max 90 entries, ~3 months).
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { info, warn } from "../logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const HISTORY_FILE = join(DATA_DIR, "evolution-history.json");
const METRICS_FILE = join(DATA_DIR, "evolution-metrics.json");
const MAX_HISTORY_ENTRIES = 90;

// ============================================================
// TYPES
// ============================================================

export interface EvolutionPhaseResult {
  phase: string;
  status: "ok" | "skipped" | "error";
  durationMs: number;
  costUsd: number;
  output?: string; // brief summary of what this phase produced
}

export interface EvolutionRecord {
  date: string;
  startedAt: string;
  completedAt: string;
  /** Per-phase outcomes */
  phases: EvolutionPhaseResult[];
  /** What intelligence sources had findings */
  sourcesWithFindings: string[];
  /** Changes actually implemented (file:description pairs) */
  implemented: string[];
  /** What was skipped and why */
  skipped: string[];
  /** Build pass/fail */
  buildPassed: boolean;
  /** Total cost */
  totalCostUsd: number;
  /** Total duration (seconds) */
  totalDurationSec: number;
  /** Conversation quality score from LLM audit (0-100, null if audit skipped) */
  conversationScore: number | null;
  /** Issues the audit flagged */
  conversationIssues: string[];
  /** Things to continue next night */
  followUps: string[];
  /** Error count in last 24h (from error logs) */
  errorCount24h: number;
}

export interface EvolutionMetrics {
  date: string;
  sourcesScanned: number;
  findingsCount: number;
  implementedCount: number;
  skippedCount: number;
  buildPassed: boolean;
  costUsd: number;
  durationSec: number;
  conversationScore: number | null;
  errorCountBefore: number;
  /** Filled the next night by comparing error counts */
  errorCountAfter: number | null;
}

// ============================================================
// PERSISTENCE
// ============================================================

export async function loadHistory(): Promise<EvolutionRecord[]> {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const raw = await readFile(HISTORY_FILE, "utf-8");
    return JSON.parse(raw) as EvolutionRecord[];
  } catch (err) {
    warn("evolution:history", `Failed to load history: ${err}`);
    return [];
  }
}

export async function appendHistory(record: EvolutionRecord): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const history = await loadHistory();
    history.push(record);

    // Trim to max entries (FIFO)
    while (history.length > MAX_HISTORY_ENTRIES) {
      history.shift();
    }

    await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
    info("evolution:history", `Appended evolution record for ${record.date} (${history.length} total)`);
  } catch (err) {
    warn("evolution:history", `Failed to append history: ${err}`);
  }
}

// ============================================================
// METRICS PERSISTENCE
// ============================================================

export async function loadMetrics(): Promise<EvolutionMetrics[]> {
  try {
    if (!existsSync(METRICS_FILE)) return [];
    const raw = await readFile(METRICS_FILE, "utf-8");
    return JSON.parse(raw) as EvolutionMetrics[];
  } catch {
    return [];
  }
}

export async function appendMetrics(metrics: EvolutionMetrics): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const all = await loadMetrics();
    all.push(metrics);
    while (all.length > MAX_HISTORY_ENTRIES) all.shift();
    await writeFile(METRICS_FILE, JSON.stringify(all, null, 2));
  } catch (err) {
    warn("evolution:history", `Failed to append metrics: ${err}`);
  }
}

/**
 * Fill in the errorCountAfter for last night's metrics entry.
 * Called at the start of tonight's evolution to close the loop.
 */
export async function backfillErrorCount(errorCount: number): Promise<void> {
  try {
    const all = await loadMetrics();
    if (all.length === 0) return;
    const last = all[all.length - 1];
    if (last.errorCountAfter === null) {
      last.errorCountAfter = errorCount;
      await writeFile(METRICS_FILE, JSON.stringify(all, null, 2));
      info("evolution:history", `Backfilled errorCountAfter=${errorCount} for ${last.date}`);
    }
  } catch {
    // non-critical
  }
}

// ============================================================
// QUERY HELPERS
// ============================================================

/**
 * Get the last N evolution records for context injection.
 */
export async function getRecentHistory(n = 7): Promise<EvolutionRecord[]> {
  const history = await loadHistory();
  return history.slice(-n);
}

/**
 * Find issues that appear in 3+ of the last 14 days' evolutions.
 * These are chronic problems that keep coming back.
 */
export async function getRecurringIssues(
  days = 14,
  threshold = 3,
): Promise<{ issue: string; count: number; dates: string[] }[]> {
  const history = await loadHistory();
  const recent = history.slice(-days);

  // Count occurrence of each conversation issue across nights
  const issueCounts = new Map<string, { count: number; dates: string[] }>();

  for (const record of recent) {
    for (const issue of record.conversationIssues) {
      const key = issue.toLowerCase().trim();
      const existing = issueCounts.get(key) || { count: 0, dates: [] };
      existing.count++;
      existing.dates.push(record.date);
      issueCounts.set(key, existing);
    }

    // Also check follow-ups that keep reappearing
    for (const followUp of record.followUps) {
      const key = `followup: ${followUp.toLowerCase().trim()}`;
      const existing = issueCounts.get(key) || { count: 0, dates: [] };
      existing.count++;
      existing.dates.push(record.date);
      issueCounts.set(key, existing);
    }
  }

  return [...issueCounts.entries()]
    .filter(([, v]) => v.count >= threshold)
    .map(([issue, v]) => ({ issue, count: v.count, dates: v.dates }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get pending follow-ups from the last 7 nights that haven't been resolved.
 * A follow-up is "resolved" if it appears in a later night's implemented list.
 */
export async function getPendingFollowUps(): Promise<string[]> {
  const history = await loadHistory();
  const recent = history.slice(-7);

  const allFollowUps = new Set<string>();
  const allImplemented = new Set<string>();

  for (const record of recent) {
    for (const fu of record.followUps) allFollowUps.add(fu);
    for (const impl of record.implemented) allImplemented.add(impl.toLowerCase());
  }

  // A follow-up is pending if no implemented entry contains its keywords
  return [...allFollowUps].filter((fu) => {
    const keywords = fu.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
    return !keywords.some((kw) => [...allImplemented].some((impl) => impl.includes(kw)));
  });
}

/**
 * Build a context string for injection into the architect/implementer prompts.
 * Summarizes recent history, recurring issues, and pending follow-ups.
 */
export async function buildHistoryContext(): Promise<string> {
  const [recent, recurring, followUps] = await Promise.all([
    getRecentHistory(5),
    getRecurringIssues(),
    getPendingFollowUps(),
  ]);

  if (recent.length === 0) {
    return "EVOLUTION HISTORY: No previous evolution runs recorded.";
  }

  const sections: string[] = ["EVOLUTION HISTORY (last 5 nights):"];

  for (const r of recent) {
    const impl = r.implemented.length > 0
      ? `Implemented: ${r.implemented.slice(0, 5).join("; ")}`
      : "No changes implemented";
    const score = r.conversationScore !== null
      ? ` | Conv quality: ${r.conversationScore}/100`
      : "";
    const build = r.buildPassed ? "build OK" : "BUILD FAILED";
    sections.push(
      `- ${r.date}: ${impl} | $${r.totalCostUsd.toFixed(2)} | ${build}${score}`,
    );
    if (r.followUps.length > 0) {
      sections.push(`  Follow-ups: ${r.followUps.join("; ")}`);
    }
  }

  if (recurring.length > 0) {
    sections.push("");
    sections.push("RECURRING ISSUES (appear 3+ times in last 14 days):");
    for (const r of recurring.slice(0, 5)) {
      sections.push(`- [${r.count}x] ${r.issue}`);
    }
  }

  if (followUps.length > 0) {
    sections.push("");
    sections.push("PENDING FOLLOW-UPS (from previous nights, not yet resolved):");
    for (const fu of followUps.slice(0, 8)) {
      sections.push(`- ${fu}`);
    }
  }

  // Metrics trend
  const metrics = await loadMetrics();
  const recentMetrics = metrics.slice(-7);
  if (recentMetrics.length >= 3) {
    const avgCost = recentMetrics.reduce((s, m) => s + m.costUsd, 0) / recentMetrics.length;
    const buildRate = recentMetrics.filter((m) => m.buildPassed).length / recentMetrics.length;
    const scored = recentMetrics.filter((m) => m.conversationScore !== null);
    const avgScore = scored.length > 0
      ? scored.reduce((s, m) => s + (m.conversationScore || 0), 0) / scored.length
      : null;

    sections.push("");
    sections.push("EVOLUTION METRICS (7-day trend):");
    sections.push(`  Avg cost/night: $${avgCost.toFixed(2)} | Build success: ${(buildRate * 100).toFixed(0)}%`);
    if (avgScore !== null) {
      sections.push(`  Avg conversation quality: ${avgScore.toFixed(0)}/100`);
    }
  }

  return sections.join("\n");
}

/**
 * Build a weekly scorecard for inclusion in the Sunday email.
 */
export async function buildWeeklyScorecard(): Promise<string> {
  const metrics = await loadMetrics();
  const weekMetrics = metrics.slice(-7);

  if (weekMetrics.length === 0) return "No evolution data this week.";

  const totalChanges = weekMetrics.reduce((s, m) => s + m.implementedCount, 0);
  const totalCost = weekMetrics.reduce((s, m) => s + m.costUsd, 0);
  const buildRate = weekMetrics.filter((m) => m.buildPassed).length / weekMetrics.length;
  const nightsRun = weekMetrics.length;

  const scored = weekMetrics.filter((m) => m.conversationScore !== null);
  const avgScore = scored.length > 0
    ? scored.reduce((s, m) => s + (m.conversationScore || 0), 0) / scored.length
    : null;

  // Error trend
  const withErrorData = weekMetrics.filter((m) => m.errorCountAfter !== null);
  let errorTrend = "N/A";
  if (withErrorData.length >= 2) {
    const first = withErrorData[0].errorCountBefore;
    const last = withErrorData[withErrorData.length - 1].errorCountAfter || 0;
    const delta = last - first;
    errorTrend = delta <= 0 ? `${Math.abs(delta)} fewer errors` : `${delta} more errors`;
  }

  const lines = [
    "WEEKLY EVOLUTION SCORECARD",
    "=".repeat(30),
    `Nights run: ${nightsRun}`,
    `Changes shipped: ${totalChanges}`,
    `Build success rate: ${(buildRate * 100).toFixed(0)}%`,
    `Total cost: $${totalCost.toFixed(2)}`,
    `Error trend: ${errorTrend}`,
  ];

  if (avgScore !== null) {
    lines.push(`Avg conversation quality: ${avgScore.toFixed(0)}/100`);
  }

  return lines.join("\n");
}
