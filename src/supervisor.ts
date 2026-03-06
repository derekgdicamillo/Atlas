/**
 * Atlas — Task Supervisor
 *
 * Tracks and monitors delegated sub-agent work (Task tool, cron skills,
 * background research). Persists task state to disk so tasks survive
 * session rollovers and process restarts.
 *
 * Integrates with heartbeat for periodic health checks on running tasks.
 * Alerts Derek when tasks complete, fail, or time out.
 *
 * Born from necessity: overnight research agents died 3 times across
 * session rollovers with zero visibility. Never again.
 */

import { readFile, writeFile, mkdir, rename, copyFile } from "fs/promises";
import { existsSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { spawn } from "bun";
import { EventEmitter } from "events";
import { info, warn, error as logError, trackClaudeCall } from "./logger.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sanitizedEnv, validateSpawnArgs } from "./claude.ts";
import { fireHooks } from "./hooks.ts";
import { acquireWorktree, releaseWorktree, cleanupStaleWorktrees, getWorktree } from "./worktree.ts";

/**
 * Graceful process termination: SIGTERM first, SIGKILL after grace period.
 * OpenClaw #18626: prevents orphaned child processes from dangling.
 */
function gracefulKill(pid: number, graceMs = 3000): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // process already dead
  }
  // Schedule SIGKILL if process doesn't exit within grace period
  setTimeout(() => {
    try {
      process.kill(pid, 0); // check if still alive
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead, good
    }
  }, graceMs).unref();
}
import {
  MODELS,
  TOKEN_COSTS,
  MAX_CONCURRENT_SUBAGENTS,
  CODE_AGENT_MAX_TOOL_CALLS,
  CODE_AGENT_WALL_CLOCK_MS,
  CODE_AGENT_INACTIVITY_MS,
  CODE_AGENT_PROGRESS_INTERVAL_MS,
  CODE_AGENT_DEFAULT_MODEL,
  CODE_AGENT_MAX_BUDGET_USD,
  SUBAGENT_MAX_DEPTH,
  SUBAGENT_MAX_OUTPUT_CHARS,
  CODE_AGENT_MAX_RESULT_CHARS,
  TOOL_POLICIES,
  RESEARCH_DEFAULT_MODEL,
  type ModelTier,
  // Supervisor system constants
  SUPERVISOR_ENABLED,
  SUPERVISOR_PATTERN_DETECT,
  SUPERVISOR_SHADOW_EVAL,
  SUPERVISOR_SHADOW_INTERVAL,
  SUPERVISOR_SHADOW_MODEL,
  SUPERVISOR_MAX_RESTARTS,
  SUPERVISOR_LEARNING,
  SUPERVISOR_CONTEXT_INJECTION,
  SUPERVISOR_MODE,
} from "./constants.ts";

// Supervisor system imports
import { createPatternDetector, type PatternDetector, type DetectedPattern } from "./patterns.ts";
import { createShadowEvaluator, storeEvaluation, type ShadowEvaluator, type EvaluationResult } from "./shadow-evaluator.ts";
import { buildCodeAgentContext, buildRestartContext, detectTaskCategory } from "./context-injector.ts";
import { extractPatternsFromTask, findSimilarPatterns, buildPatternGuidance } from "./learned-patterns.ts";
import { createCheckpointTracker, type CheckpointTracker } from "./checkpoints.ts";
import { createStreamParser } from "./claude.ts";
import {
  enqueue,
  tryDispatch,
  TaskPriority,
  DEFAULT_TTL_MS,
  SWARM_TTL_MS,
  type QueuedTask,
} from "./queue.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const TASKS_FILE = join(DATA_DIR, "tasks.json");
const TASKS_ARCHIVE = join(DATA_DIR, "tasks-archive.json");

// ============================================================
// TYPES
// ============================================================

export type TaskStatus = "pending" | "running" | "completed" | "completed_with_errors" | "failed" | "timeout" | "stalled";

/** Structured outcome (inspired by OpenClaw SubagentRunRecord) */
export type TaskOutcome =
  | { status: "ok"; summary: string; durationMs: number }
  | { status: "error"; message: string; durationMs: number }
  | { status: "timeout"; message: string; durationMs: number };

export interface SupervisedTask {
  id: string;
  description: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  timeoutMs: number;
  /** Path to expected output file (checked for completion) */
  outputFile: string | null;
  /** Brief result summary once done */
  result: string | null;
  /** Who requested the task */
  requestedBy: string;
  /** Number of retry attempts */
  retries: number;
  maxRetries: number;
  /** Last time the supervisor checked this task */
  lastCheckedAt: string | null;
  /** Error message if failed */
  error: string | null;
  /** PID of the spawned subagent process (for cleanup) */
  pid: number | null;
  /** Model tier used for this task */
  model: ModelTier;
  /** Original prompt (stored for retry spawns) */
  prompt: string | null;
  /** Task type: research writes to output file, code edits project files, ingest walks folders */
  taskType: "research" | "code" | "ingest";
  /** Working directory for code tasks */
  cwd: string | null;
  /** Live tool call count (updated by stream parser for code tasks) */
  toolCallCount: number;
  /** Accumulated cost so far */
  costUsd: number;
  /** Last tool used */
  lastToolName: string | null;
  /** Last file touched */
  lastFileTouched: string | null;
  /** Structured outcome recorded on completion (OpenClaw pattern) */
  outcome: TaskOutcome | null;
  /** Number of announce delivery attempts for completed tasks */
  announceRetryCount: number;
  /** Timestamp of last announce attempt */
  lastAnnounceAt: string | null;
  /** Whether the completion was successfully announced */
  announced: boolean;
  /** Agent ID for routing (default: atlas) */
  agentId: string;
  /** Last ~20 lines of output sampled for stall detection */
  lastOutputSample?: string | null;
  /** Consecutive checks with identical output (stall detection) */
  stallCount?: number;
  /** Git worktree branch name (if worktree isolation is active for this code task) */
  worktreeBranch?: string | null;
  /** Queued amendment queries (for ingest tasks that can't be amended in-flight) */
  _pendingAmendments?: string[];
  /** Swarm ID if part of a swarm (set via registerTask opts) */
  _swarmId?: string | null;
  /** DAG node ID if part of a swarm */
  _dagNodeId?: string | null;
  /** Task IDs this task depends on (must all complete before this runs) */
  dependsOn?: string[];
  /** Workflow ID if part of a workflow chain */
  workflowId?: string | null;
  // === SUPERVISOR SYSTEM FIELDS ===
  /** Number of restarts this task has had */
  restartCount?: number;
  /** Parent task ID if this is a restart of a previous task */
  restartOf?: string | null;
  /** Detected patterns that triggered intervention */
  detectedPatterns?: string[];
  /** Shadow evaluations performed on this task */
  shadowEvaluations?: Array<{ toolCall: number; decision: string; scores: string }>;
  /** Checkpoint spec if using checkpoint system */
  checkpoints?: string | null;
  /** Last exit code from subprocess (for death diagnostics) */
  lastExitCode?: number | null;
  /** Last stderr output from subprocess (for death diagnostics, truncated to 500 chars) */
  lastStderr?: string | null;
  /** Categorized death type (for targeted retry strategies) */
  deathCategory?: "oom" | "timeout_kill" | "rate_limit" | "session_corrupt" | "api_error" | "unknown" | null;
  /** Nesting depth: 0 = main session spawned, 1 = subagent spawned by subagent (max SUBAGENT_MAX_DEPTH) */
  depth?: number;
}

interface TaskStore {
  tasks: SupervisedTask[];
  lastCheckAt: string | null;
  totalCompleted: number;
  totalFailed: number;
  totalTimedOut: number;
}

// ============================================================
// STATE
// ============================================================

/** Check if a task status is terminal (no longer running). */
function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "completed_with_errors" || status === "failed" || status === "timeout" || status === "stalled";
}

let store: TaskStore = {
  tasks: [],
  lastCheckAt: null,
  totalCompleted: 0,
  totalFailed: 0,
  totalTimedOut: 0,
};

// ============================================================
// EVENT EMITTER (OpenClaw gateway pattern)
// ============================================================
// Fires events on task state changes so delivery is immediate,
// not dependent on 5-min cron polling. Cron becomes backup.

export const taskEvents = new EventEmitter();

// Event types:
//   "task:completed"  (task: SupervisedTask)
//   "task:failed"     (task: SupervisedTask)
//   "task:timeout"    (task: SupervisedTask)
//   "task:progress"   (task: SupervisedTask, update: CodeAgentProgress)

/** Emit a task lifecycle event. Safe (never throws). */
function emitTaskEvent(event: string, task: SupervisedTask, extra?: any): void {
  try {
    taskEvents.emit(event, task, extra);
  } catch (err) {
    warn("supervisor", `Event emission error (${event}): ${err}`);
  }
}

// ============================================================
// PERSISTENCE
// ============================================================

export async function loadTasks(): Promise<void> {
  const backupFile = TASKS_FILE + ".backup";
  try {
    if (existsSync(TASKS_FILE)) {
      const content = await readFile(TASKS_FILE, "utf-8");
      store = JSON.parse(content);
      // Create backup on successful load (for crash recovery)
      await copyFile(TASKS_FILE, backupFile).catch(() => {});
    }
  } catch (err) {
    warn("supervisor", `Failed to load tasks: ${err}`);
    // Fall back to backup if primary is corrupted
    try {
      if (existsSync(backupFile)) {
        const backupContent = await readFile(backupFile, "utf-8");
        store = JSON.parse(backupContent);
        warn("supervisor", `Recovered ${store.tasks.length} tasks from backup`);
      }
    } catch (backupErr) {
      warn("supervisor", `Backup also failed: ${backupErr}`);
    }
  }

  // Backward compat + field backfill
  if (!store.totalCompleted) store.totalCompleted = 0;
  if (!store.totalFailed) store.totalFailed = 0;
  if (!store.totalTimedOut) store.totalTimedOut = 0;
  for (const task of store.tasks) {
    if (task.pid === undefined) task.pid = null;
    if (!task.model) task.model = "sonnet";
    if (task.prompt === undefined) task.prompt = null;
    if (!task.taskType) task.taskType = "research";
    if (task.cwd === undefined) task.cwd = null;
    if (task.toolCallCount === undefined) task.toolCallCount = 0;
    if (task.costUsd === undefined) task.costUsd = 0;
    if (task.lastToolName === undefined) task.lastToolName = null;
    if (task.lastFileTouched === undefined) task.lastFileTouched = null;
    // v2026.2.17 fields
    if (task.outcome === undefined) task.outcome = null;
    if (task.announceRetryCount === undefined) task.announceRetryCount = 0;
    if (task.lastAnnounceAt === undefined) task.lastAnnounceAt = null;
    if (task.announced === undefined) task.announced = isTerminalStatus(task.status);
    // v2026.2.22 fields (supervisor safeguards)
    if (task.lastOutputSample === undefined) task.lastOutputSample = null;
    if (task.stallCount === undefined) task.stallCount = 0;
    // v2026.2.26 fields (death diagnostics)
    if (task.lastExitCode === undefined) task.lastExitCode = null;
    if (task.lastStderr === undefined) task.lastStderr = null;
    if (task.deathCategory === undefined) task.deathCategory = null;
    // v2026.2.26 fields (depth tracking)
    if (task.depth === undefined) task.depth = 0;
  }
  info("supervisor", `Loaded ${store.tasks.length} tasks from disk`);
}

async function saveTasks(): Promise<void> {
  try {
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }
    // Atomic write: write to temp file, then rename. Prevents truncated JSON on crash.
    const tmpFile = TASKS_FILE + ".tmp";
    await writeFile(tmpFile, JSON.stringify(store, null, 2));
    await rename(tmpFile, TASKS_FILE);
  } catch (err) {
    logError("supervisor", `Failed to save tasks: ${err}`);
  }
}

async function archiveTask(task: SupervisedTask): Promise<void> {
  try {
    let archive: SupervisedTask[] = [];
    if (existsSync(TASKS_ARCHIVE)) {
      const content = await readFile(TASKS_ARCHIVE, "utf-8");
      archive = JSON.parse(content);
    }
    archive.push(task);
    // Keep last 100 archived tasks
    if (archive.length > 100) {
      archive = archive.slice(-100);
    }
    await writeFile(TASKS_ARCHIVE, JSON.stringify(archive, null, 2));
  } catch (err) {
    logError("supervisor", `Failed to archive task: ${err}`);
  }

  // Clean up announcement lock file (created by relay.ts handleTaskEvent)
  try {
    const lockFile = join(DATA_DIR, "task-locks", `${task.id}.announced`);
    if (existsSync(lockFile)) unlinkSync(lockFile);
  } catch {
    // Non-fatal
  }
}

// ============================================================
// SUBAGENT SPAWNING
// ============================================================

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const SUBAGENT_CWD = process.env.PROJECT_DIR || process.cwd();
const TASK_OUTPUT_DIR = join(DATA_DIR, "task-output");
// MAX_CONCURRENT_SUBAGENTS imported from constants.ts

function getRunningSubagentCount(): number {
  return store.tasks.filter((t) => t.status === "running" && t.pid !== null).length;
}

/** Exported for queue.ts to check available slots */
export function getRunningCount(): number {
  return getRunningSubagentCount();
}

/** Exported for queue.ts to check concurrency limit */
export function getMaxConcurrent(): number {
  return MAX_CONCURRENT_SUBAGENTS;
}

function wrapPrompt(userPrompt: string, outputFile: string): string {
  const absOutput =
    outputFile.startsWith("/") || outputFile.includes(":")
      ? outputFile
      : join(SUBAGENT_CWD, outputFile);

  return [
    "You are a background research agent for Atlas.",
    "Your task is described below.",
    "",
    "CRITICAL INSTRUCTION: When you are finished, you MUST write your complete output to this file:",
    "",
    `  OUTPUT FILE: ${absOutput}`,
    "",
    "Write ALL of your results, analysis, and conclusions to that file using the Write tool.",
    "If you cannot complete the task, write a brief explanation of why to the same file.",
    "Do NOT ask for clarification. Do your best with the information given.",
    "",
    "TASK:",
    userPrompt,
  ].join("\n");
}

