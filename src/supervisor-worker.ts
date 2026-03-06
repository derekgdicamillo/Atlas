/**
 * Atlas — Supervisor Worker
 *
 * Background process that monitors running code agents.
 * Runs as a cron job, separate from the main relay to keep it responsive.
 *
 * Responsibilities:
 * - Read code agent output streams from data/code-agent-output/
 * - Run pattern detection on tool calls
 * - Run shadow evaluation periodically
 * - Kill stuck/looping agents
 * - Restart failed agents with better context
 * - Report completion/issues via task events and Telegram
 */

import { readFile, writeFile, readdir, unlink } from "fs/promises";
import { existsSync, statSync } from "fs";
import { join } from "path";
import { info, warn, error as logError, trackClaudeCall } from "./logger.ts";
import { createPatternDetector, isReadOnlyTask, type PatternDetector, type DetectedPattern } from "./patterns.ts";
import { createShadowEvaluator, storeEvaluation, type ShadowEvaluator } from "./shadow-evaluator.ts";
import { extractPatternsFromTask, findSimilarPatterns } from "./learned-patterns.ts";
import { createStreamParser } from "./claude.ts";
import { taskEvents, getTask, restartCodeTask } from "./supervisor.ts";
import {
  SUPERVISOR_ENABLED,
  SUPERVISOR_PATTERN_DETECT,
  SUPERVISOR_SHADOW_EVAL,
  SUPERVISOR_SHADOW_INTERVAL,
  SUPERVISOR_SHADOW_MODEL,
  SUPERVISOR_MAX_RESTARTS,
  SUPERVISOR_LEARNING,
  SUPERVISOR_MODE,
  TOKEN_COSTS,
  type ModelTier,
} from "./constants.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const CODE_AGENT_OUTPUT_DIR = join(DATA_DIR, "code-agent-output");

// Rate-limit pattern detection log spam (one log per pattern per 5-min window)
const patternLogTimes = new Map<string, number>();

// ============================================================
// TYPES
// ============================================================

interface AgentMeta {
  taskId: string;
  pid: number;
  model: ModelTier;
  cwd: string;
  prompt: string;
  startedAt: string;
  maxToolCalls: number;
  wallClockMs: number;
  inactivityMs: number;
  budgetUsd: number;
  checkpoints: string | null;
}

interface AgentState {
  meta: AgentMeta;
  outputFile: string;
  metaFile: string;
  lastReadPosition: number;
  toolCallCount: number;
  lastActivityAt: number;
  patternDetector: PatternDetector;
  shadowEvaluator: ShadowEvaluator | null;
  detectedPatterns: string[];
  isComplete: boolean;
  exitCode: number | null;
  costUsd: number;
}

// Track agent states across supervisor runs
const agentStates: Map<string, AgentState> = new Map();

// ============================================================
// MAIN WORKER FUNCTION
// ============================================================

/**
 * Main supervisor worker tick.
 * Called periodically by cron to check on running code agents.
 */
export async function runSupervisorWorker(): Promise<{
  checked: number;
  interventions: number;
  completed: number;
}> {
  if (!SUPERVISOR_ENABLED) {
    return { checked: 0, interventions: 0, completed: 0 };
  }

  // NOTE: Do NOT call loadTasks() here. The store is shared in-memory with supervisor.ts.
  // Calling loadTasks() every 30s was overwriting in-memory state (completed tasks reset to "running"),
  // causing duplicate completions, duplicate Telegram summaries, and wasted haiku calls.
  // Store is loaded once at startup in cron.ts:startCronJobs(). All mutations happen in-memory.

  let checked = 0;
  let interventions = 0;
  let completed = 0;

  try {
    // Find all active code agent output directories
    if (!existsSync(CODE_AGENT_OUTPUT_DIR)) {
      return { checked: 0, interventions: 0, completed: 0 };
    }

    const files = await readdir(CODE_AGENT_OUTPUT_DIR);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));

    for (const metaFile of metaFiles) {
      const taskId = metaFile.replace(".meta.json", "");
      const metaPath = join(CODE_AGENT_OUTPUT_DIR, metaFile);
      const outputPath = join(CODE_AGENT_OUTPUT_DIR, `${taskId}.jsonl`);

      try {
        const result = await checkAgent(taskId, metaPath, outputPath);
        checked++;

        if (result.intervention) {
          interventions++;
        }
        if (result.completed) {
          completed++;
        }
      } catch (err) {
        warn("supervisor-worker", `Error checking agent ${taskId}: ${err}`);
      }
    }
  } catch (err) {
    logError("supervisor-worker", `Worker error: ${err}`);
  }

  if (checked > 0) {
    info("supervisor-worker", `Checked ${checked} agents, ${interventions} interventions, ${completed} completed`);
  }

  return { checked, interventions, completed };
}

