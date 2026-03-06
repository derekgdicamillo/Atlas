/**
 * MCP Shared -- Circuit Breaker
 *
 * Simplified circuit breaker for MCP server API calls. Same three-state
 * pattern as src/circuit-breaker.ts but without Atlas-specific dependencies
 * (logger, health checks, redaction). Standalone and dependency-free.
 */

import { warn, log } from "./logger.js";

// ============================================================
// TYPES
// ============================================================

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Service name for logging. */
  name: string;
  /** MCP server name for log prefix. */
  server?: string;
  /** Failures before opening (default 3). */
  failureThreshold?: number;
  /** Ms to stay open before probing (default 60_000). */
  resetTimeoutMs?: number;
  /** Successes in half-open to close (default 1). */
  halfOpenAttempts?: number;
}

// ============================================================
// CIRCUIT BREAKER
// ============================================================

export class CircuitBreaker {
  private name: string;
  private server: string;
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private openedAtMs = 0;
  private lastError: string | null = null;

  private failureThreshold: number;
  private resetTimeoutMs: number;
  private halfOpenAttempts: number;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.server = opts.server ?? opts.name;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 60_000;
    this.halfOpenAttempts = opts.halfOpenAttempts ?? 1;
  }

  /**
   * Execute a function through the breaker.
   * Throws CircuitOpenError if the circuit is open and not yet ready to probe.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.openedAtMs >= this.resetTimeoutMs) {
        this.state = "half_open";
        this.successes = 0;
        log(this.server, `${this.name}: OPEN -> HALF_OPEN (probing)`);
      } else {
        throw new CircuitOpenError(this.name, this.lastError);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  /** Get current circuit state. */
  getState(): CircuitState {
    return this.state;
  }

  /** Manually reset to closed. */
  reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.openedAtMs = 0;
    this.lastError = null;
    log(this.server, `${this.name}: manually reset to CLOSED`);
  }

  private onSuccess(): void {
    if (this.state === "half_open") {
      this.successes++;
      if (this.successes >= this.halfOpenAttempts) {
        this.state = "closed";
        this.failures = 0;
        this.successes = 0;
        log(this.server, `${this.name}: HALF_OPEN -> CLOSED (recovered)`);
      }
    } else if (this.state === "closed") {
      this.failures = 0;
    }
  }

  private onFailure(err: unknown): void {
    this.failures++;
    this.lastError = err instanceof Error ? err.message : String(err);

    if (this.state === "half_open") {
      this.state = "open";
      this.openedAtMs = Date.now();
      warn(this.server, `${this.name}: HALF_OPEN -> OPEN (probe failed: ${this.lastError})`);
    } else if (this.state === "closed" && this.failures >= this.failureThreshold) {
      this.state = "open";
      this.openedAtMs = Date.now();
      warn(this.server, `${this.name}: CLOSED -> OPEN (${this.failures} failures: ${this.lastError})`);
    }
  }
}

// ============================================================
// ERROR
// ============================================================

export class CircuitOpenError extends Error {
  public readonly serviceName: string;
  public readonly lastError: string | null;

  constructor(serviceName: string, lastError: string | null) {
    super(`Circuit open for ${serviceName}${lastError ? `: ${lastError}` : ""}`);
    this.name = "CircuitOpenError";
    this.serviceName = serviceName;
    this.lastError = lastError;
  }
}

// ============================================================
// HELPER
// ============================================================

/**
 * Run a function through a circuit breaker. Convenience wrapper
 * that reads slightly cleaner in tool handlers.
 */
export async function withBreaker<T>(breaker: CircuitBreaker, fn: () => Promise<T>): Promise<T> {
  return breaker.call(fn);
}
