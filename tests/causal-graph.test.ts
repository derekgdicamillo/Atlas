import { describe, test, expect } from "bun:test";
import {
  walkPath,
  pendingApprovals,
  approveEdge,
  falsifyEdge,
  type CausalEdge,
  type CausalNode,
} from "../src/causal-graph.ts";

describe("causal-graph query API", () => {
  test("walkPath returns null when from-node not found", async () => {
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    } as any;
    const out = await walkPath(fakeSupabase, "nonexistent_a", "nonexistent_b", 3);
    expect(out).toBeNull();
  });

  test("pendingApprovals queries approved=false ordered by created_at desc", async () => {
    let queryShape: any = {};
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: (col: string, val: any) => {
            queryShape.eq = { col, val };
            return {
              order: (col: string, opts: any) => {
                queryShape.order = { col, opts };
                return {
                  limit: (n: number) => {
                    queryShape.limit = n;
                    return Promise.resolve({
                      data: [
                        { id: "e1", approved: false, status: "hypothesized",
                          proposed_by: "llm", evidence: [], from_node: "a", to_node: "b" },
                      ],
                      error: null,
                    });
                  },
                };
              },
            };
          },
        }),
      }),
    } as any;
    const out = await pendingApprovals(fakeSupabase, 20);
    expect(out).toHaveLength(1);
    expect(queryShape.eq).toEqual({ col: "approved", val: false });
    expect(queryShape.order.col).toBe("created_at");
    expect(queryShape.order.opts.ascending).toBe(false);
    expect(queryShape.limit).toBe(20);
  });

  test("approveEdge sets approved=true with approver, flips natural-experiment to observed", async () => {
    const updates: any[] = [];
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: {
                id: "e1",
                proposed_by: "natural-experiment",
                effect_size: 12,
                status: "hypothesized",
              },
              error: null,
            }),
          }),
        }),
        update: (u: any) => {
          updates.push(u);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      }),
    } as any;
    await approveEdge(fakeSupabase, "e1", "derek");
    expect(updates[0].approved).toBe(true);
    expect(updates[0].approved_by).toBe("derek");
    expect(updates[0].status).toBe("observed");
  });

  test("approveEdge does NOT flip status for non-natural-experiment edges", async () => {
    const updates: any[] = [];
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: { id: "e1", proposed_by: "llm", effect_size: 5, status: "hypothesized" },
              error: null,
            }),
          }),
        }),
        update: (u: any) => {
          updates.push(u);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      }),
    } as any;
    await approveEdge(fakeSupabase, "e1", "derek");
    expect(updates[0].approved).toBe(true);
    expect(updates[0].status).toBeUndefined();
  });

  test("falsifyEdge sets status=falsified and writes reason to notes", async () => {
    const updates: any[] = [];
    const fakeSupabase = {
      from: () => ({
        update: (u: any) => {
          updates.push(u);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      }),
    } as any;
    await falsifyEdge(fakeSupabase, "e1", "later analysis: correlation, not causation");
    expect(updates[0].status).toBe("falsified");
    expect(updates[0].notes).toContain("correlation");
  });
});
