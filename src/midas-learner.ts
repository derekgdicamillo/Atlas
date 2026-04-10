/**
 * Atlas — Midas Self-Learning System
 *
 * Turns Midas from a smart reporter into an adaptive learning system.
 * Tracks recommendation outcomes, computes adaptive thresholds,
 * monitors creative lifecycle/fatigue, reconciles UTM attribution,
 * verifies playbook claims, and detects data gaps.
 *
 * All recommend-only — no auto-actions. Derek decides.
 *
 * Data source: reads from ad-tracker.json, lead-volume.json, Meta API, GHL API.
 * State: data/midas-learner.json (90-day retention).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { info, warn } from "./logger.ts";
import type { AdSnapshot, AdRecommendation } from "./ad-tracker.ts";
import type { GHLOpportunity } from "./ghl.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const MEMORY_DIR = join(PROJECT_DIR, "memory");
const MARKETING_DIR = join(MEMORY_DIR, "marketing");
const LEARNER_FILE = join(DATA_DIR, "midas-learner.json");
const TRACKER_FILE = join(DATA_DIR, "ad-tracker.json");

// ============================================================
// TYPES
// ============================================================

export interface RecommendationOutcome {
  id: string;                    // `${date}-${adId}-${type}`
  date: string;                  // recommendation date YYYY-MM-DD
  adId: string;
  adName: string;
  type: "pause" | "scale" | "refresh" | "watch" | "fatigue";
  reason: string;
  baseline: {
    cpl: number;
    ctr: number;
    frequency: number;
    spend: number;               // 7-day total spend at time of rec
  };
  followed: boolean | null;      // null = pending detection
  followedDate: string | null;
  outcome: {
    cpl: number;
    ctr: number;
    frequency: number;
    spend: number;
    verdict: "positive" | "neutral" | "negative";
  } | null;
  outcomeDate: string | null;
  lessonExtracted: boolean;
}

export interface DecayBucket {
  ageDays: string;               // "1-3", "4-7", "8-14", "15-21", "22-30", "30+"
  avgCpl: number;
  avgCtr: number;
  avgFrequency: number;
  sampleSize: number;
}

export interface ComputedThresholds {
  date: string;
  pause: { cpl: number; percentile: number };
  scale: { cpl: number; ctr: number; percentile: number };
  refresh: { frequency: number; stdDevs: number };
  watch: { ctr: number; percentile: number };
}

export interface PlaybookClaim {
  line: string;
  metric: string;
  claimedValue: number;
  currentValue: number | null;
  status: "verified" | "stale" | "contradicted" | "untestable";
  lastChecked: string;
}

export interface UTMAttributionResult {
  campaigns: Array<{
    campaignId: string;
    campaignName: string;
    spend: number;
    leads: number;
    cpl: number;
  }>;
  unmatchedSpend: number;
  unmatchedLeads: number;
}

export interface FatigueResult {
  fatiguing: boolean;
  peakCpl: number;
  currentCpl: number;
  ageDays: number;
  predictedDaysToThreshold: number | null;
}

export interface PlaybookAuditResult {
  verified: number;
  stale: number;
  contradicted: number;
  untestable: number;
  claims: PlaybookClaim[];
}

interface LearnerState {
  outcomes: RecommendationOutcome[];
  computedThresholds: ComputedThresholds | null;
  adFirstSeen: Record<string, string>;   // adId -> YYYY-MM-DD
  decayCurve: DecayBucket[];
  utmMap: Record<string, string>;        // utmCampaign -> Meta campaign name
  lastPlaybookAudit: string | null;
  playbookClaims: PlaybookClaim[];
  lastUpdated: string;
}

// ============================================================
// STATE PERSISTENCE
// ============================================================

function loadState(): LearnerState {
  try {
    if (existsSync(LEARNER_FILE)) {
      return JSON.parse(readFileSync(LEARNER_FILE, "utf-8"));
    }
  } catch (err) {
    warn("midas-learner", `Failed to load state: ${err}`);
  }
  return {
    outcomes: [],
    computedThresholds: null,
    adFirstSeen: {},
    decayCurve: [],
    utmMap: {},
    lastPlaybookAudit: null,
    playbookClaims: [],
    lastUpdated: new Date().toISOString(),
  };
}

function saveState(state: LearnerState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  state.lastUpdated = new Date().toISOString();

  // 90-day retention on outcomes
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().split("T")[0];
  state.outcomes = state.outcomes.filter(o => o.date >= cutoff);

  // Prune adFirstSeen for ads not seen in 90 days
  const trackerSnapshots = loadTrackerSnapshots();
  const recentAdIds = new Set(trackerSnapshots.filter(s => s.date >= cutoff).map(s => s.adId));
  for (const adId of Object.keys(state.adFirstSeen)) {
    if (!recentAdIds.has(adId)) delete state.adFirstSeen[adId];
  }

  writeFileSync(LEARNER_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// HELPERS
// ============================================================

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });
}

function daysBetween(dateA: string, dateB: string): number {
  return Math.floor((new Date(dateB).getTime() - new Date(dateA).getTime()) / 86_400_000);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function loadTrackerSnapshots(): AdSnapshot[] {
  try {
    if (existsSync(TRACKER_FILE)) {
      const data = JSON.parse(readFileSync(TRACKER_FILE, "utf-8"));
      return data.snapshots || [];
    }
  } catch { /* ignore */ }
  return [];
}

