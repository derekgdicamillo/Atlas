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