export async function spawnSubagent(opts: {
  taskId: string;
  prompt: string;
  outputFile: string;
  model?: ModelTier;
  cwd?: string;
}): Promise<{ pid: number }> {
  const running = getRunningSubagentCount();
  if (running >= MAX_CONCURRENT_SUBAGENTS) {
    throw new Error(
      `Max concurrent subagents reached (${MAX_CONCURRENT_SUBAGENTS}). Wait for a running task to finish.`
    );
  }

  const modelTier = opts.model || RESEARCH_DEFAULT_MODEL;
  const modelId = MODELS[modelTier];
  const wrappedPrompt = wrapPrompt(opts.prompt, opts.outputFile);

  // Ensure output directory exists
  await mkdir(TASK_OUTPUT_DIR, { recursive: true });

  // Prompt piped via stdin to avoid Windows ENAMETOOLONG (~32K char limit).
  const args = [
    CLAUDE_PATH,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    modelId,
    "--dangerously-skip-permissions",
  ];

  // Granular tool policy: research agents get restricted tools (no Bash/Write/Edit)
  const researchPolicy = TOOL_POLICIES.research_agent;
  if (researchPolicy.length > 0) {
    args.push("--disallowedTools", ...researchPolicy);
  }

  // OpenClaw 2026.2.23: Validate spawn args (reject CR/LF injection on Windows)
  validateSpawnArgs(args);

  info(
    "supervisor",
    `Spawning subagent for ${opts.taskId} (${modelTier}): ${opts.prompt.substring(0, 100)}...`
  );

  const proc = spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd || SUBAGENT_CWD,
    env: sanitizedEnv(),
    windowsHide: true,
  });

  // Pipe prompt via stdin (avoids Windows command-line length limits)
  proc.stdin.write(wrappedPrompt);
  proc.stdin.end();

  const pid = proc.pid;

  // Update task with PID
  const task = store.tasks.find((t) => t.id === opts.taskId);
  if (task) {
    task.pid = pid;
    task.model = modelTier;
    await saveTasks();
  }

  // Fire-and-forget: drain stdout/stderr so pipes don't block the subprocess.
  // Also captures exit info on the task for checkTasks diagnostics.
  // Includes 60s heartbeat to detect dead processes between checkTasks() runs.
  (async () => {
    // Heartbeat: check process alive every 60s, detect death ~4min sooner than checkTasks
    const heartbeat = setInterval(() => {
      try {
        process.kill(pid, 0); // signal 0 = alive check
      } catch {
        // Process died between checkTasks runs
        clearInterval(heartbeat);
        const t = store.tasks.find((t) => t.id === opts.taskId);
        if (t && t.status === "running") {
          warn("supervisor", `Heartbeat: subagent ${opts.taskId} (PID ${pid}) died unexpectedly`);
        }
      }
    }, 60_000);
    heartbeat.unref(); // don't keep the process alive

    try {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      clearInterval(heartbeat);

      // Store exit diagnostics on task for checkTasks death analysis
      const t = store.tasks.find((t) => t.id === opts.taskId);
      if (t) {
        t.lastExitCode = exitCode;
        t.lastStderr = stderr.substring(0, 500) || null;

        // Categorize death for targeted retry strategies
        if (exitCode === 137) {
          t.deathCategory = "oom";
        } else if (exitCode === 143 || exitCode === 9) {
          t.deathCategory = "timeout_kill";
        } else if (exitCode === 1 && (!stderr || stderr.trim() === "")) {
          t.deathCategory = "session_corrupt";
        } else if (exitCode === 1 && /rate.limit|429|too many requests/i.test(stderr)) {
          t.deathCategory = "rate_limit";
        } else if (exitCode === 1 && /error|exception|failed/i.test(stderr)) {
          t.deathCategory = "api_error";
        } else if (exitCode !== 0) {
          t.deathCategory = "unknown";
        }

        if (exitCode !== 0) {
          t.error = `exit ${exitCode} [${t.deathCategory || "unknown"}]: ${stderr.substring(0, 200)}`;
        }
      }

      if (exitCode !== 0) {
        const category = t?.deathCategory || "unknown";
        warn(
          "supervisor",
          `Subagent ${opts.taskId} (PID ${pid}) exited code=${exitCode} category=${category}: ${stderr.substring(0, 300)}`
        );
      } else {
        info("supervisor", `Subagent ${opts.taskId} (PID ${pid}) exited cleanly`);
      }

      // Stdout fallback: if agent exited but output file is missing, extract
      // result text from stream-json stdout and write it as the output file.
      if (opts.outputFile && stdout.length > 0) {
        const absOut = opts.outputFile.startsWith("/") || opts.outputFile.includes(":")
          ? opts.outputFile
          : join(PROJECT_DIR, opts.outputFile);
        if (!existsSync(absOut)) {
          // Parse stream-json lines to find the result event
          let resultText = "";
          for (const line of stdout.split("\n")) {
            try {
              const evt = JSON.parse(line.trim());
              if (evt.type === "result" && evt.result) {
                resultText = evt.result;
                break;
              }
            } catch { /* skip non-JSON lines */ }
          }
          if (resultText.length > 50) {
            try {
              await writeFile(absOut, resultText, "utf-8");
              info("supervisor", `Stdout fallback: wrote ${resultText.length} chars to ${opts.outputFile} for ${opts.taskId}`);
            } catch (writeErr) {
              warn("supervisor", `Stdout fallback write failed for ${opts.taskId}: ${writeErr}`);
            }
          }
        }
      }
    } catch (err) {
      clearInterval(heartbeat);
      warn("supervisor", `Subagent ${opts.taskId} drain error: ${err}`);
    }
  })();

  info("supervisor", `Subagent spawned: ${opts.taskId} PID=${pid} model=${modelTier}`);
  return { pid };
}

// ============================================================
// TASK MANAGEMENT
// ============================================================

/** Generate a short unique task ID */
function generateId(): string {
  return "task_" + Date.now().toString(36) + "_" + Math.random().toString(36).substr(2, 5);
}

// ============================================================
// INSTRUCTION VALIDATION (safeguard #2)
// ============================================================

/** Status-report prefixes that indicate conversational text, not actionable instructions. */
const STATUS_REPORT_PREFIXES = [
  "looking at",
  "here's",
  "here is",
  "active right now",
  "all 5",
  "all five",
  "currently running",
  "no tasks",
  "nothing running",
  "task completed",
  "tasks are",
  "i see",
  "it looks like",
  "the output shows",
];

/**
 * Validate that a task prompt is actionable before spawning.
 * Rejects prompts that are too short or look like status reports.
 */
export function validateTaskPrompt(prompt: string): { valid: boolean; reason?: string } {
  const trimmed = prompt.trim();

  // Reject prompts shorter than 20 characters
  if (trimmed.length < 20) {
    return { valid: false, reason: `Prompt too short (${trimmed.length} chars, min 20). Too vague to be actionable.` };
  }

  // Reject prompts that look like status reports or conversational text
  const lower = trimmed.toLowerCase();
  for (const prefix of STATUS_REPORT_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { valid: false, reason: `Prompt looks like a status report, not an instruction (starts with "${prefix}")` };
    }
  }

  return { valid: true };
}

// ============================================================
// OUTPUT VERIFICATION (safeguard #3)
// ============================================================

/** Error indicator phrases for code task output verification. */
const CODE_ERROR_INDICATORS = [
  "Error:",
  "error:",
  "ENOENT",
  "Cannot find",
  "failed",
  "FAILED",
  "TypeError:",
  "SyntaxError:",
  "ReferenceError:",
  "EPERM",
  "EACCES",
];

/**
 * Verify task output quality on completion.
 * Returns adjustment info if the output doesn't meet expectations.
 */
async function verifyTaskOutput(task: SupervisedTask): Promise<{
  verified: boolean;
  adjustedStatus?: TaskStatus;
  reason?: string;
}> {
  // Research tasks: check output file exists and has >100 bytes
  if (task.taskType === "research" && task.outputFile) {
    const outputPath = task.outputFile.startsWith("/") || task.outputFile.includes(":")
      ? task.outputFile
      : join(PROJECT_DIR, task.outputFile);

    if (!existsSync(outputPath)) {
      return { verified: false, adjustedStatus: "failed", reason: "empty output: output file missing" };
    }

    try {
      const content = await readFile(outputPath, "utf-8");
      if (content.length < 100) {
        return { verified: false, adjustedStatus: "failed", reason: `empty output: file only ${content.length} bytes (min 100)` };
      }
    } catch {
      return { verified: false, adjustedStatus: "failed", reason: "empty output: could not read output file" };
    }
  }

  // Code tasks: check last output for error indicators
  if (task.taskType === "code" && task.result) {
    const lastOutput = task.result.slice(-1000);
    for (const indicator of CODE_ERROR_INDICATORS) {
      if (lastOutput.includes(indicator)) {
        return { verified: true, adjustedStatus: "completed_with_errors", reason: `output contains "${indicator}"` };
      }
    }
  }

  // Memory file verification: if prompt references a memory/ path, check it was modified
  if (task.prompt) {
    const memoryMatch = task.prompt.match(/memory\/[\w-]+\.md/);
    if (memoryMatch && task.startedAt) {
      const memPath = join(PROJECT_DIR, memoryMatch[0]);
      if (existsSync(memPath)) {
        try {
          const stat = statSync(memPath);
          const taskStart = new Date(task.startedAt).getTime();
          if (stat.mtimeMs < taskStart) {
            warn("supervisor", `Task ${task.id} referenced ${memoryMatch[0]} but file was not modified (mtime before task start)`);
            // Don't fail the task for this, just warn
          }
        } catch {
          // stat failed, skip
        }
      }
    }
  }

  return { verified: true };
}

/**
 * Register a new task for supervision.
 * Call this whenever Atlas delegates work to a sub-agent.
 * If `prompt` is provided along with `outputFile`, a subagent is auto-spawned.
 */
export async function registerTask(opts: {
  description: string;
  outputFile?: string;
  timeoutMs?: number;
  requestedBy?: string;
  maxRetries?: number;
  /** If provided, spawns a subagent to work on this prompt */
  prompt?: string;
  /** Model for the subagent (default: sonnet) */
  model?: ModelTier;
  /** Queue priority (default: NORMAL) */
  priority?: TaskPriority;
  /** Agent ID for routing (default: atlas) */
  agentId?: string;
  /** Swarm ID if part of a swarm */
  swarmId?: string;
  /** DAG node ID if part of a swarm */
  dagNodeId?: string;
  /** Task IDs this task depends on (must complete before spawning) */
  dependsOn?: string[];
  /** Workflow ID if part of a workflow chain */
  workflowId?: string;
}): Promise<string> {
  // Validate prompt before spawning (safeguard #2)
  if (opts.prompt) {
    const validation = validateTaskPrompt(opts.prompt);
    if (!validation.valid) {
      warn("supervisor", `Rejected task prompt: ${validation.reason} — "${opts.prompt.substring(0, 100)}"`);
      throw new Error(`Task prompt rejected: ${validation.reason}`);
    }
  }

  // Auto-generate output path if prompt provided but no outputFile
  const outputFile =
    opts.outputFile ||
    (opts.prompt ? join("data", "task-output", `${Date.now().toString(36)}.md`) : null);

  const task: SupervisedTask = {
    id: generateId(),
    description: opts.description,
    status: "running",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    timeoutMs: opts.timeoutMs || 20 * 60 * 1000, // default 20 min (was 10, too short for research)
    outputFile: outputFile,
    result: null,
    requestedBy: opts.requestedBy || "Derek",
    retries: 0,
    maxRetries: opts.maxRetries || 1,
    lastCheckedAt: null,
    error: null,
    pid: null,
    model: opts.model || "sonnet",
    prompt: opts.prompt || null,
    taskType: "research",
    cwd: null,
    toolCallCount: 0,
    costUsd: 0,
    lastToolName: null,
    lastFileTouched: null,
    outcome: null,
    announceRetryCount: 0,
    lastAnnounceAt: null,
    announced: false,
    agentId: opts.agentId || "atlas",
    _swarmId: opts.swarmId || null,
    _dagNodeId: opts.dagNodeId || null,
    dependsOn: opts.dependsOn || undefined,
    workflowId: opts.workflowId || null,
  };

  // If task has unmet dependencies, hold it as pending
  if (opts.dependsOn?.length) {
    const unmet = checkDependencies(opts.dependsOn);
    if (unmet.status === "blocked") {
      task.status = "pending";
      store.tasks.push(task);
      await saveTasks();
      info("supervisor", `Registered task: ${task.id} — ${task.description} (blocked on ${unmet.waitingOn.length} dep(s))`);
      return task.id;
    }
    if (unmet.status === "failed") {
      task.status = "failed";
      task.error = `Dependency failed: ${unmet.failedDeps.join(", ")}`;
      task.completedAt = new Date().toISOString();
      store.tasks.push(task);
      store.totalFailed++;
      await saveTasks();
      warn("supervisor", `Task ${task.id} cascade-failed due to dependency failure`);
      emitTaskEvent("task:failed", task);
      fireHooks("task-complete", { task }).catch(() => {});
      return task.id;
    }
    // status === "ready" means all deps completed, proceed with spawn
  }

  store.tasks.push(task);
  await saveTasks();
  info("supervisor", `Registered task: ${task.id} — ${task.description}`);

  // Auto-spawn subagent if prompt and output file are available
  if (opts.prompt && task.outputFile) {
    const running = getRunningSubagentCount();
    if (running < MAX_CONCURRENT_SUBAGENTS) {
      // Slot available, spawn immediately
      try {
        await spawnSubagent({
          taskId: task.id,
          prompt: opts.prompt,
          outputFile: task.outputFile,
          model: opts.model,
        });
      } catch (err) {
        task.error = `Spawn failed: ${err}`;
        task.status = "failed";
        store.totalFailed++;
        await saveTasks();
        warn("supervisor", `Failed to spawn subagent for ${task.id}: ${err}`);
      }
    } else {
      // All slots full, enqueue for later dispatch
      task.status = "pending";
      await saveTasks();
      const queued = await enqueue({
        id: task.id,
        priority: opts.priority ?? TaskPriority.NORMAL,
        enqueuedAt: new Date().toISOString(),
        ttl: opts.swarmId ? SWARM_TTL_MS : DEFAULT_TTL_MS,
        taskType: "research",
        description: task.description,
        prompt: opts.prompt,
        outputFile: task.outputFile,
        cwd: null,
        model: opts.model || "sonnet",
        timeoutMs: task.timeoutMs,
        maxRetries: task.maxRetries,
        requestedBy: task.requestedBy,
        swarmId: opts.swarmId || null,
        dagNodeId: opts.dagNodeId || null,
      });
      if (!queued) {
        task.error = "Queue full, task rejected";
        task.status = "failed";
        store.totalFailed++;
        await saveTasks();
      } else {
        info("supervisor", `Task ${task.id} queued (all ${MAX_CONCURRENT_SUBAGENTS} slots busy)`);
      }
    }
  }

  return task.id;
}

/**
 * Mark a task as completed with an optional result summary.
 */
