/**
 * Atlas — Telegram Streaming Delivery
 *
 * Progressive response delivery via Telegram editMessageText.
 * Sends a placeholder message, then edits it as text deltas arrive.
 * Handles multi-message splitting when text exceeds Telegram's 4096 char limit.
 *
 * Rate-limited to 1 edit per STREAMING_EDIT_INTERVAL_MS (Telegram rate limit safety).
 *
 * 2026-07-01 rework: message content is derived from a single `accumulated`
 * buffer plus a `flushedUpTo` boundary index instead of a separate
 * per-message string. The old design reset `currentMessageText = ""` after
 * async awaits inside startNewMessage(), silently dropping any deltas that
 * arrived during the rollover — the source of the mid-sentence truncations
 * documented repeatedly in behavioral-fixes.md (06-02, 06-07 through 06-09,
 * 06-15, 06-28). With boundary indexing, a delta can never be lost: it lands
 * in `accumulated` and is owned by whichever message the boundary assigns it to.
 */

import { STREAMING_EDIT_INTERVAL_MS, STREAMING_FAST_EDIT_INTERVAL_MS, STREAMING_CHUNK_THRESHOLD, SENTINEL_TAG_PATTERNS } from "./constants.ts";
import { info, warn } from "./logger.ts";

/** Telegram's hard per-message limit. */
export const TELEGRAM_HARD_LIMIT = 4096;

interface StreamingContext {
  /** Grammy ctx.api or equivalent — needs sendMessage and editMessageText */
  api: {
    sendMessage(chatId: number | string, text: string): Promise<{ message_id: number }>;
    editMessageText(chatId: number | string, messageId: number, text: string): Promise<void>;
  };
  chatId: number | string;
}

export interface StreamingSession {
  /** Feed a text delta from Claude's stream */
  onDelta(text: string): void;
  /** Finalize streaming: send final edit with complete text. Returns all message IDs used. */
  finish(): Promise<number[]>;
  /** All Telegram message IDs used by this streaming session */
  messageIds: number[];
  /** Whether any text was streamed */
  hasContent: boolean;
}

/**
 * Strip sentinel tags from streaming text (same patterns as relay.ts stripSentinels).
 * Applied on every edit so users never see internal tags mid-stream.
 */
