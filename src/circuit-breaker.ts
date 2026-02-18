/**
 * Atlas — Circuit Breaker for External API Calls
 *
 * Per-service circuit breaker that prevents hammering dead APIs.
 * Three states: CLOSED (normal), OPEN (failing, reject fast), HALF_OPEN (testing recovery).
 *
 * Each external service (GHL, Dashboard, Google, GBP, GA4, Meta) gets its own breaker.
 * Tracks success/failure rates and provides health reporting for diagnostics.
 *
 * Inspired by Netflix Hystrix / OpenClaw resilience patterns.
 */

import { info, warn, error as logError, registerHealthCheck } from "./logger.ts";

// ============================================================
// TYPES
// ============================================================

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Service name for logging */
  name: string;
  /** Number of failures before opening the circuit (default: 3) */
  failureThreshold?: number;
  /** How long to stay open before trying half-open (default: 60s) */
  resetTimeoutMs?: number;
  /** Number of successes in half-open needed to close (default: 1) */
  halfOpenSuccessThreshold?: number;
  /** Request timeout in ms (default: 20s) */
  requestTimeoutMs?: number;
}

export interface CircuitBreakerStats {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  openedAt: string | null;
  /** Average response time in ms (last 20 calls) */
  avgResponseMs: number;
}

// ============================================================
// CIRCUIT BREAKER
// ============================================================

export class CircuitBreaker {
  private name: string;
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private totalRequests = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private lastFailureAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private openedAt: string | null = null;
  private openedAtMs = 0;

  private failureThreshold: number;
  private resetTimeoutMs: number;
  private halfOpenSuccessThreshold: number;
  private requestTimeoutMs: number;

