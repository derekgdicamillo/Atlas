/**
 * Atlas — Unified Executive Intelligence
 *
 * Phase 5: Cross-source analytics that ties the full funnel together.
 * Pulls from dashboard (financials, pipeline, attribution), GHL (ops),
 * Meta (ad spend), GBP (reviews, visibility), and GA4 (traffic).
 *
 * Key outputs:
 *   1. Full-funnel report: $1 ad spend -> lead -> consult -> treatment -> revenue -> profit
 *   2. Cross-source anomaly alerts (combines all data sources)
 *   3. Weekly executive summary push (Sunday evening)
 *   4. Provider/channel scorecards
 */

import { info, warn, error as logError } from "./logger.ts";
import {
  isDashboardReady,
  getFinancials,
  getPipeline,
  getOverview,
  getSpeedToLead,
  getAttribution,
  detectFinancialAnomalies,
  type FinancialSnapshot,
  type PipelineSnapshot,
  type OverviewSnapshot,
  type SpeedToLeadSnapshot,
  type AttributionSnapshot,
} from "./dashboard.ts";
import {
  isGHLReady,
  getOpsSnapshot,
  type OpsSnapshot,
} from "./ghl.ts";
import {
  isMetaReady,
  getAccountSummary,
  type AccountSummary,
} from "./meta.ts";
import {
  isGBPReady,
  getReviewSummary,
  getPerformanceMetrics,
  type GBPReviewSummary,
  type GBPPerformanceMetrics,
} from "./gbp.ts";
import {
  isGA4Ready,
  getOverview as getGA4Overview,
  type GA4Overview,
} from "./analytics.ts";

// ============================================================
// TYPES
// ============================================================

export interface FullFunnel {
  period: string;
  // Top of funnel (marketing)
  adSpend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  websiteVisitors: number;
  gbpImpressions: number;
  // Middle of funnel (pipeline)
  totalLeads: number;
  cpl: number;
  consultsScheduled: number;
  noShows: number;
  showRate: number;
  speedToLeadMinutes: number;
  // Bottom of funnel (conversion)
  patientsWon: number;
  patientsLost: number;
  closeRate: number;
  cac: number;
  // Revenue (financials)
  revenue: number;
  cogs: number;
  netIncome: number;
  profitMargin: number;
  roas: number; // revenue / ad spend
  // Efficiency ratios
  revenuePerPatient: number;
  profitPerPatient: number;
  leadToCloseRate: number; // leads -> won
  clickToLeadRate: number; // clicks -> leads
}

export interface ExecutiveAlert {
  severity: "critical" | "warning" | "info";
  category: string;
  message: string;
}

export interface ChannelScorecard {
  source: string;
  leads: number;
  won: number;
  lost: number;
  open: number;
  closeRate: number;
  totalValue: number;
  efficiency: string; // "high" | "medium" | "low"
}

export interface WeeklySummary {
  funnel: FullFunnel;
  alerts: ExecutiveAlert[];
  channels: ChannelScorecard[];
  reviewPulse: string;
  keyInsights: string[];
}

// ============================================================
// FULL-FUNNEL BUILDER
// ============================================================

