/**
 * Atlas — Google Analytics 4 Integration
 *
 * Pulls GA4 reporting data: sessions, traffic sources, conversions,
 * landing pages, user engagement, and real-time active users.
 *
 * Auth: Uses Derek's existing OAuth2 client with analytics.readonly scope.
 * API: Google Analytics Data API v1beta via googleapis package.
 */

import { google, type analyticsdata_v1beta } from "googleapis";
import { info, warn, error as logError } from "./logger.ts";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
type AnalyticsData = analyticsdata_v1beta.Analyticsdata;

// ============================================================
// TYPES
// ============================================================

export interface GA4Overview {
  period: string;
  sessions: number;
  users: number;
  newUsers: number;
  pageviews: number;
  avgSessionDuration: number; // seconds
  bounceRate: number; // 0-1
  engagementRate: number; // 0-1
  conversions: number;
}

export interface GA4TrafficSource {
  source: string;
  medium: string;
  sessions: number;
  users: number;
  conversions: number;
  engagementRate: number;
}

export interface GA4LandingPage {
  page: string;
  sessions: number;
  users: number;
  bounceRate: number;
  avgSessionDuration: number;
  conversions: number;
}

export interface GA4ConversionEvent {
  eventName: string;
  count: number;
  users: number;
}

export interface GA4DailyTrend {
  date: string;
  sessions: number;
  users: number;
  conversions: number;
}

// ============================================================
// STATE
// ============================================================

let analyticsData: AnalyticsData | null = null;
let propertyId: string = "";

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID || "";

// ============================================================
// INIT
// ============================================================

export function initGA4(oauthClient: OAuth2Client): boolean {
  if (!GA4_PROPERTY_ID) {
    return false;
  }

  analyticsData = google.analyticsdata({ version: "v1beta", auth: oauthClient });
  propertyId = `properties/${GA4_PROPERTY_ID}`;
  info("ga4", `GA4 initialized: property=${GA4_PROPERTY_ID}`);
  return true;
}

export function isGA4Ready(): boolean {
  return !!analyticsData && !!GA4_PROPERTY_ID;
}

// ============================================================
// HELPERS
// ============================================================

function dateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

function parseNum(val?: string | null): number {
  return val ? Number(val) : 0;
}

function parsePct(val?: string | null): number {
  const n = parseNum(val);
  return n > 1 ? n / 100 : n; // GA4 may return 0.XX or XX.X
}

// ============================================================
// OVERVIEW
// ============================================================

export async function getOverview(days = 7): Promise<GA4Overview> {
  if (!analyticsData) throw new Error("GA4 not initialized");

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const res = await analyticsData.properties.runReport({
    property: propertyId,
    requestBody: {
      dateRanges: [{ startDate: dateStr(startDate), endDate: dateStr(endDate) }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "newUsers" },
        { name: "screenPageViews" },
        { name: "averageSessionDuration" },
        { name: "bounceRate" },
        { name: "engagementRate" },
        { name: "conversions" },
      ],
    },
  });

  const row = res.data.rows?.[0];
  const vals = row?.metricValues || [];

  return {
    period: `last ${days} days`,
    sessions: parseNum(vals[0]?.value),
    users: parseNum(vals[1]?.value),
    newUsers: parseNum(vals[2]?.value),
    pageviews: parseNum(vals[3]?.value),
    avgSessionDuration: parseNum(vals[4]?.value),
    bounceRate: parsePct(vals[5]?.value),
    engagementRate: parsePct(vals[6]?.value),
    conversions: parseNum(vals[7]?.value),
  };
}

// ============================================================
// TRAFFIC SOURCES
// ============================================================

export async function getTrafficSources(days = 7, limit = 10): Promise<GA4TrafficSource[]> {
  if (!analyticsData) throw new Error("GA4 not initialized");

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const res = await analyticsData.properties.runReport({
    property: propertyId,
    requestBody: {
      dateRanges: [{ startDate: dateStr(startDate), endDate: dateStr(endDate) }],
      dimensions: [
        { name: "sessionSource" },
        { name: "sessionMedium" },
      ],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "conversions" },
        { name: "engagementRate" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit,
    },
  });

  return (res.data.rows || []).map((row) => ({
    source: row.dimensionValues?.[0]?.value || "(direct)",
    medium: row.dimensionValues?.[1]?.value || "(none)",
    sessions: parseNum(row.metricValues?.[0]?.value),
    users: parseNum(row.metricValues?.[1]?.value),
    conversions: parseNum(row.metricValues?.[2]?.value),
    engagementRate: parsePct(row.metricValues?.[3]?.value),
  }));
}

