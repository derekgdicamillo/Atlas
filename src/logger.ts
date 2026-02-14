/**
 * Atlas — Structured Logger + In-Memory Metrics
 *
 * Replaces scattered console.log/console.error with structured logging.
 * Optionally persists logs to Supabase `logs` table.
 * Tracks in-memory metrics for health monitoring.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

type LogLevel = "debug" | "info" | "warn" | "error";

interface ErrorEntry {
  time: string;
  event: string;
  message: string;
}

interface Metrics {
  startedAt: string;
  messageCount: number;
  errorCount: number;
  claudeCallCount: number;
  claudeTimeoutCount: number;
  totalResponseTimeMs: number;
  lastErrorTime: string | null;
  lastErrorEvent: string | null;
  recentErrors: ErrorEntry[];
}

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  issues: string[];
}

const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";
const MAX_RECENT_ERRORS = 20;

let supabase: SupabaseClient | null = null;

const metrics: Metrics = {
  startedAt: new Date().toISOString(),
  messageCount: 0,
  errorCount: 0,
  claudeCallCount: 0,
  claudeTimeoutCount: 0,
  totalResponseTimeMs: 0,
  lastErrorTime: null,
  lastErrorEvent: null,
  recentErrors: [],
};

function timestamp(): string {
  return new Date().toLocaleString("en-US", { timeZone: TIMEZONE });
}

function formatLog(level: LogLevel, event: string, message: string): string {
  return `[${level.toUpperCase()}] [${event}] ${message}`;
}

function persistLog(level: LogLevel, event: string, message: string, metadata?: Record<string, unknown>): void {
  if (!supabase) return;
  // Fire-and-forget — never block the main flow
  supabase.from("logs").insert({
    level,
    event,
    message,
    metadata: metadata || {},
  }).then(({ error }) => {
    if (error) console.error(`[logger] Supabase log write failed: ${error.message}`);
  });
}

function log(level: LogLevel, event: string, message: string, metadata?: Record<string, unknown>): void {
  const formatted = formatLog(level, event, message);

  if (level === "error") {
    console.error(formatted);
  } else if (level === "warn") {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }

  persistLog(level, event, message, metadata);
}

// ============================================================
// PUBLIC API
// ============================================================

export function initLogger(client: SupabaseClient | null): void {
  supabase = client;
}

export function info(event: string, message: string, metadata?: Record<string, unknown>): void {
  log("info", event, message, metadata);
}

export function warn(event: string, message: string, metadata?: Record<string, unknown>): void {
  log("warn", event, message, metadata);
}

export function error(event: string, message: string, metadata?: Record<string, unknown>): void {
  log("error", event, message, metadata);
  metrics.errorCount++;
  metrics.lastErrorTime = new Date().toISOString();
  metrics.lastErrorEvent = event;
  metrics.recentErrors.push({ time: new Date().toISOString(), event, message });
  if (metrics.recentErrors.length > MAX_RECENT_ERRORS) {
    metrics.recentErrors.shift();
  }
}

export function trackMessage(): void {
  metrics.messageCount++;
}

export function trackClaudeCall(durationMs: number): void {
  metrics.claudeCallCount++;
  metrics.totalResponseTimeMs += durationMs;
}

export function trackTimeout(): void {
  metrics.claudeTimeoutCount++;
}

export function getMetrics(): Metrics & { avgResponseMs: number } {
  return {
    ...metrics,
    avgResponseMs: metrics.claudeCallCount > 0
      ? Math.round(metrics.totalResponseTimeMs / metrics.claudeCallCount)
      : 0,
  };
}

export function getHealthStatus(): HealthStatus {
  const issues: string[] = [];
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const thirtyMinAgo = now - 30 * 60 * 1000;

  // Check recent errors (within last hour)
  const recentErrorCount = metrics.recentErrors.filter(
    (e) => new Date(e.time).getTime() > oneHourAgo
  ).length;

  // Check recent timeouts
  if (metrics.claudeTimeoutCount > 3) {
    issues.push(`${metrics.claudeTimeoutCount} Claude timeouts total`);
  }

  // Error rate check
  if (metrics.messageCount > 5 && metrics.errorCount / metrics.messageCount > 0.5) {
    issues.push(`High error rate: ${metrics.errorCount}/${metrics.messageCount} messages failed`);
  }

  // Average response time
  const avgMs = metrics.claudeCallCount > 0
    ? metrics.totalResponseTimeMs / metrics.claudeCallCount
    : 0;
  if (avgMs > 60000) {
    issues.push(`Slow responses: avg ${Math.round(avgMs / 1000)}s`);
  }

  // Recent errors
  if (recentErrorCount > 5) {
    issues.push(`${recentErrorCount} errors in the last hour`);
  }

  // Determine status
  let status: "healthy" | "degraded" | "unhealthy" = "healthy";

  if (
    (metrics.messageCount > 5 && metrics.errorCount / metrics.messageCount > 0.5) ||
    recentErrorCount > 10
  ) {
    status = "unhealthy";
  } else if (recentErrorCount > 0 || avgMs > 60000) {
    status = "degraded";
  }

  return { status, issues };
}
