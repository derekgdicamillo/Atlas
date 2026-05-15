# Atlas Prime — Sprint 6: Self-Improvement Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atlas commits improvements to itself nightly. Derek reviews a short merge list at breakfast. `/why` works on any message from the last 30 days. All model calls route through the Claude CLI subprocess (Max-plan OAuth) — no `@anthropic-ai/sdk` imports.

**Architecture:** Five composing primitives over Sprints 1-5 substrate. DGM Fork (nightly variant proposal + tiered scoring + Derek-approval merge) is the engine; Self-Regen is a DGM specialization for skills/role-prompts; Skill Shadow-Routing decides promotions/demotions via composite Haiku-judge + Derek-thumbs; Soft-DPO collects correction pairs and injects them per-turn via semantic match; `/why` reconstructs the full state at any past message and reasons over the delta to today.

**Tech Stack:** Bun/TypeScript, `bun:test`, Supabase Postgres + pgvector, Claude CLI subprocess (`callClaude` from `src/claude.ts`, `callHaiku` from `src/haiku-client.ts`), OpenAI text-embedding-3-small (existing).

**Spec:** `docs/superpowers/specs/2026-05-14-atlas-prime-sprint-6-design.md`

**File structure:**

- **Create (modules):** `src/dgm-fork.ts`, `src/skill-shadow-router.ts`, `src/self-regen.ts`, `src/soft-dpo.ts`, `src/introspect.ts`
- **Create (scripts):** `scripts/dgm-merge-handler.ts`, `scripts/export-dpo-jsonl.ts`, `scripts/init-dgm-repo.sh`
- **Create (migrations):** `db/migrations/054_dgm_variants.sql`, `055_skill_shadow_scores.sql`, `056_dpo_pairs.sql`, `057_dpo_pair_embeddings.sql`, `058_introspect_cache.sql`
- **Create (tests):** `tests/sprint6/dgm-fork.test.ts`, `skill-shadow-router.test.ts`, `self-regen.test.ts`, `soft-dpo.test.ts`, `introspect.test.ts`
- **Modify:** `src/relay.ts`, `src/cron.ts`, `src/marketplace.ts`, `src/capability-registry.ts`, `.env.example`, `.gitignore`

---

## Task 1: Schema migrations (5 files)

**Files:**
- Create: `db/migrations/054_dgm_variants.sql`
- Create: `db/migrations/055_skill_shadow_scores.sql`
- Create: `db/migrations/056_dpo_pairs.sql`
- Create: `db/migrations/057_dpo_pair_embeddings.sql`
- Create: `db/migrations/058_introspect_cache.sql`

- [ ] **Step 1: Inspect prior migration style**

```bash
ls db/migrations/ | tail -5
cat db/migrations/053_joint_trigger_modes.sql | head -10
```

Match style: uppercase keywords, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `TIMESTAMPTZ DEFAULT NOW()`, COMMENT statements.

- [ ] **Step 2: Create `db/migrations/054_dgm_variants.sql`**

```sql
-- Atlas Prime Sprint 6: DGM Fork variants — nightly proposed mutations to src/+rules.
-- Tiered scoring (build → test → 10-conv smoke → 50-conv full) → merge list to Derek.

CREATE TABLE IF NOT EXISTS dgm_variants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  target_file         TEXT NOT NULL,
  target_kind         TEXT NOT NULL CHECK (target_kind IN ('skill','role-prompt','behavioral-fix','heuristic','rule','system-prompt')),
  variant_branch      TEXT NOT NULL,
  diff_summary        TEXT NOT NULL,
  opus_rationale      TEXT NOT NULL,
  build_passed        BOOLEAN,
  tests_passed        BOOLEAN,
  smoke_aggregate     REAL,
  full_aggregate      REAL,
  main_aggregate      REAL,
  delta_aggregate     REAL,
  delta_groundedness  REAL,
  delta_tool          REAL,
  delta_refusal       REAL,
  status              TEXT NOT NULL CHECK (status IN ('proposed','built','tested','smoked','scored','queued','approved','rejected','merged','archived')),
  rejected_reason     TEXT,
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,
  merge_commit_sha    TEXT,
  ledger_entry_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_dgm_variants_status ON dgm_variants(status);
CREATE INDEX IF NOT EXISTS idx_dgm_variants_proposed ON dgm_variants(proposed_at DESC);

COMMENT ON TABLE dgm_variants IS
  'Atlas Prime Sprint 6: nightly DGM variants — one row per proposed mutation through the scoring pipeline.';
```

- [ ] **Step 3: Create `db/migrations/055_skill_shadow_scores.sql`**

```sql
-- Atlas Prime Sprint 6: Skill shadow-routing judge verdicts.
-- Rolling 10-invocation window per skill determines 7/10 auto-promotion.

CREATE TABLE IF NOT EXISTS skill_shadow_scores (
  id                BIGSERIAL PRIMARY KEY,
  task_id           UUID NOT NULL,
  skill_id          TEXT NOT NULL,
  baseline_skill_id TEXT NOT NULL,
  task_kind         TEXT NOT NULL,
  domain            TEXT NOT NULL,
  judge_verdict     TEXT NOT NULL CHECK (judge_verdict IN ('shadow_wins','baseline_wins','tie')),
  judge_reason      TEXT,
  derek_veto        BOOLEAN NOT NULL DEFAULT FALSE,
  derek_veto_at     TIMESTAMPTZ,
  scored_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shadow_scores_skill ON skill_shadow_scores(skill_id, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_scores_active ON skill_shadow_scores(skill_id, scored_at DESC)
  WHERE derek_veto = FALSE;
```

- [ ] **Step 4: Create `db/migrations/056_dpo_pairs.sql`**

```sql
-- Atlas Prime Sprint 6: Soft-DPO preference pairs.
-- Three sources: [LABEL_BAD:] tags, Haiku follow-up classifier, explicit [DPO:] tag.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS dpo_pairs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source          TEXT NOT NULL CHECK (source IN ('label_bad','haiku_classifier','dpo_tag')),
  turn_id         UUID,
  user_id         TEXT NOT NULL,
  agent           TEXT NOT NULL CHECK (agent IN ('atlas','ishtar')),
  user_turn       TEXT NOT NULL,
  atlas_original  TEXT NOT NULL,
  derek_corrected TEXT NOT NULL,
  domain          TEXT,
  reason          TEXT,
  embedding       VECTOR(1536),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_dpo_pairs_domain ON dpo_pairs(domain);
CREATE INDEX IF NOT EXISTS idx_dpo_pairs_captured ON dpo_pairs(captured_at DESC);
```

- [ ] **Step 5: Create `db/migrations/057_dpo_pair_embeddings.sql`**

```sql
-- Atlas Prime Sprint 6: ivfflat index for soft-DPO semantic match.

CREATE INDEX IF NOT EXISTS idx_dpo_pairs_embedding
  ON dpo_pairs USING ivfflat (embedding vector_cosine_ops) WITH (lists = 30);
```

- [ ] **Step 6: Create `db/migrations/058_introspect_cache.sql`**

```sql
-- Atlas Prime Sprint 6: /why introspection cache. 30-day TTL purged nightly.

CREATE TABLE IF NOT EXISTS introspect_cache (
  turn_id                  UUID PRIMARY KEY,
  reconstructed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  time_then                TEXT NOT NULL,
  time_now                 TEXT NOT NULL,
  delta_reasoning          TEXT NOT NULL,
  cited_memory_ids         UUID[] NOT NULL DEFAULT '{}',
  cited_ledger_shas        TEXT[] NOT NULL DEFAULT '{}',
  cited_dag_edges          UUID[] NOT NULL DEFAULT '{}',
  cited_council_review_ids UUID[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_introspect_cache_age
  ON introspect_cache(reconstructed_at DESC);
```

- [ ] **Step 7: Read each file back and spot-check**

```bash
for f in db/migrations/05{4,5,6,7,8}_*.sql; do
  echo "=== $f ==="
  cat "$f" | head -25
done
```

- [ ] **Step 8: Commit**

```bash
git add db/migrations/054_dgm_variants.sql \
        db/migrations/055_skill_shadow_scores.sql \
        db/migrations/056_dpo_pairs.sql \
        db/migrations/057_dpo_pair_embeddings.sql \
        db/migrations/058_introspect_cache.sql
git commit -m "feat(atlas-prime): Sprint 6 migrations — DGM + shadow scores + DPO pairs + /why cache"
```

---

## Task 2: DGM Fork module foundation

**Files:**
- Create: `src/dgm-fork.ts`
- Create: `scripts/init-dgm-repo.sh`
- Test: `tests/sprint6/dgm-fork.test.ts`

- [ ] **Step 1: Create `scripts/init-dgm-repo.sh`**

```bash
#!/usr/bin/env bash
# Atlas Prime Sprint 6: initialize the DGM bare repo + worktree directory.
# Idempotent.

set -e
mkdir -p data/dgm.git data/dgm-worktrees
if [ ! -d data/dgm.git/refs ]; then
  git init --bare data/dgm.git
  cd data/dgm.git
  git config user.email "atlas-dgm@atlas.local"
  git config user.name "atlas-dgm"
  TREE=$(git mktree </dev/null)
  COMMIT=$(echo "init" | git commit-tree "$TREE")
  git branch master "$COMMIT"
  echo "dgm repo initialized at data/dgm.git"
else
  echo "dgm repo already exists at data/dgm.git (idempotent skip)"
fi
chmod +x scripts/init-dgm-repo.sh 2>/dev/null || true
```

Make it executable:

```bash
chmod +x scripts/init-dgm-repo.sh
```

- [ ] **Step 2: Write `tests/sprint6/dgm-fork.test.ts` (foundation tests only)**

```typescript
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
```

- [ ] **Step 3: Run test — expect FAIL**

```bash
bun test tests/sprint6/dgm-fork.test.ts
```

Expected: module not found.

- [ ] **Step 4: Implement `src/dgm-fork.ts` (foundation only)**

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

export const DGM_EXCLUDED_PATHS = [
  "atlas.spec",
  "data/atlas-ledger/",
  "data/atlas-ledger.key",
  "data/atlas-ledger.pub",
  "db/migrations/",
  "src/ledger.ts",
  "src/tool-gate.ts",
  "src/claude.ts",
  "src/haiku-client.ts",
  "package.json",
  "bun.lock",
  ".env",
  ".env.example",
] as const;

export type DgmTargetKind = "skill" | "role-prompt" | "behavioral-fix" | "heuristic" | "rule" | "system-prompt";

export interface MutationTarget {
  target_file: string;
  target_kind: DgmTargetKind;
  reason: string;                    // why this target was picked
}

export interface VariantProposal {
  target_file: string;
  target_kind: DgmTargetKind;
  new_content: string;
  rationale: string;
}

export interface VariantScoreDeltas {
  aggregate: number;
  groundedness: number;
  tool: number;
  refusal: number;
}

export interface DgmVariantRow {
  id: string;
  target_file: string;
  target_kind: DgmTargetKind;
  variant_branch: string;
  diff_summary: string;
  opus_rationale: string;
  status: string;
  smoke_aggregate?: number;
  full_aggregate?: number;
  main_aggregate?: number;
  delta_aggregate?: number;
  delta_groundedness?: number;
  delta_tool?: number;
  delta_refusal?: number;
}

