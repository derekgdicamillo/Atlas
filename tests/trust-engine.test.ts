import { describe, test, expect } from "bun:test";
import {
  computeDomainTrust,
  aggregateTrust,
  shouldEscalate,
  type TrustEvent,
} from "../src/trust-engine.ts";

describe("trust-engine", () => {
  const now = new Date("2026-04-19T12:00:00Z").getTime();
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

  test("pure wins in last 7 days yield score near 1", () => {
    const events: TrustEvent[] = [
      { ts: daysAgo(1), domain: "ad-spend", delta: +1 },
      { ts: daysAgo(3), domain: "ad-spend", delta: +1 },
      { ts: daysAgo(5), domain: "ad-spend", delta: +1 },
    ];
    const score = computeDomainTrust("ad-spend", events, now);
    expect(score).toBeGreaterThan(0.9);
  });

  test("pure losses drive score toward 0", () => {
    const events: TrustEvent[] = [
      { ts: daysAgo(1), domain: "ad-spend", delta: -1 },
      { ts: daysAgo(2), domain: "ad-spend", delta: -1 },
    ];
    const score = computeDomainTrust("ad-spend", events, now);
    expect(score).toBeLessThan(0.2);
  });

  test("old losses decay — 90-day-old loss has small effect", () => {
    const events: TrustEvent[] = [
      { ts: daysAgo(90), domain: "metrics", delta: -1 },
      { ts: daysAgo(1), domain: "metrics", delta: +1 },
    ];
    const score = computeDomainTrust("metrics", events, now);
    expect(score).toBeGreaterThan(0.7);
  });

  test("unknown domain returns 0.5 (neutral prior)", () => {
    const score = computeDomainTrust("brand-new-domain", [], now);
    expect(score).toBe(0.5);
  });

  test("aggregateTrust returns per-domain map + overall", () => {
    const events: TrustEvent[] = [
      { ts: daysAgo(1), domain: "metrics", delta: +1 },
      { ts: daysAgo(1), domain: "ad-spend", delta: -1 },
    ];
    const a = aggregateTrust(events, now);
    expect(a.byDomain["metrics"]).toBeGreaterThan(0.5);
    expect(a.byDomain["ad-spend"]).toBeLessThan(0.5);
    expect(a.overall).toBeGreaterThan(0);
    expect(a.overall).toBeLessThan(1);
  });

  test("shouldEscalate returns true when domain trust below threshold", () => {
    const events: TrustEvent[] = [{ ts: daysAgo(1), domain: "ad-spend", delta: -1 }];
    expect(shouldEscalate("ad-spend", events, 0.7, now)).toBe(true);
    expect(shouldEscalate("ad-spend", events, 0.1, now)).toBe(false);
  });
});
