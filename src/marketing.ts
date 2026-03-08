/**
 * Atlas — Midas Marketing Intelligence Module
 *
 * Analysis and attribution layer on top of existing data collection.
 * Does NOT collect data (ad-tracker.ts, meta.ts, ghl.ts handle that).
 * Reads outputs from data/*.json and stitches them into funnel insights.
 *
 * Cron jobs call these functions; the Midas agent file defines the persona.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { info, warn, error as logError } from "./logger.ts";
import { runPrompt } from "./prompt-runner.ts";
import { MODELS } from "./constants.ts";
import { isGHLReady, getPipelineAttribution } from "./ghl.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const MEMORY_DIR = join(PROJECT_DIR, "memory");
const MARKETING_DIR = join(MEMORY_DIR, "marketing");

// ============================================================
// TYPES
// ============================================================

export interface FunnelStageMetrics {
  date: string;
  impressions: number;
  clicks: number;
  lpViews: number;
  formSubmits: number;
  leadsCreated: number;
  consultationsBooked: number;
  consultationsShowed: number;
  closed: number;
}

export interface FunnelAlert {
  date: string;
  stage: string;
  metric: string;
  currentValue: number;
  avgValue: number;
  dropPct: number;
  severity: "warning" | "critical";
  message: string;
}

export interface AttributionRow {
  source: string;
  spend: number;
  leads: number;
  booked: number;
  showed: number;
  patients: number;
  revenue: number;
  cpl: number;
  cac: number;
  roas: number;
  showRate: number;
  closeRate: number;
}

export interface AdDigestEntry {
  adId: string;
  adName: string;
  campaignName: string;
  spend7d: number;
  cpl7d: number;
  ctr7d: number;
  frequency7d: number;
  trend: "improving" | "stable" | "declining";
  alerts: string[];
  hookType?: string;
  simGroup?: string;
}

interface MarketingState {
  funnelHistory: FunnelStageMetrics[];
  lastDigest: string;
  lastAttribution: string;
}

// ============================================================
// STATE PERSISTENCE
// ============================================================

const STATE_FILE = join(DATA_DIR, "marketing-state.json");

function loadState(): MarketingState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (err) {
    warn("marketing", `Failed to load state: ${err}`);
  }
  return { funnelHistory: [], lastDigest: "", lastAttribution: "" };
}

function saveState(state: MarketingState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  // 90-day retention
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().split("T")[0];
  state.funnelHistory = state.funnelHistory.filter(f => f.date >= cutoff);
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// FUNNEL CONVERSION MONITOR (Daily 9 AM job)
// ============================================================

/**
 * Build yesterday's funnel metrics from existing data sources.
 * Reads: ad-tracker.json (impressions/clicks), lead-volume.json (leads by source),
 * show-rate-state.json (show/no-show data).
 */
export function buildFunnelSnapshot(dateStr: string): FunnelStageMetrics | null {
  const snapshot: FunnelStageMetrics = {
    date: dateStr,
    impressions: 0,
    clicks: 0,
    lpViews: 0,
    formSubmits: 0,
    leadsCreated: 0,
    consultationsBooked: 0,
    consultationsShowed: 0,
    closed: 0,
  };

  // Pull from ad-tracker.json for impressions/clicks
  try {
    const trackerPath = join(DATA_DIR, "ad-tracker.json");
    if (existsSync(trackerPath)) {
      const tracker = JSON.parse(readFileSync(trackerPath, "utf-8"));
      const daySnapshots = (tracker.snapshots || []).filter(
        (s: { date: string }) => s.date === dateStr
      );
      for (const s of daySnapshots) {
        snapshot.impressions += s.impressions || 0;
        snapshot.clicks += s.clicks || 0;
      }
    }
  } catch (err) {
    warn("marketing", `Failed to read ad-tracker for funnel: ${err}`);
  }

  // Pull from lead-volume.json for daily lead count
  try {
    const leadPath = join(DATA_DIR, "lead-volume.json");
    if (existsSync(leadPath)) {
      const leadData = JSON.parse(readFileSync(leadPath, "utf-8"));
      const dayEntry = (leadData.days || leadData).find?.(
        (d: { date: string }) => d.date === dateStr
      );
      if (dayEntry) {
        snapshot.leadsCreated = dayEntry.total || dayEntry.count || 0;
        // form submits ~ leads for now (1:1 mapping from LP to GHL)
        snapshot.formSubmits = snapshot.leadsCreated;
      }
    }
  } catch (err) {
    warn("marketing", `Failed to read lead-volume for funnel: ${err}`);
  }

  // LP views estimated from clicks (not all clicks reach LP due to bounce)
  // Using 85% pass-through as industry standard estimate
  snapshot.lpViews = Math.round(snapshot.clicks * 0.85);

  // Show rate data from show-rate-state.json
  try {
    const showRatePath = join(DATA_DIR, "show-rate-state.json");
    if (existsSync(showRatePath)) {
      const showData = JSON.parse(readFileSync(showRatePath, "utf-8"));
      // Extract daily stats if available
      const dailyStats = showData.dailyStats?.[dateStr];
      if (dailyStats) {
        snapshot.consultationsBooked = dailyStats.remindersTotal || 0;
        snapshot.consultationsShowed = dailyStats.showed || 0;
      }
    }
  } catch (err) {
    warn("marketing", `Failed to read show-rate for funnel: ${err}`);
  }

  // Only return if we have at least some data
  if (snapshot.impressions === 0 && snapshot.leadsCreated === 0) {
    return null;
  }

  return snapshot;
}

/**
 * Compare today's funnel snapshot against 7-day rolling average.
 * Returns alerts for any stage with >20% drop.
 */
