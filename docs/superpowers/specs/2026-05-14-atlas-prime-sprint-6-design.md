# Atlas Prime — Sprint 6 (Self-Improvement Engine) — Design Spec

**Date:** 2026-05-14
**Owner:** Derek DiCamillo
**Status:** Locked. Ready for plan.
**Source vision:** `ATLAS-PRIME.md` lines 143-150 (Sprint 6: Self-Improvement Engine)
**Builds on:** Sprints 1-5 (atlas.spec, ledger, Haiku client via CLI, replay harness, trust budget, cortex, procedural memory, causal DAG, world model, dream engine, Derek twin, role registry, shadow council, marketplace, joint protocol, git blackboard)

---

## Goal

Atlas improves itself nightly. Every morning Derek reviews a short merge list of approved variants — refined skill prompts, tuned role prompts, behavioral-fix updates, scoring-weight adjustments — that beat the replay harness against current main. Skills that lose 7 of 10 shadow bids auto-demote. `/why <turn_id>` reconstructs the full state at any past message and tells Derek both what Atlas knew then and whether Atlas would say it again given today's knowledge.

## Ship criteria (from ATLAS-PRIME.md and our locks)

1. **DGM Fork runs nightly.** 3-5 variants per night. Build + test gate, then 10-conversation smoke replay, then top-2 get the full 50-conversation evaluation. Cap ~$3/night Haiku spend.
2. **Merge list at breakfast.** 8 AM Telegram message with diff, replay delta (groundedness/tool/refusal/aggregate), Opus rationale, 3-button keyboard (✓ merge, ✗ archive, ✏ edit-then-merge).
3. **Skill shadow-routing live with auto-promotion gate.** Composite Haiku-judge + Derek-thumbs override. 7/10 wins in 10-invocation rolling window promotes. 7/10 losses in 30-day rolling window auto-demotes.
4. **Self-regenerating skills.** Nightly DGM picks struggling skills (Sprint 5 `agent_reputation` β/(α+β) > 0.6 or recent loss streak ≥3). Opus reads last 30 invocations + current text, writes v2. v2 enters shadow-routing via the same 7/10 gate. Manual `/skill regenerate <name>` for explicit Derek opt-in.
5. **Soft-DPO inference loop closed.** Pairs collected from three sources (`[LABEL_BAD:]` tags, Haiku-classified follow-up corrections, explicit `[DPO:]` tag) land in `dpo_pairs` table. Nightly cron digests per-domain into `data/behavioral-soft-dpo.md`. Per-turn relay injects matching pairs into system prompt via semantic match (procedural-memory pattern).
6. **DPO data-collection pipeline ready for future fine-tuning.** Same `dpo_pairs` table is the seed dataset; export script `scripts/export-dpo-jsonl.ts` produces OpenAI/Anthropic fine-tuning JSONL format on demand. Inference path doesn't change — only data accumulation.
7. **`/why <turn_id>` works on any message from the last 30 days.** Three-section output: *"At the time, Atlas knew..."* (frozen `memory.original_content` + ledger snapshot + DAG state at message_ts) / *"Today, Atlas knows..."* (current `memory.summary` + current DAG) / *"Would I say it again?"* (Opus delta-reasoning, yes/no/updated).
8. **All model calls via Claude CLI subprocess (Max-plan OAuth).** No `@anthropic-ai/sdk` imports in Sprint 6 modules. `callClaude(prompt, {model:'opus', isolated:true})` for Opus, existing `callHaiku()` for Haiku (haiku-client.ts is already CLI-backed).
9. **Full test suite green.** Atlas restart healthy. No regression in Sprints 1-5.

---

## Architecture overview

