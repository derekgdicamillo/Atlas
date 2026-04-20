import { describe, test, expect } from "bun:test";
import { formatTrustReport } from "../src/trust-engine.ts";

describe("formatTrustReport", () => {
  test("renders a compact Telegram-friendly summary", () => {
    const text = formatTrustReport({
      byDomain: { "ad-spend": 0.84, "metrics": 0.93, "newsletter": 0.41 },
      overall: 0.73,
      eventCount: 42,
    });
    expect(text).toContain("Overall: 0.73");
    expect(text).toContain("ad-spend");
    expect(text).toContain("0.84");
    expect(text).toContain("newsletter");
  });

  test("marks below-threshold domains with a warning glyph", () => {
    const text = formatTrustReport(
      { byDomain: { "newsletter": 0.41 }, overall: 0.41, eventCount: 2 },
      { threshold: 0.65 }
    );
    expect(text).toMatch(/!|⚠/);
  });
});
