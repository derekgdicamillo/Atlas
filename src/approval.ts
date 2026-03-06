/**
 * Atlas — Approval Queue System
 *
 * Manages the content_queue lifecycle for autonomous business operations.
 * Sends items to Telegram with inline keyboard buttons (Approve/Edit/Reject).
 * Integrates with trust gradient to determine whether items need approval.
 *
 * Flow: content generated -> trust check -> draft? send to Telegram for approval
 *                                        -> auto_notify? post + notify
 *                                        -> full_auto? post silently
 */

import { info, warn, error as logError } from "./logger.ts";
import { getPermissionLevel, type PermissionLevel } from "./trust.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bot } from "grammy";

// ============================================================
// TYPES
// ============================================================

export interface ContentQueueItem {
  id?: number;
  business: string;
  platform: string;
  content_type: string;
  title?: string;
  body: string;
  image_url?: string;
  image_data?: Record<string, unknown>;
  hashtags?: string[];
  link_url?: string;
  status?: string;
  scheduled_for?: string;
  metadata?: Record<string, unknown>;
}

interface QueueRow extends ContentQueueItem {
  id: number;
  status: string;
  created_at: string;
  updated_at: string;
  posted_at?: string;
  external_id?: string;
  approval_note?: string;
}

// ============================================================
// STATE
// ============================================================

let supabase: SupabaseClient | null = null;
let bot: Bot | null = null;
let threadId: number | null = null;
let notifyChatId: string = "";

// ============================================================
// INIT
// ============================================================

/**
 * Initialize the approval queue with Supabase client, Telegram bot, and thread ID.
 */
export function initApproval(
  client: SupabaseClient,
  telegramBot: Bot,
  chatId: string,
  toxThreadId?: number,
): void {
  supabase = client;
  bot = telegramBot;
  notifyChatId = chatId;
  threadId = toxThreadId || null;
  info("approval", `Approval queue initialized (thread: ${threadId || "main chat"})`);
}

export function isApprovalReady(): boolean {
  return !!supabase && !!bot && !!notifyChatId;
}

// ============================================================
// QUEUE MANAGEMENT
// ============================================================

/**
 * Add an item to the content queue.
 * Checks trust level to determine initial status:
 * - draft: status = 'pending_approval', sends Telegram approval request
 * - auto_notify: status = 'approved', sends Telegram notification
 * - full_auto: status = 'approved', silent
 *
 * Returns the queue item ID.
 */