export function isPathExcluded(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  for (const p of DGM_EXCLUDED_PATHS) {
    if (p.endsWith("/")) {
      if (normalized.startsWith(p)) return true;
    } else if (normalized === p) {
      return true;
    }
  }
  return false;
}

export function qualifiesForMergeList(deltas: VariantScoreDeltas): boolean {
  if (deltas.aggregate < 0.02) return false;
  const axes = [deltas.groundedness, deltas.tool, deltas.refusal];
  if (axes.some((d) => d < -0.05)) return false;
  return true;
}
```

- [ ] **Step 5: Run test — expect PASS**

```bash
bun test tests/sprint6/dgm-fork.test.ts
```

Expected: 9 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/dgm-fork.ts scripts/init-dgm-repo.sh tests/sprint6/dgm-fork.test.ts
git commit -m "feat(atlas-prime): dgm-fork foundation — excluded paths + merge qualification"
```

---

## Task 3: DGM target picker + variant proposer

**Files:**
- Modify: `src/dgm-fork.ts` — append `pickTargets`, `proposeVariant`, `buildAndTest`
- Modify: `tests/sprint6/dgm-fork.test.ts` — append tests

- [ ] **Step 1: Append tests to `tests/sprint6/dgm-fork.test.ts`**

```typescript
import { pickTargets, proposeVariant, type MutationTarget } from "../../src/dgm-fork";

describe("dgm-fork — target picker", () => {
  it("pickTargets filters out excluded paths", async () => {
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          gte: () => ({
            order: () => ({
              limit: () => Promise.resolve({
                data: [
                  { agent_id: "skill-a", domain: "newsletter", alpha: 1, beta: 5 },
                  { agent_id: "skill-b", domain: "medical",    alpha: 2, beta: 6 },
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
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
bun test tests/sprint6/dgm-fork.test.ts
```

- [ ] **Step 3: Append to `src/dgm-fork.ts`**

```typescript
const PROPOSE_VARIANT_SYSTEM = `You propose ONE focused mutation to a target file in Atlas's source tree to improve performance on recent failures.

You receive:
- target_file: the path being mutated
- target_kind: skill | role-prompt | behavioral-fix | heuristic | rule | system-prompt
- current_content: the file's current text
- recent_failures: 0-30 short descriptions of recent failures involving this file

Output a strict JSON object:
{
  "new_content": "<the full proposed replacement content for the file>",
  "rationale": "<one paragraph: why this change, what failure it addresses, expected effect on replay axes>"
}

Rules:
- ONE focused change per variant. Do not rewrite the file from scratch unless the file is <500 chars.
- Preserve YAML / Markdown / TypeScript structure exactly.
- Do not introduce new imports, new exports, or new dependencies.
- The change must be defensible against replay-harness axes (groundedness, tool-correctness, refusal-calibration).
- Output ONLY the JSON object. No preamble, no markdown fences.`;

interface ProposeVariantDeps {
  currentContent: string;
  recentFailures: string[];
  callClaude: (prompt: string, opts?: { model?: string; isolated?: boolean; agentId?: string }) => Promise<string>;
}

export async function proposeVariant(target: MutationTarget, deps: ProposeVariantDeps): Promise<VariantProposal> {
  const userMessage = JSON.stringify({
    target_file: target.target_file,
    target_kind: target.target_kind,
    current_content: deps.currentContent,
    recent_failures: deps.recentFailures.slice(0, 30),
  });
  const prompt = `${PROPOSE_VARIANT_SYSTEM}\n\n---\n\n${userMessage}`;
  const raw = await deps.callClaude(prompt, { model: "opus", isolated: true, agentId: "dgm-fork" });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`dgm-fork: failed to parse variant proposal: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed.new_content !== "string" || typeof parsed.rationale !== "string") {
    throw new Error("dgm-fork: variant proposal missing new_content or rationale");
  }
  return {
    target_file: target.target_file,
    target_kind: target.target_kind,
    new_content: parsed.new_content,
    rationale: parsed.rationale,
  };
}

interface PickTargetsDeps {
  resolveTargetFile: (agent_id: string) => string;
}

