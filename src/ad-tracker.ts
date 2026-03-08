/**
 * Atlas -- Ad Creative Performance Tracker
 *
 * Tracks ad creative performance over time, identifies winners/losers,
 * and recommends actions (pause underperformers, scale winners).
 *
 * NOT an A/B test framework (Meta handles that). This is a monitoring
 * and recommendation layer on top of existing ad data from meta.ts.
 *
 * Data source: getTopAds() from meta.ts returns AdInsight[] with:
 *   adId, adName, adsetName, campaignName, spend, impressions,
 *   clicks, ctr, cpc, conversions, cpl, reach
 *
 * Note: frequency is not returned at the ad level by the Graph API.
 * We estimate it as impressions/reach when reach > 0.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { info, warn } from "./logger.ts";

const DATA_DIR = join(process.env.PROJECT_DIR || process.cwd(), "data");
const TRACKER_FILE = join(DATA_DIR, "ad-tracker.json");

// ============================================================
// TYPES
// ============================================================

export interface AdSnapshot {
  date: string;
  campaignName: string;
  adId: string;
  adName: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpl: number;       // cost per lead
  ctr: number;       // click-through rate
  frequency: number; // estimated: impressions / reach (0 if no reach data)
  reach: number;
}

interface AdTrackerState {
  snapshots: AdSnapshot[];
  recommendations: AdRecommendation[];
  lastUpdated: string;
}

export interface AdRecommendation {
  date: string;
  adId: string;
  adName: string;
  type: "pause" | "scale" | "refresh" | "watch";
  reason: string;
  metric: string;
  value: number;
  threshold: number;
}

// ============================================================
// STATE PERSISTENCE
// ============================================================

function loadTracker(): AdTrackerState {
  try {
    if (existsSync(TRACKER_FILE)) {
      return JSON.parse(readFileSync(TRACKER_FILE, "utf-8"));
    }
  } catch (err) {
    warn("ad-tracker", `Failed to load tracker state: ${err}`);
  }
  return { snapshots: [], recommendations: [], lastUpdated: new Date().toISOString() };
}

function saveTracker(state: AdTrackerState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  state.lastUpdated = new Date().toISOString();

  // Keep 90 days of snapshots
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().split("T")[0];
  state.snapshots = state.snapshots.filter(s => s.date >= cutoff);
  state.recommendations = state.recommendations.filter(r => r.date >= cutoff);

  writeFileSync(TRACKER_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// SNAPSHOT RECORDING
// ============================================================

/** Record a daily ad performance snapshot. */
export function recordAdSnapshot(snapshot: AdSnapshot): void {
  const state = loadTracker();
  // Dedup by date + adId
  const idx = state.snapshots.findIndex(s => s.date === snapshot.date && s.adId === snapshot.adId);
  if (idx >= 0) {
    state.snapshots[idx] = snapshot;
  } else {
    state.snapshots.push(snapshot);
  }
  saveTracker(state);
}

/** Record multiple snapshots at once (batch insert). */
export function recordAdSnapshots(snapshots: AdSnapshot[]): void {
  const state = loadTracker();
  for (const snapshot of snapshots) {
    const idx = state.snapshots.findIndex(s => s.date === snapshot.date && s.adId === snapshot.adId);
    if (idx >= 0) {
      state.snapshots[idx] = snapshot;
    } else {
      state.snapshots.push(snapshot);
    }
  }
  saveTracker(state);
  info("ad-tracker", `Recorded ${snapshots.length} ad snapshot(s) for ${snapshots[0]?.date || "unknown"}`);
}

/**
 * Convert AdInsight results from meta.ts into AdSnapshots.
 * Called by the cron job after getTopAds().
 */
export function insightsToSnapshots(
  insights: Array<{
    adId: string;
    adName: string;
    campaignName: string;
    spend: number;
    impressions: number;
    clicks: number;
    ctr: number;
    conversions: number;
    cpl: number;
    reach: number;
  }>,
  date: string
): AdSnapshot[] {
  return insights.map(ad => ({
    date,
    campaignName: ad.campaignName,
    adId: ad.adId,
    adName: ad.adName,
    spend: ad.spend,
    impressions: ad.impressions,
    clicks: ad.clicks,
    conversions: ad.conversions,
    cpl: ad.cpl,
    ctr: ad.ctr,
    frequency: ad.reach > 0 ? ad.impressions / ad.reach : 0,
    reach: ad.reach,
  }));
}

// ============================================================
// ANALYSIS ENGINE
// ============================================================