export function checkFunnelHealth(current: FunnelStageMetrics): FunnelAlert[] {
  const state = loadState();
  const alerts: FunnelAlert[] = [];

  // Need at least 3 days of history for meaningful comparison
  if (state.funnelHistory.length < 3) {
    // Store this snapshot and return no alerts
    state.funnelHistory.push(current);
    saveState(state);
    return [];
  }

  // 7-day rolling average (or all available if < 7)
  const recent = state.funnelHistory.slice(-7);

  const stages: Array<{ key: keyof FunnelStageMetrics; label: string }> = [
    { key: "impressions", label: "Impressions" },
    { key: "clicks", label: "Clicks" },
    { key: "lpViews", label: "LP Views" },
    { key: "formSubmits", label: "Form Submits" },
    { key: "leadsCreated", label: "Leads Created" },
    { key: "consultationsBooked", label: "Consultations Booked" },
    { key: "consultationsShowed", label: "Consultations Showed" },
  ];

  for (const stage of stages) {
    const avg = recent.reduce((sum, f) => sum + (f[stage.key] as number), 0) / recent.length;
    if (avg === 0) continue; // Can't compare against zero

    const currentVal = current[stage.key] as number;
    const dropPct = ((avg - currentVal) / avg) * 100;

    if (dropPct > 40) {
      alerts.push({
        date: current.date,
        stage: stage.label,
        metric: stage.key,
        currentValue: currentVal,
        avgValue: Math.round(avg * 10) / 10,
        dropPct: Math.round(dropPct),
        severity: "critical",
        message: `${stage.label} dropped ${Math.round(dropPct)}% vs 7-day avg (${currentVal} vs ${Math.round(avg)})`,
      });
    } else if (dropPct > 20) {
      alerts.push({
        date: current.date,
        stage: stage.label,
        metric: stage.key,
        currentValue: currentVal,
        avgValue: Math.round(avg * 10) / 10,
        dropPct: Math.round(dropPct),
        severity: "warning",
        message: `${stage.label} dropped ${Math.round(dropPct)}% vs 7-day avg (${currentVal} vs ${Math.round(avg)})`,
      });
    }
  }

  // Store this snapshot
  state.funnelHistory.push(current);
  saveState(state);

  return alerts;
}

/**
 * Format funnel alerts for Telegram.
 */
