import { describe, test, expect } from "bun:test";
import { computeDelta, permutationPValue } from "../src/causal-discovery.ts";

describe("causal-discovery natural-experiment helpers", () => {
  test("computeDelta returns mean(post) - mean(pre)", () => {
    const pre = [10, 12, 11, 9, 13];
    const post = [18, 17, 22, 20, 19];
    expect(computeDelta(pre, post)).toBeCloseTo(8.2, 1);
  });

  test("computeDelta with empty arrays returns 0", () => {
    expect(computeDelta([], [])).toBe(0);
  });

  test("permutationPValue is small when groups differ strongly", () => {
    const pre = [1, 2, 1, 2, 1, 2, 1, 2];
    const post = [10, 11, 10, 11, 10, 11, 10, 11];
    const p = permutationPValue(pre, post, 200);
    expect(p).toBeLessThan(0.05);
  });

  test("permutationPValue is large when groups are similar", () => {
    const pre = [5, 6, 5, 6, 5, 6, 5, 6];
    const post = [5, 6, 5, 6, 5, 6, 5, 6];
    const p = permutationPValue(pre, post, 200);
    expect(p).toBeGreaterThan(0.5);
  });

  test("permutationPValue with empty arrays returns 1", () => {
    expect(permutationPValue([], [1, 2], 100)).toBe(1);
  });
});
