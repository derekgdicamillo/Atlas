import { describe, it, expect } from "bun:test";
import { judgeShadowOutput, computePromotion, computeDemotion } from "../../src/skill-shadow-router";

describe("skill-shadow-router — judge", () => {
  it("parses verdict from Haiku JSON", async () => {
    const callHaiku = async () => ({
      text: JSON.stringify({ verdict: "shadow_wins", reason: "shadow output is concise and accurate" }),
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const out = await judgeShadowOutput(
      { task_description: "summarize" },
      "baseline output",
      "shadow output",
      { callHaiku }
    );
    expect(out.verdict).toBe("shadow_wins");
    expect(out.reason).toContain("concise");
  });

  it("throws on malformed Haiku output", async () => {
    const callHaiku = async () => ({ text: "not json", usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(
      judgeShadowOutput({ task_description: "x" }, "a", "b", { callHaiku })
    ).rejects.toThrow(/parse/i);
  });

  it("throws on invalid verdict value", async () => {
    const callHaiku = async () => ({ text: JSON.stringify({ verdict: "bogus", reason: "x" }), usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(
      judgeShadowOutput({ task_description: "x" }, "a", "b", { callHaiku })
    ).rejects.toThrow(/invalid verdict/i);
  });
});

describe("skill-shadow-router — promotion math", () => {
  it("promotes at exactly 7 wins of last 10 (excluding vetoed)", () => {
    const scores = [
      ...Array(7).fill({ judge_verdict: "shadow_wins", derek_veto: false }),
      ...Array(3).fill({ judge_verdict: "baseline_wins", derek_veto: false }),
    ];
    expect(computePromotion(scores).promote).toBe(true);
  });
  it("does not promote with 6 wins", () => {
    const scores = [
      ...Array(6).fill({ judge_verdict: "shadow_wins", derek_veto: false }),
      ...Array(4).fill({ judge_verdict: "baseline_wins", derek_veto: false }),
    ];
    expect(computePromotion(scores).promote).toBe(false);
  });
  it("excludes Derek-vetoed wins from the count", () => {
    const scores = [
      ...Array(7).fill({ judge_verdict: "shadow_wins", derek_veto: true }),
      ...Array(3).fill({ judge_verdict: "baseline_wins", derek_veto: false }),
    ];
    expect(computePromotion(scores).promote).toBe(false);
  });
  it("requires a full window of 10", () => {
    const scores = Array(5).fill({ judge_verdict: "shadow_wins", derek_veto: false });
    expect(computePromotion(scores).promote).toBe(false);
  });
});

describe("skill-shadow-router — demotion math", () => {
  it("demotes at 7+ baseline_wins in window", () => {
    const scores = [
      ...Array(7).fill({ judge_verdict: "baseline_wins", derek_veto: false }),
      ...Array(3).fill({ judge_verdict: "shadow_wins", derek_veto: false }),
    ];
    expect(computeDemotion(scores).demote).toBe(true);
  });
  it("does not demote with 6 baseline_wins", () => {
    const scores = [
      ...Array(6).fill({ judge_verdict: "baseline_wins", derek_veto: false }),
      ...Array(4).fill({ judge_verdict: "shadow_wins", derek_veto: false }),
    ];
    expect(computeDemotion(scores).demote).toBe(false);
  });
});
