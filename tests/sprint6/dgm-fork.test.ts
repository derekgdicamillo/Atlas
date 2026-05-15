import { describe, it, expect } from "bun:test";
import {
  DGM_EXCLUDED_PATHS,
  isPathExcluded,
  qualifiesForMergeList,
  type VariantScoreDeltas,
} from "../../src/dgm-fork";

describe("dgm-fork — excluded paths", () => {
  it("blocks atlas.spec mutations", () => {
    expect(isPathExcluded("atlas.spec")).toBe(true);
  });
  it("blocks ledger artifacts", () => {
    expect(isPathExcluded("data/atlas-ledger.key")).toBe(true);
    expect(isPathExcluded("data/atlas-ledger/2026-05-14.jsonl")).toBe(true);
    expect(isPathExcluded("src/ledger.ts")).toBe(true);
  });
  it("blocks migrations and tool-gate", () => {
    expect(isPathExcluded("db/migrations/099_anything.sql")).toBe(true);
    expect(isPathExcluded("src/tool-gate.ts")).toBe(true);
  });
  it("blocks model-call substrate", () => {
    expect(isPathExcluded("src/claude.ts")).toBe(true);
    expect(isPathExcluded("src/haiku-client.ts")).toBe(true);
  });
  it("blocks package.json and lockfiles", () => {
    expect(isPathExcluded("package.json")).toBe(true);
    expect(isPathExcluded("bun.lock")).toBe(true);
    expect(isPathExcluded(".env")).toBe(true);
  });
  it("allows skill prompts and role yaml", () => {
    expect(isPathExcluded("data/roles-seed.yaml")).toBe(false);
    expect(isPathExcluded(".claude/skills/humanizer/SKILL.md")).toBe(false);
    expect(isPathExcluded("src/dream-engine.ts")).toBe(false);
  });
  it("DGM_EXCLUDED_PATHS is exhaustive", () => {
    expect(DGM_EXCLUDED_PATHS).toContain("atlas.spec");
    expect(DGM_EXCLUDED_PATHS).toContain("src/ledger.ts");
    expect(DGM_EXCLUDED_PATHS).toContain("src/claude.ts");
  });
});

describe("dgm-fork — merge-list qualification", () => {
  const baseline: VariantScoreDeltas = {
    aggregate: +0.04,
    groundedness: +0.05,
    tool: +0.03,
    refusal: +0.02,
  };

  it("qualifies when aggregate ≥ +0.02 and no axis regression > 0.05", () => {
    expect(qualifiesForMergeList(baseline)).toBe(true);
  });
  it("rejects when aggregate < +0.02", () => {
    expect(qualifiesForMergeList({ ...baseline, aggregate: 0.01 })).toBe(false);
  });
  it("rejects when any axis regresses > 0.05", () => {
    expect(qualifiesForMergeList({ ...baseline, refusal: -0.06 })).toBe(false);
    expect(qualifiesForMergeList({ ...baseline, groundedness: -0.06 })).toBe(false);
  });
  it("accepts small axis regression up to -0.05 boundary inclusive", () => {
    expect(qualifiesForMergeList({ ...baseline, refusal: -0.05 })).toBe(true);
  });
});
