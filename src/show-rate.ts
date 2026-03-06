/**
 * Atlas -- Show Rate Optimization Engine
 *
 * Automated appointment reminder cadence + no-show recovery to push
 * show rate from ~37% toward 65%+. Works alongside GHL's native
 * workflows by adding Atlas-level intelligence and tracking.
 *
 * Reminder cadence:
 *   - 72h before: confirmation request ("Are you still coming?")
 *   - 24h before: logistics reminder (address, prep instructions, what to expect)
 *   - 2h before:  final nudge ("See you soon!")
 *   - Post no-show: same-day recovery outreach (reschedule offer)
 *
 * Each reminder is:
 *   1. Tracked in data/show-rate-state.json to prevent duplicates
 *   2. Executed via GHL tags (workflow enrollment, contact notes, tasks)
 *   3. Logged so Derek has visibility into what went out
 *
 * Called every 15 min during business hours by cron job "appointment-reminders".
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { info, warn, error as logError } from "./logger.ts";
import {
  isGHLReady,
  getAppointments,
  getContact,
  addContactNote,
  createContactTask,
  addTagToContact,
  removeTagFromContact,
  type GHLAppointment,
} from "./ghl.ts";
import { emit as emitAlert } from "./alerts.ts";
import { instantiateWorkflow } from "./workflows.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// CONFIG
// ============================================================

const PROJECT_ROOT = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_ROOT, "data");
const STATE_FILE = join(DATA_DIR, "show-rate-state.json");
const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";

/** Hours before appointment for each reminder tier */
const REMINDER_TIERS = {
  confirm_72h: 72,
  remind_24h: 24,
  nudge_2h: 2,
} as const;

/** How soon after a no-show to trigger recovery outreach (hours) */
const NOSHOW_RECOVERY_DELAY_H = 1;

/** Tags applied to contacts at each stage for GHL workflow triggers */
const TAGS = {
  REMINDER_72H_SENT: "atlas-reminder-72h",
  REMINDER_24H_SENT: "atlas-reminder-24h",
  REMINDER_2H_SENT: "atlas-reminder-2h",
  NOSHOW_RECOVERY_SENT: "atlas-noshow-recovery",
  CONFIRMED: "atlas-appointment-confirmed",
} as const;

// ============================================================
// PERSISTENT STATE
// ============================================================

interface ReminderRecord {
  appointmentId: string;
  contactId: string;
  tier: string;       // "confirm_72h" | "remind_24h" | "nudge_2h" | "noshow_recovery"
  sentAt: string;     // ISO timestamp
}

interface ShowRateState {
  /** Reminders already sent (keyed by "appointmentId:tier") */
  sent: Record<string, ReminderRecord>;
  /** Daily stats for logging */
  dailyStats: Record<string, {
    reminders72h: number;
    reminders24h: number;
    reminders2h: number;
    noshowRecoveries: number;
    date: string;
  }>;
}

function loadState(): ShowRateState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    warn("show-rate", "Failed to load state, starting fresh");
  }
  return { sent: {}, dailyStats: {} };
}

function saveState(state: ShowRateState): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logError("show-rate", `Failed to save state: ${err}`);
  }
}

function stateKey(appointmentId: string, tier: string): string {
  return `${appointmentId}:${tier}`;
}

/** Prune sent records older than 14 days to prevent unbounded growth. */
function pruneOldRecords(state: ShowRateState): void {
  const cutoff = Date.now() - 14 * 24 * 3600_000;
  for (const [key, record] of Object.entries(state.sent)) {
    if (new Date(record.sentAt).getTime() < cutoff) {
      delete state.sent[key];
    }
  }

  // Prune daily stats older than 30 days
  const statsCutoff = new Date(Date.now() - 30 * 24 * 3600_000)
    .toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  for (const date of Object.keys(state.dailyStats)) {
    if (date < statsCutoff) {
      delete state.dailyStats[date];
    }
  }
}

// ============================================================
// HELPERS
// ============================================================

function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

function hoursUntil(isoTime: string): number {
  return (new Date(isoTime).getTime() - Date.now()) / 3600_000;
}

function hoursSince(isoTime: string): number {
  return (Date.now() - new Date(isoTime).getTime()) / 3600_000;
}

function incrementDailyStat(
  state: ShowRateState,
  field: "reminders72h" | "reminders24h" | "reminders2h" | "noshowRecoveries"
): void {
  const date = todayStr();
  if (!state.dailyStats[date]) {
    state.dailyStats[date] = {
      reminders72h: 0, reminders24h: 0, reminders2h: 0, noshowRecoveries: 0, date,
    };
  }
  state.dailyStats[date][field]++;
}