```
              ┌─────────────────────────────────────────┐
              │  DGM Fork (nightly, 22:00)              │
              │  ─ pick 3-5 mutation targets             │
              │  ─ Opus proposes variants               │
              │  ─ tiered scoring (build → test → smoke │
              │    → full replay)                       │
              │  ─ writes merge-list to data/dgm-       │
              │    review/YYYY-MM-DD.jsonl              │
              └────────────┬────────────────────────────┘
                           │
                           ▼
              ┌──────────────────────────────────────────┐
              │  Morning DGM Review (08:00)              │
              │  ─ Telegram surface with diffs + scores  │
              │  ─ 3-button keyboard per variant         │
              │  ─ ✓ merges to master via ledger-signed  │
              │    commit with dgm-approved-by trailer   │
              └──────────────────────────────────────────┘

              ┌──────────────────────────────────────────┐
              │  Skill Shadow-Routing (continuous)       │
              │  ─ every shadow-routed task fires        │
              │    judgeShadowOutput(input, A, B)        │
              │  ─ 10-invocation rolling window per      │
              │    skill in skill_shadow_scores          │
              │  ─ 7/10 wins → auto-promote              │
              │  ─ 7/10 losses (30d) → auto-demote       │
              │  ─ /skills shadow surfaces recent        │
              │    comparisons + thumb-veto buttons      │
              └──────────────────────────────────────────┘

              ┌──────────────────────────────────────────┐
              │  Self-Regen (DGM-Fork-integrated)        │
              │  ─ DGM picks targets with β/(α+β) > 0.6  │
              │    or loss streak ≥3                     │
              │  ─ self-regen template: last 30          │
              │    invocations + current text → v2       │
              │  ─ v2 enters shadow-routing as candidate │
              │  ─ /skill regenerate <name> on-demand    │
              └──────────────────────────────────────────┘

              ┌──────────────────────────────────────────┐
              │  Soft-DPO Loop                           │
              │  ─ pair collection: [LABEL_BAD:],        │
              │    Haiku correction-classifier,          │
              │    [DPO:] explicit tag                   │
              │  ─ dpo_pairs table + nightly digest      │
              │  ─ per-turn semantic match injects       │
              │    matching pairs into system prompt     │
              │  ─ data export: scripts/export-dpo-      │
              │    jsonl.ts (future fine-tuning seed)    │
              └──────────────────────────────────────────┘

              ┌──────────────────────────────────────────┐
              │  /why Introspection                      │
              │  ─ /why <turn_id> | <message_link>       │
              │  ─ 30-day TTL                            │
              │  ─ time-then + time-now + delta          │
              │  ─ cites memory IDs, ledger SHAs,        │
              │    DAG edges, council reviews            │
              └──────────────────────────────────────────┘
```

**New modules (5):**
- `src/dgm-fork.ts` — variant proposal + tiered scoring + merge-list builder
- `src/skill-shadow-router.ts` — shadow execution + judge + promotion/demotion gate
- `src/self-regen.ts` — skill regeneration workflow (special case of DGM)
- `src/soft-dpo.ts` — pair collection + nightly digest + per-turn injection
- `src/introspect.ts` — `/why` reconstruction engine

**New scripts (2):**
- `scripts/dgm-merge-handler.ts` — handles ✓/✗/✏ buttons from Telegram
- `scripts/export-dpo-jsonl.ts` — export pairs to fine-tuning format

**New migrations (5):**
- `054_dgm_variants.sql`
- `055_skill_shadow_scores.sql`
- `056_dpo_pairs.sql`
- `057_dpo_pair_embeddings.sql` (semantic match index)
- `058_introspect_cache.sql` (optional `/why` result cache, 30d TTL)

**Modified modules:**
- `src/relay.ts` — `/why`, `/skill`, `/dgm`, `/dpo` commands; soft-DPO injection in prompt builder; pair-capture hooks on user follow-ups
- `src/cron.ts` — 5 new crons (`dgm-fork-nightly`, `dgm-morning-review`, `dpo-digest-nightly`, `skill-shadow-judge` per-invocation hook, `introspect-cache-purge`)
- `src/marketplace.ts` — wire shadow execution into `routeTask` to capture both live and shadow outputs
- `src/capability-registry.ts` — 5 new entries
- `.env.example` — `DGM_NIGHTLY_BUDGET_USD=3`, `DGM_VARIANTS_PER_NIGHT=5`, `SHADOW_PROMOTE_THRESHOLD=7`, `SHADOW_WINDOW_SIZE=10`, `SHADOW_DEMOTE_WINDOW_DAYS=30`, `SOFT_DPO_INJECT_TOPK=3`, `INTROSPECT_TTL_DAYS=30`

---

## §1. DGM Fork — Nightly Self-Modification

### Schema

