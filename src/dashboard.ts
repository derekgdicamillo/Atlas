/**
 * Atlas — PV Dashboard Integration
 *
 * Connects to the PV Dashboard API (Next.js on Vercel) to surface
 * financial, pipeline, and marketing data directly in Telegram.
 *
 * The dashboard already integrates GoHighLevel (CRM), Meta Ads,
 * and QuickBooks Online. Atlas reads from these aggregated endpoints
 * rather than re-implementing each integration.
 *
 * Auth: Bearer token via DASHBOARD_API_TOKEN env var.
 */

import { info, warn, error as logError } from "./logger.ts";
import { dashboardBreaker } from "./circuit-breaker.ts";

const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://pv-dashboard-ten.vercel.app";
const API_TOKEN = process.env.DASHBOARD_API_TOKEN || "";

// ============================================================
// TYPES
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

export function isDashboardReady(): boolean {
  return !!API_TOKEN;
}

export function initDashboard(): boolean {
  if (!API_TOKEN) {
    warn("dashboard", "DASHBOARD_API_TOKEN not set. Dashboard integration disabled.");
    return false;
  }
  info("dashboard", `Dashboard integration ready: ${DASHBOARD_URL}`);
  return true;
}

/** Quick auth check. Returns true if token is valid, false if 401/403. */
export async function checkDashboardHealth(): Promise<boolean> {
  if (!API_TOKEN) return false;
  try {
    const res = await fetch(new URL("/api/metrics/overview", DASHBOARD_URL).toString(), {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      logError("dashboard", `Health check failed: ${res.status}. DASHBOARD_API_TOKEN may be stale.`);
      return false;
    }
    return res.ok;
  } catch (err) {
    warn("dashboard", `Health check error: ${err}`);
    return false;
  }
}

// ============================================================
// FETCH HELPER
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

/** Dashboard fetch with circuit breaker protection */
async function dashboardFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  return dashboardBreaker.exec(() => dashboardFetchRaw<T>(path, params));
}

// ============================================================
// DATA FETCHERS
// ============================================================

export async function getFinancials(period = "month"): Promise<FinancialSnapshot> {
  return dashboardFetch<FinancialSnapshot>("/api/metrics/financials", { period });
}

export async function getPipeline(period = "month"): Promise<PipelineSnapshot> {
  return dashboardFetch<PipelineSnapshot>("/api/metrics/pipeline", { period });
}

export async function getOverview(period = "month"): Promise<OverviewSnapshot> {
  return dashboardFetch<OverviewSnapshot>("/api/metrics/overview", { period });
}

export async function getSpeedToLead(period = "month"): Promise<SpeedToLeadSnapshot> {
  return dashboardFetch<SpeedToLeadSnapshot>("/api/metrics/speed-to-lead", { period });
}

export async function getAttribution(period = "month"): Promise<AttributionSnapshot> {
  return dashboardFetch<AttributionSnapshot>("/api/metrics/attribution", { period });
}

// ============================================================
// FORMATTERS
// ============================================================