export async function completeTask(id: string, result?: string): Promise<void> {
  const task = store.tasks.find((t) => t.id === id);
  if (!task) {
    warn("supervisor", `completeTask: task ${id} not found`);
    return;
  }

  const durationMs = task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : 0;
  task.status = "completed";
  task.completedAt = new Date().toISOString();
  task.result = result || "Completed successfully";
  task.outcome = { status: "ok", summary: task.result, durationMs };

  // Output verification (safeguard #3)
  const verification = await verifyTaskOutput(task);
  if (!verification.verified && verification.adjustedStatus === "failed") {
    // Auto-retry for research tasks (safeguard #4), max 1 retry, never code tasks
    if (task.taskType === "research" && task.retries < 1 && task.prompt && task.outputFile) {
      task.retries++;
      task.status = "running";
      task.completedAt = null;
      task.result = null;
      task.outcome = null;
      task.startedAt = new Date().toISOString();
      const retryPrompt = task.prompt + "\n\nPrevious attempt produced empty or invalid output. Please ensure you write results to the specified output file.";
      warn("supervisor", `completeTask verification failed for ${task.id}: ${verification.reason}. Auto-retrying.`);

      // Delete bad output file
      const outputPath = task.outputFile.startsWith("/") || task.outputFile.includes(":")
        ? task.outputFile
        : join(PROJECT_DIR, task.outputFile);
      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(outputPath);
      } catch { /* ignore */ }

      await saveTasks();
      try {
        await spawnSubagent({
          taskId: task.id,
          prompt: retryPrompt,
          outputFile: task.outputFile,
          model: task.model,
        });
      } catch (err) {
        warn("supervisor", `completeTask retry spawn failed for ${task.id}: ${err}`);
        await failTask(id, `${verification.reason} (retry spawn failed: ${err})`);
      }
      return;
    }

    // No retry: fail the task
    const reason = task.retries > 0
      ? `retry also produced empty output (${verification.reason})`
      : (verification.reason || "output verification failed");
    await failTask(id, reason);
    return;
  }

  // Check for code tasks with error indicators
  if (verification.adjustedStatus === "completed_with_errors") {
    task.status = "completed_with_errors";
    task.error = verification.reason || "output contains error indicators";
    warn("supervisor", `Task ${task.id} completed with errors: ${verification.reason}`);
  }

  store.totalCompleted++;

  info("supervisor", `Task completed: ${task.id} — ${task.description} (${Math.round(durationMs / 1000)}s)${task.status === "completed_with_errors" ? " [with errors]" : ""}`);
  await saveTasks();

  // Event-driven delivery (immediate, doesn't wait for cron)
  emitTaskEvent("task:completed", task);
  fireHooks("task-complete", { task }).catch(() => {});

  // Notify queue + swarm orchestrator
  await onTaskFinished(task.id);
}

/**
 * Mark a task as failed with an error message.
 */
export async function failTask(id: string, error: string): Promise<void> {
  const task = store.tasks.find((t) => t.id === id);
  if (!task) {
    warn("supervisor", `failTask: task ${id} not found`);
    return;
  }

  const durationMs = task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : 0;
  task.status = "failed";
  task.completedAt = new Date().toISOString();
  task.error = error;
  task.outcome = { status: "error", message: error, durationMs };
  store.totalFailed++;

  logError("supervisor", `Task failed: ${task.id} — ${task.description}: ${error} (${Math.round(durationMs / 1000)}s)`);
  await saveTasks();

  // Event-driven delivery (immediate)
  emitTaskEvent("task:failed", task);
  fireHooks("task-complete", { task }).catch(() => {});

  // Notify queue + swarm orchestrator
  await onTaskFinished(task.id);
}

// ============================================================
// MONITORING & HEALTH CHECK
// ============================================================

/**
 * Check all running tasks for timeouts and output file completion.
 * Called by the heartbeat system.
 *
 * Returns a list of tasks that need attention (timed out, completed, failed).
 */
export interface CompletedTaskInfo {
  id: string;
  description: string;
  outputFile: string | null;
  outputPreview: string; // first ~500 chars of output
  taskType: "research" | "code";
  status: "completed" | "completed_with_errors" | "failed" | "timeout" | "stalled";
  /** Error message for failed/timeout tasks */
  error?: string | null;
}

export async function checkTasks(): Promise<{
  alerts: string[];
  healthy: boolean;
  completedTasks: CompletedTaskInfo[];
  /** Tasks that completed but haven't been announced yet (for retry logic) */
  unannouncedTasks: SupervisedTask[];
}> {
  const now = Date.now();
  const alerts: string[] = [];
  const completedTasks: CompletedTaskInfo[] = [];
  let healthy = true;

  for (const task of store.tasks) {
    if (task.status !== "running") continue;

    task.lastCheckedAt = new Date().toISOString();
    const elapsed = now - new Date(task.startedAt!).getTime();

    // Check if process is still alive (OpenClaw-inspired health check)
    if (task.pid) {
      try {
        process.kill(task.pid, 0); // signal 0 = check existence
      } catch {
        // Process died without producing output. Mark for retry or failure.
        const durationMs = now - new Date(task.startedAt!).getTime();
        if (!task.outputFile || !existsSync(
          task.outputFile.startsWith("/") || task.outputFile.includes(":") ? task.outputFile : join(PROJECT_DIR, task.outputFile)
        )) {
          const exitInfo = task.error ? ` (${task.error})` : "";
          warn("supervisor", `Subagent PID ${task.pid} for ${task.id} died unexpectedly after ${Math.round(durationMs / 1000)}s${exitInfo}`);
          task.pid = null;

          if (task.retries < task.maxRetries && task.prompt && task.outputFile) {
            task.retries++;
            task.startedAt = new Date().toISOString();
            // Reset stalling state so retry gets a clean slate
            task.stallCount = 0;
            task.lastOutputSample = null;
            (task as any)._stallStartMs = undefined;
            alerts.push(`Task "${task.description}" — subagent died, auto-retrying (${task.retries}/${task.maxRetries}).`);
            // Exponential backoff before retry: 5s, 10s, 20s... (prevents cascade on resource exhaustion)
            const retryDelayMs = Math.min(5000 * Math.pow(2, task.retries - 1), 60_000);
            info("supervisor", `Waiting ${retryDelayMs}ms before retry spawn for ${task.id}`);
            await new Promise((r) => setTimeout(r, retryDelayMs));
            try {
              await spawnSubagent({
                taskId: task.id,
                prompt: task.prompt,
                outputFile: task.outputFile,
                model: task.model,
              });
              info("supervisor", `Respawned dead subagent for ${task.id}`);
            } catch (err) {
              warn("supervisor", `Retry spawn after death failed for ${task.id}: ${err}`);
            }
            await saveTasks();
            continue;
          }
          // No retries left, fall through to output check / timeout
        }
      }
    }

    // Mid-flight progress monitoring (safeguard #1): detect stalled tasks
    if (task.pid && elapsed > task.timeoutMs * 0.5) {
      // Build a progress fingerprint from observable state
      const fingerprint = `tc=${task.toolCallCount}|tool=${task.lastToolName}|file=${task.lastFileTouched}|cost=${task.costUsd}`;

      if (task.lastOutputSample === fingerprint) {
        // Output hasn't changed since last check
        task.stallCount = (task.stallCount || 0) + 1;
        // Track when stall started (first identical fingerprint)
        if (task.stallCount === 1) (task as any)._stallStartMs = now;

        // Kill if stalled for 3 consecutive checks OR 12+ minutes with no progress
        const stallDurationMs = now - ((task as any)._stallStartMs || now);
        if (task.stallCount >= 3 || stallDurationMs > 12 * 60 * 1000) {
          // Stalled for 3 consecutive checks, kill the task
          warn("supervisor", `Task ${task.id} stalled (identical output for ${task.stallCount} checks). Killing PID ${task.pid}.`);
          try {
            gracefulKill(task.pid);
          } catch { /* already dead */ }
          task.pid = null;

          const durationMs = now - new Date(task.startedAt!).getTime();
          task.status = "stalled";
          task.completedAt = new Date().toISOString();
          task.error = `Stalled: no progress for ${task.stallCount} consecutive checks (${Math.round(elapsed / 60000)}m elapsed)`;
          task.outcome = { status: "error", message: task.error, durationMs };
          store.totalFailed++;
          healthy = false;
          alerts.push(`Task STALLED: "${task.description}" — no progress detected for ${task.stallCount} consecutive checks. Killed.`);
          emitTaskEvent("task:failed", task);
          fireHooks("task-complete", { task }).catch(() => {});
          completedTasks.push({
            id: task.id,
            description: task.description,
            outputFile: task.outputFile,
            outputPreview: "",
            taskType: task.taskType,
            status: "failed",
            error: task.error,
          });
          await onTaskFinished(task.id);
          continue;
        } else {
          warn("supervisor", `Task ${task.id} may be stalling (${task.stallCount}/3 identical checks, ${Math.round(elapsed / 60000)}m/${Math.round(task.timeoutMs / 60000)}m)`);
          alerts.push(`Warning: task "${task.description}" may be stalling (${task.stallCount}/3 identical checks)`);
        }
      } else {
        // Progress detected, reset stall counter
        task.lastOutputSample = fingerprint;
        task.stallCount = 0;
      }
    }

    // Check for output file completion
    if (task.outputFile) {
      const outputPath = task.outputFile.startsWith("/") || task.outputFile.includes(":")
        ? task.outputFile
        : join(PROJECT_DIR, task.outputFile);

      if (existsSync(outputPath)) {
        // Defense-in-depth: skip if already announced (prevents duplicate completions)
        if (task.announced) {
          warn("supervisor", `Skipping already-announced task ${task.id} (status was ${task.status}, likely stale state)`);
          task.status = "completed";
          continue;
        }

        // Output file exists, tentatively mark completed then verify
        const durationMs = now - new Date(task.startedAt!).getTime();
        let outputPreview = "";
        try {
          const content = await readFile(outputPath, "utf-8");
          outputPreview = content.substring(0, 500).trim();
          task.status = "completed";
          task.completedAt = new Date().toISOString();
          task.result = `Output saved to ${task.outputFile} (${content.length} chars)`;
          task.outcome = { status: "ok", summary: task.result, durationMs };
        } catch (err) {
          // File exists but can't read, still count as completed
          task.status = "completed";
          task.completedAt = new Date().toISOString();
          task.result = `Output file exists at ${task.outputFile}`;
          task.outcome = { status: "ok", summary: task.result, durationMs };
        }

        // Output verification (safeguard #3) + auto-retry (safeguard #4)
        const verification = await verifyTaskOutput(task);
        if (!verification.verified && verification.adjustedStatus === "failed") {
          // Failed verification. Auto-retry for research tasks (max 1 retry), never for code tasks.
          if (task.taskType === "research" && task.retries < 1 && task.prompt && task.outputFile) {
            task.retries++;
            task.status = "running";
            task.completedAt = null;
            task.result = null;
            task.outcome = null;
            task.startedAt = new Date().toISOString();
            // Reset stalling state so retry gets a clean slate
            task.stallCount = 0;
            task.lastOutputSample = null;
            (task as any)._stallStartMs = undefined;
            const retryPrompt = task.prompt + "\n\nPrevious attempt produced empty or invalid output. Please ensure you write results to the specified output file.";
            alerts.push(`Task "${task.description}" completed with ${verification.reason}. Auto-retrying (${task.retries}/1).`);
            warn("supervisor", `Output verification failed for ${task.id}: ${verification.reason}. Auto-retrying.`);

            // Delete the empty/bad output file so we detect fresh output
            try {
              unlinkSync(outputPath);
            } catch { /* ignore */ }

            const retryDelayMs = 5000;
            await new Promise((r) => setTimeout(r, retryDelayMs));
            try {
              await spawnSubagent({
                taskId: task.id,
                prompt: retryPrompt,
                outputFile: task.outputFile,
                model: task.model,
              });
              info("supervisor", `Respawned subagent for output-verification retry: ${task.id}`);
            } catch (err) {
              warn("supervisor", `Output-verification retry spawn failed for ${task.id}: ${err}`);
              task.status = "failed";
              task.completedAt = new Date().toISOString();
              task.error = `${verification.reason} (retry spawn failed: ${err})`;
              task.outcome = { status: "error", message: task.error, durationMs };
              store.totalFailed++;
            }
            await saveTasks();
            continue;
          }

          // No retry available: mark as failed
          task.status = "failed";
          task.error = verification.reason || "output verification failed";
          task.outcome = { status: "error", message: task.error, durationMs };
          store.totalFailed++;
          const isRetryFailure = task.retries > 0;
          if (isRetryFailure) {
            task.error = `retry also produced empty output (${verification.reason})`;
            task.outcome = { status: "error", message: task.error, durationMs };
          }
          alerts.push(`Task FAILED: "${task.description}" — ${task.error}`);
          logError("supervisor", `Output verification failed permanently for ${task.id}: ${task.error}`);
          completedTasks.push({
            id: task.id,
            description: task.description,
            outputFile: task.outputFile,
            outputPreview,
            taskType: task.taskType,
            status: "failed",
            error: task.error,
          });
          emitTaskEvent("task:failed", task);
          fireHooks("task-complete", { task }).catch(() => {});
          await saveTasks();
          await onTaskFinished(task.id);
          continue;
        }

        // Verification passed (possibly with adjusted status for code tasks)
        if (verification.adjustedStatus === "completed_with_errors") {
          task.status = "completed_with_errors";
          task.error = verification.reason || "output contains error indicators";
          warn("supervisor", `Task ${task.id} completed with errors: ${verification.reason}`);
        }

        store.totalCompleted++;
        alerts.push(`Task completed: "${task.description}" — output at ${task.outputFile}`);
        info("supervisor", `Task auto-completed via output file: ${task.id} (${Math.round(durationMs / 1000)}s)${task.status === "completed_with_errors" ? " [with errors]" : ""}`);
        completedTasks.push({
          id: task.id,
          description: task.description,
          outputFile: task.outputFile,
          outputPreview,
          taskType: task.taskType,
          status: task.status === "completed_with_errors" ? "completed_with_errors" : "completed",
          error: task.error,
        });
        // Event-driven delivery (immediate)
        emitTaskEvent("task:completed", task);
        fireHooks("task-complete", { task }).catch(() => {});
        // Persist immediately so state survives before next tick
        await saveTasks();
        // Notify queue + swarm
        await onTaskFinished(task.id);
        continue;
      }
    }

    // Check for timeout
    if (elapsed > task.timeoutMs) {
      if (task.retries < task.maxRetries) {
        // Kill existing process before retry
        if (task.pid) {
          try {
            gracefulKill(task.pid);
            info("supervisor", `Terminated subagent PID ${task.pid} before retry for ${task.id}`);
          } catch {
            // Process already dead
          }
          task.pid = null;
        }

        // Can retry
        task.retries++;
        task.startedAt = new Date().toISOString();
        // Reset stalling state so retry gets a clean slate
        task.stallCount = 0;
        task.lastOutputSample = null;
        (task as any)._stallStartMs = undefined;
        alerts.push(
          `Task "${task.description}" timed out after ${Math.round(elapsed / 60000)}m. ` +
          `Retry ${task.retries}/${task.maxRetries}.`
        );
        warn("supervisor", `Task timed out, retrying: ${task.id} (attempt ${task.retries})`);

        // Respawn subagent if we have the prompt (with backoff delay)
        if (task.prompt && task.outputFile) {
          const retryDelayMs = Math.min(5000 * Math.pow(2, task.retries - 1), 60_000);
          info("supervisor", `Waiting ${retryDelayMs}ms before timeout retry for ${task.id}`);
          await new Promise((r) => setTimeout(r, retryDelayMs));
          try {
            await spawnSubagent({
              taskId: task.id,
              prompt: task.prompt,
              outputFile: task.outputFile,
              model: task.model,
            });
            info("supervisor", `Respawned subagent for retry: ${task.id}`);
          } catch (err) {
            warn("supervisor", `Retry spawn failed for ${task.id}: ${err}`);
          }
        }
      } else {
        // Kill orphaned process
        if (task.pid) {
          try {
            gracefulKill(task.pid);
            info("supervisor", `Terminated orphaned subagent PID ${task.pid} for ${task.id}`);
          } catch {
            // Process already dead
          }
          task.pid = null;
        }

        // Max retries exhausted
        task.status = "timeout";
        task.completedAt = new Date().toISOString();
        task.error = `Timed out after ${Math.round(elapsed / 60000)}m (${task.retries} retries)`;
        task.outcome = { status: "timeout", message: task.error, durationMs: elapsed };
        store.totalTimedOut++;
        healthy = false;
        alerts.push(
          `Task FAILED: "${task.description}" — timed out after ${Math.round(elapsed / 60000)}m ` +
          `with ${task.retries} retries. Output file ${task.outputFile ? "never appeared" : "not configured"}.`
        );
        logError("supervisor", `Task timed out permanently: ${task.id} — ${task.description}`);
        // Event-driven delivery (immediate)
        emitTaskEvent("task:timeout", task);
        fireHooks("task-complete", { task }).catch(() => {});
        // Persist immediately so state survives before next tick
        await saveTasks();
        completedTasks.push({
          id: task.id,
          description: task.description,
          outputFile: task.outputFile,
          outputPreview: "",
          taskType: task.taskType,
          status: "timeout",
          error: task.error,
        });
      }
    }
  }

  // Expire stale running tasks with no PID (orphaned, OpenClaw pattern)
  // If a task has been running for 2x its timeout with no PID, force-fail it.
  for (const task of store.tasks) {
    if (task.status === "running" && !task.pid) {
      const elapsed = now - new Date(task.startedAt!).getTime();
      if (elapsed > task.timeoutMs * 2) {
        task.status = "failed";
        task.completedAt = new Date().toISOString();
        task.error = `Stale task expired (no PID, ${Math.round(elapsed / 60000)}m old)`;
        task.outcome = { status: "error", message: task.error, durationMs: elapsed };
        store.totalFailed++;
        alerts.push(`Stale task expired: "${task.description}" — ${task.error || "no PID, no output"}`);
        warn("supervisor", `Expired stale task ${task.id} (no PID for ${Math.round(elapsed / 60000)}m)`);
      }
    }
  }

  // Clean up: archive old completed/failed tasks (>24h old)
  const cutoff = now - 24 * 60 * 60 * 1000;
  const toArchive = store.tasks.filter(
    (t) =>
      isTerminalStatus(t.status) &&
      t.completedAt &&
      new Date(t.completedAt).getTime() < cutoff
  );
  for (const task of toArchive) {
    await archiveTask(task);
  }
  if (toArchive.length > 0) {
    store.tasks = store.tasks.filter((t) => !toArchive.includes(t));
    info("supervisor", `Archived ${toArchive.length} old tasks`);
  }

  // Clean up stale git worktrees (>3h, auto-expired), but protect running tasks
  try {
    const runningTaskIds = new Set(
      store.tasks.filter(t => t.status === "running").map(t => t.id)
    );
    const staleCleanedCount = await cleanupStaleWorktrees(runningTaskIds);
    if (staleCleanedCount > 0) {
      alerts.push(`Cleaned up ${staleCleanedCount} stale worktree(s)`);
    }
  } catch (err) {
    warn("supervisor", `Worktree cleanup failed: ${err}`);
  }

  // Collect unannounced completed tasks for delivery retry (OpenClaw announce pattern)
  const unannouncedTasks = store.tasks.filter(
    (t) => isTerminalStatus(t.status) && !t.announced
  );

  store.lastCheckAt = new Date().toISOString();
  await saveTasks();

  return { alerts, healthy, completedTasks, unannouncedTasks };
}

