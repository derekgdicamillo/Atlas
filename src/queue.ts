/**
 * Atlas — Priority Task Queue
 *
 * When all subagent slots are full, new work queues instead of failing.
 * Tasks are dispatched by priority (CRITICAL > HIGH > NORMAL > LOW > IDLE),
 * FIFO within the same priority tier.
 *
 * Integrates with supervisor.ts for spawning and dag.ts for dependency checks.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { info, warn } from "./logger.ts";
import type { ModelTier } from "./constants.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const QUEUE_FILE = join(DATA_DIR, "queue.json");

// ============================================================
// TYPES
// ============================================================

export enum TaskPriority {
  CRITICAL = 0,  // user-facing, blocking Telegram response
  HIGH = 1,      // swarm tasks with downstream dependents
  NORMAL = 2,    // standard research/code tasks
  LOW = 3,       // background, heartbeat, summarization
  IDLE = 4,      // speculative prefetch
}

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  [TaskPriority.CRITICAL]: "critical",
  [TaskPriority.HIGH]: "high",
  [TaskPriority.NORMAL]: "normal",
  [TaskPriority.LOW]: "low",
  [TaskPriority.IDLE]: "idle",
};

export interface QueuedTask {
  id: string;
  priority: TaskPriority;
  enqueuedAt: string;
  ttl: number;                   // max ms in queue before auto-cancel

  // Task payload (matches registerTask/registerCodeTask opts)
  taskType: "research" | "code";
  description: string;
  prompt: string;
  outputFile: string | null;     // research tasks
  cwd: string | null;            // code tasks
  model: ModelTier;
  timeoutMs: number;
  maxRetries: number;
  requestedBy: string;

  // Swarm integration (null for standalone tasks)
  swarmId: string | null;
  dagNodeId: string | null;

  // Code agent options
  maxToolCalls?: number;
  wallClockMs?: number;
  inactivityMs?: number;
  budgetUsd?: number;
}

interface QueueStore {
  tasks: QueuedTask[];
  totalEnqueued: number;
  totalDispatched: number;
  totalDropped: number;
  totalExpired: number;
}

// ============================================================
// CONSTANTS
// ============================================================

export const MAX_QUEUE_SIZE = 25;
export const DEFAULT_TTL_MS = 10 * 60 * 1000;       // 10 min for normal tasks
export const SWARM_TTL_MS = 30 * 60 * 1000;          // 30 min for swarm tasks
const EXPIRE_CHECK_INTERVAL_MS = 60_000;              // 60s

// ============================================================
// STATE
// ============================================================

let store: QueueStore = {
  tasks: [],
  totalEnqueued: 0,
  totalDispatched: 0,
  totalDropped: 0,
  totalExpired: 0,
};

// Callback set by supervisor integration to dispatch tasks
let dispatchCallback: ((task: QueuedTask) => Promise<void>) | null = null;

// Callback set by dag integration to check if a swarm node is ready
let dagReadyCallback: ((swarmId: string, nodeId: string) => boolean) | null = null;

// ============================================================
// PERSISTENCE
// ============================================================

export async function loadQueue(): Promise<void> {
  try {
    if (existsSync(QUEUE_FILE)) {
      const content = await readFile(QUEUE_FILE, "utf-8");
      store = JSON.parse(content);
      info("queue", `Loaded ${store.tasks.length} queued tasks from disk`);
    }
  } catch (err) {
    warn("queue", `Failed to load queue: ${err}`);
  }
}

export async function persistQueue(): Promise<void> {
  try {
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }
    await writeFile(QUEUE_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    warn("queue", `Failed to persist queue: ${err}`);
  }
}

// ============================================================
// REGISTRATION
// ============================================================

/**
 * Register callbacks for queue dispatch and DAG readiness checks.
 * Called once during startup from relay.ts.
 */
export function registerQueueCallbacks(opts: {
  onDispatch: (task: QueuedTask) => Promise<void>;
  isDagNodeReady?: (swarmId: string, nodeId: string) => boolean;
}): void {
  dispatchCallback = opts.onDispatch;
  dagReadyCallback = opts.isDagNodeReady || null;
}

// ============================================================
// CORE OPERATIONS
// ============================================================

/**
 * Add a task to the priority queue.
 * Sorted by priority (lower = higher priority), then FIFO within same priority.
 */
export async function enqueue(task: QueuedTask): Promise<boolean> {
  // Check if queue is full
  if (store.tasks.length >= MAX_QUEUE_SIZE) {
    // Try to drop lowest priority task to make room
    const lowestPriority = Math.max(...store.tasks.map(t => t.priority));
    if (task.priority < lowestPriority) {
      // New task has higher priority, drop the lowest
      const dropIdx = store.tasks.findLastIndex(t => t.priority === lowestPriority);
      if (dropIdx >= 0) {
        const dropped = store.tasks.splice(dropIdx, 1)[0];
        store.totalDropped++;
        warn("queue", `Dropped ${PRIORITY_LABELS[dropped.priority]} task "${dropped.description}" to make room for ${PRIORITY_LABELS[task.priority]} task`);
      }
    } else {
      warn("queue", `Queue full (${MAX_QUEUE_SIZE}), rejecting ${PRIORITY_LABELS[task.priority]} task: ${task.description}`);
      return false;
    }
  }

  // Insert sorted: by priority ASC, then by enqueuedAt ASC (FIFO within tier)
  let insertIdx = store.tasks.findIndex(t =>
    t.priority > task.priority ||
    (t.priority === task.priority && t.enqueuedAt > task.enqueuedAt)
  );
  if (insertIdx === -1) insertIdx = store.tasks.length;

  store.tasks.splice(insertIdx, 0, task);
  store.totalEnqueued++;

  info("queue", `Enqueued [${PRIORITY_LABELS[task.priority]}] "${task.description}" (${store.tasks.length} in queue)`);
  await persistQueue();

  // Try to dispatch immediately
  await tryDispatch();

  return true;
}