export async function buildFullFunnel(period = "month"): Promise<FullFunnel> {
  // Pull all data sources in parallel. Each one is optional.
  const [overview, pipeline, financials, stl, ops, ads, gbpMetrics, ga4] = await Promise.all([
    isDashboardReady() ? getOverview(period).catch(() => null) : Promise.resolve(null),
    isDashboardReady() ? getPipeline(period).catch(() => null) : Promise.resolve(null),
    isDashboardReady() ? getFinancials(period).catch(() => null) : Promise.resolve(null),
    isDashboardReady() ? getSpeedToLead(period).catch(() => null) : Promise.resolve(null),
    isGHLReady() ? getOpsSnapshot().catch(() => null) : Promise.resolve(null),
    isMetaReady() ? getAccountSummary(period === "week" ? "7d" : "30d").catch(() => null) : Promise.resolve(null),
    isGBPReady() ? getPerformanceMetrics(period === "week" ? 7 : 30).catch(() => null) : Promise.resolve(null),
    isGA4Ready() ? getGA4Overview(period === "week" ? 7 : 30).catch(() => null) : Promise.resolve(null),
  ]);

  const adSpend = ads?.spend ?? overview?.adSpend ?? 0;
  const impressions = ads?.impressions ?? overview?.impressions ?? 0;
  const clicks = ads?.clicks ?? overview?.clicks ?? 0;
  const ctr = ads?.ctr ?? overview?.ctr ?? 0;
  const totalLeads = overview?.totalLeads ?? ops?.recentLeads ?? 0;
  const cpl = adSpend > 0 && totalLeads > 0 ? adSpend / totalLeads : (ads?.cpl ?? overview?.cpl ?? 0);
  const consultsScheduled = pipeline?.metrics.consultScheduled ?? overview?.consultScheduled ?? 0;
  const noShows = pipeline?.metrics.noShowCount ?? ops?.noShowsThisWeek ?? 0;
  const showRate = pipeline?.metrics.showRate ?? overview?.showRate ?? 0;
  const stlMinutes = stl?.summary.medianMinutes ?? 0;
  const patientsWon = pipeline?.metrics.wonCount ?? overview?.wonCount ?? 0;
  const patientsLost = pipeline?.metrics.lostCount ?? overview?.lostCount ?? 0;
  const closeRate = pipeline?.metrics.closeRate ?? overview?.closeRate ?? 0;
  const revenue = financials?.currentMonth?.revenue ?? 0;
  const cogs = financials?.currentMonth?.cogs ?? 0;
  const netIncome = financials?.currentMonth?.netIncome ?? 0;
  const profitMargin = financials?.currentMonth?.profitMargin ?? 0;
  const cac = financials?.unitEconomics?.cac ?? (adSpend > 0 && patientsWon > 0 ? adSpend / patientsWon : 0);
  const roas = adSpend > 0 && revenue > 0 ? revenue / adSpend : 0;
  const revenuePerPatient = patientsWon > 0 ? revenue / patientsWon : 0;
  const profitPerPatient = patientsWon > 0 ? netIncome / patientsWon : 0;
  const leadToCloseRate = totalLeads > 0 ? patientsWon / totalLeads : 0;
  const clickToLeadRate = clicks > 0 ? totalLeads / clicks : 0;

  return {
    period,
    adSpend,
    impressions,
    clicks,
    ctr,
    websiteVisitors: ga4?.sessions ?? 0,
    gbpImpressions: gbpMetrics?.businessImpressions ?? 0,
    totalLeads,
    cpl,
    consultsScheduled,
    noShows,
    showRate,
    speedToLeadMinutes: stlMinutes,
    patientsWon,
    patientsLost,
    closeRate,
    cac,
    revenue,
    cogs,
    netIncome,
    profitMargin,
    roas,
    revenuePerPatient,
    profitPerPatient,
    leadToCloseRate,
    clickToLeadRate,
  };
}

// ============================================================
// CROSS-SOURCE ANOMALY ENGINE
// ============================================================

