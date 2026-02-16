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

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const TASKS_FILE = join(DATA_DIR, "tasks.json");
const TASKS_ARCHIVE = join(DATA_DIR, "tasks-archive.json");

// ============================================================
// TYPES
// ============================================================

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "timeout";

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

  // SAFETY: prompt is passed as a direct spawn argument (not through shell).
  // Bun's spawn() uses libuv/CreateProcess, no shell metacharacter injection risk.
  const args = [
    CLAUDE_PATH,
    "-p",
    wrappedPrompt,
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
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd || SUBAGENT_CWD,
    env: { ...process.env },
  });

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
  };

  store.tasks.push(task);
  await saveTasks();
  info("supervisor", `Registered task: ${task.id} — ${task.description}`);

  // Auto-spawn subagent if prompt and output file are available
  if (opts.prompt && task.outputFile) {
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

  task.status = "completed";
  task.completedAt = new Date().toISOString();
  task.result = result || "Completed successfully";
  store.totalCompleted++;

  info("supervisor", `Task completed: ${task.id} — ${task.description}`);
  await saveTasks();
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

  task.status = "failed";
  task.completedAt = new Date().toISOString();
  task.error = error;
  store.totalFailed++;

  logError("supervisor", `Task failed: ${task.id} — ${task.description}: ${error}`);
  await saveTasks();
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
export async function checkTasks(): Promise<{
  alerts: string[];
  healthy: boolean;
}> {
  const now = Date.now();
  const alerts: string[] = [];
  let healthy = true;

  for (const task of store.tasks) {
    if (task.status !== "running") continue;

    task.lastCheckedAt = new Date().toISOString();
    const elapsed = now - new Date(task.startedAt!).getTime();

    // Check for output file completion
    if (task.outputFile) {
      const outputPath = task.outputFile.startsWith("/") || task.outputFile.includes(":")
        ? task.outputFile
        : join(PROJECT_DIR, task.outputFile);

      if (existsSync(outputPath)) {
        // Output file exists, task completed
        try {
          const content = await readFile(outputPath, "utf-8");
          const preview = content.substring(0, 200).trim();
          task.status = "completed";
          task.completedAt = new Date().toISOString();
          task.result = `Output saved to ${task.outputFile} (${content.length} chars)`;
          store.totalCompleted++;
          alerts.push(`Task completed: "${task.description}" — output at ${task.outputFile}`);
          info("supervisor", `Task auto-completed via output file: ${task.id}`);
        } catch (err) {
          // File exists but can't read, still count as completed
          task.status = "completed";
          task.completedAt = new Date().toISOString();
          task.result = `Output file exists at ${task.outputFile}`;
          store.totalCompleted++;
        }
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
        store.totalTimedOut++;
        healthy = false;
        alerts.push(
          `Task FAILED: "${task.description}" — timed out after ${Math.round(elapsed / 60000)}m ` +
          `with ${task.retries} retries. Output file ${task.outputFile ? "never appeared" : "not configured"}.`
        );
        logError("supervisor", `Task timed out permanently: ${task.id} — ${task.description}`);
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

  store.lastCheckAt = new Date().toISOString();
  await saveTasks();

  return { alerts, healthy };
}

// ============================================================
// CONTEXT FOR HEARTBEAT / STATUS
// ============================================================

/**
 * Get supervisor context for heartbeat prompt injection.
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
    context += "Running:\n";
    for (const t of running) {
      const elapsed = Math.round(
        (Date.now() - new Date(t.startedAt!).getTime()) / 60000
      );
      const timeout = Math.round(t.timeoutMs / 60000);
      context += `  - [${t.id}] "${t.description}" — ${elapsed}m elapsed (timeout: ${timeout}m)`;
      if (t.pid) context += ` | PID: ${t.pid}`;
      if (t.taskType === "code") {
        context += ` | CODE`;
        if (t.toolCallCount) context += ` | ${t.toolCallCount} tools`;
        if (t.costUsd) context += ` | $${t.costUsd.toFixed(2)}`;
        if (t.lastToolName) context += ` | last: ${t.lastToolName}`;
      } else if (t.outputFile) {
        context += ` | watching: ${t.outputFile}`;
      }
      context += "\n";
    }
  }

  if (recent.length > 0) {
    context += "Recent:\n";
    for (const t of recent) {
      const icon = t.status === "completed" ? "done" : t.status === "failed" ? "FAILED" : "TIMEOUT";
      context += `  - [${icon}] "${t.description}"`;
      if (t.result) context += ` — ${t.result.substring(0, 100)}`;
      if (t.error) context += ` — ERROR: ${t.error.substring(0, 100)}`;
      context += "\n";
    }
  }

  context += `Lifetime: ${store.totalCompleted} completed, ${store.totalFailed} failed, ${store.totalTimedOut} timed out`;
  return context;
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

// ============================================================
// INTENT PROCESSING (tag extraction from Claude responses)
// ============================================================

const TASK_REGEX = /\[TASK:\s*(.+?)\s*\|\s*OUTPUT:\s*(.+?)\s*\|\s*PROMPT:\s*(.+?)\]/gs;
const CODE_TASK_REGEX = /\[CODE_TASK:\s*cwd=(.+?)\s*\|\s*PROMPT:\s*(.+?)\]/gs;

/**
 * Extract [TASK: desc | OUTPUT: file | PROMPT: instructions] tags from Claude's response.
 * Spawns a supervised subagent for each match, replaces the tag with a status note.
 */
export async function processTaskIntents(response: string): Promise<string> {
  let processed = response;
  const matches: { fullMatch: string; description: string; outputFile: string; prompt: string }[] = [];

  // Collect all matches first (regex exec with global flag)
  let match;
  while ((match = TASK_REGEX.exec(response)) !== null) {
    matches.push({
      fullMatch: match[0],
      description: match[1].trim(),
      outputFile: match[2].trim(),
      prompt: match[3].trim(),
    });
  }
  // Reset regex state
  TASK_REGEX.lastIndex = 0;

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
    wrappedPrompt,
    "--output-format", "stream-json",
    "--verbose",
    "--model", modelId,
    "--dangerously-skip-permissions",
  ];

  info("supervisor", `[code-agent] Spawning for ${opts.taskId} (${modelTier}) in ${opts.cwd}: ${opts.prompt.substring(0, 120)}...`);

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: { ...process.env },
  });

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
      task.status = exitReason === "completed" && !isError ? "completed" : "failed";
      task.completedAt = new Date().toISOString();
      task.toolCallCount = toolCallCount;
      task.costUsd = accCostUsd;
      task.result = resultText.substring(0, 2000) || (exitReason === "completed" ? "Completed" : `Failed: ${exitReason}`);
      task.error = exitReason !== "completed" ? exitReason : null;
      task.pid = null;
      if (exitReason === "completed" && !isError) {
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
  const matches: { fullMatch: string; cwd: string; prompt: string }[] = [];

  let match;
  while ((match = CODE_TASK_REGEX.exec(response)) !== null) {
    matches.push({
      fullMatch: match[0],
      cwd: match[1].trim(),
      prompt: match[2].trim(),
    });
  }
  CODE_TASK_REGEX.lastIndex = 0;

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
