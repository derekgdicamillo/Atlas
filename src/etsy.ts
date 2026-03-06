/**
 * Atlas — Etsy API v3 Integration
 *
 * Manages Etsy shop listings, orders, and analytics.
 * Auth: OAuth 2.0 with PKCE (mandatory for Etsy).
 * API: https://openapi.etsy.com/v3/
 *
 * Status: Skeleton ready. Activate when Etsy developer API approval arrives.
 *
 * Known limitations (Etsy API v3):
 * - No shop analytics endpoint (views/conversion are dashboard-only)
 * - No reviews/feedback endpoint
 * - No customer messaging endpoint
 * - Rate limit: 10,000 QPD, 10 QPS
 */

import { info, warn, error as logError } from "./logger.ts";
import { getBreaker } from "./circuit-breaker.ts";
import { createHash, randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// CONFIG
// ============================================================

const ETSY_API = "https://openapi.etsy.com/v3";
const ETSY_API_KEY = process.env.ETSY_API_KEY || "";
const ETSY_SHOP_ID = process.env.ETSY_SHOP_ID || "";
const ETSY_REDIRECT_URI = process.env.ETSY_REDIRECT_URI || "http://127.0.0.1:3001/oauth/etsy";

let accessToken = process.env.ETSY_ACCESS_TOKEN || "";
let refreshToken = process.env.ETSY_REFRESH_TOKEN || "";

const etsyBreaker = getBreaker("Etsy", {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  requestTimeoutMs: 20_000,
});

let supabase: SupabaseClient | null = null;

// ============================================================
// TYPES
// ============================================================

export interface EtsyListing {
  listing_id: number;
  title: string;
  description: string;
  tags: string[];
  price: { amount: number; divisor: number; currency_code: string };
  quantity: number;
  views: number;
  num_favorers: number;
  state: string; // active, draft, inactive, expired
  images?: Array<{ url_570xN: string; url_fullxfull: string }>;
  url?: string;
}

export interface EtsyReceipt {
  receipt_id: number;
  buyer_email: string;
  name: string;
  status: string;
  is_shipped: boolean;
  transactions: Array<{
    listing_id: number;
    title: string;
    quantity: number;
    price: { amount: number; divisor: number };
  }>;
  create_timestamp: number;
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

export function isEtsyReady(): boolean {
  return !!accessToken && !!ETSY_API_KEY && !!ETSY_SHOP_ID;
}

export function initEtsy(client?: SupabaseClient): boolean {
  if (client) supabase = client;

  if (!ETSY_API_KEY) {
    return false;
  }
  if (!accessToken) {
    warn("etsy", "Etsy API key configured but no access token. Run OAuth flow first.");
    return false;
  }
  if (!ETSY_SHOP_ID) {
    warn("etsy", "Etsy access token present but no shop ID configured.");
    return false;
  }
  info("etsy", `Etsy integration ready (shop: ${ETSY_SHOP_ID})`);
  return true;
}

// ============================================================
// OAUTH (PKCE)
// ============================================================

// PKCE state storage (in-memory, single-user system)
let pendingCodeVerifier = "";

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/**
 * Generate the OAuth authorization URL with PKCE.
 */
export function getEtsyAuthUrl(state: string): string {
  const { codeVerifier, codeChallenge } = generatePKCE();
  pendingCodeVerifier = codeVerifier;

  const scopes = "listings_r listings_w transactions_r transactions_w shops_r";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ETSY_API_KEY,
    redirect_uri: ETSY_REDIRECT_URI,
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `https://www.etsy.com/oauth/connect?${params}`;
}

/**
 * Exchange authorization code for tokens (with PKCE verifier).
 */
export async function exchangeEtsyCode(code: string, codeVerifier?: string): Promise<TokenResponse> {
  const verifier = codeVerifier || pendingCodeVerifier;
  if (!verifier) throw new Error("No PKCE code verifier available");

  const res = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ETSY_API_KEY,
      redirect_uri: ETSY_REDIRECT_URI,
      code,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Etsy token exchange failed (${res.status}): ${body.substring(0, 200)}`);
  }

  const tokens = (await res.json()) as TokenResponse;
  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token;
  pendingCodeVerifier = "";
  info("etsy", "OAuth tokens obtained successfully");
  return tokens;
}

/**
 * Refresh the access token.
 */
export async function refreshEtsyToken(): Promise<string> {
  if (!refreshToken) throw new Error("No Etsy refresh token available");

  const res = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ETSY_API_KEY,
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Etsy token refresh failed (${res.status}): ${body.substring(0, 200)}`);
  }

  const tokens = (await res.json()) as TokenResponse;
  accessToken = tokens.access_token;
  if (tokens.refresh_token) refreshToken = tokens.refresh_token;
  info("etsy", "Access token refreshed");
  return accessToken;
}

