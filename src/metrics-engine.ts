/**
 * Atlas Metrics Engine — Single Source of Truth
 *
 * This module IS the methodology. Every formula is documented in code.
 * Every metric has one calculation path. No other module should compute
 * business metrics independently.
 *
 * Two modes:
 *   1. Daily (automated): crons call captureDaily() to snapshot funnel + pipeline
 *   2. Monthly (Derek in the loop): captureMonthly() processes AR exports + QB
 *
 * All writes go to Supabase business_scorecard table.
 * All reads come from the same table.
 * Dashboard, Midas, morning brief, executive reports all read from here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn, error as logError } from "./logger.ts";
import { getAccountSummary } from "./meta.ts";
import { getOpsSnapshot } from "./ghl.ts";
import { getFinancials } from "./dashboard.ts";

// ============================================================
// TYPES
// ============================================================

export interface DailyMetrics {
  date: string; // YYYY-MM-DD
  // Funnel (Meta Ads)
  leads: number;
  ad_spend: number;
  cpl: number;
  impressions: number;
  clicks: number;
  ctr: number;
  lp_views: number;
  // Pipeline (GHL)
  show_rate: number;
  close_rate: number;
  pipeline_total: number;
  pipeline_open: number;
  pipeline_won: number;
  pipeline_lost: number;
  pipeline_noshow: number;
}

export interface MonthlyMetrics {
  date: string; // YYYY-MM-01 (first of month)
  // The Money (QuickBooks)
  revenue: number;
  cogs: number;
  gross_margin: number;
  net_income: number;
  net_margin: number;
  cash_on_hand: number;
  // The Bucket (Aesthetic Record)
  active_patients: number;
  mrr: number;
  new_patients: number;
  cancellations: number;
  churn_rate: number;
  annual_churn: number;
  avg_tenure_months: number;
  median_tenure_months: number | null;
  ltv: number;
  // The Funnel (calculated)
  leads: number;
  ad_spend: number;
  cpl: number;
  show_rate: number;
  close_rate: number;
  cac: number;
  ltv_cac_ratio: number;
  // Metadata
  metadata: {
    tier_breakdown?: Record<string, { count: number; price: number }>;
    expense_breakdown?: { name: string; amount: number }[];
    med_costs?: Record<string, number>;
    [key: string]: unknown;
  };
}

export interface ScorecardView {
  monthly: MonthlyRow | null;
  daily: DailyRow[];
}

interface DailyRow {
  date: string;
  leads: number | null;
  ad_spend: number | null;
  cpl: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  lp_views: number | null;
  show_rate: number | null;
  close_rate: number | null;
  pipeline_total: number | null;
  pipeline_open: number | null;
  pipeline_won: number | null;
  pipeline_lost: number | null;
  pipeline_noshow: number | null;
}

interface MonthlyRow {
  date: string;
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
  show_rate: number | null;
  close_rate: number | null;
  cac: number | null;
  ltv_cac_ratio: number | null;
  validated: boolean;
  metadata: Record<string, unknown>;
}

// ============================================================
// PURE CALCULATION FUNCTIONS
// These ARE the methodology. The code IS the documentation.
// ============================================================

/**
 * Monthly Churn Rate
 * Formula: true_exits / avg_active_base / months_in_period
 * Source: AR churn report cross-referenced against current active roster
 * "True exits" = patients in churn report NOT on current roster
 * Excludes tier switches, plan changes, and patients who left and returned
 */
export function calculateChurn(trueExits: number, avgActiveBase: number, months: number): number {
  if (avgActiveBase <= 0 || months <= 0) return 0;
  return (trueExits / avgActiveBase / months) * 100;
}

/**
 * Annual Churn Rate
 * Formula: 1 - (1 - monthly_rate)^12
 * Compound probability of surviving 12 months
 */
export function calculateAnnualChurn(monthlyChurnRate: number): number {
  const rate = monthlyChurnRate / 100; // convert from percentage
  return (1 - Math.pow(1 - rate, 12)) * 100;
}

