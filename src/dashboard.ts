/**
 * Atlas — PV Dashboard Integration
 *
 * Primary data source: Supabase business_scorecard table.
 * Secondary: GHL ops snapshot (for pipeline stage detail).
 * Fallback: Dashboard API (legacy, endpoints removed 2026-03-08).
 *
 * All exported types and function signatures are preserved so that
 * executive.ts, monitor.ts, relay.ts, and MCP consumers work unchanged.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn, error as logError } from "./logger.ts";
import { dashboardBreaker } from "./circuit-breaker.ts";
import { isGHLReady, getOpsSnapshot } from "./ghl.ts";

const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://pv-dashboard-ten.vercel.app";
const API_TOKEN = process.env.DASHBOARD_API_TOKEN || "";

// Supabase client, set by relay.ts at startup via setDashboardSupabase()
let _supabase: SupabaseClient | null = null;

// ============================================================
// TYPES (unchanged — all consumers depend on these)
// ============================================================

export interface FinancialSnapshot {
  authenticated: boolean;
  error?: string;
  currentMonth?: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    expenses: number;
    netIncome: number;
    profitMargin: number;
    expenseBreakdown: { name: string; amount: number }[];
    revenueBreakdown: { name: string; amount: number }[];
    period: { start: string; end: string };
  };
  lastMonth?: {
    name: string;
    revenue: number;
    cogs: number;
    grossProfit: number;
    expenses: number;
    netIncome: number;
    profitMargin: number;
    period: { start: string; end: string };
  };
  ytd?: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    expenses: number;
    netIncome: number;
    profitMargin: number;
  };
  balance?: {
    cashOnHand: number;
    totalAssets: number;
    totalLiabilities: number;
    equity: number;
  };
  monthlyTrend?: { month: string; revenue: number; expenses: number; profit: number }[];
  unitEconomics?: {
    cac: number;
    wonCount: number;
    closeRate: number;
    cpl: number;
    adSpend: number;
  };
}

export interface PipelineSnapshot {
  pipelineName: string;
  stages: { stageName: string; count: number; monetaryValue: number; percentage: number }[];
  metrics: {
    totalOpportunities: number;
    wonCount: number;
    lostCount: number;
    closeRate: number;
    consultScheduled: number;
    noShowCount: number;
    showRate: number;
    totalMonetaryValue: number;
    avgDealValue: number;
  };
  staleLeads: { count: number; threshold: number };
}

export interface OverviewSnapshot {
  period: { start: string; end: string; label: string };
  totalLeads: number;
  newLeadsThisWeek: number;
  newLeadsThisMonth: number;
  adSpend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpl: number;
  totalOpportunities: number;
  wonCount: number;
  lostCount: number;
  closeRate: number;
  consultScheduled: number;
  noShowCount: number;
  showRate: number;
  formSubmits: number;
  costPerWon: number;
}

export interface SpeedToLeadSnapshot {
  totalOpportunities: number;
  withResponseData: number;
  summary: {
    avgMinutes: number;
    medianMinutes: number;
    under5min: number;
    under5minPct: number;
    under30min: number;
    under60min: number;
    avgWonMinutes: number;
    avgLostMinutes: number;
  };
}

export interface AttributionSnapshot {
  totalOpportunities: number;
  bySource: {
    source: string;
    total: number;
    won: number;
    lost: number;
    open: number;
    closeRate: number;
    totalValue: number;
  }[];
  stageAging: {
    count: number;
    avgDays: number;
  };
}

// ============================================================
// INIT
// ============================================================

/**
 * Set the Supabase client for direct scorecard queries.
 * Called by relay.ts at startup.
 */
export function setDashboardSupabase(client: SupabaseClient): void {
  _supabase = client;
  info("dashboard", "Supabase client set for direct scorecard queries");
}

export function isDashboardReady(): boolean {
  return !!_supabase || !!API_TOKEN;
}

export function initDashboard(): boolean {
  if (_supabase) {
    info("dashboard", "Dashboard ready via Supabase direct connection");
    return true;
  }
  if (!API_TOKEN) {
    warn("dashboard", "No Supabase or DASHBOARD_API_TOKEN. Dashboard integration disabled.");
    return false;
  }
  info("dashboard", `Dashboard integration ready: ${DASHBOARD_URL}`);
  return true;
}