function usd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatFinancials(f: FinancialSnapshot): string {
  if (!f.authenticated) {
    return "QuickBooks not connected. Reconnect at the dashboard.";
  }

  const lines: string[] = ["FINANCIALS"];

  if (f.balance) {
    lines.push(`Cash on hand: ${usd(f.balance.cashOnHand)}`);
  }

  if (f.currentMonth) {
    const cm = f.currentMonth;
    lines.push(
      `\nThis month (${cm.period.start} to ${cm.period.end}):`,
      `  Revenue: ${usd(cm.revenue)}`,
      `  COGS: ${usd(cm.cogs)}`,
      `  Expenses: ${usd(cm.expenses)}`,
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

  if (f.ytd) {
    lines.push(
      `\nYTD:`,
      `  Revenue: ${usd(f.ytd.revenue)} | Net: ${usd(f.ytd.netIncome)} (${pct(f.ytd.profitMargin)})`,
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
    `Avg deal value: ${usd(m.avgDealValue)}`,
  );

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
    `Leads: ${o.totalLeads} total | ${o.newLeadsThisWeek} this week | ${o.newLeadsThisMonth} this month`,
    `Ad spend: ${usd(o.adSpend)} | CPL: ${usd(o.cpl)} | Cost/won: ${usd(o.costPerWon)}`,
    `Consults: ${o.consultScheduled} scheduled | ${o.noShowCount} no-shows (${pct(o.showRate)} show rate)`,
    `Pipeline: ${o.wonCount} won | ${o.lostCount} lost (${pct(o.closeRate)} close rate)`,
  );

  return lines.join("\n");
}

export function formatSpeedToLead(s: SpeedToLeadSnapshot): string {
  const lines: string[] = ["SPEED TO LEAD"];
  const sm = s.summary;

  lines.push(
    `Avg response: ${sm.avgMinutes.toFixed(0)} min | Median: ${sm.medianMinutes.toFixed(0)} min`,
    `Under 5 min: ${sm.under5min} (${pct(sm.under5minPct)})`,
    `Under 30 min: ${sm.under30min} | Under 60 min: ${sm.under60min}`,
  );

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
 * Used by /scorecard command and morning brief.
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

  if (sections.length === 0) return "Could not reach the dashboard. Check connection.";

  return sections.join("\n\n");
}

/**
 * Compact financial pulse for the morning brief digest.
 * Returns a short string or empty if unavailable.
 */
export async function getFinancialPulse(): Promise<string> {
  try {
    const f = await getFinancials("month");
    if (!f.authenticated) return "";

    const lines: string[] = ["--- Business Pulse ---"];

    if (f.balance) {
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
    const [pipeline, stl] = await Promise.all([
      getPipeline("week"),
      getSpeedToLead("week").catch(() => null),
    ]);

    const m = pipeline.metrics;
    const lines: string[] = ["--- Pipeline Pulse ---"];
    lines.push(`This week: ${m.totalOpportunities} opps | ${m.wonCount} won | ${m.lostCount} lost`);
    lines.push(`Close rate: ${pct(m.closeRate)} | Show rate: ${pct(m.showRate)}`);

    if (pipeline.staleLeads.count > 0) {
      lines.push(`Stale leads: ${pipeline.staleLeads.count} (>${pipeline.staleLeads.threshold}d)`);
    }

    if (stl) {
      lines.push(`Speed to lead: ${stl.summary.medianMinutes.toFixed(0)} min median`);
    }

    return lines.join("\n");
  } catch (err) {
    warn("dashboard", `Pipeline pulse failed: ${err}`);
    return "";
  }
}

/**
 * Dashboard context injected into Claude's prompt.
 * Gives Atlas awareness of current business metrics.
 */
export async function getDashboardContext(): Promise<string> {
  if (!isDashboardReady()) return "";

  try {
    const [overview, pipeline] = await Promise.all([
      getOverview("month").catch(() => null),
      getPipeline("month").catch(() => null),
    ]);

    const parts: string[] = [];

    if (overview) {
      parts.push(
        `CURRENT BUSINESS METRICS (this month):`,
        `Leads: ${overview.totalLeads} | CPL: ${usd(overview.cpl)} | Cost/won: ${usd(overview.costPerWon)}`,
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
// DEEP FINANCIALS (Phase 3: QuickBooks Intelligence)
// ============================================================

/**
 * Comprehensive financial dump formatted for Claude analysis.
 * Used by `/finance deep` command. Gives Claude all the data it
 * needs to answer conversational financial questions.
 */
export async function getDeepFinancials(): Promise<string> {
  if (!isDashboardReady()) return "Dashboard not connected.";

  try {
    const f = await getFinancials("month");
    if (!f.authenticated) return "QuickBooks not connected. Reconnect at the dashboard.";

    const sections: string[] = ["DETAILED FINANCIAL ANALYSIS"];

    // Balance sheet
    if (f.balance) {
      const b = f.balance;
      sections.push(
        `\nBALANCE SHEET:`,
        `  Cash on hand: $${b.cashOnHand.toLocaleString()}`,
        `  Total assets: $${b.totalAssets.toLocaleString()}`,
        `  Total liabilities: $${b.totalLiabilities.toLocaleString()}`,
        `  Equity: $${b.equity.toLocaleString()}`,
        `  Debt-to-equity: ${b.equity > 0 ? (b.totalLiabilities / b.equity).toFixed(2) : "n/a"}`,
      );
    }

    // Current month with full breakdown
    if (f.currentMonth) {
      const cm = f.currentMonth;
      sections.push(
        `\nCURRENT MONTH P&L (${cm.period.start} to ${cm.period.end}):`,
        `  Revenue: $${cm.revenue.toLocaleString()}`,
        `  COGS: $${cm.cogs.toLocaleString()} (${cm.revenue > 0 ? ((cm.cogs / cm.revenue) * 100).toFixed(1) : 0}% of revenue)`,
        `  Gross profit: $${cm.grossProfit.toLocaleString()} (${pct(cm.revenue > 0 ? cm.grossProfit / cm.revenue : 0)} margin)`,
        `  Operating expenses: $${cm.expenses.toLocaleString()}`,
        `  Net income: $${cm.netIncome.toLocaleString()} (${pct(cm.profitMargin)} net margin)`,
      );

      if (cm.revenueBreakdown && cm.revenueBreakdown.length > 0) {
        sections.push(`\n  Revenue by category:`);
        for (const r of cm.revenueBreakdown.sort((a, b) => b.amount - a.amount).slice(0, 10)) {
          const pctOfRev = cm.revenue > 0 ? ((r.amount / cm.revenue) * 100).toFixed(1) : "0";
          sections.push(`    ${r.name}: $${r.amount.toLocaleString()} (${pctOfRev}%)`);
        }
      }

      if (cm.expenseBreakdown && cm.expenseBreakdown.length > 0) {
        sections.push(`\n  Expenses by category:`);
        for (const e of cm.expenseBreakdown.sort((a, b) => b.amount - a.amount).slice(0, 10)) {
          const pctOfExp = cm.expenses > 0 ? ((e.amount / cm.expenses) * 100).toFixed(1) : "0";
          sections.push(`    ${e.name}: $${e.amount.toLocaleString()} (${pctOfExp}%)`);
        }
      }
    }

    // Month-over-month comparison
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

    // YTD
    if (f.ytd) {
      sections.push(
        `\nYEAR TO DATE:`,
        `  Revenue: $${f.ytd.revenue.toLocaleString()}`,
        `  Net income: $${f.ytd.netIncome.toLocaleString()} (${pct(f.ytd.profitMargin)})`,
      );
    }

    // Trend
    if (f.monthlyTrend && f.monthlyTrend.length > 0) {
      sections.push(`\nMONTHLY TREND (last ${f.monthlyTrend.length} months):`);
      for (const m of f.monthlyTrend) {
        const margin = m.revenue > 0 ? ((m.profit / m.revenue) * 100).toFixed(1) : "0";
        sections.push(`  ${m.month}: $${m.revenue.toLocaleString()} rev, $${m.profit.toLocaleString()} profit (${margin}%)`);
      }
    }

    // Unit economics
    if (f.unitEconomics && f.unitEconomics.wonCount > 0) {
      const ue = f.unitEconomics;
      sections.push(
        `\nUNIT ECONOMICS:`,
        `  Customer acquisition cost (CAC): $${ue.cac.toLocaleString()}`,
        `  Cost per lead (CPL): $${ue.cpl.toLocaleString()}`,
        `  Close rate: ${pct(ue.closeRate)}`,
        `  New patients won: ${ue.wonCount}`,
        `  Ad spend: $${ue.adSpend.toLocaleString()}`,
      );
    }

    // Anomaly detection
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

  // 1. Margin compression
  if (f.currentMonth && f.lastMonth) {
    const marginDelta = f.currentMonth.profitMargin - f.lastMonth.profitMargin;
    if (marginDelta < -0.05) {
      alerts.push(`Margin compression: ${pct(f.currentMonth.profitMargin)} this month vs ${pct(f.lastMonth.profitMargin)} last month (${(marginDelta * 100).toFixed(1)} pts)`);
    }
  }

  // 2. Revenue decline
  if (f.currentMonth && f.lastMonth && f.lastMonth.revenue > 0) {
    const revChange = (f.currentMonth.revenue - f.lastMonth.revenue) / f.lastMonth.revenue;
    if (revChange < -0.10) {
      alerts.push(`Revenue down ${(revChange * 100).toFixed(1)}% vs last month`);
    }
  }

  // 3. Revenue up but profit down (cost problem)
  if (f.currentMonth && f.lastMonth) {
    const revUp = f.currentMonth.revenue > f.lastMonth.revenue;
    const profitDown = f.currentMonth.netIncome < f.lastMonth.netIncome;
    if (revUp && profitDown) {
      alerts.push(`Revenue up but profit down. Check COGS and operating expenses.`);
    }
  }

  // 4. COGS ratio spike
  if (f.currentMonth && f.currentMonth.revenue > 0) {
    const cogsRatio = f.currentMonth.cogs / f.currentMonth.revenue;
    if (cogsRatio > 0.50) {
      alerts.push(`COGS ratio high: ${(cogsRatio * 100).toFixed(1)}% of revenue`);
    }
  }

  // 5. Low cash relative to monthly expenses
  if (f.balance && f.currentMonth && f.currentMonth.expenses > 0) {
    const monthsOfRunway = f.balance.cashOnHand / f.currentMonth.expenses;
    if (monthsOfRunway < 2) {
      alerts.push(`Cash runway: ${monthsOfRunway.toFixed(1)} months at current expense rate`);
    }
  }

  // 6. High CAC relative to revenue per patient
  if (f.unitEconomics && f.currentMonth && f.unitEconomics.wonCount > 0) {
    const revenuePerPatient = f.currentMonth.revenue / f.unitEconomics.wonCount;
    if (f.unitEconomics.cac > revenuePerPatient * 0.5) {
      alerts.push(`CAC ($${f.unitEconomics.cac.toFixed(0)}) is ${((f.unitEconomics.cac / revenuePerPatient) * 100).toFixed(0)}% of revenue per patient ($${revenuePerPatient.toFixed(0)})`);
    }
  }

  // 7. Declining trend (3+ months of revenue decline)
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
 * Includes anomaly alerts so Atlas can proactively bring up issues.
 */
export async function getFinancialContext(): Promise<string> {
  if (!isDashboardReady()) return "";

  try {
    const f = await getFinancials("month");
    if (!f.authenticated) return "";

    const parts: string[] = [];

    if (f.balance) {
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