// ============================================================
// CORE: REMINDER CHECK
// ============================================================

export interface ReminderCheckResult {
  reminders72h: number;
  reminders24h: number;
  reminders2h: number;
  noshowRecoveries: number;
  errors: number;
}

/**
 * Main entry point: scan upcoming appointments and send reminders
 * for any that haven't been reminded yet at the appropriate tier.
 *
 * Called by cron every 15 minutes during business hours.
 */
export async function checkAppointmentReminders(
  supabase: SupabaseClient | null,
): Promise<ReminderCheckResult> {
  const result: ReminderCheckResult = {
    reminders72h: 0, reminders24h: 0, reminders2h: 0,
    noshowRecoveries: 0, errors: 0,
  };

  if (!isGHLReady()) return result;

  const state = loadState();
  pruneOldRecords(state);

  // Fetch appointments for next 4 days (covers 72h window + buffer)
  try {
    const appointments = await getAppointments({ days: 4 });
    if (appointments.length === 0) {
      saveState(state);
      return result;
    }

    for (const appt of appointments) {
      // Skip cancelled or already-completed appointments
      const status = (appt.appointmentStatus || "").toLowerCase();
      if (status === "cancelled" || status === "canceled") continue;

      const hoursLeft = hoursUntil(appt.startTime);

      // 72h reminder: send when 48-72h out (window for the 15-min cron)
      if (hoursLeft <= 72 && hoursLeft > 24) {
        const key = stateKey(appt.id, "confirm_72h");
        if (!state.sent[key]) {
          try {
            await send72hReminder(appt, supabase);
            state.sent[key] = {
              appointmentId: appt.id,
              contactId: appt.contactId,
              tier: "confirm_72h",
              sentAt: new Date().toISOString(),
            };
            incrementDailyStat(state, "reminders72h");
            result.reminders72h++;
          } catch (err) {
            logError("show-rate", `72h reminder failed for ${appt.id}: ${err}`);
            result.errors++;
          }
        }
      }

      // 24h reminder: send when 2-24h out
      if (hoursLeft <= 24 && hoursLeft > 2) {
        const key = stateKey(appt.id, "remind_24h");
        if (!state.sent[key]) {
          try {
            await send24hReminder(appt, supabase);
            state.sent[key] = {
              appointmentId: appt.id,
              contactId: appt.contactId,
              tier: "remind_24h",
              sentAt: new Date().toISOString(),
            };
            incrementDailyStat(state, "reminders24h");
            result.reminders24h++;
          } catch (err) {
            logError("show-rate", `24h reminder failed for ${appt.id}: ${err}`);
            result.errors++;
          }
        }
      }

      // 2h nudge: send when 0-2h out
      if (hoursLeft <= 2 && hoursLeft > 0) {
        const key = stateKey(appt.id, "nudge_2h");
        if (!state.sent[key]) {
          try {
            await send2hNudge(appt, supabase);
            state.sent[key] = {
              appointmentId: appt.id,
              contactId: appt.contactId,
              tier: "nudge_2h",
              sentAt: new Date().toISOString(),
            };
            incrementDailyStat(state, "reminders2h");
            result.reminders2h++;
          } catch (err) {
            logError("show-rate", `2h nudge failed for ${appt.id}: ${err}`);
            result.errors++;
          }
        }
      }

      // No-show recovery: appointment time has passed, status indicates no-show
      if (hoursLeft < 0 && hoursLeft > -12) {
        const isNoShow = status === "no_show" || status === "noshow" || status === "no-show";
        if (isNoShow) {
          const key = stateKey(appt.id, "noshow_recovery");
          if (!state.sent[key]) {
            // Wait at least NOSHOW_RECOVERY_DELAY_H after appointment time
            const hoursPast = Math.abs(hoursLeft);
            if (hoursPast >= NOSHOW_RECOVERY_DELAY_H) {
              try {
                await sendNoshowRecovery(appt, supabase);
                state.sent[key] = {
                  appointmentId: appt.id,
                  contactId: appt.contactId,
                  tier: "noshow_recovery",
                  sentAt: new Date().toISOString(),
                };
                incrementDailyStat(state, "noshowRecoveries");
                result.noshowRecoveries++;
              } catch (err) {
                logError("show-rate", `No-show recovery failed for ${appt.id}: ${err}`);
                result.errors++;
              }
            }
          }
        }
      }
    }
  } catch (err) {
    logError("show-rate", `Appointment fetch failed: ${err}`);
    result.errors++;
  }

  saveState(state);
  return result;
}

