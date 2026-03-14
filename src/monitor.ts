/**
 * Atlas -- Proactive Monitoring Module
 *
 * Pure-computation metric comparison engine. NO LLM calls in monitor
 * checks. Only haiku is used for alert message composition (via alerts.ts
 * emit). Runs on tiered schedules (fast/medium/slow/daily) to catch
 * anomalies, threshold breaches, and state changes across all data sources.
 *
 * Key design principles:
 *   1. Every check is try/catch isolated. One failure never blocks others.
 *   2. Readiness guards (isDashboardReady, isGHLReady, etc.) prevent
 *      calls to unconfigured integrations.
 *   3. Metric snapshots are persisted to Supabase for baseline comparison.
 *   4. In-memory state is persisted to data/monitor-state.json for
 *      crash recovery.
 *   5. Severity escalation: stale alerts auto-escalate over time.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { info, warn, error as logError } from "./logger.ts";
import { emit } from "./alerts.ts";
import {
  isDashboardReady,
  getOverview,
  getFinancials,
  getSpeedToLead,
  type OverviewSnapshot,
  type FinancialSnapshot,
  type SpeedToLeadSnapshot,
} from "./dashboard.ts";
import {
  isGHLReady,
  getNewLeadsSince,
  getOpsSnapshot,
  type OpsSnapshot,
} from "./ghl.ts";
import {
  isGA4Ready,
  getOverview as getGA4Overview,
  type GA4Overview,
} from "./analytics.ts";
import {
  isGBPReady,
  getReviewSummary,
  type GBPReviewSummary,
} from "./gbp.ts";
import {
  isGoogleEnabled,
  listUnreadEmails,
  listTodayEvents,
  type EmailSummary,
  type CalEvent,
} from "./google.ts";

// ============================================================
// CONSTANTS
// ============================================================

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const STATE_FILE = join(DATA_DIR, "monitor-state.json");
const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";

/** Urgent email senders/domains to watch for */
const URGENT_EMAIL_SENDERS = [
  "quickbooks",
  "intuit",
  "google.com",
  "meta.com",
  "facebook.com",
  "gohighlevel",
  "leadconnector",
  "wpengine",
  "stripe",
  "bank",
];

/** Urgent email subject keywords */
const URGENT_EMAIL_KEYWORDS = [
  "urgent",
  "action required",
  "suspended",
  "declined",
  "failed",
  "overdue",
  "expiring",
  "security alert",
  "unauthorized",
  "payment failed",
  "account locked",
];

// ============================================================
// TYPES
// ============================================================

export type MonitorScheduleTier = "fast" | "medium" | "slow" | "daily";

export interface MonitorCheck {
  key: string;
  schedule: MonitorScheduleTier;
  enabled: boolean;
  run: (supabase: SupabaseClient) => Promise<MonitorResult[]>;
}

export interface MonitorResult {
  metricKey: string;
  value: number;
  severity: "info" | "warning" | "critical" | null;
  message?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

export interface MetricSnapshot {
  metricKey: string;
  value: number;
  metadata?: Record<string, unknown>;
}

interface MetricBaseline {
  avg: number;
  stddev: number;
  count: number;
  min: number;
  max: number;
}

interface MonitorState {
  lastRunByCheck: Record<string, number>;  // check_key -> epoch ms
  lastLeadCheckTime: string;               // ISO for lead polling
  lastReviewCount: number;
  pendingWarnings: Array<{ message: string; category: string; timestamp: number }>;
}

// ============================================================
// STATE
// ============================================================

let state: MonitorState = {
  lastRunByCheck: {},
  lastLeadCheckTime: new Date(Date.now() - 300_000).toISOString(),
  lastReviewCount: -1, // -1 = not yet initialized
  pendingWarnings: [],
};

let initialized = false;
const checkRegistry: MonitorCheck[] = [];

// Running stats for getMonitorStatus()
let totalChecksRun = 0;
let totalAlertsEmitted = 0;
let totalSnapshotsRecorded = 0;
let lastTickTime = 0;

// ============================================================
// STATE PERSISTENCE
// ============================================================

function loadState(): void {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const loaded = JSON.parse(raw);
      state = {
        lastRunByCheck: loaded.lastRunByCheck || {},
        lastLeadCheckTime: loaded.lastLeadCheckTime || new Date(Date.now() - 300_000).toISOString(),
        lastReviewCount: loaded.lastReviewCount ?? -1,
        pendingWarnings: loaded.pendingWarnings || [],
      };
      info("monitor", `State loaded from ${STATE_FILE}`);
    }
  } catch (err) {
    warn("monitor", `Failed to load state: ${err}`);
  }
}

