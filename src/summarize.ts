/**
 * Atlas -- Conversation Summarization
 *
 * Periodically compresses old messages into summaries to reduce noise
 * in semantic search results. Recent messages (< 48h) stay raw.
 * Older messages get summarized in batches of 50 via Haiku.
 *
 * Summaries are stored in the summaries table and automatically
 * embedded via the same webhook pipeline as messages/memory.
 *
 * Called from cron.ts on a nightly schedule.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn, error as logError } from "./logger.ts";

const BATCH_SIZE = 50;       // messages per summary
const MAX_BATCHES = 5;       // max batches per run (250 messages/night)
const AGE_THRESHOLD_HOURS = 48; // only summarize messages older than this

// ============================================================
// TYPES
// ============================================================

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

// ============================================================
// CORE
// ============================================================

/**
 * Run one summarization cycle. Finds old unsummarized messages,
 * groups them into batches, summarizes each batch via a callback,
 * and stores the summaries in Supabase.
 *
 * @param supabase  Supabase client
 * @param summarize Callback that takes message text and returns a summary.
 *                  In practice this calls runPrompt() with haiku.
 * @returns Number of summaries created.
 */
export async function runSummarization(
  supabase: SupabaseClient,
  summarize: (text: string) => Promise<string>
): Promise<number> {
  let summariesCreated = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const messages = await getUnsummarizedBatch(supabase);
    if (!messages.length) {
      info("summarize", `No more messages to summarize (batch ${batch})`);
      break;
    }

    info("summarize", `Summarizing batch ${batch + 1}: ${messages.length} messages`);

    // Format messages for the summarizer
    const formattedText = messages
      .map((m) => {
        const time = new Date(m.created_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        const role = m.role === "user" ? "User" : "Atlas";
        return `[${time}] ${role}: ${m.content}`;
      })
      .join("\n");

    const prompt =
      "Summarize this conversation excerpt in 2-3 sentences. " +
      "Focus on key topics discussed, decisions made, and any action items. " +
      "Be factual and concise.\n\n" +
      formattedText;

    try {
      const summary = await summarize(prompt);
      if (!summary) {
        warn("summarize", `Empty summary for batch ${batch + 1}, skipping`);
        continue;
      }

      await saveSummary(supabase, {
        content: summary,
        messageIds: messages.map((m) => m.id),
        periodStart: messages[0].created_at,
        periodEnd: messages[messages.length - 1].created_at,
        messageCount: messages.length,
      });

      summariesCreated++;
      info("summarize", `Created summary for ${messages.length} messages`);
    } catch (err) {
      logError("summarize", `Batch ${batch + 1} failed: ${err}`);
    }
  }

  return summariesCreated;
}

// ============================================================
// DATABASE OPERATIONS
// ============================================================

/**
 * Get a batch of old messages that haven't been summarized yet.
 * "Unsummarized" = message ID not in any summary's source_message_ids.
 */
async function getUnsummarizedBatch(
  supabase: SupabaseClient
): Promise<MessageRow[]> {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - AGE_THRESHOLD_HOURS);

  try {
    // Get all message IDs that have already been summarized
    const { data: existingSummaries } = await supabase
      .from("summaries")
      .select("source_message_ids");

    const summarizedIds = new Set<string>();
    if (existingSummaries) {
      for (const s of existingSummaries) {
        if (s.source_message_ids) {
          for (const id of s.source_message_ids) {
            summarizedIds.add(id);
          }
        }
      }
    }

    // Get old messages, ordered chronologically
    const { data: messages, error } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .lt("created_at", cutoff.toISOString())
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE * 2); // fetch extra to filter

    if (error || !messages?.length) return [];

    // Filter out already-summarized messages
    const unsummarized = messages.filter((m: MessageRow) => !summarizedIds.has(m.id));

    return unsummarized.slice(0, BATCH_SIZE);
  } catch (err) {
    logError("summarize", `Failed to fetch unsummarized batch: ${err}`);
    return [];
  }
}

/**
 * Store a summary in the summaries table.
 * Embedding is generated automatically via the webhook pipeline.
 */
async function saveSummary(
  supabase: SupabaseClient,
  data: {
    content: string;
    messageIds: string[];
    periodStart: string;
    periodEnd: string;
    messageCount: number;
  }
): Promise<void> {
  const { error } = await supabase.from("summaries").insert({
    content: data.content,
    source_message_ids: data.messageIds,
    period_start: data.periodStart,
    period_end: data.periodEnd,
    message_count: data.messageCount,
  });

  if (error) {
    throw new Error(`Failed to save summary: ${error.message}`);
  }
}
