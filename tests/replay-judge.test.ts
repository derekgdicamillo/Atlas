import { describe, test, expect } from "bun:test";
import { scoreEntry, type JudgeScore } from "../src/replay-judge.ts";
import type { ReplayEntry } from "../src/replay-dataset.ts";

const STUB_ENTRY: ReplayEntry = {
  id: "test-1",
  capturedAt: "2026-03-01T00:00:00.000Z",
  agent: "atlas",
  userTurn: "what's revenue MTD?",
  contextSummary: "scorecard present",
  atlasResponse: "MTD revenue is $42,100 per business_scorecard.",
  derekCorrection: null,
  label: "good",
  tags: ["metrics"],
};

describe("replay-judge", () => {
  test("scoreEntry returns JudgeScore with all axes in [0,1]", async () => {
    const mockJson = {
      groundedness: 0.9,
      tool_correctness: 0.85,
      refusal_calibration: 0.8,
      rationale: "Cited source, no hallucination.",
    };
    const callHaiku = async () => ({
      text: JSON.stringify(mockJson),
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const score = await scoreEntry(STUB_ENTRY, { callHaiku });
    expect(score.groundedness).toBe(0.9);
    expect(score.tool_correctness).toBe(0.85);
    expect(score.refusal_calibration).toBe(0.8);
    expect(score.aggregate).toBeGreaterThan(0);
    expect(score.aggregate).toBeLessThanOrEqual(1);
    expect(score.rationale).toContain("Cited");
  });

  test("scoreEntry throws on malformed judge output", async () => {
    const callHaiku = async () => ({
      text: "not json",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(scoreEntry(STUB_ENTRY, { callHaiku })).rejects.toThrow(/parse/i);
  });

  test("scoreEntry clamps out-of-range scores", async () => {
    const callHaiku = async () => ({
      text: JSON.stringify({
        groundedness: 1.3,
        tool_correctness: -0.2,
        refusal_calibration: 0.5,
        rationale: "x",
      }),
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const s = await scoreEntry(STUB_ENTRY, { callHaiku });
    expect(s.groundedness).toBe(1);
    expect(s.tool_correctness).toBe(0);
  });
});