function saveState(): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    warn("monitor", `Failed to save state: ${err}`);
  }
}

// ============================================================
// METRIC SNAPSHOT PERSISTENCE
// ============================================================

async function recordSnapshot(supabase: SupabaseClient, snapshot: MetricSnapshot): Promise<void> {
  try {
    const { error } = await supabase.from("metric_snapshots").insert({
      metric_key: snapshot.metricKey,
      value: snapshot.value,
      metadata: snapshot.metadata || {},
    });
    if (error) {
      warn("monitor", `Snapshot insert failed for ${snapshot.metricKey}: ${error.message}`);
    } else {
      totalSnapshotsRecorded++;
    }
  } catch (err) {
    warn("monitor", `Snapshot record error for ${snapshot.metricKey}: ${err}`);
  }
}

async function getBaseline(
  supabase: SupabaseClient,
  metricKey: string,
  windowHours = 168,
): Promise<MetricBaseline | null> {
  try {
    const { data, error } = await supabase.rpc("get_metric_baseline", {
      p_metric_key: metricKey,
      p_window_hours: windowHours,
    });
    if (error) {
      warn("monitor", `Baseline RPC failed for ${metricKey}: ${error.message}`);
      return null;
    }
    if (!data || (Array.isArray(data) && data.length === 0)) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || row.count === 0) return null;
    return {
      avg: Number(row.avg) || 0,
      stddev: Number(row.stddev) || 0,
      count: Number(row.count) || 0,
      min: Number(row.min) || 0,
      max: Number(row.max) || 0,
    };
  } catch (err) {
    warn("monitor", `Baseline fetch error for ${metricKey}: ${err}`);
    return null;
  }
}

async function getLatestSnapshot(
  supabase: SupabaseClient,
  metricKey: string,
): Promise<{ value: number; created_at: string } | null> {
  try {
    const { data, error } = await supabase.rpc("get_latest_metric", {
      p_metric_key: metricKey,
    });
    if (error) {
      warn("monitor", `Latest metric RPC failed for ${metricKey}: ${error.message}`);
      return null;
    }
    if (!data || (Array.isArray(data) && data.length === 0)) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
      value: Number(row.value) || 0,
      created_at: row.created_at || "",
    };
  } catch (err) {
    warn("monitor", `Latest metric fetch error for ${metricKey}: ${err}`);
    return null;
  }
}

// ============================================================
// SEVERITY ESCALATION
// ============================================================

async function checkEscalation(
  supabase: SupabaseClient,
  dedupKey: string,
  currentSeverity: "info" | "warning" | "critical",
): Promise<"info" | "warning" | "critical"> {
  try {
    const { data } = await supabase
      .from("alerts")
      .select("created_at, severity")
      .eq("dedup_key", dedupKey)
      .order("created_at", { ascending: true })
      .limit(1);

    if (!data || data.length === 0) return currentSeverity;

    const firstSeen = new Date(data[0].created_at).getTime();
    const ageHours = (Date.now() - firstSeen) / 3600_000;

    if (currentSeverity === "info" && ageHours > 4) {
      return "warning";
    }
    if (currentSeverity === "warning" && ageHours > 12) {
      return "critical";
    }
  } catch {
    // Escalation check failed, keep current severity
  }
  return currentSeverity;
}

// ============================================================
// CHECK IMPLEMENTATIONS
// ============================================================

// --- FAST CHECKS (5 min) ---

async function checkNewLeads(supabase: SupabaseClient): Promise<MonitorResult[]> {
  if (!isGHLReady()) return [];
  const results: MonitorResult[] = [];
  try {
    const { leads, checkTime } = await getNewLeadsSince(state.lastLeadCheckTime);
    state.lastLeadCheckTime = checkTime;

    if (leads.length > 0) {
      const names = leads.map((l) => {
        const name = l.contact?.name || l.name || "Unknown";
        const src = l.source ? ` (${l.source})` : "";
        return `${name}${src}`;
      });
      // severity: null = metric tracking only, no alert.
      // Webhook (supabase/functions/ghl-webhook) handles real-time Telegram notification.
      results.push({
        metricKey: "pipeline.new_leads",
        value: leads.length,
        severity: null,
        category: "Pipeline",
        message: `New lead${leads.length > 1 ? "s" : ""}: ${names.join(", ")}`,
        metadata: { leadNames: names },
      });
    }
  } catch (err) {
    warn("monitor", `New leads check failed: ${err}`);
  }
  return results;
}

