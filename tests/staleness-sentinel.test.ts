import { describe, test, expect } from "bun:test";
import { classifyByTriggers } from "../src/staleness-sentinel.ts";

describe("staleness-sentinel — trigger-based fallback classifier", () => {
  test("detects GHL questions via trigger match", () => {
    const r = classifyByTriggers("how do I enroll a contact in a GHL workflow?");
    expect(r.tier).toBe("fast");
    expect(r.matchedDomain).toBe("gohighlevel");
  });

  test("detects Claude Code questions", () => {
    const r = classifyByTriggers("what's the new hooks API in claude code?");
    expect(r.tier).toBe("fast");
    expect(r.matchedDomain).toBe("claude_code");
  });

  test("timeless for general business strategy", () => {
    const r = classifyByTriggers("what's buffett's view on pricing power?");
    expect(r.tier).toBe("timeless");
    expect(r.matchedDomain).toBeUndefined();
  });

  test("multiple triggers picks shortest half-life", () => {
    const r = classifyByTriggers("how do I integrate Meta ads with GoHighLevel workflows?");
    // claude_code=14, anthropic_api=21, gohighlevel=30, meta_ads=45 — GHL wins
    expect(r.matchedDomain).toBe("gohighlevel");
  });
});
