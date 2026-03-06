/**
 * Atlas -- Write-Ahead Delivery Queue + Configurable Delivery
 *
 * Two layers:
 * 1. Write-Ahead Queue: Persists outbound Telegram replies to disk
 *    before sending, so if the process crashes mid-delivery we can
 *    drain unsent messages on restart.
 * 2. Delivery Configuration: Per-job/task delivery config specifying
 *    channel, format, failure handling, and retry policy.
 *
 * Stale WAQ entries (>1hr old) are skipped to avoid replaying
 * ancient messages after a long outage.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { info, warn } from "./logger.ts";
import { DELIVERY_MAX_BACKOFF_MS, DELIVERY_MIN_RETRY_INTERVAL_MS } from "./constants.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const DATA_DIR = join(PROJECT_ROOT, "data");
const QUEUE_FILE = join(DATA_DIR, "pending_replies.json");
const BACKOFF_FILE = join(DATA_DIR, "delivery-backoff.json");
const STALE_THRESHOLD_MS = 60 * 60_000; // 1 hour

interface PendingReply {
  id: string;
  chatId: string;
  text: string;
  enqueuedAt: number;
}

let queue: PendingReply[] = [];

async function persist(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (err) {
    warn("delivery", `Failed to persist queue: ${err}`);
  }
}

async function loadQueue(): Promise<void> {
  try {
    const raw = await readFile(QUEUE_FILE, "utf-8");
    queue = JSON.parse(raw);
  } catch {
    queue = [];
  }
}

/** Persist a reply before attempting delivery. Returns an ID for markDelivered(). */
export async function enqueueReply(chatId: string, text: string): Promise<string> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  queue.push({ id, chatId, text, enqueuedAt: Date.now() });
  await persist();
  return id;
}

/** Remove a successfully delivered reply from the queue. */
export async function markDelivered(id: string): Promise<void> {
  queue = queue.filter((r) => r.id !== id);
  await persist();
}

/** On startup, deliver any replies that were enqueued but never confirmed delivered. */
export async function drainPendingReplies(
  sendFn: (chatId: string, text: string) => Promise<void>
): Promise<void> {
  await loadQueue();

  if (queue.length === 0) return;

  const now = Date.now();
  const fresh: PendingReply[] = [];
  let stale = 0;

  for (const entry of queue) {
    if (now - entry.enqueuedAt > STALE_THRESHOLD_MS) {
      stale++;
      continue;
    }
    fresh.push(entry);
  }

  if (stale > 0) {
    info("delivery", `Discarded ${stale} stale pending replies (>1hr old)`);
  }

  if (fresh.length === 0) {
    queue = [];
    await persist();
    return;
  }

  info("delivery", `Draining ${fresh.length} pending replies from previous run`);

  const delivered: string[] = [];
  for (const entry of fresh) {
    try {
      await sendFn(entry.chatId, entry.text);
      delivered.push(entry.id);
      info("delivery", `Drained reply to ${entry.chatId} (${entry.text.substring(0, 60)}...)`);
    } catch (err) {
      warn("delivery", `Failed to drain reply ${entry.id}: ${err}`);
    }
  }

  queue = queue.filter((r) => !delivered.includes(r.id));
  await persist();
}

// ============================================================
// PERSISTENT BACKOFF (OpenClaw delivery recovery)
// ============================================================
// Tracks per-target delivery failure state across restarts.
// If Telegram is down for hours, we don't slam it on recovery.

interface BackoffState {
  /** Consecutive failure count */
  failures: number;
  /** Timestamp of last failed attempt */
  lastFailedAt: number;
  /** Current backoff interval in ms */
  backoffMs: number;
}

let backoffMap: Record<string, BackoffState> = {};

function loadBackoff(): void {
  try {
    if (existsSync(BACKOFF_FILE)) {
      backoffMap = JSON.parse(readFileSync(BACKOFF_FILE, "utf-8"));
    }
  } catch {
    backoffMap = {};
  }
}

function saveBackoff(): void {
  try {
    writeFileSync(BACKOFF_FILE, JSON.stringify(backoffMap, null, 2));
  } catch { /* non-critical */ }
}

/** Record a delivery failure for a target. Doubles backoff up to cap. */
export function recordDeliveryFailure(target: string): void {
  const existing = backoffMap[target] || { failures: 0, lastFailedAt: 0, backoffMs: DELIVERY_MIN_RETRY_INTERVAL_MS };
  existing.failures++;
  existing.lastFailedAt = Date.now();
  existing.backoffMs = Math.min(existing.backoffMs * 2, DELIVERY_MAX_BACKOFF_MS);
  backoffMap[target] = existing;
  saveBackoff();
}

/** Clear backoff state for a target after successful delivery. */
export function clearDeliveryBackoff(target: string): void {
  if (backoffMap[target]) {
    delete backoffMap[target];
    saveBackoff();
  }
}

/** Check if we should wait before retrying delivery to a target. Returns ms to wait, or 0. */
export function getDeliveryWaitMs(target: string): number {
  const state = backoffMap[target];
  if (!state) return 0;
  const elapsed = Date.now() - state.lastFailedAt;
  const remaining = state.backoffMs - elapsed;
  return remaining > 0 ? remaining : 0;
}

