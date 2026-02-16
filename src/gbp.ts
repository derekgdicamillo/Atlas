/**
 * Atlas — Google Business Profile Integration
 *
 * Pulls GBP reviews and performance metrics (impressions, calls,
 * direction requests, website clicks, search keywords).
 *
 * Auth: Uses Derek's existing OAuth2 client with business.manage scope.
 * Reviews use legacy My Business v4 REST API (no googleapis SDK).
 * Performance uses the businessprofileperformance v1 API.
 */

import { google } from "googleapis";
import { info, warn, error as logError } from "./logger.ts";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

// ============================================================
// TYPES
// ============================================================

export interface GBPReview {
  reviewer: string;
  rating: number; // 1-5 (STAR_RATING enum mapped)
  comment?: string;
  createTime: string;
  updateTime: string;
  replyComment?: string;
  replyTime?: string;
}

export interface GBPReviewSummary {
  totalReviews: number;
  averageRating: number;
  recentReviews: GBPReview[];
  unreplied: number;
  ratingDistribution: { [stars: number]: number };
  reviewVelocity: number; // reviews per month (last 30d)
}

export interface GBPPerformanceMetrics {
  period: string; // "last 7 days" etc.
  websiteClicks: number;
  phoneCalls: number;
  directionRequests: number;
  businessImpressions: number; // total search + maps
  searchImpressions: number;
  mapImpressions: number;
  conversations: number;
  bookings: number;
}

export interface GBPSearchKeyword {
  keyword: string;
  impressions: number;
}

// ============================================================
// STATE
// ============================================================

let auth: OAuth2Client | null = null;
let locationName: string = ""; // "locations/{id}" format
let accountName: string = ""; // "accounts/{id}" format

const GBP_LOCATION_ID = process.env.GBP_LOCATION_ID || "";
const GBP_ACCOUNT_ID = process.env.GBP_ACCOUNT_ID || "";

// ============================================================
// INIT
// ============================================================

export function initGBP(oauthClient: OAuth2Client): boolean {
  if (!GBP_LOCATION_ID || !GBP_ACCOUNT_ID) {
    return false;
  }

  auth = oauthClient;
  locationName = `locations/${GBP_LOCATION_ID}`;
  accountName = `accounts/${GBP_ACCOUNT_ID}`;
  info("gbp", `GBP initialized: account=${GBP_ACCOUNT_ID}, location=${GBP_LOCATION_ID}`);
  return true;
}

export function isGBPReady(): boolean {
  return !!auth && !!GBP_LOCATION_ID && !!GBP_ACCOUNT_ID;
}

// ============================================================
// REVIEWS (Legacy My Business v4 REST API)
// ============================================================

