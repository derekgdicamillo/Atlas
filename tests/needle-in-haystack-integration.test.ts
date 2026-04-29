import { describe, test, expect } from "bun:test";
import { rerank } from "../src/reranker.ts";

describe("needle in haystack integration", () => {
  test("reranker promotes a textually-relevant chunk over many distractors", async () => {
    const distractors = Array.from({ length: 49 }, (_, i) => ({
      id: `d${i}`,
      text: `Random fact number ${i} about quantum mechanics and the structure of subatomic particles.`,
    }));
    const needle = {
      id: "needle",
      text: "Tirzepatide compound pricing at Hallandale dropped from $400 to $320 in November 2025.",
    };
    const candidates = [
      ...distractors.slice(0, 25),
      needle,
      ...distractors.slice(25),
    ];
    const out = await rerank(
      "What's the current Tirzepatide compound price at Hallandale?",
      candidates,
      3
    );
    const ids = out.map((r) => r.id);
    expect(ids).toContain("needle");
  }, 180_000);  // allow 3 minutes for cold-start in worst case
});
