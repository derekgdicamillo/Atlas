/**
 * Atlas — Conversation Memory System
 *
 * Two interlocking components:
 *
 * 1. Ring Buffer: Circular buffer of the last 20 conversation entries
 *    per session, persisted to disk. Injected into every prompt so Claude
 *    always sees recent turns regardless of what --resume provides.
 *
 * 2. Message Accumulator: When messages arrive while Claude is busy
 *    (session lock held), they accumulate here. When the lock is acquired,
 *    ALL pending messages are drained and combined into a single prompt.
 *
 * Together these guarantee: no user message is ever lost or ignored.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { info, warn } from "./logger.ts";
import { CONTEXT_PRUNE_AGE_ENTRIES, CONTEXT_PRUNE_MAX_CHARS, IMAGE_DEDUP_TAIL_KEEP, COMPACTION_BUDGET_THRESHOLD, COMPACTION_MIN_ENTRIES, DEFAULT_QUEUE_MODE, type QueueMode } from "./constants.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const CONVERSATIONS_DIR = join(PROJECT_ROOT, "data", "conversations");
const MAX_ENTRIES = 20;
const MAX_CONTENT_LENGTH = 500; // truncate ring buffer entries for context efficiency
const MAX_ACCUMULATOR_SIZE = 50; // cap pending messages per session to prevent memory spikes
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ============================================================
// COMPRESSION (Background conversation summarization)
// ============================================================

const COMPRESS_THRESHOLD = 10; // Only compress when buffer has more than this many entries
const RAW_TAIL_COUNT = 6;      // Always keep last 6 entries raw (uncompressed)

interface CompressedConversation {
  summary: string;
  coveredCount: number;  // How many entries the summary covers
  generatedAt: number;   // timestamp
}

// In-memory compression cache per session
const compressions: Map<string, CompressedConversation> = new Map();

/**
 * Compress older conversation entries into a summary.
 * Fire-and-forget after each assistant response (when buffer > COMPRESS_THRESHOLD).
 * The cached summary is used by formatForPrompt() to reduce token usage.
 *
 * @param key Session key
 * @param summarizeFn Function that takes a prompt and returns a summary string
 */
export async function compressOldEntries(
  key: string,
  summarizeFn: (prompt: string) => Promise<string>,
): Promise<void> {
  const entries = await loadBuffer(key);
  if (entries.length <= COMPRESS_THRESHOLD) return;

  // Split: old entries to compress, recent entries to keep raw
  const oldEntries = entries.slice(0, -RAW_TAIL_COUNT);
  const oldCount = oldEntries.length;

  // If we already have a compression covering the same count, skip
  const existing = compressions.get(key);
  if (existing && existing.coveredCount === oldCount) return;

  // Build the text to compress
  const text = oldEntries.map(e => {
    const prefix = e.role === "user" ? "User" : e.role === "system" ? "System" : "Atlas";
    return `${prefix}: ${e.content}`;
  }).join("\n");

  const prompt =
    "Compress this conversation into 2-3 dense sentences. " +
    "Preserve entity names, dates, decisions, action items, and emotional tone. " +
    "Do not add any preamble or explanation, just the compressed summary.\n\n" +
    text;

  const summary = await summarizeFn(prompt);
  if (!summary) return;

  compressions.set(key, {
    summary,
    coveredCount: oldCount,
    generatedAt: Date.now(),
  });
  info("conversation", `Compressed ${oldCount} entries for ${key} (${summary.length} chars)`);
}

// ============================================================
// TYPES
// ============================================================

export interface ConversationEntry {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string; // ISO 8601
  type?: "text" | "voice" | "photo" | "document";
}

export interface PendingMessage {
  text: string;
  type: "text" | "voice" | "photo" | "document";
  filePath?: string; // for photos/documents (backup on disk)
  imageBase64?: string; // base64-encoded image data for inline passing to Claude CLI
  imageMimeType?: string; // MIME type of the image (e.g. "image/jpeg")
  timestamp: string; // ISO 8601
}

// ============================================================
// RING BUFFER (per-session, persisted)
// ============================================================

const buffers: Map<string, ConversationEntry[]> = new Map();
let dirCreated = false;

async function ensureDir(): Promise<void> {
  if (dirCreated) return;
  await mkdir(CONVERSATIONS_DIR, { recursive: true });
  dirCreated = true;
}

function bufferFilePath(key: string): string {
  // Replace colons with dashes for filesystem safety
  const safeKey = key.replace(/:/g, "-");
  return join(CONVERSATIONS_DIR, `${safeKey}.json`);
}

async function loadBuffer(key: string): Promise<ConversationEntry[]> {
  if (buffers.has(key)) return buffers.get(key)!;
  try {
    const raw = await readFile(bufferFilePath(key), "utf-8");
    const entries: ConversationEntry[] = JSON.parse(raw);
    buffers.set(key, entries);
    return entries;
  } catch {
    const entries: ConversationEntry[] = [];
    buffers.set(key, entries);
    return entries;
  }
}