function loadTrackerRecommendations(): AdRecommendation[] {
  try {
    if (existsSync(TRACKER_FILE)) {
      const data = JSON.parse(readFileSync(TRACKER_FILE, "utf-8"));
      return data.recommendations || [];
    }
  } catch { /* ignore */ }
  return [];
}

// ============================================================
// SECTION 1: RECOMMENDATION OUTCOME TRACKER — RECORDING
// ============================================================

/**
 * Record new recommendations with baseline metrics.
 * Called from cron after analyzeAdPerformance() returns.
 */
export function recordRecommendations(recs: AdRecommendation[], snapshots: AdSnapshot[]): number {
  if (recs.length === 0) return 0;

  const state = loadState();
  let recorded = 0;

  for (const rec of recs) {
    const id = `${rec.date}-${rec.adId}-${rec.type}`;
    // Dedup: skip if already recorded
    if (state.outcomes.some(o => o.id === id)) continue;

    // Build baseline from recent snapshots for this ad (using CPLPV, not Meta CPL)
    const adSnaps = snapshots.filter(s => s.adId === rec.adId);
    const totalSpend = adSnaps.reduce((sum, s) => sum + s.spend, 0);
    const totalLPViews = adSnaps.reduce((sum, s) => sum + (s.lpViews || 0), 0);
    const avgCplpv = totalLPViews > 0 ? totalSpend / totalLPViews : 0;
    const avgCtr = adSnaps.length > 0 ? adSnaps.reduce((sum, s) => sum + s.ctr, 0) / adSnaps.length : 0;
    const avgFreq = adSnaps.length > 0 ? adSnaps.reduce((sum, s) => sum + s.frequency, 0) / adSnaps.length : 0;

    state.outcomes.push({
      id,
      date: rec.date,
      adId: rec.adId,
      adName: rec.adName,
      type: rec.type as RecommendationOutcome["type"],
      reason: rec.reason,
      baseline: { cpl: avgCplpv, ctr: avgCtr, frequency: avgFreq, spend: totalSpend },
      followed: null,
      followedDate: null,
      outcome: null,
      outcomeDate: null,
      lessonExtracted: false,
    });
    recorded++;
  }

  if (recorded > 0) {
    saveState(state);
    info("midas-learner", `Recorded ${recorded} new recommendation outcome(s)`);
  }
  return recorded;
}

// ============================================================
// SECTION 1: RECOMMENDATION OUTCOME TRACKER — FOLLOW-THROUGH
// ============================================================

/**
 * Detect whether recommendations were followed.
 * Uses Meta API to check ad status changes.
 * Returns status messages for logging.
 */
export async function checkFollowThrough(
  getAdStatus: (adId: string) => Promise<{ status: string } | null>
): Promise<string[]> {
  const state = loadState();
  const messages: string[] = [];
  const todayStr = today();

  const pending = state.outcomes.filter(o => o.followed === null && o.type !== "watch");

  for (const outcome of pending) {
    const daysOld = daysBetween(outcome.date, todayStr);

    if (outcome.type === "pause" || outcome.type === "fatigue") {
      // Check if ad was paused/archived
      try {
        const adInfo = await getAdStatus(outcome.adId);
        if (adInfo && (adInfo.status === "PAUSED" || adInfo.status === "ARCHIVED")) {
          outcome.followed = true;
          outcome.followedDate = todayStr;
          messages.push(`PAUSE followed: ${outcome.adName} is now ${adInfo.status}`);
        } else if (daysOld >= 3) {
          // 3 days without action = ignored
          outcome.followed = false;
          messages.push(`PAUSE ignored: ${outcome.adName} still ACTIVE after ${daysOld}d`);
        }
      } catch { /* API error, retry next day */ }
    } else if (outcome.type === "scale") {
      // Check if spend increased >20% vs baseline
      const recentSnaps = loadTrackerSnapshots().filter(
        s => s.adId === outcome.adId && s.date > outcome.date
      );
      if (recentSnaps.length >= 3) {
        const recentSpend = recentSnaps.reduce((sum, s) => sum + s.spend, 0);
        const baselineDaily = outcome.baseline.spend / 7;
        const recentDaily = recentSpend / recentSnaps.length;
        if (recentDaily > baselineDaily * 1.2) {
          outcome.followed = true;
          outcome.followedDate = todayStr;
          messages.push(`SCALE followed: ${outcome.adName} spend up ${((recentDaily / baselineDaily - 1) * 100).toFixed(0)}%`);
        } else if (daysOld >= 7) {
          outcome.followed = false;
          messages.push(`SCALE ignored: ${outcome.adName} no spend increase after ${daysOld}d`);
        }
      }
    } else if (outcome.type === "refresh") {
      // Check if ad was paused (refresh = replace creative)
      try {
        const adInfo = await getAdStatus(outcome.adId);
        if (adInfo && (adInfo.status === "PAUSED" || adInfo.status === "ARCHIVED")) {
          outcome.followed = true;
          outcome.followedDate = todayStr;
          messages.push(`REFRESH followed: ${outcome.adName} replaced`);
        } else if (daysOld >= 7) {
          outcome.followed = false;
          messages.push(`REFRESH ignored: ${outcome.adName} still active after ${daysOld}d`);
        }
      } catch { /* retry next day */ }
    }
  }

  // Auto-close WATCH recs (informational only)
  for (const outcome of state.outcomes.filter(o => o.followed === null && o.type === "watch")) {
    if (daysBetween(outcome.date, todayStr) >= 3) {
      outcome.followed = null; // stays null — no action expected
      outcome.outcomeDate = todayStr; // mark as evaluated
    }
  }

  if (messages.length > 0) saveState(state);
  return messages;
}

