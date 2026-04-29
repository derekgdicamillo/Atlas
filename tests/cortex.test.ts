import { describe, test, expect } from "bun:test";
import {
  TIERS,
  type Tier,
  recordAttribution,
  recordFailure,
  computePressure,
  type FailureSource,
  FAILURE_WEIGHTS,
  DEMOTION_THRESHOLD,
  MAX_INVERSION_DEPTH,
} from "../src/cortex.ts";

describe("cortex foundation", () => {
  test("TIERS is exhaustive 7-tuple in correct order", () => {
    expect(TIERS).toEqual([
      "sensory",
      "working",
      "session",
      "episodic",
      "semantic",
      "procedural",
      "identity",
    ]);
  });

  test("FAILURE_WEIGHTS matches spec", () => {
    expect(FAILURE_WEIGHTS["replay-judge"]).toBe(0.5);
    expect(FAILURE_WEIGHTS["derek-correction"]).toBe(1.0);
    expect(FAILURE_WEIGHTS["trust-event"]).toBe(0.7);
  });

  test("DEMOTION_THRESHOLD = 3.0 and MAX_INVERSION_DEPTH = 2", () => {
    expect(DEMOTION_THRESHOLD).toBe(3.0);
    expect(MAX_INVERSION_DEPTH).toBe(2);
  });

  test("computePressure sums weighted events correctly", () => {
    const events = [
      { source: "derek-correction" as FailureSource, ts: "2026-04-01T00:00:00Z" },
      { source: "replay-judge" as FailureSource, ts: "2026-04-02T00:00:00Z" },
      { source: "trust-event" as FailureSource, ts: "2026-04-03T00:00:00Z" },
    ];
    expect(computePressure(events)).toBeCloseTo(1.0 + 0.5 + 0.7, 5);
  });

  test("recordAttribution writes one row per (turn, memory) pair", async () => {
    const inserted: any[] = [];
    const fakeSupabase = {
      from: (_t: string) => ({
        insert: (rows: any[]) => {
          inserted.push(...rows);
          return Promise.resolve({ error: null });
        },
      }),
    } as any;
    await recordAttribution(fakeSupabase, {
      turn_id: "t1",
      user_id: "u1",
      agent: "atlas",
      memories: [
        { id: "m1", rank: 0, rerank_score: 0.92 },
        { id: "m2", rank: 1, rerank_score: 0.81 },
      ],
    });
    expect(inserted).toHaveLength(2);
    expect(inserted[0].turn_id).toBe("t1");
    expect(inserted[0].memory_id).toBe("m1");
    expect(inserted[0].rank).toBe(0);
    expect(inserted[0].rerank_score).toBe(0.92);
  });

  test("recordAttribution with empty memories is a no-op", async () => {
    let called = false;
    const fakeSupabase = {
      from: () => ({ insert: () => { called = true; return Promise.resolve({ error: null }); } }),
    } as any;
    await recordAttribution(fakeSupabase, {
      turn_id: "t1",
      user_id: "u1",
      agent: "atlas",
      memories: [],
    });
    expect(called).toBe(false);
  });

  test("recordFailure looks up contributors and calls memory_record_failure RPC", async () => {
    const rpcCalls: any[] = [];
    const fakeSupabase = {
      from: (_t: string) => ({
        select: () => ({
          eq: () => Promise.resolve({
            data: [{ memory_id: "m1" }, { memory_id: "m2" }],
            error: null,
          }),
        }),
      }),
      rpc: (name: string, args: any) => {
        rpcCalls.push({ name, args });
        return Promise.resolve({ error: null });
      },
    } as any;
    await recordFailure(fakeSupabase, {
      turn_id: "t1",
      source: "derek-correction",
      reason: "outdated pricing",
    });
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].name).toBe("memory_record_failure");
    expect(rpcCalls[0].args.p_memory_id).toBe("m1");
    expect(rpcCalls[0].args.p_weight).toBe(1.0);
    expect(rpcCalls[0].args.p_event.source).toBe("derek-correction");
    expect(rpcCalls[0].args.p_event.reason).toBe("outdated pricing");
  });

  test("recordFailure with no contributors is a graceful no-op", async () => {
    let rpcCalled = false;
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
      rpc: () => { rpcCalled = true; return Promise.resolve({ error: null }); },
    } as any;
    await recordFailure(fakeSupabase, {
      turn_id: "t-empty",
      source: "replay-judge",
    });
    expect(rpcCalled).toBe(false);
  });
});