// Load persisted backoff state on module init
loadBackoff();

// ============================================================
// DELIVERY CONFIGURATION (OpenClaw gateway pattern)
// ============================================================

export type DeliveryMode = "announce" | "silent" | "log-only";
export type DeliveryChannel = "telegram";
export type FailureAction = "retry" | "silent" | "notify";

export interface DeliveryConfig {
  /** How to deliver: announce (send), silent (skip), log-only (write to log) */
  mode: DeliveryMode;
  /** Delivery channel (telegram for now, extensible to email later) */
  channel: DeliveryChannel;
  /** Chat ID or recipient identifier */
  to: string;
  /** Telegram topic thread ID for topic-based delivery */
  threadId?: number;
  /** Message format */
  format: "markdown" | "plain";
  /** What to do on delivery failure */
  onFailure: FailureAction;
  /** Max retry attempts before giving up */
  maxRetries: number;
}

/** Default delivery config: announce to Derek via Telegram */
const DEFAULT_CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

export const DEFAULT_DELIVERY: DeliveryConfig = {
  mode: "announce",
  channel: "telegram",
  to: DEFAULT_CHAT_ID,
  format: "plain",
  onFailure: "retry",
  maxRetries: 5,
};

/**
 * Unified delivery function.
 * Routes messages through the configured channel with retry and failure handling.
 */
export async function deliver(
  message: string,
  config: Partial<DeliveryConfig> = {}
): Promise<{ success: boolean; attempts: number; error?: string }> {
  const cfg: DeliveryConfig = { ...DEFAULT_DELIVERY, ...config };

  // Silent mode: skip delivery entirely
  if (cfg.mode === "silent") {
    return { success: true, attempts: 0 };
  }

  // Log-only mode: just log, don't send
  if (cfg.mode === "log-only") {
    info("delivery", `[log-only] ${message.substring(0, 200)}`);
    return { success: true, attempts: 0 };
  }

  // Persistent backoff check: if this target has been failing, wait before retrying
  const waitMs = getDeliveryWaitMs(cfg.to);
  if (waitMs > 0) {
    info("delivery", `Backoff active for ${cfg.to}: waiting ${Math.round(waitMs / 1000)}s before retry`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 10_000))); // cap per-call wait at 10s
  }

  // Announce mode: deliver via configured channel
  let lastError = "";
  for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
    try {
      switch (cfg.channel) {
        case "telegram":
          await sendViaTelegram(cfg.to, message, cfg.threadId);
          break;
        default:
          warn("delivery", `Unknown channel: ${cfg.channel}, falling back to telegram`);
          await sendViaTelegram(cfg.to, message, cfg.threadId);
      }
      // Success: clear any persisted backoff for this target
      clearDeliveryBackoff(cfg.to);
      return { success: true, attempts: attempt };
    } catch (err) {
      lastError = String(err);
      warn("delivery", `Delivery attempt ${attempt}/${cfg.maxRetries} failed: ${err}`);

      // Exponential backoff between retries (500ms, 1s, 2s, 4s, 8s)
      if (attempt < cfg.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt - 1)));
      }
    }
  }

  // All retries exhausted: persist backoff state for this target
  recordDeliveryFailure(cfg.to);

  // All retries exhausted
  if (cfg.onFailure === "notify") {
    // Try one last notification about the failure itself
    try {
      await sendViaTelegram(cfg.to, `[Delivery Failed] Could not deliver message after ${cfg.maxRetries} attempts: ${lastError.substring(0, 100)}`, cfg.threadId);
    } catch { /* give up */ }
  }

  return { success: false, attempts: cfg.maxRetries, error: lastError };
}

/**
 * Validate Telegram delivery target format.
 * Rejects invalid formats before making API calls (OpenClaw #21930).
 * Valid: numeric chat IDs, optionally negative (groups/supergroups).
 */
function isValidTelegramTarget(chatId: string): boolean {
  // Must be a numeric string, optionally with a leading minus for groups
  return /^-?\d{1,20}$/.test(chatId);
}

/** Send a message via Telegram Bot API (low-level). Supports topic threads. */
async function sendViaTelegram(chatId: string, text: string, threadId?: number): Promise<void> {
  if (!BOT_TOKEN || !chatId) {
    throw new Error("Missing BOT_TOKEN or chatId");
  }
  if (!isValidTelegramTarget(chatId)) {
    throw new Error(`Invalid Telegram chat ID format: "${chatId.substring(0, 30)}"`);
  }
  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (threadId) payload.message_thread_id = threadId;
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Telegram API error: ${response.status} ${response.statusText}`);
  }
}

/**
 * Merge a partial delivery config with defaults.
 * Useful for cron jobs and tasks that want to override specific fields.
 */
export function mergeDeliveryConfig(overrides: Partial<DeliveryConfig>): DeliveryConfig {
  return { ...DEFAULT_DELIVERY, ...overrides };
}