// ============================================================
// SECTION 1: RECOMMENDATION OUTCOME TRACKER — MEASUREMENT
// ============================================================

/**
 * Measure 7-day outcomes for recommendations that have been evaluated.
 * Returns summary messages.
 */
export function measureOutcomes(): string[] {
  const state = loadState();
  const snapshots = loadTrackerSnapshots();
  const todayStr = today();
  const messages: string[] = [];

  const ready = state.outcomes.filter(
    o => o.followed !== null && o.outcome === null && daysBetween(o.date, todayStr) >= 7
  );

  for (const outcome of ready) {
    // Get ad's performance in the 7 days after the recommendation
    const windowStart = outcome.date;
    const windowEnd = new Date(new Date(outcome.date).getTime() + 7 * 86_400_000)
      .toISOString().split("T")[0];

    const postSnaps = snapshots.filter(
      s => s.adId === outcome.adId && s.date > windowStart && s.date <= windowEnd
    );

    if (postSnaps.length === 0 && outcome.followed) {
      // Ad was paused — for PAUSE recs, that's the desired outcome
      if (outcome.type === "pause" || outcome.type === "fatigue") {
        outcome.outcome = {
          cpl: 0, ctr: 0, frequency: 0, spend: 0,
          verdict: "positive",
        };
        outcome.outcomeDate = todayStr;
        messages.push(`${outcome.type.toUpperCase()} outcome: ${outcome.adName} — positive (ad stopped, saving ~$${(outcome.baseline.spend / 7).toFixed(0)}/day)`);
        continue;
      }
    }

    if (postSnaps.length === 0) {
      // No data = can't measure. Mark as neutral and move on
      outcome.outcome = {
        cpl: 0, ctr: 0, frequency: 0, spend: 0,
        verdict: "neutral",
      };
      outcome.outcomeDate = todayStr;
      continue;
    }

    const totalSpend = postSnaps.reduce((sum, s) => sum + s.spend, 0);
    const totalLPViews = postSnaps.reduce((sum, s) => sum + (s.lpViews || 0), 0);
    const postCplpv = totalLPViews > 0 ? totalSpend / totalLPViews : 0;
    const postCtr = postSnaps.reduce((sum, s) => sum + s.ctr, 0) / postSnaps.length;
    const postFreq = postSnaps.reduce((sum, s) => sum + s.frequency, 0) / postSnaps.length;

    // Determine verdict by comparing cost/LPV to baseline
    let verdict: "positive" | "neutral" | "negative";
    if (outcome.baseline.cpl === 0) {
      verdict = "neutral";
    } else {
      const cplpvChange = (postCplpv - outcome.baseline.cpl) / outcome.baseline.cpl;
      if (outcome.type === "scale") {
        verdict = cplpvChange <= 0.15 ? "positive" : cplpvChange <= 0.3 ? "neutral" : "negative";
      } else {
        verdict = cplpvChange <= -0.15 ? "positive" : cplpvChange >= 0.15 ? "negative" : "neutral";
      }
    }

    outcome.outcome = { cpl: postCplpv, ctr: postCtr, frequency: postFreq, spend: totalSpend, verdict };
    outcome.outcomeDate = todayStr;

    const cplpvDelta = outcome.baseline.cpl > 0
      ? `${((postCplpv / outcome.baseline.cpl - 1) * 100).toFixed(0)}%`
      : "N/A";
    messages.push(
      `${outcome.type.toUpperCase()} outcome: ${outcome.adName} — ${verdict} (Cost/LPV ${cplpvDelta})`
    );
  }

  if (messages.length > 0) saveState(state);
  return messages;
}

// ============================================================
// SECTION 2: ADAPTIVE THRESHOLDS
// ============================================================

/**
 * Compute percentile-based thresholds from trailing 30-day data.
 * Called weekly from midas-attribution cron.
 */
