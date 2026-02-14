/**
 * Atlas — In-Session Heartbeat
 *
 * Runs inside Derek's active conversation session (via --resume) so
 * the agent retains full context between interactions.
 *
 * Rotating checks: health, todos, memory, journal, conversation
 * HEARTBEAT_OK suppression: only notifies when something needs attention.
 * Memory flush: heartbeat can use [REMEMBER:] and [TODO:] tags.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaude } from "./claude.ts";
import { processMemoryIntents, getMemoryContext } from "./memory.ts";
import { getTodoContext } from "./todo.ts";
import { getMetrics, getHealthStatus, error as logError } from "./logger.ts";
import type { ModelTier } from "./constants.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const MEMORY_DIR = join(PROJECT_DIR, "memory");
const STATE_FILE = join(DATA_DIR, "heartbeat-state.json");
const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";
const HEARTBEAT_MODEL: ModelTier =
  (process.env.HEARTBEAT_MODEL as ModelTier) || "sonnet";
const DEREK_USER_ID = process.env.TELEGRAM_USER_ID || "";

// ============================================================
// STATE
// ============================================================

const CHECK_TYPES = ["health", "todos", "memory", "journal", "conversation"] as const;
type CheckType = (typeof CHECK_TYPES)[number];

interface HeartbeatState {
  tickCount: number;
  lastCheckType: CheckType;
  lastResult: "ok" | "notified" | "skipped" | "error";
  lastTimestamp: string;
  notes: string[];
  consecutiveFailures: number;
  nextRetryAfter: string | null;
}

async function loadState(): Promise<HeartbeatState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(content);
    // Backward compat: add fields missing from old state files
    if (parsed.consecutiveFailures === undefined) parsed.consecutiveFailures = 0;
    if (parsed.nextRetryAfter === undefined) parsed.nextRetryAfter = null;
    return parsed as HeartbeatState;
  } catch {
    return {
      tickCount: 0,
      lastCheckType: "conversation",
      lastResult: "ok",
      lastTimestamp: new Date().toISOString(),
      notes: [],
      consecutiveFailures: 0,
      nextRetryAfter: null,
    };
  }
}

async function saveState(state: HeartbeatState): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// CHECK-SPECIFIC CONTEXT GATHERING
// ============================================================

async function getHealthContext(): Promise<string> {
  const metrics = getMetrics();
  const health = getHealthStatus();
  return (
    `HEALTH STATUS: ${health.status}\n` +
    `- Uptime since: ${metrics.startedAt}\n` +
    `- Messages: ${metrics.messageCount} | Claude calls: ${metrics.claudeCallCount}\n` +
    `- Errors: ${metrics.errorCount} | Timeouts: ${metrics.claudeTimeoutCount}\n` +
    `- Avg response: ${metrics.avgResponseMs}ms\n` +
    (health.issues.length > 0
      ? `- Issues: ${health.issues.join("; ")}\n`
      : "- No issues detected\n") +
    (metrics.recentErrors.length > 0
      ? `- Recent errors:\n${metrics.recentErrors
          .slice(-5)
          .map((e) => `  ${e.time}: [${e.event}] ${e.message}`)
          .join("\n")}\n`
      : "")
  );
}

async function getJournalContext(): Promise<string> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  const journalPath = join(MEMORY_DIR, `${today}.md`);

  try {
    const content = await readFile(journalPath, "utf-8");
    const lineCount = content.split("\n").filter((l) => l.trim()).length;
    if (lineCount <= 1) {
      return `JOURNAL (${today}): Created but empty — no entries logged today.`;
    }
    // Show last ~500 chars to keep token count reasonable
    const tail = content.length > 500 ? "..." + content.slice(-500) : content;
    return `JOURNAL (${today}) [${lineCount} lines]:\n${tail}`;
  } catch {
    return `JOURNAL (${today}): No journal file exists for today.`;
  }
}

// ============================================================
// BUILD HEARTBEAT PROMPT
// ============================================================

async function buildHeartbeatPrompt(
  checkType: CheckType,
  state: HeartbeatState,
  supabase: SupabaseClient | null
): Promise<string> {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const metrics = getMetrics();
  const health = getHealthStatus();
  const uptimeHrs = Math.round(
    (Date.now() - new Date(metrics.startedAt).getTime()) / 3600000
  );

  // Gather check-specific context
  let checkContext = "";
  switch (checkType) {
    case "health":
      checkContext = await getHealthContext();
      break;
    case "todos":
      checkContext = (await getTodoContext()) || "No tasks found in MASTER TODO.";
      break;
    case "memory":
      checkContext =
        (await getMemoryContext(supabase)) ||
        "No memory context available (Supabase not configured or empty).";
      break;
    case "journal":
      checkContext = await getJournalContext();
      break;
    case "conversation":
      checkContext =
        "Review the recent conversation context (available via --resume). " +
        "Check for loose threads, promises made, or follow-ups needed.";
      break;
  }

  const previousNotes =
    state.notes.length > 0
      ? state.notes.slice(-3).join("\n")
      : "(no previous notes)";

  return (
    `[HEARTBEAT] Tick #${state.tickCount + 1} | ${timeStr} | Check: ${checkType}\n\n` +
    "You are performing an internal heartbeat check. This runs every 30 minutes during active hours.\n" +
    "You are IN Derek's conversation session — you can see recent context.\n\n" +
    "RULES:\n" +
    "- If nothing needs Derek's attention, respond EXACTLY: HEARTBEAT_OK\n" +
    "- If something is actionable, write a brief Telegram-ready message for Derek\n" +
    "- Use [REMEMBER: ...] to persist important context before it gets lost\n" +
    "- Use [TODO: ...] to capture tasks you notice that aren't tracked yet\n" +
    "- Do NOT greet Derek. This is an internal system check, not a conversation.\n" +
    "- Keep it SHORT. This is not a report — it's a quick check.\n\n" +
    `CURRENT CHECK: ${checkType}\n${checkContext}\n\n` +
    "SYSTEM SUMMARY:\n" +
    `- Uptime: ${uptimeHrs}h | Msgs today: ${metrics.messageCount} | Health: ${health.status} | Errors: ${metrics.errorCount}\n` +
    `- Last heartbeat: tick #${state.tickCount} (${state.lastResult}) | Model: ${HEARTBEAT_MODEL}\n\n` +
    "PREVIOUS HEARTBEAT NOTES:\n" +
    previousNotes
  );
}

// ============================================================
// MAIN EXPORT
// ============================================================

export interface HeartbeatResult {
  skipped: boolean;
  shouldNotify: boolean;
  message: string;
}

/** Compute backoff delay in ms: 1m, 2m, 4m, 8m... capped at 30m */
function backoffMs(failures: number): number {
  const base = 60_000; // 1 minute
  const cap = 30 * 60_000; // 30 minutes
  return Math.min(base * Math.pow(2, failures - 1), cap);
}