import { executeDemotion, composeInversion, type MemoryRow } from "../src/cortex.ts";

describe("cortex demotion", () => {
  const baseRow: MemoryRow = {
    id: "m1",
    content: "Tirzepatide costs $400/month",
    summary: "Tirzepatide costs $400/month",
    original_content: "Tirzepatide costs $400/month",
    class: "semantic",
    demotion_pressure: 3.2,
    demotion_events: [
      { source: "derek-correction", ts: "2026-04-01T00:00:00Z", reason: "outdated pricing" },
      { source: "derek-correction", ts: "2026-04-05T00:00:00Z", reason: "ignored Hallandale switch" },
      { source: "derek-correction", ts: "2026-04-10T00:00:00Z", reason: "wrong pharmacy listed" },
    ],
    inverted_from: null,
    inversion_depth: 0,
    tags: ["pricing", "tirzepatide"],
    created_at: "2026-03-01T00:00:00Z",
  };

  test("composeInversion produces a hindsight-formatted entry", () => {
    const inv = composeInversion(baseRow, "2026-04-15");
    expect(inv.content).toContain("AS OF 2026-04-15");
    expect(inv.content).toContain("Tirzepatide costs $400/month");
    expect(inv.content).toContain("3 times");
    expect(inv.class).toBe("episodic");
    expect(inv.inverted_from).toBe("m1");
    expect(inv.inversion_depth).toBe(1);
  });

  test("composeInversion includes reasons when present", () => {
    const inv = composeInversion(baseRow, "2026-04-15");
    expect(inv.content).toContain("outdated pricing");
  });

  test("composeInversion at depth 1 produces depth 2", () => {
    const inv = composeInversion({ ...baseRow, inversion_depth: 1 }, "2026-04-15");
    expect(inv.inversion_depth).toBe(2);
  });

  test("executeDemotion below threshold is no-op", async () => {
    const updates: any[] = [];
    const inserts: any[] = [];
    const fakeSupabase = {
      from: () => ({
        update: (u: any) => {
          updates.push(u);
          return { eq: () => Promise.resolve({ error: null }) };
        },
        insert: (rows: any[]) => {
          inserts.push(...rows);
          return Promise.resolve({ error: null });
        },
      }),
    } as any;
    const result = await executeDemotion(fakeSupabase, { ...baseRow, demotion_pressure: 2.5 });
    expect(result.demoted).toBe(false);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  test("executeDemotion at threshold demotes + writes inversion", async () => {
    const updates: any[] = [];
    const inserts: any[] = [];
    const fakeSupabase = {
      from: () => ({
        update: (u: any) => {
          updates.push(u);
          return { eq: () => Promise.resolve({ error: null }) };
        },
        insert: (rows: any[]) => {
          inserts.push(...rows);
          return Promise.resolve({ error: null });
        },
      }),
    } as any;
    const result = await executeDemotion(fakeSupabase, baseRow);
    expect(result.demoted).toBe(true);
    expect(result.inverted).toBe(true);
    expect(updates[0].class).toBe("demoted");
    expect(inserts[0].inverted_from).toBe("m1");
    expect(inserts[0].inversion_depth).toBe(1);
  });

  test("executeDemotion at max depth refuses further inversion", async () => {
    const inserts: any[] = [];
    const fakeSupabase = {
      from: () => ({
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        insert: (rows: any[]) => {
          inserts.push(...rows);
          return Promise.resolve({ error: null });
        },
      }),
    } as any;
    const deep = { ...baseRow, inversion_depth: 2 };
    const result = await executeDemotion(fakeSupabase, deep);
    expect(result.demoted).toBe(true);
    expect(result.inverted).toBe(false);
    expect(result.alertReason).toContain("max inversion depth");
    expect(inserts).toHaveLength(0);
  });
});
