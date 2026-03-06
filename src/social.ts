/**
 * Atlas — Unified Social Media Posting
 *
 * Platform-agnostic posting interface with per-platform adapters.
 * Supports: Pinterest, Instagram, Facebook, TikTok.
 *
 * Each platform adapter handles auth, image upload, and post creation
 * according to that platform's API requirements.
 */

import { info, warn, error as logError } from "./logger.ts";
import { getBreaker } from "./circuit-breaker.ts";

// ============================================================
// CONFIG
// ============================================================

// Pinterest
const PINTEREST_TOKEN = process.env.PINTEREST_ACCESS_TOKEN || "";
const PINTEREST_BOARD_ID = process.env.PINTEREST_BOARD_ID || "";
const PINTEREST_API = "https://api.pinterest.com/v5";

// Meta (Instagram + Facebook) -- separate from PV's Meta integration
const META_TOX_PAGE_TOKEN = process.env.META_TOX_PAGE_TOKEN || "";
const META_TOX_IG_USER_ID = process.env.META_TOX_IG_USER_ID || "";
const META_TOX_PAGE_ID = process.env.META_TOX_PAGE_ID || "";
const META_GRAPH_API = "https://graph.facebook.com/v19.0";

// TikTok
const TIKTOK_TOKEN = process.env.TIKTOK_ACCESS_TOKEN || "";
const TIKTOK_API = "https://open.tiktokapis.com/v2";

// Circuit breakers
const pinterestBreaker = getBreaker("Pinterest", {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  requestTimeoutMs: 20_000,
});

const metaToxBreaker = getBreaker("MetaTox", {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  requestTimeoutMs: 25_000,
});

const tiktokBreaker = getBreaker("TikTok", {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  requestTimeoutMs: 30_000,
});

// ============================================================
// TYPES
// ============================================================

export type Platform = "pinterest" | "instagram" | "facebook" | "tiktok";

export interface SocialPost {
  platform: Platform;
  content: string;
  imageUrl?: string;
  videoUrl?: string;
  link?: string;
  hashtags?: string[];
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface PostResult {
  externalId: string;
  url: string;
  platform: Platform;
}

export interface PostAnalytics {
  impressions: number;
  reach: number;
  engagement: number;
  clicks: number;
  saves: number;
}

// ============================================================
// INIT
// ============================================================

export function isSocialReady(platform?: Platform): boolean {
  if (platform) {
    switch (platform) {
      case "pinterest":
        return !!PINTEREST_TOKEN && !!PINTEREST_BOARD_ID;
      case "instagram":
        return !!META_TOX_PAGE_TOKEN && !!META_TOX_IG_USER_ID;
      case "facebook":
        return !!META_TOX_PAGE_TOKEN && !!META_TOX_PAGE_ID;
      case "tiktok":
        return !!TIKTOK_TOKEN;
    }
  }
  // At least one platform configured
  return (
    (!!PINTEREST_TOKEN && !!PINTEREST_BOARD_ID) ||
    (!!META_TOX_PAGE_TOKEN && (!!META_TOX_IG_USER_ID || !!META_TOX_PAGE_ID)) ||
    !!TIKTOK_TOKEN
  );
}

export function initSocial(): boolean {
  const platforms: string[] = [];
  if (PINTEREST_TOKEN && PINTEREST_BOARD_ID) platforms.push("Pinterest");
  if (META_TOX_PAGE_TOKEN && META_TOX_IG_USER_ID) platforms.push("Instagram");
  if (META_TOX_PAGE_TOKEN && META_TOX_PAGE_ID) platforms.push("Facebook");
  if (TIKTOK_TOKEN) platforms.push("TikTok");

  if (platforms.length === 0) {
    return false;
  }

  info("social", `Social posting ready: ${platforms.join(", ")}`);
  return true;
}

// ============================================================
// PINTEREST ADAPTER
// ============================================================

async function pinterestFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  return pinterestBreaker.exec(async () => {
    const res = await fetch(`${PINTEREST_API}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${PINTEREST_TOKEN}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Pinterest ${endpoint} returned ${res.status}: ${body.substring(0, 200)}`);
    }
    return res.json() as Promise<T>;
  });
}