async function persistBuffer(key: string): Promise<void> {
  try {
    await ensureDir();
    const entries = buffers.get(key) || [];
    await writeFile(bufferFilePath(key), JSON.stringify(entries, null, 2));
  } catch (err) {
    warn("conversation", `Failed to persist buffer for ${key}: ${err}`);
  }
}

/** Add an entry to the ring buffer. Evicts oldest if over MAX_ENTRIES. */
export async function addEntry(key: string, entry: ConversationEntry): Promise<void> {
  const entries = await loadBuffer(key);

  // Truncate content for ring buffer storage (full text goes via accumulator)
  const stored: ConversationEntry = {
    ...entry,
    content: entry.content.length > MAX_CONTENT_LENGTH
      ? entry.content.substring(0, MAX_CONTENT_LENGTH) + "..."
      : entry.content,
  };

  entries.push(stored);

  // Evict oldest entries if over cap
  while (entries.length > MAX_ENTRIES) {
    entries.shift();
  }

  buffers.set(key, entries);

  // Invalidate compression if entry count changed significantly
  const cached = compressions.get(key);
  if (cached && entries.length - RAW_TAIL_COUNT !== cached.coveredCount) {
    compressions.delete(key);
  }

  await persistBuffer(key);
}

/** Get all entries in the ring buffer (most recent last). */
export async function getEntries(key: string): Promise<ConversationEntry[]> {
  return await loadBuffer(key);
}

/**
 * Format ring buffer entries for injection into Claude's prompt.
 * @param excludeLastN - Exclude the last N entries (used to avoid duplicating
 *   current-turn user messages that also appear in the accumulated messages section).
 */
export async function formatForPrompt(key: string, excludeLastN = 0): Promise<string> {
  const entries = await loadBuffer(key);
  const show = excludeLastN > 0 ? entries.slice(0, -excludeLastN) : entries;
  if (show.length === 0) return "";

  // Check if we have a valid compression for older entries
  const compression = compressions.get(key);
  if (compression && show.length > RAW_TAIL_COUNT) {
    // Use compressed summary for old entries + raw for recent
    const recentEntries = show.slice(-RAW_TAIL_COUNT);
    const recentLines = recentEntries.map((e, idx) => {
      const time = formatTime(e.timestamp);
      const prefix = e.role === "user" ? "User" : e.role === "system" ? "System" : "Atlas";
      const typeTag = e.type && e.type !== "text" ? ` [${e.type}]` : "";
      // Strip old photo entries even in recent tail
      let content = e.content;
      if (e.type === "photo" && idx < recentEntries.length - IMAGE_DEDUP_TAIL_KEEP) {
        content = "[image omitted]";
      }
      return `[${time}] ${prefix}${typeTag}: ${content}`;
    });

    return "RECENT CONVERSATION:\n[Earlier: " + compression.summary + "]\n\n" + recentLines.join("\n");
  }

  // No compression: format all entries with context window pruning
  const lines = show.map((e, idx) => {
    const time = formatTime(e.timestamp);
    const prefix = e.role === "user" ? "User" : e.role === "system" ? "System" : "Atlas";
    const typeTag = e.type && e.type !== "text" ? ` [${e.type}]` : "";

    // Context window pruning: aggressively truncate old entries
    const distFromEnd = show.length - idx;
    let content = e.content;

    // Strip old image/photo entries to save tokens (keep only recent N)
    if (e.type === "photo" && distFromEnd > IMAGE_DEDUP_TAIL_KEEP) {
      content = "[image omitted]";
    }
    // Truncate old entries that are far from the tail
    else if (distFromEnd > CONTEXT_PRUNE_AGE_ENTRIES && content.length > CONTEXT_PRUNE_MAX_CHARS) {
      content = content.substring(0, CONTEXT_PRUNE_MAX_CHARS) + "...";
    }

    return `[${time}] ${prefix}${typeTag}: ${content}`;
  });

  return "RECENT CONVERSATION:\n" + lines.join("\n");
}

/** Clear the ring buffer for a session (e.g., on /session reset). */
export async function clearBuffer(key: string): Promise<void> {
  buffers.set(key, []);
  await persistBuffer(key);
  info("conversation", `Buffer cleared for ${key}`);
}

// ============================================================
// MESSAGE ACCUMULATOR (in-memory, per-session)
// ============================================================

const accumulators: Map<string, PendingMessage[]> = new Map();