export async function detectAllAnomalies(): Promise<ExecutiveAlert[]> {
  const alerts: ExecutiveAlert[] = [];

  // Financial anomalies (from Phase 3)
  if (isDashboardReady()) {
    try {
      const financials = await getFinancials("month");
      const finAlerts = detectFinancialAnomalies(financials);
      for (const a of finAlerts) {
        alerts.push({ severity: "warning", category: "Financial", message: a });
      }
    } catch {}
  }

  // Pipeline anomalies
  if (isGHLReady()) {
    try {
      const ops = await getOpsSnapshot();
      if (ops.pipeline.staleCount > 5) {
        alerts.push({
          severity: "warning",
          category: "Pipeline",
          message: `${ops.pipeline.staleCount} stale leads sitting >7 days in early stages. Revenue leaking.`,
        });
      }
      if (ops.noShowsThisWeek > 3) {
        alerts.push({
          severity: "warning",
          category: "Pipeline",
          message: `${ops.noShowsThisWeek} no-shows this week. Automated reminders (72h/24h/2h) and no-show recovery are running. Check if GHL confirmation + reschedule workflows are active.`,
        });
      }
      if (ops.pipeline.showRate > 0 && ops.pipeline.showRate < 0.50) {
        alerts.push({
          severity: "critical",
          category: "Pipeline",
          message: `Show rate at ${(ops.pipeline.showRate * 100).toFixed(1)}%. Below 50% threshold. Review: (1) Are GHL reminder workflows firing? (2) Speed-to-lead on new bookings. (3) Pre-consult nurture content.`,
        });
      }
      if (ops.pipeline.closeRate < 0.2 && ops.pipeline.open > 10) {
        alerts.push({
          severity: "critical",
          category: "Pipeline",
          message: `Close rate at ${(ops.pipeline.closeRate * 100).toFixed(1)}% with ${ops.pipeline.open} open. Sales process needs attention.`,
        });
      }
    } catch {}
  }

  // Ad efficiency anomalies: handled by monitor.ts (checkAdMetrics) with
  // stable dedup keys and hourly schedule. Removed here to prevent dual-firing
  // that caused alert spam every 15 min. Ad data still flows into weekly
  // summary via buildFullFunnel().

  // Speed to lead alert
  if (isDashboardReady()) {
    try {
      const stl = await getSpeedToLead("week");
      if (stl.summary.medianMinutes > 30) {
        alerts.push({
          severity: "critical",
          category: "Operations",
          message: `Speed to lead: ${stl.summary.medianMinutes.toFixed(0)} min median. Leads contacted within 5 min convert 4x better.`,
        });
      }
    } catch {}
  }

  // Review alerts
  if (isGBPReady()) {
    try {
      const reviews = await getReviewSummary();
      if (reviews.unreplied > 3) {
        alerts.push({
          severity: "warning",
          category: "Reputation",
          message: `${reviews.unreplied} unreplied Google reviews. Hurts SEO and trust.`,
        });
      }
      if (reviews.averageRating < 4.5 && reviews.totalReviews > 10) {
        alerts.push({
          severity: "info",
          category: "Reputation",
          message: `Google rating at ${reviews.averageRating.toFixed(1)}/5.0. Target 4.8+ for competitive advantage.`,
        });
      }
    } catch {}
  }

  // Website traffic anomalies
  if (isGA4Ready()) {
    try {
      const ga4 = await getGA4Overview(7);
      if (ga4.bounceRate > 0.7 && ga4.sessions > 50) {
        alerts.push({
          severity: "warning",
          category: "Website",
          message: `Bounce rate at ${(ga4.bounceRate * 100).toFixed(0)}% (7d). Landing pages may need optimization.`,
        });
      }
      if (ga4.engagementRate < 0.3 && ga4.sessions > 50) {
        alerts.push({
          severity: "warning",
          category: "Website",
          message: `Engagement rate at ${(ga4.engagementRate * 100).toFixed(0)}% (7d). Content may not be resonating.`,
        });
      }
    } catch {}
  }

  // Lead volume trend: detect declining lead counts from lead-volume.json
  try {
    const { existsSync, readFileSync } = await import("fs");
    const { join } = await import("path");
    const volumePath = join(process.env.PROJECT_DIR || process.cwd(), "data", "lead-volume.json");
    if (existsSync(volumePath)) {
      const volumeLog = JSON.parse(readFileSync(volumePath, "utf-8")) as { date: string; count: number; weekAvg: number }[];
      if (volumeLog.length >= 7) {
        const recent7 = volumeLog.slice(-7);
        const prior7 = volumeLog.slice(-14, -7);
        if (prior7.length >= 7) {
          const recentTotal = recent7.reduce((sum, d) => sum + d.count, 0);
          const priorTotal = prior7.reduce((sum, d) => sum + d.count, 0);
          if (priorTotal > 0) {
            const change = (recentTotal - priorTotal) / priorTotal;
            if (change < -0.3) {
              alerts.push({
                severity: "warning",
                category: "Pipeline",
                message: "Lead volume trending down " + Math.abs(Math.round(change * 100)) + "% WoW (" + recentTotal + " vs " + priorTotal + " prior week). Check ad spend, landing page, and content distribution.",
              });
            }
          }
        }
        // Check for 3+ consecutive days with zero leads
        const recentZeroDays = recent7.filter(d => d.count === 0).length;
        if (recentZeroDays >= 3) {
          alerts.push({
            severity: "critical",
            category: "Pipeline",
            message: recentZeroDays + " zero-lead days in the past week. Something is broken in the lead generation funnel.",
          });
        }
      }
    }
  } catch {}

  // Sort: critical first, then warning, then info
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return alerts;
}

// ============================================================
// CHANNEL SCORECARDS
// ============================================================

export async function getChannelScorecards(): Promise<ChannelScorecard[]> {
  if (!isDashboardReady()) return [];

  try {
    const attr = await getAttribution("month");
    return attr.bySource.map((s) => {
      let efficiency: "high" | "medium" | "low" = "medium";
      if (s.closeRate > 0.4) efficiency = "high";
      else if (s.closeRate < 0.15) efficiency = "low";

      return {
        source: s.source || "(direct)",
        leads: s.total,
        won: s.won,
        lost: s.lost,
        open: s.open,
        closeRate: s.closeRate,
        totalValue: s.totalValue,
        efficiency,
      };
    }).sort((a, b) => b.won - a.won);
  } catch (err) {
    warn("executive", `Channel scorecards failed: ${err}`);
    return [];
  }
}

// ============================================================
// WEEKLY EXECUTIVE SUMMARY
// ============================================================

