import { describe, it, expect } from "bun:test";
import { entropyOf, type Cluster } from "../../src/entropy-probe.ts";

const cluster = (id: number, members: number[]): Cluster => ({
  cluster_id: id,
  members,
  representative: { idx: members[0], tool: "x", args_canonical: "{}" },
});

describe("entropy-probe — entropyOf", () => {
  it("returns 0 for one unanimous cluster", () => {
    expect(entropyOf([cluster(0, [0, 1, 2, 3, 4])], 5)).toBeCloseTo(0, 5);
  });

  it("returns ln(5) for 5 singletons", () => {
    const clusters = [0, 1, 2, 3, 4].map((i) => cluster(i, [i]));
    expect(entropyOf(clusters, 5)).toBeCloseTo(Math.log(5), 5);
  });

  it("returns ln(2) for 50/50 binary split (k=4)", () => {
    expect(entropyOf([cluster(0, [0, 1]), cluster(1, [2, 3])], 4)).toBeCloseTo(Math.log(2), 5);
  });
});

describe("entropy-probe — destructive-asymmetry override", () => {
  it("forces clarify when any sample is destructive and any alternative is not", async () => {
    const { recommend } = await import("../../src/entropy-probe.ts");
    const result = recommend(
      0.1,
      [cluster(0, [0, 1, 2, 3]), cluster(1, [4])],
      [
        { idx: 0, tool: "DRAFT", args_canonical: "{}" },
        { idx: 1, tool: "DRAFT", args_canonical: "{}" },
        { idx: 2, tool: "DRAFT", args_canonical: "{}" },
        { idx: 3, tool: "DRAFT", args_canonical: "{}" },
        { idx: 4, tool: "SEND", args_canonical: "{}" },
      ]
    );
    expect(result.recommendation).toBe("clarify");
  });

  it("dispatches consensus when entropy is low and no destructive mix", async () => {
    const { recommend } = await import("../../src/entropy-probe.ts");
    const result = recommend(
      0.1,
      [cluster(0, [0, 1, 2, 3, 4])],
      [0, 1, 2, 3, 4].map((i) => ({ idx: i, tool: "DRAFT", args_canonical: "{}" }))
    );
    expect(result.recommendation).toBe("dispatch_consensus");
    expect(result.selectedTool).toBe("DRAFT");
  });
});