/** Push a message to the accumulator for a session. Drops oldest if cap exceeded. */
export function accumulate(key: string, msg: PendingMessage): void {
  if (!accumulators.has(key)) {
    accumulators.set(key, []);
  }
  const messages = accumulators.get(key)!;

  // Image token deduplication: if this message has inline image data,
  // check if the same image (by base64 prefix match) is already pending.
  // Prevents duplicate image injections from costing double tokens.
  if (msg.imageBase64 && messages.length > 0) {
    const prefix = msg.imageBase64.substring(0, 200);
    const duplicate = messages.find((m) => m.imageBase64?.substring(0, 200) === prefix);
    if (duplicate) {
      info("conversation", `Image dedup: skipping duplicate image in accumulator for ${key}`);
      // Still accumulate the text, just strip the duplicate image
      msg = { ...msg, imageBase64: undefined, imageMimeType: undefined };
    }
  }

  if (messages.length >= MAX_ACCUMULATOR_SIZE) {
    warn("conversation", `Accumulator full for ${key} (${MAX_ACCUMULATOR_SIZE}), dropping oldest message`);
    messages.shift();
  }
  messages.push(msg);
}

/** Drain all accumulated messages for a session. Returns them and clears the queue. */
export function drain(key: string): PendingMessage[] {
  const pending = accumulators.get(key) || [];
  accumulators.set(key, []);
  return pending;
}

/** Check if there are pending messages for a session. */
export function hasPending(key: string): boolean {
  const pending = accumulators.get(key);
  return !!pending && pending.length > 0;
}

/**
 * Format accumulated messages for the prompt.
 * Single message: just "User: <text>"
 * Multiple messages: labeled with timestamps and a header explaining the user sent multiple.
 */
export function formatAccumulated(messages: PendingMessage[]): string {
  if (messages.length === 0) return "";

  if (messages.length === 1) {
    const m = messages[0];
    // Skip file path prefix when image is being sent inline via base64
    const filePrefix = m.filePath && !m.imageBase64 ? `[File: ${m.filePath}]\n\n` : "";
    return `${filePrefix}User: ${m.text}`;
  }

  // Multiple messages accumulated while Claude was busy
  const lines = messages.map((m) => {
    const time = formatTime(m.timestamp);
    const typeTag = m.type !== "text" ? ` [${m.type}]` : "";
    // Skip file reference when image is being sent inline via base64
    const fileRef = m.filePath && !m.imageBase64 ? ` (file: ${m.filePath})` : "";
    return `[${time}]${typeTag} ${m.text}${fileRef}`;
  });

  return (
    "The user sent multiple messages while you were working. Read and address ALL of them:\n\n" +
    lines.join("\n")
  );
}

/**
 * Check if any pending messages contain inline image data.
 * Used by callClaude to decide whether to use stream-json input format.
 */
export function hasInlineImages(messages: PendingMessage[]): boolean {
  return messages.some((m) => !!m.imageBase64);
}

/**
 * Build Anthropic API-compatible content blocks for a set of pending messages.
 * Images are included as base64 image content blocks, text as text blocks.
 * Returns the content array for an SDKUserMessage.
 */
export function buildImageContentBlocks(messages: PendingMessage[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    // Add image block first (if present), then the text
    if (m.imageBase64 && m.imageMimeType) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: m.imageMimeType,
          data: m.imageBase64,
        },
      });
    }
    // Always add the text
    if (m.text) {
      content.push({
        type: "text",
        text: m.text,
      });
    }
  }

  return content;
}

// ============================================================
// HELPERS
// ============================================================

// ============================================================
// QUEUE MODE (OpenClaw collect/interrupt pattern)
// ============================================================

const queueModes = new Map<string, QueueMode>();

export function getQueueMode(key: string): QueueMode {
  return queueModes.get(key) || DEFAULT_QUEUE_MODE;
}

export function setQueueMode(key: string, mode: QueueMode): void {
  queueModes.set(key, mode);
  info("conversation", `Queue mode set to "${mode}" for ${key}`);
}

// ============================================================
// SESSION COMPACTION (OpenClaw budget-aware inline summarization)
// ============================================================

/**
 * Trigger inline compaction when conversation context exceeds the prompt budget threshold.
 * Unlike compressOldEntries() (fire-and-forget background), this runs synchronously during
 * prompt building and returns the compacted conversation string.
 *
 * @returns The compacted conversation string, or null if no compaction needed
 */
export async function compactIfNeeded(
  key: string,
  contextChars: number,
  budgetChars: number,
  summarizeFn: (text: string) => Promise<string>,
): Promise<string | null> {
  const entries = await loadBuffer(key);
  if (entries.length < COMPACTION_MIN_ENTRIES) return null;

  const ratio = contextChars / budgetChars;
  if (ratio < COMPACTION_BUDGET_THRESHOLD) return null;

  // Check if we already have a cached compression covering these entries
  const cached = compressions.get(key);
  const entriesOlderThanTail = entries.length - RAW_TAIL_COUNT;
  if (cached && cached.coveredCount >= entriesOlderThanTail) return null;

  info("conversation", `[compaction] Inline compaction for ${key} (ratio: ${(ratio * 100).toFixed(0)}%, ${entries.length} entries)`);
  await compressOldEntries(key, summarizeFn);

  return await formatForPrompt(key, 0);
}

// ============================================================
// HELPERS
// ============================================================

function formatTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleTimeString("en-US", {
      timeZone: USER_TIMEZONE,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return isoString;
  }
}
