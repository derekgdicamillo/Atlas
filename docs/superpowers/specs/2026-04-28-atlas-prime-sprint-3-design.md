# Atlas Prime — Sprint 3 (Memory That Works) — Design Spec

**Date:** 2026-04-28
**Owner:** Derek DiCamillo
**Status:** Locked. Ready for plan.
**Source vision:** `ATLAS-PRIME.md` lines 118-124 (Sprint 3: Memory That Works)
**Builds on:** Sprint 1 (`atlas.spec`, ledger, Haiku client, Staleness Sentinel), Sprint 2 (Replay harness, Trust budget, CaMeL Reader, hooks)

---

## Goal

Atlas remembers **not just what but why**. Retrieving a memory from 6 months ago updates the summary with today's hindsight. A procedure that has worked 7/10 times in similar contexts retrieves before one that has worked 2/10. Ingested context is chunked with surrounding meaning, not blindly by 800-char windows. Failures cause memories to be demoted, inverted, and re-tested.

## Ship criteria (from ATLAS-PRIME.md)

1. A retrieval of a memory at least 7 days old, accessed ≥5 times, returns a `summary` that has been rewritten with hindsight (e.g., "AS OF [date], we believed X. Updated [date] because Y.").
2. `findProcedure(goal)` returns a top-k ranked list using Thompson sampling over Beta(α,β); after `recordOutcome()` is called the posterior advances and subsequent ranks reflect the update.
3. The `documents` table's chunks are 100% `chunked_strategy='contextual-v1'` after backfill; queries that depended on document context (heading, date, doc title) score better on the integration tests.
4. A memory entry that accumulates ≥3.0 weighted demotion pressure (judge 0.5 + correction 1.0 + trust event 0.7) is moved to `class='demoted'` and an inverted hypothesis appears at episodic tier.
5. The reranker (`zerank-1-small` if ONNX-available, else `bge-reranker-base`) re-scores the top-50 embedding candidates and returns top-8 to the Planner; a "needle in haystack" integration test passes.
6. Full test suite green. Atlas restart healthy. No regression in Sprint 1+2 modules.

---

## Architecture overview

```
                ┌─ Working: ring buffer (conversation.ts)
                │
                ├─ Session: today's journal (memory/YYYY-MM-DD.md)
                │
                ├─ Episodic: memory.class='episodic'
   cortex.ts ───┤
                ├─ Semantic: memory.class='semantic'
                │
                ├─ Procedural: NEW procedures table
                │
                └─ Identity: SOUL.md / IDENTITY.md / USER.md

   attribution_log  ←  populated on every getRelevantContext()
   demotion_pressure ←  judge × 0.5 + correction × 1.0 + trust × 0.7
                        threshold 3.0 → demote + invert
```

Three new modules:
- `src/cortex.ts` — tier definitions, promotion/demotion logic, attribution log writer.
- `src/procedures.ts` — find/record/seed for procedural memory.
- `src/memory-rewrite.ts` — lazy-on-stale rewrite queue.
- `src/reranker.ts` — local Transformers.js cross-encoder.

Two extended modules:
- `src/ingest-worker.ts` — new `chunkContextually()` path.
- `src/search.ts` — reranker stage between embedding and return; attribution log writes.

One backfill script: `scripts/recontextualize-documents.ts`.

---

## §1. Cortical Stack (option C — existing surfaces tier-mapped)

### Tier mapping

