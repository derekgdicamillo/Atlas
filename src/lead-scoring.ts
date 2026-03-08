/**
 * Atlas -- Lead Scoring by Engagement
 *
 * Lightweight lead scoring framework. Assigns a 0-100 score based on
 * engagement signals, then classifies leads as hot/warm/cold.
 *
 * Data sources available via GHL PIT-token API:
 *   - Contact tags (tags array on GHLContact)
 *   - Conversations + messages (direction, dates, type)
 *   - Appointments (status: confirmed, showed, no-showed, cancelled)
 *   - Opportunity pipeline stage + status
 *   - Contact dateAdded (recency)
 *
 * Data NOT available via GHL PIT-token API:
 *   - Email open tracking (GHL tracks internally, not exposed to API)
 *   - Email click tracking (same)
 *   - SMS delivery/read status
 *   - Page visit / form activity (only via webhooks, not queryable)
 *
 * Architecture: Signal-based. Callers collect whatever signals they can
 * and pass them in. The scoring function doesn't call GHL directly,
 * keeping it testable and decoupled. A helper function (buildSignalsFromGHL)
 * wraps the GHL calls for convenience.
 */

import { info, warn } from "./logger.ts";

// ============================================================
// TYPES
// ============================================================

export type SignalType =
  | "replied_to_message"     // Contact sent an inbound message
  | "appointment_confirmed"  // Confirmed an upcoming appointment
  | "appointment_showed"     // Actually showed up (won opportunity)
  | "appointment_noshow"     // No-showed (negative signal)
  | "appointment_booked"     // Has an appointment on the calendar
  | "tag_applied"            // Specific tag was added (e.g., "interested", "hot-lead")
  | "opportunity_advanced"   // Moved forward in pipeline
  | "opportunity_stale"      // Stuck in early stage > 7 days
  | "recent_activity"        // Any activity within last N days
  | "form_submitted"         // Submitted a form (via webhook event)
  | "email_opened"           // Opened an email (TODO: not yet available via API)
  | "link_clicked"           // Clicked a link (TODO: not yet available via API)
  | "sms_replied";           // Replied to SMS (detected via message direction)

export interface LeadSignal {
  type: SignalType;
  /** When this signal occurred. Used for recency weighting. */
  timestamp: string;
  /** Optional extra context (e.g., tag name, message preview). */
  detail?: string;
  /** Override default weight for this signal type. */
  weight?: number;
}

export interface LeadScore {
  contactId: string;
  score: number;          // 0-100
  tier: "hot" | "warm" | "cold";
  signals: LeadSignal[];
  scoredAt: string;
  breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  engagementScore: number;   // from messages/replies
  appointmentScore: number;  // from appointment behavior
  recencyScore: number;      // how recent is activity
  pipelineScore: number;     // from opportunity stage
  tagBonus: number;          // from engagement-indicating tags
  penalties: number;         // from negative signals (no-shows, stale)
}

export interface ScoredLead {
  contactId: string;
  contactName: string;
  score: number;
  tier: "hot" | "warm" | "cold";
  topSignals: string[];
}

// ============================================================
// SIGNAL WEIGHTS (default points per signal type)
// ============================================================

const DEFAULT_WEIGHTS: Record<SignalType, number> = {
  replied_to_message:    15,
  appointment_confirmed: 20,
  appointment_showed:    25,
  appointment_noshow:   -15,
  appointment_booked:    10,
  tag_applied:            5,  // base; specific tags get bonuses below
  opportunity_advanced:  15,
  opportunity_stale:    -10,
  recent_activity:        5,
  form_submitted:        20,
  email_opened:          10,
  link_clicked:          12,
  sms_replied:           15,
};

/** Tags that indicate higher engagement. Additive bonus on top of base tag_applied weight. */
const HIGH_VALUE_TAGS: Record<string, number> = {
  "interested":          10,
  "hot-lead":            15,
  "auto-enriched":        5,
  "atlas-appointment-confirmed": 10,
  "responded":           10,
  "booked":              10,
  "qualified":           15,
};

// ============================================================
// SCORING ENGINE
// ============================================================

/**
 * Score a contact based on collected engagement signals.
 * Pure function: does not call any external APIs.
 */
