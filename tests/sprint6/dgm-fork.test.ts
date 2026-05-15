import { describe, it, expect } from "bun:test";
import {
  DGM_EXCLUDED_PATHS,
  isPathExcluded,
  qualifiesForMergeList,
  pickTargets,
  proposeVariant,
  buildMergeList,
  type VariantScoreDeltas,
  type MutationTarget,
  type DgmVariantRow,
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

describe("dgm-fork — target picker", () => {
  it("pickTargets filters out excluded paths", async () => {
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          gte: () => ({
            order: () => ({
              limit: () => Promise.resolve({
                data: [
                  { agent_kind: "skill", agent_id: "skill-a", domain: "newsletter", alpha: 1, beta: 5, use_count: 10, updated_at: new Date().toISOString() },
                  { agent_kind: "skill", agent_id: "skill-b", domain: "medical",    alpha: 2, beta: 6, use_count: 10, updated_at: new Date().toISOString() },
                ],
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as any;
    const targets = await pickTargets(fakeSupabase, 5, {
      resolveTargetFile: (skillId: string) => (skillId === "skill-a" ? ".claude/skills/skill-a/SKILL.md" : ".claude/skills/skill-b/SKILL.md"),
    });
    expect(targets.length).toBeLessThanOrEqual(5);
    for (const t of targets) {
      expect(isPathExcluded(t.target_file)).toBe(false);
    }
  });

  it("pickTargets returns empty when no struggling agents", async () => {
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          gte: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      }),
    } as any;
    const targets = await pickTargets(fakeSupabase, 5, { resolveTargetFile: () => "x" });
    expect(targets).toEqual([]);
  });

  it("pickTargets filters by loss-rate threshold (> 0.6)", async () => {
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          gte: () => ({
            order: () => ({
              limit: () => Promise.resolve({
                data: [
                  // loss-rate = 5/(2+5) = 0.71 — qualifies
                  { agent_kind: "skill", agent_id: "high-loss", domain: "x", alpha: 2, beta: 5, use_count: 10, updated_at: new Date().toISOString() },
                  // loss-rate = 1/(9+1) = 0.10 — excluded
                  { agent_kind: "skill", agent_id: "low-loss", domain: "x", alpha: 9, beta: 1, use_count: 10, updated_at: new Date().toISOString() },
                ],
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as any;
    const targets = await pickTargets(fakeSupabase, 5, {
      resolveTargetFile: (id) => `.claude/skills/${id}/SKILL.md`,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].target_file).toContain("high-loss");
  });
});

describe("dgm-fork — proposeVariant", () => {
  it("returns proposal with new_content and rationale via injected callClaude", async () => {
    const callClaude = async (_prompt: string) =>
      JSON.stringify({
        new_content: "improved version of the file",
        rationale: "addresses the failure pattern in last 7 days of corrections",
      });
    const target: MutationTarget = {
      target_file: "data/roles-seed.yaml",
      target_kind: "role-prompt",
      reason: "munger-inverter loss rate 0.65",
    };
    const proposal = await proposeVariant(target, {
      currentContent: "current content here",
      recentFailures: ["failure 1", "failure 2"],
      callClaude,
    });
    expect(proposal.target_file).toBe(target.target_file);
    expect(proposal.new_content).toContain("improved");
    expect(proposal.rationale).toContain("failure pattern");
  });

  it("throws on malformed Opus output", async () => {
    const callClaude = async () => "not json";
    const target: MutationTarget = {
      target_file: "data/roles-seed.yaml",
      target_kind: "role-prompt",
      reason: "test",
    };
    await expect(
      proposeVariant(target, { currentContent: "x", recentFailures: [], callClaude })
    ).rejects.toThrow(/parse/i);
  });

  it("throws when output lacks required fields", async () => {
    const callClaude = async () => JSON.stringify({ new_content: "x" }); // missing rationale
    const target: MutationTarget = {
      target_file: "data/roles-seed.yaml",
      target_kind: "role-prompt",
      reason: "test",
    };
    await expect(
      proposeVariant(target, { currentContent: "x", recentFailures: [], callClaude })
    ).rejects.toThrow(/missing/i);
  });
});

describe("dgm-fork — merge-list builder", () => {
  it("includes only variants with status='scored' AND qualifying deltas", () => {
    const rows: DgmVariantRow[] = [
      {
        id: "v1", target_file: "data/roles-seed.yaml", target_kind: "role-prompt",
        variant_branch: "v1", diff_summary: "x", opus_rationale: "y",
        status: "scored", delta_aggregate: 0.04, delta_groundedness: 0.05, delta_tool: 0.03, delta_refusal: -0.01,
      },
      {
        id: "v2", target_file: "data/roles-seed.yaml", target_kind: "role-prompt",
        variant_branch: "v2", diff_summary: "x", opus_rationale: "y",
        status: "scored", delta_aggregate: 0.01, delta_groundedness: 0.02, delta_tool: 0.0, delta_refusal: 0.0,
      },
      {
        id: "v3", target_file: "data/roles-seed.yaml", target_kind: "role-prompt",
        variant_branch: "v3", diff_summary: "x", opus_rationale: "y",
        status: "scored", delta_aggregate: 0.05, delta_groundedness: 0.06, delta_tool: 0.05, delta_refusal: -0.08,
      },
      {
        id: "v4", target_file: "data/roles-seed.yaml", target_kind: "role-prompt",
        variant_branch: "v4", diff_summary: "x", opus_rationale: "y",
        status: "rejected", delta_aggregate: 0.10, delta_groundedness: 0.10, delta_tool: 0.10, delta_refusal: 0.10,
      },
    ];
    const merged = buildMergeList(rows);
    expect(merged.map((r) => r.id)).toEqual(["v1"]);
  });

  it("sorts by delta_aggregate descending", () => {
    const rows: DgmVariantRow[] = [
      {
        id: "low", target_file: "a", target_kind: "skill",
        variant_branch: "x", diff_summary: "x", opus_rationale: "y",
        status: "scored", delta_aggregate: 0.03, delta_groundedness: 0.05, delta_tool: 0.03, delta_refusal: 0.02,
      },
      {
        id: "high", target_file: "a", target_kind: "skill",
        variant_branch: "x", diff_summary: "x", opus_rationale: "y",
        status: "scored", delta_aggregate: 0.10, delta_groundedness: 0.05, delta_tool: 0.03, delta_refusal: 0.02,
      },
    ];
    const merged = buildMergeList(rows);
    expect(merged.map((r) => r.id)).toEqual(["high", "low"]);
  });
});
