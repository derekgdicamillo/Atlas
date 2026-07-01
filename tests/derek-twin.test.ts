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

import {
  generateMorningPredictions,
  scoreEveningPredictions,
  rollingCalibration,
} from "../src/derek-twin.ts";

describe("derek-twin generateMorningPredictions", () => {
  test("inserts up to 5 prediction rows from Opus output", async () => {
    const inserted: any[] = [];
    const fakeSupabase = {
      from: (t: string) => {
        if (t === "twin_revealed_observations") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }),
          };
        }
        if (t === "twin_predictions") {
          return {
            insert: (row: any) => ({
              select: () => ({
                single: () => {
                  inserted.push(row);
                  return Promise.resolve({
                    data: { id: `id-${inserted.length}`, ...row },
                    error: null,
                  });
                },
              }),
            }),
          };
        }
        return {};
      },
    } as any;
    // Inject callOpus directly — the old SDK-client `client` opt died in the
    // CLI refactor, which left this test making a REAL 5s Opus call.
    const fakeCallOpus = async () => ({
      text: JSON.stringify([
        { prediction: "ad performance", confidence: 0.7, basis: "calendar", basis_refs: { event_id: "e1" } },
        { prediction: "esther review", confidence: 0.6, basis: "open-thread", basis_refs: { turn_id: "t1" } },
        { prediction: "PDO inventory", confidence: 0.45, basis: "day-of-week-pattern", basis_refs: null },
      ]),
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const out = await generateMorningPredictions(fakeSupabase, "derek", "2026-04-29", { callOpus: fakeCallOpus as any });
    expect(out.length).toBe(3);
    expect(inserted.length).toBe(3);
    expect(out[0].prediction).toBe("ad performance");
  });
});

describe("derek-twin scoreEveningPredictions", () => {
  test("calls Haiku-judge per prediction and updates rows", async () => {
    const updates: any[] = [];
    const fakeSupabase = {
      from: (t: string) => {
        if (t === "twin_predictions") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  is: () => Promise.resolve({
                    data: [
                      { id: "p1", prediction: "ad performance", matched_turn_id: null },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
            update: (u: any) => {
              updates.push(u);
              return { eq: () => Promise.resolve({ error: null }) };
            },
          };
        }
        if (t === "messages") {
          return {
            select: () => ({
              eq: () => ({
                gte: () => ({
                  lte: () => Promise.resolve({
                    data: [
                      { id: "t1", content: "How did yesterday's ads do?" },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    } as any;
    const callHaiku = async () => ({
      text: JSON.stringify({ matched: true, match_score: 0.85, turn_id: "t1" }),
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const out = await scoreEveningPredictions(fakeSupabase, "derek", "2026-04-29", { callHaiku });
    expect(out.scored).toBe(1);
    expect(out.calibration).toBeCloseTo(0.85, 2);
    expect(updates[0].match_score).toBeCloseTo(0.85, 2);
    expect(updates[0].matched_turn_id).toBe("t1");
  });
});

describe("derek-twin rollingCalibration", () => {
  test("computes mean across days and per_day breakdown", async () => {
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gte: () => ({
              not: () => Promise.resolve({
                data: [
                  { predicted_for: "2026-04-27", match_score: 0.6 },
                  { predicted_for: "2026-04-27", match_score: 0.8 },
                  { predicted_for: "2026-04-28", match_score: 0.5 },
                ],
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as any;
    const out = await rollingCalibration(fakeSupabase, "derek", 30);
    expect(out.n).toBe(3);
    expect(out.mean).toBeCloseTo((0.6 + 0.8 + 0.5) / 3, 2);
    expect(out.per_day).toHaveLength(2);
  });
});
