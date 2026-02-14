/**
 * Atlas — Write-Ahead Delivery Queue
 *
 * Persists outbound Telegram replies to disk before sending, so if
 * the process crashes mid-delivery we can drain unsent messages on
 * restart. Stale entries (>1hr old) are skipped to avoid replaying
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