export function computeAdaptiveThresholds(): ComputedThresholds | null {
  const snapshots = loadTrackerSnapshots();
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().split("T")[0];
  const recent = snapshots.filter(s => s.date >= cutoff);

  if (recent.length < 10) {
    info("midas-learner", `Not enough data for adaptive thresholds (${recent.length} snapshots, need 10)`);
    return null;
  }

  // Aggregate by adId
  const byAd: Record<string, AdSnapshot[]> = {};
  for (const s of recent) {
    if (!byAd[s.adId]) byAd[s.adId] = [];
    byAd[s.adId].push(s);
  }

  // Use cost-per-landing-page-view (CPLPV) instead of CPL since Meta blocks
  // conversion tracking for health/wellness advertisers.
  const adMetrics = Object.entries(byAd).map(([_, snaps]) => {
    const totalSpend = snaps.reduce((sum, s) => sum + s.spend, 0);
    const totalLPViews = snaps.reduce((sum, s) => sum + (s.lpViews || 0), 0);
    return {
      cplpv: totalLPViews > 0 ? totalSpend / totalLPViews : Infinity,
      ctr: snaps.reduce((sum, s) => sum + s.ctr, 0) / snaps.length,
      frequency: snaps.reduce((sum, s) => sum + s.frequency, 0) / snaps.length,
    };
  });

  // Filter out Infinity CPLPV for percentile calculation
  const validCplpvs = adMetrics.filter(m => m.cplpv !== Infinity).map(m => m.cplpv).sort((a, b) => a - b);
  const ctrs = adMetrics.map(m => m.ctr).sort((a, b) => a - b);
  const frequencies = adMetrics.map(m => m.frequency).filter(f => f > 0);

  if (validCplpvs.length < 3) {
    info("midas-learner", `Not enough ads with LP views for thresholds (${validCplpvs.length})`);
    return null;
  }

  // Compute with floors/ceilings (CPLPV range: $3-$10 typical)
  const pauseCpl = Math.max(6, percentile(validCplpvs, 80));
  const scaleCpl = Math.min(4, percentile(validCplpvs, 20));
  const scaleCtr = Math.max(1.5, percentile(ctrs, 80));
  const watchCtr = Math.min(2.0, percentile(ctrs, 25));

  // Frequency: mean + 1.5 * stddev
  let refreshFreq = 3.5; // default
  if (frequencies.length >= 3) {
    const mean = frequencies.reduce((a, b) => a + b, 0) / frequencies.length;
    const variance = frequencies.reduce((sum, f) => sum + Math.pow(f - mean, 2), 0) / frequencies.length;
    const stddev = Math.sqrt(variance);
    refreshFreq = Math.max(2.5, mean + 1.5 * stddev);
  }

  const computed: ComputedThresholds = {
    date: today(),
    pause: { cpl: Math.round(pauseCpl * 100) / 100, percentile: 80 },
    scale: { cpl: Math.round(scaleCpl * 100) / 100, ctr: Math.round(scaleCtr * 100) / 100, percentile: 20 },
    refresh: { frequency: Math.round(refreshFreq * 10) / 10, stdDevs: 1.5 },
    watch: { ctr: Math.round(watchCtr * 100) / 100, percentile: 25 },
  };

  const state = loadState();
  state.computedThresholds = computed;
  saveState(state);

  info("midas-learner", `Adaptive thresholds (CPLPV): PAUSE $${computed.pause.cpl}, SCALE $${computed.scale.cpl}, REFRESH freq ${computed.refresh.frequency}, WATCH CTR ${computed.watch.ctr}%`);

  // Check divergence from thresholds.md
  checkThresholdDivergence(computed);

  return computed;
}

function checkThresholdDivergence(computed: ComputedThresholds): void {
  try {
    const thresholdsPath = join(MARKETING_DIR, "thresholds.md");
    if (!existsSync(thresholdsPath)) return;
    const content = readFileSync(thresholdsPath, "utf-8");

    const cplMatch = content.match(/CPL[^$]*\$(\d+)/i);
    if (cplMatch) {
      const manual = parseFloat(cplMatch[1]);
      const divergence = Math.abs(computed.pause.cpl - manual) / manual;
      if (divergence > 0.3) {
        warn("midas-learner", `Threshold divergence: manual PAUSE CPL $${manual} vs computed $${computed.pause.cpl.toFixed(0)} (${(divergence * 100).toFixed(0)}% off). Consider updating thresholds.md`);
      }
    }
  } catch { /* thresholds.md not readable */ }
}

/**
 * Get the active thresholds for ad-tracker to use.
 * Priority: computed (if fresh) → thresholds.md → hardcoded defaults.
 */
export function getActiveThresholds(): {
  pause: number;
  scale: number;
  scaleCtr: number;
  refresh: number;
  watch: number;
} {
  const defaults = { pause: 80, scale: 40, scaleCtr: 2, refresh: 3.5, watch: 1 };

  // Try computed thresholds first
  const state = loadState();
  if (state.computedThresholds) {
    const age = daysBetween(state.computedThresholds.date, today());
    if (age <= 10) {
      return {
        pause: state.computedThresholds.pause.cpl,
        scale: state.computedThresholds.scale.cpl,
        scaleCtr: state.computedThresholds.scale.ctr,
        refresh: state.computedThresholds.refresh.frequency,
        watch: state.computedThresholds.watch.ctr,
      };
    }
  }

  // Try thresholds.md
  try {
    const thresholdsPath = join(MARKETING_DIR, "thresholds.md");
    if (existsSync(thresholdsPath)) {
      const content = readFileSync(thresholdsPath, "utf-8");
      const pauseMatch = content.match(/pause[^$]*\$(\d+)/i);
      const scaleMatch = content.match(/scale[^$]*\$(\d+)/i);
      const freqMatch = content.match(/frequency[^:]*:\s*([\d.]+)/i);
      const ctrMatch = content.match(/CTR[^:]*:\s*([\d.]+)/i);

      return {
        pause: pauseMatch ? parseFloat(pauseMatch[1]) : defaults.pause,
        scale: scaleMatch ? parseFloat(scaleMatch[1]) : defaults.scale,
        scaleCtr: defaults.scaleCtr,
        refresh: freqMatch ? parseFloat(freqMatch[1]) : defaults.refresh,
        watch: ctrMatch ? parseFloat(ctrMatch[1]) : defaults.watch,
      };
    }
  } catch { /* fall through */ }

  return defaults;
}

// ============================================================
// SECTION 3: CREATIVE LIFECYCLE
// ============================================================

/**
 * Update ad first-seen registry from daily snapshots.
 */
export function updateAdRegistry(snapshots: AdSnapshot[]): void {
  const state = loadState();
  const todayStr = today();
  let updated = false;

  for (const snap of snapshots) {
    if (!state.adFirstSeen[snap.adId]) {
      state.adFirstSeen[snap.adId] = snap.date || todayStr;
      updated = true;
    }
  }

  if (updated) saveState(state);
}

/**
 * Get ad age in days, or null if unknown.
 */
export function getAdAge(adId: string): number | null {
  const state = loadState();
  const firstSeen = state.adFirstSeen[adId];
  if (!firstSeen) return null;
  return daysBetween(firstSeen, today());
}