async function postToPinterest(post: SocialPost): Promise<PostResult> {
  if (!PINTEREST_TOKEN || !PINTEREST_BOARD_ID) {
    throw new Error("Pinterest not configured (missing token or board ID)");
  }

  const pinData: Record<string, unknown> = {
    board_id: PINTEREST_BOARD_ID,
    title: post.title || post.content.substring(0, 100),
    description: post.content,
    alt_text: post.title || "Tox Tray product",
  };

  if (post.link) {
    pinData.link = post.link;
  }

  if (post.imageUrl) {
    pinData.media_source = {
      source_type: "url",
      url: post.imageUrl,
    };
  }

  const result = await pinterestFetch<{ id: string }>("/pins", {
    method: "POST",
    body: JSON.stringify(pinData),
  });

  info("social", `Pinterest pin created: ${result.id}`);
  return {
    externalId: result.id,
    url: `https://www.pinterest.com/pin/${result.id}/`,
    platform: "pinterest",
  };
}

async function getPinterestAnalytics(pinId: string): Promise<PostAnalytics> {
  try {
    const data = await pinterestFetch<{
      all: { lifetime_metrics: { impression: number; save: number; pin_click: number; outbound_click: number } };
    }>(`/pins/${pinId}/analytics?start_date=2020-01-01&end_date=2030-01-01&metric_types=IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK`);

    const m = data.all?.lifetime_metrics || {};
    return {
      impressions: m.impression || 0,
      reach: 0,
      engagement: (m.save || 0) + (m.pin_click || 0),
      clicks: m.outbound_click || 0,
      saves: m.save || 0,
    };
  } catch (err) {
    warn("social", `Pinterest analytics failed for pin ${pinId}: ${err}`);
    return { impressions: 0, reach: 0, engagement: 0, clicks: 0, saves: 0 };
  }
}

// ============================================================
// INSTAGRAM ADAPTER (Meta Graph API)
// ============================================================