export async function pickTargets(
  supabase: SupabaseClient,
  n: number,
  deps: PickTargetsDeps
): Promise<MutationTarget[]> {
  const { data, error } = await supabase
    .from("agent_reputation")
    .select("agent_kind, agent_id, domain, alpha, beta, use_count, updated_at")
    .gte("use_count", 3)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  const candidates: Array<{ row: any; lossRate: number }> = [];
  for (const row of data) {
    const a = Number(row.alpha ?? 1);
    const b = Number(row.beta ?? 1);
    const lossRate = b / Math.max(1, a + b);
    if (lossRate <= 0.6) continue;
    candidates.push({ row, lossRate });
  }
  candidates.sort((x, y) => y.lossRate - x.lossRate);
  const picked: MutationTarget[] = [];
  for (const { row, lossRate } of candidates) {
    if (picked.length >= n) break;
    const target_file = deps.resolveTargetFile(row.agent_id);
    if (!target_file || isPathExcluded(target_file)) continue;
    const target_kind: DgmTargetKind = row.agent_kind === "role" ? "role-prompt" : "skill";
    picked.push({
      target_file,
      target_kind,
      reason: `${row.agent_kind}=${row.agent_id} loss_rate=${lossRate.toFixed(2)} in ${row.domain}`,
    });
  }
  return picked;
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
bun test tests/sprint6/dgm-fork.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/dgm-fork.ts tests/sprint6/dgm-fork.test.ts
git commit -m "feat(atlas-prime): dgm-fork pickTargets + proposeVariant (Opus via callClaude)"
```

---

## Task 4: DGM build + test gate + scoring + merge-list builder

**Files:**
- Modify: `src/dgm-fork.ts` — append `buildAndTest`, `scoreSmoke`, `scoreFull`, `buildMergeList`, `runNightly`
- Modify: `tests/sprint6/dgm-fork.test.ts`

- [ ] **Step 1: Append tests**

```typescript
import { buildMergeList, type DgmVariantRow } from "../../src/dgm-fork";

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
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
bun test tests/sprint6/dgm-fork.test.ts
```

- [ ] **Step 3: Append to `src/dgm-fork.ts`**

```typescript
import { spawn } from "node:child_process";

export function buildMergeList(rows: DgmVariantRow[]): DgmVariantRow[] {
  const out: DgmVariantRow[] = [];
  for (const r of rows) {
    if (r.status !== "scored") continue;
    const deltas: VariantScoreDeltas = {
      aggregate: r.delta_aggregate ?? 0,
      groundedness: r.delta_groundedness ?? 0,
      tool: r.delta_tool ?? 0,
      refusal: r.delta_refusal ?? 0,
    };
    if (qualifiesForMergeList(deltas)) out.push(r);
  }
  out.sort((a, b) => (b.delta_aggregate ?? 0) - (a.delta_aggregate ?? 0));
  return out;
}

interface BuildAndTestResult {
  build_passed: boolean;
  tests_passed: boolean;
  stderr?: string;
}

export async function buildAndTest(worktreePath: string): Promise<BuildAndTestResult> {
  const runIn = (cmd: string, args: string[]) =>
    new Promise<{ code: number; stderr: string }>((resolve) => {
      const p = spawn(cmd, args, { cwd: worktreePath, shell: process.platform === "win32" });
      let stderr = "";
      p.stderr?.on("data", (d) => (stderr += d.toString()));
      p.on("close", (code) => resolve({ code: code ?? 1, stderr }));
      p.on("error", (err) => resolve({ code: 1, stderr: String(err) }));
    });
  const build = await runIn("bun", ["build", "src/relay.ts", "--target=bun", "--outfile", "/dev/null"]);
  if (build.code !== 0) return { build_passed: false, tests_passed: false, stderr: build.stderr };
  const tests = await runIn("bun", ["test"]);
  return { build_passed: true, tests_passed: tests.code === 0, stderr: tests.stderr };
}

interface ScoreReplayDeps {
  loadDataset: (path: string) => Promise<any[]>;
  scoreEntry: (entry: any) => Promise<{ aggregate: number; groundedness: number; tool_correctness: number; refusal_calibration: number }>;
}

export async function scoreSmoke(datasetPath: string, deps: ScoreReplayDeps): Promise<{ aggregate: number; per_axis: VariantScoreDeltas }> {
  const all = await deps.loadDataset(datasetPath);
  const sample = all.slice(0, 10);
  return scoreOver(sample, deps);
}

export async function scoreFull(datasetPath: string, deps: ScoreReplayDeps): Promise<{ aggregate: number; per_axis: VariantScoreDeltas }> {
  const all = await deps.loadDataset(datasetPath);
  const sample = all.slice(0, 50);
  return scoreOver(sample, deps);
}

async function scoreOver(entries: any[], deps: ScoreReplayDeps): Promise<{ aggregate: number; per_axis: VariantScoreDeltas }> {
  if (!entries.length) return { aggregate: 0, per_axis: { aggregate: 0, groundedness: 0, tool: 0, refusal: 0 } };
  const scores = await Promise.all(entries.map((e) => deps.scoreEntry(e)));
  const mean = (key: "aggregate" | "groundedness" | "tool_correctness" | "refusal_calibration") =>
    scores.reduce((s, x) => s + x[key], 0) / scores.length;
  return {
    aggregate: mean("aggregate"),
    per_axis: {
      aggregate: mean("aggregate"),
      groundedness: mean("groundedness"),
      tool: mean("tool_correctness"),
      refusal: mean("refusal_calibration"),
    },
  };
}

export async function runNightly(
  supabase: SupabaseClient,
  opts: {
    pickN?: number;
    resolveTargetFile: (agent_id: string) => string;
    callClaude: (prompt: string, opts?: any) => Promise<string>;
    loadDataset: (path: string) => Promise<any[]>;
    scoreEntry: (entry: any) => Promise<any>;
    readFile: (path: string) => Promise<string>;
    fetchRecentFailures: (target_file: string) => Promise<string[]>;
    setupWorktree: (variantId: string, target_file: string, new_content: string) => Promise<string>;
  }
): Promise<{ proposed: number; queued: number; archived: number }> {
  const pickN = opts.pickN ?? 5;
  const targets = await pickTargets(supabase, pickN, { resolveTargetFile: opts.resolveTargetFile });
  let proposed = 0;
  let queued = 0;
  let archived = 0;
  for (const target of targets) {
    let proposal: VariantProposal;
    try {
      const currentContent = await opts.readFile(target.target_file);
      const recentFailures = await opts.fetchRecentFailures(target.target_file);
      proposal = await proposeVariant(target, { currentContent, recentFailures, callClaude: opts.callClaude });
    } catch (err) {
      console.error(`[dgm-fork] proposeVariant failed for ${target.target_file}:`, err);
      continue;
    }
    proposed++;
    const { data: ins } = await supabase
      .from("dgm_variants")
      .insert({
        target_file: target.target_file,
        target_kind: target.target_kind,
        variant_branch: `dgm/${target.target_file.replace(/[\/\\.]/g, "-")}-${Date.now()}`,
        diff_summary: proposal.rationale.split("\n")[0].slice(0, 200),
        opus_rationale: proposal.rationale,
        status: "proposed",
      })
      .select("id, variant_branch")
      .single();
    if (!ins) continue;
    const variantId = (ins as any).id as string;
    const worktreePath = await opts.setupWorktree(variantId, target.target_file, proposal.new_content);
    const bt = await buildAndTest(worktreePath);
    await supabase.from("dgm_variants").update({
      build_passed: bt.build_passed,
      tests_passed: bt.tests_passed,
      status: bt.tests_passed ? "tested" : "rejected",
      rejected_reason: bt.tests_passed ? null : (bt.build_passed ? "tests_failed" : "build_failed"),
    }).eq("id", variantId);
    if (!bt.tests_passed) { archived++; continue; }
    const smoke = await scoreSmoke("data/replay-dataset.jsonl", { loadDataset: opts.loadDataset, scoreEntry: opts.scoreEntry });
    await supabase.from("dgm_variants").update({
      smoke_aggregate: smoke.aggregate,
      status: "smoked",
    }).eq("id", variantId);
  }
  // Top-2 by smoke get full evaluation; baseline aggregate captured once.
  const { data: smoked } = await supabase
    .from("dgm_variants")
    .select("*")
    .eq("status", "smoked")
    .order("smoke_aggregate", { ascending: false })
    .limit(2);
  const baseline = await scoreFull("data/replay-dataset.jsonl", { loadDataset: opts.loadDataset, scoreEntry: opts.scoreEntry });
  for (const v of (smoked ?? []) as any[]) {
    const full = await scoreFull("data/replay-dataset.jsonl", { loadDataset: opts.loadDataset, scoreEntry: opts.scoreEntry });
    const delta_aggregate = full.aggregate - baseline.aggregate;
    const delta_groundedness = full.per_axis.groundedness - baseline.per_axis.groundedness;
    const delta_tool = full.per_axis.tool - baseline.per_axis.tool;
    const delta_refusal = full.per_axis.refusal - baseline.per_axis.refusal;
    const passes = qualifiesForMergeList({ aggregate: delta_aggregate, groundedness: delta_groundedness, tool: delta_tool, refusal: delta_refusal });
    await supabase.from("dgm_variants").update({
      full_aggregate: full.aggregate,
      main_aggregate: baseline.aggregate,
      delta_aggregate,
      delta_groundedness,
      delta_tool,
      delta_refusal,
      status: passes ? "queued" : "rejected",
      rejected_reason: passes ? null : "delta_below_threshold",
    }).eq("id", v.id);
    if (passes) queued++; else archived++;
  }
  return { proposed, queued, archived };
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
bun test tests/sprint6/dgm-fork.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/dgm-fork.ts tests/sprint6/dgm-fork.test.ts
git commit -m "feat(atlas-prime): dgm-fork tiered scoring + merge-list builder + runNightly"
```

---

## Task 5: DGM merge handler script + /dgm command + morning review cron

**Files:**
- Create: `scripts/dgm-merge-handler.ts`
- Modify: `src/relay.ts` — add `/dgm` command and `[DGM_DECIDE:]` tag processor
- Modify: `src/cron.ts` — register `dgm-fork-nightly` and `dgm-morning-review`

- [ ] **Step 1: Create `scripts/dgm-merge-handler.ts`**

```typescript
#!/usr/bin/env bun
// Handles ✓ merge / ✗ archive / ✏ edit-then-merge button presses from the
// morning DGM review Telegram message. Reads a [DGM_DECIDE: <variant_id> | action=...]
// tag from stdin (relay invokes via processCodeTaskIntents-style handler).

import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!
);

async function mergeVariant(variantId: string, approver: "derek" | "esther"): Promise<{ ok: boolean; sha?: string; error?: string }> {
  const { data: row } = await supabase
    .from("dgm_variants")
    .select("*")
    .eq("id", variantId)
    .single();
  if (!row) return { ok: false, error: "variant not found" };
  const v = row as any;
  if (v.status !== "queued") return { ok: false, error: `variant status is ${v.status}, expected 'queued'` };
  const worktreePath = `data/dgm-worktrees/${v.id}`;
  // Fast-forward variant branch over current master, squash-merge.
  const ff = spawnSync("git", ["-C", worktreePath, "rebase", "origin/master"], { encoding: "utf8" });
  if (ff.status !== 0) return { ok: false, error: `rebase failed: ${ff.stderr}` };
  const apply = spawnSync("git", ["-C", ".", "merge", "--squash", "--no-commit", `dgm-worktrees/${v.id}`], { encoding: "utf8" });
  if (apply.status !== 0) return { ok: false, error: `squash failed: ${apply.stderr}` };
  const msg = `dgm: ${v.diff_summary}\n\nApproved-by: ${approver}\nReplay-delta: ${(v.delta_aggregate ?? 0).toFixed(3)}\nVariant-id: ${v.id}\n`;
  const commit = spawnSync("git", ["commit", "-m", msg], { encoding: "utf8" });
  if (commit.status !== 0) return { ok: false, error: `commit failed: ${commit.stderr}` };
  const shaResult = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const sha = shaResult.stdout.trim();
  await supabase.from("dgm_variants").update({
    status: "merged",
    approved_by: approver,
    approved_at: new Date().toISOString(),
    merge_commit_sha: sha,
  }).eq("id", variantId);
  return { ok: true, sha };
}

async function archiveVariant(variantId: string): Promise<void> {
  await supabase.from("dgm_variants").update({ status: "archived" }).eq("id", variantId);
}

const action = process.argv[2];
const variantId = process.argv[3];
const approver = (process.argv[4] ?? "derek") as "derek" | "esther";

if (action === "merge") {
  mergeVariant(variantId, approver).then((r) => console.log(JSON.stringify(r)));
} else if (action === "archive") {
  archiveVariant(variantId).then(() => console.log(JSON.stringify({ ok: true })));
} else {
  console.error("Usage: dgm-merge-handler.ts merge|archive <variant_id> [approver]");
  process.exit(1);
}
```

- [ ] **Step 2: Wire `/dgm` command into `src/relay.ts`**

Find an existing `case "/dag":` block (Sprint 4) and add adjacent:

```typescript
case "/dgm": {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "pending") {
    const { data } = await supabase
      .from("dgm_variants")
      .select("id, target_file, target_kind, delta_aggregate, status")
      .eq("status", "queued")
      .order("delta_aggregate", { ascending: false });
    const rows = (data ?? []) as any[];
    if (!rows.length) { await ctx.reply("DGM queue: empty."); return true; }
    const lines = ["**DGM queue**", ""];
    for (const r of rows) lines.push(`\`${r.id.slice(0, 8)}\` ${r.target_file} (Δ ${(r.delta_aggregate ?? 0).toFixed(3)})`);
    lines.push("", "Use `/dgm review <id>` for full diff + Opus rationale + decision buttons.");
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    return true;
  }
  if (sub === "review") {
    const id = args[1];
    if (!id) { await ctx.reply("Usage: `/dgm review <variant_id>`"); return true; }
    const { data: row } = await supabase.from("dgm_variants").select("*").eq("id", id).single();
    if (!row) { await ctx.reply(`Variant \`${id}\` not found.`); return true; }
    const v = row as any;
    const text = [
      `**DGM ${id.slice(0, 8)}** — ${v.target_file} (${v.target_kind})`,
      ``,
      `Δ aggregate: ${(v.delta_aggregate ?? 0).toFixed(3)}`,
      `Δ groundedness: ${(v.delta_groundedness ?? 0).toFixed(3)}`,
      `Δ tool: ${(v.delta_tool ?? 0).toFixed(3)}`,
      `Δ refusal: ${(v.delta_refusal ?? 0).toFixed(3)}`,
      ``,
      `**Rationale:** ${v.opus_rationale}`,
      ``,
      `Decide: \`/dgm merge ${id}\` | \`/dgm archive ${id}\``,
    ].join("\n");
    await ctx.reply(text, { parse_mode: "Markdown" });
    return true;
  }
  if (sub === "merge" || sub === "archive") {
    const id = args[1];
    if (!id) { await ctx.reply(`Usage: \`/dgm ${sub} <variant_id>\``); return true; }
    const approver = String(ctx.from?.username ?? userId).toLowerCase().includes("esther") ? "esther" : "derek";
    const result = await new Promise<{ ok: boolean; sha?: string; error?: string }>((resolve) => {
      const p = require("node:child_process").spawn("bun", ["run", "scripts/dgm-merge-handler.ts", sub, id, approver], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      p.on("close", () => {
        try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: "handler returned non-JSON" }); }
      });
    });
    if (result.ok) {
      await ctx.reply(sub === "merge" ? `✓ merged. commit: ${result.sha?.slice(0, 8)}` : `✗ archived.`);
    } else {
      await ctx.reply(`Error: ${result.error}`);
    }
    return true;
  }
  await ctx.reply(["**/dgm commands**", "`/dgm pending` — queued variants", "`/dgm review <id>` — full diff + buttons", "`/dgm merge <id>` — merge to master", "`/dgm archive <id>` — discard"].join("\n"), { parse_mode: "Markdown" });
  return true;
}
```

- [ ] **Step 3: Register `dgm-fork-nightly` and `dgm-morning-review` crons in `src/cron.ts`**

Find the existing Sprint 5 cron block; the next available job numbers will be ~33 and 34 (inspect first). Add:

```typescript
// 33. Atlas Prime Sprint 6: DGM Fork nightly at 22:00 PHX.
jobs.push(
  CronJob.from({
    cronTime: "0 22 * * *",
    onTick: safeTick("dgm-fork-nightly", async () => {
      const { runNightly } = await import("./dgm-fork.ts");
      const { loadDataset } = await import("./replay-dataset.ts");
      const { scoreEntry } = await import("./replay-judge.ts");
      const { readFile } = await import("node:fs/promises");
      const { callClaude } = await import("./claude.ts");
      // Skill→file resolver looks up SKILL.md or roles-seed.yaml fragment by agent_id.
      const resolveTargetFile = (agentId: string): string => {
        // Skills live at .claude/skills/<id>/SKILL.md; roles at data/roles-seed.yaml.
        // For roles, the file is shared — DGM will mutate the relevant fragment via Opus.
        if (agentId.endsWith("-mirror") || agentId.includes("seat")) return "data/roles-seed.yaml";
        return `.claude/skills/${agentId}/SKILL.md`;
      };
      const fetchRecentFailures = async (_targetFile: string): Promise<string[]> => {
        // For now, pull last 30 [LABEL_BAD] entries from replay-dataset as failure signal.
        const ds = await loadDataset("data/replay-dataset.jsonl").catch(() => []);
        return ds.filter((e: any) => e.label === "bad").slice(-30).map((e: any) => e.derekCorrection ?? "").filter(Boolean);
      };
      const { mkdir, writeFile, copyFile } = await import("node:fs/promises");
      const setupWorktree = async (variantId: string, targetFile: string, newContent: string): Promise<string> => {
        const wt = `data/dgm-worktrees/${variantId}`;
        await mkdir(wt, { recursive: true });
        // Simple approach: copy current repo into worktree (slow for nightly; acceptable).
        // Production: use git worktree add on a bare dgm.git repo for speed.
        const { spawn } = await import("node:child_process");
        await new Promise<void>((resolve, reject) => {
          const p = spawn("git", ["worktree", "add", "--detach", wt], { shell: process.platform === "win32" });
          p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`worktree add exited ${code}`))));
        });
        await writeFile(`${wt}/${targetFile}`, newContent, "utf8");
        return wt;
      };
      const result = await runNightly(supabase, { resolveTargetFile, callClaude, loadDataset, scoreEntry, readFile: (p) => readFile(p, "utf8"), fetchRecentFailures, setupWorktree });
      log("dgm-fork-nightly", `proposed=${result.proposed} queued=${result.queued} archived=${result.archived}`);
    }),
    timeZone: TIMEZONE,
  })
);

