/**
 * Atlas — Canva Connect API Integration
 *
 * Pulls product designs from Canva for social media posting.
 * Auth: OAuth 2.0 (user-delegated, no service accounts).
 * API: https://api.canva.com/rest/v1/
 *
 * Supports: design listing, folder browsing, async PNG/JPG export.
 */

import { info, warn, error as logError } from "./logger.ts";
import { getBreaker } from "./circuit-breaker.ts";

// ============================================================
// CONFIG
// ============================================================

const CANVA_API = "https://api.canva.com/rest/v1";
const CANVA_CLIENT_ID = process.env.CANVA_CLIENT_ID || "";
const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET || "";
const CANVA_REDIRECT_URI = process.env.CANVA_REDIRECT_URI || "http://127.0.0.1:3001/callback";
const CANVA_FOLDER_ID = process.env.CANVA_FOLDER_ID || "";

let accessToken = process.env.CANVA_ACCESS_TOKEN || "";
let refreshToken = process.env.CANVA_REFRESH_TOKEN || "";

const canvaBreaker = getBreaker("Canva", {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  requestTimeoutMs: 20_000,
});

// ============================================================
// TYPES
// ============================================================

export interface CanvaDesign {
  id: string;
  title: string;
  thumbnail?: { url: string; width: number; height: number };
  urls?: { editUrl: string; viewUrl: string };
  created_at?: string;
  updated_at?: string;
}

interface CanvaExportJob {
  job: { id: string; status: string };
}

