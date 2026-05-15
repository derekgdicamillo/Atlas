import { describe, it, expect } from "bun:test";
import { capturePair, findMatchingPairs, buildInjectionBlock, type DpoPair, type MatchingPair } from "../../src/soft-dpo";

describe("soft-dpo — capture", () => {
  it("inserts a pair row with embedding via injected supabase + embedder", async () => {
    const inserts: any[] = [];
    const supabase = {
      from: () => ({ insert: (row: any) => { inserts.push(row); return { select: () => ({ single: () => Promise.resolve({ data: { id: "p1", ...row }, error: null }) }) }; } }),
    } as any;
    const embedText = async (_t: string): Promise<number[]> => Array(1536).fill(0.1);
    const pair = await capturePair(supabase, {
      source: "label_bad",
      turn_id: "t1",
      user_id: "derek",
      agent: "atlas",
      user_turn: "write a newsletter",
      atlas_original: "long thing",
      derek_corrected: "short thing",
      domain: "newsletter",
      reason: "too long",
    }, { embedText });
    expect(pair.id).toBe("p1");
    expect(inserts[0].source).toBe("label_bad");
    expect(inserts[0].embedding).toHaveLength(1536);
  });

  it("truncates long fields to 4000 chars", async () => {
    const inserts: any[] = [];
    const supabase = {
      from: () => ({ insert: (row: any) => { inserts.push(row); return { select: () => ({ single: () => Promise.resolve({ data: { id: "p1", ...row }, error: null }) }) }; } }),
    } as any;
    const embedText = async (): Promise<number[]> => Array(1536).fill(0);
    await capturePair(supabase, {
      source: "dpo_tag",
      user_id: "derek",
      agent: "atlas",
      user_turn: "x".repeat(5000),
      atlas_original: "y".repeat(5000),
      derek_corrected: "z".repeat(5000),
    }, { embedText });
    expect(inserts[0].user_turn.length).toBe(4000);
    expect(inserts[0].atlas_original.length).toBe(4000);
    expect(inserts[0].derek_corrected.length).toBe(4000);
  });
});

describe("soft-dpo — semantic match", () => {
  it("returns top-K via injected vector-search", async () => {
    const supabase = {
      rpc: (_name: string, _args: any) => Promise.resolve({
        data: [
          { id: "p1", user_turn: "a", atlas_original: "b", derek_corrected: "c", domain: "newsletter", similarity: 0.92 },
          { id: "p2", user_turn: "d", atlas_original: "e", derek_corrected: "f", domain: "newsletter", similarity: 0.85 },
        ],
        error: null,
      }),
    } as any;
    const embedText = async (): Promise<number[]> => Array(1536).fill(0);
    const matches = await findMatchingPairs(supabase, { query: "newsletter prompt", domain: "newsletter", k: 3, embedText });
    expect(matches).toHaveLength(2);
    expect(matches[0].id).toBe("p1");
  });

  it("returns empty on RPC error", async () => {
    const supabase = {
      rpc: () => Promise.resolve({ data: null, error: { message: "not found" } }),
    } as any;
    const embedText = async (): Promise<number[]> => Array(1536).fill(0);
    const matches = await findMatchingPairs(supabase, { query: "x", k: 3, embedText });
    expect(matches).toEqual([]);
  });
});

describe("soft-dpo — injection block", () => {
  it("returns empty string when no pairs", () => {
    expect(buildInjectionBlock([])).toBe("");
  });
  it("builds markdown block with user_id attribution", () => {
    const pairs: MatchingPair[] = [{
      id: "p1",
      source: "label_bad",
      user_id: "derek",
      agent: "atlas",
      user_turn: "u",
      atlas_original: "old answer",
      derek_corrected: "new answer",
      reason: "shorter",
    }];
    const block = buildInjectionBlock(pairs);
    expect(block).toContain("Recent corrections");
    expect(block).toContain("derek wanted");
    expect(block).toContain("old answer");
    expect(block).toContain("new answer");
  });
});