/**
 * Get all tasks that completed but were never announced.
 * Used by startup recovery to drain undelivered results.
 */
export function getUnannouncedTasks(): SupervisedTask[] {
  return store.tasks.filter(
    (t) => isTerminalStatus(t.status) && !t.announced
  );
}

/**
 * Mark a task as announced (completion message delivered to user).
 * Supports the OpenClaw announce-retry pattern.
 */
export async function markAnnounced(taskId: string): Promise<void> {
  const task = store.tasks.find((t) => t.id === taskId);
  if (task) {
    task.announced = true;
    task.lastAnnounceAt = new Date().toISOString();
    await saveTasks();
  }
}

/**
 * Increment announce retry count for a task (backoff tracking).
 */
export async function incrementAnnounceRetry(taskId: string): Promise<void> {
  const task = store.tasks.find((t) => t.id === taskId);
  if (task) {
    task.announceRetryCount++;
    task.lastAnnounceAt = new Date().toISOString();
    await saveTasks();
  }
}

// ============================================================
// CONTEXT FOR HEARTBEAT / STATUS
// ============================================================

/**
 * Get supervisor context for heartbeat prompt injection.
 * Uses intent-first reporting: leads with WHAT happened, not raw IDs.
 * Inspired by OpenClaw's structured outcome pattern.
 */
export function getTaskContext(): string {
  const running = store.tasks.filter((t) => t.status === "running");
  // Show completed tasks from last 24h OR last 5, whichever is more.
  // Prevents task completions from falling off before Claude sees them.
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const allFinished = store.tasks.filter((t) => isTerminalStatus(t.status));
  const last24h = allFinished.filter((t) => t.completedAt && new Date(t.completedAt).getTime() > oneDayAgo);
  const lastFive = allFinished.slice(-5);
  const recent = last24h.length > lastFive.length ? last24h : lastFive;

  if (running.length === 0 && recent.length === 0) {
    return "SUPERVISED TASKS: None active or recent.";
  }

  let context = "SUPERVISED TASKS:\n";

  if (running.length > 0) {
    context += `Active (${running.length}):\n`;
    for (const t of running) {
      const elapsed = Math.round(
        (Date.now() - new Date(t.startedAt!).getTime()) / 60000
      );
      const timeout = Math.round(t.timeoutMs / 60000);
      // Intent-first: describe what's happening, then metadata
      if (t.taskType === "code") {
        const progress = t.toolCallCount ? `${t.toolCallCount} tools used` : "starting";
        const cost = t.costUsd ? `, $${t.costUsd.toFixed(2)}` : "";
        const doing = t.lastToolName ? ` (${t.lastToolName}${t.lastFileTouched ? ` on ${t.lastFileTouched.split(/[/\\]/).pop()}` : ""})` : "";
        context += `  - Coding [${t.id}]: "${t.description}" — ${progress}${doing}, ${elapsed}m/${timeout}m${cost}\n`;
      } else if (t.taskType === "ingest") {
        const progress = t.toolCallCount ? `${t.toolCallCount} files processed` : "starting";
        const doing = t.lastToolName ? ` (${t.lastToolName})` : "";
        context += `  - Ingesting [${t.id}]: "${t.description}" — ${progress}${doing}, ${elapsed}m/${timeout}m\n`;
      } else {
        const retryNote = t.retries > 0 ? ` (retry ${t.retries}/${t.maxRetries})` : "";
        context += `  - Researching [${t.id}]: "${t.description}" — ${elapsed}m/${timeout}m${retryNote}\n`;
      }
      // Conductor: show original instructions so Claude can reason about follow-ups
      if (t.prompt) {
        const instrPreview = t.prompt.substring(0, 200).replace(/\n/g, " ");
        context += `    Instructions: "${instrPreview}${t.prompt.length > 200 ? "..." : ""}"\n`;
      }
    }
  }

  if (recent.length > 0) {
    context += "Recent results:\n";
    for (const t of recent) {
      // Intent-first: lead with the outcome, then details
      if (t.outcome) {
        const dur = `${Math.round(t.outcome.durationMs / 1000)}s`;
        if (t.outcome.status === "ok") {
          context += `  - Done: "${t.description}" (${dur})`;
          if (t.outputFile) context += ` — ${t.outputFile}`;
          context += "\n";
        } else if (t.outcome.status === "error") {
          context += `  - Failed: "${t.description}" (${dur}) — ${t.outcome.message.substring(0, 80)}\n`;
        } else {
          context += `  - Timed out: "${t.description}" (${dur}) — ${t.outcome.message.substring(0, 80)}\n`;
        }
      } else {
        // Legacy tasks without outcome
        const icon = t.status === "completed" ? "Done" : t.status === "completed_with_errors" ? "Done (with errors)" : t.status === "stalled" ? "Stalled" : t.status === "failed" ? "Failed" : "Timed out";
        context += `  - ${icon}: "${t.description}"`;
        if (t.result) context += ` — ${t.result.substring(0, 100)}`;
        if (t.error) context += ` — ${t.error.substring(0, 100)}`;
        context += "\n";
      }
    }
  }

  context += `Lifetime: ${store.totalCompleted} completed, ${store.totalFailed} failed, ${store.totalTimedOut} timed out`;
  return context;
}

/**
 * Format a task result in intent-first style for user-facing messages.
 * Leads with what was accomplished, not internal status codes.
 */
export function formatTaskResult(task: SupervisedTask): string {
  const desc = task.description || `Task ${task.id || "unknown"}`;

  if (!task.outcome) {
    // Legacy fallback
    if (task.status === "completed") return `Task done: ${desc}. ${task.result || ""}`.trim();
    if (task.status === "completed_with_errors") return `Task done (with errors): ${desc}. ${task.error || ""}`.trim();
    if (task.status === "stalled") return `Task stalled: ${desc}. ${task.error || ""}`.trim();
    if (task.status === "failed") return `Task failed: ${desc}. ${task.error || ""}`.trim();
    return `Task ${task.status}: ${desc}`;
  }

  const dur = Math.round((task.outcome.durationMs ?? 0) / 1000);
  const durStr = dur > 60 ? `${Math.round(dur / 60)}m` : `${dur}s`;

  switch (task.outcome.status) {
    case "ok": {
      const where = task.outputFile ? ` Output: ${task.outputFile}` : "";
      return `${desc} completed in ${durStr}.${where}`;
    }
    case "error":
      return `${desc} failed after ${durStr}: ${task.outcome.message || "unknown error"}`;
    case "timeout":
      return `${desc} timed out after ${durStr}. ${task.retries > 0 ? `Tried ${task.retries + 1} times.` : ""}`.trim();
    default:
      return `${desc}: ${task.outcome.status || "unknown status"}`;
  }
}

/**
 * Get summary for /status command.
 */
export function getTaskStatus(): {
  running: number;
  completed: number;
  failed: number;
  timedOut: number;
  tasks: SupervisedTask[];
} {
  return {
    running: store.tasks.filter((t) => t.status === "running").length,
    completed: store.totalCompleted,
    failed: store.totalFailed,
    timedOut: store.totalTimedOut,
    tasks: store.tasks,
  };
}

/**
 * Get all currently running tasks (for display or retry).
 */
export function getRunningTasks(): SupervisedTask[] {
  return store.tasks.filter((t) => t.status === "running");
}

/**
 * Get a specific task by ID.
 */
export function getTask(taskId: string): SupervisedTask | null {
  return store.tasks.find(t => t.id === taskId) || null;
}

/** Get and clear pending amendment queries for a task (consumed on completion). */
export function consumePendingAmendments(taskId: string): string[] {
  const task = store.tasks.find(t => t.id === taskId);
  if (!task || !task._pendingAmendments?.length) return [];
  const amendments = [...task._pendingAmendments];
  task._pendingAmendments = [];
  return amendments;
}

/**
 * Cancel a running task by ID.
 */
export async function cancelTask(id: string, reason?: string): Promise<boolean> {
  const task = store.tasks.find((t) => t.id === id && t.status === "running");
  if (!task) return false;

  // Kill subagent process if running
  if (task.pid) {
    try {
      gracefulKill(task.pid);
      info("supervisor", `Terminated subagent PID ${task.pid} for cancelled task ${task.id}`);
    } catch {
      // Process already dead
    }
    task.pid = null;
  }

  task.status = "failed";
  task.completedAt = new Date().toISOString();
  task.error = reason || "Cancelled by user";
  store.totalFailed++;
  await saveTasks();
  info("supervisor", `Task cancelled: ${task.id} — ${task.description}`);
  return true;
}

/**
 * Kill all running subagent processes and mark them as failed.
 * Called during graceful shutdown to avoid orphaned processes.
 * Returns the number of processes killed.
 */
export async function killAllRunningSubagents(reason = "Process shutdown"): Promise<number> {
  const running = store.tasks.filter((t) => t.status === "running");
  let killed = 0;

  for (const task of running) {
    if (task.pid) {
      try {
        gracefulKill(task.pid, 1000); // shorter grace on shutdown
        info("supervisor", `Shutdown: terminated subagent PID ${task.pid} (${task.id}: ${task.description})`);
        killed++;
      } catch {
        // Process already dead
      }
      task.pid = null;
    }

    const durationMs = task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : 0;
    task.status = "failed";
    task.completedAt = new Date().toISOString();
    task.error = reason;
    task.outcome = { status: "error", message: reason, durationMs };
    store.totalFailed++;
  }

  if (killed > 0) {
    await saveTasks();
    info("supervisor", `Shutdown: killed ${killed} running subagent(s)`);
  }

  return killed;
}

// ============================================================
// QUEUE DISPATCH HANDLER
// ============================================================

/**
 * Called by the queue when a slot opens and a task is ready to dispatch.
 * Spawns the appropriate agent type for the queued task.
 */
export async function dispatchQueuedTask(queued: QueuedTask): Promise<void> {
  const task = store.tasks.find(t => t.id === queued.id);
  if (!task) {
    warn("supervisor", `Queued task ${queued.id} not found in task store, skipping dispatch`);
    return;
  }

  task.status = "running";
  task.startedAt = new Date().toISOString();
  await saveTasks();

  if (queued.taskType === "code" && queued.cwd) {
    await spawnCodeAgent({
      taskId: queued.id,
      prompt: queued.prompt,
      cwd: queued.cwd,
      model: queued.model,
      maxToolCalls: queued.maxToolCalls,
      wallClockMs: queued.wallClockMs,
      inactivityMs: queued.inactivityMs,
      budgetUsd: queued.budgetUsd,
    });
  } else if (queued.outputFile) {
    await spawnSubagent({
      taskId: queued.id,
      prompt: queued.prompt,
      outputFile: queued.outputFile,
      model: queued.model,
    });
  } else {
    warn("supervisor", `Queued task ${queued.id} has no output file or cwd, cannot dispatch`);
    task.status = "failed";
    task.error = "Missing output file or cwd for dispatch";
    store.totalFailed++;
    await saveTasks();
  }
}

// ============================================================
// TASK COMPLETION CALLBACK (triggers queue dispatch)
// ============================================================

/** Swarm completion callback, registered by orchestrator */
let swarmCompletionCallback: ((taskId: string, swarmId: string, dagNodeId: string, cost: number) => Promise<void>) | null = null;

export function registerSwarmCompletionCallback(
  cb: (taskId: string, swarmId: string, dagNodeId: string, cost: number) => Promise<void>
): void {
  swarmCompletionCallback = cb;
}

/**
 * Check dependency status for a task.
 * Returns "ready" if all deps completed, "blocked" if some still pending/running,
 * or "failed" if any dep failed/timed out.
 */
