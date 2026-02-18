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

interface CostEntry {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  traceId?: string;
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
  // Cost tracking
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  todayCosts: CostEntry[];
  modelCallCounts: Record<string, number>;
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
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  todayCosts: [],
  modelCallCounts: {},
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

export function trackClaudeCall(durationMs: number, costInfo?: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  traceId?: string;
}): void {
  metrics.claudeCallCount++;
  metrics.totalResponseTimeMs += durationMs;

  if (costInfo) {
    metrics.totalInputTokens += costInfo.inputTokens;
    metrics.totalOutputTokens += costInfo.outputTokens;
    metrics.totalCostUsd += costInfo.costUsd;
    metrics.modelCallCounts[costInfo.model] = (metrics.modelCallCounts[costInfo.model] || 0) + 1;

    // Prune old entries (keep today only)
    const todayStr = new Date().toISOString().slice(0, 10);
    metrics.todayCosts = metrics.todayCosts.filter((c) => c.timestamp.startsWith(todayStr));
    metrics.todayCosts.push({
      timestamp: new Date().toISOString(),
      model: costInfo.model,
      inputTokens: costInfo.inputTokens,
      outputTokens: costInfo.outputTokens,
      costUsd: costInfo.costUsd,
      traceId: costInfo.traceId,
    });
  }
}

export function getTodayClaudeCosts(): {
  totalCostUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  byModel: Record<string, { calls: number; costUsd: number }>;
} {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayEntries = metrics.todayCosts.filter((c) => c.timestamp.startsWith(todayStr));

  const byModel: Record<string, { calls: number; costUsd: number }> = {};
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;

  for (const entry of todayEntries) {
    totalCost += entry.costUsd;
    totalInput += entry.inputTokens;
    totalOutput += entry.outputTokens;
    if (!byModel[entry.model]) byModel[entry.model] = { calls: 0, costUsd: 0 };
    byModel[entry.model].calls++;
    byModel[entry.model].costUsd += entry.costUsd;
  }

  return {
    totalCostUsd: totalCost,
    calls: todayEntries.length,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    byModel,
  };
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

/**
 * Optional health check hook for external subsystems (e.g., circuit breakers).
 * Registered via registerHealthCheck() to avoid circular dependencies.
 * Each hook returns { issues: string[], degraded: boolean }.
 */
type HealthCheckHook = () => { issues: string[]; degraded: boolean };
const healthCheckHooks: HealthCheckHook[] = [];

/** Register an additional health check (called by getHealthStatus). */
export function registerHealthCheck(hook: HealthCheckHook): void {
  healthCheckHooks.push(hook);
}

export function getHealthStatus(): HealthStatus {
  const issues: string[] = [];
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

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

  // Run registered health check hooks (circuit breakers, etc.)
  let hookDegraded = false;
  for (const hook of healthCheckHooks) {
    try {
      const result = hook();
      if (result.issues.length > 0) issues.push(...result.issues);
      if (result.degraded) hookDegraded = true;
    } catch {
      // Health check hooks should never crash the health check
    }
  }

  // Determine status
  let status: "healthy" | "degraded" | "unhealthy" = "healthy";

  if (
    (metrics.messageCount > 5 && metrics.errorCount / metrics.messageCount > 0.5) ||
    recentErrorCount > 10
  ) {
    status = "unhealthy";
  } else if (recentErrorCount > 0 || avgMs > 60000 || hookDegraded) {
    status = "degraded";
  }

  return { status, issues };
}