```sql
-- db/migrations/054_dgm_variants.sql
CREATE TABLE IF NOT EXISTS dgm_variants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  target_file         TEXT NOT NULL,                    -- e.g. 'data/roles-seed.yaml' or 'src/dream-engine.ts'
  target_kind         TEXT NOT NULL CHECK (target_kind IN ('skill','role-prompt','behavioral-fix','heuristic','rule','system-prompt')),
  variant_branch      TEXT NOT NULL,                    -- git branch in dgm worktree
  diff_summary        TEXT NOT NULL,                    -- 1-paragraph human description
  opus_rationale      TEXT NOT NULL,                    -- why this variant was proposed
  build_passed        BOOLEAN,
  tests_passed        BOOLEAN,
  smoke_aggregate     REAL,                             -- 10-conv replay score
  full_aggregate      REAL,                             -- 50-conv replay score (only for top-2 smoke winners)
  main_aggregate      REAL,                             -- baseline aggregate at same time
  delta_aggregate     REAL,                             -- variant - main
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
```

### Module: `src/dgm-fork.ts`

```typescript
export interface VariantProposal {
  target_file: string;
  target_kind: 'skill' | 'role-prompt' | 'behavioral-fix' | 'heuristic' | 'rule' | 'system-prompt';
  new_content: string;
  rationale: string;
}

export async function runNightly(): Promise<{ proposed: number; merged_queue: number; archived: number }>;
export async function pickTargets(supabase, n: number): Promise<MutationTarget[]>;
export async function proposeVariant(target: MutationTarget): Promise<VariantProposal>;
export async function buildAndTest(variantBranch: string): Promise<{ build_passed: boolean; tests_passed: boolean }>;
export async function scoreSmoke(variantBranch: string): Promise<{ aggregate: number; per_axis: any }>;
export async function scoreFull(variantBranch: string): Promise<{ aggregate: number; per_axis: any }>;
export async function buildMergeList(date: string): Promise<MergeListEntry[]>;
```

### Pipeline (cron `dgm-fork-nightly` at 22:00 PHX)

1. **Pick 5 mutation targets** from:
   - Marketplace bidders with `agent_reputation.beta/(alpha+beta) > 0.6` (struggling skills/roles)
   - Recent `[LABEL_BAD:]` corrections grouped by domain (Sprint 2 replay-dataset)
   - Files cited as causes in `dpo_pairs.evidence` (recent corrections)
   - Files with stale `summary_rewritten_at` (Sprint 3 memory-rewrite signal applied to behavioral docs)
2. **For each target**, spawn an isolated git worktree at `data/dgm-worktrees/<variant_uuid>/` from current `master`.
3. **Opus proposes a variant** via `callClaude(prompt, {model:'opus', isolated:true, agentId:'dgm-fork'})`. Prompt template includes:
   - Current file content
   - Recent failures grounded in this file (last 30 days)
   - Replay-harness axis scores where this file was involved
   - Explicit instruction: "Propose ONE focused change. Output a unified diff plus a one-paragraph rationale."