export function formatFunnelAlerts(alerts: FunnelAlert[]): string {
  if (alerts.length === 0) return "";

  const lines = ["**Midas Funnel Alert**"];

  const critical = alerts.filter(a => a.severity === "critical");
  const warnings = alerts.filter(a => a.severity === "warning");

  if (critical.length > 0) {
    lines.push("");
    lines.push("CRITICAL:");
    for (const a of critical) {
      lines.push(`  ${a.message}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push("WARNING:");
    for (const a of warnings) {
      lines.push(`  ${a.message}`);
    }
  }

  return lines.join("\n");
}

// ============================================================
// AD PERFORMANCE DIGEST (Daily 9:30 PM job)
// ============================================================

/**
 * Build Midas-layer ad digest from existing ad-tracker data.
 * Adds: trend detection, entity diversity scoring, hook type mapping,
 * spend pacing, and threshold-based alerts with Midas context.
 */
export function buildAdDigest(): { entries: AdDigestEntry[]; summary: string } {
  const entries: AdDigestEntry[] = [];

  // Load ad-tracker data
  let snapshots: Array<{
    date: string; adId: string; adName: string; campaignName: string;
    spend: number; impressions: number; clicks: number; conversions: number;
    cpl: number; ctr: number; frequency: number; reach: number;
  }> = [];

  try {
    const trackerPath = join(DATA_DIR, "ad-tracker.json");
    if (existsSync(trackerPath)) {
      const tracker = JSON.parse(readFileSync(trackerPath, "utf-8"));
      snapshots = tracker.snapshots || [];
    }
  } catch (err) {
    warn("marketing", `Failed to read ad-tracker for digest: ${err}`);
    return { entries: [], summary: "Failed to read ad-tracker data." };
  }

  if (snapshots.length === 0) {
    return { entries: [], summary: "No ad data available." };
  }

  // 7-day window
  const cutoff7d = new Date(Date.now() - 7 * 86_400_000).toISOString().split("T")[0];
  // 14-day window for trend comparison
  const cutoff14d = new Date(Date.now() - 14 * 86_400_000).toISOString().split("T")[0];

  // Group by adId
  const byAd: Record<string, typeof snapshots> = {};
  for (const s of snapshots) {
    if (!byAd[s.adId]) byAd[s.adId] = [];
    byAd[s.adId].push(s);
  }

  // Load creative taxonomy for hook type mapping
  let taxonomy: Record<string, { hookType: string; simGroup: string }> = {};
  try {
    const taxPath = join(MARKETING_DIR, "campaigns", "creative-taxonomy.md");
    if (existsSync(taxPath)) {
      const content = readFileSync(taxPath, "utf-8");
      // Parse ad name to hook type from the taxonomy tables
      const rows = content.match(/\| ([\w-]+(?:-IMG-\d+)?[^|]*)\| (\w+)\s*\|[^|]+\| (\w+)\s*\| (SIM-\w+)/g);
      if (rows) {
        for (const row of rows) {
          const parts = row.split("|").map(p => p.trim()).filter(Boolean);
          if (parts.length >= 4) {
            const adNamePrefix = parts[0].split(" ")[0]; // e.g., KICKSTART-IMG-01
            taxonomy[adNamePrefix] = { hookType: parts[1], simGroup: parts[3] };
          }
        }
      }
    }
  } catch {
    // Taxonomy is optional enhancement
  }

  // Load thresholds
  let cplWarning = 65, cplCritical = 100;
  let ctrWarning = 1.5, freqWarning = 3.0, freqCritical = 4.0;
  try {
    const threshPath = join(MARKETING_DIR, "thresholds.md");
    if (existsSync(threshPath)) {
      const content = readFileSync(threshPath, "utf-8");
      const cplW = content.match(/CPL\s*\|\s*>\$(\d+)\s*\|\s*>\$(\d+)/);
      if (cplW) { cplWarning = Number(cplW[1]); cplCritical = Number(cplW[2]); }
      const freqW = content.match(/Frequency\s*\|\s*>(\d+\.?\d*)\s*\|\s*>(\d+\.?\d*)/);
      if (freqW) { freqWarning = Number(freqW[1]); freqCritical = Number(freqW[2]); }
    }
  } catch {
    // Use defaults
  }

  for (const [adId, adSnapshots] of Object.entries(byAd)) {
    const recent7d = adSnapshots.filter(s => s.date >= cutoff7d);
    const prev7d = adSnapshots.filter(s => s.date >= cutoff14d && s.date < cutoff7d);

    if (recent7d.length === 0) continue;

    const latest = recent7d[recent7d.length - 1];
    const spend7d = recent7d.reduce((s, snap) => s + snap.spend, 0);
    const conversions7d = recent7d.reduce((s, snap) => s + snap.conversions, 0);
    const cpl7d = conversions7d > 0 ? spend7d / conversions7d : Infinity;
    const avgCtr7d = recent7d.reduce((s, snap) => s + snap.ctr, 0) / recent7d.length;
    const avgFreq7d = recent7d.reduce((s, snap) => s + snap.frequency, 0) / recent7d.length;

    // Trend: compare 7d CPL to previous 7d CPL
    let trend: "improving" | "stable" | "declining" = "stable";
    if (prev7d.length >= 2) {
      const prevSpend = prev7d.reduce((s, snap) => s + snap.spend, 0);
      const prevConv = prev7d.reduce((s, snap) => s + snap.conversions, 0);
      const prevCPL = prevConv > 0 ? prevSpend / prevConv : Infinity;
      if (cpl7d < prevCPL * 0.85) trend = "improving";
      else if (cpl7d > prevCPL * 1.15) trend = "declining";
    }

    // Alerts
    const alerts: string[] = [];
    if (cpl7d > cplCritical && spend7d > 50) alerts.push(`CPL ${cpl7d === Infinity ? "N/A - no conversions" : "$" + cpl7d.toFixed(0)} (critical >${cplCritical})`);
    else if (cpl7d > cplWarning && spend7d > 30) alerts.push(`CPL ${cpl7d === Infinity ? "N/A - no conversions" : "$" + cpl7d.toFixed(0)} (warning >${cplWarning})`);
    if (avgFreq7d > freqCritical) alerts.push(`Frequency ${avgFreq7d.toFixed(1)} (critical >${freqCritical})`);
    else if (avgFreq7d > freqWarning) alerts.push(`Frequency ${avgFreq7d.toFixed(1)} (warning >${freqWarning})`);
    if (avgCtr7d < ctrWarning && spend7d > 20) alerts.push(`CTR ${avgCtr7d.toFixed(2)}% (warning <${ctrWarning}%)`);

    // Match hook type from taxonomy
    const adPrefix = latest.adName.split(" ")[0];
    const taxEntry = taxonomy[adPrefix];

    entries.push({
      adId,
      adName: latest.adName,
      campaignName: latest.campaignName,
      spend7d: Math.round(spend7d * 100) / 100,
      cpl7d: cpl7d === Infinity ? -1 : Math.round(cpl7d * 100) / 100,
      ctr7d: Math.round(avgCtr7d * 100) / 100,
      frequency7d: Math.round(avgFreq7d * 100) / 100,
      trend,
      alerts,
      hookType: taxEntry?.hookType,
      simGroup: taxEntry?.simGroup,
    });
  }

  // Sort by spend descending
  entries.sort((a, b) => b.spend7d - a.spend7d);

  // Build summary
  const totalSpend = entries.reduce((s, e) => s + e.spend7d, 0);
  const adsWithAlerts = entries.filter(e => e.alerts.length > 0);
  const declining = entries.filter(e => e.trend === "declining");
  const improving = entries.filter(e => e.trend === "improving");

  // Entity diversity: count unique SIM groups among active ads
  const activeSims = new Set(entries.filter(e => e.simGroup).map(e => e.simGroup));

  const summaryLines = [
    `**Midas Ad Digest** (7-day)`,
    `Spend: $${totalSpend.toFixed(0)} across ${entries.length} ads`,
    `Entity diversity: ${activeSims.size} distinct SIM groups`,
  ];

  if (improving.length > 0) {
    summaryLines.push(`Improving: ${improving.map(e => e.adName.split(" |")[0]).join(", ")}`);
  }
  if (declining.length > 0) {
    summaryLines.push(`Declining: ${declining.map(e => e.adName.split(" |")[0]).join(", ")}`);
  }
  if (adsWithAlerts.length > 0) {
    summaryLines.push("");
    summaryLines.push(`Alerts (${adsWithAlerts.length} ads):`);
    for (const e of adsWithAlerts.slice(0, 5)) {
      summaryLines.push(`  ${e.adName.split(" |")[0]}: ${e.alerts.join("; ")}`);
    }
  }

  const summary = summaryLines.join("\n");

  // Update state
  const state = loadState();
  state.lastDigest = new Date().toISOString();
  saveState(state);

  return { entries, summary };
}

// ============================================================
// FULL-FUNNEL ATTRIBUTION (Weekly Sunday job)
// ============================================================

/**
 * Build weekly full-funnel attribution report.
 * Stitches: Meta spend → GHL leads (by source) → booked → showed → patient → revenue
 *
 * This is the highest-value analysis Midas produces.
 * Saved to memory/marketing/attribution/{date}.md
 */
export async function buildWeeklyAttribution(): Promise<{ report: string; rows: AttributionRow[] }> {
  const rows: AttributionRow[] = [];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });

  // ---- Meta Ad Spend by Campaign ----
  let campaignSpend: Record<string, number> = {};
  try {
    const trackerPath = join(DATA_DIR, "ad-tracker.json");
    if (existsSync(trackerPath)) {
      const tracker = JSON.parse(readFileSync(trackerPath, "utf-8"));
      const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().split("T")[0];
      const recent = (tracker.snapshots || []).filter((s: { date: string }) => s.date >= cutoff);
      for (const s of recent) {
        const campaign = s.campaignName || "Unknown";
        campaignSpend[campaign] = (campaignSpend[campaign] || 0) + (s.spend || 0);
      }
    }
  } catch (err) {
    warn("marketing", `Attribution: failed to read ad spend: ${err}`);
  }

  // ---- Lead Volume by Source ----
  let leadsBySource: Record<string, number> = {};
  try {
    const leadPath = join(DATA_DIR, "lead-volume.json");
    if (existsSync(leadPath)) {
      const leadData = JSON.parse(readFileSync(leadPath, "utf-8"));
      const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().split("T")[0];
      const days = (leadData.days || leadData || []).filter(
        (d: { date: string }) => d.date >= cutoff
      );
      for (const day of days) {
        if (day.sources) {
          for (const [source, count] of Object.entries(day.sources)) {
            leadsBySource[source] = (leadsBySource[source] || 0) + (count as number);
          }
        } else {
          leadsBySource["unknown"] = (leadsBySource["unknown"] || 0) + (day.total || day.count || 0);
        }
      }
    }
  } catch (err) {
    warn("marketing", `Attribution: failed to read lead volume: ${err}`);
  }

  // ---- GHL Pipeline Data (real funnel metrics) ----
  let pipelineData: Awaited<ReturnType<typeof getPipelineAttribution>> | null = null;
  let usingRealData = false;

  if (isGHLReady()) {
    try {
      pipelineData = await getPipelineAttribution(7);
      usingRealData = true;
      info("marketing", `Attribution: got real pipeline data (${pipelineData.totalOpps} opportunities)`);
    } catch (err) {
      warn("marketing", `Attribution: GHL pipeline fetch failed, falling back to estimates: ${err}`);
    }
  }

  // ---- Build Attribution Rows ----
  const allSources = new Set([
    ...Object.keys(campaignSpend),
    ...Object.keys(leadsBySource),
    ...(pipelineData ? Object.keys(pipelineData.bySource) : []),
  ]);

  const totalSpend = Object.values(campaignSpend).reduce((a, b) => a + b, 0);

  // Estimated LTV for revenue projection (used when monetaryValue not set in GHL)
  const avgRevPerPatient = 376 * 7.2; // $376/mo * 7.2 months avg tenure = $2,707

  for (const source of allSources) {
    const spend = campaignSpend[source] || 0;
    const pData = pipelineData?.bySource[source];

    let leads: number, booked: number, showed: number, patients: number, revenue: number;

    if (usingRealData && pData) {
      // Real GHL pipeline data
      leads = pData.leads;
      booked = pData.booked;
      showed = pData.showed;
      patients = pData.closed;
      revenue = pData.revenue > 0 ? pData.revenue : patients * avgRevPerPatient;
    } else {
      // Fallback: lead volume + estimated conversion rates
      leads = leadsBySource[source] || 0;
      booked = Math.round(leads * 0.45);
      showed = Math.round(booked * 0.70);
      patients = Math.round(showed * 0.1984);
      revenue = patients * avgRevPerPatient;
    }

    const cpl = leads > 0 ? spend / leads : spend > 0 ? Infinity : 0;
    const showRate = booked > 0 ? showed / booked : 0;
    const closeRate = showed > 0 ? patients / showed : 0;
    const cac = patients > 0 ? spend / patients : 0;
    const roas = spend > 0 ? revenue / spend : 0;

    rows.push({
      source,
      spend: Math.round(spend * 100) / 100,
      leads,
      booked,
      showed,
      patients,
      revenue: Math.round(revenue),
      cpl: cpl === Infinity ? -1 : Math.round(cpl * 100) / 100,
      cac: Math.round(cac * 100) / 100,
      roas: Math.round(roas * 100) / 100,
      showRate: Math.round(showRate * 100),
      closeRate: Math.round(closeRate * 100 * 10) / 10,
    });
  }

  // Sort by spend descending
  rows.sort((a, b) => b.spend - a.spend);

  const totalLeads = rows.reduce((s, r) => s + r.leads, 0);
  const dataLabel = usingRealData ? "GHL pipeline" : "estimated";

  // ---- Build Report ----
  const reportLines = [
    `# Midas Weekly Attribution Report`,
    `Week ending: ${today}`,
    `Data source: ${usingRealData ? "GHL pipeline (real)" : "Estimated conversion rates (GHL unavailable)"}`,
    ``,
    `## Summary`,
    `- Total ad spend: $${totalSpend.toFixed(0)}`,
    `- Total leads: ${totalLeads}`,
    `- Blended CPL: $${totalLeads > 0 ? (totalSpend / totalLeads).toFixed(0) : "N/A"}`,
    ``,
    `## By Source`,
    ``,
    `| Source | Spend | Leads | CPL | Booked | Showed | Patients | Revenue (${dataLabel}) | ROAS |`,
    `|--------|-------|-------|-----|--------|--------|----------|--------------|------|`,
  ];

  for (const row of rows) {
    const cplStr = row.cpl === -1 ? "N/A" : `$${row.cpl.toFixed(0)}`;
    reportLines.push(
      `| ${row.source} | $${row.spend.toFixed(0)} | ${row.leads} | ${cplStr} | ${row.booked} | ${row.showed} | ${row.patients} | $${row.revenue.toLocaleString()} | ${row.roas.toFixed(1)}x |`
    );
  }

  reportLines.push("");
  reportLines.push("## Notes");
  if (usingRealData) {
    reportLines.push("- Booked/showed/patients pulled from GHL pipeline stages (real data)");
    reportLines.push("- Revenue uses GHL monetaryValue when set, otherwise estimated LTV ($376/mo x 7.2 months = $2,707)");
    reportLines.push("- Source matching depends on GHL opportunity source tags being set correctly");
  } else {
    reportLines.push("- GHL pipeline was unavailable. Using estimated rates: 45% book, 70% show, 19.84% close");
    reportLines.push("- Revenue estimated using $376/mo avg x 7.2 months avg tenure = $2,707 LTV");
  }
  reportLines.push("- TODO: Wire QuickBooks revenue data for actual revenue attribution");

  const report = reportLines.join("\n");

  // Save to attribution directory
  const attrDir = join(MARKETING_DIR, "attribution");
  if (!existsSync(attrDir)) mkdirSync(attrDir, { recursive: true });
  writeFileSync(join(attrDir, `${today}.md`), report);
  info("marketing", `Attribution report saved: attribution/${today}.md`);

  // Update state
  const state = loadState();
  state.lastAttribution = today;
  saveState(state);

  return { report, rows };
}

// ============================================================
// TELEGRAM FORMATTERS
// ============================================================

/**
 * Format weekly attribution for Telegram (condensed version).
 */
export function formatAttributionTelegram(rows: AttributionRow[], totalSpend: number, totalLeads: number): string {
  const lines = [
    `**Midas Weekly Attribution**`,
    `Spend: $${totalSpend.toFixed(0)} | Leads: ${totalLeads} | CPL: $${totalLeads > 0 ? (totalSpend / totalLeads).toFixed(0) : "N/A"}`,
    ``,
  ];

  for (const row of rows.slice(0, 5)) {
    const cplStr = row.cpl === -1 ? "N/A" : `$${row.cpl.toFixed(0)}`;
    lines.push(`${row.source}: ${row.leads} leads, ${cplStr} CPL, ${row.roas.toFixed(1)}x ROAS`);
  }

  if (rows.length > 5) {
    lines.push(`...and ${rows.length - 5} more sources`);
  }

  return lines.join("\n");
}

// ============================================================
// CONTENT HOOKS MEMO (Tues/Fri 7 AM)
// ============================================================

/**
 * Build a content hooks memo by searching GLP-1 / weight loss trends
 * and generating 3 hook ideas with angle + recommended pillar.
 * Uses Opus for strategic creative depth.
 */
export async function buildContentHooksMemo(): Promise<string> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });

  // Gather business context for the prompt
  let businessContext = "";
  try {
    const biblePath = join(MARKETING_DIR, "business-bible.md");
    if (existsSync(biblePath)) {
      const content = readFileSync(biblePath, "utf-8");
      const sections = content.match(/## (The Offer|Content & Creative Frameworks|What Midas Must NEVER Do)[\s\S]*?(?=\n## |$)/g);
      businessContext = sections ? sections.join("\n\n") : content.slice(0, 2000);
    }
  } catch {}

  // Gather playbook for what's worked
  let playbookContext = "";
  try {
    const playbookPath = join(MARKETING_DIR, "playbook.md");
    if (existsSync(playbookPath)) {
      playbookContext = readFileSync(playbookPath, "utf-8").slice(0, 1500);
    }
  } catch {}

  // Gather content tracker for recent content (avoid repeats)
  let recentContent = "";
  try {
    const trackerPath = join(DATA_DIR, "content-tracker.json");
    if (existsSync(trackerPath)) {
      const tracker = JSON.parse(readFileSync(trackerPath, "utf-8"));
      const recent = (tracker.entries || []).slice(-10);
      recentContent = recent.map((e: any) => `${e.date}: ${e.pillar} - ${e.subtopic}`).join("\n");
    }
  } catch {}

  // Check content-hooks dir for previous memos to avoid repetition
  let previousHooks = "";
  try {
    const hooksDir = join(MARKETING_DIR, "content-hooks");
    if (existsSync(hooksDir)) {
      const files = readdirSync(hooksDir).filter(f => f.endsWith(".md")).sort().slice(-3);
      for (const f of files) {
        const content = readFileSync(join(hooksDir, f), "utf-8");
        previousHooks += `\n--- ${f} ---\n${content.slice(0, 500)}`;
      }
    }
  } catch {}

  const prompt = `You are Midas, marketing strategist for PV MediSpa & Weight Loss (Prescott Valley, AZ).

Generate a Content Hooks Memo with 3 content hook ideas based on current GLP-1, weight loss, and functional medicine trends.

## Business Context
${businessContext || "(see constraints below)"}

## What's Worked Before
${playbookContext || "(no playbook data)"}

## Recent Content (avoid repeating)
${recentContent || "(none tracked)"}

## Previous Hook Memos (avoid repeating)
${previousHooks || "(none yet)"}

## Key Constraints
- We use compounded GLP-1s (semaglutide/tirzepatide from Hallandale Pharmacy), NOT brand-name (no Ozempic/Wegovy/Mounjaro/Zepbound)
- LegitScript certified. Can say "GLP-1", "semaglutide", "tirzepatide"
- Body comp uses SCALE equipment (not InBody, not DEXA)
- No before/after body images, no guaranteed outcomes
- 5 Pillars: Precision Weight Science, Nourishing Health, Dynamic Movement, Mindful Wellness, Functional Wellness
- Named frameworks: SLOW & SHIELD, Vitality Tracker, Protein Paradox, Fuel Code, Calm Core Toolkit, Cooling Fuel Protocol, Movement Hierarchy

## Hook Classification
Classify each hook by type: ELIG (eligibility), CURI (curiosity), PAIN (pain point), CRED (credibility), FEAR (fear/urgency), SKEP (skeptic conversion), CONV (convenience), NOBL (noble cause), OUTC (outcome), MYTH (myth-busting)

## Output Format (exactly this structure)
### Hook 1: [Title]
- **Hook Type:** [CODE]
- **Pillar:** [which of the 5]
- **Angle:** [Hormozi Value Equation component it targets: Dream Outcome / Perceived Likelihood / Time Delay / Effort-Sacrifice]
- **Why now:** [What trend or news makes this timely]
- **Ad copy starter:** [2-3 sentence hook that could open an ad or post]
- **Visual suggestion:** [IMG/VID/UGC/GFX/TST/CRS + brief description]

### Hook 2: [Title]
(same structure)

### Hook 3: [Title]
(same structure)

Think about what's MISSING from our current creative mix (see playbook) and what trends make something timely RIGHT NOW. Don't recycle generic weight loss hooks. Be specific to our market position.`;

  const result = await runPrompt(prompt, MODELS.opus);

  if (result && result.length > 200) {
    const hooksDir = join(MARKETING_DIR, "content-hooks");
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
    const filename = `${today}.md`;
    const header = `# Content Hooks Memo\n*${today} | Generated by Midas (Opus)*\n\n---\n\n`;
    writeFileSync(join(hooksDir, filename), header + result);
    info("marketing", `Content hooks memo saved: content-hooks/${filename}`);

    // Retention: keep only last 30 memos
    try {
      const files = readdirSync(hooksDir).filter(f => f.endsWith(".md")).sort();
      if (files.length > 30) {
        for (const f of files.slice(0, files.length - 30)) {
          try { writeFileSync(join(hooksDir, f), ""); } catch {}
        }
      }
    } catch {}

    return result;
  }

  warn("marketing", "Content hooks memo: empty or too-short response from Opus");
  return "";
}

