/**
 * Atlas — GHL Social Planner Integration
 *
 * Schedule and manage social media posts through GHL's Social Planner API.
 * Posts default to "draft" status so Derek/Esther can review before publishing.
 *
 * Auth: Same PIT token as ghl.ts (requires socialplanner/* scopes).
 * API version: 2021-07-28
 */

import { info, warn, error as logError } from "./logger.ts";
import { ghlBreaker } from "./circuit-breaker.ts";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const GHL_TOKEN = process.env.GHL_API_TOKEN || "";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "";

// ============================================================
// TYPES
// ============================================================

export interface SocialAccount {
  id: string;
  name: string;
  platform: string;
  type: string;
  avatar?: string;
  isExpired: boolean;
  expire?: string;
}

export interface SocialPost {
  id: string;
  accountIds: string[];
  status: string;
  summary?: string;
  media?: SocialMedia[];
  scheduleDate?: string;
  createdAt?: string;
  type: string;
}

export interface SocialMedia {
  url: string;
  type?: string;
  caption?: string;
  thumbnail?: string;
  id?: string;
}

export interface CreatePostOptions {
  /** Post text content */
  summary: string;
  /** Account IDs to post to (from listSocialAccounts) */
  accountIds: string[];
  /** "post" | "story" | "reel" */
  type?: string;
  /** "draft" | "scheduled" | null (null = publish now) */
  status?: string | null;
  /** ISO date string for scheduled posts */
  scheduleDate?: string;
  /** Media attachments (must be publicly accessible URLs) */
  media?: SocialMedia[];
  /** GHL user ID (defaults to env) */
  userId?: string;
  /** First comment on the post */
  followUpComment?: string;
  /** GMB-specific post details */
  gmbPostDetails?: {
    gmbEventType?: string;
    title?: string;
    offerTitle?: string;
    startDate?: string;
    endDate?: string;
    url?: string;
    couponCode?: string;
    actionType?: string;
  };
}

// ============================================================
// FETCH HELPER (mirrors ghl.ts pattern)
// ============================================================