/**
 * Build decay curves from historical data.
 * Groups all snapshots by ad age bucket, computes average metrics.
 * Requires 20+ unique ads with 14+ days of history for meaningful results.
 */
export function buildDecayCurves(): DecayBucket[] {
  const state = loadState();
  const snapshots = loadTrackerSnapshots();

  const bucketDefs: Array<{ label: string; min: number; max: number }> = [
    { label: "1-3", min: 1, max: 3 },
    { label: "4-7", min: 4, max: 7 },
    { label: "8-14", min: 8, max: 14 },
    { label: "15-21", min: 15, max: 21 },
    { label: "22-30", min: 22, max: 30 },
    { label: "30+", min: 31, max: 999 },
  ];

  const buckets: Record<string, { cpls: number[]; ctrs: number[]; freqs: number[] }> = {};
  for (const b of bucketDefs) {
    buckets[b.label] = { cpls: [], ctrs: [], freqs: [] };
  }

  for (const snap of snapshots) {
    const firstSeen = state.adFirstSeen[snap.adId];
    if (!firstSeen) continue;

    const age = daysBetween(firstSeen, snap.date);
    if (age < 1) continue;

    const bucket = bucketDefs.find(b => age >= b.min && age <= b.max);
    if (!bucket) continue;

    const b = buckets[bucket.label];
    // Use cost-per-LPV instead of CPL for decay curves (Meta blocks conversions for health/wellness)
    const lpv = snap.lpViews || 0;
    if (lpv > 0 && snap.spend > 0) b.cpls.push(snap.spend / lpv);
    if (snap.ctr > 0) b.ctrs.push(snap.ctr);
    if (snap.frequency > 0) b.freqs.push(snap.frequency);
  }

  const curves: DecayBucket[] = bucketDefs.map(def => {
    const b = buckets[def.label];
    return {
      ageDays: def.label,
      avgCpl: b.cpls.length > 0 ? b.cpls.reduce((a, c) => a + c, 0) / b.cpls.length : 0, // now cost/LPV
      avgCtr: b.ctrs.length > 0 ? b.ctrs.reduce((a, c) => a + c, 0) / b.ctrs.length : 0,
      avgFrequency: b.freqs.length > 0 ? b.freqs.reduce((a, c) => a + c, 0) / b.freqs.length : 0,
      sampleSize: b.cpls.length,
    };
  });

  state.decayCurve = curves;
  saveState(state);

  return curves;
}

/**
 * Detect fatigue for a specific ad.
 * Returns fatigue analysis or null if insufficient data.
 */
export function detectFatigue(adId: string): FatigueResult | null {
  const state = loadState();
  const snapshots = loadTrackerSnapshots();
  const firstSeen = state.adFirstSeen[adId];
  if (!firstSeen) return null;

  const ageDays = daysBetween(firstSeen, today());
  if (ageDays < 7) return null; // too young to evaluate

  // Use cost-per-landing-page-view (CPLPV) as fatigue proxy since Meta blocks
  // conversion tracking for health/wellness advertisers. lpViews may be missing
  // on older snapshots, so filter for snapshots that have them.
  const adSnaps = snapshots.filter(s => s.adId === adId && (s.lpViews || 0) > 0);
  if (adSnaps.length < 5) return null; // not enough data

  // Find best 7-day cost/LPV window (the peak efficiency)
  let bestWindowCplpv = Infinity;
  for (let i = 0; i <= adSnaps.length - 3; i++) {
    const window = adSnaps.slice(i, Math.min(i + 7, adSnaps.length));
    const windowSpend = window.reduce((sum, s) => sum + s.spend, 0);
    const windowLPV = window.reduce((sum, s) => sum + (s.lpViews || 0), 0);
    if (windowLPV > 0) {
      const windowCplpv = windowSpend / windowLPV;
      if (windowCplpv < bestWindowCplpv) bestWindowCplpv = windowCplpv;
    }
  }

  if (bestWindowCplpv === Infinity) return null;

  // Current cost/LPV from last 7 days
  const recent = adSnaps.filter(s => daysBetween(s.date, today()) <= 7);
  const recentSpend = recent.reduce((sum, s) => sum + s.spend, 0);
  const recentLPV = recent.reduce((sum, s) => sum + (s.lpViews || 0), 0);
  const currentCplpv = recentLPV > 0 ? recentSpend / recentLPV : Infinity;

  if (currentCplpv === Infinity) return null;

  // Get typical peak age from decay curve
  const typicalPeakAge = 7; // default assumption: ads peak day 4-7
  const fatiguing = currentCplpv > bestWindowCplpv * 1.4 && ageDays > typicalPeakAge;

  // Predict days to critical CPLPV threshold ($8)
  let predictedDays: number | null = null;
  const cplpvCritical = 8; // matches ad-tracker.ts threshold
  if (currentCplpv < cplpvCritical && adSnaps.length >= 7) {
    // Linear extrapolation from recent trend
    const last7 = adSnaps.slice(-7);
    const calcCplpv = (snaps: typeof last7) => {
      const sp = snaps.reduce((s, snap) => s + snap.spend, 0);
      const lp = snaps.reduce((s, snap) => s + (snap.lpViews || 0), 0);
      return lp > 0 ? sp / lp : 0;
    };
    const first3Cplpv = calcCplpv(last7.slice(0, 3));
    const last3Cplpv = calcCplpv(last7.slice(-3));
    const dailyRise = (last3Cplpv - first3Cplpv) / 4;
    if (dailyRise > 0) {
      predictedDays = Math.ceil((cplpvCritical - currentCplpv) / dailyRise);
      if (predictedDays > 30) predictedDays = null;
    }
  }

  return {
    fatiguing,
    peakCpl: Math.round(bestWindowCplpv * 100) / 100,   // now cost/LPV, not CPL
    currentCpl: Math.round(currentCplpv * 100) / 100,    // now cost/LPV, not CPL
    ageDays,
    predictedDaysToThreshold: predictedDays,
  };
}