async function checkNewReviews(_supabase: SupabaseClient): Promise<MonitorResult[]> {
  if (!isGBPReady()) return [];
  const results: MonitorResult[] = [];
  try {
    const summary = await getReviewSummary();
    const currentCount = summary.totalReviews;

    if (state.lastReviewCount === -1) {
      // First run, just set the baseline
      state.lastReviewCount = currentCount;
      return [];
    }

    if (currentCount > state.lastReviewCount) {
      const newCount = currentCount - state.lastReviewCount;
      const latest = summary.recentReviews[0];
      const latestInfo = latest
        ? ` Latest: ${latest.rating}/5 from ${latest.reviewer}${latest.comment ? ` - "${latest.comment.substring(0, 60)}..."` : ""}`
        : "";

      results.push({
        metricKey: "reviews.new_review",
        value: newCount,
        severity: "info",
        category: "Reputation",
        message: `${newCount} new Google review${newCount > 1 ? "s" : ""}.${latestInfo}`,
        metadata: { newCount, totalReviews: currentCount, averageRating: summary.averageRating },
      });
      state.lastReviewCount = currentCount;
    }
  } catch (err) {
    warn("monitor", `Review check failed: ${err}`);
  }
  return results;
}

async function checkUrgentEmails(_supabase: SupabaseClient): Promise<MonitorResult[]> {
  if (!isGoogleEnabled()) return [];
  const results: MonitorResult[] = [];
  try {
    const emails = await listUnreadEmails(5);
    const urgent = emails.filter((e: EmailSummary) => {
      const fromLower = (e.from || "").toLowerCase();
      const subjectLower = (e.subject || "").toLowerCase();

      const senderMatch = URGENT_EMAIL_SENDERS.some((s) => fromLower.includes(s));
      const keywordMatch = URGENT_EMAIL_KEYWORDS.some((k) => subjectLower.includes(k));

      return senderMatch || keywordMatch;
    });

    if (urgent.length > 0) {
      const summaries = urgent.map(
        (e: EmailSummary) => `${e.from}: "${e.subject}"`
      );
      results.push({
        metricKey: "email.urgent",
        value: urgent.length,
        severity: "warning",
        category: "Email",
        message: `${urgent.length} potentially urgent email${urgent.length > 1 ? "s" : ""}: ${summaries.join("; ")}`,
        metadata: { emails: summaries },
      });
    }
  } catch (err) {
    warn("monitor", `Urgent email check failed: ${err}`);
  }
  return results;
}

// --- MEDIUM CHECKS (15 min) ---

async function checkAdMetrics(supabase: SupabaseClient): Promise<MonitorResult[]> {
  if (!isDashboardReady()) return [];
  const results: MonitorResult[] = [];
  try {
    const overview: OverviewSnapshot = await getOverview("week");

    // Record snapshot
    await recordSnapshot(supabase, { metricKey: "ads.cpl_7d", value: overview.cpl });

    if (overview.cpl > 100) {
      // Critical: real-time Telegram ping
      let severity: "info" | "warning" | "critical" = "critical";
      severity = await checkEscalation(supabase, "ads.cpl_7d", severity);
      results.push({
        metricKey: "ads.cpl_7d",
        value: overview.cpl,
        severity,
        category: "Ads",
        message: `CPL at $${overview.cpl.toFixed(0)} (7d). Above $100 critical threshold.`,
        metadata: { cpl: overview.cpl, adSpend: overview.adSpend, totalLeads: overview.totalLeads },
      });
    } else if (overview.cpl > 65) {
      // Warning-level: log as info (visible in /alerts, no Telegram ping)
      const baseline = await getBaseline(supabase, "ads.cpl_7d");
      const isSpike = baseline && baseline.stddev > 0 && overview.cpl > baseline.avg + 2 * baseline.stddev;
      results.push({
        metricKey: "ads.cpl_7d",
        value: overview.cpl,
        severity: "info",
        category: "Ads",
        message: `CPL at $${overview.cpl.toFixed(0)} (7d)${isSpike ? " -- sudden spike" : ""}. Target <$65.`,
        metadata: {
          cpl: overview.cpl,
          baselineAvg: baseline?.avg,
          baselineStddev: baseline?.stddev,
          isSpike,
        },
      });
    }
  } catch (err) {
    warn("monitor", `Ad metrics check failed: ${err}`);
  }
  return results;
}