async function metaFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  return metaToxBreaker.exec(async () => {
    const url = endpoint.startsWith("http") ? endpoint : `${META_GRAPH_API}${endpoint}`;
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = `${url}${sep}access_token=${META_TOX_PAGE_TOKEN}`;

    const res = await fetch(fullUrl, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Meta API ${endpoint} returned ${res.status}: ${body.substring(0, 200)}`);
    }
    return res.json() as Promise<T>;
  });
}

async function postToInstagram(post: SocialPost): Promise<PostResult> {
  if (!META_TOX_PAGE_TOKEN || !META_TOX_IG_USER_ID) {
    throw new Error("Instagram not configured (missing page token or IG user ID)");
  }

  if (!post.imageUrl) {
    throw new Error("Instagram posts require an image URL");
  }

  // Step 1: Create media container
  const caption = post.hashtags?.length
    ? `${post.content}\n\n${post.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`
    : post.content;

  const container = await metaFetch<{ id: string }>(`/${META_TOX_IG_USER_ID}/media`, {
    method: "POST",
    body: JSON.stringify({
      image_url: post.imageUrl,
      caption,
    }),
  });

  // Step 2: Wait for processing
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Step 3: Publish
  const published = await metaFetch<{ id: string }>(`/${META_TOX_IG_USER_ID}/media_publish`, {
    method: "POST",
    body: JSON.stringify({
      creation_id: container.id,
    }),
  });

  info("social", `Instagram post published: ${published.id}`);
  return {
    externalId: published.id,
    url: `https://www.instagram.com/p/${published.id}/`,
    platform: "instagram",
  };
}

async function getInstagramAnalytics(mediaId: string): Promise<PostAnalytics> {
  try {
    const data = await metaFetch<{
      data: Array<{ name: string; values: Array<{ value: number }> }>;
    }>(`/${mediaId}/insights?metric=impressions,reach,engagement,saved`);

    const metrics: Record<string, number> = {};
    for (const m of data.data || []) {
      metrics[m.name] = m.values?.[0]?.value || 0;
    }

    return {
      impressions: metrics.impressions || 0,
      reach: metrics.reach || 0,
      engagement: metrics.engagement || 0,
      clicks: 0,
      saves: metrics.saved || 0,
    };
  } catch (err) {
    warn("social", `Instagram analytics failed for ${mediaId}: ${err}`);
    return { impressions: 0, reach: 0, engagement: 0, clicks: 0, saves: 0 };
  }
}

// ============================================================
// FACEBOOK ADAPTER (Meta Graph API)
// ============================================================

async function postToFacebook(post: SocialPost): Promise<PostResult> {
  if (!META_TOX_PAGE_TOKEN || !META_TOX_PAGE_ID) {
    throw new Error("Facebook not configured (missing page token or page ID)");
  }

  let result: { id: string; post_id?: string };

  if (post.imageUrl) {
    // Photo post
    result = await metaFetch<{ id: string; post_id?: string }>(`/${META_TOX_PAGE_ID}/photos`, {
      method: "POST",
      body: JSON.stringify({
        url: post.imageUrl,
        message: post.content,
      }),
    });
  } else {
    // Text/link post
    const body: Record<string, string> = { message: post.content };
    if (post.link) body.link = post.link;

    result = await metaFetch<{ id: string }>(`/${META_TOX_PAGE_ID}/feed`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  const postId = result.post_id || result.id;
  info("social", `Facebook post created: ${postId}`);
  return {
    externalId: postId,
    url: `https://www.facebook.com/${postId}`,
    platform: "facebook",
  };
}

async function getFacebookAnalytics(postId: string): Promise<PostAnalytics> {
  try {
    const data = await metaFetch<{
      data: Array<{ name: string; values: Array<{ value: number | Record<string, number> }> }>;
    }>(`/${postId}/insights?metric=post_impressions,post_engaged_users,post_clicks`);

    const metrics: Record<string, number> = {};
    for (const m of data.data || []) {
      const val = m.values?.[0]?.value;
      metrics[m.name] = typeof val === "number" ? val : 0;
    }

    return {
      impressions: metrics.post_impressions || 0,
      reach: 0,
      engagement: metrics.post_engaged_users || 0,
      clicks: metrics.post_clicks || 0,
      saves: 0,
    };
  } catch (err) {
    warn("social", `Facebook analytics failed for ${postId}: ${err}`);
    return { impressions: 0, reach: 0, engagement: 0, clicks: 0, saves: 0 };
  }
}

// ============================================================
// TIKTOK ADAPTER (skeleton -- most complex, implemented last)
// ============================================================

async function postToTikTok(post: SocialPost): Promise<PostResult> {
  if (!TIKTOK_TOKEN) {
    throw new Error("TikTok not configured (missing access token)");
  }

  if (!post.videoUrl) {
    throw new Error("TikTok posts require a video URL");
  }

  // TikTok Content Posting API: initialize upload from URL
  const initRes = await tiktokBreaker.exec(async () => {
    const res = await fetch(`${TIKTOK_API}/post/publish/video/init/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TIKTOK_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        post_info: {
          title: post.content.substring(0, 150),
          privacy_level: "PUBLIC_TO_EVERYONE",
          disable_comment: false,
          auto_add_music: true,
        },
        source_info: {
          source: "PULL_FROM_URL",
          video_url: post.videoUrl,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`TikTok init returned ${res.status}: ${body.substring(0, 200)}`);
    }
    return res.json() as Promise<{ data: { publish_id: string } }>;
  });

  const publishId = initRes.data.publish_id;
  info("social", `TikTok video upload initiated: ${publishId}`);

  // TikTok processing is async. publish_id can be checked later.
  return {
    externalId: publishId,
    url: `https://www.tiktok.com/@user/video/${publishId}`,
    platform: "tiktok",
  };
}

async function getTikTokAnalytics(_videoId: string): Promise<PostAnalytics> {
  warn("social", "TikTok analytics not yet implemented");
  return { impressions: 0, reach: 0, engagement: 0, clicks: 0, saves: 0 };
}

// ============================================================
// UNIFIED API
// ============================================================

/**
 * Publish a post to the specified platform.
 */
export async function publishPost(post: SocialPost): Promise<PostResult> {
  info("social", `Publishing to ${post.platform}: "${post.content.substring(0, 50)}..."`);

  switch (post.platform) {
    case "pinterest":
      return postToPinterest(post);
    case "instagram":
      return postToInstagram(post);
    case "facebook":
      return postToFacebook(post);
    case "tiktok":
      return postToTikTok(post);
    default:
      throw new Error(`Unknown platform: ${post.platform}`);
  }
}

/**
 * Delete a post from the specified platform.
 */
export async function deletePost(platform: Platform, externalId: string): Promise<void> {
  info("social", `Deleting ${platform} post: ${externalId}`);

  switch (platform) {
    case "pinterest":
      await pinterestFetch(`/pins/${externalId}`, { method: "DELETE" });
      break;
    case "instagram":
    case "facebook":
      await metaFetch(`/${externalId}`, { method: "DELETE" });
      break;
    case "tiktok":
      warn("social", "TikTok post deletion not yet implemented");
      break;
  }
}

/**
 * Get analytics for a specific post.
 */
export async function getPostAnalytics(platform: Platform, externalId: string): Promise<PostAnalytics> {
  switch (platform) {
    case "pinterest":
      return getPinterestAnalytics(externalId);
    case "instagram":
      return getInstagramAnalytics(externalId);
    case "facebook":
      return getFacebookAnalytics(externalId);
    case "tiktok":
      return getTikTokAnalytics(externalId);
    default:
      return { impressions: 0, reach: 0, engagement: 0, clicks: 0, saves: 0 };
  }
}

/**
 * Get list of configured platforms.
 */
export function getConfiguredPlatforms(): Platform[] {
  const platforms: Platform[] = [];
  if (PINTEREST_TOKEN && PINTEREST_BOARD_ID) platforms.push("pinterest");
  if (META_TOX_PAGE_TOKEN && META_TOX_IG_USER_ID) platforms.push("instagram");
  if (META_TOX_PAGE_TOKEN && META_TOX_PAGE_ID) platforms.push("facebook");
  if (TIKTOK_TOKEN) platforms.push("tiktok");
  return platforms;
}

// ============================================================
// TAG PROCESSING
// ============================================================

/**
 * Process social posting tags from Claude responses.
 *
 * [POST_PIN: title | description | image_url | link]
 * [POST_IG: caption | image_url | hashtags]
 * [POST_FB: text | image_url | link]
 * [POST_TT: caption | video_url | hashtags]
 */
export async function processSocialIntents(response: string): Promise<string> {
  let clean = response;

  // Pinterest: [POST_PIN: title | description | image_url | link]
  for (const match of response.matchAll(/\[POST_PIN:\s*([\s\S]+?)\]/gi)) {
    const parts = match[1].split("|").map((s) => s.trim());
    if (parts.length < 2) {
      warn("social", `POST_PIN missing parameters: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    try {
      const result = await publishPost({
        platform: "pinterest",
        title: parts[0],
        content: parts[1],
        imageUrl: parts[2] || undefined,
        link: parts[3] || undefined,
      });
      info("social", `POST_PIN success: ${result.url}`);
    } catch (err) {
      logError("social", `POST_PIN failed: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  // Instagram: [POST_IG: caption | image_url | hashtags]
  for (const match of response.matchAll(/\[POST_IG:\s*([\s\S]+?)\]/gi)) {
    const parts = match[1].split("|").map((s) => s.trim());
    if (parts.length < 2) {
      warn("social", `POST_IG missing parameters: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    try {
      const hashtags = parts[2] ? parts[2].split(/[,\s]+/).filter(Boolean) : [];
      const result = await publishPost({
        platform: "instagram",
        content: parts[0],
        imageUrl: parts[1],
        hashtags,
      });
      info("social", `POST_IG success: ${result.url}`);
    } catch (err) {
      logError("social", `POST_IG failed: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  // Facebook: [POST_FB: text | image_url | link]
  for (const match of response.matchAll(/\[POST_FB:\s*([\s\S]+?)\]/gi)) {
    const parts = match[1].split("|").map((s) => s.trim());
    if (parts.length < 1) {
      clean = clean.replace(match[0], "");
      continue;
    }

    try {
      const result = await publishPost({
        platform: "facebook",
        content: parts[0],
        imageUrl: parts[1] || undefined,
        link: parts[2] || undefined,
      });
      info("social", `POST_FB success: ${result.url}`);
    } catch (err) {
      logError("social", `POST_FB failed: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  // TikTok: [POST_TT: caption | video_url | hashtags]
  for (const match of response.matchAll(/\[POST_TT:\s*([\s\S]+?)\]/gi)) {
    const parts = match[1].split("|").map((s) => s.trim());
    if (parts.length < 2) {
      warn("social", `POST_TT missing parameters: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    try {
      const hashtags = parts[2] ? parts[2].split(/[,\s]+/).filter(Boolean) : [];
      const result = await publishPost({
        platform: "tiktok",
        content: parts[0],
        videoUrl: parts[1],
        hashtags,
      });
      info("social", `POST_TT success: ${result.url}`);
    } catch (err) {
      logError("social", `POST_TT failed: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  return clean;
}

// ============================================================
// CONTEXT
// ============================================================

/**
 * Lightweight context for buildPrompt().
 */
export async function getSocialContext(): Promise<string> {
  const platforms = getConfiguredPlatforms();
  if (platforms.length === 0) return "";

  const lines = [
    `SOCIAL PLATFORMS: ${platforms.join(", ")}`,
    "",
    "Post tags:",
  ];

  if (platforms.includes("pinterest")) {
    lines.push("  [POST_PIN: title | description | image_url | link]");
  }
  if (platforms.includes("instagram")) {
    lines.push("  [POST_IG: caption | image_url | hashtags]");
  }
  if (platforms.includes("facebook")) {
    lines.push("  [POST_FB: text | image_url | link]");
  }
  if (platforms.includes("tiktok")) {
    lines.push("  [POST_TT: caption | video_url | hashtags]");
  }

  return lines.join("\n");
}