/**
 * Get fatigue status for all active ads.
 * Returns list of ads approaching or in fatigue.
 */
export function getAllFatigueAlerts(): Array<{ adId: string; adName: string; fatigue: FatigueResult }> {
  const snapshots = loadTrackerSnapshots();
  const todayStr = today();
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().split("T")[0];

  // Get recently active ads
  const activeAds = new Map<string, string>();
  for (const s of snapshots) {
    if (s.date >= cutoff) activeAds.set(s.adId, s.adName);
  }

  const alerts: Array<{ adId: string; adName: string; fatigue: FatigueResult }> = [];

  for (const [adId, adName] of activeAds) {
    const result = detectFatigue(adId);
    if (result && (result.fatiguing || (result.predictedDaysToThreshold !== null && result.predictedDaysToThreshold <= 5))) {
      alerts.push({ adId, adName, fatigue: result });
    }
  }

  return alerts;
}

// ============================================================
// SECTION 4: UTM ATTRIBUTION
// ============================================================

/**
 * Extract UTM campaign IDs from GHL opportunity attributions.
 * Maps utmCampaign → Meta campaign name from ad-tracker data.
 */
export function extractUTMFromOpportunities(opps: GHLOpportunity[]): void {
  const state = loadState();
  const snapshots = loadTrackerSnapshots();
  let updated = false;

  // Build reverse map: campaignName from ad-tracker -> display name
  // (campaignName in Meta is often the campaign ID like "120233554390290549")
  const campaignNames = new Set(snapshots.map(s => s.campaignName));

  for (const opp of opps) {
    const attrs = (opp as any).attributions;
    if (!Array.isArray(attrs) || attrs.length === 0) continue;

    const utm = attrs[0];
    if (utm?.utmCampaign && !state.utmMap[utm.utmCampaign]) {
      // Try to match to a campaign name from ad-tracker
      if (campaignNames.has(utm.utmCampaign)) {
        state.utmMap[utm.utmCampaign] = utm.utmCampaign;
        updated = true;
      }
    }
  }

  if (updated) saveState(state);
}

/**
 * Build UTM-based attribution: join Meta spend to GHL leads via campaign ID.
 */
export function buildUTMAttribution(days: number = 7): UTMAttributionResult {
  const state = loadState();
  const snapshots = loadTrackerSnapshots();
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0];

  // Spend by campaign from ad-tracker
  const spendByCampaign: Record<string, number> = {};
  for (const s of snapshots.filter(s => s.date >= cutoff)) {
    spendByCampaign[s.campaignName] = (spendByCampaign[s.campaignName] || 0) + s.spend;
  }

  // Lead count by UTM campaign from lead-volume + UTM map
  // We need to read the lead-volume data that includes source info
  const leadsByCampaign: Record<string, number> = {};
  let totalLeads = 0;

  try {
    const leadPath = join(DATA_DIR, "lead-volume.json");
    if (existsSync(leadPath)) {
      const leadData = JSON.parse(readFileSync(leadPath, "utf-8"));
      const days_ = (leadData.days || leadData || []).filter(
        (d: { date: string }) => d.date >= cutoff
      );
      for (const day of days_) {
        totalLeads += day.count || day.total || 0;
      }
    }
  } catch { /* ignore */ }

  // Build result by matching campaign IDs
  const campaigns: UTMAttributionResult["campaigns"] = [];
  let matchedSpend = 0;

  for (const [campaignId, spend] of Object.entries(spendByCampaign)) {
    // Check if we have UTM data mapping leads to this campaign
    const utmLeads = leadsByCampaign[campaignId] || 0;
    campaigns.push({
      campaignId,
      campaignName: state.utmMap[campaignId] || campaignId,
      spend,
      leads: utmLeads,
      cpl: utmLeads > 0 ? spend / utmLeads : 0,
    });
    matchedSpend += spend;
  }

  return {
    campaigns: campaigns.sort((a, b) => b.spend - a.spend),
    unmatchedSpend: 0,
    unmatchedLeads: Math.max(0, totalLeads - campaigns.reduce((s, c) => s + c.leads, 0)),
  };
}

// ============================================================
// SECTION 5: PLAYBOOK VERIFICATION
// ============================================================

/**
 * Audit the playbook for testable claims and verify against current data.
 */