function checkDependencies(depIds: string[]): {
  status: "ready" | "blocked" | "failed";
  waitingOn: string[];
  failedDeps: string[];
} {
  const waitingOn: string[] = [];
  const failedDeps: string[] = [];

  for (const depId of depIds) {
    const dep = store.tasks.find(t => t.id === depId);
    if (!dep) {
      failedDeps.push(depId); // unknown dep = treat as failed
      continue;
    }
    if (dep.status === "completed" || dep.status === "completed_with_errors") {
      continue; // dep satisfied
    }
    if (dep.status === "failed" || dep.status === "timeout" || dep.status === "stalled") {
      failedDeps.push(depId);
    } else {
      waitingOn.push(depId); // still pending or running
    }
  }

  if (failedDeps.length > 0) return { status: "failed", waitingOn, failedDeps };
  if (waitingOn.length > 0) return { status: "blocked", waitingOn, failedDeps };
  return { status: "ready", waitingOn, failedDeps };
}

/**
 * Check if any pending tasks with dependencies are now unblocked.
 * Called when a task completes or fails to cascade immediately.
 */
async function dispatchUnblockedTasks(): Promise<void> {
  const pendingWithDeps = store.tasks.filter(
    t => t.status === "pending" && t.dependsOn?.length
  );

  for (const task of pendingWithDeps) {
    const depCheck = checkDependencies(task.dependsOn!);

    if (depCheck.status === "failed") {
      // Cascade failure
      task.status = "failed";
      task.error = `Dependency failed: ${depCheck.failedDeps.join(", ")}`;
      task.completedAt = new Date().toISOString();
      store.totalFailed++;
      emitTaskEvent("task:failed", task);
      fireHooks("task-complete", { task }).catch(() => {});
      warn("supervisor", `Task ${task.id} cascade-failed (dep failure)`);
    } else if (depCheck.status === "ready") {
      // All deps met, spawn the task
      info("supervisor", `Task ${task.id} unblocked, spawning...`);
      task.status = "running";
      task.startedAt = new Date().toISOString();

      if (task.prompt && task.outputFile) {
        const running = getRunningSubagentCount();
        if (running < MAX_CONCURRENT_SUBAGENTS) {
          try {
            await spawnSubagent({
              taskId: task.id,
              prompt: task.prompt,
              outputFile: task.outputFile,
              model: task.model,
            });
          } catch (err) {
            task.error = `Spawn failed: ${err}`;
            task.status = "failed";
            store.totalFailed++;
          }
        } else {
          // Queue it
          task.status = "pending";
          await enqueue({
            id: task.id,
            priority: TaskPriority.NORMAL,
            enqueuedAt: new Date().toISOString(),
            ttl: DEFAULT_TTL_MS,
            taskType: task.taskType,
            description: task.description,
            prompt: task.prompt,
            outputFile: task.outputFile,
            cwd: task.cwd,
            model: task.model,
            timeoutMs: task.timeoutMs,
            maxRetries: task.maxRetries,
            requestedBy: task.requestedBy,
            swarmId: task._swarmId || null,
            dagNodeId: task._dagNodeId || null,
          });
        }
      }
    }
    // "blocked" = still waiting, do nothing
  }

  await saveTasks();
}

/**
 * Called internally when any task completes (research or code).
 * Triggers queue dispatch to fill the freed slot.
 * If the task is part of a swarm, notifies the orchestrator.
 * Checks for unblocked dependent tasks.
 */
async function onTaskFinished(taskId: string): Promise<void> {
  // Try to fill the freed slot
  await tryDispatch();

  // Check if any pending tasks with dependencies are now unblocked
  await dispatchUnblockedTasks();

  // Check if this task was part of a swarm
  const task = store.tasks.find(t => t.id === taskId);
  if (task && swarmCompletionCallback) {
    const swarmId = (task as any)._swarmId;
    const dagNodeId = (task as any)._dagNodeId;
    if (swarmId && dagNodeId) {
      await swarmCompletionCallback(taskId, swarmId, dagNodeId, task.costUsd);
    }
  }
}

// ============================================================
// INTENT PROCESSING (tag extraction from Claude responses)
// ============================================================

// Full format: [TASK: description | OUTPUT: filename.md | PROMPT: detailed instructions]
// Minimal format: [TASK: description] (auto-generates output file, uses description as prompt)
// Partial format: [TASK: description | PROMPT: instructions] (auto-generates output file)
// All formats supported. Fields parsed by lookahead, not greedy pipe splitting.

// Match the outer [TAG: ...] bracket, then parse fields inside.
// Uses alternation (non-bracket chars | balanced bracket pairs) to handle
// one level of nested brackets in PROMPT content (e.g. "array[0]", "[this]").
const TASK_OUTER_REGEX = /\[TASK:\s*((?:[^\[\]]|\[[^\]]*\])*)\](?!\()/g;
const CODE_TASK_OUTER_REGEX = /\[CODE_TASK:\s*((?:[^\[\]]|\[[^\]]*\])*)\](?!\()/g;
const INGEST_FOLDER_OUTER_REGEX = /\[INGEST_FOLDER:\s*((?:[^\[\]]|\[[^\]]*\])*)\](?!\()/g;
const TASK_AMEND_OUTER_REGEX = /\[TASK_AMEND:\s*((?:[^\[\]]|\[[^\]]*\])*)\](?!\()/g;
const TASK_CANCEL_OUTER_REGEX = /\[TASK_CANCEL:\s*((?:[^\[\]]|\[[^\]]*\])*)\](?!\()/g;

/**
 * Structural validators for agent-spawning tags.
 * These run AFTER regex extraction but BEFORE spawning to reject conversational
 * bullet points that accidentally match tag syntax. A valid tag must contain
 * pipe-delimited fields with the required keywords.
 *
 * Example of what gets rejected: "[TASK: check the logs]" (no pipe, no PROMPT:)
 * Example of what passes: "[TASK: desc | OUTPUT: file.md | PROMPT: do research]"
 */
const TASK_REQUIRED_FIELDS = /\|\s*(?:PROMPT|OUTPUT)\s*:/i;
const CODE_TASK_REQUIRED_FIELDS = /^cwd\s*=/i;
const CODE_TASK_PROMPT_FIELD = /\|\s*PROMPT\s*:/i;
const INGEST_REQUIRED_FIELDS = /^path\s*=/i;
const TASK_AMEND_REQUIRED_FIELDS = /\|\s*INSTRUCTIONS\s*:/i;
const TASK_CANCEL_REQUIRED_FIELDS = /\|\s*REASON\s*:/i;

// Fallback detection: phrases that suggest Claude intended to delegate but didn't emit a tag.
const TASK_INTENT_HINTS = [
  /(?:research\s+(?:task|agent)?|background\s+task)\s+(?:is\s+)?(?:running|started|kicked off|spawned|delegated)/i,
  /(?:I'll|I will)\s+(?:spin up|spawn|kick off|delegate|start)\s+(?:a\s+)?(?:research|background|sub-?\s*agent)/i,
  /(?:spinning up|kicking off|spawning)\s+(?:a\s+)?(?:research|background|sub-?\s*agent)/i,
];

/** Parse tag fields using lookahead-based splitting (pipe-safe). */
function parseTaskFields(raw: string): { description: string; outputFile: string; prompt: string } {
  // Split on | only when followed by known field names (OUTPUT: or PROMPT:)
  const parts = raw.split(/\s*\|\s*(?=(?:OUTPUT|PROMPT)\s*:)/i);

  let description = parts[0].trim();
  let outputFile = "";
  let prompt = "";

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const outputMatch = part.match(/^OUTPUT\s*:\s*([\s\S]*)/i);
    const promptMatch = part.match(/^PROMPT\s*:\s*([\s\S]*)/i);
    if (outputMatch) outputFile = outputMatch[1].trim();
    else if (promptMatch) prompt = promptMatch[1].trim();
  }

  // Auto-generate output filename from description if not provided
  if (!outputFile) {
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 60);
    outputFile = `${slug}.md`;
  }

  // Use description as prompt if prompt not provided
  if (!prompt) {
    prompt = description;
  }

  return { description, outputFile, prompt };
}

/**
 * Extract [TASK: ...] tags from Claude's response.
 * Supports full, partial, and minimal formats.
 * Spawns a supervised subagent for each match, replaces the tag with a status note.
 * Logs a warning if task-like language is detected but no tag was found.
 */
export async function processTaskIntents(response: string): Promise<string> {
  let processed = response;
  const matches: { fullMatch: string; description: string; outputFile: string; prompt: string }[] = [];
  const rejectedTags: string[] = [];
  const seen = new Set<string>();

  let match;
  try {
    while ((match = TASK_OUTER_REGEX.exec(response)) !== null) {
      const rawContent = match[1];
      // Structural validation: require pipe-delimited PROMPT: or OUTPUT: field
      if (!TASK_REQUIRED_FIELDS.test(rawContent)) {
        warn("supervisor", `Rejected [TASK:] tag without required fields (PROMPT: or OUTPUT:): "${rawContent.substring(0, 100)}"`);
        rejectedTags.push(rawContent.substring(0, 80));
        continue;
      }
      const fields = parseTaskFields(rawContent);
      if (fields.description) {
        const key = fields.prompt.substring(0, 80);
        if (!seen.has(key)) {
          seen.add(key);
          matches.push({ fullMatch: match[0], ...fields });
        } else {
          warn("supervisor", `Duplicate [TASK:] tag skipped: "${key}"`);
        }
      }
    }
  } finally {
    TASK_OUTER_REGEX.lastIndex = 0;
  }

  // Spawn tasks
  for (const m of matches) {
    try {
      const taskId = await registerTask({
        description: m.description,
        outputFile: m.outputFile,
        prompt: m.prompt,
        model: RESEARCH_DEFAULT_MODEL,
        timeoutMs: 20 * 60 * 1000, // 20 min for research tasks
        maxRetries: 1,
      });
      processed = processed.replace(
        m.fullMatch,
        `Background task started: ${m.description} (${taskId})`
      );
      info("supervisor", `Task intent processed: ${taskId} — ${m.description}`);
    } catch (err) {
      processed = processed.replace(m.fullMatch, `Task spawn failed: ${err}`);
      warn("supervisor", `Task intent spawn failed: ${err}`);
    }
  }

  // Fallback: detect task-like language without a matching tag.
  // Skip if CODE_TASK tags are present -- "agent is running" language refers to the code agent.
  if (matches.length === 0) {
    CODE_TASK_OUTER_REGEX.lastIndex = 0;
    const hasCodeTask = CODE_TASK_OUTER_REGEX.test(response);
    CODE_TASK_OUTER_REGEX.lastIndex = 0;

    if (!hasCodeTask) {
      for (const hint of TASK_INTENT_HINTS) {
        if (hint.test(processed)) {
          warn("supervisor", `Phantom research dispatch: task language detected but no [TASK:] tag found: "${processed.substring(0, 200)}"`);
          let warning = "\n\n\u26A0\uFE0F I mentioned delegating research but no [TASK:] tags were emitted. The research did NOT actually start. Please re-request so I can emit proper [TASK:] tags.";
          if (rejectedTags.length > 0) {
            warning += `\n(Rejected tags: ${rejectedTags.map(t => `"${t}"`).join(", ")}. Required format: [TASK: description | PROMPT: instructions])`;
          }
          processed += warning;
          break;
        }
      }
    }
  }

  return processed;
}

// ============================================================
// CODE AGENT — autonomous coding subagent with streaming
// ============================================================

export interface CodeAgentProgress {
  toolName: string;
  toolCallCount: number;
  elapsedSec: number;
  lastFile?: string;
  costUsd: number;
}

export interface CodeAgentResult {
  success: boolean;
  resultText: string;
  toolCallCount: number;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  exitReason: "completed" | "tool_limit" | "wall_clock" | "inactivity" | "budget" | "error";
}

export interface CodeAgentOptions {
  taskId: string;
  prompt: string;
  cwd: string;
  model?: ModelTier;
  maxToolCalls?: number;
  wallClockMs?: number;
  inactivityMs?: number;
  budgetUsd?: number;
  onProgress?: (update: CodeAgentProgress) => void;
  onComplete?: (result: CodeAgentResult) => void;
  // Supervisor system options
  /** Disable context injection for this task */
  skipContextInjection?: boolean;
  /** Disable pattern detection for this task */
  skipPatternDetect?: boolean;
  /** Disable shadow evaluation for this task */
  skipShadowEval?: boolean;
  /** Checkpoint spec for phase tracking */
  checkpoints?: string;
  /** Callback when intervention is triggered */
  onIntervention?: (pattern: DetectedPattern | EvaluationResult, action: string) => void;
  /** This is a restart of a previous task (provides context) */
  isRestart?: boolean;
  /** Previous attempt summary for restart context */
  previousAttemptSummary?: string;
  /** Patterns to avoid from previous attempt */
  avoidPatterns?: string[];
  /** Conversation context for the agent */
  conversationContext?: string;
  /** Nesting depth (cascade prevention) */
  depth?: number;
}

/**
 * Build the base prompt wrapper for code agents.
 * Context injection is handled separately by wrapCodePromptWithContext().
 */
function wrapCodePromptBase(userPrompt: string, depth = 0): string {
  const depthRule = depth >= SUBAGENT_MAX_DEPTH - 1
    ? "DEPTH LIMIT: You are at maximum nesting depth. Do NOT use the Task tool to spawn subagents. Complete all work yourself."
    : "You can use the Task tool to spawn subagents (subagent_type='Bash', 'Explore', 'general-purpose', 'Plan') for parallel work when it would speed things up. Do NOT spawn more than 3 subagents.";

  return [
    "You are a code agent. Complete the following coding task autonomously.",
    "Work directly on the project files in your working directory.",
    "Read files, make edits, run tests/builds as needed. Iterate until done.",
    "When finished, your final message should summarize what you changed.",
    depthRule,
    "",
    "SECURITY RULES:",
    "- Never use shell interpolation ($(...), `...`, ${...}) in Bash commands",
    "- Use literal strings and proper quoting for all shell arguments",
    "- Do not read, echo, or log .env files, tokens, or secrets",
    "- Do not modify .env, credentials, or security-sensitive files",
    "- Do not install packages or run scripts from untrusted sources",
    "- Stay within the working directory. Do not access parent directories outside the project",
    "",
    "TASK:",
    userPrompt,
  ].join("\n");
}

/**
 * Legacy wrapper for backward compatibility.
 */
function wrapCodePrompt(userPrompt: string, depth = 0): string {
  return wrapCodePromptBase(userPrompt, depth);
}

/**
 * Build code agent prompt with rich context injection.
 * Assembles CLAUDE.md, SOUL.md, USER.md excerpts and task-specific memory.
 */