// ============================================================
// COMPETITOR RECON (Weekly Wednesday)
// ============================================================

/**
 * Run weekly competitor reconnaissance.
 * Reads the watchlist, researches competitor activity, and writes analysis.
 */
export async function runCompetitorRecon(): Promise<string> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });

  // Load watchlist
  let watchlist = "";
  try {
    const watchlistPath = join(MARKETING_DIR, "competitors", "watchlist.md");
    if (existsSync(watchlistPath)) {
      watchlist = readFileSync(watchlistPath, "utf-8");
    }
  } catch {}

  // Load existing competitive intel
  let existingIntel = "";
  try {
    const intelPath = join(MEMORY_DIR, "competitive-intel.md");
    if (existsSync(intelPath)) {
      existingIntel = readFileSync(intelPath, "utf-8").slice(0, 3000);
    }
  } catch {}

  // Load business bible for our positioning
  let ourPosition = "";
  try {
    const biblePath = join(MARKETING_DIR, "business-bible.md");
    if (existsSync(biblePath)) {
      const content = readFileSync(biblePath, "utf-8");
      const section = content.match(/## Competitive Landscape[\s\S]*?(?=\n## |$)/);
      ourPosition = section ? section[0] : "";
    }
  } catch {}

  // Load last recon if exists
  let lastRecon = "";
  try {
    const reconDir = join(MARKETING_DIR, "competitors");
    const files = readdirSync(reconDir).filter(f => f.startsWith("recon-") && f.endsWith(".md")).sort();
    if (files.length > 0) {
      lastRecon = readFileSync(join(reconDir, files[files.length - 1]), "utf-8").slice(0, 2000);
    }
  } catch {}

  const prompt = `You are Midas, marketing strategist for PV MediSpa & Weight Loss (Prescott Valley, AZ).

Run a weekly competitor reconnaissance report. Analyze competitor positioning, identify threats and opportunities.

## Our Competitive Position
${ourPosition || "(not available)"}

## Competitor Watchlist
${watchlist || "(no watchlist)"}

## Existing Competitive Intel
${existingIntel || "(none)"}

## Last Week's Recon
${lastRecon || "(none - this is the first)"}

## Your Analysis Tasks
1. **Positioning shifts**: For each locked competitor, note any changes in their offer, pricing, or messaging you can identify from the watchlist data.
2. **Threat assessment**: Which competitor is the biggest threat right now and why? Score 1-10.
3. **Opportunity gaps**: What are competitors NOT doing that we could exploit? Look at:
   - Hook types they aren't using
   - Platforms they're ignoring
   - Patient segments they're overlooking
   - Service offerings they lack (e.g., body comp, functional approach, 5-pillar system)
4. **Creative intelligence**: What messaging themes are competitors leaning into? What can we learn?
5. **Rotating slot recommendation**: Should any of the 5 rotating competitor slots be swapped? Who should replace whom and why?

## Output Rules
- Be specific. "They're doing well" is useless. "Superior You is running 3 new UGC-style ads with PAIN hooks targeting women 35-50 who failed with diet alone" is useful.
- Include "so what" for every observation. What should WE do differently because of this?
- If you lack data on a competitor, say so. Don't fabricate.
- End with 3 concrete action items for Derek.

## Format
Use markdown with clear headers per competitor. Keep total output under 1500 words.`;

  const result = await runPrompt(prompt, MODELS.opus);

  if (result && result.length > 200) {
    const reconDir = join(MARKETING_DIR, "competitors");
    if (!existsSync(reconDir)) mkdirSync(reconDir, { recursive: true });
    const filename = `recon-${today}.md`;
    const header = `# Competitor Recon\n*${today} | Generated by Midas (Opus)*\n\n---\n\n`;
    writeFileSync(join(reconDir, filename), header + result);
    info("marketing", `Competitor recon saved: competitors/${filename}`);

    // Retention: keep only last 12 recons (3 months)
    try {
      const files = readdirSync(reconDir).filter(f => f.startsWith("recon-") && f.endsWith(".md")).sort();
      if (files.length > 12) {
        for (const f of files.slice(0, files.length - 12)) {
          try { writeFileSync(join(reconDir, f), ""); } catch {}
        }
      }
    } catch {}

    return result;
  }

  warn("marketing", "Competitor recon: empty or too-short response from Opus");
  return "";
}