export function scoreContact(contactId: string, signals: LeadSignal[]): LeadScore {
  const breakdown: ScoreBreakdown = {
    engagementScore: 0,
    appointmentScore: 0,
    recencyScore: 0,
    pipelineScore: 0,
    tagBonus: 0,
    penalties: 0,
  };

  const now = Date.now();

  for (const signal of signals) {
    const baseWeight = signal.weight ?? DEFAULT_WEIGHTS[signal.type] ?? 0;

    // Apply recency decay: signals older than 14 days get halved, older than 30 days get quartered
    const ageMs = now - new Date(signal.timestamp).getTime();
    const ageDays = ageMs / 86_400_000;
    let recencyMultiplier = 1.0;
    if (ageDays > 30) recencyMultiplier = 0.25;
    else if (ageDays > 14) recencyMultiplier = 0.5;

    const points = baseWeight * recencyMultiplier;

    switch (signal.type) {
      case "replied_to_message":
      case "sms_replied":
        breakdown.engagementScore += points;
        break;

      case "appointment_confirmed":
      case "appointment_showed":
      case "appointment_booked":
        breakdown.appointmentScore += points;
        break;

      case "appointment_noshow":
        breakdown.penalties += points; // points is negative
        break;

      case "opportunity_advanced":
        breakdown.pipelineScore += points;
        break;

      case "opportunity_stale":
        breakdown.penalties += points; // points is negative
        break;

      case "tag_applied": {
        let tagPoints = points;
        const tagName = (signal.detail || "").toLowerCase();
        if (HIGH_VALUE_TAGS[tagName]) {
          tagPoints += HIGH_VALUE_TAGS[tagName] * recencyMultiplier;
        }
        breakdown.tagBonus += tagPoints;
        break;
      }

      case "recent_activity":
        breakdown.recencyScore += points;
        break;

      case "form_submitted":
      case "email_opened":
      case "link_clicked":
        breakdown.engagementScore += points;
        break;
    }
  }

  // Calculate raw score (sum of all components)
  const rawScore =
    breakdown.engagementScore +
    breakdown.appointmentScore +
    breakdown.recencyScore +
    breakdown.pipelineScore +
    breakdown.tagBonus +
    breakdown.penalties;

  // Clamp to 0-100
  const score = Math.max(0, Math.min(100, rawScore));

  // Tier classification
  let tier: "hot" | "warm" | "cold";
  if (score >= 60) tier = "hot";
  else if (score >= 30) tier = "warm";
  else tier = "cold";

  return {
    contactId,
    score,
    tier,
    signals,
    scoredAt: new Date().toISOString(),
    breakdown,
  };
}

// ============================================================
// GHL SIGNAL BUILDER
// ============================================================

/**
 * Build lead signals from GHL data for a single contact.
 * This bridges the gap between GHL's API responses and the scoring engine.
 *
 * Requires the caller to pass in pre-fetched GHL data to avoid
 * importing ghl.ts directly (prevents circular deps).
 */
