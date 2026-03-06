/**
 * MCP Shared -- TTL Cache
 *
 * Simple in-memory cache with per-key TTL support. Used across MCP servers
 * to avoid redundant API calls for data that changes infrequently
 * (tokens, config, entity lookups).
 */

// ============================================================
// TTL CACHE
// ============================================================

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private defaultTtlMs: number;

  /** @param defaultTtlMs Default time-to-live in milliseconds. */
  constructor(defaultTtlMs: number) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /** Get a value. Returns undefined if missing or expired. */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Set a value with optional per-key TTL override. */
  set(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /** Check if a key exists and is not expired. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Delete a specific key. */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /** Clear all entries. */
  clear(): void {
    this.store.clear();
  }
}

// ============================================================
// HELPER
// ============================================================

/**
 * Wrap a function with caching. If the key exists in cache, returns cached
 * value. Otherwise calls fn(), stores the result, and returns it.
 */
export async function withCache<T>(
  cache: TTLCache<T>,
  key: string,
  fn: () => Promise<T>,
  ttlMs?: number,
): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = await fn();
  cache.set(key, value, ttlMs);
  return value;
}
