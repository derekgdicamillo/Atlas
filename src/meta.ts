/**
 * Atlas -- Meta (Facebook) Marketing API Integration
 *
 * Server-side integration using a System User long-lived token.
 * Pulls ad account insights, campaign breakdowns, and top creative
 * performance via Graph API v21.0.
 *
 * Token setup:
 *   1. Go to Facebook Business Manager > Business Settings > System Users
 *   2. Create a System User (Admin role)
 *   3. Generate a token with permissions: ads_read, read_insights
 *   4. The token is permanent (no refresh needed) as long as the System User exists
 *   5. Add the token to .env as META_ACCESS_TOKEN
 *
 * Env vars:
 *   META_ACCESS_TOKEN    - System User token from Business Manager
 *   META_AD_ACCOUNT_ID   - Ad account ID (format: act_XXXXXXXXX)
 *
 * Rate limits (Graph API v21.0):
 *   - Standard: 200 calls per user per hour per app
 *   - Insights: subject to async report thresholds for large date ranges
 *   - In practice, Atlas makes <10 calls per command. Not a concern.
 */

import { info, warn, error as logError } from "./logger.ts";

// ============================================================
// CONFIGURATION
// ============================================================

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

let accessToken: string | null = null;
let adAccountId: string | null = null;
let metaReady = false;

// ============================================================
// TYPES
// ============================================================

export interface DateRange {
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD
}

export interface AccountSummary {
  dateRange: DateRange;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  reach: number;
  frequency: number;
  conversions: number;
  cpl: number;
  linkClicks: number;
  landingPageViews: number;
}

export interface CampaignInsight {
  campaignId: string;
  campaignName: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  conversions: number;
  cpl: number;
  reach: number;
}

export interface AdInsight {
  adId: string;
  adName: string;
  adsetName: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  conversions: number;
  cpl: number;
  reach: number;
}

export interface AdCreativeDetail {
  adId: string;
  adName: string;
  status: string;
  creative: {
    title?: string;
    body?: string;
    linkUrl?: string;
    imageUrl?: string;
    callToAction?: string;
  };
}

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Validate Meta API token on startup.
 * Returns true if configured and valid, false otherwise.
 * Does NOT throw. Gracefully degrades if not configured.
 */