// ============================================================
// AGENT CHECKING
// ============================================================

interface CheckResult {
  intervention: boolean;
  completed: boolean;
  reason?: string;
}

async function checkAgent(
  taskId: string,
  metaPath: string,
  outputPath: string
): Promise<CheckResult> {
  // Load or initialize agent state
  let state = agentStates.get(taskId);

  if (!state) {
    // First time seeing this agent
    const metaContent = await readFile(metaPath, "utf-8");
    const meta: AgentMeta = JSON.parse(metaContent);

    const readOnly = isReadOnlyTask(meta.prompt || "");
    state = {
      meta,
      outputFile: outputPath,
      metaFile: metaPath,
      lastReadPosition: 0,
      toolCallCount: 0,
      lastActivityAt: Date.now(),
      patternDetector: createPatternDetector(taskId, { readOnly }),
      shadowEvaluator: SUPERVISOR_SHADOW_EVAL
        ? createShadowEvaluator({ model: SUPERVISOR_SHADOW_MODEL })
        : null,
      detectedPatterns: [],
      isComplete: false,
      exitCode: null,
      costUsd: 0,
    };
    agentStates.set(taskId, state);
    info("supervisor-worker", `Started monitoring agent ${taskId}${readOnly ? " (read-only mode)" : ""}`);
  }

  // Check if already complete
  if (state.isComplete) {
    return { intervention: false, completed: true };
  }

  // Check if process is still alive
  const isAlive = isProcessAlive(state.meta.pid);

  // Read new output
  if (existsSync(outputPath)) {
    const newEvents = await readNewOutput(state, outputPath);

    for (const event of newEvents) {
      await processEvent(state, event);
    }
  }

  // Check for completion marker
  if (state.isComplete) {
    await handleCompletion(state);
    return { intervention: false, completed: true };
  }

  // If process died but no completion marker, mark as failed
  if (!isAlive && !state.isComplete) {
    info("supervisor-worker", `Agent ${taskId} process died without completion marker`);
    state.isComplete = true;
    state.exitCode = -1;
    await handleCompletion(state);
    return { intervention: false, completed: true };
  }

  // Check for timeouts
  const now = Date.now();
  const startTime = new Date(state.meta.startedAt).getTime();
  const elapsed = now - startTime;
  const idle = now - state.lastActivityAt;

  // Wall clock timeout
  if (elapsed > state.meta.wallClockMs) {
    warn("supervisor-worker", `Agent ${taskId} wall clock timeout (${Math.round(elapsed / 1000)}s)`);
    await killAgent(state, "wall_clock");
    return { intervention: true, completed: false, reason: "wall_clock" };
  }

  // Inactivity timeout
  if (idle > state.meta.inactivityMs) {
    warn("supervisor-worker", `Agent ${taskId} inactivity timeout (${Math.round(idle / 1000)}s)`);
    await killAgent(state, "inactivity");
    return { intervention: true, completed: false, reason: "inactivity" };
  }

  // Tool call limit
  if (state.toolCallCount > state.meta.maxToolCalls) {
    warn("supervisor-worker", `Agent ${taskId} tool limit exceeded (${state.toolCallCount})`);
    await killAgent(state, "tool_limit");
    return { intervention: true, completed: false, reason: "tool_limit" };
  }

  // Budget check
  if (state.costUsd > state.meta.budgetUsd) {
    warn("supervisor-worker", `Agent ${taskId} budget exceeded ($${state.costUsd.toFixed(2)})`);
    await killAgent(state, "budget");
    return { intervention: true, completed: false, reason: "budget" };
  }

  // Run shadow evaluation if due
  if (
    state.shadowEvaluator &&
    state.toolCallCount > 0 &&
    state.toolCallCount % SUPERVISOR_SHADOW_INTERVAL === 0
  ) {
    const evalResult = await runShadowEval(state);
    if (evalResult && (evalResult.decision === "kill_restart" || evalResult.decision === "kill_abort")) {
      await killAgent(state, `shadow_eval: ${evalResult.decision}`);
      return { intervention: true, completed: false, reason: evalResult.decision };
    }
  }

  return { intervention: false, completed: false };
}

