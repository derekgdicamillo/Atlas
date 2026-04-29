import { describe, test, expect } from "bun:test";
import { applyDagEffects, type ForecastBands } from "../src/world-model.ts";

describe("world-model applyDagEffects", () => {
  const baseline: ForecastBands = {
    p05: [10, 11, 12, 13, 14],
    p50: [12, 13, 14, 15, 16],
    p95: [14, 15, 16, 17, 18],
  };

  test("with no edges returns baseline unchanged", () => {
    const out = applyDagEffects(baseline, [], 0);
    expect(out.p50).toEqual(baseline.p50);
    expect(out.p05).toEqual(baseline.p05);
    expect(out.p95).toEqual(baseline.p95);
  });

  test("direct edge with positive effect_size raises p50 from action_day onward", () => {
    const edges: any[] = [{
      id: "e1", from_node: "a", to_node: "b", effect_size: 5,
      effect_ci: { low: 3, high: 7 }, evidence: [],
      status: "observed", proposed_by: "natural-experiment",
      approved: true,
    }];
    const out = applyDagEffects(baseline, edges, 2);
    expect(out.p50[0]).toBe(12);
    expect(out.p50[1]).toBe(13);
    expect(out.p50[2]).toBe(19);
    expect(out.p50[3]).toBe(20);
    expect(out.p50[4]).toBe(21);
    expect(out.p95[2]).toBeGreaterThan(baseline.p95[2]);
  });

  test("multiple edges stack additively", () => {
    const edges: any[] = [
      { id: "e1", effect_size: 3, effect_ci: { low: 2, high: 4 } },
      { id: "e2", effect_size: 2, effect_ci: { low: 1, high: 3 } },
    ];
    const out = applyDagEffects(baseline, edges, 0);
    expect(out.p50[0]).toBe(17);
  });

  test("edges without effect_ci use a default 40% width", () => {
    const edges: any[] = [
      { id: "e1", effect_size: 10, effect_ci: null, evidence: [] },
    ];
    const out = applyDagEffects(baseline, edges, 0);
    expect(out.p50[0]).toBe(22);
    expect(out.p95[0]).toBeCloseTo(baseline.p95[0] + 10 + 4 / 2, 1);  // 14 + 10 + 2 = 26
    expect(out.p05[0]).toBeCloseTo(baseline.p05[0] + 10 - 4 / 2, 1);  // 10 + 10 - 2 = 18
  });

  test("edges with null effect_size are skipped", () => {
    const edges: any[] = [
      { id: "e1", effect_size: null, effect_ci: null, evidence: [] },
    ];
    const out = applyDagEffects(baseline, edges, 0);
    expect(out.p50).toEqual(baseline.p50);
  });

  test("actionDay beyond horizon does not modify anything", () => {
    const edges: any[] = [{ id: "e1", effect_size: 5, effect_ci: { low: 3, high: 7 } }];
    const out = applyDagEffects(baseline, edges, 100);
    expect(out.p50).toEqual(baseline.p50);
  });
});