async function wrapCodePromptWithContext(opts: {
  prompt: string;
  cwd: string;
  isRestart?: boolean;
  previousAttemptSummary?: string;
  avoidPatterns?: string[];
  toolHistory?: string[];
  conversationContext?: string;
  depth?: number;
}): Promise<string> {
  try {
    let contextBundle;

    if (opts.isRestart && opts.previousAttemptSummary) {
      // Build restart context with failure information
      contextBundle = await buildRestartContext({
        originalPrompt: opts.prompt,
        failureReason: opts.previousAttemptSummary,
        attemptSummary: opts.previousAttemptSummary,
        toolHistory: opts.toolHistory,
        avoidPatterns: opts.avoidPatterns,
        cwd: opts.cwd,
      });
    } else {
      // Build fresh context with conversation history
      contextBundle = await buildCodeAgentContext({
        prompt: opts.prompt,
        cwd: opts.cwd,
        additionalContext: opts.conversationContext
          ? "# Recent Conversation Context\nRecent messages between Derek and Atlas for task context:\n\n" + opts.conversationContext
          : undefined,
      });

      // Check for learned patterns
      if (SUPERVISOR_LEARNING) {
        const similarPatterns = await findSimilarPatterns(opts.prompt);
        const guidance = buildPatternGuidance(similarPatterns);
        if (guidance) {
          contextBundle.context += "\n\n" + guidance;
        }
      }
    }

    info("supervisor", `Context injection: ${contextBundle.estimatedTokens} tokens from [${contextBundle.sources.join(", ")}]`);

    // Combine context with base prompt
    const basePrompt = wrapCodePromptBase(opts.prompt, opts.depth ?? 0);
    return contextBundle.context + "\n\n---\n\n" + basePrompt;
  } catch (err) {
    warn("supervisor", `Context injection failed, using base prompt: ${err}`);
    return wrapCodePromptBase(opts.prompt);
  }
}

/**
 * Describe what a code agent is doing in human-readable terms.
 * Inspired by "What Are You Doing?" (2026) research on intermediate
 * feedback from agentic LLM assistants during multi-step processing.
 * Users respond better to descriptive phase labels than raw tool names.
 */
function describeAgentActivity(toolName: string, toolCallCount: number, lastFile?: string): string {
  const fileName = lastFile?.split(/[/\\]/).pop() || "";

  // Phase detection based on tool patterns
  if (toolCallCount <= 3) {
    if (toolName === "Glob" || toolName === "Grep" || toolName === "Read") {
      return "Exploring the codebase";
    }
    return "Getting oriented";
  }

  // Tool-specific descriptions
  switch (toolName) {
    case "Read":
      return fileName ? `Reading ${fileName}` : "Reading files";
    case "Glob":
    case "Grep":
      return "Searching for relevant code";
    case "Edit":
      return fileName ? `Editing ${fileName}` : "Making changes";
    case "Write":
      return fileName ? `Writing ${fileName}` : "Creating files";
    case "Bash":
      return "Running a command";
    case "Task":
      return "Delegating to a subagent";
    case "WebSearch":
    case "WebFetch":
      return "Researching online";
    default:
      return toolName || "Working";
  }
}

/**
 * Extract file path from tool input for progress display.
 * Looks for common tool input patterns (file_path, path, command with file args).
 */
function extractFilePath(toolName: string, toolInput?: Record<string, any>): string | undefined {
  if (!toolInput) return undefined;
  // Direct file path fields
  if (toolInput.file_path) return toolInput.file_path;
  if (toolInput.path) return toolInput.path;
  // For Bash tool, try to extract file from command
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    const cmd = toolInput.command;
    // Simple heuristic: last token that looks like a file path
    const tokens = cmd.split(/\s+/);
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].includes("/") || tokens[i].includes("\\") || tokens[i].includes(".")) {
        return tokens[i];
      }
    }
  }
  return undefined;
}

/** Output directory for code agent streams */
const CODE_AGENT_OUTPUT_DIR = join(DATA_DIR, "code-agent-output");

/**
 * Spawn a code agent that runs Claude Code autonomously in a target project directory.
 *
 * FIRE-AND-FORGET ARCHITECTURE:
 * - Spawns the process and returns immediately (non-blocking)
 * - Writes output to data/code-agent-output/{taskId}.jsonl
 * - Supervisor worker (cron) handles monitoring, pattern detection, intervention
 * - Relay stays responsive for conversation while code work runs in background
 */
export async function spawnCodeAgent(opts: CodeAgentOptions): Promise<void> {
  const running = getRunningSubagentCount();
  if (running >= MAX_CONCURRENT_SUBAGENTS) {
    throw new Error(
      `Max concurrent subagents reached (${MAX_CONCURRENT_SUBAGENTS}). Wait for a running task to finish.`
    );
  }

  const modelTier = opts.model || CODE_AGENT_DEFAULT_MODEL;
  const modelId = MODELS[modelTier];

  // === SUPERVISOR: Context Injection ===
  let wrappedPrompt: string;
  if (SUPERVISOR_ENABLED && SUPERVISOR_CONTEXT_INJECTION && !opts.skipContextInjection) {
    wrappedPrompt = await wrapCodePromptWithContext({
      prompt: opts.prompt,
      cwd: opts.cwd,
      isRestart: opts.isRestart,
      previousAttemptSummary: opts.previousAttemptSummary,
      avoidPatterns: opts.avoidPatterns,
      conversationContext: opts.conversationContext,
      depth: opts.depth ?? 0,
    });
  } else {
    wrappedPrompt = wrapCodePrompt(opts.prompt, opts.depth ?? 0);
  }

  const args = [
    CLAUDE_PATH,
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", modelId,
    "--dangerously-skip-permissions",
  ];

  validateSpawnArgs(args);

  // Validate cwd exists and is writable before spawning
  if (!existsSync(opts.cwd)) {
    throw new Error(`Code agent cwd does not exist: ${opts.cwd}`);
  }
  try {
    const stat = statSync(opts.cwd);
    if (!stat.isDirectory()) {
      throw new Error(`Code agent cwd is not a directory: ${opts.cwd}`);
    }
    // Write+delete a probe file to confirm writable
    const probe = join(opts.cwd, `.atlas-probe-${Date.now()}`);
    await writeFile(probe, "");
    unlinkSync(probe);
  } catch (err: any) {
    if (err.message?.startsWith("Code agent cwd")) throw err;
    throw new Error(`Code agent cwd is not writable: ${opts.cwd} (${err.message})`);
  }

  // Ensure output directory exists
  if (!existsSync(CODE_AGENT_OUTPUT_DIR)) {
    await mkdir(CODE_AGENT_OUTPUT_DIR, { recursive: true });
  }

  // Output file for this task's stream
  const outputFile = join(CODE_AGENT_OUTPUT_DIR, `${opts.taskId}.jsonl`);
  const metaFile = join(CODE_AGENT_OUTPUT_DIR, `${opts.taskId}.meta.json`);

  info("supervisor", `[code-agent] Spawning ${opts.taskId} (${modelTier}) -> ${outputFile}`);

  const proc = spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: sanitizedEnv(),
    windowsHide: true,
  });

  // Pipe prompt via stdin
  proc.stdin.write(wrappedPrompt);
  proc.stdin.end();

  const pid = proc.pid;

  // Update task with PID and output file location
  const task = store.tasks.find((t) => t.id === opts.taskId);
  if (task) {
    task.pid = pid;
    task.model = modelTier;
    if (opts.checkpoints) task.checkpoints = opts.checkpoints;
    if (opts.isRestart) task.restartCount = (task.restartCount || 0) + 1;
    await saveTasks();
  }

  // Write metadata for supervisor worker
  const meta = {
    taskId: opts.taskId,
    pid,
    model: modelTier,
    cwd: opts.cwd,
    prompt: opts.prompt,
    startedAt: new Date().toISOString(),
    maxToolCalls: opts.maxToolCalls ?? CODE_AGENT_MAX_TOOL_CALLS,
    wallClockMs: opts.wallClockMs ?? CODE_AGENT_WALL_CLOCK_MS,
    inactivityMs: opts.inactivityMs ?? CODE_AGENT_INACTIVITY_MS,
    budgetUsd: opts.budgetUsd ?? CODE_AGENT_MAX_BUDGET_USD,
    checkpoints: opts.checkpoints || null,
  };
  await writeFile(metaFile, JSON.stringify(meta, null, 2));

  info("supervisor", `[code-agent] Spawned PID=${pid} model=${modelTier} (fire-and-forget)`);

  // === FIRE-AND-FORGET: Stream to file, don't block relay ===
  // This runs detached - relay returns immediately
  streamToFile(proc, outputFile, opts.taskId, task).catch((err) => {
    warn("supervisor", `[code-agent] ${opts.taskId} stream error: ${err}`);
  });

  // Return immediately - supervisor worker will handle the rest
}

/**
 * Stream code agent output to a file (non-blocking).
 * Runs in the background, doesn't block the relay.
 * Supervisor worker reads these files to monitor progress.
 */
async function streamToFile(
  proc: ReturnType<typeof spawn>,
  outputFile: string,
  taskId: string,
  task: SupervisedTask | undefined
): Promise<void> {
  const { createWriteStream } = await import("fs");
  const fileStream = createWriteStream(outputFile, { flags: "a" });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      fileStream.write(chunk);

      // Quick inline parse to update task tool count (lightweight, doesn't block)
      try {
        const lines = chunk.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.type === "assistant" && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === "tool_use" && task) {
                task.toolCallCount = (task.toolCallCount || 0) + 1;
                task.lastToolName = block.name || null;
              }
            }
          }
        }
      } catch {
        // Ignore parse errors for partial lines
      }
    }
  } catch (err) {
    fileStream.write(`\n{"type":"stream_error","error":"${String(err)}"}\n`);
  }

  // Wait for process exit
  let stderr = "";
  try {
    stderr = await new Response(proc.stderr).text();
    await proc.exited;
  } catch {
    // Process already dead
  }

  // Write completion marker
  const exitMarker = {
    type: "stream_complete",
    exitCode: proc.exitCode,
    stderr: stderr.substring(0, 500),
    completedAt: new Date().toISOString(),
  };
  fileStream.write("\n" + JSON.stringify(exitMarker) + "\n");
  fileStream.end();

  // Update task status (will be refined by supervisor worker)
  if (task) {
    const success = proc.exitCode === 0;
    task.status = success ? "completed" : "failed";
    task.completedAt = new Date().toISOString();
    task.pid = null;
    task.error = success ? null : `Exit code ${proc.exitCode}`;

    // Increment store counters (code tasks don't go through completeTask/failTask)
    if (success) store.totalCompleted++;
    else store.totalFailed++;

    // Output size limit: cap result text to prevent context bloat on announcements
    if (task.result && task.result.length > CODE_AGENT_MAX_RESULT_CHARS) {
      task.result = task.result.substring(0, CODE_AGENT_MAX_RESULT_CHARS) + "\n\n[...truncated, full output in code-agent-output file]";
    }

    await saveTasks();

    // NOTE: Do NOT emit task events here. The supervisor worker (checkTasks/completeTask/failTask)
    // is the single source of truth for event emission. Emitting here caused duplicate Telegram
    // notifications due to a race between streamToFile and the supervisor worker both firing events.
  }

  info("supervisor", `[code-agent] ${taskId} stream complete (exit: ${proc.exitCode})`);
}

/**
 * Register and spawn a code task.
 * Unlike registerTask(), this creates a code-type task with streaming monitoring.
 */
export interface RegisterCodeTaskOptions {
  description: string;
  prompt: string;
  cwd: string;
  model?: ModelTier;
  requestedBy?: string;
  maxToolCalls?: number;
  wallClockMs?: number;
  inactivityMs?: number;
  budgetUsd?: number;
  onProgress?: (update: CodeAgentProgress) => void;
  onComplete?: (result: CodeAgentResult) => void;
  // Supervisor system options
  checkpoints?: string;
  skipContextInjection?: boolean;
  skipPatternDetect?: boolean;
  skipShadowEval?: boolean;
  onIntervention?: (pattern: DetectedPattern | EvaluationResult, action: string) => void;
  // Conversation context (recent turns so agent knows what Derek discussed)
  conversationContext?: string;
  // Restart tracking
  isRestart?: boolean;
  restartOf?: string;
  previousAttemptSummary?: string;
  avoidPatterns?: string[];
  // Depth tracking (cascade prevention)
  depth?: number;
}

export async function registerCodeTask(opts: RegisterCodeTaskOptions): Promise<string> {
  // Depth limit enforcement (cascade prevention)
  const depth = opts.depth ?? 0;
  if (depth >= SUBAGENT_MAX_DEPTH) {
    warn("supervisor", `Rejected code task at depth ${depth} (max ${SUBAGENT_MAX_DEPTH}): ${opts.prompt.substring(0, 80)}`);
    throw new Error(`Subagent depth limit reached (${depth}/${SUBAGENT_MAX_DEPTH}). Cannot spawn nested subagents.`);
  }

  // Validate prompt before spawning (safeguard #2)
  const validation = validateTaskPrompt(opts.prompt);
  if (!validation.valid) {
    warn("supervisor", `Rejected code task prompt: ${validation.reason} — "${opts.prompt.substring(0, 100)}"`);
    throw new Error(`Code task prompt rejected: ${validation.reason}`);
  }

  const task: SupervisedTask = {
    id: generateId(),
    description: opts.description,
    status: "running",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    timeoutMs: opts.wallClockMs || CODE_AGENT_WALL_CLOCK_MS,
    outputFile: null,
    result: null,
    requestedBy: opts.requestedBy || "Derek",
    retries: 0,
    maxRetries: 1, // retry once via checkTasks on unexpected death
    lastCheckedAt: null,
    error: null,
    pid: null,
    model: opts.model || CODE_AGENT_DEFAULT_MODEL,
    prompt: opts.prompt,
    taskType: "code",
    cwd: opts.cwd,
    toolCallCount: 0,
    costUsd: 0,
    lastToolName: null,
    lastFileTouched: null,
    outcome: null,
    announceRetryCount: 0,
    lastAnnounceAt: null,
    announced: false,
    agentId: "atlas",
    depth,
  };

  store.tasks.push(task);
  await saveTasks();
  info("supervisor", `Registered code task: ${task.id} — ${task.description} (cwd: ${opts.cwd})`);

  // Acquire a git worktree for isolation (if cwd is a git repo).
  // Falls back gracefully to the original cwd if worktree creation fails.
  let agentCwd = opts.cwd;
  try {
    const entry = await acquireWorktree(task.id, opts.cwd);
    agentCwd = entry.worktreePath;
    task.worktreeBranch = entry.branch;
    await saveTasks();
    info("supervisor", `Worktree acquired for ${task.id}: ${entry.worktreePath} (branch: ${entry.branch})`);
  } catch (err) {
    // Non-fatal: fall back to running directly in the repo (old behavior)
    warn("supervisor", `Worktree creation failed for ${task.id}, running in-place: ${err}`);
  }

  // Wrap onComplete to release the worktree after the agent finishes
  const originalOnComplete = opts.onComplete;
  const wrappedOnComplete = async (result: CodeAgentResult) => {
    // Release worktree: merge back on success, skip merge on failure
    if (task.worktreeBranch) {
      try {
        const mergeResult = await releaseWorktree(task.id, {
          skipMerge: !result.success,
        });
        if (mergeResult.conflictDetails) {
          // Append conflict report to task result for visibility
          task.result = [task.result || "", "", "MERGE CONFLICT:", mergeResult.conflictDetails].join("\n").substring(0, 3000);
          task.error = (task.error || "") + " | merge_conflict";
          await saveTasks();
          warn("supervisor", `[code-agent] ${task.id} has merge conflicts: ${mergeResult.summary}`);
        } else if (mergeResult.success) {
          info("supervisor", `[code-agent] ${task.id} worktree merged successfully`);
        }
      } catch (err) {
        warn("supervisor", `[code-agent] ${task.id} worktree release failed: ${err}`);
      }
    }
    if (originalOnComplete) originalOnComplete(result);
  };

  try {
    await spawnCodeAgent({
      taskId: task.id,
      prompt: opts.prompt,
      cwd: agentCwd,
      model: opts.model,
      maxToolCalls: opts.maxToolCalls,
      wallClockMs: opts.wallClockMs,
      inactivityMs: opts.inactivityMs,
      budgetUsd: opts.budgetUsd,
      onProgress: opts.onProgress,
      onComplete: wrappedOnComplete,
      // Supervisor system options
      checkpoints: opts.checkpoints,
      skipContextInjection: opts.skipContextInjection,
      skipPatternDetect: opts.skipPatternDetect,
      skipShadowEval: opts.skipShadowEval,
      onIntervention: opts.onIntervention,
      isRestart: opts.isRestart,
      previousAttemptSummary: opts.previousAttemptSummary,
      avoidPatterns: opts.avoidPatterns,
      conversationContext: opts.conversationContext,
      depth,
    });
  } catch (err) {
    // Clean up worktree on spawn failure
    if (task.worktreeBranch) {
      try { await releaseWorktree(task.id, { skipMerge: true }); } catch {}
    }
    task.error = `Spawn failed: ${err}`;
    task.status = "failed";
    store.totalFailed++;
    await saveTasks();
    emitTaskEvent("task:failed", task);
    warn("supervisor", `Failed to spawn code agent for ${task.id}: ${err}`);
    throw err;
  }

  return task.id;
}

