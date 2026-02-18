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

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { spawn } from "bun";
import { info, warn, error as logError, trackClaudeCall } from "./logger.ts";
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
  type ModelTier,
} from "./constants.ts";
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

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "timeout";

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
  /** Task type: research writes to output file, code edits project files */
  taskType: "research" | "code";
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
  /** Swarm ID if part of a swarm (set via registerTask opts) */
  _swarmId?: string | null;
  /** DAG node ID if part of a swarm */
  _dagNodeId?: string | null;
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

let store: TaskStore = {
  tasks: [],
  lastCheckAt: null,
  totalCompleted: 0,
  totalFailed: 0,
  totalTimedOut: 0,
};

// ============================================================
// PERSISTENCE
// ============================================================

export async function loadTasks(): Promise<void> {
  try {
    if (existsSync(TASKS_FILE)) {
      const content = await readFile(TASKS_FILE, "utf-8");
      store = JSON.parse(content);
      // Backward compat
      if (!store.totalCompleted) store.totalCompleted = 0;
      if (!store.totalFailed) store.totalFailed = 0;
      if (!store.totalTimedOut) store.totalTimedOut = 0;
      // Backfill new fields on existing tasks
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
        if (task.announced === undefined) task.announced = task.status !== "running";
      }
      info("supervisor", `Loaded ${store.tasks.length} tasks from disk`);
    }
  } catch (err) {
    warn("supervisor", `Failed to load tasks: ${err}`);
  }
}