async function fetchReviews(pageSize = 50): Promise<GBPReview[]> {
  if (!auth) throw new Error("GBP auth not initialized");

  const accessToken = await auth.getAccessToken();
  const token = accessToken.token;
  if (!token) throw new Error("Could not get access token for GBP");

  const url = `https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/reviews?pageSize=${pageSize}&orderBy=updateTime desc`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GBP reviews API returned ${res.status}: ${body.substring(0, 300)}`);
  }

  const data = await res.json() as {
    reviews?: Array<{
      reviewer?: { displayName?: string };
      starRating?: string;
      comment?: string;
      createTime?: string;
      updateTime?: string;
      reviewReply?: { comment?: string; updateTime?: string };
    }>;
    totalReviewCount?: number;
    averageRating?: number;
  };

  const ratingMap: Record<string, number> = {
    ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
  };

  return (data.reviews || []).map((r) => ({
    reviewer: r.reviewer?.displayName || "Anonymous",
    rating: ratingMap[r.starRating || ""] || 0,
    comment: r.comment,
    createTime: r.createTime || "",
    updateTime: r.updateTime || "",
    replyComment: r.reviewReply?.comment,
    replyTime: r.reviewReply?.updateTime,
  }));
}

export async function getReviewSummary(): Promise<GBPReviewSummary> {
  const reviews = await fetchReviews(50);

  const totalReviews = reviews.length;
  const avgRating = totalReviews > 0
    ? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
    : 0;

  const unreplied = reviews.filter((r) => !r.replyComment).length;

  const distribution: { [stars: number]: number } = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of reviews) {
    if (r.rating >= 1 && r.rating <= 5) distribution[r.rating]++;
  }

  // Review velocity: count reviews in last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recentCount = reviews.filter((r) =>
    r.createTime && new Date(r.createTime) >= thirtyDaysAgo
  ).length;

  // Recent reviews (last 5)
  const recentReviews = reviews.slice(0, 5);

  return {
    totalReviews,
    averageRating: avgRating,
    recentReviews,
    unreplied,
    ratingDistribution: distribution,
    reviewVelocity: recentCount,
  };
}

// ============================================================
// PERFORMANCE METRICS (businessprofileperformance v1)
// ============================================================

const DAILY_METRICS = [
  "WEBSITE_CLICKS",
  "CALL_CLICKS",
  "BUSINESS_DIRECTION_REQUESTS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_BOOKINGS",
] as const;

function dateToGBP(d: Date): { year: number; month: number; day: number } {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

export async function getPerformanceMetrics(days = 7): Promise<GBPPerformanceMetrics> {
  if (!auth) throw new Error("GBP auth not initialized");

  const perfApi = google.businessprofileperformance({ version: "v1", auth });

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const start = dateToGBP(startDate);
  const end = dateToGBP(endDate);

  // Fetch all metrics in one batch call
  const res = await perfApi.locations.fetchMultiDailyMetricsTimeSeries({
    location: locationName,
    dailyMetrics: [...DAILY_METRICS],
    "dailyRange.startDate.year": start.year,
    "dailyRange.startDate.month": start.month,
    "dailyRange.startDate.day": start.day,
    "dailyRange.endDate.year": end.year,
    "dailyRange.endDate.month": end.month,
    "dailyRange.endDate.day": end.day,
  });

  // Sum up all daily values per metric
  const sums: Record<string, number> = {};
  for (const metric of DAILY_METRICS) {
    sums[metric] = 0;
  }

  const series = res.data.multiDailyMetricTimeSeries || [];
  for (const s of series) {
    const metricName = s.dailyMetricTimeSeries?.dailyMetric || "";
    const values = s.dailyMetricTimeSeries?.timeSeries?.datedValues || [];
    for (const v of values) {
      sums[metricName] = (sums[metricName] || 0) + Number(v.value || 0);
    }
  }

  const searchImpressions =
    (sums["BUSINESS_IMPRESSIONS_DESKTOP_SEARCH"] || 0) +
    (sums["BUSINESS_IMPRESSIONS_MOBILE_SEARCH"] || 0);
  const mapImpressions =
    (sums["BUSINESS_IMPRESSIONS_DESKTOP_MAPS"] || 0) +
    (sums["BUSINESS_IMPRESSIONS_MOBILE_MAPS"] || 0);

  return {
    period: `last ${days} days`,
    websiteClicks: sums["WEBSITE_CLICKS"] || 0,
    phoneCalls: sums["CALL_CLICKS"] || 0,
    directionRequests: sums["BUSINESS_DIRECTION_REQUESTS"] || 0,
    businessImpressions: searchImpressions + mapImpressions,
    searchImpressions,
    mapImpressions,
    conversations: sums["BUSINESS_CONVERSATIONS"] || 0,
    bookings: sums["BUSINESS_BOOKINGS"] || 0,
  };
}

// ============================================================
// SEARCH KEYWORDS
// ============================================================

export async function getSearchKeywords(): Promise<GBPSearchKeyword[]> {
  if (!auth) throw new Error("GBP auth not initialized");

  const perfApi = google.businessprofileperformance({ version: "v1", auth });

  try {
    const res = await perfApi.locations.searchkeywords.impressions.monthly.list({
      parent: locationName,
      // Gets latest month by default
    });

    const keywords = res.data.searchKeywordsCounts || [];
    return keywords
      .map((k) => ({
        keyword: k.searchKeyword || "",
        impressions: Number(k.insightsValue?.value || 0),
      }))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 20);
  } catch (err) {
    warn("gbp", `Search keywords fetch failed: ${err}`);
    return [];
  }
}

// ============================================================
// FORMATTERS
// ============================================================

export function formatReviewSummary(summary: GBPReviewSummary): string {
  const lines: string[] = ["GOOGLE REVIEWS"];

  lines.push(
    `\nRating: ${summary.averageRating.toFixed(1)} / 5.0 (${summary.totalReviews} reviews)`,
    `Review velocity: ${summary.reviewVelocity} in last 30 days`,
  );

  if (summary.unreplied > 0) {
    lines.push(`Unreplied reviews: ${summary.unreplied}`);
  }

  // Rating distribution bar
  lines.push("\nDistribution:");
  for (let star = 5; star >= 1; star--) {
    const count = summary.ratingDistribution[star] || 0;
    const bar = "█".repeat(Math.ceil(count / 2));
    lines.push(`  ${star}★ ${bar} ${count}`);
  }

  // Recent reviews
  if (summary.recentReviews.length > 0) {
    lines.push("\nRecent reviews:");
    for (const r of summary.recentReviews.slice(0, 3)) {
      const stars = "★".repeat(r.rating) + "☆".repeat(5 - r.rating);
      const snippet = r.comment ? ` — "${r.comment.substring(0, 80)}${r.comment.length > 80 ? "..." : ""}"` : "";
      const replied = r.replyComment ? " [replied]" : " [needs reply]";
      lines.push(`  ${stars} ${r.reviewer}${snippet}${replied}`);
    }
  }

  return lines.join("\n");
}

export function formatPerformanceMetrics(metrics: GBPPerformanceMetrics): string {
  const lines: string[] = [`GOOGLE BUSINESS PROFILE (${metrics.period})`];

  lines.push(
    `\nImpressions: ${metrics.businessImpressions.toLocaleString()} total`,
    `  Search: ${metrics.searchImpressions.toLocaleString()} | Maps: ${metrics.mapImpressions.toLocaleString()}`,
    `\nActions:`,
    `  Website clicks: ${metrics.websiteClicks.toLocaleString()}`,
    `  Phone calls: ${metrics.phoneCalls.toLocaleString()}`,
    `  Direction requests: ${metrics.directionRequests.toLocaleString()}`,
  );

  if (metrics.conversations > 0) {
    lines.push(`  Conversations: ${metrics.conversations.toLocaleString()}`);
  }
  if (metrics.bookings > 0) {
    lines.push(`  Bookings: ${metrics.bookings.toLocaleString()}`);
  }

  // Action rate
  const totalActions = metrics.websiteClicks + metrics.phoneCalls + metrics.directionRequests;
  if (metrics.businessImpressions > 0 && totalActions > 0) {
    const actionRate = ((totalActions / metrics.businessImpressions) * 100).toFixed(1);
    lines.push(`\nAction rate: ${actionRate}% (actions / impressions)`);
  }

  return lines.join("\n");
}

export function formatSearchKeywords(keywords: GBPSearchKeyword[]): string {
  if (keywords.length === 0) return "No search keyword data available.";

  const lines: string[] = ["TOP SEARCH KEYWORDS"];
  for (const kw of keywords.slice(0, 15)) {
    lines.push(`  ${kw.keyword}: ${kw.impressions.toLocaleString()} impressions`);
  }
  return lines.join("\n");
}

// ============================================================
// CONTEXT FOR CLAUDE PROMPT
// ============================================================

export async function getGBPContext(): Promise<string> {
  if (!isGBPReady()) return "";

  try {
    const [metrics, summary] = await Promise.all([
      getPerformanceMetrics(7).catch(() => null),
      getReviewSummary().catch(() => null),
    ]);

    const parts: string[] = [];

    if (metrics) {
      parts.push(
        `GBP (7d): ${metrics.businessImpressions} impressions, ` +
        `${metrics.websiteClicks} clicks, ${metrics.phoneCalls} calls, ` +
        `${metrics.directionRequests} directions`
      );
    }

    if (summary) {
      parts.push(
        `Reviews: ${summary.averageRating.toFixed(1)}/5 (${summary.totalReviews} total)` +
        (summary.unreplied > 0 ? `, ${summary.unreplied} unreplied` : "")
      );
    }

    return parts.join("\n");
  } catch (err) {
    warn("gbp", `Context fetch failed: ${err}`);
    return "";
  }
}