export function auditPlaybook(): PlaybookAuditResult {
  const state = loadState();
  const snapshots = loadTrackerSnapshots();
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().split("T")[0];
  const recent = snapshots.filter(s => s.date >= cutoff);
  const todayStr = today();

  const playbookPath = join(MARKETING_DIR, "playbook.md");
  if (!existsSync(playbookPath)) {
    return { verified: 0, stale: 0, contradicted: 0, untestable: 0, claims: [] };
  }

  const content = readFileSync(playbookPath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim().length > 10);

  const claims: PlaybookClaim[] = [];

  // Patterns to detect testable claims
  const cplPattern = /CPL\s*\$(\d+)/i;
  const ctrPattern = /CTR\s*([\d.]+)%/i;
  const hookTypePattern = /(ELIG|CURI|PAIN|CRED|FEAR|SKEP|CONV|NOBL|OUTC|MYTH)\s+hooks?\s+(?:are|is)\s+#?1?\s*(performer|best|top|worst)/i;

  for (const line of lines) {
    let claim: PlaybookClaim | null = null;

    const cplMatch = line.match(cplPattern);
    if (cplMatch) {
      const claimedCpl = parseFloat(cplMatch[1]);
      // Get current account average CPL
      const totalSpend = recent.reduce((s, snap) => s + snap.spend, 0);
      const totalConv = recent.reduce((s, snap) => s + snap.conversions, 0);
      const currentCpl = totalConv > 0 ? totalSpend / totalConv : null;

      let status: PlaybookClaim["status"] = "untestable";
      if (currentCpl !== null) {
        const diff = Math.abs(currentCpl - claimedCpl) / claimedCpl;
        status = diff <= 0.2 ? "verified" : diff <= 0.5 ? "stale" : "contradicted";
      }

      claim = { line: line.trim(), metric: "cpl", claimedValue: claimedCpl, currentValue: currentCpl, status, lastChecked: todayStr };
    }

    const hookMatch = line.match(hookTypePattern);
    if (hookMatch && !claim) {
      const hookType = hookMatch[1].toUpperCase();
      // Find ads matching this hook type by name
      const hookSnaps = recent.filter(s => s.adName.toUpperCase().includes(hookType));
      const allConv = recent.filter(s => s.conversions > 0);

      if (hookSnaps.length >= 3 && allConv.length >= 5) {
        const hookSpend = hookSnaps.reduce((s, snap) => s + snap.spend, 0);
        const hookConv = hookSnaps.reduce((s, snap) => s + snap.conversions, 0);
        const hookCpl = hookConv > 0 ? hookSpend / hookConv : Infinity;

        const allSpend = allConv.reduce((s, snap) => s + snap.spend, 0);
        const allConvTotal = allConv.reduce((s, snap) => s + snap.conversions, 0);
        const avgCpl = allSpend / allConvTotal;

        const isTop = hookCpl <= avgCpl;
        const claimSaysTop = /performer|best|top/i.test(hookMatch[2]);

        const status = (isTop === claimSaysTop) ? "verified" : "contradicted";
        claim = { line: line.trim(), metric: `hook_type_${hookType}`, claimedValue: 0, currentValue: hookCpl, status, lastChecked: todayStr };
      } else {
        claim = { line: line.trim(), metric: `hook_type_${hookType}`, claimedValue: 0, currentValue: null, status: "untestable", lastChecked: todayStr };
      }
    }

    if (claim) claims.push(claim);
  }

  const result: PlaybookAuditResult = {
    verified: claims.filter(c => c.status === "verified").length,
    stale: claims.filter(c => c.status === "stale").length,
    contradicted: claims.filter(c => c.status === "contradicted").length,
    untestable: claims.filter(c => c.status === "untestable").length,
    claims,
  };

  state.playbookClaims = claims;
  state.lastPlaybookAudit = todayStr;
  saveState(state);

  info("midas-learner", `Playbook audit: ${result.verified} verified, ${result.stale} stale, ${result.contradicted} contradicted`);

  return result;
}

/**
 * Generate evidence-based lessons from outcome data.
 * Returns markdown section or null if insufficient data.
 */
export function generateLessonsSection(): string | null {
  const state = loadState();
  const completed = state.outcomes.filter(o => o.outcome !== null);
  if (completed.length < 10) return null;

  const byType: Record<string, RecommendationOutcome[]> = {};
  for (const o of completed) {
    if (!byType[o.type]) byType[o.type] = [];
    byType[o.type].push(o);
  }

  const lines: string[] = ["## Data-Driven Lessons (auto-generated)", `_Updated ${today()}_`, ""];

  for (const [type, outcomes] of Object.entries(byType)) {
    if (outcomes.length < 5) continue;

    const followed = outcomes.filter(o => o.followed === true);
    const positive = outcomes.filter(o => o.outcome?.verdict === "positive");
    const followedPositive = followed.filter(o => o.outcome?.verdict === "positive");

    lines.push(`### ${type.toUpperCase()} Recommendations`);
    lines.push(`- Total: ${outcomes.length} | Followed: ${followed.length}/${outcomes.length} (${Math.round(followed.length / outcomes.length * 100)}%)`);
    lines.push(`- Positive outcomes: ${positive.length}/${outcomes.length} (${Math.round(positive.length / outcomes.length * 100)}%)`);

    if (followed.length > 0) {
      lines.push(`- When followed: ${followedPositive.length}/${followed.length} positive (${Math.round(followedPositive.length / followed.length * 100)}%)`);
    }

    // Average CPL impact for followed recs
    const followedWithCpl = followed.filter(o => o.outcome && o.baseline.cpl > 0 && o.outcome.cpl > 0);
    if (followedWithCpl.length >= 3) {
      const avgImpact = followedWithCpl.reduce((sum, o) =>
        sum + (o.outcome!.cpl - o.baseline.cpl) / o.baseline.cpl, 0) / followedWithCpl.length;
      lines.push(`- Avg CPL impact when followed: ${avgImpact <= 0 ? "" : "+"}${(avgImpact * 100).toFixed(0)}%`);
    }

    lines.push("");
  }

  return lines.length > 3 ? lines.join("\n") : null;
}

/**
 * Generate threshold feedback based on follow-through patterns.
 */