export async function checkDashboardHealth(): Promise<boolean> {
  if (_supabase) {
    try {
      const { error } = await _supabase
        .from("business_scorecard")
        .select("date")
        .eq("period_type", "monthly")
        .limit(1);
      return !error;
    } catch { return false; }
  }
  return false;
}

// ============================================================
// SUPABASE SCORECARD QUERIES
// ============================================================

interface ScorecardRow {
  date: string;
  period_type: string;
  revenue: number | null;
  cogs: number | null;
  gross_margin: number | null;
  net_income: number | null;
  net_margin: number | null;
  cash_on_hand: number | null;
  active_patients: number | null;
  mrr: number | null;
  new_patients: number | null;
  cancellations: number | null;
  churn_rate: number | null;
  annual_churn: number | null;
  avg_tenure_months: number | null;
  median_tenure_months: number | null;
  ltv: number | null;
  leads: number | null;
  ad_spend: number | null;
  cpl: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  lp_views: number | null;
  show_rate: number | null;
  close_rate: number | null;
  cac: number | null;
  ltv_cac_ratio: number | null;
  pipeline_total: number | null;
  pipeline_open: number | null;
  pipeline_won: number | null;
  pipeline_lost: number | null;
  pipeline_noshow: number | null;
  metadata: Record<string, unknown> | null;
}

function num(v: number | null | undefined): number {
  return v ?? 0;
}

async function getLatestMonthly(): Promise<ScorecardRow | null> {
  if (!_supabase) return null;
  const { data, error } = await _supabase
    .from("business_scorecard")
    .select("*")
    .eq("period_type", "monthly")
    .order("date", { ascending: false })
    .limit(1)
    .single();
  if (error || !data) return null;
  return data as ScorecardRow;
}

async function getMonthlyHistory(months = 6): Promise<ScorecardRow[]> {
  if (!_supabase) return [];
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const { data, error } = await _supabase
    .from("business_scorecard")
    .select("*")
    .eq("period_type", "monthly")
    .gte("date", cutoff.toISOString().split("T")[0])
    .order("date", { ascending: true });
  if (error || !data) return [];
  return data as ScorecardRow[];
}

async function getDailyAgg(days = 30): Promise<{
  totalLeads: number;
  totalAdSpend: number;
  avgCpl: number;
  avgShowRate: number;
  avgCloseRate: number;
  totalImpressions: number;
  totalClicks: number;
  avgCtr: number;
  totalWon: number;
  totalLost: number;
  totalNoShow: number;
}> {
  if (!_supabase) return {
    totalLeads: 0, totalAdSpend: 0, avgCpl: 0, avgShowRate: 0,
    avgCloseRate: 0, totalImpressions: 0, totalClicks: 0, avgCtr: 0,
    totalWon: 0, totalLost: 0, totalNoShow: 0,
  };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const { data, error } = await _supabase
    .from("business_scorecard")
    .select("*")
    .eq("period_type", "daily")
    .gte("date", cutoff.toISOString().split("T")[0])
    .order("date", { ascending: true });

  if (error || !data || data.length === 0) return {
    totalLeads: 0, totalAdSpend: 0, avgCpl: 0, avgShowRate: 0,
    avgCloseRate: 0, totalImpressions: 0, totalClicks: 0, avgCtr: 0,
    totalWon: 0, totalLost: 0, totalNoShow: 0,
  };

  const rows = data as ScorecardRow[];
  const sum = (fn: (r: ScorecardRow) => number) => rows.reduce((acc, r) => acc + fn(r), 0);
  const avg = (fn: (r: ScorecardRow) => number) => {
    const vals = rows.map(fn).filter(v => v > 0);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };

  return {
    totalLeads: sum(r => num(r.leads)),
    totalAdSpend: sum(r => num(r.ad_spend)),
    avgCpl: avg(r => num(r.cpl)),
    avgShowRate: avg(r => num(r.show_rate)),
    avgCloseRate: avg(r => num(r.close_rate)),
    totalImpressions: sum(r => num(r.impressions)),
    totalClicks: sum(r => num(r.clicks)),
    avgCtr: avg(r => num(r.ctr)),
    totalWon: sum(r => num(r.pipeline_won)),
    totalLost: sum(r => num(r.pipeline_lost)),
    totalNoShow: sum(r => num(r.pipeline_noshow)),
  };
}

