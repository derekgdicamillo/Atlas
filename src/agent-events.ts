/**
 * Atlas — Event-Sourced Agent Actions
 *
 * Logs every agent action (tool call, decision, state transition) as an
 * immutable event. Enables debugging ("what did the agent do at 3am?"),
 * auditing, and training data for the evolution pipeline.
 *
 * Format: JSONL (one JSON object per line) for append-only efficiency.
 * Storage: data/agent-events/{taskId}.jsonl
 */

import { appendFile, readFile, readdir, unlink, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createHash, randomUUID } from "crypto";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const EVENTS_DIR = join(PROJECT_DIR, "data", "agent-events");

// ============================================================
// TYPES
// ============================================================

export type AgentEventType =
  | "tool_call"
  | "tool_result"
  | "phase_transition"
  | "pattern_detected"
  | "intervention"
  | "completion"
  | "failure"
  | "restart";

export interface AgentEvent {
  id: string;
  taskId: string;
  agentId?: string;
  eventType: AgentEventType;
  timestamp: string;
  data: {
    toolName?: string;
    toolInputHash?: string;
    outputSummary?: string;
    phase?: string;
    pattern?: string;
    exitCode?: number;
    costUsd?: number;
    stuckScore?: number;
    errorMessage?: string;
  };
}

export interface EventLog {
  events: AgentEvent[];
  taskId: string;
  startedAt: string;
  completedAt?: string;
}

export interface QueryOptions {
  taskId?: string;
  eventType?: AgentEventType;
  since?: string;
  until?: string;
  limit?: number;
}

// ============================================================
// HELPERS
// ============================================================

function eventFilePath(taskId: string): string {
  // Sanitize taskId to prevent path traversal
  const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(EVENTS_DIR, `${safe}.jsonl`);
}

async function ensureDir(): Promise<void> {
  if (!existsSync(EVENTS_DIR)) {
    await mkdir(EVENTS_DIR, { recursive: true });
  }
}

/** Hash tool input for dedup detection. First 8 hex chars of SHA-256. */
export function inputHash(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .substring(0, 8);
}

// ============================================================
// CORE FUNCTIONS
// ============================================================

/** Append an event to the task's JSONL file. */
export async function logEvent(
  taskId: string,
  eventType: AgentEventType,
  data: AgentEvent["data"] = {}
): Promise<void> {
  try {
    await ensureDir();
    const event: AgentEvent = {
      id: randomUUID(),
      taskId,
      agentId: `pid-${process.pid}`,
      eventType,
      timestamp: new Date().toISOString(),
      data,
    };
    await appendFile(eventFilePath(taskId), JSON.stringify(event) + "\n");
  } catch {
    // Fire-and-forget. Never let event logging break the main flow.
  }
}

/** Read all events for a task. */
export async function getEventLog(taskId: string): Promise<EventLog> {
  const filePath = eventFilePath(taskId);
  const events: AgentEvent[] = [];
  let startedAt = "";
  let completedAt: string | undefined;

  if (!existsSync(filePath)) {
    return { events, taskId, startedAt: new Date().toISOString() };
  }

  const content = await readFile(filePath, "utf-8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event: AgentEvent = JSON.parse(line);
      events.push(event);
      if (!startedAt || event.timestamp < startedAt) startedAt = event.timestamp;
      if (event.eventType === "completion" || event.eventType === "failure") {
        completedAt = event.timestamp;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { events, taskId, startedAt: startedAt || new Date().toISOString(), completedAt };
}

/** Compact summary: event counts, duration, cost, patterns, final status. */
export async function getEventSummary(taskId: string): Promise<{
  totalEvents: number;
  typeCounts: Record<string, number>;
  durationMs: number;
  totalCost: number;
  patterns: string[];
  finalStatus: string;
}> {
  const log = await getEventLog(taskId);
  const typeCounts: Record<string, number> = {};
  let totalCost = 0;
  const patterns: string[] = [];
  let finalStatus = "unknown";

  for (const event of log.events) {
    typeCounts[event.eventType] = (typeCounts[event.eventType] || 0) + 1;
    if (event.data.costUsd) totalCost += event.data.costUsd;
    if (event.data.pattern) patterns.push(event.data.pattern);
    if (event.eventType === "completion") finalStatus = "completed";
    if (event.eventType === "failure") finalStatus = "failed";
    if (event.eventType === "restart") finalStatus = "restarted";
  }

  const durationMs = log.completedAt
    ? new Date(log.completedAt).getTime() - new Date(log.startedAt).getTime()
    : 0;

  return { totalEvents: log.events.length, typeCounts, durationMs, totalCost, patterns, finalStatus };
}

/** Query across all event logs with filters. */
export async function queryEvents(options: QueryOptions = {}): Promise<AgentEvent[]> {
  const results: AgentEvent[] = [];
  const limit = options.limit || 100;

  try {
    await ensureDir();
    const files = options.taskId
      ? [eventFilePath(options.taskId)]
      : (await readdir(EVENTS_DIR)).filter((f) => f.endsWith(".jsonl")).map((f) => join(EVENTS_DIR, f));

    for (const file of files) {
      if (!existsSync(file)) continue;
      const content = await readFile(file, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event: AgentEvent = JSON.parse(line);
          if (options.eventType && event.eventType !== options.eventType) continue;
          if (options.since && event.timestamp < options.since) continue;
          if (options.until && event.timestamp > options.until) continue;
          results.push(event);
          if (results.length >= limit) return results;
        } catch {
          // Skip malformed
        }
      }
    }
  } catch {
    // Return what we have
  }

  return results;
}

/** Format events as a human-readable timeline for debugging/Telegram. */
export async function formatEventTimeline(taskId: string): Promise<string> {
  const log = await getEventLog(taskId);
  if (log.events.length === 0) return `No events found for task ${taskId}`;

  const lines = log.events.map((e) => {
    const time = e.timestamp.substring(11, 19); // HH:MM:SS
    const detail = e.data.toolName
      ? e.data.toolName
      : e.data.pattern
        ? e.data.pattern
        : e.data.phase
          ? e.data.phase
          : e.data.errorMessage
            ? e.data.errorMessage.substring(0, 80)
            : "";
    return `[${time}] ${e.eventType.toUpperCase()}${detail ? ": " + detail : ""}`;
  });

  return lines.join("\n");
}

/** Delete event files older than N days. Returns count of files removed. */
export async function cleanupOldEvents(maxAgeDays: number): Promise<number> {
  let removed = 0;
  try {
    await ensureDir();
    const files = await readdir(EVENTS_DIR);
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(EVENTS_DIR, file);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs < cutoff) {
          await unlink(filePath);
          removed++;
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Non-fatal
  }
  return removed;
}
