/**
 * Atlas -- JSONL Run Logging (OpenClaw cron/runs pattern)
 *
 * Persists per-job execution history as append-only JSONL files.
 * Each cron job gets its own file: data/cron-runs/{jobName}.jsonl
 *
 * Provides:
 * - appendRun()       -- log a job execution
 * - queryRuns()       -- read recent runs for a job
 * - getRecentFailures() -- find failures across all jobs
 * - cleanupOldRuns()  -- trim logs older than retention period
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { info, warn } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const RUNS_DIR = join(PROJECT_DIR, "data", "cron-runs");
const RETENTION_DAYS = 30;

// ============================================================
// TYPES
// ============================================================

export interface CronRun {
  ts: number;
  jobName: string;
  status: "ok" | "error" | "timeout" | "skipped";
  durationMs: number;
  summary?: string;
  error?: string;
}

// ============================================================
// WRITE
// ============================================================

function ensureRunsDir(): void {
  if (!existsSync(RUNS_DIR)) {
    mkdirSync(RUNS_DIR, { recursive: true });
  }
}

/** Append a run entry for a job. */
export function appendRun(jobName: string, run: CronRun): void {
  try {
    ensureRunsDir();
    const file = join(RUNS_DIR, `${sanitize(jobName)}.jsonl`);
    appendFileSync(file, JSON.stringify(run) + "\n");
  } catch (err) {
    warn("run-log", `Failed to log run for ${jobName}: ${err}`);
  }
}

// ============================================================
// READ
// ============================================================

/** Get recent runs for a job (newest first). */
export function queryRuns(jobName: string, limit = 10): CronRun[] {
  try {
    const file = join(RUNS_DIR, `${sanitize(jobName)}.jsonl`);
    if (!existsSync(file)) return [];

    const lines = readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim());

    return lines
      .map((l) => {
        try { return JSON.parse(l) as CronRun; } catch { return null; }
      })
      .filter(Boolean)
      .slice(-limit)
      .reverse() as CronRun[];
  } catch {
    return [];
  }
}

/** Get recent failures across ALL jobs within the last N hours. */
export function getRecentFailures(hours = 24): CronRun[] {
  try {
    ensureRunsDir();
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const failures: CronRun[] = [];

    for (const file of readdirSync(RUNS_DIR)) {
      if (!file.endsWith(".jsonl")) continue;
      const lines = readFileSync(join(RUNS_DIR, file), "utf-8")
        .split("\n")
        .filter((l) => l.trim());

      for (const line of lines) {
        try {
          const run = JSON.parse(line) as CronRun;
          if (run.ts >= cutoff && (run.status === "error" || run.status === "timeout")) {
            failures.push(run);
          }
        } catch { /* skip malformed */ }
      }
    }

    return failures.sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

/** Get all job names that have run logs. */
export function listJobNames(): string[] {
  try {
    if (!existsSync(RUNS_DIR)) return [];
    return readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(".jsonl", ""));
  } catch {
    return [];
  }
}

// ============================================================
// FORMAT (for /runs command)
// ============================================================

/** Format runs for Telegram display. */
export function formatRuns(jobName: string, runs: CronRun[]): string {
  if (runs.length === 0) return `No run history for "${jobName}".`;

  const lines = [`Recent runs for "${jobName}":\n`];
  for (const run of runs) {
    const time = new Date(run.ts).toLocaleString("en-US", { timeZone: "America/Phoenix", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const dur = run.durationMs < 1000 ? `${run.durationMs}ms` : `${Math.round(run.durationMs / 1000)}s`;
    const icon = run.status === "ok" ? "OK" : run.status === "skipped" ? "SKIP" : "FAIL";
    const err = run.error ? ` -- ${run.error.substring(0, 80)}` : "";
    lines.push(`  ${icon} ${time} (${dur})${err}`);
  }
  return lines.join("\n");
}

/** Format failure summary for morning brief or /status. */
export function formatFailureSummary(failures: CronRun[]): string {
  if (failures.length === 0) return "";
  const lines = [`Cron failures (last 24h): ${failures.length}`];
  for (const f of failures.slice(0, 5)) {
    const time = new Date(f.ts).toLocaleString("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit" });
    lines.push(`  ${f.jobName} at ${time}: ${f.error || f.status}`);
  }
  if (failures.length > 5) lines.push(`  ... and ${failures.length - 5} more`);
  return lines.join("\n");
}

// ============================================================
// CLEANUP
// ============================================================

/** Remove run entries older than retention period. */
export function cleanupOldRuns(): number {
  try {
    if (!existsSync(RUNS_DIR)) return 0;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let trimmed = 0;

    for (const file of readdirSync(RUNS_DIR)) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(RUNS_DIR, file);
      const lines = readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim());

      const kept: string[] = [];
      for (const line of lines) {
        try {
          const run = JSON.parse(line) as CronRun;
          if (run.ts >= cutoff) {
            kept.push(line);
          } else {
            trimmed++;
          }
        } catch {
          // Drop malformed lines
          trimmed++;
        }
      }

      if (kept.length < lines.length) {
        writeFileSync(filePath, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
      }
    }

    if (trimmed > 0) {
      info("run-log", `Cleaned up ${trimmed} old run entries (>${RETENTION_DAYS}d)`);
    }
    return trimmed;
  } catch (err) {
    warn("run-log", `Cleanup failed: ${err}`);
    return 0;
  }
}

// ============================================================
// HELPERS
// ============================================================

/** Sanitize job name for use as filename. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").substring(0, 60);
}