async function socialFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  if (!GHL_TOKEN) throw new Error("GHL_API_TOKEN not configured");

  const url = `${GHL_BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GHL_TOKEN}`,
      Version: GHL_VERSION,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GHL Social ${endpoint} returned ${res.status}: ${body.substring(0, 300)}`);
  }

  return res.json() as Promise<T>;
}

/** Social fetch with circuit breaker */
async function ghlSocialFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  return ghlBreaker.exec(() => socialFetch<T>(endpoint, options));
}

// ============================================================
// ACCOUNTS
// ============================================================

let cachedAccounts: SocialAccount[] | null = null;
let accountsCachedAt = 0;
const ACCOUNT_CACHE_TTL = 10 * 60 * 1000; // 10 min

/**
 * List all connected social media accounts in GHL Social Planner.
 * Returns account IDs needed for creating posts.
 */
export async function listSocialAccounts(forceRefresh = false): Promise<SocialAccount[]> {
  if (!forceRefresh && cachedAccounts && Date.now() - accountsCachedAt < ACCOUNT_CACHE_TTL) {
    return cachedAccounts;
  }

  try {
    const res = await ghlSocialFetch<{ accounts?: SocialAccount[]; groups?: unknown[] }>(
      `/social-media-posting/${GHL_LOCATION_ID}/accounts`
    );
    cachedAccounts = (res.accounts || []).map((a) => ({
      id: a.id,
      name: a.name,
      platform: a.platform,
      type: a.type,
      avatar: a.avatar,
      isExpired: a.isExpired ?? false,
      expire: a.expire,
    }));
    accountsCachedAt = Date.now();
    info("ghl-social", `Found ${cachedAccounts.length} connected accounts`);
    return cachedAccounts;
  } catch (err) {
    logError("ghl-social", `Failed to list accounts: ${err}`);
    throw err;
  }
}

/**
 * Get account IDs for specific platforms.
 * @param platforms - e.g. ["facebook", "instagram", "google"]
 * @returns Array of account IDs matching those platforms (non-expired only)
 */
export async function getAccountsByPlatform(platforms: string[]): Promise<SocialAccount[]> {
  const accounts = await listSocialAccounts();
  const normalized = platforms.map((p) => p.toLowerCase());
  return accounts.filter(
    (a) => normalized.includes(a.platform.toLowerCase()) && !a.isExpired
  );
}

// ============================================================
// POSTS
// ============================================================

/**
 * Create a social media post in GHL Social Planner.
 * Defaults to "draft" status for review before publishing.
 */
export async function createSocialPost(opts: CreatePostOptions): Promise<SocialPost> {
  const userId = opts.userId || process.env.GHL_USER_ID || "";

  const payload: Record<string, unknown> = {
    type: opts.type || "post",
    accountIds: opts.accountIds,
    userId,
    summary: opts.summary,
    status: opts.status ?? "draft", // default to draft
  };

  if (opts.scheduleDate) payload.scheduleDate = opts.scheduleDate;
  if (opts.media && opts.media.length > 0) payload.media = opts.media;
  if (opts.followUpComment) payload.followUpComment = opts.followUpComment;
  if (opts.gmbPostDetails) payload.gmbPostDetails = opts.gmbPostDetails;

  try {
    const res = await ghlSocialFetch<{ post?: SocialPost }>(
      `/social-media-posting/${GHL_LOCATION_ID}/posts`,
      { method: "POST", body: JSON.stringify(payload) }
    );

    const post = res.post;
    if (!post) throw new Error("No post returned from API");

    info("ghl-social", `Created ${opts.status ?? "draft"} post ${post.id} to ${opts.accountIds.length} accounts`);
    return post;
  } catch (err) {
    logError("ghl-social", `Failed to create post: ${err}`);
    throw err;
  }
}

/**
 * List posts with optional status filter.
 */
export async function listSocialPosts(opts?: {
  status?: string;
  limit?: number;
  accounts?: string[];
}): Promise<SocialPost[]> {
  const body: Record<string, unknown> = {};
  if (opts?.status) body.status = opts.status;
  if (opts?.limit) body.limit = opts.limit;
  if (opts?.accounts) body.accounts = opts.accounts;

  try {
    const res = await ghlSocialFetch<{ posts?: SocialPost[] }>(
      `/social-media-posting/${GHL_LOCATION_ID}/posts/list`,
      { method: "POST", body: JSON.stringify(body) }
    );
    return res.posts || [];
  } catch (err) {
    logError("ghl-social", `Failed to list posts: ${err}`);
    return [];
  }
}

/**
 * Get a single post by ID.
 */
export async function getSocialPost(postId: string): Promise<SocialPost | null> {
  try {
    return await ghlSocialFetch<SocialPost>(
      `/social-media-posting/${GHL_LOCATION_ID}/posts/${postId}`
    );
  } catch (err) {
    logError("ghl-social", `Failed to get post ${postId}: ${err}`);
    return null;
  }
}

/**
 * Update an existing post (e.g., change from draft to scheduled).
 */
export async function updateSocialPost(
  postId: string,
  updates: Partial<CreatePostOptions>
): Promise<SocialPost | null> {
  try {
    const res = await ghlSocialFetch<{ post?: SocialPost }>(
      `/social-media-posting/${GHL_LOCATION_ID}/posts/${postId}`,
      { method: "PUT", body: JSON.stringify(updates) }
    );
    info("ghl-social", `Updated post ${postId}`);
    return res.post || null;
  } catch (err) {
    logError("ghl-social", `Failed to update post ${postId}: ${err}`);
    return null;
  }
}

/**
 * Publish a draft post (changes status from draft to scheduled or immediate).
 */
export async function publishDraft(
  postId: string,
  scheduleDate?: string
): Promise<SocialPost | null> {
  const updates: Record<string, unknown> = {
    status: scheduleDate ? "scheduled" : null, // null = publish now
  };
  if (scheduleDate) updates.scheduleDate = scheduleDate;

  return updateSocialPost(postId, updates as Partial<CreatePostOptions>);
}

// ============================================================
// MEDIA UPLOAD
// ============================================================

export interface UploadedMedia {
  fileId: string;
  url: string;
}

/**
 * Upload a local image file to GHL's media library.
 * Returns the public CDN URL that can be used in social posts.
 */
export async function uploadMedia(filePath: string, name?: string): Promise<UploadedMedia> {
  if (!GHL_TOKEN) throw new Error("GHL_API_TOKEN not configured");

  const file = Bun.file(filePath);
  if (!(await file.exists())) throw new Error(`File not found: ${filePath}`);

  const formData = new FormData();
  formData.append("file", file);
  formData.append("hosted", "false");
  formData.append(
    "fileProcessingOptions",
    JSON.stringify({
      altId: GHL_LOCATION_ID,
      altType: "location",
      name: name || filePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") || "atlas-upload",
    })
  );

  const res = await fetch(`${GHL_BASE_URL}/medias/upload-file`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GHL_TOKEN}`,
      Version: GHL_VERSION,
    },
    body: formData,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GHL media upload failed ${res.status}: ${body.substring(0, 200)}`);
  }

  const data = (await res.json()) as { fileId: string; url: string };
  info("ghl-social", `Uploaded media: ${data.url} (id: ${data.fileId})`);
  return { fileId: data.fileId, url: data.url };
}

/**
 * Upload and immediately get a SocialMedia object ready for post creation.
 */
export async function uploadForPost(filePath: string, name?: string): Promise<SocialMedia> {
  const { url } = await uploadMedia(filePath, name);
  const ext = filePath.toLowerCase().split(".").pop() || "";
  const isVideo = ["mp4", "mov", "avi", "webm"].includes(ext);
  return {
    url,
    type: isVideo ? "video/mp4" : `image/${ext === "jpg" ? "jpeg" : ext || "png"}`,
  };
}

// ============================================================
// CONVENIENCE: Multi-platform draft
// ============================================================

/**
 * Create a draft post across all connected, non-expired accounts for given platforms.
 * Returns the created post or null if no matching accounts found.
 */
export async function draftToAllPlatforms(
  summary: string,
  platforms: string[] = ["facebook", "instagram", "google"],
  media?: SocialMedia[]
): Promise<SocialPost | null> {
  const accounts = await getAccountsByPlatform(platforms);
  if (accounts.length === 0) {
    warn("ghl-social", `No connected accounts for platforms: ${platforms.join(", ")}`);
    return null;
  }

  const accountIds = accounts.map((a) => a.id);
  info("ghl-social", `Drafting to ${accounts.map((a) => `${a.platform}:${a.name}`).join(", ")}`);

  return createSocialPost({
    summary,
    accountIds,
    status: "draft",
    media,
  });
}

// ============================================================
// FORMAT HELPERS
// ============================================================

/** Format account list for Telegram display */
export function formatAccountList(accounts: SocialAccount[]): string {
  if (accounts.length === 0) return "No connected social accounts found.";

  const lines = accounts.map((a) => {
    const status = a.isExpired ? " (EXPIRED)" : "";
    return `- **${a.platform}**: ${a.name}${status}`;
  });
  return `**Connected Social Accounts (${accounts.length}):**\n${lines.join("\n")}`;
}

/** Format post for Telegram display */
export function formatPost(post: SocialPost): string {
  const status = post.status || "immediate";
  const date = post.scheduleDate ? ` | ${new Date(post.scheduleDate).toLocaleString()}` : "";
  const preview = post.summary ? `\n${post.summary.substring(0, 100)}...` : "";
  return `[${status}${date}] ${post.type}${preview}`;
}

// ============================================================
// INIT CHECK
// ============================================================

export function isSocialReady(): boolean {
  return !!GHL_TOKEN && !!GHL_LOCATION_ID;
}

export async function initSocial(): Promise<void> {
  if (!isSocialReady()) {
    warn("ghl-social", "GHL Social Planner not configured (missing token or location ID)");
    return;
  }
  try {
    const accounts = await listSocialAccounts();
    info("ghl-social", `Social Planner ready: ${accounts.length} connected accounts`);
    for (const a of accounts) {
      info("ghl-social", `  ${a.platform}: ${a.name}${a.isExpired ? " (EXPIRED)" : ""}`);
    }
  } catch (err) {
    warn("ghl-social", `Social Planner init failed (may need socialplanner scopes on PIT token): ${err}`);
  }
}
