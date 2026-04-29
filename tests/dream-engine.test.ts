import { describe, test, expect } from "bun:test";
import {
  computeSalience,
  DEFAULT_SALIENCE_WEIGHTS,
  type SalienceWeights,
} from "../src/dream-engine.ts";

describe("dream-engine salience", () => {
  test("default weights sum to 1", () => {
    const w = DEFAULT_SALIENCE_WEIGHTS;
    expect(w.access + w.trust + w.incident + w.demotion).toBeCloseTo(1, 2);
  });

  test("computeSalience caps access component at 1", async () => {
    const fakeSupabase = {
      from: (t: string) => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: t === "memory"
                ? {
                    id: "m1",
                    access_count_since_rewrite: 25,
                    demotion_pressure: 0,
                    tags: [],
                  }
                : null,
              error: null,
            }),
            gte: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as any;
    const out = await computeSalience(fakeSupabase, "m1");
    expect(out.components.access).toBe(1);
  });

  test("incident component is 1 when tags include 'decision'", async () => {
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: {
                id: "m1",
                access_count_since_rewrite: 0,
                demotion_pressure: 0,
                tags: ["decision", "pricing"],
              },
              error: null,
            }),
            gte: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as any;
    const out = await computeSalience(fakeSupabase, "m1");
    expect(out.components.incident).toBe(1);
  });

  test("incident component is 0 with no incident tags", async () => {
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: { id: "m1", access_count_since_rewrite: 0, demotion_pressure: 0, tags: ["meta"] },
              error: null,
            }),
            gte: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as any;
    const out = await computeSalience(fakeSupabase, "m1");
    expect(out.components.incident).toBe(0);
  });

  test("demotion component scales with pressure (capped at 3)", async () => {
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: { id: "m1", access_count_since_rewrite: 0, demotion_pressure: 1.5, tags: [] },
              error: null,
            }),
            gte: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as any;
    const out = await computeSalience(fakeSupabase, "m1");
    expect(out.components.demotion).toBeCloseTo(0.5, 2);
  });

  test("returns zero score for missing memory row", async () => {
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: null, error: null }),
            gte: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    } as any;
    const out = await computeSalience(fakeSupabase, "m-nonexistent");
    expect(out.score).toBe(0);
    expect(out.components.access).toBe(0);
  });
});