// ============================================================
// OUTPUT PARSING
// ============================================================

interface StreamEvent {
  type: string;
  toolName?: string;
  toolInput?: Record<string, any>;
  resultText?: string;
  isError?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  exitCode?: number;
  stderr?: string;
  completedAt?: string;
}

async function readNewOutput(state: AgentState, outputPath: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];

  try {
    const stats = statSync(outputPath);
    if (stats.size <= state.lastReadPosition) {
      return events;
    }

    const content = await readFile(outputPath, "utf-8");
    const newContent = content.substring(state.lastReadPosition);
    state.lastReadPosition = content.length;

    const lines = newContent.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        // Raw Claude CLI JSON has tool calls nested inside message.content.
        // Transform to flat StreamEvent format the worker expects.
        if (parsed.type === "assistant" && parsed.message?.content) {
          for (const block of parsed.message.content) {
            if (block.type === "tool_use") {
              events.push({
                type: "assistant",
                toolName: block.name || "unknown",
                toolInput: block.input,
              });
            }
          }
        } else if (parsed.type === "result") {
          events.push({
            type: "result",
            inputTokens: parsed.usage?.input_tokens,
            outputTokens: parsed.usage?.output_tokens,
          });
        } else if (parsed.toolName || parsed.type === "stream_complete" || parsed.type === "stream_error") {
          // Already flat format or completion markers
          events.push(parsed);
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch (err) {
    warn("supervisor-worker", `Error reading output for ${state.meta.taskId}: ${err}`);
  }

  return events;
}

async function processEvent(state: AgentState, event: StreamEvent): Promise<void> {
  state.lastActivityAt = Date.now();

  if (event.type === "stream_complete") {
    state.isComplete = true;
    state.exitCode = event.exitCode ?? null;
    return;
  }

  if (event.type === "assistant") {
    // Tool call - run pattern detection
    state.toolCallCount++;

    if (SUPERVISOR_PATTERN_DETECT) {
      const detected = state.patternDetector.check({
        toolName: event.toolName || "unknown",
        toolInput: event.toolInput,
        timestamp: Date.now(),
        isError: false,
      });

      if (detected && detected.action !== "none") {
        state.detectedPatterns.push(detected.type);

        // Patterns that are safe to act on regardless of SUPERVISOR_MODE.
        // stuck_exploration and read_loop with high severity mean the agent is burning
        // money without making progress. Letting them run is pure waste.
        // EXCEPTION: read-only tasks (audits, plan mode) are expected to read extensively
        // without writing. Don't auto-kill them for doing their job.
        const alwaysActPatterns: Set<string> = new Set(
          state.patternDetector.isReadOnly
            ? [] // read-only tasks: no always-act patterns, rely on normal thresholds
            : ["stuck_exploration", "read_loop"]
        );
        const shouldIntervene =
          SUPERVISOR_MODE === "active" ||
          (detected.severity === "high" && alwaysActPatterns.has(detected.type));

        if (shouldIntervene) {
          if (detected.action === "kill_restart" || detected.action === "kill_abort") {
            warn("supervisor-worker", `Pattern intervention: ${detected.type} (severity=${detected.severity})`);
            await killAgent(state, `pattern: ${detected.type}`);
          }
        } else {
          // Rate-limit log spam: only log once per pattern per 5-min window
          const logKey = `${state.meta.taskId}-${detected.type}`;
          const lastLogged = patternLogTimes.get(logKey) || 0;
          const now = Date.now();
          if (now - lastLogged > 300_000) {
            info("supervisor-worker", `Pattern (log-only): ${state.meta.taskId} - ${detected.type}`);
            patternLogTimes.set(logKey, now);
          }
        }
      }
    }
  }

  if (event.type === "result") {
    // Calculate cost
    const costRates = TOKEN_COSTS[state.meta.model] || TOKEN_COSTS.sonnet;
    state.costUsd =
      ((event.inputTokens || 0) * costRates.input +
        (event.outputTokens || 0) * costRates.output) /
      1_000_000;
  }
}

// ============================================================
// SHADOW EVALUATION
// ============================================================

async function runShadowEval(state: AgentState): Promise<{ decision: string } | null> {
  if (!state.shadowEvaluator) return null;

  try {
    const startTime = new Date(state.meta.startedAt).getTime();
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);

    const evalResult = await state.shadowEvaluator.evaluate({
      taskId: state.meta.taskId,
      originalPrompt: state.meta.prompt,
      toolCallCount: state.toolCallCount,
      elapsedSec,
      costUsd: state.costUsd,
      recentTools: state.patternDetector.getSummary().recentTools,
      patternSummary: state.patternDetector.getSummary(),
      previousEvals: state.shadowEvaluator.getHistory(),
    });

    await storeEvaluation(state.meta.taskId, evalResult, {
      taskId: state.meta.taskId,
      toolCallCount: state.toolCallCount,
      elapsedSec,
    });

    info(
      "supervisor-worker",
      `Shadow eval ${state.meta.taskId}: c=${evalResult.coherenceScore} a=${evalResult.approachScore} e=${evalResult.efficiencyScore} -> ${evalResult.decision}`
    );

    return { decision: evalResult.decision };
  } catch (err) {
    warn("supervisor-worker", `Shadow eval error: ${err}`);
    return null;
  }
}