/**
 * Average Tenure (months)
 * Formula: 1 / monthly_churn_rate
 * Implied from churn. Use median_tenure for measured value.
 */
export function calculateAvgTenure(monthlyChurnRate: number): number {
  const rate = monthlyChurnRate / 100;
  if (rate <= 0) return 0;
  return 1 / rate;
}

/**
 * Lifetime Value (LTV)
 * Formula: gross_profit_per_patient_per_month * avg_tenure_months
 * Uses QB gross profit across entire patient base (conservative method).
 * Doesn't assume tier-specific margins. Uses real financials.
 *
 * Alternative for ad-acquired WL patients only:
 *   $530/mo revenue * 64.1% blended WL margin * tenure = ~$3,693
 *   Use calculateWLPatientLTV() for that.
 */
export function calculateLTV(grossProfitPerPatientPerMonth: number, avgTenureMonths: number): number {
  return grossProfitPerPatientPerMonth * avgTenureMonths;
}

/**
 * Gross Profit per Patient per Month
 * Formula: QB annual gross profit / avg active patients / 12
 * Source: QuickBooks P&L gross profit line, AR average active base
 */
export function calculateGPPerPatient(annualGrossProfit: number, avgActiveBase: number): number {
  if (avgActiveBase <= 0) return 0;
  return annualGrossProfit / avgActiveBase / 12;
}

/**
 * Customer Acquisition Cost (CAC)
 * Formula: total_ad_spend / patients_won
 * Source: Meta Ads API spend, GHL pipeline won count
 * Period must match: if using 3-month spend, use 3-month won count
 */
export function calculateCAC(totalAdSpend: number, patientsWon: number): number {
  if (patientsWon <= 0) return 0;
  return totalAdSpend / patientsWon;
}

/**
 * LTV:CAC Ratio
 * Formula: LTV / CAC
 * Target: >3x healthy, >5x strong
 * Source: calculated from LTV and CAC
 */
export function calculateLTVCACRatio(ltv: number, cac: number): number {
  if (cac <= 0) return 0;
  return ltv / cac;
}

/**
 * Cost Per Lead (CPL)
 * Formula: ad_spend / leads
 * Source: Meta Ads API (standard Lead event, not custom events)
 * Note: Before 2026-03-07, used custom "weight_loss_form_submit" which undercounted
 */
export function calculateCPL(adSpend: number, leads: number): number {
  if (leads <= 0) return 0;
  return adSpend / leads;
}

/**
 * Gross Margin
 * Formula: (revenue - cogs) / revenue * 100
 * Source: QuickBooks P&L
 */
export function calculateGrossMargin(revenue: number, cogs: number): number {
  if (revenue <= 0) return 0;
  return ((revenue - cogs) / revenue) * 100;
}

/**
 * Net Margin
 * Formula: net_income / revenue * 100
 * Source: QuickBooks P&L (net_income = revenue - cogs - opex)
 */
export function calculateNetMargin(netIncome: number, revenue: number): number {
  if (revenue <= 0) return 0;
  return (netIncome / revenue) * 100;
}

/**
 * True New Patients per Month
 * Formula: (ending_active - starting_active + true_exits) / months
 * Source: AR active counts at start/end of period + churn report
 * Filters out tier switches that AR double-counts as cancel + new
 */
export function calculateTrueNewPatients(
  endingActive: number,
  startingActive: number,
  trueExits: number,
  months: number,
): number {
  if (months <= 0) return 0;
  return (endingActive - startingActive + trueExits) / months;
}

/**
 * Close Rate
 * Formula: won / (won + lost) * 100
 * Only counts decided leads (excludes open and no-show)
 * Source: GHL pipeline
 */
export function calculateCloseRate(won: number, lost: number): number {
  const decided = won + lost;
  if (decided <= 0) return 0;
  return (won / decided) * 100;
}

/**
 * Show Rate
 * Formula: (showed) / (showed + no_shows) * 100
 * Where "showed" = won + lost (they showed up and got a decision)
 * Source: GHL pipeline stages
 */