4. **Apply diff** to the worktree. Insert `dgm_variants` row with `status='proposed'`.
5. **Build gate** — `bun build src/*.ts --target=bun` inside worktree. Fail → archive, status `'rejected'`, rejected_reason `'build_failed'`.
6. **Test gate** — `bun test` inside worktree. Fail → archive.
7. **Smoke replay** — 10 conversations sampled from `data/replay-dataset.jsonl`, Haiku-judged via existing replay-harness. Records `smoke_aggregate`.
8. **Top-2 by smoke** advance to **full replay** — 50 conversations, Haiku-judged. Records `full_aggregate`, `delta_*` per axis.
9. **Decision gate** — variant qualifies for merge list if:
   - `delta_aggregate >= +0.02`
   - No single axis regression > 0.05 (e.g., variant can't trade groundedness for tool-correctness)
   - Touches no excluded file (see below)
10. **Qualifying variants** → status `'queued'`, written to `data/dgm-review/YYYY-MM-DD.jsonl`.

### Excluded files (DGM cannot modify)

Hard list in `src/dgm-fork.ts`:
```typescript
const DGM_EXCLUDED_PATHS = [
  'atlas.spec',
  'data/atlas-ledger/',
  'data/atlas-ledger.key',
  'data/atlas-ledger.pub',
  'db/migrations/',
  'src/ledger.ts',
  'src/tool-gate.ts',
  'src/claude.ts',          // model call substrate
  'src/haiku-client.ts',    // model call substrate
  'package.json',
  'bun.lock',
  '.env',
  '.env.example',
];
```

Tested at proposal stage and again at merge stage.

### Morning review (cron `dgm-morning-review` at 08:00 PHX)

Reads `data/dgm-review/YYYY-MM-DD.jsonl`. For each entry, posts a Telegram message:

```
🧬 DGM #1 of 3 — data/roles-seed.yaml (role-prompt)

Δ aggregate: +0.04 (groundedness +0.06, tool +0.02, refusal -0.01)

Rationale: Munger-Inverter consistently scored low on tool-correctness
when the action involved an external send. Adding "If the action sends
to a non-internal address, explicitly invert: what if the recipient
misreads this and acts on it?" prompts variant.

Diff (3 lines):
- prompt_fragment: |
-     You are the Munger Inverter...
+ prompt_fragment: |
+     You are the Munger Inverter. If the action sends externally,
+     invert the recipient's reading...

[✓ Merge] [✗ Archive] [✏ Edit then merge]
```

Buttons emit `[DGM_DECIDE: <variant_id> | action=merge|archive|edit]` tags handled by `scripts/dgm-merge-handler.ts`.

### Merge mechanics

On approve:
1. Worktree's branch fast-forwarded to current `master` (rebase variant).
2. Single squashed commit with message: `dgm: <diff_summary>\n\nApproved-by: <derek|esther>\nReplay-delta: +<n>\nVariant-id: <uuid>\nLedger-entry: <sha>`.
3. Ledger entry written referencing variant id + commit SHA.
4. Worktree GC'd.
5. `dgm_variants.status='merged'`, `merge_commit_sha`, `approved_by`, `approved_at` populated.

On archive:
1. Worktree GC'd.
2. `status='archived'`. Stays in DB for later analysis.

On edit:
1. Telegram surfaces full diff. Derek edits → re-submits via `[DGM_DECIDE: <id> | action=merge | edited_diff=...]` OR opens worktree manually.
2. Edited variant re-runs through scoring before being eligible.

### Tests

- Unit: `pickTargets`, `proposeVariant` (with mocked Claude CLI), `scoreSmoke` math, `buildMergeList` filtering by delta threshold.
- Integration: full nightly run against a tiny `dgm-test-targets/` fixture set with a known-good variant + a known-bad variant. Known-good appears in merge list; known-bad gets archived.

---

## §2. Skill Shadow-Routing — Continuous Promotion/Demotion

### Schema

```sql
-- db/migrations/055_skill_shadow_scores.sql
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
```

### Module: `src/skill-shadow-router.ts`

```typescript
export async function executeWithShadow(
  taskId: string,
  task: TaskInput,
  baselineSkillId: string,
  candidateSkillId: string
): Promise<{ liveOutput: any; shadowOutput: any }>;

export async function judgeShadowOutput(
  task: TaskInput,
  liveOutput: any,
  shadowOutput: any
): Promise<{ verdict: 'shadow_wins' | 'baseline_wins' | 'tie'; reason: string }>;

export async function checkPromotion(skillId: string): Promise<{ promote: boolean; window: number }>;
export async function checkDemotion(skillId: string): Promise<{ demote: boolean; window: number }>;
export async function vetoShadowWin(scoreId: string, by: 'derek' | 'esther'): Promise<void>;
```

### Execution

When `routeTask` (Sprint 5 marketplace) routes a task that has a shadow-candidate:
1. Execute baseline (live) — capture output.
2. In parallel, execute candidate (shadow) — capture output but don't return.
3. Fire-and-forget `judgeShadowOutput` via Haiku (CLI). Insert `skill_shadow_scores` row.
4. Update rolling window for `candidateSkillId`.
5. Return baseline output to caller.

### Judge prompt

System (cached): *"You judge which output better serves the task. Output strict JSON `{verdict: 'shadow_wins' | 'baseline_wins' | 'tie', reason: <one sentence>}`."*

User: `{task_description, live_output, shadow_output}`.

### Promotion / demotion logic

After each new score:
- Pull last 10 scores for `skill_id` (excluding `derek_veto=true`).
- If ≥7 are `shadow_wins`: emit `[SKILL_PROMOTE: <skill_id>]` → handler swaps candidate into baseline routing, candidate reputation seeded with prior baseline's α/β.
- After promotion: rolling 30-day window. If ≥7 `baseline_wins` (which means the newly-promoted skill is losing): emit `[SKILL_DEMOTE: <skill_id>]` → reverts.

### Derek-thumbs override

`/skills shadow` lists last 20 scored comparisons with inline buttons. Thumbs-down on a `shadow_wins` row sets `derek_veto=true` AND emits `[SHADOW_VETO: <score_id>]`. Vetoed scores are excluded from promotion math; the gate effectively resets.

### Tests

- Unit: rolling-window math; veto exclusion; promotion threshold; demotion threshold.
- Integration: simulated stream of 10 wins → promote fires; 7 baseline-wins after promotion → demote fires.

---

## §3. Self-Regenerating Skills

### Trigger

Both paths feed the same regeneration workflow:

**Nightly (DGM-integrated):**
- DGM Fork's `pickTargets` includes "skill regen candidates" — skills where:
  - `agent_reputation.beta / (alpha+beta) > 0.6` over last 30 days, OR
  - Recent loss streak ≥3 in marketplace_bids, OR
  - Stale: no successful invocation in last 14 days

**On-demand:**
- `/skill regenerate <name>` Telegram command.

### Workflow

Module: `src/self-regen.ts`. The DGM Fork target-kind `'skill'` and `'role-prompt'` routes here.

```typescript
export async function regenerate(opts: {
  skill_id: string;
  current_text: string;
  invocation_trace_count?: number;     // default 30
}): Promise<{ v2_text: string; rationale: string }>;
```

1. Pull last 30 invocations of `skill_id` from `messages` + `marketplace_bids` + `marketplace_outcomes`.
2. For each invocation, extract: input task, output, success/failure tag, any Derek correction that followed.
3. Build Opus prompt (cached):
   - System: *"You refine a skill prompt based on its invocation history. Output JSON `{v2_text, rationale}`. v2_text is the full refined skill prompt. Rationale is ≤200 words explaining the change."*
   - User: `{current_text, invocations: [...]}` (truncated to fit context).
4. `callClaude(prompt, {model:'opus', isolated:true, agentId:'self-regen'})`.
5. v2 enters DGM scoring pipeline as a variant proposal targeting that skill's file.

### `/skill regenerate <name>` command

Synchronous on-demand path:
- Run regeneration immediately.
- Run scoring synchronously (smoke + full replay).
- Surface result + diff via Telegram with 3-button keyboard (same UX as DGM morning review).

### Tests

- Unit: invocation-trace fetcher returns the right shape; regenerate produces v2 via mocked CLI.
- Integration: known-failing skill regenerated, scored, lands in merge list.

---

## §4. Soft-DPO

### Pair collection (three sources)

**Source 1: `[LABEL_BAD:]` tags** (Sprint 2 label-tag.ts):
- Already writes to `data/replay-dataset.jsonl`.
- Sprint 6 also writes to `dpo_pairs` table with `source='label_bad'`.

**Source 2: Haiku-classified follow-up corrections:**
- Hook in relay.ts: every user turn that follows an assistant turn gets a Haiku classification call.
- System (cached): *"Did this user message correct the assistant's previous response? If yes, output `{is_correction: true, original: <quoted assistant text>, corrected: <derived correction>, domain: <topic>}`. If no, `{is_correction: false}`."*
- Only fires when conversation has recent assistant turn (skip greetings, new threads).
- Cost: ~1¢ per user turn, ~$2/month at typical volume.

**Source 3: Explicit `[DPO: <reason>]` tag:**
- Derek/Esther can mark a correction explicitly. Same shape as `[LABEL_BAD:]` but specifically tagged as a preference pair.

### Schema

```sql
-- db/migrations/056_dpo_pairs.sql
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
  embedding       VECTOR(1536),                       -- semantic search index for soft-DPO injection
  metadata        JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_dpo_pairs_domain ON dpo_pairs(domain);
CREATE INDEX IF NOT EXISTS idx_dpo_pairs_embedding ON dpo_pairs USING ivfflat (embedding vector_cosine_ops) WITH (lists = 30);
```

### Nightly digest (cron `dpo-digest-nightly` at 23:30 PHX)

Aggregates new pairs by `domain` into `data/behavioral-soft-dpo.md`. Structure:

```markdown
# Behavioral Soft-DPO Digest

Auto-generated. Each section lists recent (user-turn → correction) pairs in that domain.
Per-turn relay injection picks the top-K by semantic match to the active turn.

## newsletter

- **User asked:** "draft this week's newsletter"
  **Atlas said:** "Here's a 1200-word piece on..."
  **Derek wanted:** "Cut to 600 words. Cut the hook. Lead with the data."
  *(Captured 2026-05-12 via label_bad)*

- ...

## medical-protocol
...

## pricing
...
```

### Per-turn injection

In `src/relay.ts` prompt builder (before calling `callClaude`):
1. Classify active user turn into a domain via Haiku (cheap, cached).
2. Pull top-K (default 3) `dpo_pairs` by semantic match (`embedding` cosine) within that domain.
3. Inject into system prompt as a "Recent corrections" block:
   ```
   ## Recent corrections (soft-DPO)
   When responding, weight these patterns from prior corrections in this domain:
   - You said "..." but Derek wanted "...". Reason: ...
   - You said "..." but Esther wanted "...". Reason: ...
   ```

### Export script

`scripts/export-dpo-jsonl.ts` produces Anthropic/OpenAI fine-tuning JSONL:
```json
{"messages":[{"role":"user","content":"<user_turn>"},{"role":"assistant","content":"<derek_corrected>"}],"rejected":"<atlas_original>"}
```

### Tests

- Unit: pair-write triggered by each of 3 sources; embedding generated and stored; digest groups by domain.
- Integration: relay turn with newsletter intent → top-K injection happens; verify system-prompt contains injected pairs.

---

## §5. `/why` Introspection

### Schema (optional cache)

```sql
-- db/migrations/058_introspect_cache.sql
CREATE TABLE IF NOT EXISTS introspect_cache (
  turn_id          UUID PRIMARY KEY,
  reconstructed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  time_then        TEXT NOT NULL,
  time_now         TEXT NOT NULL,
  delta_reasoning  TEXT NOT NULL,
  cited_memory_ids UUID[] NOT NULL DEFAULT '{}',
  cited_ledger_shas TEXT[] NOT NULL DEFAULT '{}',
  cited_dag_edges  UUID[] NOT NULL DEFAULT '{}',
  cited_council_review_ids UUID[] NOT NULL DEFAULT '{}'
);
```

Cache TTL purged nightly via cron `introspect-cache-purge` at 04:30 PHX (anything older than `INTROSPECT_TTL_DAYS=30`).

### Module: `src/introspect.ts`

```typescript
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

export async function reconstruct(supabase, turn_id: string): Promise<IntrospectionResult | { error: string }>;
```

### Reconstruction steps

1. **Resolve turn_id** — accept turn_id directly, or parse Telegram message link (chat_id + message_id) → query `messages.metadata` for turn_id.
2. **Age check** — if `message_ts < now() - 30 days`, return *"that turn was archived. Use `/dag walk` or `/dreams search` for general history."*
3. **Pull contributing memories** via `attribution_log.turn_id`. For each, fetch both `original_content` (frozen) and current `summary`.
4. **Pull ledger entries** with this turn_id in metadata.
5. **Pull Shadow Council reviews** for any outbound action in this turn (`shadow_council_reviews.payload_hash` matched against turn output hashes).
6. **Pull role contracts** if this turn triggered a deliberation (`role_contracts.deliberation_id → deliberations.task_summary` matches).
7. **Pull DAG snapshot** — `causal_edges.approved_at <= message_ts AND status='observed'`.
8. **Pull scorecard row** from message day.
9. **Build Opus prompt** (cached):
   - System: *"You answer two questions about a past Atlas message: (1) why did Atlas say this given what it knew then? (2) given what Atlas knows today, would it say it again? Output three sections: 'At the time, Atlas knew...', 'Today, Atlas knows...', 'Would I say it again? [Yes / No / Updated]'. Cite memory IDs, ledger SHAs, and DAG edges."*
   - User: full reconstructed context (truncated to ~80k tokens).
10. **Cache result** in `introspect_cache` if successful.

### Command UX

```
/why <turn_id>
/why <telegram_message_link>
```

Output rendered to Telegram (≤4000 chars; split if needed):

```
**Why did I say that — turn abc12345**
Message: "MTD revenue is $42,100 per business_scorecard as of 03-01."
Captured: 2026-03-01 09:14 AM

**At the time, Atlas knew:**
- business_scorecard daily row 2026-03-01 had revenue_mtd=42100 (memory:a7…)
- ledger entry 0x9f3… captured the read
- DAG edge ad_spend→leads at +0.3 (edge:e6f…)

**Today, Atlas knows:**
- Same scorecard row unchanged.
- New edge approved 2026-04-20: telehealth_pause→leads at -15.2/wk.
- DPO correction on 2026-03-15: Derek prefers MTD with prior-month delta.

**Would I say it again? — Updated.**
Today I'd answer: "MTD revenue is $42,100 (+12% vs Feb same-day pace).
The telehealth pause on March 1 is the dominant cause-of-change."
```

### Tests

- Unit: turn_id resolver handles both formats; age check rejects >30d.
- Integration: seeded turn with 3 contributing memories + 1 ledger entry + 1 council review → reconstruct returns 3-section output with all citations.

---

## Cron registration (5 new jobs)

| Cron | Time | Module | Purpose |
|---|---|---|---|
| `dgm-fork-nightly` | 22:00 PHX | `src/dgm-fork.ts` | Propose + score variants |
| `dgm-morning-review` | 08:00 PHX | `src/dgm-fork.ts` | Surface merge list to Telegram |
| `dpo-digest-nightly` | 23:30 PHX | `src/soft-dpo.ts` | Regenerate `data/behavioral-soft-dpo.md` |
| `introspect-cache-purge` | 04:30 PHX | `src/introspect.ts` | Drop cache rows older than 30d |
| `shadow-judge-flush` | every 5 min | `src/skill-shadow-router.ts` | Process pending shadow-judge queue |

---

## File touch summary

**Created (modules — 5):** `src/dgm-fork.ts`, `src/skill-shadow-router.ts`, `src/self-regen.ts`, `src/soft-dpo.ts`, `src/introspect.ts`

**Created (scripts — 2):** `scripts/dgm-merge-handler.ts`, `scripts/export-dpo-jsonl.ts`

**Created (migrations — 5):** `054_dgm_variants.sql`, `055_skill_shadow_scores.sql`, `056_dpo_pairs.sql`, `057_dpo_pair_embeddings.sql`, `058_introspect_cache.sql`

**Created (tests — 5):** `tests/sprint6/dgm-fork.test.ts`, `tests/sprint6/skill-shadow-router.test.ts`, `tests/sprint6/self-regen.test.ts`, `tests/sprint6/soft-dpo.test.ts`, `tests/sprint6/introspect.test.ts`

**Modified:**
- `src/relay.ts` — 4 new commands (`/why`, `/skill`, `/dgm`, `/dpo`); soft-DPO prompt injection in builder; pair-capture follow-up hook; DGM/shadow decide-tag handlers
- `src/cron.ts` — 5 new crons
- `src/marketplace.ts` — wire `executeWithShadow` into routeTask
- `src/capability-registry.ts` — 5 new entries
- `.env.example` — DGM + shadow + soft-DPO + introspect env vars

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| DGM proposes a variant that introduces a subtle bug surviving build + tests + replay | (a) Derek's manual review of the diff is the final gate; (b) excluded-paths list keeps the trust substrate off-limits; (c) every merge writes a ledger entry tagged `dgm-approved-by`, so reverts are one git command. |
| DGM nightly budget overrun | Tiered scoring (build → test → smoke → full) means most variants never hit Haiku-judge. Cap of 5 variants × 2 reaching full evaluation × 50 conv × 3 axes = 300 Haiku calls/night ≈ $3. Hard ceiling in code: if estimated cost exceeds `DGM_NIGHTLY_BUDGET_USD`, drop lowest-priority targets. |
| Shadow-routing judge has poor calibration → wrong promotions | (a) Derek-thumbs veto blocks any individual win from counting; (b) post-promotion demotion gate catches regressions; (c) ledger trail every promotion. |
| Self-regen produces verbose / hedging prompts that don't actually improve performance | Same gate as DGM: scored on replay-harness, must beat current by ≥0.02. Verbose-but-no-gain variants get archived. |
| Soft-DPO injection makes responses inconsistent (prompts contradict each other across turns) | Top-K capped at 3. Pairs are scoped by domain — only domain-matching pairs inject. Stale pairs (>90 days, no recent reinforcement) demoted. |
| `/why` reconstruction returns inaccurate "at the time" memory if memory.original_content wasn't backfilled | Sprint 3 backfill script populates it. Check: if `original_content IS NULL`, `/why` returns *"original frozen content missing for this memory; reconstruction degraded."* |
| Bun segfault on `bun test` during DGM nightly | Build gate uses `bun build`, test gate uses `bun test` in a fresh shell per variant; if Bun crashes, that variant gets `tests_passed=null` and is archived for retry next night. Persistent crash logged for Derek. |
| Anthropic CLI rate-limit hit during DGM full replay | Existing rate-limit fallback chain in `callClaude` (opus → sonnet → haiku) handles transient 429s; if scoring fails for a variant, status stays `'smoked'` and resumes next night. |

---

## What Sprint 6 explicitly does NOT do

- **Real LoRA fine-tuning** — Anthropic doesn't publish a Claude fine-tuning API. Sprint 6 collects pairs to seed a future training pipeline (open-weights pivot, Anthropic API release, or third-party tooling). Inference path uses soft-DPO via system-prompt injection.
- **Auto-merge variants without Derek approval** — every DGM merge requires explicit ✓ button. Even ✏-edited variants get a final re-review.
- **DGM modification of trust substrate** — `atlas.spec`, ledger code/keys, migrations, `claude.ts`, `haiku-client.ts`, `tool-gate.ts`, `package.json` are immutable to DGM. Sprint 7 may revisit.
- **Cross-skill arbitration via shadow-routing** — a skill v2 only shadows against its own current baseline, not against other skills. Cross-skill bidding is Marketplace's job.
- **Public Merkle root of variants** — Sprint 7 (transparency beacon).

---

## Self-review

- **Spec coverage:** All 5 ATLAS-PRIME Sprint 6 primitives covered. 9 ship criteria each map to specific tests/commands.
- **Placeholder scan:** None. Every schema, function signature, and prompt is concrete. Excluded-files list, budget caps, and threshold env vars all named.
- **Internal consistency:** `agent_reputation` table (Sprint 5) referenced for both DGM target-picking and self-regen triggers. `replay-dataset.jsonl` referenced for both DGM smoke/full replay and DPO collection sources. `attribution_log` (Sprint 3) referenced for `/why` memory contribution lookup.
- **Scope check:** 5 modules, 5 migrations, ~14-16 implementation tasks. Smaller than Sprint 5 (8 migrations, 18-22 tasks) because the substrate is already in place — Sprint 6 mostly composes Sprints 1-5 outputs into improvement loops.
- **Ambiguity check:** Two implementation choices flagged for runtime resolution: (a) DGM worktree git operations — bare repo at `data/atlas-blackboard.git` (Sprint 5) could host DGM branches OR a separate `data/dgm.git`; recommend separate for isolation. (b) Soft-DPO embedding cost — `text-embedding-3-small` via OpenAI is $0.02/1M tokens; ~30 pairs/day × ~500 tokens = $0.0003/day; negligible. Decision: stay with OpenAI embeddings (matches Sprint 3 procedural memory).

---

## Cost projection

- DGM nightly: ~$3/night × 30 = **$90/month**
- Self-regen (DGM-integrated, accounted above): $0 marginal
- Shadow-routing Haiku-judge: ~30 shadow tasks/day × $0.0003/call = **$0.30/month**
- Soft-DPO Haiku classifier on follow-ups: ~50 turns/day × $0.0003 = **$0.45/month**
- Soft-DPO embeddings: **$0.01/month** (negligible)
- `/why` Opus calls: ~3/week × $0.15 = **$1.80/month**
- **Total new spend: ~$92/month.** Within Max-plan + reasonable spend bucket.

---

## Decision log

- **Sprint scope:** All 5 primitives in one sprint (Sprint 4/5 calibration).
- **DGM file scope:** (c) Full `src/` + rules with 6 guardrails. Excluded-paths list protects trust substrate.
- **Skill shadow-routing judge:** (c) Composite Haiku-judge + Derek-thumbs override. 7/10 promote, 7/10-of-30d demote.
- **Self-regen trigger:** (c) DGM-Fork-integrated + (d) manual `/skill regenerate <name>` command on top.
- **DPO path:** (c) Soft-DPO via system-prompt injection NOW + data collection pipeline ready for future fine-tuning.
- **`/why` reconstruction:** (c) Full time-then + time-now + delta-reasoning comparison; 30-day TTL.
- **Model calls:** All via Claude CLI subprocess (`callClaude` with `{model:'opus'|'sonnet'|'haiku', isolated:true}`); no `@anthropic-ai/sdk` imports in Sprint 6 modules. Existing `haiku-client.ts` already CLI-backed and continues to serve.
- **DGM worktree storage:** Separate `data/dgm.git` (bare) + `data/dgm-worktrees/<variant_uuid>/`. Isolated from Sprint 5's blackboard repo.
- **DGM nightly budget:** Tiered scoring caps Haiku spend at ~$3/night.