/**
 * Remove and return the highest priority task that is ready to run.
 * For swarm tasks, checks DAG readiness.
 */
function dequeue(): QueuedTask | null {
  for (let i = 0; i < store.tasks.length; i++) {
    const task = store.tasks[i];

    // For swarm tasks, check if the DAG node is ready
    if (task.swarmId && task.dagNodeId && dagReadyCallback) {
      if (!dagReadyCallback(task.swarmId, task.dagNodeId)) {
        continue; // Skip, upstream deps not done yet
      }
    }

    // Ready to dispatch
    store.tasks.splice(i, 1);
    store.totalDispatched++;
    return task;
  }

  return null; // Nothing ready
}

/**
 * Try to dispatch queued tasks to available slots.
 * Called on: task completion, enqueue, periodic tick.
 */
export async function tryDispatch(): Promise<number> {
  if (!dispatchCallback) return 0;

  // Import dynamically to avoid circular deps
  const { getRunningCount, getMaxConcurrent } = await import("./supervisor.ts");
  const running = getRunningCount();
  const max = getMaxConcurrent();
  let dispatched = 0;

  while (running + dispatched < max) {
    const task = dequeue();
    if (!task) break;

    try {
      await dispatchCallback(task);
      dispatched++;
      info("queue", `Dispatched [${PRIORITY_LABELS[task.priority]}] "${task.description}" (${store.tasks.length} remaining)`);
    } catch (err) {
      // Dispatch failed, re-enqueue with lower TTL
      warn("queue", `Dispatch failed for "${task.description}": ${err}`);
      task.ttl = Math.max(task.ttl - 60_000, 60_000); // lose 1 min TTL on failure
      store.tasks.unshift(task); // put back at front
      store.totalDispatched--; // undo count
      break;
    }
  }

  if (dispatched > 0) {
    await persistQueue();
  }

  return dispatched;
}

/**
 * Remove all queued tasks for a specific swarm.
 */
export async function dequeueBySwarmId(swarmId: string): Promise<number> {
  const before = store.tasks.length;
  store.tasks = store.tasks.filter(t => t.swarmId !== swarmId);
  const removed = before - store.tasks.length;
  if (removed > 0) {
    store.totalDropped += removed;
    info("queue", `Removed ${removed} queued tasks for swarm ${swarmId}`);
    await persistQueue();
  }
  return removed;
}

/**
 * Expire tasks that have exceeded their TTL.
 * Called periodically from heartbeat.
 */
export async function expireStaleTasks(): Promise<number> {
  const now = Date.now();
  const before = store.tasks.length;

  store.tasks = store.tasks.filter(t => {
    const age = now - new Date(t.enqueuedAt).getTime();
    if (age > t.ttl) {
      warn("queue", `Expired queued task "${t.description}" (age: ${Math.round(age / 60000)}m, ttl: ${Math.round(t.ttl / 60000)}m)`);
      store.totalExpired++;
      return false;
    }
    return true;
  });

  const expired = before - store.tasks.length;
  if (expired > 0) {
    await persistQueue();
  }
  return expired;
}

// ============================================================
// QUERY
// ============================================================

export function getQueueLength(): number {
  return store.tasks.length;
}

export function getQueuePressure(): number {
  return store.tasks.length / MAX_QUEUE_SIZE;
}

export function getQueueStats(): {
  length: number;
  pressure: number;
  byPriority: Record<string, number>;
  totalEnqueued: number;
  totalDispatched: number;
  totalDropped: number;
  totalExpired: number;
} {
  const byPriority: Record<string, number> = {};
  for (const task of store.tasks) {
    const label = PRIORITY_LABELS[task.priority];
    byPriority[label] = (byPriority[label] || 0) + 1;
  }

  return {
    length: store.tasks.length,
    pressure: getQueuePressure(),
    byPriority,
    totalEnqueued: store.totalEnqueued,
    totalDispatched: store.totalDispatched,
    totalDropped: store.totalDropped,
    totalExpired: store.totalExpired,
  };
}

/**
 * Format queue status for /status command or context injection.
 */
export function getQueueContext(): string {
  if (store.tasks.length === 0) return "";

  const stats = getQueueStats();
  const priorityStr = Object.entries(stats.byPriority)
    .map(([p, n]) => `${n} ${p}`)
    .join(", ");

  let ctx = `Queue: ${stats.length} tasks waiting (${priorityStr})`;

  // Show first 3 tasks
  const preview = store.tasks.slice(0, 3);
  for (const t of preview) {
    const swarmNote = t.swarmId ? ` [swarm: ${t.swarmId.slice(0, 8)}]` : "";
    ctx += `\n  [${PRIORITY_LABELS[t.priority]}] ${t.description.slice(0, 60)}${swarmNote}`;
  }
  if (store.tasks.length > 3) {
    ctx += `\n  ... and ${store.tasks.length - 3} more`;
  }

  return ctx;
}