export async function buildWeeklySummary(): Promise<WeeklySummary> {
  const [funnel, alerts, channels] = await Promise.all([
    buildFullFunnel("week"),
    detectAllAnomalies(),
    getChannelScorecards(),
  ]);

  // Review pulse
  let reviewPulse = "";
  if (isGBPReady()) {
    try {
      const reviews = await getReviewSummary();
      reviewPulse = `${reviews.averageRating.toFixed(1)}/5 (${reviews.totalReviews} reviews, ${reviews.reviewVelocity} this month)`;
      if (reviews.unreplied > 0) reviewPulse += `, ${reviews.unreplied} unreplied`;
    } catch {}
  }

  // Generate key insights from the data
  const keyInsights = generateInsights(funnel, alerts, channels);

  return { funnel, alerts, channels, reviewPulse, keyInsights };
}

function generateInsights(funnel: FullFunnel, alerts: ExecutiveAlert[], channels: ChannelScorecard[]): string[] {
  const insights: string[] = [];

  // ROAS insight
  if (funnel.roas > 0) {
    if (funnel.roas >= 5) {
      insights.push(`Strong ROAS at ${funnel.roas.toFixed(1)}x. Every $1 in ads generates $${funnel.roas.toFixed(2)} in revenue.`);
    } else if (funnel.roas >= 3) {
      insights.push(`Healthy ROAS at ${funnel.roas.toFixed(1)}x. Room to scale ad spend.`);
    } else if (funnel.roas < 2) {
      insights.push(`ROAS at ${funnel.roas.toFixed(1)}x is below target. Optimize campaigns or cut underperformers.`);
    }
  }

  // Funnel leakage
  if (funnel.totalLeads > 0 && funnel.patientsWon > 0) {
    const conversionPct = (funnel.leadToCloseRate * 100).toFixed(0);
    const leadsLost = funnel.totalLeads - funnel.patientsWon - (funnel.patientsLost || 0);
    if (funnel.leadToCloseRate < 0.15) {
      insights.push(`Only ${conversionPct}% of leads convert. ${leadsLost} leads are in limbo. Tighten follow-up.`);
    }
  }

  // Speed to lead
  if (funnel.speedToLeadMinutes > 0) {
    if (funnel.speedToLeadMinutes <= 5) {
      insights.push(`Speed to lead is excellent at ${funnel.speedToLeadMinutes.toFixed(0)} min. Keep it up.`);
    } else if (funnel.speedToLeadMinutes > 15) {
      insights.push(`Speed to lead at ${funnel.speedToLeadMinutes.toFixed(0)} min. Every minute over 5 drops conversion 10%.`);
    }
  }

  // Profit per patient
  if (funnel.profitPerPatient > 0) {
    insights.push(`Profit per patient: $${funnel.profitPerPatient.toFixed(0)}. CAC of $${funnel.cac.toFixed(0)} means ${(funnel.profitPerPatient / funnel.cac).toFixed(1)}x payback.`);
  }

  // Best channel
  if (channels.length > 0) {
    const best = channels[0];
    if (best.won > 0) {
      insights.push(`Top channel: ${best.source} (${best.won} won, ${(best.closeRate * 100).toFixed(0)}% close rate).`);
    }
  }

  // Critical alert count
  const criticalCount = alerts.filter((a) => a.severity === "critical").length;
  if (criticalCount > 0) {
    insights.push(`${criticalCount} critical alert${criticalCount > 1 ? "s" : ""} need immediate attention.`);
  }

  return insights;
}

// ============================================================
// FORMATTERS
// ============================================================