async function checkPipelineChanges(supabase: SupabaseClient): Promise<MonitorResult[]> {
  if (!isGHLReady()) return [];
  const results: MonitorResult[] = [];
  try {
    const ops: OpsSnapshot = await getOpsSnapshot();

    // Record stage count snapshots
    await recordSnapshot(supabase, { metricKey: "pipeline.open", value: ops.pipeline.open });
    await recordSnapshot(supabase, { metricKey: "pipeline.show_rate", value: ops.pipeline.showRate });
    await recordSnapshot(supabase, { metricKey: "pipeline.close_rate", value: ops.pipeline.closeRate });

    // Show rate drop detection
    if (ops.pipeline.showRate > 0 && ops.pipeline.showRate < 0.35) {
      results.push({
        metricKey: "pipeline.show_rate",
        value: ops.pipeline.showRate,
        severity: "critical",
        category: "Pipeline",
        message: `Show rate at ${(ops.pipeline.showRate * 100).toFixed(1)}%. Below 35% critical threshold. Check reminder workflows and pre-consult nurture.`,
        metadata: { showRate: ops.pipeline.showRate, noShows: ops.noShowsThisWeek },
      });
    } else if (ops.pipeline.showRate > 0 && ops.pipeline.showRate < 0.5) {
      results.push({
        metricKey: "pipeline.show_rate",
        value: ops.pipeline.showRate,
        severity: "warning",
        category: "Pipeline",
        message: `Show rate at ${(ops.pipeline.showRate * 100).toFixed(1)}%. Below 50% warning threshold.`,
        metadata: { showRate: ops.pipeline.showRate, noShows: ops.noShowsThisWeek },
      });
    }

    // Stale leads — disabled 2026-03-09 per Derek (too many false positives on leads awaiting consult)
    // if (ops.pipeline.staleCount > 5) {
    //   results.push({
    //     metricKey: "pipeline.stale_count",
    //     value: ops.pipeline.staleCount,
    //     severity: "warning",
    //     category: "Pipeline",
    //     message: `${ops.pipeline.staleCount} stale leads (>7d in early stages). Revenue leaking.`,
    //     metadata: { staleCount: ops.pipeline.staleCount },
    //   });
    // }
  } catch (err) {
    warn("monitor", `Pipeline changes check failed: ${err}`);
  }
  return results;
}

async function checkSpeedToLead(supabase: SupabaseClient): Promise<MonitorResult[]> {
  if (!isDashboardReady()) return [];
  const results: MonitorResult[] = [];
  try {
    const stl: SpeedToLeadSnapshot = await getSpeedToLead("week");
    const median = stl.summary.medianMinutes;

    // Record snapshot (skip if median is null/undefined to avoid NOT NULL constraint violation)
    if (median != null) {
      await recordSnapshot(supabase, { metricKey: "pipeline.stl_median", value: median });
    }

    if (median > 60) {
      results.push({
        metricKey: "pipeline.stl_median",
        value: median,
        severity: "critical",
        category: "Operations",
        message: `Speed to lead: ${median.toFixed(0)} min median. Above 60min critical threshold. Leads contacted within 5 min convert 4x better.`,
        metadata: { medianMinutes: median, avgMinutes: stl.summary.avgMinutes },
      });
    } else if (median > 30) {
      results.push({
        metricKey: "pipeline.stl_median",
        value: median,
        severity: "warning",
        category: "Operations",
        message: `Speed to lead: ${median.toFixed(0)} min median. Target <30 min for optimal conversion.`,
        metadata: { medianMinutes: median, avgMinutes: stl.summary.avgMinutes },
      });
    }
  } catch (err) {
    warn("monitor", `Speed to lead check failed: ${err}`);
  }
  return results;
}

// --- SLOW CHECKS (60 min) ---