/** Analyze recent ad performance and generate recommendations. */
export function analyzeAdPerformance(days: number = 7): AdRecommendation[] {
  const state = loadTracker();
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];
  const recent = state.snapshots.filter(s => s.date >= cutoff);

  if (recent.length === 0) return [];

  // Aggregate by adId
  const byAd: Record<string, AdSnapshot[]> = {};
  for (const s of recent) {
    if (!byAd[s.adId]) byAd[s.adId] = [];
    byAd[s.adId].push(s);
  }

  const recommendations: AdRecommendation[] = [];
  const today = new Date().toISOString().split("T")[0];

  for (const [adId, snapshots] of Object.entries(byAd)) {
    const latest = snapshots[snapshots.length - 1];
    const totalSpend = snapshots.reduce((s, snap) => s + snap.spend, 0);
    const totalConversions = snapshots.reduce((s, snap) => s + snap.conversions, 0);
    const avgCPL = totalConversions > 0 ? totalSpend / totalConversions : Infinity;
    const avgFrequency = snapshots.reduce((s, snap) => s + snap.frequency, 0) / snapshots.length;
    const avgCTR = snapshots.reduce((s, snap) => s + snap.ctr, 0) / snapshots.length;

    // PAUSE: CPL > $80 over the window with meaningful spend
    if (avgCPL > 80 && totalSpend > 50) {
      recommendations.push({
        date: today, adId, adName: latest.adName,
        type: "pause",
        reason: `CPL ${avgCPL === Infinity ? "N/A (no conversions)" : "$" + avgCPL.toFixed(0)} over ${days}d (threshold: $80). Spent $${totalSpend.toFixed(0)} with ${totalConversions} conversion${totalConversions !== 1 ? "s" : ""}.`,
        metric: "cpl", value: avgCPL, threshold: 80,
      });
    }

    // REFRESH: frequency > 3.5 (audience fatigue)
    if (avgFrequency > 3.5) {
      recommendations.push({
        date: today, adId, adName: latest.adName,
        type: "refresh",
        reason: `Frequency ${avgFrequency.toFixed(1)} (threshold: 3.5). Audience fatigue likely.`,
        metric: "frequency", value: avgFrequency, threshold: 3.5,
      });
    }

    // SCALE: CPL < $40 and CTR > 2% with meaningful spend
    if (avgCPL < 40 && avgCPL > 0 && avgCTR > 2 && totalSpend > 30) {
      recommendations.push({
        date: today, adId, adName: latest.adName,
        type: "scale",
        reason: `Strong performer: CPL $${avgCPL.toFixed(0)}, CTR ${avgCTR.toFixed(1)}%. Consider increasing budget.`,
        metric: "cpl", value: avgCPL, threshold: 40,
      });
    }

    // WATCH: CTR < 1% with meaningful spend
    if (avgCTR < 1 && totalSpend > 20) {
      recommendations.push({
        date: today, adId, adName: latest.adName,
        type: "watch",
        reason: `Low CTR ${avgCTR.toFixed(2)}% (threshold: 1%). Creative may not resonate.`,
        metric: "ctr", value: avgCTR, threshold: 1,
      });
    }
  }

  // Persist recommendations
  state.recommendations = [...state.recommendations, ...recommendations];
  saveTracker(state);

  return recommendations;
}

// ============================================================
// SUMMARY FORMATTERS
// ============================================================

/** Get a formatted summary for Telegram/morning brief. */
export function getAdPerformanceSummary(days: number = 7): string {
  const recommendations = analyzeAdPerformance(days);
  if (recommendations.length === 0) return "";

  const lines = ["--- Ad Creative Insights ---"];

  const byType: Record<string, AdRecommendation[]> = {};
  for (const r of recommendations) {
    if (!byType[r.type]) byType[r.type] = [];
    byType[r.type].push(r);
  }

  if (byType.pause?.length) {
    lines.push(`PAUSE (${byType.pause.length}):`);
    for (const r of byType.pause.slice(0, 3)) {
      lines.push(`  ${r.adName}: ${r.reason}`);
    }
  }
  if (byType.refresh?.length) {
    lines.push(`REFRESH (${byType.refresh.length}):`);
    for (const r of byType.refresh.slice(0, 3)) {
      lines.push(`  ${r.adName}: ${r.reason}`);
    }
  }
  if (byType.scale?.length) {
    lines.push(`SCALE (${byType.scale.length}):`);
    for (const r of byType.scale.slice(0, 3)) {
      lines.push(`  ${r.adName}: ${r.reason}`);
    }
  }
  if (byType.watch?.length) {
    lines.push(`WATCH (${byType.watch.length}):`);
    for (const r of byType.watch.slice(0, 2)) {
      lines.push(`  ${r.adName}: ${r.reason}`);
    }
  }

  return lines.join("\n");
}

/** Get raw tracker state for debugging/skill use. */
export function getTrackerState(): AdTrackerState {
  return loadTracker();
}