function usd(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatFullFunnel(f: FullFunnel): string {
  const periodLabel = f.period === "week" ? "This Week" : "This Month";
  const lines: string[] = [`FULL-FUNNEL REPORT (${periodLabel})`];

  // Top of funnel
  lines.push(
    `\n--- AWARENESS ---`,
    `Ad spend: ${usd(f.adSpend)}`,
    `Impressions: ${f.impressions.toLocaleString()} | Clicks: ${f.clicks.toLocaleString()} | CTR: ${pct(f.ctr)}`,
  );
  if (f.websiteVisitors > 0) lines.push(`Website visitors: ${f.websiteVisitors.toLocaleString()}`);
  if (f.gbpImpressions > 0) lines.push(`GBP impressions: ${f.gbpImpressions.toLocaleString()}`);

  // Middle of funnel
  lines.push(
    `\n--- ACQUISITION ---`,
    `Leads: ${f.totalLeads} | CPL: ${usd(f.cpl)}`,
  );
  if (f.clicks > 0 && f.totalLeads > 0) {
    lines.push(`Click-to-lead rate: ${pct(f.clickToLeadRate)}`);
  }
  if (f.consultsScheduled > 0) {
    lines.push(`Consults scheduled: ${f.consultsScheduled}`);
  }
  if (f.speedToLeadMinutes > 0) {
    lines.push(`Speed to lead: ${f.speedToLeadMinutes.toFixed(0)} min (median)`);
  }
  if (f.noShows > 0) {
    lines.push(`No-shows: ${f.noShows} | Show rate: ${pct(f.showRate)}`);
  }

  // Bottom of funnel
  lines.push(
    `\n--- CONVERSION ---`,
    `Won: ${f.patientsWon} | Lost: ${f.patientsLost} | Close rate: ${pct(f.closeRate)}`,
    `Lead-to-close: ${pct(f.leadToCloseRate)}`,
    `CAC: ${usd(f.cac)}`,
  );

  // Revenue
  if (f.revenue > 0) {
    lines.push(
      `\n--- REVENUE ---`,
      `Revenue: ${usd(f.revenue)} | COGS: ${usd(f.cogs)}`,
      `Net income: ${usd(f.netIncome)} (${pct(f.profitMargin)} margin)`,
      `ROAS: ${f.roas.toFixed(1)}x`,
    );
    if (f.patientsWon > 0) {
      lines.push(
        `Revenue/patient: ${usd(f.revenuePerPatient)} | Profit/patient: ${usd(f.profitPerPatient)}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatAlerts(alerts: ExecutiveAlert[]): string {
  if (alerts.length === 0) return "No alerts. All systems healthy.";

  const icons = { critical: "🔴", warning: "🟡", info: "🔵" };
  const lines: string[] = [`ALERTS (${alerts.length})`];

  for (const a of alerts) {
    lines.push(`${icons[a.severity]} [${a.category}] ${a.message}`);
  }

  return lines.join("\n");
}

export function formatChannelScorecards(channels: ChannelScorecard[]): string {
  if (channels.length === 0) return "No channel data available.";

  const lines: string[] = ["CHANNEL SCORECARDS"];
  for (const c of channels) {
    const effIcon = c.efficiency === "high" ? "▲" : c.efficiency === "low" ? "▼" : "●";
    lines.push(
      `\n${effIcon} ${c.source}`,
      `  Leads: ${c.leads} | Won: ${c.won} | Lost: ${c.lost} | Open: ${c.open}`,
      `  Close rate: ${pct(c.closeRate)}${c.totalValue > 0 ? ` | Value: ${usd(c.totalValue)}` : ""}`,
    );
  }

  return lines.join("\n");
}

export function formatWeeklySummary(summary: WeeklySummary): string {
  const sections: string[] = [];

  // Key insights first
  if (summary.keyInsights.length > 0) {
    sections.push("KEY INSIGHTS\n" + summary.keyInsights.map((i) => `  • ${i}`).join("\n"));
  }

  // Alerts
  if (summary.alerts.length > 0) {
    sections.push(formatAlerts(summary.alerts));
  }

  // Full funnel
  sections.push(formatFullFunnel(summary.funnel));

  // Channels
  if (summary.channels.length > 0) {
    sections.push(formatChannelScorecards(summary.channels));
  }

  // Reviews
  if (summary.reviewPulse) {
    sections.push(`GOOGLE REVIEWS: ${summary.reviewPulse}`);
  }

  return `WEEKLY EXECUTIVE SUMMARY\n${"═".repeat(30)}\n\n${sections.join("\n\n")}`;
}

// ============================================================
// QUICK EXECUTIVE CONTEXT (for Claude's prompt)
// ============================================================

export async function getExecutiveContext(): Promise<string> {
  // Only generate if we have at least dashboard data
  if (!isDashboardReady()) return "";

  try {
    const funnel = await buildFullFunnel("month");

    const parts: string[] = [];

    if (funnel.roas > 0) {
      parts.push(`ROAS: ${funnel.roas.toFixed(1)}x`);
    }
    if (funnel.leadToCloseRate > 0) {
      parts.push(`Lead-to-close: ${pct(funnel.leadToCloseRate)}`);
    }
    if (funnel.cac > 0 && funnel.revenuePerPatient > 0) {
      parts.push(`CAC: ${usd(funnel.cac)} vs Rev/patient: ${usd(funnel.revenuePerPatient)}`);
    }
    if (funnel.profitPerPatient > 0) {
      parts.push(`Profit/patient: ${usd(funnel.profitPerPatient)}`);
    }

    return parts.length > 0 ? `EXEC: ${parts.join(" | ")}` : "";
  } catch {
    return "";
  }
}