async function checkFinancialHealth(supabase: SupabaseClient): Promise<MonitorResult[]> {
  if (!isDashboardReady()) return [];
  const results: MonitorResult[] = [];
  try {
    const financials: FinancialSnapshot = await getFinancials("month");
    if (!financials.authenticated) return [];

    // Record snapshots
    if (financials.currentMonth) {
      await recordSnapshot(supabase, {
        metricKey: "financial.revenue_mtd",
        value: financials.currentMonth.revenue,
      });
      await recordSnapshot(supabase, {
        metricKey: "financial.margin",
        value: financials.currentMonth.profitMargin,
      });
      await recordSnapshot(supabase, {
        metricKey: "financial.net_income",
        value: financials.currentMonth.netIncome,
      });
    }

    // Margin compression detection vs baseline
    if (financials.currentMonth) {
      const currentMargin = financials.currentMonth.profitMargin;
      const baseline = await getBaseline(supabase, "financial.margin");

      if (baseline && baseline.count >= 3) {
        const marginDrop = baseline.avg - currentMargin;

        if (marginDrop > 0.10) {
          results.push({
            metricKey: "financial.margin",
            value: currentMargin,
            severity: "critical",
            category: "Financial",
            message: `Profit margin at ${(currentMargin * 100).toFixed(1)}%. Down ${(marginDrop * 100).toFixed(1)} pts vs baseline avg of ${(baseline.avg * 100).toFixed(1)}%.`,
            metadata: { currentMargin, baselineAvg: baseline.avg, drop: marginDrop },
          });
        } else if (marginDrop > 0.05) {
          results.push({
            metricKey: "financial.margin",
            value: currentMargin,
            severity: "warning",
            category: "Financial",
            message: `Margin compression: ${(currentMargin * 100).toFixed(1)}% vs ${(baseline.avg * 100).toFixed(1)}% baseline (${(marginDrop * 100).toFixed(1)} pt drop).`,
            metadata: { currentMargin, baselineAvg: baseline.avg, drop: marginDrop },
          });
        }
      }

      // Month-over-month comparison
      if (financials.lastMonth) {
        const momMarginDelta = financials.currentMonth.profitMargin - financials.lastMonth.profitMargin;
        if (momMarginDelta < -0.10) {
          results.push({
            metricKey: "financial.margin_mom",
            value: momMarginDelta,
            severity: "critical",
            category: "Financial",
            message: `Margin dropped ${(Math.abs(momMarginDelta) * 100).toFixed(1)} pts vs last month (${(financials.currentMonth.profitMargin * 100).toFixed(1)}% vs ${(financials.lastMonth.profitMargin * 100).toFixed(1)}%).`,
          });
        } else if (momMarginDelta < -0.05) {
          results.push({
            metricKey: "financial.margin_mom",
            value: momMarginDelta,
            severity: "warning",
            category: "Financial",
            message: `Margin down ${(Math.abs(momMarginDelta) * 100).toFixed(1)} pts MoM. Current: ${(financials.currentMonth.profitMargin * 100).toFixed(1)}%.`,
          });
        }
      }
    }
  } catch (err) {
    warn("monitor", `Financial health check failed: ${err}`);
  }
  return results;
}

async function checkWebsiteTraffic(supabase: SupabaseClient): Promise<MonitorResult[]> {
  if (!isGA4Ready()) return [];
  const results: MonitorResult[] = [];
  try {
    const ga4: GA4Overview = await getGA4Overview(7);

    // Record snapshot
    await recordSnapshot(supabase, { metricKey: "website.sessions_7d", value: ga4.sessions });

    // Compare to baseline for WoW detection
    const baseline = await getBaseline(supabase, "website.sessions_7d");
    if (baseline && baseline.count >= 2 && baseline.avg > 0) {
      const pctChange = (ga4.sessions - baseline.avg) / baseline.avg;

      if (pctChange < -0.50) {
        results.push({
          metricKey: "website.sessions_7d",
          value: ga4.sessions,
          severity: "critical",
          category: "Website",
          message: `Website traffic dropped ${Math.abs(Math.round(pctChange * 100))}% WoW (${ga4.sessions} vs ${Math.round(baseline.avg)} avg). Check site uptime and ad delivery.`,
          metadata: { sessions: ga4.sessions, baselineAvg: baseline.avg, pctChange },
        });
      } else if (pctChange < -0.30) {
        results.push({
          metricKey: "website.sessions_7d",
          value: ga4.sessions,
          severity: "warning",
          category: "Website",
          message: `Website traffic down ${Math.abs(Math.round(pctChange * 100))}% WoW (${ga4.sessions} vs ${Math.round(baseline.avg)} avg).`,
          metadata: { sessions: ga4.sessions, baselineAvg: baseline.avg, pctChange },
        });
      }
    }
  } catch (err) {
    warn("monitor", `Website traffic check failed: ${err}`);
  }
  return results;
}

async function checkWebsiteConversionRate(supabase: SupabaseClient): Promise<MonitorResult[]> {
  if (!isGA4Ready()) return [];
  const results: MonitorResult[] = [];
  try {
    const ga4: GA4Overview = await getGA4Overview(7);
    const cvr = ga4.sessions > 0 ? (ga4.conversions / ga4.sessions) * 100 : 0;

    // Record snapshot
    await recordSnapshot(supabase, { metricKey: "website.cvr_7d", value: cvr });

    if (cvr < 3 && ga4.sessions > 50) {
      results.push({
        metricKey: "website.cvr_7d",
        value: cvr,
        severity: "critical",
        category: "Website",
        message: `Conversion rate at ${cvr.toFixed(1)}% (7d). Below 3% critical threshold. Check landing page UX and form functionality.`,
        metadata: { cvr, sessions: ga4.sessions, conversions: ga4.conversions },
      });
    } else if (cvr < 5 && ga4.sessions > 50) {
      results.push({
        metricKey: "website.cvr_7d",
        value: cvr,
        severity: "warning",
        category: "Website",
        message: `Conversion rate at ${cvr.toFixed(1)}% (7d). Target >5%. ${ga4.conversions} conversions from ${ga4.sessions} sessions.`,
        metadata: { cvr, sessions: ga4.sessions, conversions: ga4.conversions },
      });
    }
  } catch (err) {
    warn("monitor", `Website CVR check failed: ${err}`);
  }
  return results;
}

