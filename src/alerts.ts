/**
 * Atlas -- Real-Time Alert Pipeline
 *
 * Central alert system that monitors, deduplicates, batches, and delivers
 * alerts proactively via Telegram.
 *
 * Features:
 * - Deduplication: same dedup_key within category-aware window (4h-24h)
 * - Rate limiting: max 10 alerts/hour (critical exempt)
 * - Quiet hours: 10 PM - 7 AM MST (warnings suppressed, critical always delivered)
 * - Grouping: alerts within 5-min window grouped by category
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { info, warn, error as logError } from "./logger.ts";
import { ALERT_DEDUP_WINDOWS, ALERT_DEDUP_DEFAULT_MS } from "./constants.ts";

// ============================================================
// CONFIGURATION
// ============================================================
const RATE_LIMIT_PER_HOUR = 10;           // max alerts per hour (critical exempt)
const GROUPING_WINDOW_MS = 5 * 60_000;   // 5 minutes
const QUIET_START_HOUR = 22;              // 10 PM MST
const QUIET_END_HOUR = 7;                 // 7 AM MST
const TIMEZONE = "America/Phoenix";

// In-memory rate tracking
let alertCountThisHour = 0;
let currentHourStart = 0;

// ============================================================
// TYPES
// ============================================================

export interface AlertInput {
  source: string;
  severity: "info" | "warning" | "critical";
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
  dedupKey?: string;  // custom dedup key; auto-generated if not provided
}

interface StoredAlert {
  id: string;
  source: string;
  severity: string;
  category: string;
  message: string;
  dedup_key: string | null;
  delivered: boolean;
  suppressed: boolean;
  created_at: string;
  delivered_at: string | null;
  metadata: Record<string, unknown>;
}

// ============================================================
// HELPERS
// ============================================================

function generateDedupKey(alert: AlertInput): string {
  const raw = `${alert.source}:${alert.category}:${alert.message.substring(0, 100)}`;
  return createHash("sha256").update(raw).digest("hex").substring(0, 16);
}

export function isQuietHours(): boolean {
  const now = new Date();
  const hour = parseInt(
    now.toLocaleString("en-US", { timeZone: TIMEZONE, hour: "numeric", hour12: false })
  );
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

function checkRateLimit(): boolean {
  const now = Date.now();
  const hourMs = 3600_000;
  if (now - currentHourStart > hourMs) {
    currentHourStart = now;
    alertCountThisHour = 0;
  }
  return alertCountThisHour < RATE_LIMIT_PER_HOUR;
}

// ============================================================
// CORE API
// ============================================================

/**
 * Emit an alert into the pipeline.
 * Handles dedup, rate limiting, quiet hours, and DB insertion.
 */
export async function emit(
  supabase: SupabaseClient,
  alert: AlertInput,
): Promise<{ stored: boolean; reason?: string }> {
  const dedupKey = alert.dedupKey || generateDedupKey(alert);

  // Dedup check: same key within category-aware window
  try {
    const dedupMs = ALERT_DEDUP_WINDOWS[alert.category] ?? ALERT_DEDUP_DEFAULT_MS;
    const cutoff = new Date(Date.now() - dedupMs).toISOString();
    const { data: existing } = await supabase
      .from("alerts")
      .select("id")
      .eq("dedup_key", dedupKey)
      .gte("created_at", cutoff)
      .limit(1);

    if (existing?.length) {
      return { stored: false, reason: "duplicate" };
    }
  } catch {
    // Dedup check failed, proceed anyway
  }

  // Rate limit check (critical exempt)
  if (alert.severity !== "critical" && !checkRateLimit()) {
    return { stored: false, reason: "rate_limited" };
  }

  // Quiet hours: suppress non-critical alerts
  const suppressed = alert.severity !== "critical" && isQuietHours();

  // Insert alert
  const { error } = await supabase.from("alerts").insert({
    source: alert.source,
    severity: alert.severity,
    category: alert.category,
    message: alert.message,
    dedup_key: dedupKey,
    suppressed,
    metadata: alert.metadata || {},
  });

  if (error) {
    logError("alerts", `Failed to store alert: ${error.message}`);
    return { stored: false, reason: error.message };
  }

  alertCountThisHour++;

  // Critical alerts get immediate delivery flag (handled by deliver())
  if (alert.severity === "critical") {
    info("alerts", `CRITICAL alert: ${alert.message}`);
  }

  return { stored: true };
}

/**
 * Deliver undelivered alerts.
 * Groups alerts by category within the grouping window.
 * Called every 1 minute by cron.
 *
 * Returns formatted messages ready for Telegram delivery.
 */
export async function deliver(
  supabase: SupabaseClient,
): Promise<string[]> {
  const messages: string[] = [];

  try {
    const { data: pending, error } = await supabase
      .from("alerts")
      .select("*")
      .eq("delivered", false)
      .eq("suppressed", false)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error || !pending?.length) return messages;

    // Group by category
    const groups = new Map<string, StoredAlert[]>();
    for (const alert of pending as StoredAlert[]) {
      const key = alert.category;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(alert);
    }

    // Format each group
    const severityIcon: Record<string, string> = {
      critical: "[!!!]",
      warning: "[!]",
      info: "[i]",
    };

    for (const [category, alerts] of groups) {
      const header = `Alert: ${category.charAt(0).toUpperCase() + category.slice(1)}`;
      const lines = alerts.map(a => {
        const icon = severityIcon[a.severity] || "";
        return `${icon} ${a.message}`;
      });
      messages.push(`${header}\n${lines.join("\n")}`);

      // Mark as delivered
      const ids = alerts.map(a => a.id);
      await supabase
        .from("alerts")
        .update({ delivered: true, delivered_at: new Date().toISOString() })
        .in("id", ids);
    }
  } catch (err) {
    logError("alerts", `Delivery failed: ${err}`);
  }

  return messages;
}

/**
 * Get recent alerts for display (e.g., /alerts command).
 */
export async function getRecentAlerts(
  supabase: SupabaseClient,
  hours = 24,
): Promise<string> {
  try {
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    const { data, error } = await supabase
      .from("alerts")
      .select("severity, category, message, delivered, suppressed, created_at")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return `Alert error: ${error.message}`;
    if (!data?.length) return `No alerts in the last ${hours} hours.`;

    // Count suppressed
    const suppressed = data.filter((a: any) => a.suppressed).length;

    // Group by category
    const groups = new Map<string, any[]>();
    for (const alert of data) {
      const cat = (alert as any).category || "general";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(alert);
    }

    const sections: string[] = [`Alerts (last ${hours}h):`];

    for (const [category, alerts] of groups) {
      sections.push(`\n${category.toUpperCase()} (${alerts.length}):`);
      for (const a of alerts.slice(0, 10)) {
        const time = new Date(a.created_at).toLocaleTimeString("en-US", {
          timeZone: "America/Phoenix",
          hour: "numeric",
          minute: "2-digit",
        });
        const icon = a.severity === "critical" ? "[!!!]" : a.severity === "warning" ? "[!]" : "[i]";
        const status = a.suppressed ? " (suppressed)" : a.delivered ? "" : " (pending)";
        sections.push(`  ${icon} ${time} ${a.message}${status}`);
      }
    }

    if (suppressed > 0) {
      sections.push(`\n${suppressed} alert(s) suppressed during quiet hours.`);
    }

    return sections.join("\n");
  } catch (err) {
    return `Alert error: ${err}`;
  }
}
