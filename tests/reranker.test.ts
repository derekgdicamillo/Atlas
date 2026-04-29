import { describe, test, expect } from "bun:test";
import { rerank, getActiveModelId, preWarm } from "../src/reranker.ts";

describe("reranker", () => {
  test("rerank with empty candidates returns empty", async () => {
    const out = await rerank("query", [], 8);
    expect(out).toEqual([]);
  });

  test("rerank preserves IDs and returns sorted scores", async () => {
    const candidates = [
      { id: "a", text: "cats are mammals" },
      { id: "b", text: "the periodic table has 118 elements" },
      { id: "c", text: "domestic cats sleep 12-16 hours daily" },
    ];
    const out = await rerank("how long do cats sleep", candidates, 3);
    expect(out).toHaveLength(3);
    // For a sleep-related query, "b" (chemistry) should be lowest.
    expect(out[out.length - 1].id).toBe("b");
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].rerank_score).toBeGreaterThanOrEqual(out[i].rerank_score);
    }
  }, 120_000);

  test("rerank topK clamps to candidate count", async () => {
    const out = await rerank("q", [{ id: "x", text: "y" }], 10);
    expect(out).toHaveLength(1);
  }, 120_000);

  test("getActiveModelId reports the loaded model", async () => {
    await rerank("warm", [{ id: "a", text: "b" }], 1);
    const id = getActiveModelId();
    expect(id === "zeta-alpha-ai/zerank-1-small" || id === "Xenova/bge-reranker-base").toBe(true);
  }, 120_000);
});