export function calculateShowRate(showed: number, noShows: number): number {
  const total = showed + noShows;
  if (total <= 0) return 0;
  return (showed / total) * 100;
}

// ============================================================
// DAILY CAPTURE
// Called by Atlas cron job. Pulls from Meta + GHL APIs.
// Writes one row to business_scorecard with period_type='daily'.
// ============================================================

export async function captureDaily(supabase: SupabaseClient): Promise<DailyMetrics | null> {
  const today = new Date().toISOString().split("T")[0];
  info("metrics-engine", `Capturing daily metrics for ${today}`);

  let adMetrics = {
    spend: 0,
    impressions: 0,
    clicks: 0,
    ctr: 0,
    cpl: 0,
    conversions: 0,
    landingPageViews: 0,
  };

  let opsMetrics = {
    pipeline: { total: 0, open: 0, won: 0, lost: 0, closeRate: 0, showRate: 0 },
    noShowsThisWeek: 0,
  };

  // Pull from Meta Ads API
  try {
    const summary = await getAccountSummary("today");
    adMetrics = {
      spend: summary.spend,
      impressions: summary.impressions,
      clicks: summary.clicks,
      ctr: summary.ctr,
      cpl: summary.cpl,
      conversions: summary.conversions,
      landingPageViews: summary.landingPageViews,
    };
  } catch (e) {
    warn("metrics-engine", `Meta Ads pull failed: ${(e as Error).message}`);
  }

  // Pull from GHL pipeline
  try {
    const ops = await getOpsSnapshot();
    opsMetrics = {
      pipeline: ops.pipeline,
      noShowsThisWeek: ops.noShowsThisWeek,
    };
  } catch (e) {
    warn("metrics-engine", `GHL ops pull failed: ${(e as Error).message}`);
  }

  const daily: DailyMetrics = {
    date: today,
    leads: adMetrics.conversions,
    ad_spend: round2(adMetrics.spend),
    cpl: round2(adMetrics.cpl),
    impressions: adMetrics.impressions,
    clicks: adMetrics.clicks,
    ctr: round2(adMetrics.ctr),
    lp_views: adMetrics.landingPageViews,
    show_rate: round2(opsMetrics.pipeline.showRate),
    close_rate: round2(opsMetrics.pipeline.closeRate),
    pipeline_total: opsMetrics.pipeline.total,
    pipeline_open: opsMetrics.pipeline.open,
    pipeline_won: opsMetrics.pipeline.won,
    pipeline_lost: opsMetrics.pipeline.lost,
    pipeline_noshow: opsMetrics.noShowsThisWeek,
  };

  // Upsert to Supabase (one row per day)
  const { error } = await supabase.from("business_scorecard").upsert(
    {
      date: today,
      period_type: "daily",
      leads: daily.leads,
      ad_spend: daily.ad_spend,
      cpl: daily.cpl,
      impressions: daily.impressions,
      clicks: daily.clicks,
      ctr: daily.ctr,
      lp_views: daily.lp_views,
      show_rate: daily.show_rate,
      close_rate: daily.close_rate,
      pipeline_total: daily.pipeline_total,
      pipeline_open: daily.pipeline_open,
      pipeline_won: daily.pipeline_won,
      pipeline_lost: daily.pipeline_lost,
      pipeline_noshow: daily.pipeline_noshow,
      source: "atlas",
      validated: false,
    },
    { onConflict: "date,period_type" },
  );

  if (error) {
    logError("metrics-engine", `Failed to write daily scorecard: ${error.message}`);
    return null;
  }

  info("metrics-engine", `Daily scorecard captured: ${daily.leads} leads, $${daily.ad_spend} spend, ${daily.show_rate}% show rate`);
  return daily;
}

// ============================================================
// MONTHLY CAPTURE
// Called when Derek provides AR exports. Processes inputs,
// runs all calculations, writes validated monthly row.
// ============================================================