export async function submitContent(item: ContentQueueItem): Promise<number> {
  if (!supabase) throw new Error("Approval queue not initialized");

  const trustLevel = await getPermissionLevel(item.business, "social_post");
  const status = trustLevel === "draft" ? "pending_approval" : "approved";

  const { data, error } = await supabase
    .from("content_queue")
    .insert({
      business: item.business,
      platform: item.platform,
      content_type: item.content_type,
      title: item.title || null,
      body: item.body,
      image_url: item.image_url || null,
      image_data: item.image_data || {},
      hashtags: item.hashtags || [],
      link_url: item.link_url || null,
      status,
      scheduled_for: item.scheduled_for || null,
      metadata: item.metadata || {},
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to insert content queue item: ${error?.message || "no data returned"}`);
  }

  const queueId = data.id;
  info("approval", `Content queued: #${queueId} [${item.platform}/${item.content_type}] status=${status}`);

  // Send to Telegram based on trust level
  if (trustLevel === "draft") {
    await sendApprovalRequest(queueId, item);
  } else if (trustLevel === "auto_notify") {
    await sendNotification(queueId, item, "auto-approved");
  }

  return queueId;
}

/**
 * Get items ready for posting (approved + scheduled time reached).
 */
export async function getReadyToPost(platform?: string): Promise<QueueRow[]> {
  if (!supabase) return [];

  let query = supabase
    .from("content_queue")
    .select("*")
    .eq("status", "approved")
    .or(`scheduled_for.is.null,scheduled_for.lte.${new Date().toISOString()}`);

  if (platform) {
    query = query.eq("platform", platform);
  }

  const { data, error } = await query.order("created_at", { ascending: true });

  if (error) {
    warn("approval", `Failed to fetch ready items: ${error.message}`);
    return [];
  }

  return (data as QueueRow[]) || [];
}

/**
 * Get pending approval items.
 */
export async function getPendingApproval(business = "tox_tray"): Promise<QueueRow[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("content_queue")
    .select("*")
    .eq("business", business)
    .eq("status", "pending_approval")
    .order("created_at", { ascending: true });

  if (error) {
    warn("approval", `Failed to fetch pending items: ${error.message}`);
    return [];
  }

  return (data as QueueRow[]) || [];
}

/**
 * Mark an item as posted with the external platform ID.
 */
export async function markPosted(queueId: number, externalId: string): Promise<void> {
  if (!supabase) return;

  const { error } = await supabase
    .from("content_queue")
    .update({
      status: "posted",
      external_id: externalId,
      posted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueId);

  if (error) {
    logError("approval", `Failed to mark posted: ${error.message}`);
    return;
  }

  info("approval", `#${queueId} marked as posted (external: ${externalId})`);
}

/**
 * Mark an item as failed.
 */
export async function markFailed(queueId: number, errorMsg: string): Promise<void> {
  if (!supabase) return;

  const { error } = await supabase
    .from("content_queue")
    .update({
      status: "failed",
      approval_note: errorMsg.substring(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueId);

  if (error) {
    logError("approval", `Failed to mark failed: ${error.message}`);
  }
}

/**
 * Approve an item (changes status from pending_approval to approved).
 */
export async function approveItem(queueId: number): Promise<boolean> {
  if (!supabase) return false;

  const { error } = await supabase
    .from("content_queue")
    .update({
      status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueId)
    .eq("status", "pending_approval");

  if (error) {
    logError("approval", `Failed to approve #${queueId}: ${error.message}`);
    return false;
  }

  info("approval", `#${queueId} approved`);
  return true;
}

/**
 * Reject an item with optional note.
 */
export async function rejectItem(queueId: number, note?: string): Promise<boolean> {
  if (!supabase) return false;

  const { error } = await supabase
    .from("content_queue")
    .update({
      status: "rejected",
      approval_note: note || "Rejected by user",
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueId)
    .eq("status", "pending_approval");

  if (error) {
    logError("approval", `Failed to reject #${queueId}: ${error.message}`);
    return false;
  }

  info("approval", `#${queueId} rejected${note ? `: ${note}` : ""}`);
  return true;
}

// ============================================================
// TELEGRAM INTEGRATION
// ============================================================

const PLATFORM_EMOJI: Record<string, string> = {
  pinterest: "P",
  instagram: "IG",
  facebook: "FB",
  tiktok: "TT",
  etsy: "Etsy",
};

/**
 * Send an approval request to the Telegram tox tray thread.
 * Includes inline keyboard with Approve/Reject buttons.
 */
async function sendApprovalRequest(queueId: number, item: ContentQueueItem): Promise<void> {
  if (!bot || !notifyChatId) return;

  const platformLabel = PLATFORM_EMOJI[item.platform] || item.platform;
  const preview = item.body.length > 300 ? item.body.substring(0, 297) + "..." : item.body;
  const titleLine = item.title ? `*${escapeMarkdown(item.title)}*\n` : "";
  const hashtagLine = item.hashtags?.length ? `\nTags: ${item.hashtags.slice(0, 5).join(", ")}` : "";
  const scheduleLine = item.scheduled_for ? `\nScheduled: ${item.scheduled_for}` : "";

  const text = [
    `[${platformLabel}] Content for approval (#${queueId})`,
    "",
    titleLine + escapeMarkdown(preview) + hashtagLine + scheduleLine,
  ].join("\n");

  try {
    await bot.api.sendMessage(notifyChatId, text, {
      message_thread_id: threadId || undefined,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: `tox_approve:${queueId}` },
            { text: "Reject", callback_data: `tox_reject:${queueId}` },
          ],
        ],
      },
    });
  } catch (err) {
    logError("approval", `Failed to send approval request for #${queueId}: ${err}`);
  }
}

/**
 * Send a notification (for auto_notify trust level).
 */
async function sendNotification(queueId: number, item: ContentQueueItem, action: string): Promise<void> {
  if (!bot || !notifyChatId) return;

  const platformLabel = PLATFORM_EMOJI[item.platform] || item.platform;
  const preview = item.body.length > 150 ? item.body.substring(0, 147) + "..." : item.body;

  const text = `[${platformLabel}] #${queueId} ${action}: ${escapeMarkdown(preview)}`;

  try {
    await bot.api.sendMessage(notifyChatId, text, {
      message_thread_id: threadId || undefined,
      parse_mode: "Markdown",
    });
  } catch (err) {
    warn("approval", `Failed to send notification for #${queueId}: ${err}`);
  }
}

/**
 * Send a post confirmation after successful posting.
 */
export async function sendPostConfirmation(queueId: number, platform: string, url: string): Promise<void> {
  if (!bot || !notifyChatId) return;

  const platformLabel = PLATFORM_EMOJI[platform] || platform;
  const text = `[${platformLabel}] #${queueId} posted: ${url}`;

  try {
    await bot.api.sendMessage(notifyChatId, text, {
      message_thread_id: threadId || undefined,
    });
  } catch (err) {
    warn("approval", `Failed to send post confirmation: ${err}`);
  }
}

/**
 * Handle callback query from Telegram inline keyboard.
 * Call this from the bot's callback_query handler.
 *
 * Returns true if this callback was handled (tox_approve/tox_reject).
 */
export async function handleApprovalCallback(
  callbackData: string,
  answerCallback: (text: string) => Promise<void>,
): Promise<boolean> {
  // tox_approve:123 or tox_reject:123
  const approveMatch = callbackData.match(/^tox_approve:(\d+)$/);
  if (approveMatch) {
    const queueId = parseInt(approveMatch[1], 10);
    const success = await approveItem(queueId);
    await answerCallback(success ? `#${queueId} approved` : `#${queueId} approval failed`);
    return true;
  }

  const rejectMatch = callbackData.match(/^tox_reject:(\d+)$/);
  if (rejectMatch) {
    const queueId = parseInt(rejectMatch[1], 10);
    const success = await rejectItem(queueId);
    await answerCallback(success ? `#${queueId} rejected` : `#${queueId} rejection failed`);
    return true;
  }

  return false;
}

// ============================================================
// HELPERS
// ============================================================

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

// ============================================================
// CONTEXT
// ============================================================

/**
 * Summary for buildPrompt() context injection.
 */
export async function getApprovalContext(business = "tox_tray"): Promise<string> {
  if (!supabase) return "";

  try {
    // Count items by status
    const { data: counts } = await supabase
      .from("content_queue")
      .select("status")
      .eq("business", business);

    if (!counts || counts.length === 0) return "";

    const statusCounts: Record<string, number> = {};
    for (const row of counts) {
      statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
    }

    const parts = Object.entries(statusCounts)
      .map(([status, count]) => `${status}: ${count}`)
      .join(", ");

    return `CONTENT QUEUE (${business}): ${parts}`;
  } catch (err) {
    warn("approval", `Context fetch failed: ${err}`);
    return "";
  }
}