  /** Rolling window of recent response times (last 20) */
  private responseTimes: number[] = [];
  private static readonly MAX_RESPONSE_SAMPLES = 20;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 60_000;
    this.halfOpenSuccessThreshold = opts.halfOpenSuccessThreshold ?? 1;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
  }

  /**
   * Execute a function through the circuit breaker.
   * Returns the result on success, or throws on failure / open circuit.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we should allow the request
    if (this.state === "open") {
      if (Date.now() - this.openedAtMs >= this.resetTimeoutMs) {
        // Transition to half-open: allow a probe request
        this.state = "half_open";
        this.successes = 0;
        info("circuit-breaker", `${this.name}: OPEN -> HALF_OPEN (testing recovery)`);
      } else {
        throw new CircuitOpenError(this.name, this.lastError);
      }
    }

    this.totalRequests++;
    const startMs = Date.now();

    try {
      const result = await fn();
      this.onSuccess(Date.now() - startMs);
      return result;
    } catch (err) {
      this.onFailure(err, Date.now() - startMs);
      throw err;
    }
  }

  /**
   * Execute with a fallback value when the circuit is open.
   * Never throws. Returns fallback on open circuit or failure.
   */
  async execWithFallback<T>(fn: () => Promise<T>, fallback: T, label?: string): Promise<T> {
    try {
      return await this.exec(fn);
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // Silent fallback when circuit is open (avoid log spam)
        return fallback;
      }
      const tag = label || this.name;
      warn("circuit-breaker", `${tag} failed, using fallback: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }

  /** Get the configured request timeout for this service */
  getTimeoutMs(): number {
    return this.requestTimeoutMs;
  }

  private onSuccess(responseMs: number): void {
    this.totalSuccesses++;
    this.lastSuccessAt = new Date().toISOString();
    this.recordResponseTime(responseMs);

    if (this.state === "half_open") {
      this.successes++;
      if (this.successes >= this.halfOpenSuccessThreshold) {
        this.state = "closed";
        this.failures = 0;
        this.successes = 0;
        this.openedAt = null;
        info("circuit-breaker", `${this.name}: HALF_OPEN -> CLOSED (recovered)`);
      }
    } else if (this.state === "closed") {
      // Reset failure count on success (sliding window would be better but this is simpler)
      this.failures = 0;
    }
  }

  private onFailure(err: unknown, responseMs: number): void {
    this.totalFailures++;
    this.failures++;
    this.lastFailureAt = new Date().toISOString();
    this.lastError = err instanceof Error ? err.message : String(err);
    this.recordResponseTime(responseMs);

    if (this.state === "half_open") {
      // Failed during probe, go back to open
      this.state = "open";
      this.openedAt = new Date().toISOString();
      this.openedAtMs = Date.now();
      warn("circuit-breaker", `${this.name}: HALF_OPEN -> OPEN (probe failed: ${this.lastError})`);
    } else if (this.state === "closed" && this.failures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = new Date().toISOString();
      this.openedAtMs = Date.now();
      warn("circuit-breaker", `${this.name}: CLOSED -> OPEN (${this.failures} consecutive failures. Last: ${this.lastError})`);
    }
  }

  private recordResponseTime(ms: number): void {
    this.responseTimes.push(ms);
    if (this.responseTimes.length > CircuitBreaker.MAX_RESPONSE_SAMPLES) {
      this.responseTimes.shift();
    }
  }

  /** Get current stats for diagnostics */
  getStats(): CircuitBreakerStats {
    const avgResponseMs =
      this.responseTimes.length > 0
        ? Math.round(this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length)
        : 0;

    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      openedAt: this.openedAt,
      avgResponseMs,
    };
  }

  /** Check if the circuit is currently allowing requests */
  isAvailable(): boolean {
    if (this.state === "closed" || this.state === "half_open") return true;
    // Check if reset timeout has elapsed
    return Date.now() - this.openedAtMs >= this.resetTimeoutMs;
  }

  /** Get current state */
  getState(): CircuitState {
    return this.state;
  }

  /** Manually reset the circuit breaker (e.g., after config change) */
  reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
    this.openedAtMs = 0;
    info("circuit-breaker", `${this.name}: manually reset to CLOSED`);
  }
}

// ============================================================
// CIRCUIT OPEN ERROR
// ============================================================

export class CircuitOpenError extends Error {
  public readonly serviceName: string;
  public readonly lastError: string | null;

  constructor(serviceName: string, lastError: string | null) {
    super(`Circuit breaker open for ${serviceName}${lastError ? `: ${lastError}` : ""}`);
    this.name = "CircuitOpenError";
    this.serviceName = serviceName;
    this.lastError = lastError;
  }
}

// ============================================================
// SHARED BREAKER REGISTRY
// ============================================================

const breakers: Map<string, CircuitBreaker> = new Map();

/**
 * Get or create a named circuit breaker.
 * Breakers are singletons per name.
 */
export function getBreaker(name: string, opts?: Partial<CircuitBreakerOptions>): CircuitBreaker {
  let breaker = breakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker({ name, ...opts });
    breakers.set(name, breaker);
  }
  return breaker;
}

/**
 * Get stats for all registered circuit breakers.
 * Used by the /diagnose skill and health endpoints.
 */
export function getAllBreakerStats(): CircuitBreakerStats[] {
  return Array.from(breakers.values()).map((b) => b.getStats());
}

/**
 * Get a summary string for all breakers (for /status command).
 */
export function getBreakerSummary(): string {
  if (breakers.size === 0) return "No circuit breakers registered.";

  const lines: string[] = [];
  for (const b of breakers.values()) {
    const s = b.getStats();
    const stateIcon =
      s.state === "closed" ? "OK" :
      s.state === "open" ? "OPEN" :
      "PROBE";
    const avgMs = s.avgResponseMs > 0 ? `${s.avgResponseMs}ms` : "n/a";
    const errRate = s.totalRequests > 0
      ? `${Math.round((s.totalFailures / s.totalRequests) * 100)}%`
      : "0%";
    lines.push(`  ${s.name}: ${stateIcon} | ${s.totalRequests} calls, ${errRate} err, avg ${avgMs}`);
  }
  return lines.join("\n");
}

/**
 * Reset all circuit breakers (e.g., on config reload).
 */
export function resetAllBreakers(): void {
  for (const b of breakers.values()) {
    b.reset();
  }
}

// ============================================================
// PRE-CONFIGURED BREAKERS FOR ATLAS SERVICES
// ============================================================

/** GoHighLevel API — rate-limited, occasionally 500s */
export const ghlBreaker = getBreaker("GHL", {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  requestTimeoutMs: 20_000,
});

/** PV Dashboard API (Vercel) — occasionally cold starts or 502s */
export const dashboardBreaker = getBreaker("Dashboard", {
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  requestTimeoutMs: 20_000,
});

/** Google APIs (Gmail, Calendar) — generally reliable but auth can expire */
export const googleBreaker = getBreaker("Google", {
  failureThreshold: 4,
  resetTimeoutMs: 90_000,
  requestTimeoutMs: 25_000,
});

/** Google Business Profile — less critical, higher tolerance */
export const gbpBreaker = getBreaker("GBP", {
  failureThreshold: 3,
  resetTimeoutMs: 120_000,
  requestTimeoutMs: 20_000,
});

/** Google Analytics 4 — less critical, higher tolerance */
export const ga4Breaker = getBreaker("GA4", {
  failureThreshold: 3,
  resetTimeoutMs: 120_000,
  requestTimeoutMs: 20_000,
});

/** Meta Marketing API — rate limits, occasionally slow */
export const metaBreaker = getBreaker("Meta", {
  failureThreshold: 3,
  resetTimeoutMs: 90_000,
  requestTimeoutMs: 25_000,
});

/** Supabase — vector search + logging */
export const supabaseBreaker = getBreaker("Supabase", {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  requestTimeoutMs: 12_000,
});

// ============================================================
// HEALTH CHECK INTEGRATION
// ============================================================
// Register circuit breaker state as a health check hook.
// If any breaker is open, the overall system is degraded.
registerHealthCheck(() => {
  const issues: string[] = [];
  let degraded = false;

  for (const b of breakers.values()) {
    const s = b.getStats();
    if (s.state === "open") {
      issues.push(`${s.name} API circuit breaker OPEN: ${s.lastError?.substring(0, 80) || "consecutive failures"}`);
      degraded = true;
    } else if (s.state === "half_open") {
      issues.push(`${s.name} API recovering (half-open)`);
    }
  }

  return { issues, degraded };
});