async function checkReviewHealth(supabase: SupabaseClient): Promise<MonitorResult[]> {
  if (!isGBPReady()) return [];
  const results: MonitorResult[] = [];
  try {
    const summary: GBPReviewSummary = await getReviewSummary();

    // Record snapshots
    await recordSnapshot(supabase, { metricKey: "reviews.unreplied", value: summary.unreplied });
    await recordSnapshot(supabase, { metricKey: "reviews.avg_rating", value: summary.averageRating });

    // Unreplied reviews
    if (summary.unreplied > 5) {
      results.push({
        metricKey: "reviews.unreplied",
        value: summary.unreplied,
        severity: "critical",
        category: "Reputation",
        message: `${summary.unreplied} unreplied Google reviews. Hurts SEO ranking and patient trust.`,
        metadata: { unreplied: summary.unreplied, averageRating: summary.averageRating },
      });
    } else if (summary.unreplied > 3) {
      results.push({
        metricKey: "reviews.unreplied",
        value: summary.unreplied,
        severity: "warning",
        category: "Reputation",
        message: `${summary.unreplied} unreplied Google reviews. Reply within 24h for best SEO impact.`,
        metadata: { unreplied: summary.unreplied },
      });
    }

    // Rating trend
    const baseline = await getBaseline(supabase, "reviews.avg_rating");
    if (baseline && baseline.count >= 3 && summary.averageRating < baseline.avg - 0.2) {
      results.push({
        metricKey: "reviews.avg_rating",
        value: summary.averageRating,
        severity: "warning",
        category: "Reputation",
        message: `Google rating trending down: ${summary.averageRating.toFixed(1)}/5 vs ${baseline.avg.toFixed(1)}/5 baseline.`,
        metadata: { rating: summary.averageRating, baselineAvg: baseline.avg },
      });
    }
  } catch (err) {
    warn("monitor", `Review health check failed: ${err}`);
  }
  return results;
}

// --- DAILY CHECKS ---

async function checkCalendarToday(_supabase: SupabaseClient): Promise<MonitorResult[]> {
  if (!isGoogleEnabled()) return [];
  const results: MonitorResult[] = [];
  try {
    const events: CalEvent[] = await listTodayEvents();
    if (events.length > 0) {
      const eventList = events.map((e: CalEvent) => {
        const who = e.attendees?.length ? ` (with: ${e.attendees.join(", ")})` : "";
        return `${e.start}-${e.end} ${e.title}${who}`;
      });
      results.push({
        metricKey: "calendar.today",
        value: events.length,
        severity: null, // Informational, no alert
        category: "Calendar",
        message: `Today's schedule (${events.length} events):\n${eventList.join("\n")}`,
        metadata: { eventCount: events.length, events: eventList },
      });
    }
  } catch (err) {
    warn("monitor", `Calendar check failed: ${err}`);
  }
  return results;
}

// ============================================================
// CHECK REGISTRY
// ============================================================

function registerChecks(): void {
  checkRegistry.length = 0;

  // FAST (5 min)
  checkRegistry.push({
    key: "pipeline.new_leads",
    schedule: "fast",
    enabled: true,
    run: checkNewLeads,
  });
  checkRegistry.push({
    key: "reviews.new_review",
    schedule: "fast",
    enabled: true,
    run: checkNewReviews,
  });
  checkRegistry.push({
    key: "email.urgent",
    schedule: "fast",
    enabled: true,
    run: checkUrgentEmails,
  });

  // MEDIUM (15 min)
  checkRegistry.push({
    key: "pipeline.changes",
    schedule: "medium",
    enabled: true,
    run: checkPipelineChanges,
  });
  checkRegistry.push({
    key: "pipeline.speed_to_lead",
    schedule: "medium",
    enabled: false, // Disabled 2026-03-09: endpoint removed from dashboard, was causing OPEN circuit breaker noise
    run: checkSpeedToLead,
  });

  // SLOW (60 min)
  checkRegistry.push({
    key: "ads.cpl_7d",
    schedule: "slow",
    enabled: true,
    run: checkAdMetrics,
  });
  checkRegistry.push({
    key: "financial.health",
    schedule: "slow",
    enabled: true,
    run: checkFinancialHealth,
  });
  checkRegistry.push({
    key: "website.traffic",
    schedule: "slow",
    enabled: true,
    run: checkWebsiteTraffic,
  });
  checkRegistry.push({
    key: "website.conversion_rate",
    schedule: "slow",
    enabled: true,
    run: checkWebsiteConversionRate,
  });
  checkRegistry.push({
    key: "reviews.health",
    schedule: "slow",
    enabled: true,
    run: checkReviewHealth,
  });

  // DAILY
  checkRegistry.push({
    key: "calendar.today",
    schedule: "daily",
    enabled: true,
    run: checkCalendarToday,
  });
}