// ============================================================
// MONTHLY STRATEGIC BRIEF (1st of month)
// ============================================================

/**
 * Full monthly marketing brief: creative audit, funnel analysis,
 * next month's campaign brief, and playbook update.
 * The capstone analysis Midas produces.
 */
export async function buildMonthlyBrief(): Promise<string> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });
  const monthName = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "America/Phoenix" });

  // 1. Ad tracker data (full month)
  let adData = "";
  try {
    const trackerPath = join(DATA_DIR, "ad-tracker.json");
    if (existsSync(trackerPath)) {
      const tracker = JSON.parse(readFileSync(trackerPath, "utf-8"));
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().split("T")[0];
      const recent = (tracker.snapshots || []).filter((s: { date: string }) => s.date >= cutoff);
      const totalSpend = recent.reduce((s: number, snap: any) => s + (snap.spend || 0), 0);
      const totalConversions = recent.reduce((s: number, snap: any) => s + (snap.conversions || 0), 0);
      const avgCPL = totalConversions > 0 ? totalSpend / totalConversions : 0;
      adData = `Total spend: $${totalSpend.toFixed(0)}, Conversions: ${totalConversions}, Avg CPL: $${avgCPL.toFixed(0)}, Active ads: ${new Set(recent.map((s: any) => s.adId)).size}`;
    }
  } catch {}

  // 2. Lead volume trend
  let leadTrend = "";
  try {
    const leadPath = join(DATA_DIR, "lead-volume.json");
    if (existsSync(leadPath)) {
      const leadData = JSON.parse(readFileSync(leadPath, "utf-8"));
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().split("T")[0];
      const days = (leadData.days || leadData || []).filter((d: { date: string }) => d.date >= cutoff);
      const totalLeads = days.reduce((s: number, d: any) => s + (d.total || d.count || 0), 0);
      leadTrend = `Total leads (30d): ${totalLeads}, Avg/day: ${(totalLeads / Math.max(days.length, 1)).toFixed(1)}`;
    }
  } catch {}

  // 3. Show rate data
  let showRateData = "";
  try {
    const showPath = join(DATA_DIR, "show-rate-state.json");
    if (existsSync(showPath)) {
      const data = JSON.parse(readFileSync(showPath, "utf-8"));
      const stats = data.dailyStats || {};
      const recentDays = Object.entries(stats).slice(-30);
      const totalShowed = recentDays.reduce((s, [_, d]: [string, any]) => s + (d.showed || 0), 0);
      const totalBooked = recentDays.reduce((s, [_, d]: [string, any]) => s + (d.remindersTotal || 0), 0);
      showRateData = `Showed: ${totalShowed}/${totalBooked} (${totalBooked > 0 ? ((totalShowed / totalBooked) * 100).toFixed(0) : "N/A"}% show rate)`;
    }
  } catch {}

  // 4. Creative taxonomy
  let creativeTaxonomy = "";
  try {
    const taxPath = join(MARKETING_DIR, "campaigns", "creative-taxonomy.md");
    if (existsSync(taxPath)) {
      creativeTaxonomy = readFileSync(taxPath, "utf-8").slice(0, 3000);
    }
  } catch {}

  // 5. Attribution reports
  let attributionData = "";
  try {
    const attrDir = join(MARKETING_DIR, "attribution");
    if (existsSync(attrDir)) {
      const files = readdirSync(attrDir).filter(f => f.endsWith(".md")).sort().slice(-4);
      for (const f of files) {
        const content = readFileSync(join(attrDir, f), "utf-8");
        attributionData += `\n--- ${f} ---\n${content.slice(0, 800)}`;
      }
    }
  } catch {}

  // 6. Competitor recons
  let reconData = "";
  try {
    const reconDir = join(MARKETING_DIR, "competitors");
    const files = readdirSync(reconDir).filter(f => f.startsWith("recon-") && f.endsWith(".md")).sort().slice(-4);
    for (const f of files) {
      const content = readFileSync(join(reconDir, f), "utf-8");
      reconData += `\n--- ${f} ---\n${content.slice(0, 600)}`;
    }
  } catch {}

  // 7. Content hooks
  let hooksData = "";
  try {
    const hooksDir = join(MARKETING_DIR, "content-hooks");
    if (existsSync(hooksDir)) {
      const files = readdirSync(hooksDir).filter(f => f.endsWith(".md")).sort().slice(-8);
      for (const f of files) {
        const content = readFileSync(join(hooksDir, f), "utf-8");
        hooksData += `\n--- ${f} ---\n${content.slice(0, 400)}`;
      }
    }
  } catch {}

  // 8. Business bible
  let businessContext = "";
  try {
    const biblePath = join(MARKETING_DIR, "business-bible.md");
    if (existsSync(biblePath)) {
      businessContext = readFileSync(biblePath, "utf-8").slice(0, 3000);
    }
  } catch {}

  // 9. Playbook
  let playbook = "";
  try {
    const playbookPath = join(MARKETING_DIR, "playbook.md");
    if (existsSync(playbookPath)) {
      playbook = readFileSync(playbookPath, "utf-8");
    }
  } catch {}

  // 10. Thresholds
  let thresholds = "";
  try {
    const threshPath = join(MARKETING_DIR, "thresholds.md");
    if (existsSync(threshPath)) {
      thresholds = readFileSync(threshPath, "utf-8");
    }
  } catch {}

  const prompt = `You are Midas, marketing strategist for PV MediSpa & Weight Loss (Prescott Valley, AZ).
Generate the Monthly Marketing Strategic Brief for ${monthName}.

This is THE capstone analysis. It synthesizes all data from the past month into a clear plan for next month.

## Business Context
${businessContext || "(not available)"}

## Ad Performance (30d)
${adData || "(no ad data)"}

## Lead Volume
${leadTrend || "(no lead data)"}

## Show Rate
${showRateData || "(no show data)"}

## Creative Taxonomy
${creativeTaxonomy || "(no taxonomy)"}

## Weekly Attribution Reports
${attributionData || "(none)"}

## Competitor Recons
${reconData || "(none)"}

## Content Hooks Generated
${hooksData || "(none)"}

## Current Playbook
${playbook || "(none)"}

## Current Thresholds
${thresholds || "(none)"}

## Brief Structure (follow exactly)

### 1. Executive Summary (3-5 sentences)
What happened, what it means, what to do about it.

### 2. Creative Audit
- Which ads ran, their performance, and WHY (use 5-layer framework: hook type, Hormozi Value Eq, Brunson HSO, Andromeda entity diversity, visual style)
- What creative themes won/lost and the psychological reason
- Entity diversity score and whether we're being clustered
- Specific ads to kill, scale, or iterate on

### 3. Funnel Analysis
- Full funnel: impressions -> clicks -> LP visits -> leads -> booked -> showed -> closed
- Where is the biggest drop-off and what's causing it?
- Conversion rate at each stage vs benchmarks from thresholds.md

### 4. Competitive Position
- How did our competitive position change this month?
- Any new threats or opportunities from competitor recons?

### 5. Next Month's Campaign Brief
- Budget recommendation (with reasoning)
- 3-5 new creative concepts to test (with hook type, angle, visual style)
- Any offer or messaging pivots recommended
- Content calendar priorities (which pillars need more weight?)

### 6. Playbook Updates
- New lessons learned this month (formatted as bullet points to append to playbook.md)
- Any existing playbook entries that need revision

### 7. Open Questions
- What data gaps are blocking better decisions?
- What should Derek investigate or test?

## Output Rules
- Be direct. Lead with insights, not methodology.
- Use specific numbers. Never say "improved" without a percentage.
- Every recommendation must include: what to do, why, and expected impact.
- Keep total output under 2500 words. Dense, not verbose.`;

  const result = await runPrompt(prompt, MODELS.opus);

  if (result && result.length > 500) {
    const attrDir = join(MARKETING_DIR, "attribution");
    if (!existsSync(attrDir)) mkdirSync(attrDir, { recursive: true });
    const filename = `monthly-brief-${today}.md`;
    const header = `# Monthly Marketing Strategic Brief\n*${monthName} | Generated by Midas (Opus)*\n\n---\n\n`;
    writeFileSync(join(attrDir, filename), header + result);
    info("marketing", `Monthly brief saved: attribution/${filename}`);

    // Extract playbook updates and append
    try {
      const playbookMatch = result.match(/### 6\. Playbook Updates[\s\S]*?(?=### 7\.|$)/);
      if (playbookMatch) {
        const playbookPath = join(MARKETING_DIR, "playbook.md");
        if (existsSync(playbookPath)) {
          const existing = readFileSync(playbookPath, "utf-8");
          const update = `\n\n## Monthly Update (${today})\n${playbookMatch[0].replace(/### 6\. Playbook Updates\n?/, "").trim()}`;
          writeFileSync(playbookPath, existing + update);
          info("marketing", "Playbook updated with monthly lessons");
        }
      }
    } catch (err) {
      warn("marketing", `Failed to update playbook: ${err}`);
    }

    return result;
  }

  warn("marketing", "Monthly brief: empty or too-short response from Opus");
  return "";
}

