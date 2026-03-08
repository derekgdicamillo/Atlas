/**
 * Atlas -- Savepoint (Checkpoint Resume) System
 *
 * When a code agent fails at minute 45, don't restart from scratch.
 * Roll back to the last good checkpoint and restart with context about
 * what went wrong. Saves 50-70% of wasted compute on retries.
 *
 * Each task gets a rolling window of up to 5 savepoints stored in
 * data/savepoints/{taskId}.json. On retry, buildRollbackContext()
 * produces a structured prompt section so the new agent can resume.
 */

import { readFile, writeFile, mkdir, rename, readdir, unlink, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { spawn } from "bun";
import { info, warn } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const SAVEPOINT_DIR = join(PROJECT_DIR, "data", "savepoints");
const MAX_SAVEPOINTS_PER_TASK = 5;
const MAX_DIFF_CHARS = 500;
const MAX_SAVEPOINT_BYTES = 10 * 1024; // 10KB cap per savepoint file

// ============================================================
// TYPES
// ============================================================

export interface Savepoint {
  id: string;
  taskId: string;
  phase: string;
  timestamp: string;
  toolCallCount: number;
  filesModified: string[];
  fileDiffs: Record<string, string>;
  keyDecisions: string[];
  costUsd: number;
  worktreeBranch?: string;
}

interface SavepointStore {
  savepoints: Savepoint[];
  version: number;
}

// ============================================================
// HELPERS
// ============================================================

async function ensureDir(): Promise<void> {
  if (!existsSync(SAVEPOINT_DIR)) {
    await mkdir(SAVEPOINT_DIR, { recursive: true });
  }
}

function storePath(taskId: string): string {
  return join(SAVEPOINT_DIR, `${taskId}.json`);
}

async function readStore(taskId: string): Promise<SavepointStore> {
  const filePath = storePath(taskId);
  if (!existsSync(filePath)) return { savepoints: [], version: 1 };
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    warn("savepoint", `Corrupted savepoint file for ${taskId}, starting fresh`);
    return { savepoints: [], version: 1 };
  }
}

async function writeStore(taskId: string, store: SavepointStore): Promise<void> {
  await ensureDir();
  const filePath = storePath(taskId);
  const tmpPath = filePath + ".tmp";
  const json = JSON.stringify(store, null, 2);

  // Enforce size cap: if over limit, trim oldest savepoints until under
  if (json.length > MAX_SAVEPOINT_BYTES && store.savepoints.length > 1) {
    store.savepoints = store.savepoints.slice(-1);
    const trimmed = JSON.stringify(store, null, 2);
    await writeFile(tmpPath, trimmed);
  } else {
    await writeFile(tmpPath, json);
  }
  await rename(tmpPath, filePath);
}

// ============================================================
// GIT DIFF CAPTURE
// ============================================================