export async function runHeartbeat(
  supabase: SupabaseClient | null
): Promise<HeartbeatResult> {
  const state = await loadState();

  // Check backoff: skip if we're still in a cooldown period
  if (state.nextRetryAfter && new Date() < new Date(state.nextRetryAfter)) {
    return { skipped: true, shouldNotify: false, message: "" };
  }

  // Determine next check type (rotate)
  const currentIdx = CHECK_TYPES.indexOf(state.lastCheckType);
  const nextIdx = (currentIdx + 1) % CHECK_TYPES.length;
  const checkType = CHECK_TYPES[nextIdx];

  const prompt = await buildHeartbeatPrompt(checkType, state, supabase);

  let rawResponse: string;
  try {
    // Call Claude in Derek's session with skip-if-busy lock
    rawResponse = await callClaude(prompt, {
      resume: true,
      model: HEARTBEAT_MODEL,
      agentId: "atlas",
      userId: DEREK_USER_ID,
      lockBehavior: "skip",
    });
  } catch (err) {
    // Heartbeat call crashed. Apply exponential backoff.
    state.consecutiveFailures++;
    state.lastResult = "error";
    state.lastTimestamp = new Date().toISOString();
    const delayMs = backoffMs(state.consecutiveFailures);
    state.nextRetryAfter = new Date(Date.now() + delayMs).toISOString();
    await saveState(state);

    const msg = `Heartbeat callClaude failed (attempt ${state.consecutiveFailures}, backoff ${Math.round(delayMs / 60000)}m): ${err}`;
    if (state.consecutiveFailures >= 3) {
      logError("heartbeat", msg);
    } else {
      console.log(`[heartbeat] ${msg}`);
    }

    return { skipped: false, shouldNotify: false, message: "" };
  }

  // Empty response means lock was busy (session in use)
  if (!rawResponse) {
    state.lastResult = "skipped";
    state.lastTimestamp = new Date().toISOString();
    await saveState(state);
    return { skipped: true, shouldNotify: false, message: "" };
  }

  // Success path: reset failure counter
  state.consecutiveFailures = 0;
  state.nextRetryAfter = null;

  // Process memory intents ([REMEMBER:], [TODO:], etc.)
  const response = await processMemoryIntents(supabase, rawResponse);

  // Update state
  state.tickCount++;
  state.lastCheckType = checkType;
  state.lastTimestamp = new Date().toISOString();

  // Check for HEARTBEAT_OK (suppress notification)
  const isOk = response.trim().toUpperCase().includes("HEARTBEAT_OK");

  if (isOk) {
    state.lastResult = "ok";
    // Extract any notes after HEARTBEAT_OK
    const afterOk = response.replace(/HEARTBEAT_OK/i, "").trim();
    if (afterOk) {
      state.notes.push(`[${checkType}] ${afterOk}`);
    }
    // Keep only last 10 notes
    if (state.notes.length > 10) {
      state.notes = state.notes.slice(-10);
    }
    await saveState(state);
    return { skipped: false, shouldNotify: false, message: "" };
  }

  // Something needs Derek's attention
  state.lastResult = "notified";
  state.notes.push(`[${checkType}] NOTIFIED: ${response.substring(0, 100)}`);
  if (state.notes.length > 10) {
    state.notes = state.notes.slice(-10);
  }
  await saveState(state);

  return { skipped: false, shouldNotify: true, message: response };
}