// ============================================================
// GBP CONTENT DRAFT (Mon/Thu)
// ============================================================

/**
 * Draft a Google Business Profile post from recent content waterfall output.
 * Saves to data/content-drafts/gbp-{date}.md for approval.
 * Must be posted manually via GBP dashboard (API posts get auto-rejected by Google).
 */
export async function draftGBPPost(): Promise<string> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });

  // Find most recent content waterfall output
  let waterfallContent = "";
  try {
    const outputDir = join(DATA_DIR, "task-output");
    if (existsSync(outputDir)) {
      const files = readdirSync(outputDir)
        .filter(f => f.includes("content") && f.endsWith(".md"))
        .sort()
        .reverse();
      for (const f of files.slice(0, 3)) {
        const content = readFileSync(join(outputDir, f), "utf-8");
        if (content.length > 100) {
          waterfallContent = content.slice(0, 2000);
          break;
        }
      }
    }
  } catch {}

  // Also check content-hooks for recent ideas
  let recentHooks = "";
  try {
    const hooksDir = join(MARKETING_DIR, "content-hooks");
    if (existsSync(hooksDir)) {
      const files = readdirSync(hooksDir).filter(f => f.endsWith(".md")).sort().reverse();
      if (files.length > 0) {
        recentHooks = readFileSync(join(hooksDir, files[0]), "utf-8").slice(0, 1000);
      }
    }
  } catch {}

  if (!waterfallContent && !recentHooks) {
    warn("marketing", "GBP draft: no source content found");
    return "";
  }

  const prompt = `You are Midas, drafting a Google Business Profile post for PV MediSpa & Weight Loss (Prescott Valley, AZ).

Adapt this content into a GBP post format: short (100-300 words), local, with a clear CTA.

## Source Content
${waterfallContent || "(no waterfall content)"}

## Recent Content Hook Ideas
${recentHooks || "(none)"}

## GBP Post Rules
- Keep it SHORT. GBP posts are scanned, not read. 100-300 words max.
- Lead with a hook that's relevant to Prescott Valley / Northern AZ residents
- Include a clear CTA: "Call (928) 910-8818" or "Book your consultation at landing.pvmedispa.com/weightloss"
- Use "we" language (first person plural)
- NO brand drug names (no Ozempic/Wegovy/Mounjaro/Zepbound)
- CAN say: GLP-1, semaglutide, tirzepatide, medical weight loss
- NO before/after photos, no guaranteed outcomes
- Mention body comp SCALE if relevant (never InBody or DEXA)
- Tone: warm, professional, approachable. Like a provider who genuinely cares.

## Output
Just the post text. No metadata, no headers. Ready to copy-paste into GBP.`;

  const result = await runPrompt(prompt, MODELS.sonnet); // Sonnet is fine for drafting

  if (result && result.length > 50) {
    const draftsDir = join(DATA_DIR, "content-drafts");
    if (!existsSync(draftsDir)) mkdirSync(draftsDir, { recursive: true });
    const filename = `gbp-${today}.md`;
    const header = `<!-- GBP Draft | ${today} | Requires approval before posting -->\n<!-- Status: DRAFT -->\n\n`;
    writeFileSync(join(draftsDir, filename), header + result);
    info("marketing", `GBP draft saved: content-drafts/${filename}`);
    return result;
  }

  warn("marketing", "GBP draft: empty or too-short response");
  return "";
}