interface CanvaExportResult {
  job: {
    id: string;
    status: "in_progress" | "success" | "failed";
    result?: { urls: Array<{ url: string; page: number }> };
    error?: { code: string; message: string };
  };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

// ============================================================
// INIT
// ============================================================

export function isCanvaReady(): boolean {
  return !!accessToken && !!CANVA_CLIENT_ID;
}

export function initCanva(): boolean {
  if (!CANVA_CLIENT_ID) {
    return false;
  }
  if (!accessToken) {
    warn("canva", "Canva client configured but no access token. Run OAuth flow first.");
    return false;
  }
  info("canva", `Canva integration ready (folder: ${CANVA_FOLDER_ID || "all"})`);
  return true;
}

// ============================================================
// OAUTH (PKCE required by Canva)
// ============================================================

/** Store the code verifier for the current OAuth flow */
let pendingCodeVerifier = "";

/**
 * Generate a cryptographically random code verifier for PKCE.
 */
function generateCodeVerifier(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/**
 * Derive the S256 code challenge from a code verifier.
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generate the OAuth authorization URL with PKCE.
 * Redirect user here to grant access.
 */
export async function getCanvaAuthUrl(state: string): Promise<string> {
  const scopes = "design:content:read design:content:write design:permission:read design:permission:write asset:read asset:write folder:read folder:write folder:permission:read folder:permission:write comment:read comment:write app:read app:write";
  pendingCodeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(pendingCodeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CANVA_CLIENT_ID,
    redirect_uri: CANVA_REDIRECT_URI,
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://www.canva.com/api/oauth/authorize?${params}`;
}

/** Get the pending code verifier (for setup script). */
export function getCodeVerifier(): string {
  return pendingCodeVerifier;
}

/** Set the code verifier (for setup script resuming). */
export function setCodeVerifier(v: string): void {
  pendingCodeVerifier = v;
}

/**
 * Exchange authorization code for access + refresh tokens (with PKCE).
 */
export async function exchangeCanvaCode(code: string, codeVerifier?: string): Promise<TokenResponse> {
  const verifier = codeVerifier || pendingCodeVerifier;
  if (!verifier) throw new Error("No code verifier available. Did getCanvaAuthUrl() run first?");

  const res = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${CANVA_CLIENT_ID}:${CANVA_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CANVA_REDIRECT_URI,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Canva token exchange failed (${res.status}): ${body.substring(0, 200)}`);
  }

  const tokens = (await res.json()) as TokenResponse;
  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token;
  pendingCodeVerifier = "";
  info("canva", "OAuth tokens obtained successfully");
  return tokens;
}

/**
 * Refresh the access token using the refresh token.
 */
export async function refreshCanvaToken(): Promise<string> {
  if (!refreshToken) throw new Error("No Canva refresh token available");

  const res = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${CANVA_CLIENT_ID}:${CANVA_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Canva token refresh failed (${res.status}): ${body.substring(0, 200)}`);
  }

  const tokens = (await res.json()) as TokenResponse;
  accessToken = tokens.access_token;
  if (tokens.refresh_token) refreshToken = tokens.refresh_token;
  info("canva", "Access token refreshed");
  return accessToken;
}

// ============================================================
// FETCH HELPER
// ============================================================

async function canvaFetchRaw<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  if (!accessToken) throw new Error("Canva access token not configured");

  const url = endpoint.startsWith("http") ? endpoint : `${CANVA_API}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });

  // Auto-refresh on 401
  if (res.status === 401 && refreshToken) {
    warn("canva", "Access token expired, refreshing...");
    await refreshCanvaToken();
    const retryRes = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!retryRes.ok) {
      const body = await retryRes.text().catch(() => "");
      throw new Error(`Canva ${endpoint} returned ${retryRes.status} after refresh: ${body.substring(0, 200)}`);
    }
    return retryRes.json() as Promise<T>;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Canva ${endpoint} returned ${res.status}: ${body.substring(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

async function canvaFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  return canvaBreaker.exec(() => canvaFetchRaw<T>(endpoint, options));
}

// ============================================================
// DESIGNS
// ============================================================

/**
 * List designs from the user's Canva account.
 * Optionally filter by search query.
 */
export async function listDesigns(query?: string, limit = 50): Promise<CanvaDesign[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set("query", query);

  const data = await canvaFetch<{ items: CanvaDesign[]; continuation?: string }>(`/designs?${params}`);
  return data.items || [];
}

/**
 * List designs within a specific Canva folder.
 */
export async function listFolderDesigns(folderId?: string): Promise<CanvaDesign[]> {
  const id = folderId || CANVA_FOLDER_ID;
  if (!id) {
    warn("canva", "No folder ID specified, listing all designs");
    return listDesigns();
  }

  const data = await canvaFetch<{ items: Array<{ type: string; design?: CanvaDesign }> }>(
    `/folders/${id}/items?item_types=design`,
  );

  return (data.items || [])
    .filter((item) => item.type === "design" && item.design)
    .map((item) => item.design!);
}

/**
 * Get details for a specific design.
 */
export async function getDesign(designId: string): Promise<CanvaDesign> {
  const data = await canvaFetch<{ design: CanvaDesign }>(`/designs/${designId}`);
  return data.design;
}

// ============================================================
// EXPORT (async job pattern)
// ============================================================

/**
 * Export a design as PNG or JPG. Returns the download URL.
 * This is an async operation: creates job, polls until complete.
 *
 * @param designId - The Canva design ID
 * @param format - Export format (png or jpg)
 * @param maxPollMs - Maximum time to wait for export (default 60s)
 * @returns Download URL (valid for 24 hours)
 */
export async function exportDesign(
  designId: string,
  format: "png" | "jpg" = "png",
  maxPollMs = 60_000,
): Promise<string> {
  // 1. Create export job
  const exportType = format === "jpg" ? "jpg" : "png";
  const job = await canvaFetch<CanvaExportJob>("/exports", {
    method: "POST",
    body: JSON.stringify({
      design_id: designId,
      format: { type: exportType },
    }),
  });

  const jobId = job.job.id;
  info("canva", `Export job created: ${jobId} (design: ${designId}, format: ${format})`);

  // 2. Poll for completion with exponential backoff
  const startMs = Date.now();
  let delayMs = 2000;

  while (Date.now() - startMs < maxPollMs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const result = await canvaFetch<CanvaExportResult>(`/exports/${jobId}`);

    if (result.job.status === "success" && result.job.result?.urls?.length) {
      const url = result.job.result.urls[0].url;
      info("canva", `Export complete: ${designId} -> ${url.substring(0, 80)}...`);
      return url;
    }

    if (result.job.status === "failed") {
      const errMsg = result.job.error?.message || "Unknown export error";
      throw new Error(`Canva export failed for ${designId}: ${errMsg}`);
    }

    // Exponential backoff: 2s, 4s, 8s, 16s, cap at 16s
    delayMs = Math.min(delayMs * 2, 16_000);
  }

  throw new Error(`Canva export timed out after ${maxPollMs / 1000}s for design ${designId}`);
}

// ============================================================
// TAG PROCESSING
// ============================================================

/**
 * Process [CANVA_EXPORT: designId | format=png] tags from Claude responses.
 */
export async function processCanvaIntents(response: string): Promise<string> {
  let clean = response;

  for (const match of response.matchAll(/\[CANVA_EXPORT:\s*([\s\S]+?)\]/gi)) {
    const inner = match[1];
    const pipeIdx = inner.indexOf("|");
    const designId = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim();
    const rest = pipeIdx === -1 ? "" : inner.slice(pipeIdx + 1).trim();

    // Parse optional format=png/jpg
    const formatMatch = rest.match(/format\s*=\s*(png|jpg)/i);
    const format = (formatMatch?.[1]?.toLowerCase() as "png" | "jpg") || "png";

    try {
      const url = await exportDesign(designId, format);
      info("canva", `CANVA_EXPORT tag processed: ${designId} -> ${format}`);
      // Replace tag with the URL so downstream can use it
      clean = clean.replace(match[0], url);
    } catch (err) {
      logError("canva", `CANVA_EXPORT failed for ${designId}: ${err}`);
      clean = clean.replace(match[0], "");
    }
  }

  return clean;
}

// ============================================================
// CONTEXT
// ============================================================

/**
 * Lightweight context for buildPrompt().
 * Lists available designs in the configured folder.
 */
export async function getCanvaContext(): Promise<string> {
  if (!isCanvaReady()) return "";

  try {
    const designs = await listFolderDesigns();
    if (designs.length === 0) return "Canva: connected, no designs in folder.";

    const designList = designs
      .slice(0, 10)
      .map((d) => `  - "${d.title}" (id: ${d.id})`)
      .join("\n");

    return [
      `CANVA DESIGNS (${designs.length} total):`,
      designList,
      designs.length > 10 ? `  ... and ${designs.length - 10} more` : "",
      "",
      "Export a design: [CANVA_EXPORT: designId | format=png]",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (err) {
    warn("canva", `Context fetch failed: ${err}`);
    return "";
  }
}