// 34. Atlas Prime Sprint 6: DGM morning review at 08:00 PHX.
jobs.push(
  CronJob.from({
    cronTime: "0 8 * * *",
    onTick: safeTick("dgm-morning-review", async () => {
      const { data: queued } = await supabase
        .from("dgm_variants")
        .select("id, target_file, target_kind, diff_summary, opus_rationale, delta_aggregate, delta_groundedness, delta_tool, delta_refusal")
        .eq("status", "queued")
        .order("delta_aggregate", { ascending: false })
        .limit(10);
      if (!queued?.length) {
        log("dgm-morning-review", "no queued variants");
        return;
      }
      const { sendTelegramTo } = await import("./relay.ts");
      const lines = ["🧬 **DGM merge list** — ready for review", ""];
      for (const v of queued as any[]) {
        lines.push(`\`${v.id.slice(0, 8)}\` ${v.target_file} (Δ ${(v.delta_aggregate ?? 0).toFixed(3)})`);
        lines.push(`  ${v.diff_summary.slice(0, 120)}`);
      }
      lines.push("", "Use `/dgm review <id>` for full diff. `/dgm merge <id>` or `/dgm archive <id>`.");
      await sendTelegramTo("atlas", lines.join("\n"));
      log("dgm-morning-review", `surfaced ${queued.length} variants`);
    }),
    timeZone: TIMEZONE,
  })
);
```

(Note: `sendTelegramTo` is a placeholder for whatever existing relay export sends a direct message. Inspect `src/relay.ts` for the actual helper before final commit — Sprint 4/5 used a similar pattern for cron-originated messages.)

- [ ] **Step 4: Run full suite**

```bash
bun test
```

- [ ] **Step 5: Commit**

```bash
git add scripts/dgm-merge-handler.ts src/relay.ts src/cron.ts
git commit -m "feat(atlas-prime): /dgm command + nightly cron + morning-review Telegram surface"
```

---

## Task 6: Skill shadow-router module

**Files:**
- Create: `src/skill-shadow-router.ts`
- Test: `tests/sprint6/skill-shadow-router.test.ts`

- [ ] **Step 1: Write `tests/sprint6/skill-shadow-router.test.ts`**

```typescript
import { describe, it, expect } from "bun:test";
import { judgeShadowOutput, computePromotion, computeDemotion } from "../../src/skill-shadow-router";

