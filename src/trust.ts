/**
 * Atlas — Trust Gradient System
 *
 * Per-action permission levels for autonomous business operations.
 * Three levels: draft (human approves), auto_notify (auto + notify human), full_auto (silent).
 * Config stored in trust_config table, cached in memory with 5-minute TTL.
 */

import { info, warn } from "./logger.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// TYPES
// ============================================================

export type PermissionLevel = "draft" | "auto_notify" | "full_auto";

export type ActionType =
  | "social_post"
  | "listing_update"
  | "customer_reply"
  | "price_change"
  | "analytics_report"
  | "content_generate";

export interface TrustConfig {
  business: string;
  action_type: ActionType;
  permission_level: PermissionLevel;
}

// ============================================================
// STATE
// ============================================================

let supabase: SupabaseClient | null = null;

// In-memory cache: business:action_type -> permission_level
const cache = new Map<string, PermissionLevel>();
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Defaults if DB is unavailable
const DEFAULTS: Record<ActionType, PermissionLevel> = {
  social_post: "draft",
  listing_update: "draft",
  customer_reply: "draft",
  price_change: "draft",
  analytics_report: "full_auto",
  content_generate: "full_auto",
};

// ============================================================
// INIT
// ============================================================

export function initTrust(client: SupabaseClient): void {
  supabase = client;
  info("trust", "Trust gradient system initialized");
}

// ============================================================
// CACHE MANAGEMENT
// ============================================================

async function ensureCache(): Promise<void> {
  if (Date.now() - cacheLoadedAt < CACHE_TTL_MS && cache.size > 0) return;

  if (!supabase) {
    warn("trust", "Supabase not available, using defaults");
    return;
  }

  try {
    const { data, error } = await supabase
      .from("trust_config")
      .select("business, action_type, permission_level");

    if (error) {
      warn("trust", `Failed to load trust config: ${error.message}`);
      return;
    }

    cache.clear();
    for (const row of data || []) {
      cache.set(`${row.business}:${row.action_type}`, row.permission_level as PermissionLevel);
    }
    cacheLoadedAt = Date.now();
    info("trust", `Loaded ${cache.size} trust config entries`);
  } catch (err) {
    warn("trust", `Trust config fetch failed: ${err}`);
  }
}

export function invalidateTrustCache(): void {
  cache.clear();
  cacheLoadedAt = 0;
}

// ============================================================
// CORE API
// ============================================================

/**
 * Get the permission level for a specific action.
 * Returns cached value or default if DB unavailable.
 */
export async function getPermissionLevel(
  business: string,
  actionType: ActionType,
): Promise<PermissionLevel> {
  await ensureCache();
  return cache.get(`${business}:${actionType}`) || DEFAULTS[actionType] || "draft";
}

/**
 * Update the permission level for a specific action.
 * Persists to DB and invalidates cache.
 */
export async function setPermissionLevel(
  business: string,
  actionType: ActionType,
  level: PermissionLevel,
): Promise<boolean> {
  if (!supabase) {
    warn("trust", "Cannot update trust config: Supabase not available");
    return false;
  }

  try {
    const { error } = await supabase
      .from("trust_config")
      .upsert(
        { business, action_type: actionType, permission_level: level, updated_at: new Date().toISOString() },
        { onConflict: "business,action_type" },
      );

    if (error) {
      warn("trust", `Failed to update trust config: ${error.message}`);
      return false;
    }

    // Update local cache immediately
    cache.set(`${business}:${actionType}`, level);
    info("trust", `Updated ${business}/${actionType} -> ${level}`);
    return true;
  } catch (err) {
    warn("trust", `Trust config update failed: ${err}`);
    return false;
  }
}

/**
 * Get all trust config entries for a business.
 */
export async function getTrustConfig(business: string): Promise<TrustConfig[]> {
  await ensureCache();

  const results: TrustConfig[] = [];
  for (const [key, level] of cache) {
    const [biz, action] = key.split(":");
    if (biz === business) {
      results.push({ business: biz, action_type: action as ActionType, permission_level: level });
    }
  }

  // Fill in defaults for any missing action types
  for (const [action, defaultLevel] of Object.entries(DEFAULTS)) {
    if (!results.find((r) => r.action_type === action)) {
      results.push({ business, action_type: action as ActionType, permission_level: defaultLevel });
    }
  }

  return results;
}

/**
 * Check if an action should proceed without human approval.
 * Convenience wrapper: returns true for auto_notify and full_auto.
 */
export async function canAutoExecute(business: string, actionType: ActionType): Promise<boolean> {
  const level = await getPermissionLevel(business, actionType);
  return level !== "draft";
}

/**
 * Check if an action should notify the human after execution.
 * Returns true for auto_notify (but not full_auto or draft).
 */
export async function shouldNotify(business: string, actionType: ActionType): Promise<boolean> {
  const level = await getPermissionLevel(business, actionType);
  return level === "auto_notify";
}

/**
 * Format trust config as a readable summary for context injection.
 */
export async function getTrustSummary(business: string): Promise<string> {
  const config = await getTrustConfig(business);
  if (config.length === 0) return "";

  const lines = config.map((c) => {
    const icon = c.permission_level === "draft" ? "APPROVAL" : c.permission_level === "auto_notify" ? "AUTO+NOTIFY" : "AUTO";
    return `  ${c.action_type}: ${icon}`;
  });

  return `Trust levels (${business}):\n${lines.join("\n")}`;
}