export interface MonthlyInputs {
  // From Aesthetic Record export
  activePatients: number;
  mrrTotal: number;
  newPatients: number; // true new (not tier switches)
  trueExits: number; // from churn report cross-ref
  avgActiveBase: number; // average over the period
  startingActive: number; // beginning of period
  endingActive: number; // end of period
  medianTenureMonths?: number; // measured from patient start dates
  tierBreakdown?: Record<string, { count: number; price: number }>;
  // Period
  months: number; // how many months this covers (usually 1 or 3)
  // From Meta Ads (auto-pulled)
  periodAdSpend?: number; // total spend in period
  periodLeads?: number; // total leads in period
  // From GHL (auto-pulled)
  periodWon?: number; // patients won in period
  periodShowRate?: number;
  periodCloseRate?: number;
  // Override financials (if not pulling from QB)
  revenue?: number;
  cogs?: number;
  netIncome?: number;
  cashOnHand?: number;
  expenseBreakdown?: { name: string; amount: number }[];
  medCosts?: Record<string, number>;
}

export async function captureMonthly(
  supabase: SupabaseClient,
  inputs: MonthlyInputs,
  monthDate?: string, // YYYY-MM-01, defaults to current month
): Promise<MonthlyMetrics | null> {
  const date = monthDate || `${new Date().toISOString().slice(0, 7)}-01`;
  info("metrics-engine", `Capturing monthly metrics for ${date}`);

  // Try to pull financials from QB via dashboard if not provided
  let revenue = inputs.revenue ?? 0;
  let cogs = inputs.cogs ?? 0;
  let netIncome = inputs.netIncome ?? 0;
  let cashOnHand = inputs.cashOnHand ?? 0;
  let expenseBreakdown = inputs.expenseBreakdown;

  if (!inputs.revenue) {
    try {
      const fin = await getFinancials("month");
      if (fin.authenticated && fin.currentMonth) {
        revenue = fin.currentMonth.revenue;
        cogs = fin.currentMonth.cogs;
        netIncome = fin.currentMonth.netIncome;
        expenseBreakdown = fin.currentMonth.expenseBreakdown;
      }
      if (fin.balance) {
        cashOnHand = fin.balance.cashOnHand;
      }
    } catch (e) {
      warn("metrics-engine", `QB pull failed, using provided values: ${(e as Error).message}`);
    }
  }

  // Run calculations using the pure functions above
  const churnRate = calculateChurn(inputs.trueExits, inputs.avgActiveBase, inputs.months);
  const annualChurn = calculateAnnualChurn(churnRate);
  const avgTenure = calculateAvgTenure(churnRate);
  const grossMargin = calculateGrossMargin(revenue, cogs);
  const netMargin = calculateNetMargin(netIncome, revenue);

  // GP per patient per month uses annual figures
  // If monthly input, annualize: revenue * 12 for annual GP estimate
  const annualizedGP = (revenue - cogs) * (12 / inputs.months);
  const gpPerPatient = calculateGPPerPatient(annualizedGP, inputs.avgActiveBase);
  const ltv = calculateLTV(gpPerPatient, avgTenure);

  // Ad metrics for the period
  const adSpend = inputs.periodAdSpend ?? 0;
  const leads = inputs.periodLeads ?? 0;
  const cpl = calculateCPL(adSpend, leads);
  const patientsWon = inputs.periodWon ?? 0;
  const cac = calculateCAC(adSpend, patientsWon);
  const ltvCacRatio = calculateLTVCACRatio(ltv, cac);

  const monthly: MonthlyMetrics = {
    date,
    revenue: round2(revenue),
    cogs: round2(cogs),
    gross_margin: round2(grossMargin),
    net_income: round2(netIncome),
    net_margin: round2(netMargin),
    cash_on_hand: round2(cashOnHand),
    active_patients: inputs.activePatients,
    mrr: round2(inputs.mrrTotal),
    new_patients: inputs.newPatients,
    cancellations: inputs.trueExits,
    churn_rate: round2(churnRate),
    annual_churn: round2(annualChurn),
    avg_tenure_months: round2(avgTenure),
    median_tenure_months: inputs.medianTenureMonths ?? null,
    ltv: round2(ltv),
    leads,
    ad_spend: round2(adSpend),
    cpl: round2(cpl),
    show_rate: inputs.periodShowRate ?? null,
    close_rate: inputs.periodCloseRate ?? null,
    cac: round2(cac),
    ltv_cac_ratio: round2(ltvCacRatio),
    metadata: {
      tier_breakdown: inputs.tierBreakdown,
      expense_breakdown: expenseBreakdown,
      med_costs: inputs.medCosts,
    },
  };

  // Upsert to Supabase
  const { error } = await supabase.from("business_scorecard").upsert(
    {
      date,
      period_type: "monthly",
      ...monthly,
      source: "derek",
      validated: true,
    },
    { onConflict: "date,period_type" },
  );

  if (error) {
    logError("metrics-engine", `Failed to write monthly scorecard: ${error.message}`);
    return null;
  }

  info("metrics-engine", `Monthly scorecard captured: $${monthly.revenue} revenue, ${monthly.churn_rate}% churn, ${monthly.ltv_cac_ratio}x LTV:CAC`);
  return monthly;
}

