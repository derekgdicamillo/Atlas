/**
 * Atlas — Scheduled Messages
 *
 * Queue one-off messages to be sent at specific times via Telegram.
 * Persists to disk for crash recovery. Checked every minute by cron.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { info, warn } from "./logger.ts";

const PROJECT_ROOT = dirname(import.meta.dir);
const DATA_DIR = join(PROJECT_ROOT, "data");
const QUEUE_FILE = join(DATA_DIR, "scheduled-messages.json");

export interface ScheduledMessage {
  id: string;
  chatId: string;
  text: string;
  sendAt: number; // Unix timestamp (ms)
  createdAt: number;
}

let queue: ScheduledMessage[] = [];

function persist(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (err) {
    warn("scheduled", `Failed to persist queue: ${err}`);
  }
}

function load(): void {
  try {
    if (existsSync(QUEUE_FILE)) {
      queue = JSON.parse(readFileSync(QUEUE_FILE, "utf-8"));
    }
  } catch {
    queue = [];
  }
}

// Load on import
load();

/**
 * Schedule a message to be sent at a specific time.
 * Returns the scheduled message ID for cancellation.
 */
export function scheduleMessage(
  chatId: string,
  text: string,
  sendAt: Date | number
): string {
  const id = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sendAtMs = sendAt instanceof Date ? sendAt.getTime() : sendAt;

  queue.push({
    id,
    chatId,
    text,
    sendAt: sendAtMs,
    createdAt: Date.now(),
  });

  persist();
  info("scheduled", `Queued message "${text.substring(0, 50)}..." for ${new Date(sendAtMs).toLocaleString("en-US", { timeZone: "America/Phoenix" })}`);
  return id;
}

/**
 * Cancel a scheduled message by ID.
 * Returns true if found and removed.
 */
export function cancelScheduled(id: string): boolean {
  const before = queue.length;
  queue = queue.filter((m) => m.id !== id);
  if (queue.length < before) {
    persist();
    return true;
  }
  return false;
}

/**
 * Get all pending scheduled messages.
 */
export function getPendingScheduled(): ScheduledMessage[] {
  return [...queue];
}

/**
 * Parse tag parameters (key=value | key=value format, same as google.ts).
 */
function parseTagParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  const parts = raw.split("|").map((s) => s.trim());
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      params[part.substring(0, eq).trim().toLowerCase()] = part.substring(eq + 1).trim();
    }
  }
  return params;
}

/**
 * Parse a date/time string in Arizona time and return a Unix timestamp.
 * Accepts: "YYYY-MM-DD HH:MM", "HH:MM" (assumes today), or "+Xm"/"+Xh" relative.
 */
function parseSendAt(timeStr: string): number | null {
  const trimmed = timeStr.trim();

  // Relative: "+30m", "+2h", "+1h30m"
  const relMatch = trimmed.match(/^\+(?:(\d+)h)?(?:(\d+)m)?$/i);
  if (relMatch) {
    const hours = parseInt(relMatch[1] || "0", 10);
    const mins = parseInt(relMatch[2] || "0", 10);
    if (hours === 0 && mins === 0) return null;
    return Date.now() + (hours * 3600_000) + (mins * 60_000);
  }

  // Absolute: "YYYY-MM-DD HH:MM" or "HH:MM" (assumes today in Phoenix)
  const fullMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (fullMatch) {
    // Parse as MST (UTC-7, Arizona never observes DST)
    const [, dateStr, h, m] = fullMatch;
    const utcMs = new Date(`${dateStr}T${h.padStart(2, "0")}:${m}:00-07:00`).getTime();
    return isNaN(utcMs) ? null : utcMs;
  }

  const shortMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (shortMatch) {
    const now = new Date();
    const todayStr = now.toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });
    const [, h, m] = shortMatch;
    const utcMs = new Date(`${todayStr}T${h.padStart(2, "0")}:${m}:00-07:00`).getTime();
    if (isNaN(utcMs)) return null;
    // If time already passed today, assume tomorrow
    return utcMs <= Date.now() ? utcMs + 86400_000 : utcMs;
  }

  return null;
}

/**
 * Process [SCHEDULE:] tags in Claude's response.
 * Tag format: [SCHEDULE: chatId=X | time=YYYY-MM-DD HH:MM | text=Message body]
 * Or simpler: [SCHEDULE: time=HH:MM | text=Message body] (uses default chatId)
 * Or relative: [SCHEDULE: time=+30m | text=Reminder text]
 *
 * Strips matched tags from the response.
 */
export function processScheduleIntents(response: string, defaultChatId: string): string {
  let clean = response;

  for (const match of response.matchAll(/\[SCHEDULE:\s*([\s\S]+?)\]/gi)) {
    const params = parseTagParams(match[1]);
    const chatId = params.chatid || params.chat_id || defaultChatId;
    const text = params.text || params.message || params.msg;
    const timeStr = params.time || params.at || params.when;

    if (!text || !timeStr) {
      warn("scheduled", `Malformed SCHEDULE tag (missing ${!text ? "text" : "time"}): ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    const sendAt = parseSendAt(timeStr);
    if (!sendAt) {
      warn("scheduled", `Could not parse time "${timeStr}" in SCHEDULE tag`);
      clean = clean.replace(match[0], "");
      continue;
    }

    scheduleMessage(chatId, text, sendAt);
    clean = clean.replace(match[0], "");
  }

  return clean;
}

/**
 * Check for due messages and send them.
 * Called every minute by cron.
 * Returns the number of messages sent.
 */
export async function checkScheduledMessages(
  sendFn: (chatId: string, text: string) => Promise<void>
): Promise<number> {
  if (queue.length === 0) return 0;

  const now = Date.now();
  const due = queue.filter((m) => m.sendAt <= now);

  if (due.length === 0) return 0;

  let sent = 0;
  const sentIds: string[] = [];

  for (const msg of due) {
    try {
      await sendFn(msg.chatId, msg.text);
      sentIds.push(msg.id);
      sent++;
      info("scheduled", `Sent scheduled message ${msg.id}: "${msg.text.substring(0, 50)}..."`);
    } catch (err) {
      warn("scheduled", `Failed to send ${msg.id}: ${err}`);
    }
  }

  queue = queue.filter((m) => !sentIds.includes(m.id));
  persist();

  return sent;
}