// ============================================================
// FETCH HELPER
// ============================================================

async function etsyFetchRaw<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  if (!accessToken) throw new Error("Etsy access token not configured");

  const url = `${ETSY_API}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "x-api-key": ETSY_API_KEY,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });

  // Auto-refresh on 401
  if (res.status === 401 && refreshToken) {
    warn("etsy", "Access token expired, refreshing...");
    await refreshEtsyToken();
    const retryRes = await fetch(url, {
      ...options,
      headers: {
        "x-api-key": ETSY_API_KEY,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!retryRes.ok) {
      const body = await retryRes.text().catch(() => "");
      throw new Error(`Etsy ${endpoint} returned ${retryRes.status} after refresh: ${body.substring(0, 200)}`);
    }
    return retryRes.json() as Promise<T>;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Etsy ${endpoint} returned ${res.status}: ${body.substring(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

async function etsyFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  return etsyBreaker.exec(() => etsyFetchRaw<T>(endpoint, options));
}

// ============================================================
// LISTINGS
// ============================================================

export async function getListings(limit = 25, offset = 0): Promise<EtsyListing[]> {
  const data = await etsyFetch<{ results: EtsyListing[]; count: number }>(
    `/application/shops/${ETSY_SHOP_ID}/listings?limit=${limit}&offset=${offset}&state=active`,
  );
  return data.results || [];
}

export async function getListing(listingId: number): Promise<EtsyListing | null> {
  try {
    return await etsyFetch<EtsyListing>(`/application/listings/${listingId}`);
  } catch {
    return null;
  }
}

export async function updateListing(
  listingId: number,
  data: { title?: string; description?: string; tags?: string[] },
): Promise<EtsyListing> {
  info("etsy", `Updating listing ${listingId}: ${Object.keys(data).join(", ")}`);
  return etsyFetch<EtsyListing>(`/application/shops/${ETSY_SHOP_ID}/listings/${listingId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

// ============================================================
// ORDERS
// ============================================================

export async function getOrders(limit = 25): Promise<EtsyReceipt[]> {
  const data = await etsyFetch<{ results: EtsyReceipt[]; count: number }>(
    `/application/shops/${ETSY_SHOP_ID}/receipts?limit=${limit}&sort_on=created&sort_order=desc`,
  );
  return data.results || [];
}

export async function getUnshippedOrders(): Promise<EtsyReceipt[]> {
  const data = await etsyFetch<{ results: EtsyReceipt[]; count: number }>(
    `/application/shops/${ETSY_SHOP_ID}/receipts?was_shipped=false&limit=50`,
  );
  return data.results || [];
}

export async function addShipment(
  receiptId: number,
  trackingNumber: string,
  carrier: string,
): Promise<void> {
  info("etsy", `Adding shipment to receipt ${receiptId}: ${carrier} ${trackingNumber}`);
  await etsyFetch(`/application/shops/${ETSY_SHOP_ID}/receipts/${receiptId}/shipments`, {
    method: "POST",
    body: JSON.stringify({
      tracking_code: trackingNumber,
      carrier_name: carrier,
    }),
  });
}

// ============================================================
// SYNC (cache listings to Supabase)
// ============================================================

export async function syncListingsToCache(): Promise<number> {
  if (!supabase) {
    warn("etsy", "Cannot sync listings: Supabase not available");
    return 0;
  }

  const listings = await getListings(100);
  if (listings.length === 0) return 0;

  const rows = listings.map((l) => ({
    listing_id: String(l.listing_id),
    title: l.title,
    description: l.description?.substring(0, 5000),
    tags: l.tags || [],
    price_cents: l.price ? Math.round((l.price.amount / l.price.divisor) * 100) : 0,
    quantity: l.quantity,
    views: l.views || 0,
    favorites: l.num_favorers || 0,
    status: l.state,
    images: l.images || [],
    last_synced_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("etsy_listings")
    .upsert(rows, { onConflict: "listing_id" });

  if (error) {
    logError("etsy", `Listing sync failed: ${error.message}`);
    return 0;
  }

  info("etsy", `Synced ${rows.length} listings to cache`);
  return rows.length;
}

// ============================================================
// TAG PROCESSING
// ============================================================

export async function processEtsyIntents(response: string): Promise<string> {
  let clean = response;

  // [ETSY_UPDATE: listingId | title=... | description=... | tags=...]
  for (const match of response.matchAll(/\[ETSY_UPDATE:\s*([\s\S]+?)\]/gi)) {
    const inner = match[1];
    const parts = inner.split("|").map((s) => s.trim());
    const listingId = parseInt(parts[0], 10);

    if (isNaN(listingId)) {
      warn("etsy", `ETSY_UPDATE: invalid listing ID: ${parts[0]}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    const updateData: { title?: string; description?: string; tags?: string[] } = {};
    for (const part of parts.slice(1)) {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) continue;
      const key = part.slice(0, eqIdx).trim().toLowerCase();
      const val = part.slice(eqIdx + 1).trim();
      if (key === "title") updateData.title = val;
      else if (key === "description") updateData.description = val;
      else if (key === "tags") updateData.tags = val.split(",").map((t) => t.trim());
    }

    try {
      await updateListing(listingId, updateData);
      info("etsy", `ETSY_UPDATE success: listing ${listingId}`);
    } catch (err) {
      logError("etsy", `ETSY_UPDATE failed for ${listingId}: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [ETSY_SYNC:]
  for (const match of response.matchAll(/\[ETSY_SYNC:\s*\]/gi)) {
    try {
      const count = await syncListingsToCache();
      info("etsy", `ETSY_SYNC: ${count} listings synced`);
    } catch (err) {
      logError("etsy", `ETSY_SYNC failed: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [ETSY_SHIP: receiptId | tracking | carrier]
  for (const match of response.matchAll(/\[ETSY_SHIP:\s*([\s\S]+?)\]/gi)) {
    const parts = match[1].split("|").map((s) => s.trim());
    if (parts.length < 3) {
      warn("etsy", `ETSY_SHIP missing parameters: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    const receiptId = parseInt(parts[0], 10);
    const tracking = parts[1];
    const carrier = parts[2];

    if (isNaN(receiptId)) {
      warn("etsy", `ETSY_SHIP: invalid receipt ID: ${parts[0]}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    try {
      await addShipment(receiptId, tracking, carrier);
      info("etsy", `ETSY_SHIP success: receipt ${receiptId}`);
    } catch (err) {
      logError("etsy", `ETSY_SHIP failed for ${receiptId}: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  return clean;
}

// ============================================================
// CONTEXT
// ============================================================

export async function getEtsyContext(): Promise<string> {
  if (!isEtsyReady() && !supabase) return "";

  // Try cache first
  if (supabase) {
    try {
      const { data } = await supabase
        .from("etsy_listings")
        .select("title, price_cents, quantity, views, favorites, status")
        .eq("status", "active")
        .order("views", { ascending: false })
        .limit(10);

      if (data && data.length > 0) {
        const listingLines = data.map((l: Record<string, unknown>) => {
          const price = typeof l.price_cents === "number" ? `$${(l.price_cents / 100).toFixed(2)}` : "?";
          return `  - ${l.title} | ${price} | ${l.quantity} qty | ${l.views} views, ${l.favorites} fav`;
        });

        return [
          `ETSY SHOP (${data.length} active listings):`,
          ...listingLines,
          "",
          "Tags: [ETSY_UPDATE: id | title=... | tags=...], [ETSY_SYNC:], [ETSY_SHIP: receiptId | tracking | carrier]",
        ].join("\n");
      }
    } catch (err) {
      warn("etsy", `Context cache read failed: ${err}`);
    }
  }

  if (isEtsyReady()) {
    return "Etsy: connected (use [ETSY_SYNC:] to refresh listing cache)";
  }

  return "";
}