export function buildSignalsFromGHL(data: {
  contact: {
    id: string;
    tags?: string[];
    dateAdded?: string;
  };
  messages?: Array<{
    direction: string;
    dateAdded: string;
    body?: string;
  }>;
  appointments?: Array<{
    appointmentStatus: string;
    startTime: string;
  }>;
  opportunity?: {
    status: string;
    pipelineStageId: string;
    dateAdded?: string;
    lastStageChangeAt?: string;
  };
  /** Stage names mapped by ID, for detecting advancement */
  stageNames?: Record<string, string>;
}): LeadSignal[] {
  const signals: LeadSignal[] = [];
  const now = new Date().toISOString();

  // 1. Tag signals
  if (data.contact.tags) {
    for (const tag of data.contact.tags) {
      signals.push({
        type: "tag_applied",
        timestamp: data.contact.dateAdded || now,
        detail: tag.toLowerCase(),
      });
    }
  }

  // 2. Message signals: inbound messages = replied
  if (data.messages) {
    const inbound = data.messages.filter(m => m.direction === "inbound");
    for (const msg of inbound) {
      signals.push({
        type: "replied_to_message",
        timestamp: msg.dateAdded,
        detail: msg.body?.substring(0, 50),
      });
    }
  }

  // 3. Appointment signals
  if (data.appointments) {
    for (const appt of data.appointments) {
      const status = appt.appointmentStatus?.toLowerCase() || "";
      if (status === "confirmed") {
        signals.push({
          type: "appointment_confirmed",
          timestamp: appt.startTime,
        });
      } else if (status === "showed" || status === "completed") {
        signals.push({
          type: "appointment_showed",
          timestamp: appt.startTime,
        });
      } else if (status === "noshow" || status === "no_show" || status === "no show") {
        signals.push({
          type: "appointment_noshow",
          timestamp: appt.startTime,
        });
      } else if (status === "booked" || status === "new") {
        signals.push({
          type: "appointment_booked",
          timestamp: appt.startTime,
        });
      }
    }
  }

  // 4. Opportunity/pipeline signals
  if (data.opportunity) {
    const opp = data.opportunity;

    // Check if stale: in early stage > 7 days
    if (opp.status === "open") {
      const stageName = data.stageNames?.[opp.pipelineStageId]?.toLowerCase() || "";
      const isEarlyStage = stageName.includes("new") || stageName.includes("lead") || stageName.includes("undecided");
      const lastChange = opp.lastStageChangeAt || opp.dateAdded;

      if (isEarlyStage && lastChange) {
        const daysSinceChange = (Date.now() - new Date(lastChange).getTime()) / 86_400_000;
        if (daysSinceChange > 7) {
          signals.push({
            type: "opportunity_stale",
            timestamp: lastChange,
            detail: `${Math.round(daysSinceChange)}d in ${stageName}`,
          });
        }
      }

      // If not in an early stage, they've advanced
      if (!isEarlyStage && stageName) {
        signals.push({
          type: "opportunity_advanced",
          timestamp: opp.lastStageChangeAt || now,
          detail: stageName,
        });
      }
    }

    // Won opportunity = showed up
    if (opp.status === "won") {
      signals.push({
        type: "appointment_showed",
        timestamp: opp.lastStageChangeAt || now,
      });
    }
  }

  // 5. Recency signal: any activity in last 7 days
  const sevenDaysAgo = Date.now() - 7 * 86_400_000;
  const hasRecentActivity = signals.some(s => new Date(s.timestamp).getTime() > sevenDaysAgo);
  if (hasRecentActivity) {
    signals.push({
      type: "recent_activity",
      timestamp: now,
    });
  }

  return signals;
}

// ============================================================
// BATCH SCORING (placeholder for future automation)
// ============================================================

/**
 * Score and rank the top N leads.
 *
 * TODO: This currently requires the caller to provide contact data.
 * Full automation would need to:
 *   1. Pull all open opportunities from GHL
 *   2. For each, fetch contact, messages, appointments
 *   3. Build signals and score
 *   4. Sort by score, return top N
 *
 * This is API-intensive (2-4 calls per contact). For now, it's a
 * framework that can be called for individual contacts or small batches.
 * A daily batch scorer could be added as a cron job once API rate
 * limits are validated.
 */
export async function getTopLeads(
  contactData: Array<{
    contactId: string;
    contactName: string;
    signals: LeadSignal[];
  }>,
  n: number = 10
): Promise<ScoredLead[]> {
  const scored: ScoredLead[] = [];

  for (const entry of contactData) {
    const result = scoreContact(entry.contactId, entry.signals);
    scored.push({
      contactId: entry.contactId,
      contactName: entry.contactName,
      score: result.score,
      tier: result.tier,
      topSignals: result.signals
        .filter(s => (s.weight ?? DEFAULT_WEIGHTS[s.type] ?? 0) > 0)
        .sort((a, b) => (b.weight ?? DEFAULT_WEIGHTS[b.type] ?? 0) - (a.weight ?? DEFAULT_WEIGHTS[a.type] ?? 0))
        .slice(0, 3)
        .map(s => `${s.type}${s.detail ? ` (${s.detail})` : ""}`),
    });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}

/**
 * Format scored leads for Telegram output.
 */
export function formatScoredLeads(leads: ScoredLead[]): string {
  if (leads.length === 0) return "No scored leads to display.";

  const lines = ["--- Lead Scores ---"];

  for (const lead of leads) {
    const tierIcon = lead.tier === "hot" ? "[HOT]" : lead.tier === "warm" ? "[WARM]" : "[COLD]";
    lines.push(
      `${tierIcon} ${lead.contactName}: ${lead.score}/100`,
      `  Signals: ${lead.topSignals.join(", ") || "none"}`,
    );
  }

  return lines.join("\n");
}