// ============================================================
// INTERVENTION
// ============================================================

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killAgent(state: AgentState, reason: string): Promise<void> {
  info("supervisor-worker", `Killing agent ${state.meta.taskId}: ${reason}`);

  try {
    process.kill(state.meta.pid, "SIGTERM");
    // Give it a moment then SIGKILL
    setTimeout(() => {
      try {
        process.kill(state.meta.pid, 0);
        process.kill(state.meta.pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }, 3000);
  } catch {
    // Already dead
  }

  state.isComplete = true;
  state.exitCode = -1;

  // Consider restart if under limit.
  // Always-act pattern kills (stuck_exploration, read_loop) fire even in log_only mode,
  // so restarts should also be allowed for those kills regardless of mode.
  const isAlwaysActKill = reason.startsWith("pattern: ");
  if ((SUPERVISOR_MODE === "active" || isAlwaysActKill) && reason !== "kill_abort") {
    const task = await getTask(state.meta.taskId);
    const restartCount = task?.restartCount || 0;

    if (restartCount < SUPERVISOR_MAX_RESTARTS) {
      info("supervisor-worker", `Scheduling restart for ${state.meta.taskId} (attempt ${restartCount + 1})`);
      // Queue restart (will be picked up by main relay via event)
      taskEvents.emit("task:needs_restart", {
        taskId: state.meta.taskId,
        reason,
        detectedPatterns: state.detectedPatterns,
      });
    } else {
      warn("supervisor-worker", `Max restarts exceeded for ${state.meta.taskId}`);
    }
  }

  await handleCompletion(state);
}

async function handleCompletion(state: AgentState): Promise<void> {
  const success = state.exitCode === 0;

  info(
    "supervisor-worker",
    `Agent ${state.meta.taskId} completed: exit=${state.exitCode} tools=${state.toolCallCount} cost=$${state.costUsd.toFixed(4)}`
  );

  // Learning: extract patterns
  if (SUPERVISOR_LEARNING) {
    try {
      await extractPatternsFromTask({
        taskId: state.meta.taskId,
        prompt: state.meta.prompt,
        success,
        exitReason: success ? "completed" : "error",
        toolCallCount: state.toolCallCount,
        costUsd: state.costUsd,
        durationMs: Date.now() - new Date(state.meta.startedAt).getTime(),
        toolHistory: state.patternDetector.getToolHistory(),
        detectedPatterns: state.detectedPatterns,
      });
    } catch (err) {
      warn("supervisor-worker", `Pattern extraction failed: ${err}`);
    }
  }

  // Clean up old files (keep for 1 hour for debugging)
  setTimeout(async () => {
    try {
      if (existsSync(state.outputFile)) await unlink(state.outputFile);
      if (existsSync(state.metaFile)) await unlink(state.metaFile);
      agentStates.delete(state.meta.taskId);
    } catch {
      // Ignore cleanup errors
    }
  }, 60 * 60 * 1000);

  // Emit completion. Look up the full task object from the store so handleTaskEvent
  // in relay.ts gets a real SupervisedTask (not a bare { taskId } stub that causes
  // "Task undefined: Task unknown" messages).
  const fullTask = await getTask(state.meta.taskId);
  if (fullTask) {
    taskEvents.emit(success ? "task:completed" : "task:failed", fullTask);
  } else {
    warn("supervisor-worker", `Cannot find task ${state.meta.taskId} in store for event emission`);
  }
}

// ============================================================
// STATUS QUERY
// ============================================================

/**
 * Get status of all running code agents.
 * Used by /codestatus command.
 */
export function getCodeAgentStatus(): Array<{
  taskId: string;
  pid: number;
  model: string;
  toolCallCount: number;
  elapsedSec: number;
  costUsd: number;
  lastTool: string;
  detectedPatterns: string[];
  isAlive: boolean;
}> {
  const statuses: Array<{
    taskId: string;
    pid: number;
    model: string;
    toolCallCount: number;
    elapsedSec: number;
    costUsd: number;
    lastTool: string;
    detectedPatterns: string[];
    isAlive: boolean;
  }> = [];

  for (const [taskId, state] of agentStates) {
    if (state.isComplete) continue;

    const startTime = new Date(state.meta.startedAt).getTime();
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    const summary = state.patternDetector.getSummary();

    statuses.push({
      taskId,
      pid: state.meta.pid,
      model: state.meta.model,
      toolCallCount: state.toolCallCount,
      elapsedSec,
      costUsd: state.costUsd,
      lastTool: summary.recentTools[summary.recentTools.length - 1] || "none",
      detectedPatterns: state.detectedPatterns,
      isAlive: isProcessAlive(state.meta.pid),
    });
  }

  return statuses;
}

/**
 * Get detailed status for a specific task.
 */
export async function getCodeAgentDetail(taskId: string): Promise<{
  meta: AgentMeta;
  toolCallCount: number;
  elapsedSec: number;
  costUsd: number;
  recentTools: string[];
  detectedPatterns: string[];
  isAlive: boolean;
  isComplete: boolean;
} | null> {
  const state = agentStates.get(taskId);
  if (!state) return null;

  const startTime = new Date(state.meta.startedAt).getTime();
  const elapsedSec = Math.round((Date.now() - startTime) / 1000);
  const summary = state.patternDetector.getSummary();

  return {
    meta: state.meta,
    toolCallCount: state.toolCallCount,
    elapsedSec,
    costUsd: state.costUsd,
    recentTools: summary.recentTools,
    detectedPatterns: state.detectedPatterns,
    isAlive: isProcessAlive(state.meta.pid),
    isComplete: state.isComplete,
  };
}
