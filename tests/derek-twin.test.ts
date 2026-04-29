import { describe, test, expect } from "bun:test";
import {
  classifyObservation,
  recomputeDivergence,
  formatTwinReport,
  type DivergenceRow,
  type TwinPrediction,
} from "../src/derek-twin.ts";

describe("derek-twin classifyObservation", () => {
  test("returns one of the 4 valid signals", async () => {
    const callHaiku = async () => ({
      text: JSON.stringify({
        signal: "rewrite_diverge",
        rationale: "extended a 100-word reply to 400 words despite 'concise' preference",
      }),
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const out = await classifyObservation({
      preference_text: "concise responses",
      atlas_output: "Yes.",
      user_followup: "Can you elaborate? I need details on X, Y, Z.",
      callHaiku,
    });
    expect(["accept", "rewrite_align", "rewrite_diverge", "reject"]).toContain(out.signal);
    expect(out.signal).toBe("rewrite_diverge");
    expect(out.rationale).toContain("400 words");
  });

  test("rejects malformed Haiku output", async () => {
    const callHaiku = async () => ({ text: "not json", usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(
      classifyObservation({
        preference_text: "x",
        atlas_output: "y",
        user_followup: "z",
        callHaiku,
      })
    ).rejects.toThrow(/parse/i);
  });

  test("rejects invalid signal value", async () => {
    const callHaiku = async () => ({
      text: JSON.stringify({ signal: "bogus", rationale: "x" }),
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await expect(
      classifyObservation({
        preference_text: "x",
        atlas_output: "y",
        user_followup: "z",
        callHaiku,
      })
    ).rejects.toThrow(/invalid signal/i);
  });
});

describe("derek-twin recomputeDivergence", () => {
  test("computes revealed_score = (accept + rewrite_align) / total", async () => {
    const inserts: any[] = [];
    const fakeSupabase = {
      from: (t: string) => {
        if (t === "twin_stated_preferences") {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({
                  data: { id: "p1", preference: "concise", domain: null, user_id: "derek" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (t === "twin_revealed_observations") {
          return {
            select: () => ({
              eq: () => ({
                order: () => Promise.resolve({
                  data: [
                    { signal: "accept" },
                    { signal: "accept" },
                    { signal: "rewrite_align" },
                    { signal: "rewrite_diverge" },
                    { signal: "rewrite_diverge" },
                    { signal: "reject" },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (t === "twin_divergence") {
          return {
            insert: (row: any) => {
              inserts.push(row);
              return Promise.resolve({ error: null });
            },
          };
        }
        return {};
      },
    } as any;
    const out = await recomputeDivergence(fakeSupabase, "p1", null);
    expect(out.revealed_score).toBeCloseTo(0.5, 2);
    expect(out.gap).toBeCloseTo(0.5, 2);
    expect(out.sample_size).toBe(6);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].revealed_score).toBeCloseTo(0.5, 2);
  });
});

describe("formatTwinReport", () => {
  test("includes calibration and top divergences", () => {
    const divs: DivergenceRow[] = [{
      preference_id: "p1",
      preference_text: "concise medical replies",
      domain: "medical",
      stated_score: 1,
      revealed_score: 0.4,
      gap: 0.6,
      sample_size: 12,
    }];
    const preds: TwinPrediction[] = [{
      id: "x",
      prediction: "ad performance",
      confidence: 0.7,
      basis: "calendar",
      basis_refs: null,
      matched_turn_id: null,
      match_score: null,
    }];
    const report = formatTwinReport({ divergences: divs, todays_predictions: preds, calibration_30d: 0.62 });
    expect(report).toContain("Twin Report");
    expect(report).toContain("0.62");
    expect(report).toContain("concise medical replies");
    expect(report).toContain("0.6");
    expect(report).toContain("ad performance");
  });

  test("handles empty divergences and predictions gracefully", () => {
    const report = formatTwinReport({ divergences: [], todays_predictions: [], calibration_30d: 0.5 });
    expect(report).toContain("Twin Report");
    expect(report).toContain("0.5");
  });
});