// ============================================================
// REMINDER ACTIONS
// ============================================================

/**
 * 72h confirmation request.
 * Goal: Get the patient to mentally commit. Creates accountability.
 * Actions: Tag contact, add note, create staff follow-up task.
 */
async function send72hReminder(appt: GHLAppointment, supabase: SupabaseClient | null): Promise<void> {
  const contactId = appt.contactId;
  const apptDate = new Date(appt.startTime).toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  // Tag for GHL workflow trigger (GHL workflow should send SMS/email confirmation request)
  await addTagToContact(contactId, TAGS.REMINDER_72H_SENT);

  // Add internal note for clinic staff visibility
  await addContactNote(
    contactId,
    `[Atlas Show Rate] 72h confirmation request queued for appointment on ${apptDate}. ` +
    `Tag "${TAGS.REMINDER_72H_SENT}" applied. GHL workflow should send confirmation SMS/email.`
  );

  // Create a staff task to follow up if no confirmation received within 24h
  const taskDue = new Date(new Date(appt.startTime).getTime() - 48 * 3600_000);
  await createContactTask(contactId, `Confirm appointment: ${apptDate}`, {
    dueDate: taskDue.toISOString(),
    description: "Patient hasn't confirmed yet. Call or text to confirm appointment. If unreachable, consider offering reschedule.",
  });

  info("show-rate", `72h reminder sent for appointment ${appt.id} (contact: ${contactId})`);
}

/**
 * 24h logistics reminder.
 * Goal: Reduce friction. Tell them exactly what to expect.
 * Actions: Tag contact, add note with prep details.
 */
async function send24hReminder(appt: GHLAppointment, supabase: SupabaseClient | null): Promise<void> {
  const contactId = appt.contactId;
  const apptDate = new Date(appt.startTime).toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  await addTagToContact(contactId, TAGS.REMINDER_24H_SENT);

  await addContactNote(
    contactId,
    `[Atlas Show Rate] 24h logistics reminder queued for appointment on ${apptDate}. ` +
    `Tag "${TAGS.REMINDER_24H_SENT}" applied. GHL workflow should send appointment details ` +
    `(address, parking, what to bring, what to expect during consult).`
  );

  info("show-rate", `24h reminder sent for appointment ${appt.id} (contact: ${contactId})`);
}

/**
 * 2h final nudge.
 * Goal: Top-of-mind. Last chance to prevent ghosting.
 * Actions: Tag contact for final SMS nudge.
 */
