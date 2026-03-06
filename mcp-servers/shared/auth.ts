/**
 * MCP Shared -- OAuth2 Token Management
 *
 * Manages OAuth2 token refresh for Google, GBP, and GA4 APIs.
 * In-memory cache with auto-refresh 5 minutes before expiry.
 * Each service gets its own token lifecycle.
 */

import { log, error as logError } from "./logger.js";

// ============================================================
// TYPES
// ============================================================

export interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// ============================================================
// TOKEN CACHE
// ============================================================

const tokenCache = new Map<string, CachedToken>();

/** Buffer before expiry to trigger refresh (5 min). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Get a valid OAuth2 access token for the given config.
 * Returns a cached token if still valid (with 5 min buffer).
 * Otherwise refreshes via the token endpoint.
 */
export async function getOAuth2Token(config: OAuth2Config): Promise<string> {
  const cacheKey = `${config.clientId}:${config.tokenUrl}`;
  const cached = tokenCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt - REFRESH_BUFFER_MS) {
    return cached.accessToken;
  }

  // Refresh the token
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const msg = `Token refresh failed (${res.status}): ${text.substring(0, 200)}`;
    logError("auth", msg);
    throw new Error(msg);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };

  if (!data.access_token) {
    throw new Error("Token refresh response missing access_token");
  }

  const expiresAt = Date.now() + data.expires_in * 1000;

  tokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt,
  });

  log("auth", `Token refreshed for ${config.tokenUrl.includes("google") ? "Google" : "OAuth2"} (expires in ${data.expires_in}s)`);

  return data.access_token;
}

// ============================================================
// GOOGLE TOKEN HELPERS
// ============================================================

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Get a Google API access token (Gmail, Calendar, Contacts). */
export async function getGoogleToken(): Promise<string> {
  return getOAuth2Token({
    clientId: requireEnv("GOOGLE_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
    refreshToken: requireEnv("GOOGLE_REFRESH_TOKEN"),
    tokenUrl: GOOGLE_TOKEN_URL,
  });
}

/** Get a Google Business Profile API access token. */
export async function getGBPToken(): Promise<string> {
  return getOAuth2Token({
    clientId: requireEnv("GOOGLE_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
    refreshToken: requireEnv("GBP_REFRESH_TOKEN"),
    tokenUrl: GOOGLE_TOKEN_URL,
  });
}

/** Get a Google Analytics 4 API access token. */
export async function getGA4Token(): Promise<string> {
  return getOAuth2Token({
    clientId: requireEnv("GOOGLE_CLIENT_ID"),
    clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
    refreshToken: requireEnv("GA4_REFRESH_TOKEN"),
    tokenUrl: GOOGLE_TOKEN_URL,
  });
}

// ============================================================
// GOOGLEAPIS OAuth2Client
// ============================================================

/**
 * Create a googleapis OAuth2Client using Derek's credentials.
 * Used by source modules (gbp.ts, analytics.ts) that need the full
 * googleapis SDK client rather than raw access tokens.
 *
 * Uses GOOGLE_REFRESH_TOKEN_DEREK (same as main relay).
 */
export async function getGoogleOAuth2Client(): Promise<import("googleapis").Auth.OAuth2Client> {
  const { google } = await import("googleapis");
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_REFRESH_TOKEN_DEREK");

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  log("auth", "googleapis OAuth2Client initialized (Derek)");
  return client;
}