// ============================================================
// LANDING PAGES
// ============================================================

export async function getLandingPages(days = 7, limit = 10): Promise<GA4LandingPage[]> {
  if (!analyticsData) throw new Error("GA4 not initialized");

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const res = await analyticsData.properties.runReport({
    property: propertyId,
    requestBody: {
      dateRanges: [{ startDate: dateStr(startDate), endDate: dateStr(endDate) }],
      dimensions: [{ name: "landingPagePlusQueryString" }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "bounceRate" },
        { name: "averageSessionDuration" },
        { name: "conversions" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit,
    },
  });

  return (res.data.rows || []).map((row) => ({
    page: row.dimensionValues?.[0]?.value || "/",
    sessions: parseNum(row.metricValues?.[0]?.value),
    users: parseNum(row.metricValues?.[1]?.value),
    bounceRate: parsePct(row.metricValues?.[2]?.value),
    avgSessionDuration: parseNum(row.metricValues?.[3]?.value),
    conversions: parseNum(row.metricValues?.[4]?.value),
  }));
}

// ============================================================
// CONVERSIONS
// ============================================================

export async function getConversions(days = 7): Promise<GA4ConversionEvent[]> {
  if (!analyticsData) throw new Error("GA4 not initialized");

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const res = await analyticsData.properties.runReport({
    property: propertyId,
    requestBody: {
      dateRanges: [{ startDate: dateStr(startDate), endDate: dateStr(endDate) }],
      dimensions: [{ name: "eventName" }],
      metrics: [
        { name: "conversions" },
        { name: "totalUsers" },
      ],
      dimensionFilter: {
        filter: {
          fieldName: "eventName",
          inListFilter: {
            values: [
              "form_submit",
              "generate_lead",
              "purchase",
              "sign_up",
              "contact",
              "schedule_appointment",
              "phone_call",
              "click_to_call",
            ],
          },
        },
      },
      orderBys: [{ metric: { metricName: "conversions" }, desc: true }],
    },
  });

  return (res.data.rows || []).map((row) => ({
    eventName: row.dimensionValues?.[0]?.value || "",
    count: parseNum(row.metricValues?.[0]?.value),
    users: parseNum(row.metricValues?.[1]?.value),
  })).filter((e) => e.count > 0);
}

// ============================================================
// DAILY TREND
// ============================================================

export async function getDailyTrend(days = 14): Promise<GA4DailyTrend[]> {
  if (!analyticsData) throw new Error("GA4 not initialized");

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const res = await analyticsData.properties.runReport({
    property: propertyId,
    requestBody: {
      dateRanges: [{ startDate: dateStr(startDate), endDate: dateStr(endDate) }],
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "conversions" },
      ],
      orderBys: [{ dimension: { dimensionName: "date" } }],
    },
  });

  return (res.data.rows || []).map((row) => {
    const raw = row.dimensionValues?.[0]?.value || "";
    // GA4 returns YYYYMMDD format
    const formatted = raw.length === 8
      ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
      : raw;
    return {
      date: formatted,
      sessions: parseNum(row.metricValues?.[0]?.value),
      users: parseNum(row.metricValues?.[1]?.value),
      conversions: parseNum(row.metricValues?.[2]?.value),
    };
  });
}

// ============================================================
// REAL-TIME
// ============================================================

export async function getRealtimeUsers(): Promise<number> {
  if (!analyticsData) throw new Error("GA4 not initialized");

  try {
    const res = await analyticsData.properties.runRealtimeReport({
      property: propertyId,
      requestBody: {
        metrics: [{ name: "activeUsers" }],
      },
    });

    return parseNum(res.data.rows?.[0]?.metricValues?.[0]?.value);
  } catch (err) {
    warn("ga4", `Realtime report failed: ${err}`);
    return 0;
  }
}

