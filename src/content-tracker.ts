/**
 * Atlas -- Content Engagement Tracker
 *
 * Tracks content performance across pillars and formats.
 * Updated weekly (manual or cron), used to optimize content strategy.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { info } from "./logger.ts";

const DATA_DIR = join(process.env.PROJECT_DIR || process.cwd(), "data");
const TRACKER_FILE = join(DATA_DIR, "content-tracker.json");

export interface ContentEntry {
  date: string;
  pillar: number;
  pillarName: string;
  subtopic: string;
  format: string; // "skool" | "facebook" | "newsletter" | "youtube"
  criticScore?: number;
  criticPassed?: boolean;
  // Engagement (filled in later, manually or via API)
  engagement?: {
    likes?: number;
    comments?: number;
    shares?: number;
    reach?: number;
    clicks?: number;
    saves?: number;
  };
  notes?: string;
}

interface TrackerState {
  entries: ContentEntry[];
  pillarStats: Record<number, { total: number; avgEngagement: number; bestSubtopic: string }>;
  lastUpdated: string;
}

function loadTracker(): TrackerState {
  try {
    if (existsSync(TRACKER_FILE)) {
      return JSON.parse(readFileSync(TRACKER_FILE, "utf-8"));
    }
  } catch {}
  return { entries: [], pillarStats: {}, lastUpdated: new Date().toISOString() };
}

function saveTracker(state: TrackerState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  state.lastUpdated = new Date().toISOString();
  // Keep last 90 days
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
  state.entries = state.entries.filter(e => e.date >= cutoff);
  writeFileSync(TRACKER_FILE, JSON.stringify(state, null, 2));
}

/** Log a content generation event (called after content waterfall runs) */
export function trackContentGeneration(entry: Omit<ContentEntry, "engagement">): void {
  const state = loadTracker();
  // Dedup by date + pillar
  const exists = state.entries.find(e => e.date === entry.date && e.pillar === entry.pillar);
  if (exists) {
    Object.assign(exists, entry);
  } else {
    state.entries.push(entry as ContentEntry);
  }
  saveTracker(state);
  info("content-tracker", `Tracked: ${entry.date} Pillar ${entry.pillar} (${entry.subtopic})`);
}

/** Update engagement metrics for a content entry */
export function updateContentEngagement(date: string, pillar: number, engagement: ContentEntry["engagement"]): void {
  const state = loadTracker();
  const entry = state.entries.find(e => e.date === date && e.pillar === pillar);
  if (entry) {
    entry.engagement = { ...entry.engagement, ...engagement };
    saveTracker(state);
  }
}

/** Get a summary of content performance by pillar for the last N days */
export function getContentPerformanceSummary(days: number = 30): string {
  const state = loadTracker();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];
  const recent = state.entries.filter(e => e.date >= cutoff);

  if (recent.length === 0) return "No content tracked in the last " + days + " days.";

  const pillarNames: Record<number, string> = {
    1: "Precision Weight Science",
    2: "Nourishing Health",
    3: "Dynamic Movement",
    4: "Mindful Wellness",
    5: "Functional Wellness",
  };

  const byPillar: Record<number, ContentEntry[]> = {};
  for (const entry of recent) {
    if (!byPillar[entry.pillar]) byPillar[entry.pillar] = [];
    byPillar[entry.pillar].push(entry);
  }

  const lines: string[] = [`Content Performance (${days}d, ${recent.length} entries):`];

  for (const [pillar, entries] of Object.entries(byPillar).sort(([a], [b]) => Number(a) - Number(b))) {
    const p = Number(pillar);
    const withEngagement = entries.filter(e => e.engagement);
    const totalComments = withEngagement.reduce((s, e) => s + (e.engagement?.comments || 0), 0);
    const totalLikes = withEngagement.reduce((s, e) => s + (e.engagement?.likes || 0), 0);
    const avgCritic = entries.filter(e => e.criticScore).reduce((s, e) => s + (e.criticScore || 0), 0) / (entries.filter(e => e.criticScore).length || 1);

    lines.push(`  P${p} (${pillarNames[p] || "Unknown"}): ${entries.length} posts, ${withEngagement.length} measured`);
    if (withEngagement.length > 0) {
      lines.push(`    Engagement: ${totalLikes} likes, ${totalComments} comments`);
    }
    if (avgCritic > 0) {
      lines.push(`    Avg critic score: ${Math.round(avgCritic * 100)}%`);
    }
  }

  return lines.join("\n");
}
