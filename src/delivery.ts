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
import { join, dirname } from "path";
import { info, warn } from "./logger.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const DATA_DIR = join(PROJECT_ROOT, "data");
const QUEUE_FILE = join(DATA_DIR, "pending_replies.json");
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

  // Announce mode: deliver via configured channel
  let lastError = "";
  for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
    try {
      switch (cfg.channel) {
        case "telegram":
          await sendViaTelegram(cfg.to, message);
          break;
        default:
          warn("delivery", `Unknown channel: ${cfg.channel}, falling back to telegram`);
          await sendViaTelegram(cfg.to, message);
      }
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

  // All retries exhausted
  if (cfg.onFailure === "notify") {
    // Try one last notification about the failure itself
    try {
      await sendViaTelegram(cfg.to, `[Delivery Failed] Could not deliver message after ${cfg.maxRetries} attempts: ${lastError.substring(0, 100)}`);
    } catch { /* give up */ }
  }

  return { success: false, attempts: cfg.maxRetries, error: lastError };
}

/** Send a message via Telegram Bot API (low-level). */
async function sendViaTelegram(chatId: string, text: string): Promise<void> {
  if (!BOT_TOKEN || !chatId) {
    throw new Error("Missing BOT_TOKEN or chatId");
  }
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
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
