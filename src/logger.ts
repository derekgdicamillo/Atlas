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

/**
 * Redact sensitive tokens from log messages, health dumps, and error output.
 *
 * Two layers:
 *  1. Exact-match patterns built from actual env var values at startup.
 *  2. Generic regex patterns that catch common secret formats even if
 *     the env var wasn't loaded (e.g. leaked via error messages from APIs).
 */
const SENSITIVE_EXACT: RegExp[] = [];

/** Env vars whose runtime values should never appear in any output. */
const SENSITIVE_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "ISHTAR_BOT_TOKEN",
  "GHL_API_TOKEN",
  "GHL_WEBHOOK_SECRET",
  "DASHBOARD_API_TOKEN",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN_DEREK",
  "GOOGLE_REFRESH_TOKEN_ATLAS",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "AZURE_CLIENT_SECRET",
  "META_ACCESS_TOKEN",
  "WP_APP_PASSWORD",
  "ANTHROPIC_API_KEY",
  "VOYAGE_API_KEY",
  "GEMINI_API_KEY",
  "NVIDIA_API_KEY",
  "HA_TOKEN",
  "GAMMA_API_KEY",
];

/**
 * Generic patterns that catch common secret formats in free text.
 * These fire even when the secret didn't come from our own env vars
 * (e.g. an upstream API echoed a key back in an error body).
 */
const GENERIC_SECRET_PATTERNS: RegExp[] = [
  // Bearer tokens in Authorization headers
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  // Common API key prefixes (sk-, pk-, api-, pat_, ghp_, gho_, etc.)
  /\b(?:sk|pk|api|pat|ghp|gho|ghu|ghs|whsec|rk)[-_][A-Za-z0-9\-._]{20,}\b/g,
  // Base64 blobs that look like tokens (40+ chars, no spaces)
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function initSensitivePatterns(): void {
  for (const key of SENSITIVE_ENV_KEYS) {
    const val = process.env[key];
    if (val && val.length >= 8) {
      SENSITIVE_EXACT.push(new RegExp(escapeForRegex(val), "g"));
    }
  }
  // Defensive: also catch any env var whose name matches *_SECRET, *_PASSWORD, *_PRIVATE_KEY, *_TOKEN, or *_KEY
  for (const [key, val] of Object.entries(process.env)) {
    if (!val || val.length < 8) continue;
    if (SENSITIVE_ENV_KEYS.includes(key)) continue; // already added
    if (/SECRET|PASSWORD|PRIVATE_KEY|_TOKEN|_KEY/i.test(key)) {
      SENSITIVE_EXACT.push(new RegExp(escapeForRegex(val), "g"));
    }
  }
}
// Initialize once at module load
setTimeout(initSensitivePatterns, 0);

/**
 * Redact sensitive tokens from a string.
 * Exported so other modules (circuit breaker, health dumps) can use it.
 */
export function redactSecrets(msg: string): string {
  if (!msg) return msg;
  let out = msg;
  // Layer 1: exact env var values
  for (const pat of SENSITIVE_EXACT) {
    pat.lastIndex = 0; // reset stateful regex
    out = out.replace(pat, "[REDACTED]");
  }
  // Layer 2: generic secret-shaped strings
  for (const pat of GENERIC_SECRET_PATTERNS) {
    pat.lastIndex = 0;
    out = out.replace(pat, "[REDACTED]");
  }
  return out;
}

/**
 * Deep-redact an object (for metadata, health dumps, etc.).
 * Walks objects/arrays and redacts any string values. Returns a new object.
 */
export function redactObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return redactSecrets(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map(redactObject) as unknown as T;
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      // Suppress entire value for keys that look like secrets
      if (/secret|password|token|_key|private_key|authorization/i.test(key) && typeof val === "string") {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactObject(val);
      }
    }
    return out as T;
  }
  return obj;
}

let supabase: SupabaseClient | null = null;

/**
 * Supabase log persistence circuit breaker.
 * Suppresses log writes after consecutive failures to avoid log spam
 * during network outages (addresses recurring socket close errors).
 * Auto-recovers after a cooldown period.
 */