export async function initMeta(): Promise<boolean> {
  accessToken = process.env.META_ACCESS_TOKEN || null;
  adAccountId = process.env.META_AD_ACCOUNT_ID || null;

  if (!accessToken || !adAccountId) {
    warn("meta", "Meta API not configured (missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID)");
    metaReady = false;
    return false;
  }

  // Validate token by hitting the account endpoint
  try {
    const url = `${GRAPH_BASE}/${adAccountId}?fields=name,account_status,currency,timezone_name&access_token=${accessToken}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      logError("meta", `Token validation failed: ${data.error.message}`);
      metaReady = false;
      return false;
    }

    metaReady = true;
    info("meta", `Meta API ready: ${data.name} (${adAccountId}), currency=${data.currency}, tz=${data.timezone_name}`);
    return true;
  } catch (err) {
    logError("meta", `Meta API init error: ${err}`);
    metaReady = false;
    return false;
  }
}

export function isMetaReady(): boolean {
  return metaReady;
}

// ============================================================
// DATE RANGE HELPERS
// ============================================================

/**
 * Parse a shorthand date range string into a DateRange.
 * Supports: "today", "yesterday", "7d", "14d", "30d", "mtd", "last_month"
 * Default: "7d"
 */
export function parseDateRange(input?: string): DateRange {
  const now = new Date();
  // Use USER_TIMEZONE for consistency
  const tz = process.env.USER_TIMEZONE || "America/Phoenix";
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD

  const today = new Date(todayStr + "T00:00:00");

  const fmt = (d: Date): string => d.toISOString().split("T")[0];

  const range = (input || "7d").toLowerCase().trim();

  switch (range) {
    case "today":
      return { since: todayStr, until: todayStr };

    case "yesterday": {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      return { since: fmt(y), until: fmt(y) };
    }

    case "7d": {
      const start = new Date(today);
      start.setDate(start.getDate() - 7);
      return { since: fmt(start), until: todayStr };
    }

    case "14d": {
      const start = new Date(today);
      start.setDate(start.getDate() - 14);
      return { since: fmt(start), until: todayStr };
    }

    case "30d": {
      const start = new Date(today);
      start.setDate(start.getDate() - 30);
      return { since: fmt(start), until: todayStr };
    }

    case "mtd": {
      const monthStart = todayStr.substring(0, 8) + "01";
      return { since: monthStart, until: todayStr };
    }

    case "last_month": {
      const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastMonthEnd = new Date(firstOfThisMonth);
      lastMonthEnd.setDate(lastMonthEnd.getDate() - 1);
      const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
      return { since: fmt(lastMonthStart), until: fmt(lastMonthEnd) };
    }

    default:
      // Try parsing as "7d" style
      const match = range.match(/^(\d+)d$/);
      if (match) {
        const days = parseInt(match[1], 10);
        const start = new Date(today);
        start.setDate(start.getDate() - days);
        return { since: fmt(start), until: todayStr };
      }
      // Fallback: 7 days
      {
        const start = new Date(today);
        start.setDate(start.getDate() - 7);
        return { since: fmt(start), until: todayStr };
      }
  }
}

// ============================================================
// GRAPH API HELPERS
// ============================================================

interface GraphError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
  };
}

async function graphGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  if (!accessToken) throw new Error("Meta API not configured");

  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set("access_token", accessToken);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json();

  if ((data as GraphError).error) {
    const err = (data as GraphError).error;
    throw new Error(`Graph API error [${err.code}]: ${err.message}`);
  }

  return data as T;
}

/**
 * Extract conversion count from the actions array.
 * We look for our custom conversion event first, then fall back to
 * offsite_conversion.fb_pixel_custom and finally lead actions.
 */
function extractConversions(actions?: Array<{ action_type: string; value: string }>): number {
  if (!actions || actions.length === 0) return 0;

  // Priority order for conversion actions
  const conversionTypes = [
    "offsite_conversion.custom.weight_loss_form_submit",
    "offsite_conversion.fb_pixel_custom",
    "lead",
    "offsite_conversion.fb_pixel_lead",
    "complete_registration",
  ];

  for (const type of conversionTypes) {
    const action = actions.find((a) => a.action_type === type);
    if (action) return parseInt(action.value, 10) || 0;
  }

  return 0;
}

/** Extract link clicks from actions array */
function extractLinkClicks(actions?: Array<{ action_type: string; value: string }>): number {
  if (!actions) return 0;
  const action = actions.find((a) => a.action_type === "link_click");
  return action ? parseInt(action.value, 10) || 0 : 0;
}

/** Extract landing page views from actions array */
function extractLandingPageViews(actions?: Array<{ action_type: string; value: string }>): number {
  if (!actions) return 0;
  const action = actions.find((a) => a.action_type === "landing_page_view");
  return action ? parseInt(action.value, 10) || 0 : 0;
}

// ============================================================
// CORE API FUNCTIONS
// ============================================================

/**
 * Get account-level summary for a date range.
 * Endpoint: GET /{ad_account_id}/insights
 */
export async function getAccountSummary(dateRange?: DateRange | string): Promise<AccountSummary> {
  if (!metaReady) throw new Error("Meta API not configured");

  const range = typeof dateRange === "string" ? parseDateRange(dateRange) : (dateRange || parseDateRange("7d"));

  const fields = [
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "reach",
    "frequency",
    "actions",
  ].join(",");

  const data = await graphGet<{ data: Array<Record<string, any>> }>(
    `/${adAccountId}/insights`,
    {
      fields,
      time_range: JSON.stringify({ since: range.since, until: range.until }),
      level: "account",
    }
  );

  if (!data.data || data.data.length === 0) {
    return {
      dateRange: range,
      spend: 0,
      impressions: 0,
      clicks: 0,
      ctr: 0,
      cpc: 0,
      reach: 0,
      frequency: 0,
      conversions: 0,
      cpl: 0,
      linkClicks: 0,
      landingPageViews: 0,
    };
  }

  const row = data.data[0];
  const spend = parseFloat(row.spend || "0");
  const conversions = extractConversions(row.actions);
  const linkClicks = extractLinkClicks(row.actions);
  const landingPageViews = extractLandingPageViews(row.actions);

  return {
    dateRange: range,
    spend,
    impressions: parseInt(row.impressions || "0", 10),
    clicks: parseInt(row.clicks || "0", 10),
    ctr: parseFloat(row.ctr || "0"),
    cpc: parseFloat(row.cpc || "0"),
    reach: parseInt(row.reach || "0", 10),
    frequency: parseFloat(row.frequency || "0"),
    conversions,
    cpl: conversions > 0 ? spend / conversions : 0,
    linkClicks,
    landingPageViews,
  };
}

/**
 * Get per-campaign performance breakdown.
 * Endpoint: GET /{ad_account_id}/insights?level=campaign
 */
export async function getCampaignBreakdown(dateRange?: DateRange | string): Promise<CampaignInsight[]> {
  if (!metaReady) throw new Error("Meta API not configured");

  const range = typeof dateRange === "string" ? parseDateRange(dateRange) : (dateRange || parseDateRange("7d"));

  const fields = [
    "campaign_id",
    "campaign_name",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "reach",
    "actions",
  ].join(",");

  const data = await graphGet<{ data: Array<Record<string, any>> }>(
    `/${adAccountId}/insights`,
    {
      fields,
      time_range: JSON.stringify({ since: range.since, until: range.until }),
      level: "campaign",
      limit: "50",
    }
  );

  if (!data.data) return [];

  // Also fetch campaign statuses
  let campaignStatuses: Record<string, string> = {};
  try {
    const campaigns = await graphGet<{ data: Array<{ id: string; effective_status: string }> }>(
      `/${adAccountId}/campaigns`,
      { fields: "id,effective_status", limit: "100" }
    );
    for (const c of campaigns.data || []) {
      campaignStatuses[c.id] = c.effective_status;
    }
  } catch {
    // Non-critical, continue without statuses
  }

  return data.data.map((row) => {
    const spend = parseFloat(row.spend || "0");
    const conversions = extractConversions(row.actions);
    return {
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      status: campaignStatuses[row.campaign_id] || "UNKNOWN",
      spend,
      impressions: parseInt(row.impressions || "0", 10),
      clicks: parseInt(row.clicks || "0", 10),
      ctr: parseFloat(row.ctr || "0"),
      cpc: parseFloat(row.cpc || "0"),
      conversions,
      cpl: conversions > 0 ? spend / conversions : 0,
      reach: parseInt(row.reach || "0", 10),
    };
  });
}

/**
 * Get top performing ads sorted by lowest CPA (cost per acquisition).
 * Endpoint: GET /{ad_account_id}/insights?level=ad
 */
export async function getTopAds(dateRange?: DateRange | string, limit = 5): Promise<AdInsight[]> {
  if (!metaReady) throw new Error("Meta API not configured");

  const range = typeof dateRange === "string" ? parseDateRange(dateRange) : (dateRange || parseDateRange("7d"));

  const fields = [
    "ad_id",
    "ad_name",
    "adset_name",
    "campaign_name",
    "spend",
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "reach",
    "actions",
  ].join(",");

  const data = await graphGet<{ data: Array<Record<string, any>> }>(
    `/${adAccountId}/insights`,
    {
      fields,
      time_range: JSON.stringify({ since: range.since, until: range.until }),
      level: "ad",
      limit: "100", // Fetch more, then sort client-side
    }
  );

  if (!data.data) return [];

  const ads: AdInsight[] = data.data.map((row) => {
    const spend = parseFloat(row.spend || "0");
    const conversions = extractConversions(row.actions);
    return {
      adId: row.ad_id,
      adName: row.ad_name,
      adsetName: row.adset_name,
      campaignName: row.campaign_name,
      spend,
      impressions: parseInt(row.impressions || "0", 10),
      clicks: parseInt(row.clicks || "0", 10),
      ctr: parseFloat(row.ctr || "0"),
      cpc: parseFloat(row.cpc || "0"),
      conversions,
      cpl: conversions > 0 ? spend / conversions : 0,
      reach: parseInt(row.reach || "0", 10),
    };
  });

  // Sort: ads with conversions first (by lowest CPL), then by most spend
  ads.sort((a, b) => {
    if (a.conversions > 0 && b.conversions > 0) return a.cpl - b.cpl;
    if (a.conversions > 0) return -1;
    if (b.conversions > 0) return 1;
    return b.spend - a.spend; // No conversions: highest spend first (active ads)
  });

  return ads.slice(0, limit);
}

/**
 * Get creative details for a specific ad.
 * Endpoint: GET /{ad_id}?fields=name,status,creative{...}
 */
export async function getAdCreativeInsights(adId: string): Promise<AdCreativeDetail> {
  if (!metaReady) throw new Error("Meta API not configured");

  const creativeFields = "title,body,link_url,image_url,call_to_action_type";

  const data = await graphGet<Record<string, any>>(
    `/${adId}`,
    {
      fields: `name,status,creative{${creativeFields}}`,
    }
  );

  return {
    adId: data.id,
    adName: data.name,
    status: data.status,
    creative: {
      title: data.creative?.title,
      body: data.creative?.body,
      linkUrl: data.creative?.link_url,
      imageUrl: data.creative?.image_url,
      callToAction: data.creative?.call_to_action_type,
    },
  };
}

// ============================================================
// FORMATTERS (Telegram-friendly output)
// ============================================================

export function formatAccountSummary(s: AccountSummary): string {
  const lines = [
    `Ad Account Summary (${s.dateRange.since} to ${s.dateRange.until})`,
    ``,
    `Spend: $${s.spend.toFixed(2)}`,
    `Impressions: ${s.impressions.toLocaleString()}`,
    `Reach: ${s.reach.toLocaleString()}`,
    `Frequency: ${s.frequency.toFixed(2)}`,
    ``,
    `Clicks: ${s.clicks.toLocaleString()}`,
    `CTR: ${s.ctr.toFixed(2)}%`,
    `CPC: $${s.cpc.toFixed(2)}`,
    `Link Clicks: ${s.linkClicks.toLocaleString()}`,
    `LP Views: ${s.landingPageViews.toLocaleString()}`,
    ``,
    `Conversions: ${s.conversions}`,
    `CPL: ${s.conversions > 0 ? "$" + s.cpl.toFixed(2) : "n/a"}`,
  ];

  // Add LP conversion rate if we have the data
  if (s.landingPageViews > 0 && s.conversions > 0) {
    const lpCvr = ((s.conversions / s.landingPageViews) * 100).toFixed(1);
    lines.push(`LP Conv Rate: ${lpCvr}%`);
  }

  return lines.join("\n");
}

export function formatCampaignBreakdown(campaigns: CampaignInsight[]): string {
  if (campaigns.length === 0) return "No campaign data for this period.";

  const lines = ["Campaign Breakdown", ""];

  for (const c of campaigns) {
    const statusIcon = c.status === "ACTIVE" ? "[ON]" : "[OFF]";
    lines.push(
      `${statusIcon} ${c.campaignName}`,
      `  Spend: $${c.spend.toFixed(2)} | Reach: ${c.reach.toLocaleString()}`,
      `  Clicks: ${c.clicks} (CTR ${c.ctr.toFixed(2)}%, CPC $${c.cpc.toFixed(2)})`,
      `  Conversions: ${c.conversions} | CPL: ${c.conversions > 0 ? "$" + c.cpl.toFixed(2) : "n/a"}`,
      ``
    );
  }

  return lines.join("\n").trim();
}

export function formatTopAds(ads: AdInsight[]): string {
  if (ads.length === 0) return "No ad data for this period.";

  const lines = [`Top ${ads.length} Ads by Performance`, ""];

  ads.forEach((ad, i) => {
    lines.push(
      `${i + 1}. ${ad.adName}`,
      `   Campaign: ${ad.campaignName}`,
      `   Spend: $${ad.spend.toFixed(2)} | Clicks: ${ad.clicks} | CTR: ${ad.ctr.toFixed(2)}%`,
      `   Conversions: ${ad.conversions} | CPL: ${ad.conversions > 0 ? "$" + ad.cpl.toFixed(2) : "n/a"}`,
      ``
    );
  });

  return lines.join("\n").trim();
}

export function formatAdCreative(c: AdCreativeDetail): string {
  const lines = [
    `Ad Creative: ${c.adName}`,
    `Status: ${c.status}`,
    ``,
  ];

  if (c.creative.title) lines.push(`Title: ${c.creative.title}`);
  if (c.creative.body) lines.push(`Body: ${c.creative.body}`);
  if (c.creative.callToAction) lines.push(`CTA: ${c.creative.callToAction}`);
  if (c.creative.linkUrl) lines.push(`Link: ${c.creative.linkUrl}`);

  return lines.join("\n");
}

export function formatSpendQuick(s: AccountSummary): string {
  const days = Math.max(1, Math.round(
    (new Date(s.dateRange.until).getTime() - new Date(s.dateRange.since).getTime()) / 86_400_000
  ) + 1);
  const dailyAvg = s.spend / days;

  return [
    `Spend: $${s.spend.toFixed(2)} (${s.dateRange.since} to ${s.dateRange.until})`,
    `Daily avg: $${dailyAvg.toFixed(2)}`,
    `Conversions: ${s.conversions} | CPL: ${s.conversions > 0 ? "$" + s.cpl.toFixed(2) : "n/a"}`,
  ].join("\n");
}