export function generateThresholdFeedback(): string | null {
  const state = loadState();
  const completed = state.outcomes.filter(o => o.followed !== null);
  if (completed.length < 10) return null;

  const lines: string[] = [];

  const pauseRecs = completed.filter(o => o.type === "pause" || o.type === "fatigue");
  if (pauseRecs.length >= 5) {
    const followRate = pauseRecs.filter(o => o.followed).length / pauseRecs.length;
    if (followRate < 0.5) {
      lines.push(`- PAUSE threshold may be too aggressive (only ${Math.round(followRate * 100)}% followed). Consider raising from $${getActiveThresholds().pause} to reduce noise.`);
    }
  }

  const scaleRecs = completed.filter(o => o.type === "scale");
  if (scaleRecs.length >= 5) {
    const followRate = scaleRecs.filter(o => o.followed).length / scaleRecs.length;
    const positiveRate = scaleRecs.filter(o => o.followed && o.outcome?.verdict === "positive").length / Math.max(1, scaleRecs.filter(o => o.followed).length);
    if (followRate > 0.8 && positiveRate > 0.7) {
      lines.push(`- SCALE recommendations have ${Math.round(followRate * 100)}% follow rate and ${Math.round(positiveRate * 100)}% positive outcomes. Could tighten threshold to catch more winners.`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

// ============================================================
// SECTION 6: DATA GAP DETECTION
// ============================================================

/**
 * Check form submit divergence between Meta and GHL.
 * Returns alert message if divergence > 20%.
 */
export function checkFormSubmitDivergence(metaFormSubmits: number, ghlLeads: number): string | null {
  if (metaFormSubmits === 0 && ghlLeads === 0) return null;
  if (metaFormSubmits === 0) return null; // can't compare without Meta data

  const divergence = Math.abs(metaFormSubmits - ghlLeads) / metaFormSubmits;
  if (divergence > 0.2 && Math.abs(metaFormSubmits - ghlLeads) >= 2) {
    return `Form submit divergence: Meta reports ${metaFormSubmits} submissions but GHL created ${ghlLeads} leads (${Math.round(divergence * 100)}% gap). Possible webhook issue.`;
  }
  return null;
}

// ============================================================
// DIGEST: SURFACE INSIGHTS
// ============================================================

/**
 * Get compact learner digest for inclusion in nightly/monthly reports.
 */
export function getLearnerDigest(): string {
  const state = loadState();
  const lines: string[] = ["--- Midas Learning ---"];

  // Outcome stats
  const total = state.outcomes.length;
  const followed = state.outcomes.filter(o => o.followed === true).length;
  const ignored = state.outcomes.filter(o => o.followed === false).length;
  const pending = state.outcomes.filter(o => o.followed === null).length;
  const measured = state.outcomes.filter(o => o.outcome !== null);

  if (total > 0) {
    lines.push(`Outcomes: ${total} tracked (${followed} followed, ${ignored} ignored, ${pending} pending)`);
  }

  // Accuracy by type
  for (const type of ["pause", "scale", "refresh", "fatigue"] as const) {
    const typeOutcomes = measured.filter(o => o.type === type);
    if (typeOutcomes.length >= 3) {
      const positive = typeOutcomes.filter(o => o.outcome?.verdict === "positive").length;
      lines.push(`  ${type.toUpperCase()} accuracy: ${Math.round(positive / typeOutcomes.length * 100)}% positive (${positive}/${typeOutcomes.length})`);
    }
  }

  // Adaptive thresholds
  if (state.computedThresholds) {
    const t = state.computedThresholds;
    lines.push(`Thresholds: PAUSE $${t.pause.cpl.toFixed(0)}, SCALE $${t.scale.cpl.toFixed(0)}, REFRESH freq ${t.refresh.frequency.toFixed(1)}`);
  }

  // Fatigue alerts
  const fatigueAlerts = getAllFatigueAlerts();
  if (fatigueAlerts.length > 0) {
    const approaching = fatigueAlerts.filter(a => a.fatigue.predictedDaysToThreshold !== null && !a.fatigue.fatiguing);
    const fatiguing = fatigueAlerts.filter(a => a.fatigue.fatiguing);
    if (fatiguing.length > 0) {
      lines.push(`Fatiguing: ${fatiguing.map(a => a.adName).join(", ")}`);
    }
    if (approaching.length > 0) {
      lines.push(`Approaching fatigue (5d): ${approaching.map(a => `${a.adName} (~${a.fatigue.predictedDaysToThreshold}d)`).join(", ")}`);
    }
  }

  // Playbook health
  if (state.playbookClaims.length > 0) {
    const v = state.playbookClaims.filter(c => c.status === "verified").length;
    const s = state.playbookClaims.filter(c => c.status === "stale").length;
    const c = state.playbookClaims.filter(c => c.status === "contradicted").length;
    lines.push(`Playbook: ${v} verified, ${s} stale, ${c} contradicted`);
  }

  // Decay curve summary
  if (state.decayCurve.length > 0 && state.decayCurve.some(b => b.sampleSize > 0)) {
    const peak = state.decayCurve.reduce((best, b) =>
      b.avgCpl > 0 && b.avgCpl < (best?.avgCpl || Infinity) ? b : best,
      null as DecayBucket | null);
    if (peak) {
      lines.push(`Creative peak: day ${peak.ageDays} (avg CPL $${peak.avgCpl.toFixed(0)})`);
    }
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

/**
 * Get raw learner state for debugging/skill access.
 */
export function getLearnerState(): LearnerState {
  return loadState();
}