// ============================================================
// FORMATTERS
// ============================================================

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatOverview(o: GA4Overview): string {
  const lines: string[] = [`WEBSITE ANALYTICS (${o.period})`];

  lines.push(
    `\nSessions: ${o.sessions.toLocaleString()} | Users: ${o.users.toLocaleString()} (${o.newUsers.toLocaleString()} new)`,
    `Pageviews: ${o.pageviews.toLocaleString()}`,
    `Avg session: ${fmtDuration(o.avgSessionDuration)}`,
    `Engagement rate: ${pct(o.engagementRate)} | Bounce rate: ${pct(o.bounceRate)}`,
  );

  if (o.conversions > 0) {
    const convRate = o.sessions > 0 ? ((o.conversions / o.sessions) * 100).toFixed(1) : "0";
    lines.push(`Conversions: ${o.conversions} (${convRate}% of sessions)`);
  }

  return lines.join("\n");
}

export function formatTrafficSources(sources: GA4TrafficSource[]): string {
  if (sources.length === 0) return "No traffic source data available.";

  const lines: string[] = ["TRAFFIC SOURCES"];
  for (const s of sources) {
    const label = `${s.source} / ${s.medium}`;
    const conv = s.conversions > 0 ? ` | ${s.conversions} conv` : "";
    lines.push(`  ${label}: ${s.sessions} sessions, ${s.users} users${conv}`);
  }
  return lines.join("\n");
}

export function formatLandingPages(pages: GA4LandingPage[]): string {
  if (pages.length === 0) return "No landing page data available.";

  const lines: string[] = ["TOP LANDING PAGES"];
  for (const p of pages) {
    const pagePath = p.page.length > 50 ? p.page.substring(0, 47) + "..." : p.page;
    const conv = p.conversions > 0 ? ` | ${p.conversions} conv` : "";
    lines.push(`  ${pagePath}: ${p.sessions} sessions, ${pct(p.bounceRate)} bounce${conv}`);
  }
  return lines.join("\n");
}

export function formatConversions(events: GA4ConversionEvent[]): string {
  if (events.length === 0) return "No conversion events tracked.";

  const lines: string[] = ["CONVERSION EVENTS"];
  const total = events.reduce((sum, e) => sum + e.count, 0);
  lines.push(`Total: ${total} conversions\n`);

  for (const e of events) {
    lines.push(`  ${e.eventName}: ${e.count} (${e.users} users)`);
  }
  return lines.join("\n");
}

export function formatDailyTrend(trends: GA4DailyTrend[]): string {
  if (trends.length === 0) return "No trend data available.";

  const lines: string[] = ["DAILY TREND"];
  for (const t of trends) {
    const conv = t.conversions > 0 ? ` | ${t.conversions} conv` : "";
    lines.push(`  ${t.date}: ${t.sessions} sessions, ${t.users} users${conv}`);
  }

  // Week-over-week comparison
  if (trends.length >= 14) {
    const thisWeek = trends.slice(-7);
    const lastWeek = trends.slice(-14, -7);
    const thisWeekSessions = thisWeek.reduce((s, t) => s + t.sessions, 0);
    const lastWeekSessions = lastWeek.reduce((s, t) => s + t.sessions, 0);
    if (lastWeekSessions > 0) {
      const change = ((thisWeekSessions - lastWeekSessions) / lastWeekSessions) * 100;
      const arrow = change >= 0 ? "↑" : "↓";
      lines.push(`\nWeek-over-week: ${arrow} ${Math.abs(change).toFixed(1)}% (${thisWeekSessions} vs ${lastWeekSessions})`);
    }
  }

  return lines.join("\n");
}

// ============================================================
// CONTEXT FOR CLAUDE PROMPT
// ============================================================

export async function getGA4Context(): Promise<string> {
  if (!isGA4Ready()) return "";

  try {
    const overview = await getOverview(7).catch(() => null);
    if (!overview) return "";

    const convRate = overview.sessions > 0
      ? ((overview.conversions / overview.sessions) * 100).toFixed(1)
      : "0";

    return (
      `GA4 (7d): ${overview.sessions} sessions, ${overview.users} users, ` +
      `${pct(overview.engagementRate)} engaged, ` +
      `${overview.conversions} conversions (${convRate}%)`
    );
  } catch (err) {
    warn("ga4", `Context fetch failed: ${err}`);
    return "";
  }
}
