/**
 * Atlas — Git Worktree Manager
 *
 * Gives each code agent its own isolated git worktree on a feature branch.
 * No more conflicts when running parallel agents on the same repo.
 *
 * Flow:
 *   1. acquireWorktree(taskId, repoDir) -> creates worktree + feature branch
 *   2. Agent runs in the worktree directory (isolated from main working tree)
 *   3. releaseWorktree(taskId) -> merges feature branch back, removes worktree
 *   4. If merge conflict: reports it, does NOT auto-resolve
 *   5. Stale worktrees (>2h) are auto-cleaned by periodic sweep
 *
 * State persisted to data/worktrees.json so cleanup survives restarts.
 */

import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { info, warn, error as logError } from "./logger.ts";
import {
  WORKTREE_BASE_DIR,
  WORKTREE_MAX_AGE_MS,
  WORKTREE_STATE_FILE,
  WORKTREE_BRANCH_PREFIX,
} from "./constants.ts";

// ============================================================
// TYPES
// ============================================================

export interface WorktreeEntry {
  /** Task ID that owns this worktree */
  taskId: string;
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Feature branch name (e.g., atlas/agent/task_123456) */
  branch: string;
  /** Source repo directory (the main working tree) */
  repoDir: string;
  /** Branch the worktree was created from */
  baseBranch: string;
  /** ISO timestamp when created */
  createdAt: string;
  /** Whether the worktree has been merged back */
  merged: boolean;
  /** Whether the worktree directory has been removed */
  removed: boolean;
  /** Merge conflict details if merge failed */
  mergeConflict: string | null;
}

export interface MergeResult {
  success: boolean;
  /** Summary of what was merged (files changed, insertions, deletions) */
  summary: string;
  /** Conflict details if merge failed. Includes file list. */
  conflictDetails: string | null;
}

interface WorktreeState {
  entries: WorktreeEntry[];
}

// ============================================================
// STATE
// ============================================================

let state: WorktreeState = { entries: [] };
let stateLoaded = false;

async function ensureStateDir(): Promise<void> {
  const dir = join(process.env.PROJECT_DIR || process.cwd(), "data");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function loadState(): Promise<void> {
  if (stateLoaded) return;
  try {
    const raw = await readFile(WORKTREE_STATE_FILE, "utf-8");
    state = JSON.parse(raw);
    if (!Array.isArray(state.entries)) state.entries = [];
  } catch {
    state = { entries: [] };
  }
  stateLoaded = true;
}

async function saveState(): Promise<void> {
  await ensureStateDir();
  await writeFile(WORKTREE_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ============================================================
// GIT HELPERS
// ============================================================

/**
 * Run a git command in a given directory. Returns { stdout, stderr, exitCode }.
 * Uses Bun.spawn with stdin closed immediately (non-interactive).
 */
async function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: proc.exitCode ?? 1 };
}

/**
 * Get the current branch name in a repo.
 */
async function getCurrentBranch(repoDir: string): Promise<string> {
  const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get current branch in ${repoDir}: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Check if a branch exists (local).
 */
async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const result = await git(["rev-parse", "--verify", branch], repoDir);
  return result.exitCode === 0;
}

/**
 * Check if git worktree feature is available.
 */
async function isWorktreeSupported(repoDir: string): Promise<boolean> {
  const result = await git(["worktree", "list", "--porcelain"], repoDir);
  return result.exitCode === 0;
}

/**
 * List all worktrees tracked by git.
 */
async function listGitWorktrees(repoDir: string): Promise<string[]> {
  const result = await git(["worktree", "list", "--porcelain"], repoDir);
  if (result.exitCode !== 0) return [];
  const paths: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length));
    }
  }
  return paths;
}

// ============================================================
// CORE API
// ============================================================

/**
 * Acquire an isolated worktree for a code agent task.
 *
 * Creates a new git worktree on a feature branch forked from the current HEAD.
 * The agent runs in this worktree, completely isolated from the main working tree.
 *
 * @param taskId - Unique task identifier (used in branch name and tracking)
 * @param repoDir - Absolute path to the main repository
 * @returns WorktreeEntry with the worktree path the agent should use as cwd
 */