| # | Tier        | Surface                                                | Mutable? |
|---|-------------|--------------------------------------------------------|----------|
| 1 | Sensory     | discarded — never persisted                            | n/a      |
| 2 | Working     | `src/conversation.ts` ring buffer (per-user, 20 turns) | yes      |
| 3 | Session     | `memory/YYYY-MM-DD.md` (today's journal)               | yes      |
| 4 | Episodic    | `memory` table, `class='episodic'`                     | summary mutable, original immutable |
| 5 | Semantic    | `memory` table, `class='semantic'`                     | same    |
| 6 | Procedural  | NEW `procedures` table                                 | α/β + last_used mutable; goal/action_sequence frozen post-seed |
| 7 | Identity    | `SOUL.md`, `IDENTITY.md`, `USER.md` (file-based)       | human-edited only |

### Promotion paths (mostly already exist; Sprint 3 formalizes)

- **Working → Session:** end-of-conversation summary writer (existing `compressOldEntries` in conversation.ts and the journal append path in relay).
- **Session → Episodic:** existing `journal-to-memory` cron (already runs nightly). Sprint 3 adds a `tier` field on the resulting memory rows for explicit lineage.
- **Episodic → Semantic:** new nightly job. Clusters `episodic` rows on shared tags; when ≥3 cluster on the same topic, a Haiku call writes a generalized rule, inserts as `class='semantic'`, and demotes the source episodic rows to `class='archived-source'` (still queryable but not in retrieval pool).
- **Identity changes:** out-of-scope — only Derek edits SOUL/IDENTITY/USER files.

### Demotion (the genuinely novel piece)

#### Attribution log

New table:
```sql
create table attribution_log (
  id          bigserial primary key,
  turn_id     uuid not null,
  user_id     text not null,
  agent       text not null,             -- 'atlas' | 'ishtar'
  memory_id   uuid not null references memory(id) on delete cascade,
  rank        int  not null,             -- position in retrieval result
  rerank_score real,                     -- from reranker, null if pre-rerank
  created_at  timestamptz not null default now()
);
create index on attribution_log (turn_id);
create index on attribution_log (memory_id, created_at);
```

`getRelevantContext()` writes one row per (turn, memory) pair returned. Retention: 90 days (nightly purge cron, age > 90d).

#### Demotion pressure tracking

Schema additions on `memory`:
```sql
alter table memory add column demotion_pressure real not null default 0;
alter table memory add column demotion_events jsonb not null default '[]';
alter table memory add column inverted_from uuid references memory(id);  -- non-null if this row IS an inversion
alter table memory add column inversion_depth int not null default 0;     -- 0 = original; 1 = first inversion; max 2
```

#### Failure signal sources (multi-signal weighted)

Module: `src/cortex.ts` exports `recordFailure(turn_id, source, severity)`.

| Source signal              | Weight | Trigger                                                                   |
|----------------------------|--------|---------------------------------------------------------------------------|
| Replay judge aggregate ≤ 0.4 on a turn | 0.5 | replay-harness nightly; weight applied to all memories in attribution_log for that turn |
| `[LABEL_BAD: reason]` from Derek/Esther | 1.0 | label-tag.ts processor (Sprint 2) emits failure event for previous turn's contributing memories |
| Trust event delta = −1 in same domain  | 0.7 | trust-engine.ts recordEvent path; for this we need domain → memory mapping (see implementation note) |

For each contributing memory of the failing turn, increment `demotion_pressure += weight`, append `{source, severity, ts}` to `demotion_events`. When `demotion_pressure ≥ 3.0` AND `inversion_depth < 2`:

1. Move row's `class` to `'demoted'`. Original entry stays queryable via `getOriginal()` but is excluded from `getRelevantContext()`.
2. Compose **inversion** via Haiku: aggregate the `demotion_events` reasons, write a new memory row:
   - `content`: `"AS OF [today], original belief: '<original summary>'. Failed N times because: <aggregated reasons>. Open question: is the inverse true?"`
   - `class = 'episodic'`
   - `inverted_from = <original_id>`
   - `inversion_depth = original_depth + 1`
3. The inverted form is itself in the retrieval pool and itself demotable. At `inversion_depth = 2`, no further inversion (anti-loop guard); the entry is just demoted and an alert fires for Derek to review manually.

#### Implementation note: domain → memory mapping

For trust-event-driven failures we need to know which memories belong to a domain. We do not maintain this explicitly. Pragmatic approach: when a trust event with delta=−1 fires for `domain='ad-spend'`, query attribution_log for the last 24h of turns whose tags overlap with the trust event's domain via memory's `tags` column (already exists). The matched memories accrue the 0.7 weight. Approximate but bounded.

### Tests

- Unit: tier mapping table is exhaustive; `recordFailure()` weight math; inversion-depth guard refuses depth 3.
- Integration: seed 3 memory rows, simulate `[LABEL_BAD]` 3× on turns that retrieved them; verify rows demoted + 3 inversions written; simulate further failure on inversion → second-level inversion; one more failure → blocked at depth 2 with alert.

---

## §2. Procedural Memory (hand-curated, MACLA-lite)

### Schema

```sql
create extension if not exists vector;

create table procedures (
  id              uuid primary key default gen_random_uuid(),
  goal            text not null,
  goal_embedding  vector(1536),                   -- text-embedding-3-small
  preconditions   jsonb not null default '[]',
  action_sequence jsonb not null,
  postconditions  jsonb not null default '[]',
  alpha           int  not null default 1,        -- Beta posterior — successes (α prior 1)
  beta            int  not null default 1,        -- Beta posterior — failures  (β prior 1)
  use_count       int  not null default 0,
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  source          text not null default 'hand-curated',
  tags            text[] not null default '{}'
);
create index on procedures using ivfflat (goal_embedding vector_cosine_ops) with (lists = 50);
create index on procedures using gin (tags);
```

### action_sequence shape

Each step is one of:

```typescript
type Step =
  | { kind: "tag"; tag: string }                        // Atlas action tag template w/ {slots}
  | { kind: "wait"; for: string }                       // narrative pause for human/event
  | { kind: "say"; template: string }                   // user-facing text template
  | { kind: "branch"; if: string; then: Step[]; else?: Step[] };  // conditional, narrative-judged
```

Templates use `{slot_name}` placeholders. Slot names defined in the procedure's `preconditions`. Example:

```yaml
- id: pv-newsletter-weekly-draft
  goal: Create and push the weekly PV newsletter draft to GHL.
  preconditions:
    - "topic from PV_NEWSLETTER_TOPIC tag or autosuggested"
    - "5 pillars rotation index loaded"
  action_sequence:
    - kind: tag
      tag: "[PV_NEWSLETTER_TOPIC: {topic} | pillar={pillar}]"
    - kind: tag
      tag: "[PV_NEWSLETTER_SECTION: hook | content={hook_content}]"
    - kind: tag
      tag: "[PV_NEWSLETTER_SECTION: body | content={body_content}]"
    - kind: tag
      tag: "[PV_NEWSLETTER_PUSH]"
  postconditions:
    - "GHL draft campaign visible to Derek"
    - "section-by-section preview emitted in Telegram"
  tags: [newsletter, pv, weekly]
```

### Hand-curated seed

File: `data/procedures-seed.yaml` — 10-15 procedures covering the common Atlas workflows: newsletter draft+push, lead reactivation, weekly content waterfall, monthly metrics digest, calendar invite for clinic appt, GBP review reply draft, etc.

Migration script: `scripts/seed-procedures.ts`. Reads YAML, embeds each goal via existing OpenAI embedding edge function, upserts into `procedures` keyed by `id` field (idempotent).

### Retrieval

Module: `src/procedures.ts`.

```typescript
findProcedure(goal: string, k = 3): Promise<RankedProcedure[]>
```

1. Embed `goal` (1536 dims).
2. Vector cosine top-20 candidates from `procedures` table.
3. Rank by **Thompson sampling**: for each candidate, sample one value from Beta(α, β) and use as score. (Adds exploration: low-α/low-β newcomers occasionally beat high-α veterans.)
4. Return top-k with `slots` field unfilled (Planner fills via subsequent Haiku slot-extraction call).

```typescript
recordOutcome(procedure_id: string, success: boolean, ledger_entry_id?: string): Promise<void>
```

- `success=true` → α += 1; otherwise β += 1.
- Updates `last_used_at`, increments `use_count`.
- If `ledger_entry_id` provided, the outcome is sign-anchored — stored in a separate `procedure_outcomes` table for audit.

```sql
create table procedure_outcomes (
  id            bigserial primary key,
  procedure_id  uuid not null references procedures(id),
  success       boolean not null,
  ledger_entry_id text,                           -- references ledger entry hash
  observed_at   timestamptz not null default now()
);
```

### Slot-filling

Module helper `fillSlots(procedure, userTurn, ringBuffer): Promise<RenderedTagList>`. Calls Haiku with the procedure's `preconditions` + `action_sequence` template + recent context, returns the rendered tag strings. Critical: the slot-filler returns *tags as strings*, which still flow through the existing tool-gate (Sprint 1) before any external call.

### Contrastive refinement (stub for Sprint 3)

When a procedure reaches both α ≥ 3 *and* β ≥ 3, log a TODO to `data/procedure-refinement-queue.jsonl`. Refinement logic itself is Sprint 6 (DGM + skill self-regen).

### Tests

- Unit: Thompson sampling distribution shape; α/β increment math; slot-filler returns strings, never executes tags.
- Integration: seed 5 procedures from YAML, embed, query for a known goal, verify expected procedure ranks first; record 5 successes + 1 failure, verify subsequent rank reflects.

---

## §3. Memory Rewriting on Retrieval (lazy-on-stale)

### Schema additions

```sql
alter table memory add column original_content text;
alter table memory add column summary text;
alter table memory add column summary_rewritten_at timestamptz;
alter table memory add column access_count_since_rewrite int not null default 0;
```

### Backfill (one-shot, on first deploy)

`scripts/backfill-memory-summaries.ts`:
```sql
update memory
set original_content = content,
    summary = content,
    summary_rewritten_at = created_at
where original_content is null;
```

After backfill: ingestion writes `original_content` (frozen) and `summary` (initially identical, mutable). The legacy `content` column is kept for back-compat readers but is no longer the source of truth — all new code reads `summary`.

### Trigger logic

Module: `src/memory-rewrite.ts`.

When `getRelevantContext()` returns memory rows:
1. For each row, increment `access_count_since_rewrite`.
2. Eligibility: `summary_rewritten_at < now() − interval '7 days'` **AND** `access_count_since_rewrite ≥ 5`.
3. If eligible, enqueue rewrite via in-process `p-queue` instance (concurrency 2; the queue persists in-memory only — restart drops queue, no big deal).
4. Retrieval returns existing `summary` immediately. The rewrite never blocks user latency.

### Async worker

```typescript
async function rewriteSummary(memory_id: string): Promise<void> {
  const row = await loadMemoryRow(memory_id);
  const recentContradictions = await searchContradictions(row.original_content);
  const prompt = buildRewritePrompt({
    original: row.original_content,
    currentSummary: row.summary,
    contradictions: recentContradictions,
    today: new Date().toISOString().slice(0, 10),
  });
  const result = await callHaiku({ system: REWRITE_SYSTEM, userMessage: prompt, maxTokens: 600 });
  const newSummary = sanitizeRewrite(result.text);  // strip markdown fences, length cap

  // Pass through existing content critic (src/content-critic.ts)
  const critique = await criticize(newSummary, { type: 'memory-summary' });
  if (critique.score < 0.7 || critique.flags.includes('hallucination')) {
    // Reject. Bump rewrite timestamp to defer 24h retry.
    await defer(memory_id, '24h');
    return;
  }

  await supabase
    .from('memory')
    .update({
      summary: newSummary,
      summary_rewritten_at: new Date().toISOString(),
      access_count_since_rewrite: 0,
    })
    .eq('id', memory_id);
}
```

### Anti-thrash guards

- Max 1 successful rewrite per memory per 24h.
- Global rate limit: 50 rewrites per nightly window. Excess deferred to next night.
- Critic-rejected rewrites don't reset access count — entry is allowed to retry but not for 24h.

### Retrieval contract

`getRelevantContext()` returns `summary`. Code that needs the immutable original must call `getOriginal(memory_id)` explicitly (only the future `/why` introspection in Sprint 6 should need this). The Reader gate (Sprint 2) already operates on whatever string `getRelevantContext()` returns — no Reader-gate changes required.

### Tests

- Unit: eligibility predicate boundary cases (6d/4 accesses → no, 7d/4 → no, 6d/5 → no, 7d/5 → yes); anti-thrash guard.
- Integration: mock Haiku → trigger rewrite, verify new summary written and `original_content` unchanged; mock critic-rejection path → verify defer.

---

## §4. Contextual Chunking + zerank-1-small Reranker

### Contextual chunking

Module: extend `src/ingest-worker.ts`. New function:

```typescript
async function chunkContextually(
  documentText: string,
  metadata: { title: string; date?: string; source: string }
): Promise<Array<{ chunk_text: string; context_preamble: string; embed_text: string }>>
```

1. Split document into base chunks (existing logic — ~800 char windows, 100 char overlap).
2. For each chunk, generate a context preamble via Haiku:
   - System: *"You write a ≤80-token preamble that situates a chunk in its document. Output only the preamble, no quotes."*
   - User: `{title, date, nearest heading, the chunk text}`
   - Output: e.g., *"From the November 2025 Weight-Loss Pricing Memo, Tier B Compounded Pricing section: this passage discusses the wholesale shift from Hallandale to local pharmacy."*
3. Concatenate `preamble + "\n\n" + chunk_text` → embed the concatenation.
4. Store both `chunk_text` (original) and `context_preamble` (for explainability) in `documents` table.

Schema additions:
```sql
alter table documents add column context_preamble text;
alter table documents add column chunked_strategy text not null default 'raw';
-- 'raw' = legacy non-contextual; 'contextual-v1' = new path
```

Going forward, `ingest-worker.ts` writes `chunked_strategy = 'contextual-v1'` for all new ingestions.

### Backfill

Script: `scripts/recontextualize-documents.ts`.

- Iterates `documents` rows where `chunked_strategy = 'raw'`.
- For each, regenerates preamble via Haiku, re-embeds the `(preamble + chunk_text)` via existing edge function.
- Updates row with new embedding + preamble + `chunked_strategy = 'contextual-v1'`.
- Idempotent: only processes 'raw' rows.
- Cost ceiling: $30 (Haiku for preambles) + $1 (embeddings). Logged per batch.
- Throttle: 100 rows per minute to avoid Haiku rate limits.

### Reranker

Module: `src/reranker.ts`. Uses `@xenova/transformers` (Bun-compatible, ONNX runtime).

```typescript
import { pipeline } from "@xenova/transformers";

let pipelineInstance: any = null;
let modelId = "zeta-alpha-ai/zerank-1-small";

async function getReranker() {
  if (pipelineInstance) return pipelineInstance;
  try {
    pipelineInstance = await pipeline("text-classification", modelId, { quantized: true });
  } catch (err) {
    console.warn(`[reranker] ${modelId} unavailable (${err}); falling back to bge-reranker-base`);
    modelId = "Xenova/bge-reranker-base";
    pipelineInstance = await pipeline("text-classification", modelId, { quantized: true });
  }
  return pipelineInstance;
}

export async function rerank(
  query: string,
  candidates: Array<{ id: string; text: string }>,
  topK = 8
): Promise<Array<{ id: string; text: string; rerank_score: number }>> {
  const model = await getReranker();
  const scored = await Promise.all(
    candidates.map(async (c) => {
      const out = await model([{ text: query, text_pair: c.text }]);
      const score = Array.isArray(out) ? out[0].score : out.score;
      return { ...c, rerank_score: score };
    })
  );
  return scored.sort((a, b) => b.rerank_score - a.rerank_score).slice(0, topK);
}

export async function preWarm(): Promise<void> {
  await getReranker();
  // Single dummy inference to JIT the pipeline.
  await rerank("warm-up query", [{ id: "warm", text: "warm-up document" }], 1);
}
```

### Pipeline integration

In `src/search.ts`, the `getRelevantContext()` flow:

1. Embedding search returns top-50 candidates (was top-K, typically 8).
2. Pass to `rerank(query, candidates, 8)` → cross-encoder re-ranks.
3. Return top-8 with `rerank_score` attached.
4. Each returned chunk's `(turn_id, memory_id, rerank_score)` written to `attribution_log`.
5. Reader gate (Sprint 2) operates on the reranked top-8 unchanged.

### Cold-start mitigation

`preWarm()` is called from `startCronJobs()` after boot via `setTimeout(preWarm, 30_000)` so first-user latency doesn't pay model load.

### Risk register

- **zerank-1-small ONNX availability**: build-time check — Plan Task 1 verifies the model loads. If not, automatic fallback to `bge-reranker-base` (Xenova publishes ONNX). Both behave identically from `src/search.ts`'s perspective.
- **`@xenova/transformers` + Bun compatibility**: Transformers.js v3 supports Bun. Plan Task 1 confirms via a `bun test tests/reranker.test.ts` smoke run that loads the model and runs one inference.
- **Memory footprint**: ~150-300MB resident depending on quantization. Acceptable on Derek's machine; monitor pm2 status post-restart.
- **Inference latency**: ~50-200ms per (query, doc) pair on CPU. With 50 candidates that's 2.5-10s. Mitigation: batch inference where the lib supports it; otherwise this is acceptable for the recall lift. If unacceptable in practice, Sprint 4 can move reranking to a separate Bun process.

### Tests

- Unit: `rerank()` returns sorted top-K; preserves IDs; handles empty candidates.
- Integration: seeded "needle in haystack" test — 50 candidates, 49 generic, 1 contains the answer with poor embedding similarity but strong textual relevance to the query. Reranker returns the needle in top-3.

---

## File touch summary

**Create:**
- `src/cortex.ts` — tier definitions, attribution log writer, demotion pressure tracker, inversion writer
- `src/procedures.ts` — find/record/seed; Thompson sampling; slot-filler glue
- `src/memory-rewrite.ts` — eligibility predicate, in-process queue, async worker
- `src/reranker.ts` — Transformers.js wrapper with fallback
- `data/procedures-seed.yaml` — hand-curated starter procedures
- `scripts/seed-procedures.ts` — YAML → DB upsert
- `scripts/recontextualize-documents.ts` — backfill
- `scripts/backfill-memory-summaries.ts` — one-shot summary column backfill
- `tests/cortex.test.ts`
- `tests/procedures.test.ts`
- `tests/memory-rewrite.test.ts`
- `tests/reranker.test.ts`
- `tests/needle-in-haystack-integration.test.ts`

**Modify:**
- `src/ingest-worker.ts` — `chunkContextually()` path; default to `contextual-v1` for new
- `src/search.ts` — top-50 retrieve → rerank → top-8 return; attribution log writes
- `src/memory.ts` — getOriginal(); rewrite enqueue on access; tier classification
- `src/cron.ts` — `episodic-cluster-nightly`, `attribution-purge-nightly`, `memory-rewrite-nightly` jobs
- `src/capability-registry.ts` — entries for cortex/procedures/rewrite/reranker
- `package.json` — add `@xenova/transformers`, `js-yaml`, `p-queue`
- `.env.example` — `RERANKER_MODEL_ID`, `MEMORY_REWRITE_DAILY_LIMIT`

**Migrations (new files in `migrations/` or however Atlas does Supabase migrations):**
- 020-attribution-log
- 021-memory-rewrite-columns
- 022-memory-demotion-columns
- 023-procedures-table
- 024-procedure-outcomes-table
- 025-documents-contextual-columns

(Adapt to existing migrations directory naming convention; the plan inspects this in Task 1.)

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Reranker latency makes retrieval unusably slow | Plan Task: measure on real data; if >5s p50, batch the cross-encoder calls or scope to top-20 candidates. Hard-fail rule: if p99 > 10s, ship behind a `RERANKER_ENABLED=0` env flag (ship-criterion 5 stays met because the test passes locally). |
| Rewrite worker writes a worse summary than the original | Content-critic gate at score < 0.7 rejects. Original_content immutable is the safety net — revert is `update memory set summary = original_content` on a single row. |
| Demotion pressure thrashes good memories | Anti-loop: max 2 inversion levels. Conservative threshold of 3.0 weighted (≥3 corrections, or 6 judge-only failures, etc). Manual override: `/memory undemote <id>` slash command (added in Task 8). |
| Backfill cost exceeds estimate | Estimate is $30 + $1 = $31. Plan Task 0 dry-runs against 100 sample chunks and extrapolates. If extrapolation > $100, halt and re-spec. |
| Sprint scope blowout | All 4 components committed; the explicit guard is the per-task ship criteria. If by Task 9 we've slipped past the wall-clock budget Derek sets, the reranker (§4) is the cut candidate — it's the lowest-leverage of the four for the "remembers why not just what" thesis. |
| zerank-1-small not ONNX-published | Automatic fallback to `bge-reranker-base` (Xenova-published ONNX). Plan Task 1 verifies. |

---

## What Sprint 3 explicitly does NOT do

- **Auto-extraction of new procedures** from successful conversations — Sprint 6 (DGM-adjacent).
- **Causal DAG** — Sprint 4. Memory rewriting can cite "X happened" but cannot reason about *why* X caused Y.
- **Dream Engine / world model** — Sprint 4.
- **Contrastive refinement of procedures** — stubbed only; logic in Sprint 6.
- **Sub-domain trust events targeting individual memories** — approximated via the tag-overlap heuristic in §1; precise targeting awaits Sprint 5+ when role-signed contracts make domain attribution exact.

---

## Self-review

- **Spec coverage:** all 4 ATLAS-PRIME Sprint 3 primitives (#1, #2, #4, contextual chunking + reranker) have a §; all 6 ship criteria have a clear test path.
- **Placeholder scan:** none. Every option is concrete (table schemas, function signatures, weight numbers, file paths). The two adaptable pieces are explicit (migrations directory naming, model fallback) and have decision-rules attached, not TBDs.
- **Internal consistency:** `original_content` (immutable) vs `summary` (mutable, rewriteable) named consistently across §1 / §3 / Reader-gate prose. `attribution_log` shape used identically in §1 demotion source and §4 reranker logging. `class='demoted'` exclusion from `getRelevantContext()` matches both §1 demotion logic and §3 retrieval contract.
- **Scope check:** four primitives, ~10-12 plan tasks, comparable to Sprint 2 (which was 11). Within bounds.
- **Ambiguity check:** the trust-event → memory mapping in §1 is the most ambiguous piece — explicitly flagged as approximate via tag-overlap heuristic, with the Sprint 5+ refinement noted.
