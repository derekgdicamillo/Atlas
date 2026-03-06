/**
 * Atlas — Telegram Streaming Delivery
 *
 * Progressive response delivery via Telegram editMessageText.
 * Sends a placeholder message, then edits it as text deltas arrive.
 * Handles multi-message splitting when text exceeds Telegram's 4096 char limit.
 *
 * Rate-limited to 1 edit per STREAMING_EDIT_INTERVAL_MS (Telegram rate limit safety).
 */

import { STREAMING_EDIT_INTERVAL_MS, STREAMING_CHUNK_THRESHOLD, SENTINEL_TAG_PATTERNS } from "./constants.ts";
import { info, warn } from "./logger.ts";

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

export function createStreamingSession(ctx: StreamingContext): StreamingSession {
  let accumulated = "";
  let currentMessageId: number | null = null;
  const messageIds: number[] = [];
  let lastEditAt = 0;
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEdit = false;
  let hasContent = false;

  // Current message's text (for multi-message: text of the current message only)
  let currentMessageText = "";

  async function sendEdit(): Promise<void> {
    if (!currentMessageId) return;

    const clean = stripSentinelsFromStream(currentMessageText);
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

    const elapsed = Date.now() - lastEditAt;
    const delay = Math.max(0, STREAMING_EDIT_INTERVAL_MS - elapsed);

    editTimer = setTimeout(async () => {
      editTimer = null;
      if (pendingEdit) {
        pendingEdit = false;
        await sendEdit();
      }
    }, delay);
  }

  async function startNewMessage(): Promise<void> {
    // Finalize current message before starting a new one
    if (currentMessageId) {
      await sendEdit();
    }

    try {
      const msg = await ctx.api.sendMessage(ctx.chatId, "...");
      currentMessageId = msg.message_id;
      messageIds.push(currentMessageId);
      currentMessageText = "";
      lastEditAt = 0; // allow immediate first edit on new message
    } catch (err) {
      warn("streaming", `Failed to send streaming placeholder: ${err}`);
    }
  }

  return {
    messageIds,
    get hasContent() { return hasContent; },

    onDelta(text: string): void {
      accumulated += text;
      currentMessageText += text;
      hasContent = true;

      // Multi-message: if current message exceeds threshold and we're not mid-code-block
      if (currentMessageText.length > STREAMING_CHUNK_THRESHOLD && !isInsideCodeBlock(currentMessageText)) {
        // Fire-and-forget: start new message asynchronously
        const textToFinalize = currentMessageText;
        const msgId = currentMessageId;
        startNewMessage().catch(() => {});
        return;
      }

      // Defer edits while inside unclosed code blocks (prevents broken formatting)
      if (isInsideCodeBlock(currentMessageText)) {
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

      // Final edit with complete text
      await sendEdit();

      return [...messageIds];
    },
  };
}