async function send2hNudge(appt: GHLAppointment, supabase: SupabaseClient | null): Promise<void> {
  const contactId = appt.contactId;
  const apptTime = new Date(appt.startTime).toLocaleString("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  });

  await addTagToContact(contactId, TAGS.REMINDER_2H_SENT);

  await addContactNote(
    contactId,
    `[Atlas Show Rate] 2h final nudge queued for ${apptTime} appointment. ` +
    `Tag "${TAGS.REMINDER_2H_SENT}" applied.`
  );

  info("show-rate", `2h nudge sent for appointment ${appt.id} (contact: ${contactId})`);
}

/**
 * Post no-show recovery.
 * Goal: Re-engage immediately while the intent is still warm.
 * Actions: Tag for recovery workflow, create urgent staff task, emit alert.
 */
async function sendNoshowRecovery(appt: GHLAppointment, supabase: SupabaseClient | null): Promise<void> {
  const contactId = appt.contactId;
  const apptDate = new Date(appt.startTime).toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  // Tag for GHL no-show recovery workflow
  await addTagToContact(contactId, TAGS.NOSHOW_RECOVERY_SENT);

  // Remove prior reminder tags (clean slate for next attempt)
  await removeTagFromContact(contactId, TAGS.REMINDER_72H_SENT).catch(() => {});
  await removeTagFromContact(contactId, TAGS.REMINDER_24H_SENT).catch(() => {});
  await removeTagFromContact(contactId, TAGS.REMINDER_2H_SENT).catch(() => {});

  await addContactNote(
    contactId,
    `[Atlas Show Rate] NO-SHOW RECOVERY. Patient missed appointment on ${apptDate}. ` +
    `Tag "${TAGS.NOSHOW_RECOVERY_SENT}" applied. GHL workflow should send empathetic ` +
    `reschedule SMS (no guilt, just "life happens, let's get you back on the books").`
  );

  // Urgent staff task: call within the hour
  await createContactTask(contactId, `NO-SHOW: Call to reschedule from ${apptDate}`, {
    dueDate: new Date(Date.now() + 3600_000).toISOString(),
    description: "Patient no-showed. Call to reschedule. Be empathetic, not accusatory. " +
      "Offer the next available slot. If voicemail, leave a warm message and follow up tomorrow.",
  });

  // Resolve contact name for alert + workflow
  const contactInfo = await getContact(contactId).catch(() => null);
  const resolvedName = contactInfo
    ? (contactInfo.firstName || "") + " " + (contactInfo.lastName || "")
    : "";

  // Emit alert to Derek
  if (supabase) {
    const displayName = resolvedName.trim() || "contact " + contactId;
    await emitAlert(supabase, {
      source: "show-rate",
      severity: "warning",
      category: "Pipeline",
      message: "No-show recovery triggered for " + displayName + " (missed " + apptDate + "). Staff task created.",
      dedupKey: "noshow-recovery-" + appt.id,
    });
  }

  // Trigger no-show follow-up workflow to draft personalized re-engagement
  instantiateWorkflow("no-show-followup", {
    lead_name: resolvedName.trim() || "Patient",
    source: "no-show-recovery",
  }).catch((err) => {
    warn("show-rate", "No-show workflow failed: " + err);
  });

  info("show-rate", "No-show recovery sent for appointment " + appt.id + " (contact: " + contactId + ")");
}

// ============================================================
// DAILY DIGEST
// ============================================================

/**
 * Get a summary of show-rate actions for the morning brief or /ops.
 */
export function getShowRateDigest(): string {
  const state = loadState();
  const date = todayStr();
  const yesterday = new Date(Date.now() - 24 * 3600_000)
    .toLocaleDateString("en-CA", { timeZone: TIMEZONE });

  const todayStats = state.dailyStats[date];
  const yesterdayStats = state.dailyStats[yesterday];

  const lines: string[] = [];

  if (yesterdayStats) {
    const total = yesterdayStats.reminders72h + yesterdayStats.reminders24h +
      yesterdayStats.reminders2h;
    lines.push(
      `Yesterday's reminders: ${total} sent ` +
      `(${yesterdayStats.reminders72h} confirm, ${yesterdayStats.reminders24h} logistics, ` +
      `${yesterdayStats.reminders2h} nudge)` +
      (yesterdayStats.noshowRecoveries > 0 ? `, ${yesterdayStats.noshowRecoveries} no-show recoveries` : "")
    );
  }

  if (todayStats) {
    const total = todayStats.reminders72h + todayStats.reminders24h + todayStats.reminders2h;
    if (total > 0 || todayStats.noshowRecoveries > 0) {
      lines.push(
        `Today so far: ${total} reminders, ${todayStats.noshowRecoveries} recoveries`
      );
    }
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

// ============================================================
// TAG CLEANUP (run weekly or after appointment completion)
// ============================================================

/**
 * Clean up Atlas reminder tags from contacts whose appointments
 * are more than 48h in the past. Prevents tag buildup.
 */
export async function cleanupStaleReminderTags(): Promise<number> {
  const state = loadState();
  let cleaned = 0;
  const cutoff = Date.now() - 48 * 3600_000;

  for (const [key, record] of Object.entries(state.sent)) {
    if (new Date(record.sentAt).getTime() < cutoff) {
      // Best-effort tag removal
      try {
        const tagName = record.tier === "confirm_72h" ? TAGS.REMINDER_72H_SENT
          : record.tier === "remind_24h" ? TAGS.REMINDER_24H_SENT
          : record.tier === "nudge_2h" ? TAGS.REMINDER_2H_SENT
          : record.tier === "noshow_recovery" ? TAGS.NOSHOW_RECOVERY_SENT
          : null;
        if (tagName) {
          await removeTagFromContact(record.contactId, tagName).catch(() => {});
          cleaned++;
        }
      } catch {
        // non-critical
      }
    }
  }

  if (cleaned > 0) {
    info("show-rate", `Cleaned ${cleaned} stale reminder tags`);
  }

  return cleaned;
}

// ============================================================
// EXPORTS FOR OPS DASHBOARD
// ============================================================

export { TAGS as SHOW_RATE_TAGS };