/**
 * Publish the most recent GBP draft to Google Business Profile.
 * Call after Derek approves the draft.
 * Returns the post result.
 */
export async function publishGBPDraft(draftDate?: string): Promise<{ success: boolean; error?: string }> {
  const { isGBPReady, createLocalPost } = await import("./gbp.ts");

  if (!isGBPReady()) {
    return { success: false, error: "GBP not initialized" };
  }

  const draftsDir = join(DATA_DIR, "content-drafts");
  if (!existsSync(draftsDir)) return { success: false, error: "No drafts directory" };

  // Find the draft to publish
  let draftFile: string;
  if (draftDate) {
    draftFile = `gbp-${draftDate}.md`;
  } else {
    // Find most recent draft
    const files = readdirSync(draftsDir).filter(f => f.startsWith("gbp-") && f.endsWith(".md")).sort().reverse();
    if (files.length === 0) return { success: false, error: "No GBP drafts found" };
    draftFile = files[0];
  }

  const draftPath = join(draftsDir, draftFile);
  if (!existsSync(draftPath)) return { success: false, error: `Draft not found: ${draftFile}` };

  let content = readFileSync(draftPath, "utf-8");

  // Strip HTML comments (metadata headers)
  content = content.replace(/<!--[\s\S]*?-->\n*/g, "").trim();

  if (content.length < 20) return { success: false, error: "Draft content too short" };

  // Publish with LEARN_MORE CTA pointing to landing page
  const result = await createLocalPost(content, {
    actionType: "LEARN_MORE",
    url: "https://landing.pvmedispa.com/weightloss",
  });

  if (result.success) {
    // Mark draft as published
    const published = `<!-- GBP Draft | Published ${new Date().toISOString()} -->\n<!-- Status: PUBLISHED | Post: ${result.postName} -->\n\n${content}`;
    writeFileSync(draftPath, published);
    info("marketing", `GBP post published: ${result.postName}`);
  }

  return result;
}