// ============================================================
// QUERY FUNCTIONS
// Everything reads from here. Dashboard, Midas, morning brief.
// ============================================================

/**
 * Get the full scorecard: latest monthly + daily sparkline history.
 * This is what the dashboard calls.
 */
export async function getScorecard(supabase: SupabaseClient, dailyDays = 90): Promise<ScorecardView> {
  // Use the RPC function for efficiency
  const { data, error } = await supabase.rpc("get_scorecard", { p_daily_days: dailyDays });

  if (error) {
    logError("metrics-engine", `Failed to read scorecard: ${error.message}`);
    return { monthly: null, daily: [] };
  }

  const rows = data || [];
  const monthlyRow = rows.find((r: any) => r.period_type === "monthly") || null;
  const dailyRows = rows.filter((r: any) => r.period_type === "daily");

  return {
    monthly: monthlyRow
      ? {
          date: monthlyRow.date,
          revenue: monthlyRow.revenue,
          cogs: monthlyRow.cogs,
          gross_margin: monthlyRow.gross_margin,
          net_income: monthlyRow.net_income,
          net_margin: monthlyRow.net_margin,
          cash_on_hand: monthlyRow.cash_on_hand,
          active_patients: monthlyRow.active_patients,
          mrr: monthlyRow.mrr,
          new_patients: monthlyRow.new_patients,
          cancellations: monthlyRow.cancellations,
          churn_rate: monthlyRow.churn_rate,
          annual_churn: monthlyRow.annual_churn,
          avg_tenure_months: monthlyRow.avg_tenure_months,
          median_tenure_months: monthlyRow.median_tenure_months,
          ltv: monthlyRow.ltv,
          leads: monthlyRow.leads,
          ad_spend: monthlyRow.ad_spend,
          cpl: monthlyRow.cpl,
          show_rate: monthlyRow.show_rate,
          close_rate: monthlyRow.close_rate,
          cac: monthlyRow.cac,
          ltv_cac_ratio: monthlyRow.ltv_cac_ratio,
          validated: monthlyRow.validated,
          metadata: monthlyRow.metadata || {},
        }
      : null,
    daily: dailyRows.map((r: any) => ({
      date: r.date,
      leads: r.leads,
      ad_spend: r.ad_spend,
      cpl: r.cpl,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      lp_views: r.lp_views,
      show_rate: r.show_rate,
      close_rate: r.close_rate,
      pipeline_total: r.pipeline_total,
      pipeline_open: r.pipeline_open,
      pipeline_won: r.pipeline_won,
      pipeline_lost: r.pipeline_lost,
      pipeline_noshow: r.pipeline_noshow,
    })),
  };
}

/**
 * Get just the latest monthly metrics. Used by Midas, morning brief context.
 */
