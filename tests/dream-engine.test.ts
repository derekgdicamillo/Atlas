import { describe, test, expect } from "bun:test";
import {
  computeSalience,
  DEFAULT_SALIENCE_WEIGHTS,
  type SalienceWeights,
} from "../src/dream-engine.ts";

/** Build a minimal fake Supabase that handles both the memory row fetch
 *  and the attribution_log count query used by the recency component. */
function fakeSupabase(memoryRow: object | null, recentAttributionCount = 0) {
  return {
    from: (table: string) => {
      if (table === "memory") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: memoryRow, error: null }),
            }),
          }),
        };
      }
      // attribution_log count query: select("*", { count, head }) .eq() .gte()
      return {
        select: (_cols: string, _opts?: unknown) => ({
          eq: () => ({
            gte: () => Promise.resolve({ count: recentAttributionCount, error: null }),
          }),
        }),
      };
    },
  } as any;
}

describe("dream-engine salience", () => {
  test("default weights sum to 1", () => {
    const w = DEFAULT_SALIENCE_WEIGHTS;
    expect(w.access + w.recency + w.incident + w.demotion).toBeCloseTo(1, 2);
  });

  test("computeSalience caps access component at 1 (saturates at 5)", async () => {
    const out = await computeSalience(
      fakeSupabase({ id: "m1", access_count_since_rewrite: 25, demotion_pressure: 0, tags: [] }),
      "m1",
    );
    expect(out.components.access).toBe(1);
  });

  test("access component saturates at 5 accesses", async () => {
    const out = await computeSalience(
      fakeSupabase({ id: "m1", access_count_since_rewrite: 5, demotion_pressure: 0, tags: [] }),
      "m1",
    );
    expect(out.components.access).toBe(1);
  });

  test("recency component scales with attribution_log count (saturates at 5)", async () => {
    const out = await computeSalience(
      fakeSupabase({ id: "m1", access_count_since_rewrite: 0, demotion_pressure: 0, tags: [] }, 3),
      "m1",
    );
    expect(out.components.recency).toBeCloseTo(0.6, 2);
  });

  test("recency component caps at 1 when count >= 5", async () => {
    const out = await computeSalience(
      fakeSupabase({ id: "m1", access_count_since_rewrite: 0, demotion_pressure: 0, tags: [] }, 10),
      "m1",
    );
    expect(out.components.recency).toBe(1);
  });

  test("incident component is 1 when tags include 'decision'", async () => {
    const out = await computeSalience(
      fakeSupabase({ id: "m1", access_count_since_rewrite: 0, demotion_pressure: 0, tags: ["decision", "pricing"] }),
      "m1",
    );
    expect(out.components.incident).toBe(1);
  });

  test("incident component is 0 with no incident tags", async () => {
    const out = await computeSalience(
      fakeSupabase({ id: "m1", access_count_since_rewrite: 0, demotion_pressure: 0, tags: ["meta"] }),
      "m1",
    );
    expect(out.components.incident).toBe(0);
  });

  test("demotion component scales with pressure (capped at 3)", async () => {
    const out = await computeSalience(
      fakeSupabase({ id: "m1", access_count_since_rewrite: 0, demotion_pressure: 1.5, tags: [] }),
      "m1",
    );
    expect(out.components.demotion).toBeCloseTo(0.5, 2);
  });

  test("realistic high-salience memory scores > 0.5", async () => {
    // 4 accesses + 4 recent retrievals + no incident/demotion
    // Expected: 0.25*(4/5) + 0.35*(4/5) = 0.20 + 0.28 = 0.48
    const out = await computeSalience(
      fakeSupabase({ id: "m1", access_count_since_rewrite: 4, demotion_pressure: 0, tags: [] }, 4),
      "m1",
    );
    expect(out.score).toBeCloseTo(0.48, 2);
  });

  test("returns zero score for missing memory row", async () => {
    const out = await computeSalience(fakeSupabase(null), "m-nonexistent");
    expect(out.score).toBe(0);
    expect(out.components.access).toBe(0);
    expect(out.components.recency).toBe(0);
  });
});