export async function acquireWorktree(
  taskId: string,
  repoDir: string,
): Promise<WorktreeEntry> {
  await loadState();

  // Check for existing worktree for this task (idempotent)
  const existing = state.entries.find((e) => e.taskId === taskId && !e.removed);
  if (existing) {
    info("worktree", `Reusing existing worktree for ${taskId}: ${existing.worktreePath}`);
    return existing;
  }

  // Validate repo
  if (!existsSync(join(repoDir, ".git"))) {
    // Check if it's a worktree itself (has .git file, not directory)
    const gitPath = join(repoDir, ".git");
    if (!existsSync(gitPath)) {
      throw new Error(`Not a git repository: ${repoDir}`);
    }
  }

  // Verify git worktree support
  if (!(await isWorktreeSupported(repoDir))) {
    throw new Error(`Git worktree not supported in ${repoDir}`);
  }

  const baseBranch = await getCurrentBranch(repoDir);
  const safeName = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const branch = `${WORKTREE_BRANCH_PREFIX}${safeName}`;

  // Unique worktree directory under WORKTREE_BASE_DIR
  const repoName = basename(repoDir);
  const worktreePath = join(WORKTREE_BASE_DIR, `${repoName}_${safeName}`);

  // Ensure base directory exists
  if (!existsSync(WORKTREE_BASE_DIR)) {
    await mkdir(WORKTREE_BASE_DIR, { recursive: true });
  }

  // Clean up stale directory if it exists from a previous crashed run
  if (existsSync(worktreePath)) {
    warn("worktree", `Stale worktree directory found at ${worktreePath}, cleaning up`);
    await forceRemoveWorktree(repoDir, worktreePath, branch);
  }

  // Delete branch if it already exists (leftover from previous run)
  if (await branchExists(repoDir, branch)) {
    warn("worktree", `Stale branch ${branch} exists, deleting`);
    await git(["branch", "-D", branch], repoDir);
  }

  // Create the worktree with a new branch off current HEAD
  const result = await git(
    ["worktree", "add", "-b", branch, worktreePath],
    repoDir,
  );

  if (result.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr}`);
  }

  const entry: WorktreeEntry = {
    taskId,
    worktreePath,
    branch,
    repoDir,
    baseBranch,
    createdAt: new Date().toISOString(),
    merged: false,
    removed: false,
    mergeConflict: null,
  };

  state.entries.push(entry);
  await saveState();

  info("worktree", `Created worktree for ${taskId}: ${worktreePath} (branch: ${branch}, base: ${baseBranch})`);
  return entry;
}

/**
 * Release a worktree after task completion.
 *
 * Attempts to merge the feature branch back into the base branch.
 * If there are merge conflicts, reports them without auto-resolving.
 * Then removes the worktree and cleans up the branch.
 *
 * @param taskId - Task ID to release
 * @param options.skipMerge - If true, skip merging (just clean up). Default: false.
 * @returns MergeResult describing what happened
 */
export async function releaseWorktree(
  taskId: string,
  options?: { skipMerge?: boolean },
): Promise<MergeResult> {
  await loadState();

  const entry = state.entries.find((e) => e.taskId === taskId && !e.removed);
  if (!entry) {
    return { success: true, summary: "No worktree found for task (already cleaned up)", conflictDetails: null };
  }

  const { repoDir, worktreePath, branch, baseBranch } = entry;
  const skipMerge = options?.skipMerge ?? false;

  // Check if the agent made any commits on the feature branch
  const hasCommits = await branchHasNewCommits(repoDir, baseBranch, branch);

  let mergeResult: MergeResult = {
    success: true,
    summary: "No changes to merge",
    conflictDetails: null,
  };

  if (hasCommits && !skipMerge) {
    mergeResult = await mergeWorktreeBranch(repoDir, baseBranch, branch);
    entry.merged = mergeResult.success;
    entry.mergeConflict = mergeResult.conflictDetails;
  } else if (!hasCommits) {
    info("worktree", `No new commits on ${branch}, skipping merge`);
  }

  // Remove the worktree and branch regardless of merge outcome
  await forceRemoveWorktree(repoDir, worktreePath, branch);
  entry.removed = true;
  await saveState();

  info("worktree", `Released worktree for ${taskId}: merged=${entry.merged}, conflict=${!!entry.mergeConflict}`);
  return mergeResult;
}

/**
 * Check if a feature branch has commits not on the base branch.
 */
async function branchHasNewCommits(
  repoDir: string,
  baseBranch: string,
  featureBranch: string,
): Promise<boolean> {
  const result = await git(
    ["rev-list", "--count", `${baseBranch}..${featureBranch}`],
    repoDir,
  );
  if (result.exitCode !== 0) return false;
  const count = parseInt(result.stdout, 10);
  return count > 0;
}

/**
 * Merge a feature branch into the base branch.
 * Does NOT auto-resolve conflicts. Reports them for human review.
 */
async function mergeWorktreeBranch(
  repoDir: string,
  baseBranch: string,
  featureBranch: string,
): Promise<MergeResult> {
  // First, check out the base branch
  const checkoutResult = await git(["checkout", baseBranch], repoDir);
  if (checkoutResult.exitCode !== 0) {
    // If checkout fails (dirty working tree), try to stash first
    const stashResult = await git(["stash", "push", "-m", `worktree-pre-merge-${featureBranch}`], repoDir);
    if (stashResult.exitCode !== 0) {
      return {
        success: false,
        summary: `Cannot checkout ${baseBranch}: working tree has uncommitted changes that cannot be stashed`,
        conflictDetails: checkoutResult.stderr,
      };
    }
    const retryCheckout = await git(["checkout", baseBranch], repoDir);
    if (retryCheckout.exitCode !== 0) {
      // Restore stash before giving up
      await git(["stash", "pop"], repoDir);
      return {
        success: false,
        summary: `Cannot checkout ${baseBranch} even after stashing`,
        conflictDetails: retryCheckout.stderr,
      };
    }
  }

  // Get diffstat before merge for the summary
  const diffstat = await git(
    ["diff", "--stat", `${baseBranch}...${featureBranch}`],
    repoDir,
  );

  // Attempt the merge (no fast-forward so we always get a merge commit for clarity)
  const mergeMsg = `Merge ${featureBranch} (auto-merge by Atlas worktree manager)`;
  const mergeResult = await git(
    ["merge", "--no-ff", "-m", mergeMsg, featureBranch],
    repoDir,
  );

  if (mergeResult.exitCode === 0) {
    const summary = diffstat.stdout || "Merged successfully (no diff summary available)";
    info("worktree", `Merged ${featureBranch} into ${baseBranch}: ${summary.split("\n").pop()}`);
    return { success: true, summary, conflictDetails: null };
  }

  // Merge conflict detected. Abort the merge and report.
  warn("worktree", `Merge conflict merging ${featureBranch} into ${baseBranch}`);

  // Capture conflict details before aborting
  const conflictList = await git(["diff", "--name-only", "--diff-filter=U"], repoDir);
  const conflictDetails = [
    `Merge conflict: ${featureBranch} -> ${baseBranch}`,
    "",
    "Conflicting files:",
    ...(conflictList.stdout ? conflictList.stdout.split("\n").map((f) => `  - ${f}`) : ["  (could not determine files)"]),
    "",
    "Git merge output:",
    mergeResult.stdout,
    mergeResult.stderr,
  ].join("\n");

  // Abort the merge to restore clean state
  await git(["merge", "--abort"], repoDir);

  logError("worktree", `Merge conflict on ${featureBranch}: ${conflictList.stdout || "unknown files"}`);

  return {
    success: false,
    summary: `Merge conflict: ${conflictList.stdout || "unknown files"}`,
    conflictDetails,
  };
}

/**
 * Forcefully remove a worktree directory and its branch.
 * Handles partially-deleted worktrees and branches that may not exist.
 */
async function forceRemoveWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  // Remove git worktree registration
  const removeResult = await git(["worktree", "remove", "--force", worktreePath], repoDir);
  if (removeResult.exitCode !== 0) {
    // Worktree might already be gone. Try to prune stale entries.
    await git(["worktree", "prune"], repoDir);
  }

  // Remove directory if it still exists
  if (existsSync(worktreePath)) {
    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch (err) {
      warn("worktree", `Failed to remove worktree directory ${worktreePath}: ${err}`);
    }
  }

  // Delete the feature branch (force, since it may not be fully merged)
  const delResult = await git(["branch", "-D", branch], repoDir);
  if (delResult.exitCode !== 0 && !delResult.stderr.includes("not found")) {
    warn("worktree", `Failed to delete branch ${branch}: ${delResult.stderr}`);
  }
}

// ============================================================
// CLEANUP
// ============================================================

/**
 * Clean up all worktrees that have exceeded the max age.
 * Called periodically by cron or heartbeat.
 *
 * Stale worktrees are removed without merging (the task timed out or failed,
 * so the changes are likely incomplete). Merge conflicts are not a concern
 * since we skip the merge step.
 *
 * @returns Number of worktrees cleaned up
 */
export async function cleanupStaleWorktrees(skipTaskIds?: Set<string>): Promise<number> {
  await loadState();

  const now = Date.now();
  let cleaned = 0;

  for (const entry of state.entries) {
    if (entry.removed) continue;

    // Don't delete worktrees for tasks that are still running
    if (skipTaskIds?.has(entry.taskId)) continue;

    const age = now - new Date(entry.createdAt).getTime();
    if (age > WORKTREE_MAX_AGE_MS) {
      warn("worktree", `Worktree for ${entry.taskId} expired (age: ${Math.round(age / 60_000)}m). Removing without merge.`);
      try {
        await forceRemoveWorktree(entry.repoDir, entry.worktreePath, entry.branch);
        entry.removed = true;
        cleaned++;
      } catch (err) {
        logError("worktree", `Failed to cleanup stale worktree ${entry.worktreePath}: ${err}`);
      }
    }
  }

  if (cleaned > 0) {
    await saveState();
    info("worktree", `Cleaned up ${cleaned} stale worktree(s)`);
  }

  return cleaned;
}

/**
 * Purge all removed entries from state (housekeeping).
 * Keeps only active (non-removed) entries.
 */
export async function purgeRemovedEntries(): Promise<number> {
  await loadState();
  const before = state.entries.length;
  state.entries = state.entries.filter((e) => !e.removed);
  const purged = before - state.entries.length;
  if (purged > 0) {
    await saveState();
    info("worktree", `Purged ${purged} removed worktree entries from state`);
  }
  return purged;
}

// ============================================================
// QUERIES
// ============================================================

/**
 * Get the worktree entry for a task (if any).
 */
export async function getWorktree(taskId: string): Promise<WorktreeEntry | null> {
  await loadState();
  return state.entries.find((e) => e.taskId === taskId && !e.removed) || null;
}

/**
 * Get all active (non-removed) worktree entries.
 */
export async function getActiveWorktrees(): Promise<WorktreeEntry[]> {
  await loadState();
  return state.entries.filter((e) => !e.removed);
}

/**
 * Get worktrees that had merge conflicts (for reporting).
 */
export async function getConflictedWorktrees(): Promise<WorktreeEntry[]> {
  await loadState();
  return state.entries.filter((e) => e.mergeConflict !== null);
}

/**
 * Check if a repo directory has any active worktrees.
 */
export async function hasActiveWorktrees(repoDir: string): Promise<boolean> {
  await loadState();
  return state.entries.some((e) => e.repoDir === repoDir && !e.removed);
}

/**
 * Get a diagnostic summary of worktree state (for /diagnose).
 */
export async function getWorktreeDiagnostics(): Promise<string> {
  await loadState();

  const active = state.entries.filter((e) => !e.removed);
  const conflicts = state.entries.filter((e) => e.mergeConflict !== null);
  const removed = state.entries.filter((e) => e.removed);

  if (active.length === 0 && removed.length === 0) {
    return "No worktrees tracked.";
  }

  const lines: string[] = [];
  lines.push(`Active worktrees: ${active.length}`);

  for (const entry of active) {
    const age = Math.round((Date.now() - new Date(entry.createdAt).getTime()) / 60_000);
    lines.push(`  - ${entry.taskId}: ${entry.branch} (${age}m old, base: ${entry.baseBranch})`);
  }

  if (conflicts.length > 0) {
    lines.push(`\nUnresolved merge conflicts: ${conflicts.length}`);
    for (const entry of conflicts) {
      lines.push(`  - ${entry.taskId}: ${entry.branch}`);
      if (entry.mergeConflict) {
        const firstLine = entry.mergeConflict.split("\n")[0];
        lines.push(`    ${firstLine}`);
      }
    }
  }

  lines.push(`\nTotal tracked entries: ${state.entries.length} (${removed.length} removed)`);

  return lines.join("\n");
}