// ============================================================
// LEGACY DASHBOARD API FETCH (fallback only)
// ============================================================

async function dashboardFetchRaw<T>(path: string, params?: Record<string, string>): Promise<T> {
  if (!API_TOKEN) throw new Error("Dashboard API token not configured");

  const url = new URL(path, DASHBOARD_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(dashboardBreaker.getTimeoutMs()),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dashboard API ${path} returned ${res.status}: ${body.substring(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

async function dashboardFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  return dashboardBreaker.exec(() => dashboardFetchRaw<T>(path, params));
}

// ============================================================
// DATA FETCHERS — Supabase first, legacy API fallback
// ============================================================

export async function getFinancials(_period = "month"): Promise<FinancialSnapshot> {
  // Try Supabase scorecard first
  if (_supabase) {
    try {
      const [current, history] = await Promise.all([
        getLatestMonthly(),
        getMonthlyHistory(6),
      ]);

      if (current) {
        const revenue = num(current.revenue);
        const cogs = num(current.cogs);
        const grossProfit = revenue - cogs;
        const netIncome = num(current.net_income);
        const profitMargin = revenue > 0 ? netIncome / revenue : 0;
        const expenses = revenue - netIncome - cogs; // opex approximation

        const snapshot: FinancialSnapshot = {
          authenticated: true,
          currentMonth: {
            revenue,
            cogs,
            grossProfit,
            expenses,
            netIncome,
            profitMargin,
            expenseBreakdown: (current.metadata?.expense_breakdown as { name: string; amount: number }[]) || [],
            revenueBreakdown: [],
            period: {
              start: current.date,
              end: current.date.replace(/-01$/, "-30"),
            },
          },
          balance: {
            cashOnHand: num(current.cash_on_hand),
            totalAssets: 0,
            totalLiabilities: 0,
            equity: 0,
          },
          unitEconomics: {
            cac: num(current.cac),
            wonCount: num(current.new_patients),
            closeRate: num(current.close_rate) / 100, // scorecard stores as pct, type expects decimal
            cpl: num(current.cpl),
            adSpend: num(current.ad_spend),
          },
        };

        // Previous month for MoM comparison
        if (history.length >= 2) {
          const prev = history[history.length - 2];
          if (prev && prev.date !== current.date) {
            const prevRevenue = num(prev.revenue);
            const prevCogs = num(prev.cogs);
            const prevNetIncome = num(prev.net_income);
            const prevMargin = prevRevenue > 0 ? prevNetIncome / prevRevenue : 0;
            const monthName = new Date(prev.date + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });
            snapshot.lastMonth = {
              name: monthName,
              revenue: prevRevenue,
              cogs: prevCogs,
              grossProfit: prevRevenue - prevCogs,
              expenses: prevRevenue - prevNetIncome - prevCogs,
              netIncome: prevNetIncome,
              profitMargin: prevMargin,
              period: { start: prev.date, end: prev.date.replace(/-01$/, "-30") },
            };
          }
        }

        // Monthly trend
        if (history.length > 1) {
          snapshot.monthlyTrend = history.map(r => {
            const rev = num(r.revenue);
            const ni = num(r.net_income);
            const monthLabel = new Date(r.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" });
            return {
              month: monthLabel,
              revenue: rev,
              expenses: rev - ni - num(r.cogs),
              profit: ni,
            };
          });
        }

        return snapshot;
      }
    } catch (err) {
      warn("dashboard", `Supabase financials failed, trying legacy: ${err}`);
    }
  }

  // Legacy fallback
  if (API_TOKEN) {
    return dashboardFetch<FinancialSnapshot>("/api/metrics/financials", { period: _period });
  }

  return { authenticated: false, error: "No data source available" };
}

export async function getPipeline(_period = "month"): Promise<PipelineSnapshot> {
  // GHL direct is the best source for live pipeline data
  if (isGHLReady()) {
    try {
      const ops = await getOpsSnapshot();
      return {
        pipelineName: "Weight Loss",
        stages: [], // Stage breakdown not available from ops snapshot
        metrics: {
          totalOpportunities: ops.pipeline.total,
          wonCount: ops.pipeline.won,
          lostCount: ops.pipeline.lost,
          closeRate: ops.pipeline.closeRate,
          consultScheduled: 0,
          noShowCount: ops.noShowsThisWeek,
          showRate: ops.pipeline.showRate,
          totalMonetaryValue: 0,
          avgDealValue: 0,
        },
        staleLeads: { count: ops.pipeline.staleCount || 0, threshold: 7 },
      };
    } catch (err) {
      warn("dashboard", `GHL pipeline failed: ${err}`);
    }
  }

  // Legacy fallback
  if (API_TOKEN) {
    return dashboardFetch<PipelineSnapshot>("/api/metrics/pipeline", { period: _period });
  }

  throw new Error("No pipeline data source available");
}

export async function getOverview(_period = "month"): Promise<OverviewSnapshot> {
  // Compose from Supabase daily agg + GHL ops
  if (_supabase) {
    try {
      const days = _period === "week" ? 7 : 30;
      const [agg, ops] = await Promise.all([
        getDailyAgg(days),
        isGHLReady() ? getOpsSnapshot().catch(() => null) : Promise.resolve(null),
      ]);

      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - days);

      return {
        period: {
          start: start.toISOString().split("T")[0],
          end: now.toISOString().split("T")[0],
          label: _period === "week" ? "This Week" : "This Month",
        },
        totalLeads: agg.totalLeads,
        newLeadsThisWeek: _period === "week" ? agg.totalLeads : 0,
        newLeadsThisMonth: _period !== "week" ? agg.totalLeads : 0,
        adSpend: agg.totalAdSpend,
        impressions: agg.totalImpressions,
        clicks: agg.totalClicks,
        ctr: agg.avgCtr,
        cpl: agg.avgCpl,
        totalOpportunities: ops?.pipeline.total ?? 0,
        wonCount: ops?.pipeline.won ?? agg.totalWon,
        lostCount: ops?.pipeline.lost ?? agg.totalLost,
        closeRate: ops?.pipeline.closeRate ?? (agg.avgCloseRate / 100),
        consultScheduled: 0,
        noShowCount: ops?.noShowsThisWeek ?? agg.totalNoShow,
        showRate: ops?.pipeline.showRate ?? (agg.avgShowRate / 100),
        formSubmits: agg.totalLeads,
        costPerWon: agg.totalWon > 0 ? agg.totalAdSpend / agg.totalWon : 0,
      };
    } catch (err) {
      warn("dashboard", `Supabase overview failed: ${err}`);
    }
  }

  // Legacy fallback
  if (API_TOKEN) {
    return dashboardFetch<OverviewSnapshot>("/api/metrics/overview", { period: _period });
  }

  throw new Error("No overview data source available");
}

export async function getSpeedToLead(_period = "month"): Promise<SpeedToLeadSnapshot> {
  // Speed-to-lead endpoint removed from dashboard (2026-03-09). Return empty snapshot.
  return {
    totalOpportunities: 0,
    withResponseData: 0,
    summary: {
      avgMinutes: 0,
      medianMinutes: 0,
      under5min: 0,
      under5minPct: 0,
      under30min: 0,
      under60min: 0,
      avgWonMinutes: 0,
      avgLostMinutes: 0,
    },
  };
}

export async function getAttribution(_period = "month"): Promise<AttributionSnapshot> {
  // Attribution by source requires GHL pipeline data not in business_scorecard.
  // Legacy endpoint was removed. Return empty for now.
  if (API_TOKEN) {
    try {
      return await dashboardFetch<AttributionSnapshot>("/api/metrics/attribution", { period: _period });
    } catch {}
  }

  return {
    totalOpportunities: 0,
    bySource: [],
    stageAging: { count: 0, avgDays: 0 },
  };
}

// ============================================================
// FORMATTERS (unchanged)
// ============================================================

function usd(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatFinancials(f: FinancialSnapshot): string {
  if (!f.authenticated) {
    return "No financial data available. Check Supabase connection.";
  }

  const lines: string[] = ["FINANCIALS"];

  if (f.balance && f.balance.cashOnHand > 0) {
    lines.push(`Cash on hand: ${usd(f.balance.cashOnHand)}`);
  }

  if (f.currentMonth) {
    const cm = f.currentMonth;
    lines.push(
      `\nThis month (${cm.period.start}):`,
      `  Revenue: ${usd(cm.revenue)}`,
      `  COGS: ${usd(cm.cogs)}`,
      `  Gross profit: ${usd(cm.grossProfit)} (${pct(cm.revenue > 0 ? cm.grossProfit / cm.revenue : 0)} margin)`,
      `  Net income: ${usd(cm.netIncome)} (${pct(cm.profitMargin)} margin)`,
    );
  }

  if (f.lastMonth) {
    const lm = f.lastMonth;
    lines.push(
      `\n${lm.name} (reconciled):`,
      `  Revenue: ${usd(lm.revenue)} | Net: ${usd(lm.netIncome)} (${pct(lm.profitMargin)})`,
    );
  }

  if (f.unitEconomics && f.unitEconomics.wonCount > 0) {
    const ue = f.unitEconomics;
    lines.push(
      `\nUnit economics:`,
      `  CAC: ${usd(ue.cac)} | CPL: ${usd(ue.cpl)} | Close rate: ${pct(ue.closeRate)}`,
      `  Won: ${ue.wonCount} patients | Ad spend: ${usd(ue.adSpend)}`,
    );
  }

  if (f.monthlyTrend && f.monthlyTrend.length > 0) {
    const recent = f.monthlyTrend.slice(-3);
    lines.push(`\nRecent trend:`);
    for (const m of recent) {
      lines.push(`  ${m.month}: ${usd(m.revenue)} rev, ${usd(m.profit)} profit`);
    }
  }

  return lines.join("\n");
}

export function formatPipeline(p: PipelineSnapshot): string {
  const lines: string[] = [`PIPELINE: ${p.pipelineName}`];

  const m = p.metrics;
  lines.push(
    `Total: ${m.totalOpportunities} | Won: ${m.wonCount} | Lost: ${m.lostCount}`,
    `Close rate: ${pct(m.closeRate)} | Show rate: ${pct(m.showRate)}`,
  );

  if (m.avgDealValue > 0) {
    lines.push(`Avg deal value: ${usd(m.avgDealValue)}`);
  }

  if (p.stages.length > 0) {
    lines.push(`\nStage breakdown:`);
    for (const s of p.stages) {
      if (s.count > 0) {
        lines.push(`  ${s.stageName}: ${s.count} (${pct(s.percentage)})`);
      }
    }
  }

  if (p.staleLeads.count > 0) {
    lines.push(`\nStale leads (>${p.staleLeads.threshold}d): ${p.staleLeads.count}`);
  }

  return lines.join("\n");
}

export function formatOverview(o: OverviewSnapshot): string {
  const lines: string[] = [`OVERVIEW (${o.period.label})`];

  lines.push(
    `Leads: ${o.totalLeads} total`,
    `Ad spend: ${usd(o.adSpend)} | CPL: ${usd(o.cpl)}${o.costPerWon > 0 ? ` | Cost/won: ${usd(o.costPerWon)}` : ""}`,
  );
  if (o.noShowCount > 0 || o.showRate > 0) {
    lines.push(`No-shows: ${o.noShowCount} (${pct(o.showRate)} show rate)`);
  }
  lines.push(
    `Pipeline: ${o.wonCount} won | ${o.lostCount} lost (${pct(o.closeRate)} close rate)`,
  );

  return lines.join("\n");
}

export function formatSpeedToLead(s: SpeedToLeadSnapshot): string {
  const lines: string[] = ["SPEED TO LEAD"];
  const sm = s.summary;

  if (sm.medianMinutes === 0 && sm.avgMinutes === 0) {
    lines.push("Speed-to-lead data not available (dashboard endpoint removed).");
    lines.push("Pipeline data from /ops is still live via GHL.");
    return lines.join("\n");
  }

  if (sm.avgMinutes != null && sm.medianMinutes != null) {
    lines.push(
      `Avg response: ${sm.avgMinutes.toFixed(0)} min | Median: ${sm.medianMinutes.toFixed(0)} min`,
      `Under 5 min: ${sm.under5min ?? 0} (${pct(sm.under5minPct ?? 0)})`,
      `Under 30 min: ${sm.under30min ?? 0} | Under 60 min: ${sm.under60min ?? 0}`,
    );
  }

  if (sm.avgWonMinutes > 0 && sm.avgLostMinutes > 0) {
    lines.push(`Won avg: ${sm.avgWonMinutes.toFixed(0)} min | Lost avg: ${sm.avgLostMinutes.toFixed(0)} min`);
  }

  return lines.join("\n");
}

export function formatAttribution(a: AttributionSnapshot): string {
  const lines: string[] = ["ATTRIBUTION BY SOURCE"];

  if (a.bySource.length === 0) {
    lines.push("No attribution data available.");
    return lines.join("\n");
  }

  for (const s of a.bySource.slice(0, 8)) {
    const closeStr = s.total > 0 ? pct(s.closeRate) : "n/a";
    lines.push(`  ${s.source}: ${s.total} leads, ${s.won} won (${closeStr}), ${usd(s.totalValue)}`);
  }

  if (a.stageAging.count > 0) {
    lines.push(`\nStage aging: ${a.stageAging.count} leads, avg ${a.stageAging.avgDays.toFixed(0)} days`);
  }

  return lines.join("\n");
}

/**
 * Full scorecard combining overview + pipeline + financials.
 * Used by /scorecard command.
 */
export async function getScorecard(period = "month"): Promise<string> {
  const [overview, pipeline, financials] = await Promise.all([
    getOverview(period).catch((err) => { warn("dashboard", `Overview failed: ${err}`); return null; }),
    getPipeline(period).catch((err) => { warn("dashboard", `Pipeline failed: ${err}`); return null; }),
    getFinancials(period).catch((err) => { warn("dashboard", `Financials failed: ${err}`); return null; }),
  ]);

  const sections: string[] = [];
  if (overview) sections.push(formatOverview(overview));
  if (pipeline) sections.push(formatPipeline(pipeline));
  if (financials) sections.push(formatFinancials(financials));

  if (sections.length === 0) return "No data available. Check Supabase connection.";

  return sections.join("\n\n");
}

/**
 * Compact financial pulse for the morning brief digest.
 */
export async function getFinancialPulse(): Promise<string> {
  try {
    const f = await getFinancials("month");
    if (!f.authenticated) return "";

    const lines: string[] = ["--- Business Pulse ---"];

    if (f.balance && f.balance.cashOnHand > 0) {
      lines.push(`Cash: ${usd(f.balance.cashOnHand)}`);
    }
    if (f.currentMonth) {
      lines.push(`Revenue MTD: ${usd(f.currentMonth.revenue)} | Net: ${usd(f.currentMonth.netIncome)}`);
    }
    if (f.lastMonth) {
      lines.push(`Last month: ${usd(f.lastMonth.revenue)} rev (${pct(f.lastMonth.profitMargin)} margin)`);
    }
    if (f.unitEconomics && f.unitEconomics.wonCount > 0) {
      lines.push(`CAC: ${usd(f.unitEconomics.cac)} | Won: ${f.unitEconomics.wonCount} patients`);
    }

    return lines.join("\n");
  } catch (err) {
    warn("dashboard", `Financial pulse failed: ${err}`);
    return "";
  }
}

/**
 * Compact pipeline pulse for morning brief.
 */
export async function getPipelinePulse(): Promise<string> {
  try {
    const pipeline = await getPipeline("week");

    const m = pipeline.metrics;
    const lines: string[] = ["--- Pipeline Pulse ---"];
    lines.push(`This week: ${m.totalOpportunities} opps | ${m.wonCount} won | ${m.lostCount} lost`);
    lines.push(`Close rate: ${pct(m.closeRate)} | Show rate: ${pct(m.showRate)}`);

    if (pipeline.staleLeads.count > 0) {
      lines.push(`Stale leads: ${pipeline.staleLeads.count} (>${pipeline.staleLeads.threshold}d)`);
    }

    return lines.join("\n");
  } catch (err) {
    warn("dashboard", `Pipeline pulse failed: ${err}`);
    return "";
  }
}

/**
 * Dashboard context injected into Claude's prompt.
 */
export async function getDashboardContext(): Promise<string> {
  if (!isDashboardReady()) return "";

  try {
    const overview = await getOverview("month").catch(() => null);
    const pipeline = await getPipeline("month").catch(() => null);

    const parts: string[] = [];

    if (overview) {
      parts.push(
        `CURRENT BUSINESS METRICS (this month):`,
        `Leads: ${overview.totalLeads} | CPL: ${usd(overview.cpl)}${overview.costPerWon > 0 ? ` | Cost/won: ${usd(overview.costPerWon)}` : ""}`,
        `Won: ${overview.wonCount} | Lost: ${overview.lostCount} | Close rate: ${pct(overview.closeRate)}`,
        `Show rate: ${pct(overview.showRate)} | Ad spend: ${usd(overview.adSpend)}`,
      );
    }

    if (pipeline && pipeline.staleLeads.count > 0) {
      parts.push(`Stale leads: ${pipeline.staleLeads.count} stuck >${pipeline.staleLeads.threshold} days`);
    }

    return parts.length > 0 ? parts.join("\n") : "";
  } catch (err) {
    warn("dashboard", `Context fetch failed: ${err}`);
    return "";
  }
}

// ============================================================
// DEEP FINANCIALS
// ============================================================

/**
 * Comprehensive financial dump for `/finance deep`.
 * Uses Supabase scorecard data + monthly history.
 */
export async function getDeepFinancials(): Promise<string> {
  try {
    const f = await getFinancials("month");
    if (!f.authenticated) return "No financial data available. Check Supabase connection.";

    const sections: string[] = ["DETAILED FINANCIAL ANALYSIS"];

    if (f.balance && f.balance.cashOnHand > 0) {
      sections.push(
        `\nCASH POSITION:`,
        `  Cash on hand: $${f.balance.cashOnHand.toLocaleString()}`,
      );
    }

    if (f.currentMonth) {
      const cm = f.currentMonth;
      sections.push(
        `\nCURRENT MONTH P&L (${cm.period.start}):`,
        `  Revenue: $${cm.revenue.toLocaleString()}`,
        `  COGS: $${cm.cogs.toLocaleString()} (${cm.revenue > 0 ? ((cm.cogs / cm.revenue) * 100).toFixed(1) : 0}% of revenue)`,
        `  Gross profit: $${cm.grossProfit.toLocaleString()} (${pct(cm.revenue > 0 ? cm.grossProfit / cm.revenue : 0)} margin)`,
        `  Net income: $${cm.netIncome.toLocaleString()} (${pct(cm.profitMargin)} net margin)`,
      );

      if (cm.expenseBreakdown && cm.expenseBreakdown.length > 0) {
        sections.push(`\n  Expenses by category:`);
        for (const e of cm.expenseBreakdown.sort((a, b) => b.amount - a.amount).slice(0, 10)) {
          sections.push(`    ${e.name}: $${e.amount.toLocaleString()}`);
        }
      }
    }

    if (f.currentMonth && f.lastMonth) {
      const cm = f.currentMonth;
      const lm = f.lastMonth;
      const revChange = lm.revenue > 0 ? ((cm.revenue - lm.revenue) / lm.revenue * 100).toFixed(1) : "n/a";
      const netChange = lm.netIncome !== 0 ? ((cm.netIncome - lm.netIncome) / Math.abs(lm.netIncome) * 100).toFixed(1) : "n/a";
      const marginDelta = (cm.profitMargin - lm.profitMargin) * 100;

      sections.push(
        `\nMONTH-OVER-MONTH (vs ${lm.name}):`,
        `  Revenue: ${revChange}% change ($${cm.revenue.toLocaleString()} vs $${lm.revenue.toLocaleString()})`,
        `  Net income: ${netChange}% change ($${cm.netIncome.toLocaleString()} vs $${lm.netIncome.toLocaleString()})`,
        `  Margin shift: ${marginDelta > 0 ? "+" : ""}${marginDelta.toFixed(1)} pts (${pct(cm.profitMargin)} vs ${pct(lm.profitMargin)})`,
      );
    }

    if (f.monthlyTrend && f.monthlyTrend.length > 0) {
      sections.push(`\nMONTHLY TREND (last ${f.monthlyTrend.length} months):`);
      for (const m of f.monthlyTrend) {
        const margin = m.revenue > 0 ? ((m.profit / m.revenue) * 100).toFixed(1) : "0";
        sections.push(`  ${m.month}: $${m.revenue.toLocaleString()} rev, $${m.profit.toLocaleString()} profit (${margin}%)`);
      }
    }

    if (f.unitEconomics && f.unitEconomics.wonCount > 0) {
      const ue = f.unitEconomics;
      sections.push(
        `\nUNIT ECONOMICS:`,
        `  CAC: $${ue.cac.toLocaleString()}`,
        `  CPL: $${ue.cpl.toLocaleString()}`,
        `  Close rate: ${pct(ue.closeRate)}`,
        `  New patients won: ${ue.wonCount}`,
        `  Ad spend: $${ue.adSpend.toLocaleString()}`,
      );
    }

    const anomalies = detectFinancialAnomalies(f);
    if (anomalies.length > 0) {
      sections.push(`\nALERTS:`);
      for (const a of anomalies) {
        sections.push(`  ${a}`);
      }
    }

    return sections.join("\n");
  } catch (err) {
    warn("dashboard", `Deep financials failed: ${err}`);
    return `Failed to fetch detailed financials: ${err}`;
  }
}

/**
 * Detect financial anomalies worth flagging.
 */
export function detectFinancialAnomalies(f: FinancialSnapshot): string[] {
  const alerts: string[] = [];

  if (f.currentMonth && f.lastMonth) {
    const marginDelta = f.currentMonth.profitMargin - f.lastMonth.profitMargin;
    if (marginDelta < -0.05) {
      alerts.push(`Margin compression: ${pct(f.currentMonth.profitMargin)} this month vs ${pct(f.lastMonth.profitMargin)} last month (${(marginDelta * 100).toFixed(1)} pts)`);
    }
  }

  if (f.currentMonth && f.lastMonth && f.lastMonth.revenue > 0) {
    const revChange = (f.currentMonth.revenue - f.lastMonth.revenue) / f.lastMonth.revenue;
    if (revChange < -0.10) {
      alerts.push(`Revenue down ${(revChange * 100).toFixed(1)}% vs last month`);
    }
  }

  if (f.currentMonth && f.lastMonth) {
    const revUp = f.currentMonth.revenue > f.lastMonth.revenue;
    const profitDown = f.currentMonth.netIncome < f.lastMonth.netIncome;
    if (revUp && profitDown) {
      alerts.push(`Revenue up but profit down. Check COGS and operating expenses.`);
    }
  }

  if (f.currentMonth && f.currentMonth.revenue > 0) {
    const cogsRatio = f.currentMonth.cogs / f.currentMonth.revenue;
    if (cogsRatio > 0.50) {
      alerts.push(`COGS ratio high: ${(cogsRatio * 100).toFixed(1)}% of revenue`);
    }
  }

  if (f.monthlyTrend && f.monthlyTrend.length >= 3) {
    const last3 = f.monthlyTrend.slice(-3);
    if (last3[0].revenue > last3[1].revenue && last3[1].revenue > last3[2].revenue) {
      alerts.push(`Revenue declining 3 months in a row: ${last3.map(m => `${m.month}: $${(m.revenue / 1000).toFixed(1)}k`).join(" -> ")}`);
    }
  }

  return alerts;
}

/**
 * Enhanced financial context for Claude's prompt.
 */
export async function getFinancialContext(): Promise<string> {
  if (!isDashboardReady()) return "";

  try {
    const f = await getFinancials("month");
    if (!f.authenticated) return "";

    const parts: string[] = [];

    if (f.balance && f.balance.cashOnHand > 0) {
      parts.push(`Cash: $${f.balance.cashOnHand.toLocaleString()}`);
    }
    if (f.currentMonth) {
      parts.push(`Revenue MTD: $${f.currentMonth.revenue.toLocaleString()} | Net: $${f.currentMonth.netIncome.toLocaleString()} (${pct(f.currentMonth.profitMargin)})`);
    }
    if (f.unitEconomics && f.unitEconomics.wonCount > 0) {
      parts.push(`CAC: $${f.unitEconomics.cac.toFixed(0)} | Won: ${f.unitEconomics.wonCount} patients`);
    }

    const anomalies = detectFinancialAnomalies(f);
    if (anomalies.length > 0) {
      parts.push(`Financial alerts: ${anomalies.join("; ")}`);
    }

    return parts.length > 0 ? `FINANCIAL SNAPSHOT:\n${parts.join("\n")}` : "";
  } catch {
    return "";
  }
}
