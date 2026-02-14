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

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const CONVERSATIONS_DIR = join(PROJECT_ROOT, "data", "conversations");
const MAX_ENTRIES = 20;
const MAX_CONTENT_LENGTH = 500; // truncate ring buffer entries for context efficiency
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

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
  filePath?: string; // for photos/documents
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

  const lines = show.map((e) => {
    const time = formatTime(e.timestamp);
    const prefix = e.role === "user" ? "User" : e.role === "system" ? "System" : "Atlas";
    const typeTag = e.type && e.type !== "text" ? ` [${e.type}]` : "";
    return `[${time}] ${prefix}${typeTag}: ${e.content}`;
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

/** Push a message to the accumulator for a session. */
export function accumulate(key: string, msg: PendingMessage): void {
  if (!accumulators.has(key)) {
    accumulators.set(key, []);
  }
  accumulators.get(key)!.push(msg);
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
    const filePrefix = m.filePath ? `[File: ${m.filePath}]\n\n` : "";
    return `${filePrefix}User: ${m.text}`;
  }

  // Multiple messages accumulated while Claude was busy
  const lines = messages.map((m) => {
    const time = formatTime(m.timestamp);
    const typeTag = m.type !== "text" ? ` [${m.type}]` : "";
    const fileRef = m.filePath ? ` (file: ${m.filePath})` : "";
    return `[${time}]${typeTag} ${m.text}${fileRef}`;
  });

  return (
    "The user sent multiple messages while you were working. Read and address ALL of them:\n\n" +
    lines.join("\n")
  );
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