/**
 * Restart a failed code task with enriched context.
 * Used by the intervention system when pattern detection or shadow evaluation
 * determines an agent needs to be killed and restarted with better guidance.
 *
 * @param failedTaskId - ID of the task that failed
 * @param reason - Reason for the restart (intervention cause)
 * @param avoidPatterns - Patterns to explicitly avoid in the retry
 * @returns New task ID if restart was initiated, null if max restarts exceeded
 */
export async function restartCodeTask(
  failedTaskId: string,
  reason: string,
  avoidPatterns?: string[]
): Promise<string | null> {
  const failedTask = store.tasks.find((t) => t.id === failedTaskId);
  if (!failedTask) {
    warn("supervisor", `Cannot restart task ${failedTaskId}: not found`);
    return null;
  }

  // Check restart limit
  const restartCount = failedTask.restartCount || 0;
  if (restartCount >= SUPERVISOR_MAX_RESTARTS) {
    warn("supervisor", `Cannot restart task ${failedTaskId}: max restarts (${SUPERVISOR_MAX_RESTARTS}) exceeded`);
    return null;
  }

  // Build summary of previous attempt
  const attemptSummary = [
    `Previous attempt failed: ${reason}`,
    `Tool calls: ${failedTask.toolCallCount}`,
    `Last tool: ${failedTask.lastToolName || "unknown"}`,
    `Last file: ${failedTask.lastFileTouched || "unknown"}`,
    failedTask.detectedPatterns?.length
      ? `Detected patterns: ${failedTask.detectedPatterns.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Combine passed avoidPatterns with patterns from failed task
  const allAvoidPatterns = [
    ...(avoidPatterns || []),
    ...(failedTask.detectedPatterns || []).map((p) => `Avoid ${p} behavior`),
  ];

  info("supervisor", `Restarting task ${failedTaskId} (attempt ${restartCount + 1}/${SUPERVISOR_MAX_RESTARTS + 1})`);

  try {
    const newTaskId = await registerCodeTask({
      description: `[Retry] ${failedTask.description}`,
      prompt: failedTask.prompt || "",
      cwd: failedTask.cwd || "",
      model: failedTask.model,
      isRestart: true,
      restartOf: failedTaskId,
      previousAttemptSummary: attemptSummary,
      avoidPatterns: allAvoidPatterns,
    });

    // Update the new task with restart tracking
    const newTask = store.tasks.find((t) => t.id === newTaskId);
    if (newTask) {
      newTask.restartCount = restartCount + 1;
      newTask.restartOf = failedTaskId;
      await saveTasks();
    }

    info("supervisor", `Restarted task ${failedTaskId} as ${newTaskId}`);
    return newTaskId;
  } catch (err) {
    logError("supervisor", `Failed to restart task ${failedTaskId}: ${err}`);
    return null;
  }
}

/**
 * Get supervisor statistics for a task.
 */
export function getTaskSupervisorStats(taskId: string): {
  patternDetections: string[];
  shadowEvaluations: Array<{ toolCall: number; decision: string; scores: string }>;
  restartCount: number;
  restartOf: string | null;
  checkpoints: string | null;
} | null {
  const task = store.tasks.find((t) => t.id === taskId);
  if (!task) return null;

  return {
    patternDetections: task.detectedPatterns || [],
    shadowEvaluations: task.shadowEvaluations || [],
    restartCount: task.restartCount || 0,
    restartOf: task.restartOf || null,
    checkpoints: task.checkpoints || null,
  };
}

/** Parse CODE_TASK fields using lookahead-based splitting. */
function parseCodeTaskFields(raw: string): { cwd: string; prompt: string; timeoutMs?: number } {
  const parts = raw.split(/\s*\|\s*(?=(?:PROMPT|TIMEOUT)\s*:)/i);

  let cwd = "";
  let prompt = "";
  let timeoutMs: number | undefined;

  // First part should contain cwd=...
  const cwdMatch = parts[0].match(/^cwd\s*=\s*([\s\S]*)/i);
  if (cwdMatch) cwd = cwdMatch[1].trim();

  // Remaining parts: PROMPT: ... and/or TIMEOUT: ...
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const promptMatch = part.match(/^PROMPT\s*:\s*([\s\S]*)/i);
    const timeoutMatch = part.match(/^TIMEOUT\s*:\s*(\d+)\s*(m|min|ms|h|hr)?\s*$/i);
    if (promptMatch) {
      prompt = promptMatch[1].trim();
    } else if (timeoutMatch) {
      const val = parseInt(timeoutMatch[1], 10);
      const unit = (timeoutMatch[2] || "m").toLowerCase();
      if (unit === "ms") timeoutMs = val;
      else if (unit === "h" || unit === "hr") timeoutMs = val * 60 * 60 * 1000;
      else timeoutMs = val * 60 * 1000; // default: minutes
    }
  }

  return { cwd, prompt, timeoutMs };
}

/**
 * Parse a CODE_TASK entry from a TodoWrite content string.
 * Expects: "CODE_TASK: cwd=<dir> | PROMPT: <instructions>" (same fields as text tags).
 * Returns null if the content is missing required fields.
 */
export function parseCodeTaskFromTodoContent(content: string): { cwd: string; prompt: string; timeoutMs?: number } | null {
  const stripped = content.replace(/^CODE_TASK:\s*/, "");
  if (!stripped) return null;
  const fields = parseCodeTaskFields(stripped);
  return (fields.cwd && fields.prompt) ? fields : null;
}

/**
 * Extract [CODE_TASK: cwd=<dir> | PROMPT: <instructions>] tags from Claude's response.
 * Spawns a code agent for each match.
 */
export async function processCodeTaskIntents(
  response: string,
  onProgress?: (taskId: string, update: CodeAgentProgress) => void,
  onComplete?: (taskId: string, result: CodeAgentResult) => void,
  onSpawn?: (taskId: string, description: string) => void,
  conversationContext?: string,
): Promise<string> {
  let processed = response;
  const matches: { fullMatch: string; cwd: string; prompt: string; timeoutMs?: number }[] = [];
  const seen = new Set<string>();

  let match;
  try {
    while ((match = CODE_TASK_OUTER_REGEX.exec(response)) !== null) {
      const rawContent = match[1];
      // Structural validation: require cwd= prefix and pipe-delimited PROMPT: field
      if (!CODE_TASK_REQUIRED_FIELDS.test(rawContent) || !CODE_TASK_PROMPT_FIELD.test(rawContent)) {
        warn("supervisor", `Rejected [CODE_TASK:] tag without required fields (cwd= and PROMPT:): "${rawContent.substring(0, 100)}"`);
        continue;
      }
      const fields = parseCodeTaskFields(rawContent);
      if (fields.cwd && fields.prompt) {
        const key = fields.prompt.substring(0, 80);
        if (!seen.has(key)) {
          seen.add(key);
          matches.push({ fullMatch: match[0], ...fields });
        } else {
          warn("supervisor", `Duplicate [CODE_TASK:] tag skipped: "${key}"`);
        }
      } else {
        warn("supervisor", `Malformed CODE_TASK tag (missing cwd or prompt): "${match[0].substring(0, 100)}"`);
      }
    }
  } finally {
    CODE_TASK_OUTER_REGEX.lastIndex = 0;
  }

  for (const m of matches) {
    // Validate CWD exists
    if (!existsSync(m.cwd)) {
      processed = processed.replace(m.fullMatch, `Code task failed: directory not found: ${m.cwd}`);
      warn("supervisor", `Code task intent failed: cwd not found: ${m.cwd}`);
      continue;
    }

    try {
      let resolvedTaskId = "";
      const taskId = await registerCodeTask({
        description: m.prompt.substring(0, 100),
        prompt: m.prompt,
        cwd: m.cwd,
        wallClockMs: m.timeoutMs,
        conversationContext,
        onProgress: onProgress ? (update) => onProgress(resolvedTaskId, update) : undefined,
        onComplete: onComplete ? (result) => onComplete(resolvedTaskId, result) : undefined,
      });
      resolvedTaskId = taskId;
      onSpawn?.(taskId, m.prompt.substring(0, 80));
      processed = processed.replace(
        m.fullMatch,
        `Code agent spawned: ${m.prompt.substring(0, 80)}... (${taskId})`
      );
      info("supervisor", `Code task intent processed: ${taskId}`);
    } catch (err) {
      processed = processed.replace(m.fullMatch, `Code task spawn failed: ${err}`);
      warn("supervisor", `Code task intent spawn failed: ${err}`);
    }
  }

  return processed;
}

// ============================================================
// FUZZY CODE TASK EXTRACTION (tertiary fallback)
// ============================================================

/**
 * Last-resort extraction when phantom dispatch is detected.
 * Looks for numbered/bulleted task lists in Claude's response and maps
 * them to code tasks using the defaultCwd.
 *
 * HARDENED: Requires coding-related keywords in item text and a 25+ char
 * description to prevent conversational bullet points from spawning agents.
 */

// Keywords that indicate a code-related task (case-insensitive)
const CODE_TASK_KEYWORDS = /\b(fix|implement|add|update|refactor|create|build|write|patch|wire|integrate|modify|remove|delete|rename|move|extract|install|configure|migrate|upgrade|deprecate|src\/|\.ts\b|\.js\b|\.tsx?\b|\.json\b|function|class|module|import|export|endpoint|route|handler|middleware|component|hook|config|schema|migration|api|cron|webhook)\b/i;

export function fuzzyExtractCodeTasks(
  response: string,
  defaultCwd: string,
): Array<{ cwd: string; prompt: string }> {
  const tasks: Array<{ cwd: string; prompt: string }> = [];
  const seen = new Set<string>();

  // Match numbered items like "1. **Offer Architect** -- build X" or "- **Name**: description"
  const itemPattern = /(?:^|\n)\s*(?:\d+[.)]\s*|[-*]\s+)\*{0,2}([^*\n]+?)\*{0,2}\s*(?:--|—|:)\s*(.+)/g;
  let m;
  while ((m = itemPattern.exec(response)) !== null) {
    const name = m[1].trim();
    const desc = m[2].trim();
    // Raised minimum length from 15 to 25 chars
    if (desc.length < 25) continue;
    const prompt = `${name}: ${desc}`;
    // Require coding-related keyword in the combined text
    if (!CODE_TASK_KEYWORDS.test(prompt)) continue;
    const key = prompt.substring(0, 80);
    if (!seen.has(key)) {
      seen.add(key);
      tasks.push({ cwd: defaultCwd, prompt });
    }
  }

  return tasks;
}

// ============================================================
// INGEST FOLDER TAG PROCESSING
// ============================================================

/**
 * Parse [INGEST_FOLDER: path=<abs_path> | SOURCE: <name> | QUERY: <search after>] fields.
 */
function parseIngestFolderFields(raw: string): { path: string; source: string; query?: string } {
  // Split on | only when followed by known field names
  const parts = raw.split(/\s*\|\s*(?=(?:SOURCE|QUERY)\s*:)/i);

  let path = "";
  let source = "local";
  let query: string | undefined;

  // First part: path=... or bare path
  const pathMatch = parts[0].match(/^path\s*=\s*([\s\S]*)/i);
  if (pathMatch) path = pathMatch[1].trim();
  else path = parts[0].trim();

  for (let i = 1; i < parts.length; i++) {
    const sourceMatch = parts[i].match(/^SOURCE\s*:\s*([\s\S]*)/i);
    const queryMatch = parts[i].match(/^QUERY\s*:\s*([\s\S]*)/i);
    if (sourceMatch) source = sourceMatch[1].trim();
    else if (queryMatch) query = queryMatch[1].trim();
  }

  return { path, source, query };
}

/**
 * Extract [INGEST_FOLDER: ...] tags from Claude's response.
 * Spawns background ingestFolder() workers (no Claude CLI subprocess needed).
 */
export async function processIngestIntents(
  response: string,
  supabase: SupabaseClient | null,
  onProgress?: (taskId: string, update: import("./ingest-worker.ts").IngestProgress) => void,
  onComplete?: (taskId: string, result: import("./ingest-worker.ts").IngestFolderResult, query?: string) => void,
  onSpawn?: (taskId: string, description: string) => void,
): Promise<string> {
  if (!supabase) return response;

  let processed = response;
  const matches: { fullMatch: string; path: string; source: string; query?: string }[] = [];

  let match;
  try {
    while ((match = INGEST_FOLDER_OUTER_REGEX.exec(response)) !== null) {
      const rawContent = match[1];
      // Structural validation: require path= prefix
      if (!INGEST_REQUIRED_FIELDS.test(rawContent)) {
        warn("supervisor", `Rejected [INGEST_FOLDER:] tag without path= field: "${rawContent.substring(0, 100)}"`);
        continue;
      }
      const fields = parseIngestFolderFields(rawContent);
      if (fields.path) {
        matches.push({ fullMatch: match[0], ...fields });
      }
    }
  } finally {
    INGEST_FOLDER_OUTER_REGEX.lastIndex = 0;
  }

  if (matches.length === 0) return response;

  const { existsSync } = await import("fs");
  const { ingestFolder } = await import("./ingest-worker.ts");

  for (const m of matches) {
    // Validate path exists
    if (!existsSync(m.path)) {
      processed = processed.replace(m.fullMatch, `Ingest failed: directory not found: ${m.path}`);
      warn("supervisor", `Ingest intent failed: path not found: ${m.path}`);
      continue;
    }

    // Register as a supervised task
    const taskId = generateId();
    const now = new Date().toISOString();
    const task: SupervisedTask = {
      id: taskId,
      description: `Ingest ${m.source}: ${m.path.split(/[\\/]/).slice(-2).join("/")}`,
      status: "running",
      createdAt: now,
      startedAt: now,
      completedAt: null,
      result: null,
      timeoutMs: 30 * 60 * 1000, // 30 min for ingestion
      retries: 0,
      maxRetries: 0,
      requestedBy: "atlas",
      outputFile: null,
      lastCheckedAt: null,
      error: null,
      pid: null,
      model: "sonnet", // not using a model, satisfies the type
      prompt: m.path,
      taskType: "ingest",
      cwd: null,
      toolCallCount: 0,
      costUsd: 0,
      lastToolName: null,
      lastFileTouched: null,
      outcome: null,
      announceRetryCount: 0,
      lastAnnounceAt: null,
      announced: false,
      agentId: "atlas",
    };

    store.tasks.push(task);
    await saveTasks();

    // Spawn background ingest worker (async, not a subprocess)
    const workerStartTime = Date.now();
    ingestFolder({
      path: m.path,
      source: m.source,
      supabase,
      onProgress: (update) => {
        task.lastToolName = `ingesting ${update.currentFile}`;
        task.toolCallCount = update.current;
        onProgress?.(taskId, update);
      },
      onComplete: async (result) => {
        const durationMs = Date.now() - workerStartTime;
        task.status = "completed";
        task.completedAt = new Date().toISOString();
        task.result = `Ingested ${result.filesProcessed} files (${result.totalChunks} chunks), ${result.filesSkipped} skipped, ${result.filesErrored} errors`;
        task.outcome = { status: "ok", summary: task.result, durationMs };
        task.pid = null;
        store.totalCompleted++;
        await saveTasks();
        emitTaskEvent("task:completed", task);
        fireHooks("task-complete", { task }).catch(() => {});
        onComplete?.(taskId, result, m.query);
      },
    }).catch(async (err) => {
      task.status = "failed";
      task.error = String(err);
      task.completedAt = new Date().toISOString();
      task.outcome = { status: "error", message: task.error, durationMs: Date.now() - workerStartTime };
      store.totalFailed++;
      await saveTasks();
      emitTaskEvent("task:failed", task);
      fireHooks("task-complete", { task }).catch(() => {});
    });

    processed = processed.replace(
      m.fullMatch,
      `Ingestion started for ${m.path.split(/[\\/]/).slice(-2).join("/")} (${taskId})`
    );
    onSpawn?.(taskId, m.path);
    info("supervisor", `Ingest intent processed: ${taskId} — ${m.path} (source: ${m.source})`);
  }

  return processed;
}

// ============================================================
// CONDUCTOR: TASK AMEND + CANCEL (mid-flight follow-ups)
// ============================================================

/**
 * Parse [TASK_AMEND: task_id | INSTRUCTIONS: ...] fields.
 */
function parseTaskAmendFields(raw: string): { taskId: string; instructions: string } {
  const parts = raw.split(/\s*\|\s*(?=INSTRUCTIONS\s*:)/i);
  const taskId = parts[0].trim();
  let instructions = "";
  for (let i = 1; i < parts.length; i++) {
    const match = parts[i].match(/^INSTRUCTIONS\s*:\s*([\s\S]*)/i);
    if (match) instructions = match[1].trim();
  }
  return { taskId, instructions };
}

/**
 * Parse [TASK_CANCEL: task_id | REASON: ...] fields.
 */
function parseTaskCancelFields(raw: string): { taskId: string; reason: string } {
  const parts = raw.split(/\s*\|\s*(?=REASON\s*:)/i);
  const taskId = parts[0].trim();
  let reason = "Cancelled by user";
  for (let i = 1; i < parts.length; i++) {
    const match = parts[i].match(/^REASON\s*:\s*([\s\S]*)/i);
    if (match) reason = match[1].trim();
  }
  return { taskId, reason };
}

/**
 * Process [TASK_AMEND:] and [TASK_CANCEL:] tags from Claude's response.
 * Handles mid-flight task modifications:
 * - AMEND: for research/code tasks, cancel + respawn with amended prompt.
 *          for ingest tasks, note the amendment for follow-up search.
 * - CANCEL: kill the task via cancelTask().
 */
export async function processTaskAmendIntents(
  response: string,
  onAmendResult?: (taskId: string, action: string, detail: string) => void,
): Promise<string> {
  let processed = response;

  // Process TASK_CANCEL tags
  let match;
  try {
    while ((match = TASK_CANCEL_OUTER_REGEX.exec(response)) !== null) {
      const rawContent = match[1];
      // Structural validation: require REASON: field
      if (!TASK_CANCEL_REQUIRED_FIELDS.test(rawContent)) {
        warn("conductor", `Rejected [TASK_CANCEL:] tag without REASON: field: "${rawContent.substring(0, 100)}"`);
        continue;
      }
      const fields = parseTaskCancelFields(rawContent);
      if (fields.taskId) {
        const success = await cancelTask(fields.taskId, fields.reason);
        if (success) {
          processed = processed.replace(match[0], `Task ${fields.taskId} cancelled: ${fields.reason}`);
          info("conductor", `Task cancelled via tag: ${fields.taskId} — ${fields.reason}`);
          onAmendResult?.(fields.taskId, "cancelled", fields.reason);
        } else {
          processed = processed.replace(match[0], `Could not cancel task ${fields.taskId} (not found or already finished)`);
          warn("conductor", `Cancel failed for ${fields.taskId}: task not running`);
        }
      }
    }
  } finally {
    TASK_CANCEL_OUTER_REGEX.lastIndex = 0;
  }

  // Process TASK_AMEND tags
  try {
    while ((match = TASK_AMEND_OUTER_REGEX.exec(response)) !== null) {
    const rawContent = match[1];
    // Structural validation: require INSTRUCTIONS: field
    if (!TASK_AMEND_REQUIRED_FIELDS.test(rawContent)) {
      warn("conductor", `Rejected [TASK_AMEND:] tag without INSTRUCTIONS: field: "${rawContent.substring(0, 100)}"`);
      continue;
    }
    const fields = parseTaskAmendFields(rawContent);
    if (!fields.taskId || !fields.instructions) {
      processed = processed.replace(match[0], "Task amendment failed: missing task ID or instructions");
      warn("conductor", `Malformed TASK_AMEND: "${match[0].substring(0, 100)}"`);
      continue;
    }

    const task = getTask(fields.taskId);
    if (!task || task.status !== "running") {
      processed = processed.replace(match[0], `Cannot amend task ${fields.taskId}: not found or already finished`);
      warn("conductor", `Amend failed for ${fields.taskId}: not running`);
      continue;
    }

    if (task.taskType === "ingest") {
      // Ingest tasks are async functions, can't inject mid-flight.
      // Queue the amendment as a follow-up search query on the task object.
      // The onComplete callback in relay.ts checks _pendingAmendments and runs searches.
      if (!task._pendingAmendments) task._pendingAmendments = [];
      task._pendingAmendments.push(fields.instructions);
      processed = processed.replace(
        match[0],
        `Noted: once ingestion ${fields.taskId} completes, I'll search for: "${fields.instructions}"`
      );
      info("conductor", `Ingest amend queued on task ${fields.taskId}: ${fields.instructions.substring(0, 100)}`);
      onAmendResult?.(fields.taskId, "noted", fields.instructions);
    } else {
      // Research or code tasks: cancel + respawn with amended prompt
      const originalPrompt = task.prompt || task.description;
      const amendedPrompt = `${originalPrompt}\n\nADDITIONAL INSTRUCTIONS (added by user follow-up):\n${fields.instructions}`;

      await cancelTask(fields.taskId, `Amended: ${fields.instructions.substring(0, 80)}`);

      if (task.taskType === "code" && task.cwd) {
        try {
          const newTaskId = await registerCodeTask({
            description: `${task.description} (amended)`,
            prompt: amendedPrompt,
            cwd: task.cwd,
            model: task.model,
            requestedBy: task.requestedBy,
          });
          processed = processed.replace(
            match[0],
            `Task ${fields.taskId} cancelled and respawned as ${newTaskId} with updated instructions`
          );
          info("conductor", `Code task amended: ${fields.taskId} -> ${newTaskId}`);
          onAmendResult?.(newTaskId, "respawned", fields.instructions);
        } catch (err) {
          processed = processed.replace(match[0], `Task amendment failed: ${err}`);
          warn("conductor", `Code task respawn failed: ${err}`);
        }
      } else {
        // Research task
        try {
          const newTaskId = await registerTask({
            description: `${task.description} (amended)`,
            prompt: amendedPrompt,
            model: task.model,
            timeoutMs: task.timeoutMs,
            maxRetries: task.maxRetries,
          });
          processed = processed.replace(
            match[0],
            `Task ${fields.taskId} cancelled and respawned as ${newTaskId} with updated instructions`
          );
          info("conductor", `Research task amended: ${fields.taskId} -> ${newTaskId}`);
          onAmendResult?.(newTaskId, "respawned", fields.instructions);
        } catch (err) {
          processed = processed.replace(match[0], `Task amendment failed: ${err}`);
          warn("conductor", `Research task respawn failed: ${err}`);
        }
      }
    }
  }
  } finally {
    TASK_AMEND_OUTER_REGEX.lastIndex = 0;
  }

  return processed;
}