function stripSentinelsFromStream(text: string): string {
  let result = text;
  for (const pattern of SENTINEL_TAG_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "");
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Check if text ends inside an unclosed code block.
 * We defer edits while inside code blocks to prevent broken formatting.
 */
function isInsideCodeBlock(text: string): boolean {
  const fenceCount = (text.match(/```/g) || []).length;
  return fenceCount % 2 !== 0;
}

/**
 * Find where to split `text` so the first piece fits in maxLen, preferring
 * paragraph > line > word boundaries. Returns text.length when it fits whole.
 */
export function findSplitIndex(text: string, maxLen: number): number {
  if (text.length <= maxLen) return text.length;
  let i = text.lastIndexOf("\n\n", maxLen);
  if (i <= 0) i = text.lastIndexOf("\n", maxLen);
  if (i <= 0) i = text.lastIndexOf(" ", maxLen);
  if (i <= 0) i = maxLen;
  return i;
}

/**
 * Split a complete response into Telegram-sized chunks at natural boundaries.
 * Shared by sendResponse (batch path) and the streaming final reconciliation
 * so both paths chunk identically.
 */
export function splitForTelegram(text: string, maxLen = 4000): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const at = findSplitIndex(remaining, maxLen);
    chunks.push(remaining.substring(0, at).trimEnd());
    remaining = remaining.substring(at).trimStart();
  }
  return chunks.length > 0 ? chunks : [""];
}

export function createStreamingSession(ctx: StreamingContext): StreamingSession {
  let accumulated = "";
  /** Index into `accumulated` where the current (last) message's text begins. */
  let flushedUpTo = 0;
  let currentMessageId: number | null = null;
  const messageIds: number[] = [];
  let lastEditAt = 0;
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEdit = false;
  let hasContent = false;
  /** True while the first placeholder or a rollover is being created. */
  let transitioning = false;

  function currentText(): string {
    return accumulated.slice(flushedUpTo);
  }

  async function sendEdit(): Promise<void> {
    if (!currentMessageId) return;

    const clean = stripSentinelsFromStream(currentText()).slice(0, TELEGRAM_HARD_LIMIT);
    if (!clean || !clean.trim()) return;

    try {
      await ctx.api.editMessageText(ctx.chatId, currentMessageId, clean);
      lastEditAt = Date.now();
    } catch (err: any) {
      // Telegram returns 400 if message content hasn't changed — ignore
      if (err?.error_code !== 400) {
        warn("streaming", `Edit failed for message ${currentMessageId}: ${err?.message || err}`);
      }
    }
  }

  function scheduleEdit(): void {
    if (editTimer) return; // already scheduled

    // Adaptive interval: faster edits for short messages, standard for long ones
    const interval = currentText().length < 500
      ? STREAMING_FAST_EDIT_INTERVAL_MS
      : STREAMING_EDIT_INTERVAL_MS;
    const elapsed = Date.now() - lastEditAt;
    const delay = Math.max(0, interval - elapsed);

    editTimer = setTimeout(async () => {
      editTimer = null;
      if (pendingEdit && !transitioning) {
        pendingEdit = false;
        await sendEdit();
      }
    }, delay);
  }

  /** Create the first placeholder message. */
  async function startFirstMessage(): Promise<void> {
    try {
      const msg = await ctx.api.sendMessage(ctx.chatId, "...");
      currentMessageId = msg.message_id;
      messageIds.push(currentMessageId);
      lastEditAt = 0; // allow immediate first edit
    } catch (err) {
      warn("streaming", `Failed to send streaming placeholder: ${err}`);
    } finally {
      transitioning = false;
      pendingEdit = false;
      await sendEdit(); // user sees text in <1s; includes deltas that arrived mid-create
    }
  }

  /**
   * Roll the stream over to a new Telegram message. The boundary is computed
   * from the CURRENT buffer state; deltas that arrive during the awaits keep
   * appending to `accumulated` and are owned by the new message. Nothing is
   * ever discarded.
   */
  async function rollover(): Promise<void> {
    try {
      const text = currentText();
      const splitAt = findSplitIndex(text, STREAMING_CHUNK_THRESHOLD);
      const finalizeText = stripSentinelsFromStream(text.slice(0, splitAt));

      if (currentMessageId && finalizeText) {
        try {
          await ctx.api.editMessageText(
            ctx.chatId,
            currentMessageId,
            finalizeText.slice(0, TELEGRAM_HARD_LIMIT)
          );
        } catch (err: any) {
          if (err?.error_code !== 400) {
            warn("streaming", `Rollover finalize failed for message ${currentMessageId}: ${err?.message || err}`);
          }
        }
      }

      flushedUpTo += splitAt;

      const msg = await ctx.api.sendMessage(ctx.chatId, "...");
      currentMessageId = msg.message_id;
      messageIds.push(currentMessageId);
      lastEditAt = 0;
    } catch (err) {
      warn("streaming", `Rollover failed: ${err}`);
    } finally {
      transitioning = false;
      if (pendingEdit) {
        pendingEdit = false;
        await sendEdit();
      }
    }
  }

  return {
    messageIds,
    get hasContent() { return hasContent; },

    onDelta(text: string): void {
      accumulated += text;
      hasContent = true;

      // First delta: send placeholder + immediate first edit.
      if (!currentMessageId && !transitioning) {
        transitioning = true;
        startFirstMessage().catch(() => { transitioning = false; });
        return;
      }

      // A placeholder/rollover is in flight: just accumulate, flush after.
      if (transitioning) {
        pendingEdit = true;
        return;
      }

      // Compute once per delta: slice + fence-count on every branch adds up
      // over thousands of deltas on long responses.
      const pendingText = currentText();
      const inCodeBlock = isInsideCodeBlock(pendingText);

      // Multi-message: current message full and not mid-code-block → rollover
      if (pendingText.length > STREAMING_CHUNK_THRESHOLD && !inCodeBlock) {
        transitioning = true;
        rollover().catch(() => { transitioning = false; });
        return;
      }

      // Defer edits while inside unclosed code blocks (prevents broken formatting)
      if (inCodeBlock) {
        pendingEdit = true;
        return;
      }

      // Schedule a rate-limited edit
      pendingEdit = true;
      scheduleEdit();
    },

    async finish(): Promise<number[]> {
      // Clear any pending timer
      if (editTimer) {
        clearTimeout(editTimer);
        editTimer = null;
      }

      // If no message was ever sent, nothing to finalize
      if (messageIds.length === 0) return [];

      // Wait out any in-flight placeholder/rollover (bounded)
      for (let i = 0; i < 100 && transitioning; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // If the tail is still oversized (finish arrived before a rollover
      // could fire), keep rolling until the remainder fits one message.
      // Iteration cap: a rollover whose sendMessage fails still advances
      // flushedUpTo, but cap defensively so a pathological state can never
      // spin forever (10 rollovers = 40K+ chars, far beyond any real turn).
      for (let i = 0; i < 10 && currentText().length > TELEGRAM_HARD_LIMIT; i++) {
        transitioning = true;
        await rollover();
      }

      // Final edit with complete remaining text
      await sendEdit();

      return [...messageIds];
    },
  };
}