async function saveTasks(): Promise<void> {
  try {
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }
    await writeFile(TASKS_FILE, JSON.stringify(store, null, 2));
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

  const modelTier = opts.model || "sonnet";
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

  info(
    "supervisor",
    `Spawning subagent for ${opts.taskId} (${modelTier}): ${opts.prompt.substring(0, 100)}...`
  );

  const proc = spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd || SUBAGENT_CWD,
    env: { ...process.env },
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

  // Fire-and-forget: drain stdout/stderr so pipes don't block the subprocess
  (async () => {
    try {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        warn(
          "supervisor",
          `Subagent ${opts.taskId} (PID ${pid}) exited with code ${exitCode}: ${stderr.substring(0, 300)}`
        );
      } else {
        info("supervisor", `Subagent ${opts.taskId} (PID ${pid}) exited cleanly`);
      }
    } catch (err) {
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
  /** Swarm ID if part of a swarm */
  swarmId?: string;
  /** DAG node ID if part of a swarm */
  dagNodeId?: string;
}): Promise<string> {
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
    timeoutMs: opts.timeoutMs || 10 * 60 * 1000, // default 10 min
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
    _swarmId: opts.swarmId || null,
    _dagNodeId: opts.dagNodeId || null,
  };

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
  store.totalCompleted++;

  info("supervisor", `Task completed: ${task.id} — ${task.description} (${Math.round(durationMs / 1000)}s)`);
  await saveTasks();

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
  status: "completed" | "failed" | "timeout";
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
          warn("supervisor", `Subagent PID ${task.pid} for ${task.id} died unexpectedly after ${Math.round(durationMs / 1000)}s`);
          task.pid = null;

          if (task.retries < task.maxRetries && task.prompt && task.outputFile) {
            task.retries++;
            task.startedAt = new Date().toISOString();
            alerts.push(`Task "${task.description}" — subagent died, auto-retrying (${task.retries}/${task.maxRetries}).`);
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

    // Check for output file completion
    if (task.outputFile) {
      const outputPath = task.outputFile.startsWith("/") || task.outputFile.includes(":")
        ? task.outputFile
        : join(PROJECT_DIR, task.outputFile);

      if (existsSync(outputPath)) {
        // Output file exists, task completed
        const durationMs = now - new Date(task.startedAt!).getTime();
        let outputPreview = "";
        try {
          const content = await readFile(outputPath, "utf-8");
          outputPreview = content.substring(0, 500).trim();
          task.status = "completed";
          task.completedAt = new Date().toISOString();
          task.result = `Output saved to ${task.outputFile} (${content.length} chars)`;
          task.outcome = { status: "ok", summary: task.result, durationMs };
          store.totalCompleted++;
          alerts.push(`Task completed: "${task.description}" — output at ${task.outputFile}`);
          info("supervisor", `Task auto-completed via output file: ${task.id} (${Math.round(durationMs / 1000)}s)`);
        } catch (err) {
          // File exists but can't read, still count as completed
          task.status = "completed";
          task.completedAt = new Date().toISOString();
          task.result = `Output file exists at ${task.outputFile}`;
          task.outcome = { status: "ok", summary: task.result, durationMs };
          store.totalCompleted++;
        }
        completedTasks.push({
          id: task.id,
          description: task.description,
          outputFile: task.outputFile,
          outputPreview,
          taskType: task.taskType,
          status: "completed",
        });
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
            process.kill(task.pid);
            info("supervisor", `Killed subagent PID ${task.pid} before retry for ${task.id}`);
          } catch {
            // Process already dead
          }
          task.pid = null;
        }

        // Can retry
        task.retries++;
        task.startedAt = new Date().toISOString();
        alerts.push(
          `Task "${task.description}" timed out after ${Math.round(elapsed / 60000)}m. ` +
          `Retry ${task.retries}/${task.maxRetries}.`
        );
        warn("supervisor", `Task timed out, retrying: ${task.id} (attempt ${task.retries})`);

        // Respawn subagent if we have the prompt
        if (task.prompt && task.outputFile) {
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
            process.kill(task.pid);
            info("supervisor", `Killed orphaned subagent PID ${task.pid} for ${task.id}`);
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
        completedTasks.push({
          id: task.id,
          description: task.description,
          outputFile: task.outputFile,
          outputPreview: "",
          taskType: task.taskType,
          status: "timeout",
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
        alerts.push(`Stale task expired: "${task.description}"`);
        warn("supervisor", `Expired stale task ${task.id} (no PID for ${Math.round(elapsed / 60000)}m)`);
      }
    }
  }

  // Clean up: archive old completed/failed tasks (>24h old)
  const cutoff = now - 24 * 60 * 60 * 1000;
  const toArchive = store.tasks.filter(
    (t) =>
      (t.status === "completed" || t.status === "failed" || t.status === "timeout") &&
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

  // Collect unannounced completed tasks for delivery retry (OpenClaw announce pattern)
  const unannouncedTasks = store.tasks.filter(
    (t) => (t.status === "completed" || t.status === "failed" || t.status === "timeout") && !t.announced
  );

  store.lastCheckAt = new Date().toISOString();
  await saveTasks();

  return { alerts, healthy, completedTasks, unannouncedTasks };
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
  const recent = store.tasks
    .filter((t) => t.status === "completed" || t.status === "failed" || t.status === "timeout")
    .slice(-5);

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
        context += `  - Coding: "${t.description}" — ${progress}${doing}, ${elapsed}m/${timeout}m${cost}\n`;
      } else {
        const retryNote = t.retries > 0 ? ` (retry ${t.retries}/${t.maxRetries})` : "";
        context += `  - Researching: "${t.description}" — ${elapsed}m/${timeout}m${retryNote}\n`;
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
        const icon = t.status === "completed" ? "Done" : t.status === "failed" ? "Failed" : "Timed out";
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
  if (!task.outcome) {
    // Legacy fallback
    if (task.status === "completed") return `Task done: ${task.description}. ${task.result || ""}`.trim();
    if (task.status === "failed") return `Task failed: ${task.description}. ${task.error || ""}`.trim();
    return `Task ${task.status}: ${task.description}`;
  }

  const dur = Math.round(task.outcome.durationMs / 1000);
  const durStr = dur > 60 ? `${Math.round(dur / 60)}m` : `${dur}s`;

  switch (task.outcome.status) {
    case "ok": {
      const where = task.outputFile ? ` Output: ${task.outputFile}` : "";
      return `${task.description} completed in ${durStr}.${where}`;
    }
    case "error":
      return `${task.description} failed after ${durStr}: ${task.outcome.message}`;
    case "timeout":
      return `${task.description} timed out after ${durStr}. ${task.retries > 0 ? `Tried ${task.retries + 1} times.` : ""}`.trim();
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

/**
 * Cancel a running task by ID.
 */
export async function cancelTask(id: string, reason?: string): Promise<boolean> {
  const task = store.tasks.find((t) => t.id === id && t.status === "running");
  if (!task) return false;

  // Kill subagent process if running
  if (task.pid) {
    try {
      process.kill(task.pid);
      info("supervisor", `Killed subagent PID ${task.pid} for cancelled task ${task.id}`);
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
        process.kill(task.pid);
        info("supervisor", `Shutdown: killed subagent PID ${task.pid} (${task.id}: ${task.description})`);
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
 * Called internally when any task completes (research or code).
 * Triggers queue dispatch to fill the freed slot.
 * If the task is part of a swarm, notifies the orchestrator.
 */
async function onTaskFinished(taskId: string): Promise<void> {
  // Try to fill the freed slot
  await tryDispatch();

  // Check if this task was part of a swarm
  const task = store.tasks.find(t => t.id === taskId);
  if (task && swarmCompletionCallback) {
    // Look for swarm metadata. We store it on the QueuedTask, but we need
    // to find it. Check if the task has swarm fields (added via registerTask opts).
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

// Match the outer [TASK: ...] bracket, then parse fields inside.
// Uses [^\]] to avoid premature close on nested brackets, with /s for multiline.
const TASK_OUTER_REGEX = /\[TASK:\s*([\s\S]+?)\](?!\()/g;
const CODE_TASK_OUTER_REGEX = /\[CODE_TASK:\s*([\s\S]+?)\](?!\()/g;

// Fallback detection: phrases that suggest Claude intended to delegate but didn't emit a tag.
const TASK_INTENT_HINTS = [
  /(?:research|task|agent)\s+(?:is\s+)?(?:running|started|kicked off|spawned|delegated)/i,
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

  let match;
  while ((match = TASK_OUTER_REGEX.exec(response)) !== null) {
    const fields = parseTaskFields(match[1]);
    if (fields.description) {
      matches.push({ fullMatch: match[0], ...fields });
    }
  }
  TASK_OUTER_REGEX.lastIndex = 0;

  // Spawn tasks
  for (const m of matches) {
    try {
      const taskId = await registerTask({
        description: m.description,
        outputFile: m.outputFile,
        prompt: m.prompt,
        model: "sonnet",
        timeoutMs: 10 * 60 * 1000,
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

  // Fallback: detect task-like language without a matching tag
  if (matches.length === 0) {
    for (const hint of TASK_INTENT_HINTS) {
      if (hint.test(response)) {
        warn("supervisor", `Task intent language detected but no [TASK:] tag found in response: "${response.substring(0, 200)}"`);
        break;
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
}

function wrapCodePrompt(userPrompt: string): string {
  return [
    "You are a code agent. Complete the following coding task autonomously.",
    "Work directly on the project files in your working directory.",
    "Read files, make edits, run tests/builds as needed. Iterate until done.",
    "When finished, your final message should summarize what you changed.",
    "",
    "TASK:",
    userPrompt,
  ].join("\n");
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

/**
 * Spawn a code agent that runs Claude Code autonomously in a target project directory.
 * Unlike spawnSubagent(), this streams output, tracks progress, and reports back.
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
  const maxToolCalls = opts.maxToolCalls ?? CODE_AGENT_MAX_TOOL_CALLS;
  const wallClockMs = opts.wallClockMs ?? CODE_AGENT_WALL_CLOCK_MS;
  const inactivityMs = opts.inactivityMs ?? CODE_AGENT_INACTIVITY_MS;
  const budgetUsd = opts.budgetUsd ?? CODE_AGENT_MAX_BUDGET_USD;
  const wrappedPrompt = wrapCodePrompt(opts.prompt);

  const args = [
    CLAUDE_PATH,
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", modelId,
    "--dangerously-skip-permissions",
  ];

  info("supervisor", `[code-agent] Spawning for ${opts.taskId} (${modelTier}) in ${opts.cwd}: ${opts.prompt.substring(0, 120)}...`);

  const proc = spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: { ...process.env },
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

  info("supervisor", `[code-agent] Spawned PID=${pid} model=${modelTier}`);

  // Run the streaming monitor in background (fire-and-forget from caller's perspective)
  (async () => {
    const startTime = Date.now();
    let lastActivityAt = Date.now();
    let lastProgressAt = 0;
    let toolCallCount = 0;
    let accCostUsd = 0;
    let resultText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let gotResult = false;
    let isError = false;
    let exitReason: CodeAgentResult["exitReason"] = "completed";
    let killed = false;
    let lastFile: string | undefined;

    const parser = createStreamParser((event) => {
      lastActivityAt = Date.now();

      switch (event.type) {
        case "assistant":
          toolCallCount++;
          const filePath = extractFilePath(event.toolName || "", event.toolInput);
          if (filePath) lastFile = filePath;

          // Update task state
          if (task) {
            task.toolCallCount = toolCallCount;
            task.lastToolName = event.toolName || null;
            if (filePath) task.lastFileTouched = filePath;
          }

          // Tool call limit
          if (toolCallCount > maxToolCalls && !killed) {
            warn("supervisor", `[code-agent] ${opts.taskId} hit tool limit (${toolCallCount}/${maxToolCalls}). Killing.`);
            proc.kill();
            killed = true;
            exitReason = "tool_limit";
          }

          // Progress callback (throttled)
          {
            const now = Date.now();
            if (now - lastProgressAt >= CODE_AGENT_PROGRESS_INTERVAL_MS && opts.onProgress) {
              opts.onProgress({
                toolName: event.toolName || "working",
                toolCallCount,
                elapsedSec: Math.round((now - startTime) / 1000),
                lastFile,
                costUsd: accCostUsd,
              });
              lastProgressAt = now;
            }
          }
          break;

        case "result":
          gotResult = true;
          resultText = event.resultText || "";
          isError = !!event.isError;
          inputTokens = event.inputTokens || 0;
          outputTokens = event.outputTokens || 0;

          // Calculate cost from tokens
          const costRates = TOKEN_COSTS[modelTier] || TOKEN_COSTS.sonnet;
          accCostUsd = (inputTokens * costRates.input + outputTokens * costRates.output) / 1_000_000;

          // Update task cost
          if (task) task.costUsd = accCostUsd;

          // Budget check
          if (accCostUsd > budgetUsd && !killed) {
            warn("supervisor", `[code-agent] ${opts.taskId} exceeded budget ($${accCostUsd.toFixed(2)} > $${budgetUsd}). Killing.`);
            proc.kill();
            killed = true;
            exitReason = "budget";
          }
          break;
      }
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    // Watchdog: check inactivity and wall clock
    const watchdogInterval = setInterval(() => {
      if (killed) return;
      const now = Date.now();
      const wallElapsed = now - startTime;
      const idleElapsed = now - lastActivityAt;

      if (wallElapsed > wallClockMs) {
        warn("supervisor", `[code-agent] ${opts.taskId} wall clock exceeded (${Math.round(wallElapsed / 1000)}s). Killing.`);
        proc.kill();
        killed = true;
        exitReason = "wall_clock";
      } else if (idleElapsed > inactivityMs) {
        warn("supervisor", `[code-agent] ${opts.taskId} inactive for ${Math.round(idleElapsed / 1000)}s. Killing.`);
        proc.kill();
        killed = true;
        exitReason = "inactivity";
      }
    }, 5000);

    // Read stream
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.flush();
    } catch {
      // Stream error
    }

    clearInterval(watchdogInterval);

    // Wait for process exit
    let stderr = "";
    try {
      stderr = await new Response(proc.stderr).text();
      await proc.exited;
    } catch {
      // Process already dead
    }

    const durationMs = Date.now() - startTime;

    // Determine exit reason if not already set by watchdog
    if (!killed) {
      const exitCode = proc.exitCode;
      if (exitCode !== 0 && !gotResult) {
        exitReason = "error";
        if (!resultText) resultText = stderr.substring(0, 500) || `Exit code ${exitCode}`;
      }
    }

    // Track cost
    trackClaudeCall(durationMs, {
      model: modelTier,
      inputTokens,
      outputTokens,
      costUsd: accCostUsd,
    });

    // Update task
    if (task) {
      const success = exitReason === "completed" && !isError;
      task.status = success ? "completed" : "failed";
      task.completedAt = new Date().toISOString();
      task.toolCallCount = toolCallCount;
      task.costUsd = accCostUsd;
      task.result = resultText.substring(0, 2000) || (success ? "Completed" : `Failed: ${exitReason}`);
      task.error = success ? null : exitReason;
      task.pid = null;
      task.outcome = success
        ? { status: "ok", summary: task.result, durationMs }
        : { status: "error", message: task.error || exitReason, durationMs };
      if (success) {
        store.totalCompleted++;
      } else {
        store.totalFailed++;
      }
      await saveTasks();
    }

    info(
      "supervisor",
      `[code-agent] ${opts.taskId} finished: ${exitReason} | ${toolCallCount} tools | ${Math.round(durationMs / 1000)}s | $${accCostUsd.toFixed(4)}`
    );

    // Invoke completion callback
    if (opts.onComplete) {
      opts.onComplete({
        success: exitReason === "completed" && !isError,
        resultText: resultText.substring(0, 3000),
        toolCallCount,
        durationMs,
        costUsd: accCostUsd,
        inputTokens,
        outputTokens,
        exitReason,
      });
    }
  })();
}

/**
 * Register and spawn a code task.
 * Unlike registerTask(), this creates a code-type task with streaming monitoring.
 */
export async function registerCodeTask(opts: {
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
}): Promise<string> {
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
    maxRetries: 0, // code tasks don't auto-retry via checkTasks
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
  };

  store.tasks.push(task);
  await saveTasks();
  info("supervisor", `Registered code task: ${task.id} — ${task.description} (cwd: ${opts.cwd})`);

  try {
    await spawnCodeAgent({
      taskId: task.id,
      prompt: opts.prompt,
      cwd: opts.cwd,
      model: opts.model,
      maxToolCalls: opts.maxToolCalls,
      wallClockMs: opts.wallClockMs,
      inactivityMs: opts.inactivityMs,
      budgetUsd: opts.budgetUsd,
      onProgress: opts.onProgress,
      onComplete: opts.onComplete,
    });
  } catch (err) {
    task.error = `Spawn failed: ${err}`;
    task.status = "failed";
    store.totalFailed++;
    await saveTasks();
    warn("supervisor", `Failed to spawn code agent for ${task.id}: ${err}`);
    throw err;
  }

  return task.id;
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
 * Extract [CODE_TASK: cwd=<dir> | PROMPT: <instructions>] tags from Claude's response.
 * Spawns a code agent for each match.
 */
export async function processCodeTaskIntents(
  response: string,
  onProgress?: (taskId: string, update: CodeAgentProgress) => void,
  onComplete?: (taskId: string, result: CodeAgentResult) => void,
): Promise<string> {
  let processed = response;
  const matches: { fullMatch: string; cwd: string; prompt: string; timeoutMs?: number }[] = [];

  let match;
  while ((match = CODE_TASK_OUTER_REGEX.exec(response)) !== null) {
    const fields = parseCodeTaskFields(match[1]);
    if (fields.cwd && fields.prompt) {
      matches.push({ fullMatch: match[0], ...fields });
    } else {
      warn("supervisor", `Malformed CODE_TASK tag (missing cwd or prompt): "${match[0].substring(0, 100)}"`);
    }
  }
  CODE_TASK_OUTER_REGEX.lastIndex = 0;

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
        onProgress: onProgress ? (update) => onProgress(resolvedTaskId, update) : undefined,
        onComplete: onComplete ? (result) => onComplete(resolvedTaskId, result) : undefined,
      });
      resolvedTaskId = taskId;
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