// ============================================================
// TAG RECOVERY — Survive session rollovers
// ============================================================
// When Claude's response is cut off mid-tag (timeout, context limit,
// loop kill), incomplete tags like [CODE_TASK: cwd=... | PROMPT: ...
// are lost because the closing ] is missing and the regex never matches.
//
// This system:
// 1. Scans every response for incomplete (unclosed) tags BEFORE regex processing
// 2. Saves them to a pending-tags.json file
// 3. On the next response cycle, re-injects pending tags so they get processed
// 4. Cleans up after successful processing
// ============================================================

const PENDING_TAGS_FILE = join(DATA_DIR, "pending-tags.json");

// All tag prefixes we care about recovering
const RECOVERABLE_TAG_PREFIXES = [
  "CODE_TASK:",
  "TASK:",
  "DRAFT:",
  "SEND:",
  "CAL_ADD:",
  "CAL_REMOVE:",
  "GHL_NOTE:",
  "GHL_TASK:",
  "GHL_TAG:",
  "GHL_WORKFLOW:",
  "REMEMBER:",
  "GOAL:",
  "DONE:",
  "TODO:",
  "TODO_DONE:",
  "ENTITY:",
  "RELATE:",
  "SWARM:",
  "EXPLORE:",
  "INGEST_FOLDER:",
  "TASK_AMEND:",
  "TASK_CANCEL:",
];

interface PendingTag {
  /** The raw incomplete tag text (without closing bracket) */
  raw: string;
  /** When it was captured */
  capturedAt: string;
  /** How many times we've tried to recover it */
  retryCount: number;
  /** Source response truncated? */
  reason: "incomplete" | "unclosed";
}

interface PendingTagStore {
  tags: PendingTag[];
}

/**
 * Detect incomplete (unclosed) action tags in a response.
 * Returns the incomplete tag strings found.
 */
function detectIncompleteTags(response: string): string[] {
  const incomplete: string[] = [];
  for (const prefix of RECOVERABLE_TAG_PREFIXES) {
    // Find all occurrences of [PREFIX that don't have a matching ]
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const openPattern = new RegExp(`\\[${escapedPrefix}`, "gi");
    let m;
    while ((m = openPattern.exec(response)) !== null) {
      const startIdx = m.index;
      // Look for the closing ] after this opening
      const afterOpen = response.substring(startIdx);
      const closeBracket = afterOpen.indexOf("]");
      if (closeBracket === -1) {
        // No closing bracket found, this tag is incomplete
        incomplete.push(afterOpen.trim());
      }
    }
  }
  return incomplete;
}

/**
 * Save incomplete tags to disk for recovery on next message cycle.
 */
async function savePendingTags(tags: PendingTag[]): Promise<void> {
  try {
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }
    const store: PendingTagStore = { tags };
    await writeFile(PENDING_TAGS_FILE, JSON.stringify(store, null, 2));
    if (tags.length > 0) {
      info("tag-recovery", `Saved ${tags.length} pending tag(s) for recovery`);
    }
  } catch (err) {
    logError("tag-recovery", `Failed to save pending tags: ${err}`);
  }
}

/**
 * Load any pending tags from a previous session rollover.
 */
async function loadPendingTags(): Promise<PendingTag[]> {
  try {
    if (!existsSync(PENDING_TAGS_FILE)) return [];
    const content = await readFile(PENDING_TAGS_FILE, "utf-8");
    const store: PendingTagStore = JSON.parse(content);
    return store.tags || [];
  } catch {
    return [];
  }
}

/**
 * Clear pending tags after successful recovery.
 */
async function clearPendingTags(): Promise<void> {
  try {
    if (existsSync(PENDING_TAGS_FILE)) {
      await writeFile(PENDING_TAGS_FILE, JSON.stringify({ tags: [] }));
    }
  } catch {
    // Best effort
  }
}

/**
 * Pre-process a response: detect and save any incomplete tags.
 * Call this BEFORE the tag processing pipeline runs.
 * Returns the response with incomplete tags removed (to avoid partial processing).
 */
export async function captureIncompleteTags(response: string): Promise<string> {
  const incomplete = detectIncompleteTags(response);
  if (incomplete.length === 0) return response;

  const pending: PendingTag[] = incomplete.map((raw) => ({
    raw,
    capturedAt: new Date().toISOString(),
    retryCount: 0,
    reason: "unclosed" as const,
  }));

  // Merge with any existing pending tags (don't overwrite)
  const existing = await loadPendingTags();
  const merged = [...existing, ...pending];
  await savePendingTags(merged);

  warn(
    "tag-recovery",
    `Captured ${incomplete.length} incomplete tag(s) from truncated response: ${incomplete.map((t) => t.substring(0, 80)).join("; ")}`
  );

  // Remove incomplete tags from response so they don't confuse the user
  let cleaned = response;
  for (const tag of incomplete) {
    cleaned = cleaned.replace(tag, "[tag captured for retry]");
  }
  return cleaned;
}

/**
 * Recover pending tags by prepending them to the current response.
 * Call this BEFORE the tag processing pipeline runs (but after captureIncompleteTags).
 * Returns modified response with recovered tags injected.
 */
export async function recoverPendingTags(response: string): Promise<string> {
  const pending = await loadPendingTags();
  if (pending.length === 0) return response;

  // Filter out stale tags (> 1 hour old) and tags retried too many times
  const now = Date.now();
  const recoverable = pending.filter((t) => {
    const age = now - new Date(t.capturedAt).getTime();
    return age < 60 * 60 * 1000 && t.retryCount < 3;
  });

  if (recoverable.length === 0) {
    await clearPendingTags();
    return response;
  }

  // Close incomplete tags by appending a ]
  const recovered: string[] = [];
  for (const tag of recoverable) {
    const closed = tag.raw.trimEnd() + "]";
    recovered.push(closed);
    tag.retryCount++;
    info("tag-recovery", `Recovering tag (attempt ${tag.retryCount}): ${closed.substring(0, 100)}`);
  }

  // Save updated retry counts (in case recovery fails again)
  await savePendingTags(recoverable);

  // Prepend recovered tags to response so they get processed by the pipeline
  const injected = recovered.join("\n") + "\n" + response;
  info("tag-recovery", `Injected ${recovered.length} recovered tag(s) into response pipeline`);

  return injected;
}

/**
 * Mark recovery as successful. Clear all pending tags.
 * Call this AFTER the tag processing pipeline completes successfully.
 */
export async function confirmTagRecovery(): Promise<void> {
  await clearPendingTags();
}