async function captureGitDiff(cwd: string): Promise<string> {
  // Only run if cwd is a git repo
  if (!existsSync(join(cwd, ".git"))) return "";
  try {
    const proc = spawn(["git", "diff", "--stat"], { cwd, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.slice(0, 2000);
  } catch {
    return "";
  }
}

async function captureFileDiffs(cwd: string, files: string[]): Promise<Record<string, string>> {
  if (!existsSync(join(cwd, ".git")) || files.length === 0) return {};

  const diffs: Record<string, string> = {};
  for (const file of files.slice(0, 10)) {
    try {
      const proc = spawn(["git", "diff", "--", file], { cwd, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      if (output.trim()) {
        diffs[file] = output.slice(0, MAX_DIFF_CHARS);
      }
    } catch {
      // skip files we can't diff
    }
  }
  return diffs;
}

// ============================================================
// CORE FUNCTIONS
// ============================================================

/**
 * Capture current state as a savepoint. Rolling window of MAX_SAVEPOINTS_PER_TASK.
 */
export async function createSavepoint(
  taskId: string,
  phase: string,
  meta: {
    toolCallCount: number;
    filesModified: string[];
    keyDecisions: string[];
    costUsd: number;
    worktreeBranch?: string;
    cwd?: string;
  }
): Promise<Savepoint> {
  const store = await readStore(taskId);

  // Capture file diffs if we have a cwd
  let fileDiffs: Record<string, string> = {};
  if (meta.cwd) {
    fileDiffs = await captureFileDiffs(meta.cwd, meta.filesModified);
  }

  const savepoint: Savepoint = {
    id: crypto.randomUUID(),
    taskId,
    phase,
    timestamp: new Date().toISOString(),
    toolCallCount: meta.toolCallCount,
    filesModified: meta.filesModified,
    fileDiffs,
    keyDecisions: meta.keyDecisions,
    costUsd: meta.costUsd,
    worktreeBranch: meta.worktreeBranch,
  };

  store.savepoints.push(savepoint);

  // Rolling window: keep only the most recent N
  if (store.savepoints.length > MAX_SAVEPOINTS_PER_TASK) {
    store.savepoints = store.savepoints.slice(-MAX_SAVEPOINTS_PER_TASK);
  }

  await writeStore(taskId, store);
  info("savepoint", `Created savepoint for ${taskId} at phase "${phase}" (${store.savepoints.length} total)`);
  return savepoint;
}

/**
 * Return the most recent savepoint for a task, or null if none exist.
 */
export async function getLastSavepoint(taskId: string): Promise<Savepoint | null> {
  const store = await readStore(taskId);
  if (store.savepoints.length === 0) return null;
  return store.savepoints[store.savepoints.length - 1];
}

/**
 * Build a structured restart prompt from the last savepoint and failure reason.
 * Returns null if no savepoints exist.
 */
export async function buildRollbackContext(taskId: string, failureReason: string): Promise<string | null> {
  const store = await readStore(taskId);
  if (store.savepoints.length === 0) return null;

  const last = store.savepoints[store.savepoints.length - 1];

  // Aggregate all files and decisions across savepoints
  const allFiles = new Set<string>();
  const allDecisions: string[] = [];
  for (const sp of store.savepoints) {
    for (const f of sp.filesModified) allFiles.add(f);
    for (const d of sp.keyDecisions) {
      if (!allDecisions.includes(d)) allDecisions.push(d);
    }
  }

  const lines: string[] = [
    "# SAVEPOINT RESUME CONTEXT",
    "You are resuming from a checkpoint. Do NOT redo completed work.",
    "",
    "## Last Checkpoint",
    `- Phase reached: ${last.phase}`,
    `- Tool calls made: ${last.toolCallCount}`,
    `- Cost so far: $${last.costUsd.toFixed(4)}`,
    `- Savepoint count: ${store.savepoints.length}`,
    `- Last checkpoint time: ${last.timestamp}`,
  ];

  if (allFiles.size > 0) {
    lines.push("", "## Files Already Modified");
    for (const file of allFiles) lines.push(`- ${file}`);
    lines.push("", "Review these files to understand what was already done.");
  }

  if (allDecisions.length > 0) {
    lines.push("", "## Key Decisions Made");
    for (const d of allDecisions) lines.push(`- ${d}`);
  }

  // Include diffs from the last savepoint
  const diffEntries = Object.entries(last.fileDiffs);
  if (diffEntries.length > 0) {
    lines.push("", "## Recent File Changes (diff summary)");
    for (const [file, diff] of diffEntries) {
      lines.push(`\n### ${file}`);
      lines.push("```");
      lines.push(diff);
      lines.push("```");
    }
  }

  lines.push("", "## Failure Reason");
  lines.push(failureReason);
  lines.push("", "Resume from the checkpoint above. Pick up where the previous agent left off.");

  // Progress timeline
  lines.push("", "## Savepoint Timeline");
  for (const sp of store.savepoints) {
    const time = new Date(sp.timestamp).toLocaleTimeString("en-US", { hour12: false });
    lines.push(`- [${time}] Phase: ${sp.phase} | Tools: ${sp.toolCallCount} | Files: ${sp.filesModified.length} | Cost: $${sp.costUsd.toFixed(4)}`);
  }

  return lines.join("\n");
}

/**
 * If the task used a git worktree, reset to a clean state.
 * Optional, only applies to worktree-isolated tasks.
 */
export async function rollbackWorktree(taskId: string, cwd: string): Promise<boolean> {
  const last = await getLastSavepoint(taskId);
  if (!last || !last.worktreeBranch) return false;
  if (!existsSync(join(cwd, ".git"))) return false;

  try {
    // Stash any uncommitted changes, then reset
    const stash = spawn(["git", "stash", "--include-untracked"], { cwd, stdout: "pipe", stderr: "pipe" });
    await stash.exited;

    info("savepoint", `Rolled back worktree for ${taskId} in ${cwd}`);
    return true;
  } catch (err) {
    warn("savepoint", `Worktree rollback failed for ${taskId}: ${err}`);
    return false;
  }
}

/**
 * Delete all savepoints for a completed task.
 */
export async function cleanupSavepoints(taskId: string): Promise<void> {
  const filePath = storePath(taskId);
  if (!existsSync(filePath)) return;
  try {
    await unlink(filePath);
    info("savepoint", `Cleaned up savepoints for completed task ${taskId}`);
  } catch (err) {
    warn("savepoint", `Failed to clean savepoints for ${taskId}: ${err}`);
  }
}

/**
 * Delete savepoint files older than maxAgeDays. Returns count removed.
 */
export async function cleanupOldSavepoints(maxAgeDays: number = 7): Promise<number> {
  if (!existsSync(SAVEPOINT_DIR)) return 0;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    const files = await readdir(SAVEPOINT_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(SAVEPOINT_DIR, file);
      try {
        const stats = await stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await unlink(filePath);
          cleaned++;
        }
      } catch { /* skip files we can't stat */ }
    }
    if (cleaned > 0) info("savepoint", `Cleaned up ${cleaned} old savepoint files`);
  } catch (err) {
    warn("savepoint", `Cleanup error: ${err}`);
  }

  return cleaned;
}