export async function getLatestMonthly(supabase: SupabaseClient): Promise<MonthlyRow | null> {
  const { data, error } = await supabase
    .from("business_scorecard")
    .select("*")
    .eq("period_type", "monthly")
    .order("date", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as MonthlyRow;
}

/**
 * Get daily history for a specific metric. Used for sparklines and trends.
 */
export async function getDailyHistory(
  supabase: SupabaseClient,
  days = 90,
): Promise<DailyRow[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const { data, error } = await supabase
    .from("business_scorecard")
    .select("*")
    .eq("period_type", "daily")
    .gte("date", cutoff.toISOString().split("T")[0])
    .order("date", { ascending: true });

  if (error || !data) return [];
  return data as DailyRow[];
}

/**
 * Get monthly history for trend comparison (e.g., MoM revenue chart).
 */
export async function getMonthlyHistory(
  supabase: SupabaseClient,
  months = 12,
): Promise<MonthlyRow[]> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  const { data, error } = await supabase
    .from("business_scorecard")
    .select("*")
    .eq("period_type", "monthly")
    .gte("date", cutoff.toISOString().split("T")[0])
    .order("date", { ascending: true });

  if (error || !data) return [];
  return data as MonthlyRow[];
}

/**
 * Format scorecard for Telegram. Compact view for /pulse command.
 */
export async function formatPulse(supabase: SupabaseClient): Promise<string> {
  const scorecard = await getScorecard(supabase, 7);

  if (!scorecard.monthly) {
    return "No monthly metrics available. Run monthly capture first.";
  }

  const m = scorecard.monthly;
  const recent = scorecard.daily;
  const today = recent.length > 0 ? recent[recent.length - 1] : null;

  // Calculate WoW direction arrows from daily data
  const wow = getWoWArrows(recent);

  const lines = [
    "**PV Scorecard**\n",
    "**The Money**",
    `Revenue MTD: $${fmt(m.revenue)}`,
    `Net Margin: ${m.net_margin}%`,
    `Cash: $${fmt(m.cash_on_hand)}\n`,
    "**The Bucket**",
    `Active Patients: ${m.active_patients}`,
    `Monthly Churn: ${m.churn_rate}% ${wow.churn}`,
    `Avg Tenure: ${m.avg_tenure_months} mo`,
    `LTV: $${fmt(m.ltv)}\n`,
    "**The Funnel**",
    `Leads Today: ${today?.leads ?? "—"} ${wow.leads}`,
    `CPL: $${today?.cpl ?? m.cpl ?? "—"} ${wow.cpl}`,
    `Show Rate: ${today?.show_rate ?? m.show_rate ?? "—"}% ${wow.showRate}`,
    `Close Rate: ${today?.close_rate ?? m.close_rate ?? "—"}%`,
    `CAC: $${fmt(m.cac)}`,
    `LTV:CAC: ${m.ltv_cac_ratio}x`,
  ];

  return lines.join("\n");
}

// ============================================================
// HELPERS
// ============================================================

function round2(n: number | null | undefined): number {
  if (n == null || isNaN(n)) return 0;
  return Math.round(n * 100) / 100;
}

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function getWoWArrows(daily: DailyRow[]): Record<string, string> {
  if (daily.length < 2) return { leads: "", cpl: "", showRate: "", churn: "" };

  const recent = daily.slice(-7);
  const prior = daily.slice(-14, -7);
  if (prior.length === 0) return { leads: "", cpl: "", showRate: "", churn: "" };

  const avg = (arr: (number | null)[]): number => {
    const valid = arr.filter((v): v is number => v != null && !isNaN(v));
    return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  };

  const arrow = (current: number, previous: number, higherIsBetter: boolean): string => {
    if (previous === 0) return "";
    const pct = ((current - previous) / previous) * 100;
    if (Math.abs(pct) < 3) return "→";
    const up = pct > 0;
    return up === higherIsBetter ? "↑" : "↓";
  };

  return {
    leads: arrow(avg(recent.map((d) => d.leads)), avg(prior.map((d) => d.leads)), true),
    cpl: arrow(avg(recent.map((d) => d.cpl)), avg(prior.map((d) => d.cpl)), false), // lower is better
    showRate: arrow(avg(recent.map((d) => d.show_rate)), avg(prior.map((d) => d.show_rate)), true),
    churn: "", // churn is monthly, no daily WoW
  };
}