let supabaseLogFailures = 0;
let supabaseLogSuppressedUntil = 0;
const SUPABASE_LOG_FAILURE_THRESHOLD = 3;
const SUPABASE_LOG_COOLDOWN_MS = 60_000; // 1 min cooldown after 3 failures

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

  // Circuit breaker: suppress writes during sustained failures to avoid log spam.
  // This addresses the recurring "socket connection was closed unexpectedly" errors
  // seen during network transients (2026-02-22 error log pattern).
  const now = Date.now();
  if (supabaseLogFailures >= SUPABASE_LOG_FAILURE_THRESHOLD) {
    if (now < supabaseLogSuppressedUntil) return; // still in cooldown
    // Cooldown expired, allow one probe write to check recovery
    supabaseLogFailures = SUPABASE_LOG_FAILURE_THRESHOLD - 1;
  }

  // Fire-and-forget, never block the main flow
  supabase.from("logs").insert({
    level,
    event,
    message,
    metadata: metadata ? redactObject(metadata) : {},
  }).then(({ error }) => {
    if (error) {
      supabaseLogFailures++;
      if (supabaseLogFailures === SUPABASE_LOG_FAILURE_THRESHOLD) {
        supabaseLogSuppressedUntil = Date.now() + SUPABASE_LOG_COOLDOWN_MS;
        console.error(`[logger] Supabase log writes suppressed for ${SUPABASE_LOG_COOLDOWN_MS / 1000}s after ${SUPABASE_LOG_FAILURE_THRESHOLD} consecutive failures: ${error.message}`);
      }
    } else {
      // Success: reset failure counter
      supabaseLogFailures = 0;
    }
  });
}

function log(level: LogLevel, event: string, message: string, metadata?: Record<string, unknown>): void {
  const safeMsg = redactSecrets(message);
  const formatted = formatLog(level, event, safeMsg);

  if (level === "error") {
    console.error(formatted);
  } else if (level === "warn") {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }

  persistLog(level, event, safeMsg, metadata);
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
  // Store redacted message in metrics (these flow to health.json via getMetrics)
  metrics.recentErrors.push({ time: new Date().toISOString(), event, message: redactSecrets(message) });
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

  // Check recent errors (within last hour) -- use rolling window, not cumulative
  const recentErrors = metrics.recentErrors.filter(
    (e) => new Date(e.time).getTime() > oneHourAgo
  );
  const recentErrorCount = recentErrors.length;

  // Count recent messages (within last hour) for rolling error rate
  // Use a minimum of 5 to avoid noisy ratios from low volume
  const recentMessageCount = Math.max(metrics.messageCount, 5);

  // Check recent timeouts (only flag if they happened recently)
  const recentTimeoutErrors = recentErrors.filter(
    (e) => e.message.includes("timeout") || e.message.includes("Timeout") || e.message.includes("inactive for")
  ).length;
  if (recentTimeoutErrors > 3) {
    issues.push(`${recentTimeoutErrors} timeouts in the last hour`);
  }

  // Error rate check -- rolling 1-hour window instead of cumulative.
  // Cumulative was permanently poisoned by old cron timeout bursts.
  if (recentErrorCount > 5) {
    issues.push(`${recentErrorCount} errors in the last hour`);
  }

  // Average response time (still cumulative since startup, but acceptable)
  const avgMs = metrics.claudeCallCount > 0
    ? metrics.totalResponseTimeMs / metrics.claudeCallCount
    : 0;
  if (avgMs > 60000) {
    issues.push(`Slow responses: avg ${Math.round(avgMs / 1000)}s`);
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

  // Determine status -- based on rolling window, not cumulative totals.
  // This prevents a single network blip from permanently marking UNHEALTHY.
  let status: "healthy" | "degraded" | "unhealthy" = "healthy";

  if (recentErrorCount > 10) {
    status = "unhealthy";
  } else if (recentErrorCount > 3 || avgMs > 60000 || hookDegraded) {
    status = "degraded";
  }

  return { status, issues };
}