// ============================================================
// CORE ENGINE
// ============================================================

export async function runMonitorTick(
  supabase: SupabaseClient,
  schedule: MonitorScheduleTier,
): Promise<{
  checksRun: number;
  alertsEmitted: number;
  snapshotsRecorded: number;
}> {
  if (!initialized) {
    initMonitor();
  }

  const snapshotsBefore = totalSnapshotsRecorded;
  let checksRun = 0;
  let alertsEmitted = 0;

  // Filter checks for this schedule tier
  const checks = checkRegistry.filter((c) => c.schedule === schedule && c.enabled);

  if (checks.length === 0) {
    return { checksRun: 0, alertsEmitted: 0, snapshotsRecorded: 0 };
  }

  // Run all checks in parallel
  const settledResults = await Promise.allSettled(
    checks.map(async (check) => {
      const startMs = Date.now();
      try {
        const results = await check.run(supabase);
        state.lastRunByCheck[check.key] = Date.now();
        checksRun++;
        return results;
      } catch (err) {
        warn("monitor", `Check ${check.key} threw: ${err}`);
        state.lastRunByCheck[check.key] = Date.now();
        checksRun++;
        return [] as MonitorResult[];
      }
    }),
  );

  // Process results: emit alerts for non-null severity
  for (const settled of settledResults) {
    if (settled.status !== "fulfilled") continue;
    const results = settled.value;

    for (const result of results) {
      if (result.severity === null) continue;

      // Attempt severity escalation for persistent issues
      const escalatedSeverity = await checkEscalation(
        supabase,
        `monitor:${result.metricKey}`,
        result.severity,
      );

      const emitResult = await emit(supabase, {
        source: "monitor",
        severity: escalatedSeverity,
        category: result.category || "General",
        message: result.message || `${result.metricKey}: ${result.value}`,
        metadata: result.metadata,
        dedupKey: `monitor:${result.metricKey}`,
      });

      if (emitResult.stored) {
        alertsEmitted++;
        totalAlertsEmitted++;
      }
    }
  }

  // Save state after tick
  saveState();
  lastTickTime = Date.now();
  totalChecksRun += checksRun;

  const snapshotsThisTick = totalSnapshotsRecorded - snapshotsBefore;

  if (checksRun > 0) {
    info(
      "monitor",
      `Tick [${schedule}]: ${checksRun} checks, ${alertsEmitted} alerts, ${snapshotsThisTick} snapshots`,
    );
  }

  return {
    checksRun,
    alertsEmitted,
    snapshotsRecorded: snapshotsThisTick,
  };
}

export async function runCheckByKey(
  supabase: SupabaseClient,
  key: string,
): Promise<MonitorResult[]> {
  if (!initialized) initMonitor();

  const check = checkRegistry.find((c) => c.key === key);
  if (!check) {
    warn("monitor", `Check not found: ${key}`);
    return [];
  }

  try {
    return await check.run(supabase);
  } catch (err) {
    warn("monitor", `Check ${key} failed: ${err}`);
    return [];
  }
}

// ============================================================
// PROACTIVE INSIGHTS (injected into buildPrompt)
// ============================================================

export async function getProactiveInsights(supabase: SupabaseClient): Promise<string> {
  try {
    // Query recent alerts: undelivered OR delivered within last 2 hours
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();

    const { data, error } = await supabase
      .from("alerts")
      .select("severity, category, message, delivered, created_at")
      .or(`delivered.eq.false,and(delivered.eq.true,created_at.gte.${twoHoursAgo})`)
      .eq("suppressed", false)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error || !data || data.length === 0) return "";

    const lines: string[] = ["Since your last message:"];

    for (const alert of data) {
      const icon = alert.severity === "critical" || alert.severity === "warning" ? "[!]" : "[i]";
      lines.push(`- ${icon} ${alert.message}`);
    }

    const output = lines.join("\n");
    // Cap at 1500 chars
    return output.length > 1500 ? output.substring(0, 1497) + "..." : output;
  } catch (err) {
    warn("monitor", `Proactive insights query failed: ${err}`);
    return "";
  }
}

