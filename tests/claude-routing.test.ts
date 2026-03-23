import { describe, test, expect } from "bun:test";
import { shouldUsePersistent } from "../src/claude.ts";

describe("shouldUsePersistent routing", () => {
  test("returns true for interactive calls (skipLock: true)", () => {
    expect(shouldUsePersistent({ skipLock: true })).toBe(true);
  });

  test("returns true with skipLock and model specified", () => {
    expect(shouldUsePersistent({ skipLock: true })).toBe(true);
  });

  test("returns false for isolated calls", () => {
    expect(shouldUsePersistent({ isolated: true })).toBe(false);
  });

  test("returns false for fallback calls", () => {
    expect(shouldUsePersistent({ _isFallback: true } as any)).toBe(false);
  });

  test("returns false when persistent: false is explicit", () => {
    expect(shouldUsePersistent({ persistent: false })).toBe(false);
  });

  test("returns false for cron-style calls (lockBehavior: skip)", () => {
    expect(shouldUsePersistent({ lockBehavior: "skip" })).toBe(false);
  });

  test("returns false with no options", () => {
    expect(shouldUsePersistent()).toBe(false);
    expect(shouldUsePersistent(undefined)).toBe(false);
  });

  test("returns true when persistent: true overrides everything", () => {
    expect(shouldUsePersistent({ persistent: true, isolated: true })).toBe(true);
  });

  test("returns false for empty retry", () => {
    expect(shouldUsePersistent({ _isEmptyRetry: true } as any)).toBe(false);
  });

  test("returns false for spawn retry", () => {
    expect(shouldUsePersistent({ _isSpawnRetry: true } as any)).toBe(false);
  });
});