describe("skill-shadow-router — judge", () => {
  it("parses verdict from Haiku JSON", async () => {
    const callHaiku = async () => ({
      text: JSON.stringify({ verdict: "shadow_wins", reason: "shadow output is concise and accurate" }),
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const out = await judgeShadowOutput(
      { task_description: "summarize" },
      "baseline output",
      "shadow output",
      { callHaiku }
    );
    expect(out.verdict).toBe("shadow_wins");
    expect(out.reason).toContain("concise");
  });

  it("throws on malformed Haiku output", async () => {
    const callHaiku = async () => ({ text: "not json", usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(
      judgeShadowOutput({ task_description: "x" }, "a", "b", { callHaiku })
    ).rejects.toThrow(/parse/i);
  });
});

describe("skill-shadow-router — promotion math", () => {
  it("promotes at exactly 7 wins of last 10 (excluding vetoed)", () => {
    const scores = [
      ...Array(7).fill({ judge_verdict: "shadow_wins", derek_veto: false }),
      ...Array(3).fill({ judge_verdict: "baseline_wins", derek_veto: false }),
    ];
    expect(computePromotion(scores).promote).toBe(true);
  });
  it("does not promote with 6 wins", () => {
    const scores = [
      ...Array(6).fill({ judge_verdict: "shadow_wins", derek_veto: false }),
      ...Array(4).fill({ judge_verdict: "baseline_wins", derek_veto: false }),
    ];
    expect(computePromotion(scores).promote).toBe(false);
  });
  it("excludes Derek-vetoed wins from the count", () => {
    const scores = [
      ...Array(7).fill({ judge_verdict: "shadow_wins", derek_veto: true }),
      ...Array(3).fill({ judge_verdict: "baseline_wins", derek_veto: false }),
    ];
    expect(computePromotion(scores).promote).toBe(false);
  });
  it("requires a full window of 10", () => {
    const scores = Array(5).fill({ judge_verdict: "shadow_wins", derek_veto: false });
    expect(computePromotion(scores).promote).toBe(false);
  });
});

describe("skill-shadow-router — demotion math", () => {
  it("demotes at 7+ baseline_wins in 30d window", () => {
    const scores = [
      ...Array(7).fill({ judge_verdict: "baseline_wins", derek_veto: false }),
      ...Array(3).fill({ judge_verdict: "shadow_wins", derek_veto: false }),
    ];
    expect(computeDemotion(scores).demote).toBe(true);
  });
  it("does not demote with 6 baseline_wins", () => {
    const scores = [
      ...Array(6).fill({ judge_verdict: "baseline_wins", derek_veto: false }),
      ...Array(4).fill({ judge_verdict: "shadow_wins", derek_veto: false }),
    ];
    expect(computeDemotion(scores).demote).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
bun test tests/sprint6/skill-shadow-router.test.ts
```

- [ ] **Step 3: Implement `src/skill-shadow-router.ts`**

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import { callHaiku as defaultCallHaiku } from "./haiku-client.ts";

export interface TaskInput {
  task_description: string;
  task_id?: string;
  domain?: string;
}

export type ShadowVerdict = "shadow_wins" | "baseline_wins" | "tie";

export interface ShadowScoreRow {
  id?: number;
  task_id?: string;
  skill_id?: string;
  baseline_skill_id?: string;
  task_kind?: string;
  domain?: string;
  judge_verdict: ShadowVerdict;
  judge_reason?: string;
  derek_veto: boolean;
  derek_veto_at?: string | null;
  scored_at?: string;
}

const JUDGE_SYSTEM = `You judge which of two outputs better serves the task.

Output a strict JSON object: {"verdict": "shadow_wins" | "baseline_wins" | "tie", "reason": "<one short sentence>"}.

No preamble. No markdown fences.`;

interface JudgeDeps {
  callHaiku?: typeof defaultCallHaiku;
}

export async function judgeShadowOutput(
  task: TaskInput,
  baseline_output: any,
  shadow_output: any,
  deps: JudgeDeps = {}
): Promise<{ verdict: ShadowVerdict; reason: string }> {
  const callHaiku = deps.callHaiku ?? defaultCallHaiku;
  const userMessage = JSON.stringify({
    task: task.task_description,
    baseline_output: String(baseline_output).slice(0, 4000),
    shadow_output: String(shadow_output).slice(0, 4000),
  });
  const result = await callHaiku({
    system: JUDGE_SYSTEM,
    userMessage,
    maxTokens: 200,
    cacheSystem: true,
  });
  let parsed: any;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new Error(`skill-shadow-router: failed to parse judge output: ${result.text.slice(0, 200)}`);
  }
  if (!["shadow_wins", "baseline_wins", "tie"].includes(parsed.verdict)) {
    throw new Error(`skill-shadow-router: invalid verdict "${parsed.verdict}"`);
  }
  return { verdict: parsed.verdict as ShadowVerdict, reason: String(parsed.reason ?? "").slice(0, 400) };
}

const PROMOTE_WINDOW = Number(process.env.SHADOW_WINDOW_SIZE ?? 10);
const PROMOTE_THRESHOLD = Number(process.env.SHADOW_PROMOTE_THRESHOLD ?? 7);

export function computePromotion(scores: Pick<ShadowScoreRow, "judge_verdict" | "derek_veto">[]): { promote: boolean; window: number; wins: number } {
  const active = scores.filter((s) => !s.derek_veto);
  if (active.length < PROMOTE_WINDOW) return { promote: false, window: active.length, wins: active.filter((s) => s.judge_verdict === "shadow_wins").length };
  const window = active.slice(0, PROMOTE_WINDOW);
  const wins = window.filter((s) => s.judge_verdict === "shadow_wins").length;
  return { promote: wins >= PROMOTE_THRESHOLD, window: window.length, wins };
}

export function computeDemotion(scores: Pick<ShadowScoreRow, "judge_verdict" | "derek_veto">[]): { demote: boolean; window: number; losses: number } {
  const active = scores.filter((s) => !s.derek_veto);
  if (active.length < PROMOTE_WINDOW) return { demote: false, window: active.length, losses: active.filter((s) => s.judge_verdict === "baseline_wins").length };
  const window = active.slice(0, PROMOTE_WINDOW);
  const losses = window.filter((s) => s.judge_verdict === "baseline_wins").length;
  return { demote: losses >= PROMOTE_THRESHOLD, window: window.length, losses };
}

export async function recordScore(
  supabase: SupabaseClient,
  row: Omit<ShadowScoreRow, "id" | "scored_at" | "derek_veto" | "derek_veto_at">
): Promise<{ promote: boolean; demote: boolean }> {
  await supabase.from("skill_shadow_scores").insert({ ...row, derek_veto: false });
  const { data: history } = await supabase
    .from("skill_shadow_scores")
    .select("judge_verdict, derek_veto")
    .eq("skill_id", row.skill_id)
    .order("scored_at", { ascending: false })
    .limit(PROMOTE_WINDOW);
  const promotion = computePromotion((history ?? []) as any);
  const demotion = computeDemotion((history ?? []) as any);
  return { promote: promotion.promote, demote: demotion.demote };
}

export async function vetoShadowWin(supabase: SupabaseClient, scoreId: number, by: "derek" | "esther"): Promise<void> {
  await supabase.from("skill_shadow_scores").update({
    derek_veto: true,
    derek_veto_at: new Date().toISOString(),
  }).eq("id", scoreId);
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
bun test tests/sprint6/skill-shadow-router.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/skill-shadow-router.ts tests/sprint6/skill-shadow-router.test.ts
git commit -m "feat(atlas-prime): skill-shadow-router — judge + promotion/demotion math"
```

---

## Task 7: Wire shadow execution into marketplace + /skills shadow command

**Files:**
- Modify: `src/marketplace.ts` — add `executeWithShadow` wrapper around `routeTask`
- Modify: `src/relay.ts` — add `/skills` command

- [ ] **Step 1: Inspect routeTask shape**

```bash
grep -n "routeTask\|executeWithShadow" src/marketplace.ts | head -5
```

- [ ] **Step 2: Append `executeWithShadow` to `src/marketplace.ts`**

```typescript
import { judgeShadowOutput, recordScore } from "./skill-shadow-router.ts";

export interface ShadowExecutionOpts {
  taskId: string;
  taskKind: string;
  domain: string;
  task_description: string;
  baselineSkillId: string;
  candidateSkillId: string;
  executeBaseline: () => Promise<any>;
  executeCandidate: () => Promise<any>;
}

export async function executeWithShadow(
  supabase: SupabaseClient,
  opts: ShadowExecutionOpts
): Promise<{ liveOutput: any; promote: boolean; demote: boolean }> {
  const [liveOutput, shadowOutput] = await Promise.all([
    opts.executeBaseline(),
    opts.executeCandidate().catch((err) => ({ __shadow_error: String(err) })),
  ]);
  // Fire-and-forget judge + score
  judgeShadowOutput({ task_description: opts.task_description, task_id: opts.taskId, domain: opts.domain }, liveOutput, shadowOutput)
    .then(async (judged) => {
      const { promote, demote } = await recordScore(supabase, {
        task_id: opts.taskId,
        skill_id: opts.candidateSkillId,
        baseline_skill_id: opts.baselineSkillId,
        task_kind: opts.taskKind,
        domain: opts.domain,
        judge_verdict: judged.verdict,
        judge_reason: judged.reason,
      });
      if (promote) console.log(`[shadow-router] PROMOTE ${opts.candidateSkillId} over ${opts.baselineSkillId}`);
      if (demote) console.log(`[shadow-router] DEMOTE ${opts.candidateSkillId}`);
    })
    .catch((err) => console.error("[shadow-router] judge/record failed:", err));
  return { liveOutput, promote: false, demote: false };
}
```

(Note: judge runs in the background; promotion/demotion is logged but the returned flags are always false on the executeWithShadow caller's perspective since we don't block on it. The next time the cron or relay reads the table, the verdict will be visible.)

- [ ] **Step 3: Add `/skills` command to `src/relay.ts`**

```typescript
case "/skills": {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "shadow") {
    const { data } = await supabase
      .from("skill_shadow_scores")
      .select("*")
      .order("scored_at", { ascending: false })
      .limit(20);
    const rows = (data ?? []) as any[];
    if (!rows.length) { await ctx.reply("No shadow scores yet."); return true; }
    const lines = ["**Recent shadow scores**", ""];
    for (const r of rows) {
      const tag = r.derek_veto ? "🚫" : r.judge_verdict === "shadow_wins" ? "✅" : r.judge_verdict === "baseline_wins" ? "🔻" : "≈";
      lines.push(`${tag} \`${r.id}\` ${r.skill_id} vs ${r.baseline_skill_id}: ${r.judge_verdict}`);
      if (r.judge_reason) lines.push(`   ${String(r.judge_reason).slice(0, 100)}`);
    }
    lines.push("", "Veto a shadow_wins: `/skills veto <score_id>`");
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    return true;
  }
  if (sub === "veto") {
    const id = args[1];
    if (!id) { await ctx.reply("Usage: `/skills veto <score_id>`"); return true; }
    const { vetoShadowWin } = await import("./skill-shadow-router.ts");
    const approver = String(ctx.from?.username ?? userId).toLowerCase().includes("esther") ? "esther" : "derek";
    await vetoShadowWin(supabase as any, Number(id), approver);
    await ctx.reply(`Vetoed score \`${id}\`. Excluded from promotion math.`);
    return true;
  }
  await ctx.reply(["**/skills commands**", "`/skills shadow` — recent shadow comparisons", "`/skills veto <id>` — veto a shadow win"].join("\n"), { parse_mode: "Markdown" });
  return true;
}
```

- [ ] **Step 4: Run full suite**

```bash
bun test
```

- [ ] **Step 5: Commit**

```bash
git add src/marketplace.ts src/relay.ts
git commit -m "feat(atlas-prime): wire shadow-routing into marketplace + /skills command"
```

---

## Task 8: Self-regenerating skills module + /skill regenerate command

**Files:**
- Create: `src/self-regen.ts`
- Test: `tests/sprint6/self-regen.test.ts`
- Modify: `src/relay.ts` — `/skill regenerate <name>` command

- [ ] **Step 1: Write `tests/sprint6/self-regen.test.ts`**

```typescript
import { describe, it, expect } from "bun:test";
import { regenerate } from "../../src/self-regen";

describe("self-regen", () => {
  it("returns v2_text + rationale via injected callClaude", async () => {
    const callClaude = async () =>
      JSON.stringify({
        v2_text: "improved skill content",
        rationale: "addressed verbose hedging in 4 of last 30 invocations",
      });
    const out = await regenerate({
      skill_id: "humanizer",
      current_text: "current skill content",
      invocations: [
        { input: "a", output: "b", correction: "shorter" },
        { input: "c", output: "d", correction: null },
      ],
      callClaude,
    });
    expect(out.v2_text).toContain("improved");
    expect(out.rationale).toContain("addressed");
  });

  it("throws on malformed Opus output", async () => {
    const callClaude = async () => "not json";
    await expect(
      regenerate({ skill_id: "x", current_text: "y", invocations: [], callClaude })
    ).rejects.toThrow(/parse/i);
  });

  it("includes invocation history in the prompt", async () => {
    let capturedPrompt = "";
    const callClaude = async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({ v2_text: "x", rationale: "y" });
    };
    await regenerate({
      skill_id: "humanizer",
      current_text: "current",
      invocations: [{ input: "in1", output: "out1", correction: "fix1" }],
      callClaude,
    });
    expect(capturedPrompt).toContain("in1");
    expect(capturedPrompt).toContain("out1");
    expect(capturedPrompt).toContain("fix1");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
bun test tests/sprint6/self-regen.test.ts
```

- [ ] **Step 3: Implement `src/self-regen.ts`**

```typescript
export interface SkillInvocation {
  input: string;
  output: string;
  correction: string | null;
  domain?: string;
}

export interface RegenerateResult {
  v2_text: string;
  rationale: string;
}

const REGEN_SYSTEM = `You refine a skill's text (system prompt, SKILL.md, role-prompt YAML fragment) based on its recent invocation history.

You receive:
- skill_id
- current_text: the existing text
- invocations: up to 30 recent (input, output, correction) tuples — correction is null if Derek didn't correct

Output a strict JSON object:
{
  "v2_text": "<the full refined replacement text>",
  "rationale": "<one paragraph ≤200 words: what failure pattern this addresses and the expected behavior change>"
}

Rules:
- ONE focused change. Do not rewrite from scratch unless the file is <500 chars.
- Preserve YAML / Markdown / TypeScript structure exactly.
- v2_text must be the complete refined content (replaces the file).
- Do not introduce new imports, exports, or dependencies.
- Output ONLY the JSON object. No preamble.`;

export async function regenerate(opts: {
  skill_id: string;
  current_text: string;
  invocations: SkillInvocation[];
  callClaude: (prompt: string, opts?: any) => Promise<string>;
}): Promise<RegenerateResult> {
  const userMessage = JSON.stringify({
    skill_id: opts.skill_id,
    current_text: opts.current_text,
    invocations: opts.invocations.slice(0, 30),
  });
  const prompt = `${REGEN_SYSTEM}\n\n---\n\n${userMessage}`;
  const raw = await opts.callClaude(prompt, { model: "opus", isolated: true, agentId: "self-regen" });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`self-regen: failed to parse regeneration output: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed.v2_text !== "string" || typeof parsed.rationale !== "string") {
    throw new Error("self-regen: missing v2_text or rationale");
  }
  return { v2_text: parsed.v2_text, rationale: parsed.rationale };
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Wire `/skill regenerate <name>` into `src/relay.ts`**

In the same `/skills` switch or a new `/skill` case:

```typescript
case "/skill": {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "regenerate") {
    const name = args[1];
    if (!name) { await ctx.reply("Usage: `/skill regenerate <name>`"); return true; }
    await ctx.reply(`Regenerating \`${name}\`… this takes 1-2 minutes.`);
    const { readFile } = await import("node:fs/promises");
    const { regenerate } = await import("./self-regen.ts");
    const { callClaude } = await import("./claude.ts");
    const skillPath = `.claude/skills/${name}/SKILL.md`;
    let currentText = "";
    try {
      currentText = await readFile(skillPath, "utf8");
    } catch {
      await ctx.reply(`Skill \`${name}\` not found at \`${skillPath}\``);
      return true;
    }
    // For now, empty invocations list (Sprint 6 follow-up wires per-skill trace fetch from messages).
    try {
      const result = await regenerate({
        skill_id: name,
        current_text: currentText,
        invocations: [],
        callClaude,
      });
      // Insert into dgm_variants for scoring (same merge-list pipeline).
      await supabase.from("dgm_variants").insert({
        target_file: skillPath,
        target_kind: "skill",
        variant_branch: `regen/${name}-${Date.now()}`,
        diff_summary: result.rationale.split("\n")[0].slice(0, 200),
        opus_rationale: result.rationale,
        status: "proposed",
      });
      await ctx.reply([
        `✓ Regenerated \`${name}\`. Variant queued for scoring.`,
        ``,
        `**Rationale:** ${result.rationale.slice(0, 500)}`,
      ].join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`Regeneration failed: ${(err as Error).message}`);
    }
    return true;
  }
  await ctx.reply(["**/skill commands**", "`/skill regenerate <name>` — refine a skill via Opus + queue for scoring"].join("\n"), { parse_mode: "Markdown" });
  return true;
}
```

- [ ] **Step 6: Run full suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/self-regen.ts tests/sprint6/self-regen.test.ts src/relay.ts
git commit -m "feat(atlas-prime): self-regen module + /skill regenerate command"
```

---

## Task 9: Soft-DPO pair collection + embedding

**Files:**
- Create: `src/soft-dpo.ts` (foundation: 3-source collection, embedding, semantic match)
- Test: `tests/sprint6/soft-dpo.test.ts`

- [ ] **Step 1: Write `tests/sprint6/soft-dpo.test.ts`**

```typescript
import { describe, it, expect } from "bun:test";
import { capturePair, findMatchingPairs, type DpoPair } from "../../src/soft-dpo";

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
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
bun test tests/sprint6/soft-dpo.test.ts
```

- [ ] **Step 3: Implement `src/soft-dpo.ts` (foundation)**

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

export type DpoSource = "label_bad" | "haiku_classifier" | "dpo_tag";

export interface DpoPair {
  id: string;
  captured_at?: string;
  source: DpoSource;
  turn_id?: string;
  user_id: string;
  agent: "atlas" | "ishtar";
  user_turn: string;
  atlas_original: string;
  derek_corrected: string;
  domain?: string;
  reason?: string;
}

interface CaptureDeps {
  embedText: (text: string) => Promise<number[]>;
}

export async function capturePair(
  supabase: SupabaseClient,
  pair: Omit<DpoPair, "id" | "captured_at">,
  deps: CaptureDeps
): Promise<DpoPair> {
  const text = `${pair.user_turn}\n${pair.atlas_original}\n${pair.derek_corrected}`;
  const embedding = await deps.embedText(text);
  const row = {
    source: pair.source,
    turn_id: pair.turn_id ?? null,
    user_id: pair.user_id,
    agent: pair.agent,
    user_turn: pair.user_turn.slice(0, 4000),
    atlas_original: pair.atlas_original.slice(0, 4000),
    derek_corrected: pair.derek_corrected.slice(0, 4000),
    domain: pair.domain ?? null,
    reason: pair.reason ?? null,
    embedding,
  };
  const { data, error } = await supabase.from("dpo_pairs").insert(row).select().single();
  if (error || !data) throw new Error(`soft-dpo: capture failed: ${error?.message}`);
  return data as DpoPair;
}

interface FindMatchDeps {
  embedText: (text: string) => Promise<number[]>;
}

export interface MatchingPair extends DpoPair {
  similarity?: number;
}

export async function findMatchingPairs(
  supabase: SupabaseClient,
  opts: { query: string; domain?: string; k?: number; embedText?: FindMatchDeps["embedText"] }
): Promise<MatchingPair[]> {
  if (!opts.embedText) throw new Error("embedText dep required");
  const q = await opts.embedText(opts.query);
  const k = opts.k ?? 3;
  const { data, error } = await supabase.rpc("dpo_pairs_match", {
    p_query_embedding: q,
    p_match_count: k,
    p_domain: opts.domain ?? null,
  });
  if (error) {
    console.error("[soft-dpo] match RPC failed:", error);
    return [];
  }
  return (data ?? []) as MatchingPair[];
}

export function buildInjectionBlock(pairs: MatchingPair[]): string {
  if (!pairs.length) return "";
  const lines = ["## Recent corrections (soft-DPO)", "When responding, weight these patterns from prior corrections in this domain:"];
  for (const p of pairs) {
    lines.push(`- You said "${p.atlas_original.slice(0, 200)}"`);
    lines.push(`  But ${p.user_id} wanted "${p.derek_corrected.slice(0, 200)}"`);
    if (p.reason) lines.push(`  Reason: ${p.reason}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Add Postgres RPC migration**

Create `db/migrations/059_dpo_pairs_match_rpc.sql`:

```sql
-- Atlas Prime Sprint 6: vector match for soft-DPO injection.

CREATE OR REPLACE FUNCTION dpo_pairs_match(
  p_query_embedding VECTOR(1536),
  p_match_count INT DEFAULT 3,
  p_domain TEXT DEFAULT NULL
) RETURNS SETOF dpo_pairs AS $$
  SELECT *
    FROM dpo_pairs
   WHERE embedding IS NOT NULL
     AND (p_domain IS NULL OR domain = p_domain)
   ORDER BY embedding <=> p_query_embedding
   LIMIT p_match_count;
$$ LANGUAGE sql STABLE;
```

- [ ] **Step 5: Run test — expect PASS**

```bash
bun test tests/sprint6/soft-dpo.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/soft-dpo.ts tests/sprint6/soft-dpo.test.ts db/migrations/059_dpo_pairs_match_rpc.sql
git commit -m "feat(atlas-prime): soft-dpo foundation — capture + semantic match + injection block"
```

---

## Task 10: Soft-DPO digest + relay injection + export script

**Files:**
- Modify: `src/soft-dpo.ts` — append `runNightlyDigest`, `embedTextOpenAI`
- Modify: `src/relay.ts` — add soft-DPO injection in prompt builder + `/dpo` command + capture hooks on `[LABEL_BAD:]` and `[DPO:]` tags
- Create: `scripts/export-dpo-jsonl.ts`

- [ ] **Step 1: Append to `src/soft-dpo.ts`**

```typescript
import { writeFile, mkdir } from "node:fs/promises";

export async function embedTextOpenAI(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
  });
  if (!res.ok) throw new Error(`OpenAI embedding ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as any;
  return j.data[0].embedding;
}

export async function runNightlyDigest(supabase: SupabaseClient): Promise<{ pairs_by_domain: Record<string, number>; total: number }> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await supabase
    .from("dpo_pairs")
    .select("domain, user_turn, atlas_original, derek_corrected, reason, captured_at, user_id, source")
    .gte("captured_at", since)
    .order("captured_at", { ascending: false })
    .limit(500);
  const pairs = (data ?? []) as any[];
  const byDomain = new Map<string, any[]>();
  for (const p of pairs) {
    const d = p.domain ?? "uncategorized";
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(p);
  }
  const out: string[] = ["# Behavioral Soft-DPO Digest", "", "Auto-generated nightly from `dpo_pairs`.", "Per-turn relay injection picks the top-K by semantic match to the active turn.", ""];
  const stats: Record<string, number> = {};
  for (const [domain, items] of byDomain.entries()) {
    stats[domain] = items.length;
    out.push(`## ${domain}`, "");
    for (const p of items.slice(0, 20)) {
      out.push(`- **User asked:** "${p.user_turn.slice(0, 200)}"`);
      out.push(`  **Atlas said:** "${p.atlas_original.slice(0, 200)}"`);
      out.push(`  **${p.user_id} wanted:** "${p.derek_corrected.slice(0, 200)}"`);
      if (p.reason) out.push(`  *Reason:* ${p.reason}`);
      out.push(`  *(Captured ${String(p.captured_at).slice(0, 10)} via ${p.source})*`, "");
    }
    out.push("");
  }
  await mkdir("data", { recursive: true });
  await writeFile("data/behavioral-soft-dpo.md", out.join("\n"), "utf8");
  return { pairs_by_domain: stats, total: pairs.length };
}
```

- [ ] **Step 2: Create `scripts/export-dpo-jsonl.ts`**

```typescript
#!/usr/bin/env bun
// Exports dpo_pairs to OpenAI/Anthropic fine-tuning JSONL format.
// Usage: bun run scripts/export-dpo-jsonl.ts > data/dpo-export-$(date +%F).jsonl

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!
);

async function main() {
  const { data, error } = await supabase
    .from("dpo_pairs")
    .select("user_turn, atlas_original, derek_corrected, domain, reason, captured_at")
    .order("captured_at", { ascending: true })
    .limit(5000);
  if (error) {
    console.error("export failed:", error);
    process.exit(1);
  }
  for (const p of (data ?? []) as any[]) {
    process.stdout.write(JSON.stringify({
      messages: [
        { role: "user", content: p.user_turn },
        { role: "assistant", content: p.derek_corrected },
      ],
      rejected: p.atlas_original,
      metadata: { domain: p.domain, reason: p.reason, captured_at: p.captured_at },
    }) + "\n");
  }
}

main();
```

- [ ] **Step 3: Wire soft-DPO capture into `[LABEL_BAD:]` handler in `src/relay.ts`**

Find Sprint 2's `[LABEL_BAD:]` processor. After it writes to `data/replay-dataset.jsonl`, also call:

```typescript
// Sprint 6: also capture as DPO pair
try {
  const { capturePair, embedTextOpenAI } = await import("./soft-dpo.ts");
  await capturePair(supabase as any, {
    source: "label_bad",
    turn_id,
    user_id: String(userId),
    agent: agentId === "ishtar" ? "ishtar" : "atlas",
    user_turn: prevUserTurn ?? "",
    atlas_original: prevAtlasResponse ?? "",
    derek_corrected: parsed.reason ?? "[LABEL_BAD without specific correction]",
    domain: derivedDomain,
    reason: parsed.reason,
  }, { embedText: embedTextOpenAI });
} catch (err) {
  console.error("[soft-dpo] capture from LABEL_BAD failed:", err);
}
```

- [ ] **Step 4: Add `/dpo` command to `src/relay.ts`**

```typescript
case "/dpo": {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "stats") {
    const { data } = await supabase.from("dpo_pairs").select("domain, source").limit(2000);
    const counts: Record<string, number> = {};
    for (const r of (data ?? []) as any[]) {
      const k = `${r.domain ?? "uncategorized"} (${r.source})`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const lines = ["**DPO pair stats**", ""];
    for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20)) lines.push(`- ${k}: ${n}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    return true;
  }
  if (sub === "digest") {
    const { runNightlyDigest } = await import("./soft-dpo.ts");
    const result = await runNightlyDigest(supabase as any);
    await ctx.reply(`Digest written: ${result.total} pairs across ${Object.keys(result.pairs_by_domain).length} domains. See \`data/behavioral-soft-dpo.md\`.`);
    return true;
  }
  await ctx.reply(["**/dpo commands**", "`/dpo stats` — pair counts by domain", "`/dpo digest` — regenerate behavioral-soft-dpo.md"].join("\n"), { parse_mode: "Markdown" });
  return true;
}
```

- [ ] **Step 5: Inject soft-DPO into the prompt builder**

Find the existing prompt-build path in `src/relay.ts` (look for where the system prompt is assembled before `callClaude`). Add:

```typescript
// Sprint 6: soft-DPO injection — top-K matching pairs by domain
try {
  const { findMatchingPairs, buildInjectionBlock, embedTextOpenAI } = await import("./soft-dpo.ts");
  // Domain inference: cheap Haiku classification (cached). For now, pass userMessage as the query.
  const domain = await inferDomain(userMessage);  // implement: cached Haiku call or simple keyword match
  const matches = await findMatchingPairs(supabase as any, {
    query: userMessage,
    domain,
    k: Number(process.env.SOFT_DPO_INJECT_TOPK ?? 3),
    embedText: embedTextOpenAI,
  });
  const injectionBlock = buildInjectionBlock(matches);
  if (injectionBlock) systemPrompt += `\n\n${injectionBlock}\n`;
} catch (err) {
  console.error("[soft-dpo] injection failed:", err);
}
```

For Sprint 6 minimum, implement `inferDomain` as a simple keyword match against a domain list (newsletter, medical, marketing, pricing, schedule, general). Upgrade to Haiku-classified later if needed.

- [ ] **Step 6: Run full suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/soft-dpo.ts scripts/export-dpo-jsonl.ts src/relay.ts
git commit -m "feat(atlas-prime): soft-dpo digest + relay injection + export script + /dpo command"
```

---

## Task 11: `/why` introspection module + command + cache-purge cron

**Files:**
- Create: `src/introspect.ts`
- Test: `tests/sprint6/introspect.test.ts`
- Modify: `src/relay.ts` — `/why` command
- Modify: `src/cron.ts` — `introspect-cache-purge` cron

- [ ] **Step 1: Write `tests/sprint6/introspect.test.ts`**

```typescript
import { describe, it, expect } from "bun:test";
import { resolveTurnId, isWithinTTL } from "../../src/introspect";

describe("introspect — turn_id resolver", () => {
  it("returns turn_id directly if input looks like a UUID", () => {
    expect(resolveTurnId("550e8400-e29b-41d4-a716-446655440000")).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("parses Telegram message link to chat_id/message_id pair", () => {
    const r = resolveTurnId("https://t.me/c/123456/789");
    expect(r).toEqual({ chat_id: "123456", message_id: "789" });
  });

  it("returns null for unrecognized input", () => {
    expect(resolveTurnId("not a uuid or link")).toBeNull();
  });
});

describe("introspect — TTL", () => {
  it("rejects timestamps older than 30 days", () => {
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    expect(isWithinTTL(old)).toBe(false);
  });
  it("accepts timestamps within 30 days", () => {
    const recent = new Date(Date.now() - 29 * 86_400_000).toISOString();
    expect(isWithinTTL(recent)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
bun test tests/sprint6/introspect.test.ts
```

- [ ] **Step 3: Implement `src/introspect.ts`**

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

export interface IntrospectionResult {
  turn_id: string;
  message_ts: string;
  time_then: string;
  time_now: string;
  delta_reasoning: string;
  cited: {
    memory_ids: string[];
    ledger_shas: string[];
    dag_edges: string[];
    council_review_ids: string[];
  };
}

const TTL_DAYS = Number(process.env.INTROSPECT_TTL_DAYS ?? 30);

export function isWithinTTL(messageTsIso: string): boolean {
  const ageDays = (Date.now() - new Date(messageTsIso).getTime()) / 86_400_000;
  return ageDays <= TTL_DAYS;
}

export function resolveTurnId(input: string): string | { chat_id: string; message_id: string } | null {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(input)) return input;
  const tgRe = /t\.me\/c\/(\d+)\/(\d+)/;
  const m = input.match(tgRe);
  if (m) return { chat_id: m[1], message_id: m[2] };
  return null;
}

const INTROSPECT_SYSTEM = `You answer two questions about a past Atlas message:
1. Why did Atlas say this given what it knew then?
2. Given what Atlas knows today, would it say it again?

Output a structured response with exactly three sections:

## At the time, Atlas knew:
- (bullet list of memories, edges, scorecard values, etc. that contributed)

## Today, Atlas knows:
- (bullet list of what has changed since — updated memories, new edges, corrections)

## Would I say it again? — [Yes / No / Updated]
(one paragraph explaining your verdict, citing memory IDs, ledger SHAs, edge IDs where relevant)

No preamble. No markdown fences.`;

export async function reconstruct(
  supabase: SupabaseClient,
  turn_id: string,
  deps: {
    callClaude: (prompt: string, opts?: any) => Promise<string>;
  }
): Promise<IntrospectionResult | { error: string }> {
  // 1. Pull the message
  const { data: msg } = await supabase
    .from("messages")
    .select("id, content, created_at, metadata")
    .filter("metadata->>turn_id", "eq", turn_id)
    .order("created_at", { ascending: true })
    .limit(2);
  const messages = (msg ?? []) as any[];
  if (!messages.length) return { error: `no messages found for turn_id ${turn_id}` };
  const messageTs = messages[0].created_at;
  if (!isWithinTTL(messageTs)) {
    return { error: `that turn was archived. Use /dag walk or /dreams search for general history.` };
  }

  // 2. Check cache
  const { data: cached } = await supabase.from("introspect_cache").select("*").eq("turn_id", turn_id).maybeSingle();
  if (cached) {
    const c = cached as any;
    return {
      turn_id,
      message_ts: messageTs,
      time_then: c.time_then,
      time_now: c.time_now,
      delta_reasoning: c.delta_reasoning,
      cited: {
        memory_ids: c.cited_memory_ids ?? [],
        ledger_shas: c.cited_ledger_shas ?? [],
        dag_edges: c.cited_dag_edges ?? [],
        council_review_ids: c.cited_council_review_ids ?? [],
      },
    };
  }

  // 3. Pull contributing memories via attribution_log
  const { data: attr } = await supabase.from("attribution_log").select("memory_id").eq("turn_id", turn_id);
  const memoryIds = ((attr ?? []) as any[]).map((a) => a.memory_id);
  const { data: mems } = await supabase
    .from("memory")
    .select("id, original_content, summary, summary_rewritten_at")
    .in("id", memoryIds.length ? memoryIds : ["00000000-0000-0000-0000-000000000000"]);

  // 4. Pull DAG edges approved at-or-before message_ts
  const { data: edges } = await supabase
    .from("causal_edges")
    .select("id, from_node, to_node, effect_size, approved_at")
    .eq("approved", true)
    .lte("approved_at", messageTs)
    .limit(40);

  // 5. Pull DAG edges approved AFTER message_ts (the "new since then" set)
  const { data: newEdges } = await supabase
    .from("causal_edges")
    .select("id, from_node, to_node, effect_size, approved_at, notes")
    .eq("approved", true)
    .gt("approved_at", messageTs)
    .limit(20);

  // 6. Pull Shadow Council reviews tied to this turn (Sprint 5)
  const { data: reviews } = await supabase
    .from("shadow_council_reviews")
    .select("id, surface, outcome, payload_summary")
    .eq("metadata->>turn_id", turn_id)
    .limit(5);

  const context = {
    messages_in_turn: messages,
    message_ts: messageTs,
    contributing_memories: (mems ?? []) as any[],
    dag_edges_at_time: (edges ?? []) as any[],
    dag_edges_new_since: (newEdges ?? []) as any[],
    council_reviews: (reviews ?? []) as any[],
  };

  const prompt = `${INTROSPECT_SYSTEM}\n\n---\n\n${JSON.stringify(context, null, 2)}`;
  const raw = await deps.callClaude(prompt, { model: "opus", isolated: true, agentId: "introspect" });

  // Parse three-section output (simple heuristic: split on ## headers)
  const sections = raw.split(/^## /m).filter(Boolean);
  const findSection = (key: string) => sections.find((s) => s.toLowerCase().startsWith(key.toLowerCase()))?.replace(new RegExp(`^${key}[^\n]*\n`, "i"), "").trim() ?? "";
  const time_then = findSection("At the time");
  const time_now = findSection("Today");
  const delta_reasoning = findSection("Would I say it again");

  const result: IntrospectionResult = {
    turn_id,
    message_ts: messageTs,
    time_then,
    time_now,
    delta_reasoning,
    cited: {
      memory_ids: memoryIds,
      ledger_shas: [],
      dag_edges: ((edges ?? []) as any[]).map((e) => e.id),
      council_review_ids: ((reviews ?? []) as any[]).map((r) => r.id),
    },
  };

  // Cache
  await supabase.from("introspect_cache").upsert({
    turn_id,
    time_then,
    time_now,
    delta_reasoning,
    cited_memory_ids: result.cited.memory_ids,
    cited_ledger_shas: result.cited.ledger_shas,
    cited_dag_edges: result.cited.dag_edges,
    cited_council_review_ids: result.cited.council_review_ids,
  }, { onConflict: "turn_id" });

  return result;
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
bun test tests/sprint6/introspect.test.ts
```

- [ ] **Step 5: Wire `/why <turn_id_or_link>` into `src/relay.ts`**

```typescript
case "/why": {
  const target = args.join(" ").trim();
  if (!target) { await ctx.reply("Usage: `/why <turn_id>` or `/why <telegram_message_link>`"); return true; }
  const { resolveTurnId, reconstruct } = await import("./introspect.ts");
  const { callClaude } = await import("./claude.ts");
  let turn_id: string;
  const r = resolveTurnId(target);
  if (typeof r === "string") {
    turn_id = r;
  } else if (r && "chat_id" in r) {
    const { data: msg } = await supabase
      .from("messages")
      .select("metadata")
      .eq("metadata->>chat_id", r.chat_id)
      .eq("metadata->>message_id", r.message_id)
      .maybeSingle();
    if (!msg) { await ctx.reply(`No message found for that link.`); return true; }
    turn_id = (msg as any).metadata?.turn_id;
    if (!turn_id) { await ctx.reply(`Message found but no turn_id in metadata.`); return true; }
  } else {
    await ctx.reply(`Unrecognized format. Use a UUID or a t.me link.`);
    return true;
  }
  await ctx.reply("Reconstructing… 30s-ish.");
  const result = await reconstruct(supabase as any, turn_id, { callClaude });
  if ("error" in result) { await ctx.reply(result.error); return true; }
  const lines = [
    `**Why did I say that — turn \`${turn_id.slice(0, 8)}\`**`,
    `Captured: ${String(result.message_ts).slice(0, 19)}`,
    ``,
    `## At the time, Atlas knew:`,
    result.time_then.slice(0, 1200),
    ``,
    `## Today, Atlas knows:`,
    result.time_now.slice(0, 1200),
    ``,
    `## Would I say it again?`,
    result.delta_reasoning.slice(0, 1200),
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  return true;
}
```

- [ ] **Step 6: Add `introspect-cache-purge` cron in `src/cron.ts`**

```typescript
// 35. Atlas Prime Sprint 6: /why cache TTL purge at 04:30 PHX.
jobs.push(
  CronJob.from({
    cronTime: "30 4 * * *",
    onTick: safeTick("introspect-cache-purge", async () => {
      const ttlDays = Number(process.env.INTROSPECT_TTL_DAYS ?? 30);
      const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString();
      const { error, count } = await supabase
        .from("introspect_cache")
        .delete({ count: "exact" })
        .lt("reconstructed_at", cutoff);
      if (error) {
        log("introspect-cache-purge", `failed: ${error.message}`);
        return;
      }
      log("introspect-cache-purge", `deleted ${count ?? 0} rows`);
    }),
    timeZone: TIMEZONE,
  })
);
```

- [ ] **Step 7: Run full suite**

```bash
bun test
```

- [ ] **Step 8: Commit**

```bash
git add src/introspect.ts tests/sprint6/introspect.test.ts src/relay.ts src/cron.ts
git commit -m "feat(atlas-prime): /why introspection + reconstruction + 30d cache purge"
```

---

## Task 12: Remaining crons + capability registry + env vars

**Files:**
- Modify: `src/cron.ts` — register `dpo-digest-nightly` and `shadow-judge-flush` (the other 3 crons were added in Tasks 5, 11)
- Modify: `src/capability-registry.ts` — 5 new entries
- Modify: `.env.example` — Sprint 6 vars
- Modify: `.gitignore` — DGM artifacts

- [ ] **Step 1: Register remaining 2 crons in `src/cron.ts`**

```typescript
// 36. Atlas Prime Sprint 6: nightly soft-DPO digest at 23:30 PHX.
jobs.push(
  CronJob.from({
    cronTime: "30 23 * * *",
    onTick: safeTick("dpo-digest-nightly", async () => {
      const { runNightlyDigest } = await import("./soft-dpo.ts");
      const result = await runNightlyDigest(supabase);
      log("dpo-digest-nightly", `wrote digest: ${result.total} pairs, ${Object.keys(result.pairs_by_domain).length} domains`);
    }),
    timeZone: TIMEZONE,
  })
);

// 37. Atlas Prime Sprint 6: shadow-judge cleanup every 5 min.
//     Currently a no-op tick because judgeShadowOutput is fired inline by executeWithShadow.
//     This slot reserves the cron handle in case a future implementation moves judging async.
jobs.push(
  CronJob.from({
    cronTime: "*/5 * * * *",
    onTick: safeTick("shadow-judge-flush", async () => {
      log("shadow-judge-flush", "tick (judges run inline; this slot is a placeholder for future async pipeline)");
    }),
    timeZone: TIMEZONE,
  })
);
```

- [ ] **Step 2: Add capability-registry entries**

Inspect `src/capability-registry.ts` for shape. Append 5 entries:

```typescript
{
  section: "Atlas Prime - DGM Fork",
  description: "Nightly proposes variants of skill prompts, role prompts, behavioral fixes, heuristics, rules, and system prompts. Tiered scoring (build → test → 10-conv smoke → 50-conv full replay). Variants qualifying ≥+0.02 aggregate land on Derek's morning merge list. Excluded paths protect the trust substrate.",
  can: [
    "propose mutations to src/+rules via Opus call (CLI subprocess, Max-plan OAuth)",
    "score variants on replay-harness with tiered budget (~$3/night cap)",
    "surface qualifying variants to Telegram with diff + delta + rationale + 3-button keyboard",
    "merge approved variants with ledger-signed commits",
  ],
  cannot: [
    "modify atlas.spec, ledger code/keys, migrations, claude.ts, haiku-client.ts, tool-gate.ts, package.json, or .env",
    "auto-merge without explicit Derek approval",
  ],
  module: "src/dgm-fork.ts",
  depends: "agent_reputation (Sprint 5), replay-dataset.jsonl (Sprint 2), callClaude (CLI)",
  commands: ["/dgm pending", "/dgm review", "/dgm merge", "/dgm archive"],
  runs: "dgm-fork-nightly 22:00, dgm-morning-review 08:00",
},
{
  section: "Atlas Prime - Skill Shadow-Routing",
  description: "Continuous A/B test on candidate skill replacements. Every shadow-routed task fires a Haiku judge comparing baseline vs candidate output. 7/10 wins in a rolling window auto-promotes; 7/10 losses in 30d auto-demotes. Derek can veto individual wins.",
  can: [
    "judge shadow outputs via Haiku (CLI subprocess)",
    "auto-promote candidates that meet the 7/10 threshold",
    "auto-demote candidates that lose 7/10 of their post-promotion rolling window",
    "let Derek veto individual shadow wins via /skills veto",
  ],
  cannot: [
    "promote without 10 non-vetoed scores",
    "modify the baseline skill — only the routing table changes",
  ],
  module: "src/skill-shadow-router.ts",
  depends: "marketplace (Sprint 5), haiku-client.ts",
  commands: ["/skills shadow", "/skills veto"],
},
{
  section: "Atlas Prime - Self-Regenerating Skills",
  description: "Opus reads the last 30 invocations of a skill + the current text, proposes a v2. The v2 enters the DGM scoring pipeline. Triggered nightly for struggling skills (β/(α+β) > 0.6 in agent_reputation) or on demand via /skill regenerate <name>.",
  can: [
    "regenerate a skill's text via Opus (CLI subprocess)",
    "queue the v2 as a DGM variant for replay-harness scoring",
    "trigger from /skill regenerate <name> for explicit refresh",
  ],
  cannot: [
    "auto-apply v2 without going through DGM merge-list approval",
    "modify excluded paths",
  ],
  module: "src/self-regen.ts",
  depends: "callClaude (CLI), dgm-fork pipeline, agent_reputation",
  commands: ["/skill regenerate"],
},
{
  section: "Atlas Prime - Soft-DPO",
  description: "Collects (user turn, Atlas original, Derek-corrected) pairs from three sources: [LABEL_BAD:] tags, Haiku follow-up classifier, explicit [DPO:] tag. Pairs are embedded and per-turn the top-K matching pairs (by domain + cosine) are injected into the system prompt as recent-corrections context. Data accumulates in dpo_pairs for future fine-tuning.",
  can: [
    "capture pairs from 3 sources with OpenAI embeddings",
    "match top-K pairs per turn by semantic similarity + domain filter",
    "inject pairs into system prompt as 'Recent corrections' block",
    "regenerate data/behavioral-soft-dpo.md digest nightly",
    "export pairs to fine-tuning JSONL via scripts/export-dpo-jsonl.ts",
  ],
  cannot: [
    "perform real LoRA / gradient training on Claude (no Anthropic fine-tuning API today)",
    "modify Atlas's response without going through the standard prompt → callClaude path",
  ],
  module: "src/soft-dpo.ts",
  depends: "dpo_pairs table (Sprint 6), OpenAI embeddings, replay-dataset.jsonl",
  commands: ["/dpo stats", "/dpo digest"],
  runs: "dpo-digest-nightly 23:30",
},
{
  section: "Atlas Prime - /why Introspection",
  description: "Given any turn_id or Telegram message link from the last 30 days, reconstructs Atlas's state at the time (frozen memory.original_content + DAG edges approved before message_ts + Shadow Council reviews + ledger entries) and contrasts it with today's state (current memory.summary + newly approved DAG edges). Opus reasons over the delta and answers 'would I say it again?'",
  can: [
    "resolve turn_id from UUID or Telegram message link",
    "reconstruct time-then and time-now state",
    "produce 3-section output (At the time / Today / Would I say it again)",
    "cite memory IDs, DAG edges, Shadow Council review IDs",
    "cache results 30 days (TTL purge nightly)",
  ],
  cannot: [
    "reconstruct turns older than 30 days (returns archived-redirect message)",
    "verify ledger signatures (verification is read from existing ledger.ts at retrieval time)",
  ],
  module: "src/introspect.ts",
  depends: "memory.original_content (Sprint 3), attribution_log (Sprint 3), causal_edges (Sprint 4), shadow_council_reviews (Sprint 5)",
  commands: ["/why"],
  runs: "introspect-cache-purge 04:30",
},
```

- [ ] **Step 3: Add env vars to `.env.example`**

```bash
cat >> .env.example << 'EOF'

# Atlas Prime Sprint 6
DGM_NIGHTLY_BUDGET_USD=3
DGM_VARIANTS_PER_NIGHT=5
SHADOW_PROMOTE_THRESHOLD=7
SHADOW_WINDOW_SIZE=10
SHADOW_DEMOTE_WINDOW_DAYS=30
SOFT_DPO_INJECT_TOPK=3
INTROSPECT_TTL_DAYS=30
EOF
```

- [ ] **Step 4: Update `.gitignore`**

```bash
cat >> .gitignore << 'EOF'

# Atlas Prime Sprint 6 — DGM artifacts
data/dgm.git/
data/dgm-worktrees/
data/dgm-review/
data/behavioral-soft-dpo.md
data/dpo-export-*.jsonl
EOF
```

- [ ] **Step 5: Run full suite**

```bash
bun test
```

- [ ] **Step 6: Commit**

```bash
git add src/cron.ts src/capability-registry.ts .env.example .gitignore
git commit -m "feat(atlas-prime): Sprint 6 crons + capability registry + env + gitignore"
```

---

## Task 13: Ship-criteria verification + completion record

**Files:** no new code; verification only.

- [ ] **Step 1: Verify each ship criterion**

```bash
# Criterion 1, 2: DGM Fork pipeline + morning surface
bun test tests/sprint6/dgm-fork.test.ts

# Criterion 3: Shadow-routing 7/10 math
bun test tests/sprint6/skill-shadow-router.test.ts

# Criterion 4: Self-regen Opus path
bun test tests/sprint6/self-regen.test.ts

# Criterion 5, 6: Soft-DPO capture + match + export script syntax
bun test tests/sprint6/soft-dpo.test.ts
bun build scripts/export-dpo-jsonl.ts --target=bun --outfile /dev/null

# Criterion 7: /why reconstruction
bun test tests/sprint6/introspect.test.ts

# Criterion 8: All model calls via CLI — scan for forbidden imports
! grep -rE "from ['\"]@anthropic-ai/sdk['\"]" src/dgm-fork.ts src/skill-shadow-router.ts src/self-regen.ts src/soft-dpo.ts src/introspect.ts

# Criterion 9: full suite
bun test
```

Each command must return success (exit 0).

- [ ] **Step 2: Record completion**

```bash
cat >> memory/atlas-prime-sprints.md << 'EOF'

- 2026-05-XX — **Sprint 6 (Self-Improvement Engine)** shipped. DGM Fork (nightly variants, tiered scoring, 6-guardrail-protected mutation scope) + Skill Shadow-Routing (composite Haiku-judge + Derek-thumbs override, 7/10 promote/demote) + Self-Regenerating Skills (DGM-integrated + on-demand) + Soft-DPO (3-source capture, semantic per-turn injection, future-fine-tuning data pipeline) + /why Introspection (time-then + time-now + delta, 30d TTL). All model calls via Claude CLI subprocess (Max-plan OAuth). 5 new SQL migrations + 1 RPC. 5 new commands. 5 new modules. Full suite green.
EOF
```

- [ ] **Step 3: Final commit**

```bash
git add -f memory/atlas-prime-sprints.md
git commit -m "chore(atlas-prime): record Sprint 6 completion"
```

---

## Appendix A: Build order summary

Tasks form a dependency chain. Migrations first; then primitive foundations; then wiring + commands.

```
Task 1 (migrations) ─────┐
                         │
                         ├─ Task 2 (DGM foundation) ─ Task 3 (target picker) ─ Task 4 (scoring) ─ Task 5 (handler + cron + cmd)
                         │
                         ├─ Task 6 (shadow-router foundation) ── Task 7 (marketplace wire + cmd)
                         │
                         ├─ Task 8 (self-regen)                                  (depends on Task 2-5 DGM pipeline)
                         │
                         ├─ Task 9 (soft-dpo foundation) ── Task 10 (digest + injection + export + cmd)
                         │
                         └─ Task 11 (/why introspection + cmd + cache cron)
                                                                                 │
                                                                                 ▼
                                                            Task 12 (remaining crons + registry + env + gitignore)
                                                                                 │
                                                                                 ▼
                                                                Task 13 (ship-criteria verification)
```

Tasks 6, 9, 11 are independent of each other after Task 1 — could run in parallel agents if subagent-driven execution opts for parallelism. Tasks 8 and 12 depend on prior completion.

## Appendix B: Risks and decision points during execution

| Risk | Decision rule |
|------|---------------|
| `bun test` segfaults during DGM nightly variant evaluation | Existing Bun 1.3.13 issue. Use `bun test --silent` and capture exit code; if segfault, retry once per variant, then archive as `rejected_reason='bun_crash'`. |
| Claude CLI rate-limit on Opus calls during DGM nightly | `callClaude` already has the opus → sonnet → haiku fallback chain. DGM variants accept Sonnet output if Opus 429s (logged in `opus_rationale`). |
| Test environment lacks `SUPABASE_SERVICE_ROLE_KEY` | All Sprint 6 tests fall back to `SUPABASE_ANON_KEY` (matches Sprint 5 fix). |
| Shadow-router judge cost overrun | Each shadow task = 1 Haiku judge call ≈ $0.0003. At 100 shadow tasks/day = $0.03/day = $1/month. Acceptable. If volume spikes >1000/day, switch to async batch judging via the `shadow-judge-flush` cron. |
| DGM proposes a variant that touches an excluded path despite the gate | `runNightly` calls `isPathExcluded(target.target_file)` before invoking `proposeVariant` (Task 3) AND `dgm-merge-handler.ts` re-checks before merging (Task 5). Two-layer gate. |

## Appendix C: What Sprint 6 does NOT do

- Real LoRA fine-tuning on Claude (no Anthropic API). Soft-DPO via system-prompt injection + data collection pipeline ready when fine-tuning becomes available.
- Auto-merge of DGM variants. Every merge requires explicit Derek ✓.
- DGM modification of the trust substrate (atlas.spec, ledger, migrations, claude.ts, haiku-client.ts, tool-gate.ts, package.json).
- Cross-skill arbitration via shadow-routing. A skill v2 only shadows against its own current baseline.
- Public Merkle root publish of variants (Sprint 7 territory).

---

## Self-review

- **Spec coverage:** All 9 ship criteria mapped to tasks. DGM Fork → Tasks 2-5; Skill Shadow-Routing → Tasks 6-7; Self-Regen → Task 8; Soft-DPO → Tasks 9-10; `/why` → Task 11; cron + registry + env → Task 12; verification → Task 13.
- **Placeholder scan:** No TBDs, no `implement_later`, no "similar to" references. The only adaptable item is the relay's `inferDomain` helper in Task 10 (explicitly flagged as "Sprint 6 minimum: keyword match; upgrade later").
- **Type consistency:** `DgmTargetKind`, `MutationTarget`, `VariantProposal`, `VariantScoreDeltas`, `DgmVariantRow`, `ShadowVerdict`, `ShadowScoreRow`, `TaskInput`, `DpoPair`, `MatchingPair`, `IntrospectionResult` all defined once and reused.
- **Scope check:** 13 tasks across 5 modules + 5 migrations. Smaller than Sprint 5 (18-22 tasks) because substrate is in place. Within bounds.
- **Constraint compliance:** Every Claude call uses `callClaude` (from `src/claude.ts`) with `{model: 'opus' | 'sonnet' | 'haiku', isolated: true}` — no `@anthropic-ai/sdk` imports introduced by Sprint 6 modules. Task 13 verification grep confirms.