// ============================================================
// ANTICIPATORY CONTEXT
// ============================================================

export async function getAnticipatoryContext(supabase: SupabaseClient): Promise<string> {
  const parts: string[] = [];

  try {
    // Get current hour in Arizona timezone
    const now = new Date();
    const hourStr = now.toLocaleString("en-US", {
      timeZone: TIMEZONE,
      hour: "numeric",
      hour12: false,
    });
    const hour = parseInt(hourStr, 10);
    const dayOfWeek = parseInt(
      now.toLocaleString("en-US", { timeZone: TIMEZONE, weekday: "narrow" }),
      10,
    );
    const dayName = now.toLocaleDateString("en-US", { timeZone: TIMEZONE, weekday: "long" });

    // Monday morning: weekend recap hint
    if (dayName === "Monday" && hour >= 6 && hour <= 10) {
      parts.push("Weekend recap available. Ask for /executive or /alerts to catch up.");
    }

    // Morning hours: show today's schedule
    if (hour >= 6 && hour <= 10 && isGoogleEnabled()) {
      try {
        const events = await listTodayEvents();
        if (events.length > 0) {
          const eventLines = events.map((e: CalEvent) => {
            const who = e.attendees?.length ? ` (with ${e.attendees.join(", ")})` : "";
            return `  ${e.start} ${e.title}${who}`;
          });
          parts.push(`Today's appointments (${events.length}):\n${eventLines.join("\n")}`);
        }
      } catch {
        // Non-critical
      }
    }

    // Pre-meeting context: check if appointment in next 30 min
    if (isGoogleEnabled()) {
      try {
        const events = await listTodayEvents();
        const nowMs = Date.now();

        for (const e of events) {
          // Parse the event start time for comparison
          // Events come formatted as "HH:MM AM/PM"
          const todayStr = now.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
          const eventDateTime = new Date(`${todayStr} ${e.start}`);
          const diffMs = eventDateTime.getTime() - nowMs;

          if (diffMs > 0 && diffMs <= 30 * 60_000) {
            const minsUntil = Math.round(diffMs / 60_000);
            const who = e.attendees?.length ? ` with ${e.attendees.join(", ")}` : "";
            parts.push(`Upcoming in ${minsUntil} min: ${e.title}${who}`);
          }
        }
      } catch {
        // Non-critical
      }
    }
  } catch (err) {
    warn("monitor", `Anticipatory context failed: ${err}`);
  }

  return parts.length > 0 ? parts.join("\n") : "";
}

// ============================================================
// STATUS
// ============================================================

export function getMonitorStatus(): string {
  const lines: string[] = ["MONITOR STATUS"];

  // Overall stats
  lines.push(
    `\nTotal checks run: ${totalChecksRun}`,
    `Total alerts emitted: ${totalAlertsEmitted}`,
    `Total snapshots recorded: ${totalSnapshotsRecorded}`,
  );

  if (lastTickTime > 0) {
    const lastTickAgo = Math.round((Date.now() - lastTickTime) / 1000);
    lines.push(`Last tick: ${lastTickAgo}s ago`);
  }

  // Per-check last run times
  lines.push("\nCheck last-run times:");
  const sortedChecks = [...checkRegistry].sort((a, b) => {
    const scheduleOrder: Record<MonitorScheduleTier, number> = {
      fast: 0,
      medium: 1,
      slow: 2,
      daily: 3,
    };
    return scheduleOrder[a.schedule] - scheduleOrder[b.schedule];
  });

  for (const check of sortedChecks) {
    const lastRun = state.lastRunByCheck[check.key];
    const ago = lastRun ? `${Math.round((Date.now() - lastRun) / 60_000)}m ago` : "never";
    const enabled = check.enabled ? "" : " (disabled)";
    lines.push(`  [${check.schedule}] ${check.key}: ${ago}${enabled}`);
  }

  // State info
  lines.push(`\nLead check cursor: ${state.lastLeadCheckTime}`);
  lines.push(`Review count baseline: ${state.lastReviewCount}`);
  lines.push(`Pending warnings: ${state.pendingWarnings.length}`);

  return lines.join("\n");
}

// ============================================================
// INITIALIZATION
// ============================================================

export function initMonitor(): void {
  if (initialized) return;

  loadState();
  registerChecks();
  initialized = true;

  info("monitor", `Initialized with ${checkRegistry.length} checks registered`);
}
