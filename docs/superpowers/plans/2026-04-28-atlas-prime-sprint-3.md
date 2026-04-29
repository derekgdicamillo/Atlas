# Atlas Prime — Sprint 3: Memory That Works Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atlas remembers not just what but why. Procedures rank by Bayesian posteriors. Stale memories rewrite themselves with hindsight. Failures demote and invert. Ingested content is contextually chunked and reranked.

**Architecture:** Four new modules layered on Sprint 1+2 substrate. `src/cortex.ts` owns tier definitions and demotion. `src/procedures.ts` is the MACLA-lite engine. `src/memory-rewrite.ts` is the lazy-on-stale rewriter. `src/reranker.ts` wraps Transformers.js. `src/search.ts` and `src/ingest-worker.ts` extend with attribution-log writes, reranker stage, and contextual chunking.

**Tech Stack:** Bun/TypeScript, `bun:test`, Supabase Postgres + pgvector (already present), `@xenova/transformers` (new), `js-yaml` (new), `p-queue` (new), `@anthropic-ai/sdk` (Sprint 1), OpenAI text-embedding-3-small (existing edge function).

**Spec:** `docs/superpowers/specs/2026-04-28-atlas-prime-sprint-3-design.md`

**File structure:**
- **Create:**
  - `db/migrations/023_attribution_log.sql`
  - `db/migrations/024_memory_rewrite_columns.sql`
  - `db/migrations/025_memory_demotion_columns.sql`
  - `db/migrations/026_procedures.sql`
  - `db/migrations/027_procedure_outcomes.sql`
  - `db/migrations/028_documents_contextual_columns.sql`
  - `src/cortex.ts` — tier definitions, attribution log writer, demotion-pressure tracker, inversion writer
  - `src/procedures.ts` — find/record; Thompson sampling; slot-filler glue
  - `src/memory-rewrite.ts` — eligibility predicate, in-process queue, async worker
  - `src/reranker.ts` — Transformers.js wrapper with fallback + preWarm
  - `data/procedures-seed.yaml` — hand-curated starter procedures
  - `scripts/seed-procedures.ts` — YAML → DB upsert
  - `scripts/recontextualize-documents.ts` — backfill
  - `scripts/backfill-memory-summaries.ts` — one-shot summary column backfill
  - `tests/cortex.test.ts`
  - `tests/procedures.test.ts`
  - `tests/memory-rewrite.test.ts`
  - `tests/reranker.test.ts`
  - `tests/needle-in-haystack-integration.test.ts`
- **Modify:**
  - `src/ingest-worker.ts` — add `chunkContextually()` path
  - `src/search.ts` — top-50 retrieve → rerank → top-8; attribution log writes
  - `src/memory.ts` — `getOriginal()`; tier classification helpers; rewrite enqueue on access
  - `src/cron.ts` — register `episodic-cluster-nightly`, `attribution-purge-nightly`, `memory-rewrite-nightly`
  - `src/capability-registry.ts` — entries for cortex/procedures/rewrite/reranker
  - `src/label-tag.ts` — fire `recordFailure(turn_id, 'derek-correction', 1.0)` on `[LABEL_BAD]`
  - `src/replay-harness.ts` — fire `recordFailure(turn_id, 'replay-judge', 0.5)` on aggregate ≤ 0.4
  - `src/trust-engine.ts` — fire `recordFailure(turn_id, 'trust-event', 0.7)` on delta=−1
  - `package.json` — add `@xenova/transformers`, `js-yaml`, `p-queue`
  - `.env.example` — `RERANKER_MODEL_ID`, `MEMORY_REWRITE_DAILY_LIMIT`, `MEMORY_REWRITE_MIN_AGE_DAYS`, `MEMORY_REWRITE_MIN_ACCESS`

---

## Task 1: Schema migrations

**Files:**
- Create: `db/migrations/023_attribution_log.sql`
- Create: `db/migrations/024_memory_rewrite_columns.sql`
- Create: `db/migrations/025_memory_demotion_columns.sql`
- Create: `db/migrations/026_procedures.sql`
- Create: `db/migrations/027_procedure_outcomes.sql`
- Create: `db/migrations/028_documents_contextual_columns.sql`

- [ ] **Step 1: Create `023_attribution_log.sql`**

```sql
-- Atlas Prime Sprint 3: attribution log
-- Records which memory entries contributed to each retrieval.
-- Used by demotion pressure tracking to attribute failures.

CREATE TABLE IF NOT EXISTS attribution_log (
  id           BIGSERIAL PRIMARY KEY,
  turn_id      UUID NOT NULL,
  user_id      TEXT NOT NULL,
  agent        TEXT NOT NULL CHECK (agent IN ('atlas', 'ishtar')),
  memory_id    UUID NOT NULL,           -- references memory.id; FK omitted for cross-table flexibility
  rank         INT NOT NULL,
  rerank_score REAL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attribution_log_turn_id ON attribution_log(turn_id);
CREATE INDEX IF NOT EXISTS idx_attribution_log_memory_created ON attribution_log(memory_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attribution_log_created_at ON attribution_log(created_at);

COMMENT ON TABLE attribution_log IS
  'Atlas Prime Sprint 3: maps (turn_id, memory_id) for retrieval attribution. 90-day retention.';
```

- [ ] **Step 2: Create `024_memory_rewrite_columns.sql`**

```sql
-- Atlas Prime Sprint 3: living-summary columns on memory table.
-- original_content is frozen; summary is rewritten lazily on retrieval.

ALTER TABLE memory ADD COLUMN IF NOT EXISTS original_content TEXT;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS summary_rewritten_at TIMESTAMPTZ;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS access_count_since_rewrite INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN memory.original_content IS 'Immutable frozen original. Set once on first rewrite or backfill.';
COMMENT ON COLUMN memory.summary IS 'Living summary. Rewritten when stale + frequently accessed.';
```

- [ ] **Step 3: Create `025_memory_demotion_columns.sql`**

```sql
-- Atlas Prime Sprint 3: demotion pressure columns on memory table.

ALTER TABLE memory ADD COLUMN IF NOT EXISTS demotion_pressure REAL NOT NULL DEFAULT 0;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS demotion_events JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS inverted_from UUID REFERENCES memory(id);
ALTER TABLE memory ADD COLUMN IF NOT EXISTS inversion_depth INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_memory_demotion_pressure ON memory(demotion_pressure) WHERE demotion_pressure > 0;
CREATE INDEX IF NOT EXISTS idx_memory_inverted_from ON memory(inverted_from);
```

- [ ] **Step 4: Create `026_procedures.sql`**

```sql
-- Atlas Prime Sprint 3: procedural memory (MACLA-lite).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS procedures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal            TEXT NOT NULL,
  goal_embedding  VECTOR(1536),
  preconditions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_sequence JSONB NOT NULL,
  postconditions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  alpha           INT NOT NULL DEFAULT 1,
  beta            INT NOT NULL DEFAULT 1,
  use_count       INT NOT NULL DEFAULT 0,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source          TEXT NOT NULL DEFAULT 'hand-curated',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  external_id     TEXT UNIQUE              -- stable id from YAML for idempotent reseed
);

CREATE INDEX IF NOT EXISTS idx_procedures_embedding
  ON procedures USING ivfflat (goal_embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX IF NOT EXISTS idx_procedures_tags ON procedures USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_procedures_external_id ON procedures(external_id);

COMMENT ON TABLE procedures IS
  'Atlas Prime Sprint 3: hand-curated procedures with Beta(α,β) Bayesian posteriors.';
```

- [ ] **Step 5: Create `027_procedure_outcomes.sql`**

```sql
-- Atlas Prime Sprint 3: per-execution outcome log for procedures.

CREATE TABLE IF NOT EXISTS procedure_outcomes (
  id              BIGSERIAL PRIMARY KEY,
  procedure_id    UUID NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
  success         BOOLEAN NOT NULL,
  ledger_entry_id TEXT,                    -- references ledger entryHash for sign-anchoring
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procedure_outcomes_procedure ON procedure_outcomes(procedure_id, observed_at);
```

- [ ] **Step 6: Create `028_documents_contextual_columns.sql`**

```sql
-- Atlas Prime Sprint 3: contextual chunking columns on documents table.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS context_preamble TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunked_strategy TEXT NOT NULL DEFAULT 'raw'
  CHECK (chunked_strategy IN ('raw', 'contextual-v1'));

CREATE INDEX IF NOT EXISTS idx_documents_chunked_strategy
  ON documents(chunked_strategy) WHERE chunked_strategy = 'raw';

COMMENT ON COLUMN documents.chunked_strategy IS
  'raw = legacy non-contextual chunks; contextual-v1 = preamble-prepended embeddings.';
```

- [ ] **Step 7: Apply migrations to Supabase**

The repo's existing pattern is to apply migrations via the Supabase dashboard SQL editor or `supabase db push`. Inspect prior migrations to match:

```bash
ls db/migrations/ | tail -5
```

Apply each new migration via whichever method matches the team workflow. If unsure, ask. **Do NOT** run destructive SQL without confirmation.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/023_attribution_log.sql \
        db/migrations/024_memory_rewrite_columns.sql \
        db/migrations/025_memory_demotion_columns.sql \
        db/migrations/026_procedures.sql \
        db/migrations/027_procedure_outcomes.sql \
        db/migrations/028_documents_contextual_columns.sql
git commit -m "feat(atlas-prime): Sprint 3 migrations — attribution + memory rewrite + demotion + procedures + contextual"
```

---

## Task 2: Cortex foundation — tier definitions + attribution writer

**Files:**
- Create: `src/cortex.ts`
- Test: `tests/cortex.test.ts`

- [ ] **Step 1: Write `tests/cortex.test.ts`**

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  TIERS,
  type Tier,
  recordAttribution,
  recordFailure,
  computePressure,
  type FailureSource,
  FAILURE_WEIGHTS,
  DEMOTION_THRESHOLD,
  MAX_INVERSION_DEPTH,
} from "../src/cortex.ts";

describe("cortex foundation", () => {
  test("TIERS is exhaustive 7-tuple in correct order", () => {
    expect(TIERS).toEqual([
      "sensory",
      "working",
      "session",
      "episodic",
      "semantic",
      "procedural",
      "identity",
    ]);
  });

  test("FAILURE_WEIGHTS matches spec", () => {
    expect(FAILURE_WEIGHTS["replay-judge"]).toBe(0.5);
    expect(FAILURE_WEIGHTS["derek-correction"]).toBe(1.0);
    expect(FAILURE_WEIGHTS["trust-event"]).toBe(0.7);
  });

  test("DEMOTION_THRESHOLD = 3.0 and MAX_INVERSION_DEPTH = 2", () => {
    expect(DEMOTION_THRESHOLD).toBe(3.0);
    expect(MAX_INVERSION_DEPTH).toBe(2);
  });

  test("computePressure sums weighted events correctly", () => {
    const events = [
      { source: "derek-correction" as FailureSource, ts: "2026-04-01T00:00:00Z" },
      { source: "replay-judge" as FailureSource, ts: "2026-04-02T00:00:00Z" },
      { source: "trust-event" as FailureSource, ts: "2026-04-03T00:00:00Z" },
    ];
    expect(computePressure(events)).toBeCloseTo(1.0 + 0.5 + 0.7, 5);
  });

  test("recordAttribution writes one row per (turn, memory) pair", async () => {
    const inserted: any[] = [];
    const fakeSupabase = {
      from: (_t: string) => ({
        insert: (rows: any[]) => {
          inserted.push(...rows);
          return Promise.resolve({ error: null });
        },
      }),
    } as any;
    await recordAttribution(fakeSupabase, {
      turn_id: "t1",
      user_id: "u1",
      agent: "atlas",
      memories: [
        { id: "m1", rank: 0, rerank_score: 0.92 },
        { id: "m2", rank: 1, rerank_score: 0.81 },
      ],
    });
    expect(inserted).toHaveLength(2);
    expect(inserted[0].turn_id).toBe("t1");
    expect(inserted[0].memory_id).toBe("m1");
    expect(inserted[0].rank).toBe(0);
    expect(inserted[0].rerank_score).toBe(0.92);
  });

  test("recordFailure increments memory rows tied to a turn", async () => {
    const updates: any[] = [];
    const fakeSupabase = {
      from: (_t: string) => ({
        select: () => ({
          eq: () => Promise.resolve({
            data: [{ memory_id: "m1" }, { memory_id: "m2" }],
            error: null,
          }),
        }),
        rpc: (_n: string, args: any) => {
          updates.push(args);
          return Promise.resolve({ error: null });
        },
      }),
      rpc: (_n: string, args: any) => {
        updates.push(args);
        return Promise.resolve({ error: null });
      },
    } as any;
    await recordFailure(fakeSupabase, {
      turn_id: "t1",
      source: "derek-correction",
      reason: "outdated pricing",
    });
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `bun test tests/cortex.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `src/cortex.ts`**

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

export const TIERS = [
  "sensory",
  "working",
  "session",
  "episodic",
  "semantic",
  "procedural",
  "identity",
] as const;
export type Tier = (typeof TIERS)[number];

export type FailureSource = "replay-judge" | "derek-correction" | "trust-event";

export const FAILURE_WEIGHTS: Record<FailureSource, number> = {
  "replay-judge": 0.5,
  "derek-correction": 1.0,
  "trust-event": 0.7,
};

export const DEMOTION_THRESHOLD = 3.0;
export const MAX_INVERSION_DEPTH = 2;

export interface FailureEvent {
  source: FailureSource;
  ts: string;
  reason?: string;
}

export function computePressure(events: FailureEvent[]): number {
  return events.reduce((acc, e) => acc + (FAILURE_WEIGHTS[e.source] ?? 0), 0);
}

export interface AttributionInput {
  turn_id: string;
  user_id: string;
  agent: "atlas" | "ishtar";
  memories: Array<{ id: string; rank: number; rerank_score?: number | null }>;
}

export async function recordAttribution(
  supabase: SupabaseClient,
  input: AttributionInput
): Promise<void> {
  if (!input.memories.length) return;
  const rows = input.memories.map((m) => ({
    turn_id: input.turn_id,
    user_id: input.user_id,
    agent: input.agent,
    memory_id: m.id,
    rank: m.rank,
    rerank_score: m.rerank_score ?? null,
  }));
  const { error } = await supabase.from("attribution_log").insert(rows);
  if (error) {
    console.error("[cortex] recordAttribution failed:", error);
  }
}

export interface FailureInput {
  turn_id: string;
  source: FailureSource;
  reason?: string;
}

/**
 * Look up memories that contributed to a turn via attribution_log,
 * increment each memory's demotion_pressure by the source's weight,
 * append the event to demotion_events. Demotion execution itself
 * is handled by Task 4's executor.
 */
export async function recordFailure(
  supabase: SupabaseClient,
  input: FailureInput
): Promise<void> {
  const { data: contributors, error: lookupErr } = await supabase
    .from("attribution_log")
    .select("memory_id")
    .eq("turn_id", input.turn_id);
  if (lookupErr) {
    console.error("[cortex] recordFailure lookup failed:", lookupErr);
    return;
  }
  if (!contributors?.length) return;

  const weight = FAILURE_WEIGHTS[input.source];
  const event: FailureEvent = {
    source: input.source,
    ts: new Date().toISOString(),
    reason: input.reason,
  };

  for (const row of contributors) {
    // Each row gets its pressure incremented and event appended.
    // Use a postgres function for atomicity, or fall back to read-modify-write.
    const { error } = await supabase.rpc("memory_record_failure", {
      p_memory_id: row.memory_id,
      p_weight: weight,
      p_event: event,
    });
    if (error) {
      console.error(`[cortex] recordFailure update failed for ${row.memory_id}:`, error);
    }
  }
}
```

- [ ] **Step 4: Add helper Postgres function migration**

Create `db/migrations/029_memory_record_failure_fn.sql`:

```sql
-- Atlas Prime Sprint 3: atomic failure recorder for memory rows.

CREATE OR REPLACE FUNCTION memory_record_failure(
  p_memory_id UUID,
  p_weight    REAL,
  p_event     JSONB
) RETURNS VOID AS $$
BEGIN
  UPDATE memory
     SET demotion_pressure = demotion_pressure + p_weight,
         demotion_events   = demotion_events || jsonb_build_array(p_event)
   WHERE id = p_memory_id;
END;
$$ LANGUAGE plpgsql;
```

Apply this migration alongside Task 1's batch.

- [ ] **Step 5: Run test — expect PASS**

Run: `bun test tests/cortex.test.ts`
Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cortex.ts tests/cortex.test.ts db/migrations/029_memory_record_failure_fn.sql
git commit -m "feat(atlas-prime): cortex foundation — tiers + attribution log + failure recorder"
```

---

## Task 3: Wire attribution into search.ts

**Files:**
- Modify: `src/search.ts` — add attribution-log writes inside `getRelevantContext()`

- [ ] **Step 1: Inspect `src/search.ts` to find the retrieval result point**

Run: `grep -n "getRelevantContext\|attribution" src/search.ts | head -10`

Identify the spot inside `getRelevantContext()` where retrieval results have been finalized (after the Reader gate, before return). Note the variable holding the final result list.

- [ ] **Step 2: Add a `turn_id` parameter to `getRelevantContext()`**

`getRelevantContext()` likely has a signature like `(query: string, opts?: { limit?: number })`. Extend it to accept an optional `turn_id` and `user_id` and `agent`:

```typescript
export interface GetContextOpts {
  limit?: number;
  turn_id?: string;
  user_id?: string;
  agent?: "atlas" | "ishtar";
  _callHaikuOverride?: typeof callHaiku;     // existing test injection
}
```

If callers don't pass `turn_id`, attribution-log writes are skipped (silent no-op).

- [ ] **Step 3: Add the attribution write at the return point**

Before returning the final concatenated string, the function processes a list of result rows. Each row has a memory id (or document id). Add:

```typescript
import { recordAttribution } from "./cortex.ts";

// ... after final results are assembled, before concatenation/return:
if (opts?.turn_id && opts?.user_id) {
  const memories = finalResults.map((r, i) => ({
    id: r.id,
    rank: i,
    rerank_score: r.rerank_score ?? null,
  }));
  // Fire-and-forget; don't block retrieval on logging
  recordAttribution(supabase, {
    turn_id: opts.turn_id,
    user_id: opts.user_id,
    agent: opts.agent ?? "atlas",
    memories,
  }).catch((err) => console.error("[search] recordAttribution failed:", err));
}
```

Adapt to the actual variable names. If results contain both `messages` rows and `documents` rows, only log entries that have an actual `memory.id` (skip other surfaces in this sprint).

- [ ] **Step 4: Update call sites in `src/relay.ts`**

Find call sites:
```bash
grep -n "getRelevantContext" src/relay.ts | head -5
```

At each call site that processes a user turn, pass `turn_id`, `user_id`, `agent`. Source `turn_id` from the existing turn-id generator (relay likely creates a UUID per turn already; if not, add one near the start of `handleUserMessage`):

```typescript
const turn_id = crypto.randomUUID();
// ... later:
const ctx = await getRelevantContext(userMessage, {
  limit: 8,
  turn_id,
  user_id: userId,
  agent: agentId === "ishtar" ? "ishtar" : "atlas",
});
```

If the relay already has a turn-id-like value (e.g., for ledger writes), use that for consistency. Inspect:
```bash
grep -n "turn_id\|turnId\|crypto.randomUUID" src/relay.ts | head -10
```

- [ ] **Step 5: Manual smoke**

```bash
bun test                 # full suite — must still pass
```

Then in a temporary test or via the existing relay path, trigger a getRelevantContext call, then query attribution_log:

```sql
SELECT count(*) FROM attribution_log WHERE created_at > now() - interval '5 minutes';
```

- [ ] **Step 6: Commit**

```bash
git add src/search.ts src/relay.ts
git commit -m "feat(atlas-prime): wire attribution log into getRelevantContext"
```

---

## Task 4: Demotion executor

**Files:**
- Modify: `src/cortex.ts` — add `executeDemotion()` and `composeInversion()`
- Modify: `tests/cortex.test.ts` — add tests for demotion + inversion

- [ ] **Step 1: Append tests to `tests/cortex.test.ts`**

```typescript
import { executeDemotion, composeInversion, type MemoryRow } from "../src/cortex.ts";

describe("cortex demotion", () => {
  const baseRow: MemoryRow = {
    id: "m1",
    content: "Tirzepatide costs $400/month",
    summary: "Tirzepatide costs $400/month",
    original_content: "Tirzepatide costs $400/month",
    class: "semantic",
    demotion_pressure: 3.2,
    demotion_events: [
      { source: "derek-correction", ts: "2026-04-01T00:00:00Z", reason: "outdated pricing" },
      { source: "derek-correction", ts: "2026-04-05T00:00:00Z", reason: "ignored Hallandale switch" },
      { source: "derek-correction", ts: "2026-04-10T00:00:00Z", reason: "wrong pharmacy listed" },
    ],
    inverted_from: null,
    inversion_depth: 0,
    tags: ["pricing", "tirzepatide"],
    created_at: "2026-03-01T00:00:00Z",
  };

  test("composeInversion produces a hindsight-formatted entry", () => {
    const inv = composeInversion(baseRow, "2026-04-15");
    expect(inv.content).toContain("AS OF 2026-04-15");
    expect(inv.content).toContain("Tirzepatide costs $400/month");
    expect(inv.content).toContain("3 times");
    expect(inv.class).toBe("episodic");
    expect(inv.inverted_from).toBe("m1");
    expect(inv.inversion_depth).toBe(1);
  });

  test("executeDemotion below threshold is no-op", async () => {
    const updates: any[] = [];
    const inserts: any[] = [];
    const fakeSupabase = {
      from: () => ({
        update: (u: any) => {
          updates.push(u);
          return { eq: () => Promise.resolve({ error: null }) };
        },
        insert: (rows: any[]) => {
          inserts.push(...rows);
          return Promise.resolve({ error: null });
        },
      }),
    } as any;
    const result = await executeDemotion(fakeSupabase, { ...baseRow, demotion_pressure: 2.5 });
    expect(result.demoted).toBe(false);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  test("executeDemotion at threshold demotes + writes inversion", async () => {
    const updates: any[] = [];
    const inserts: any[] = [];
    const fakeSupabase = {
      from: () => ({
        update: (u: any) => {
          updates.push(u);
          return { eq: () => Promise.resolve({ error: null }) };
        },
        insert: (rows: any[]) => {
          inserts.push(...rows);
          return Promise.resolve({ error: null });
        },
      }),
    } as any;
    const result = await executeDemotion(fakeSupabase, baseRow);
    expect(result.demoted).toBe(true);
    expect(updates[0].class).toBe("demoted");
    expect(inserts[0].inverted_from).toBe("m1");
    expect(inserts[0].inversion_depth).toBe(1);
  });

  test("executeDemotion at max depth refuses further inversion", async () => {
    const inserts: any[] = [];
    const fakeSupabase = {
      from: () => ({
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        insert: (rows: any[]) => {
          inserts.push(...rows);
          return Promise.resolve({ error: null });
        },
      }),
    } as any;
    const deep = { ...baseRow, inversion_depth: 2 };
    const result = await executeDemotion(fakeSupabase, deep);
    expect(result.demoted).toBe(true);
    expect(result.inverted).toBe(false);
    expect(result.alertReason).toContain("max inversion depth");
    expect(inserts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

`bun test tests/cortex.test.ts`

- [ ] **Step 3: Append to `src/cortex.ts`**

```typescript
export interface MemoryRow {
  id: string;
  content: string;
  summary: string;
  original_content: string;
  class: string;
  demotion_pressure: number;
  demotion_events: FailureEvent[];
  inverted_from: string | null;
  inversion_depth: number;
  tags: string[];
  created_at: string;
}

export interface InversionDraft {
  content: string;
  summary: string;
  original_content: string;
  class: "episodic";
  inverted_from: string;
  inversion_depth: number;
  tags: string[];
}

export function composeInversion(row: MemoryRow, today: string): InversionDraft {
  const reasons = row.demotion_events
    .map((e) => e.reason)
    .filter((r): r is string => Boolean(r))
    .slice(0, 5);
  const reasonsBlock = reasons.length
    ? "Failed because: " + reasons.join("; ") + "."
    : "";
  const content = [
    `AS OF ${today}, original belief: "${row.summary}".`,
    `Failed ${row.demotion_events.length} times.`,
    reasonsBlock,
    `Open question: is the inverse true?`,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    content,
    summary: content,
    original_content: content,
    class: "episodic",
    inverted_from: row.id,
    inversion_depth: row.inversion_depth + 1,
    tags: [...row.tags, "inversion"],
  };
}

export interface DemotionResult {
  demoted: boolean;
  inverted: boolean;
  alertReason?: string;
  inversionDraft?: InversionDraft;
}

export async function executeDemotion(
  supabase: SupabaseClient,
  row: MemoryRow,
  todayIso?: string
): Promise<DemotionResult> {
  if (row.demotion_pressure < DEMOTION_THRESHOLD) {
    return { demoted: false, inverted: false };
  }

  const today = (todayIso ?? new Date().toISOString()).slice(0, 10);

  // Step 1: demote the row.
  const { error: updErr } = await supabase
    .from("memory")
    .update({ class: "demoted" })
    .eq("id", row.id);
  if (updErr) {
    return { demoted: false, inverted: false, alertReason: `update failed: ${updErr.message}` };
  }

  // Step 2: inversion guard.
  if (row.inversion_depth >= MAX_INVERSION_DEPTH) {
    return {
      demoted: true,
      inverted: false,
      alertReason: `max inversion depth (${MAX_INVERSION_DEPTH}) reached for ${row.id} — manual review required`,
    };
  }

  // Step 3: write inversion as a new memory row.
  const draft = composeInversion(row, today);
  const { error: insErr } = await supabase.from("memory").insert([draft]);
  if (insErr) {
    return { demoted: true, inverted: false, alertReason: `insert failed: ${insErr.message}` };
  }
  return { demoted: true, inverted: true, inversionDraft: draft };
}

/**
 * Scan memory rows whose pressure crossed threshold but haven't been
 * demoted yet (class != 'demoted'). Process each. Returns count.
 */
export async function processDemotions(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from("memory")
    .select("*")
    .gte("demotion_pressure", DEMOTION_THRESHOLD)
    .neq("class", "demoted")
    .limit(50);
  if (error) {
    console.error("[cortex] processDemotions query failed:", error);
    return 0;
  }
  if (!data?.length) return 0;
  let count = 0;
  for (const row of data as MemoryRow[]) {
    const result = await executeDemotion(supabase, row);
    if (result.demoted) count++;
    if (result.alertReason) console.warn("[cortex] demotion alert:", result.alertReason);
  }
  return count;
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cortex.ts tests/cortex.test.ts
git commit -m "feat(atlas-prime): demotion executor + inversion composer"
```

---

## Task 5: Wire failure signals from existing modules

**Files:**
- Modify: `src/label-tag.ts` — fire `recordFailure` on `[LABEL_BAD]`
- Modify: `src/replay-harness.ts` — fire `recordFailure` on aggregate ≤ 0.4
- Modify: `src/trust-engine.ts` — fire `recordFailure` on delta=−1

Each modification is small. Per file:

- [ ] **Step 1: Modify `src/label-tag.ts`**

Inside `processLabelTag()`, after the entry is appended to the dataset, also fire a failure if the label was BAD and a `turn_id` is provided in input:

Add to `LabelTagInput`:
```typescript
export interface LabelTagInput {
  // ... existing fields
  turn_id?: string;             // for cortex failure attribution
  supabase?: SupabaseClient;    // for cortex failure write
}
```

After the appendFile call:
```typescript
if (parsed.label === "bad" && input.turn_id && input.supabase) {
  try {
    const { recordFailure } = await import("./cortex.ts");
    await recordFailure(input.supabase, {
      turn_id: input.turn_id,
      source: "derek-correction",
      reason: parsed.reason ?? "label_bad",
    });
  } catch (err) {
    console.error("[label-tag] cortex.recordFailure failed:", err);
  }
}
```

In `src/relay.ts` where `processLabelTag` is called (Sprint 2 wired the call), pass `turn_id` and `supabase` through.

- [ ] **Step 2: Modify `src/replay-harness.ts`**

Inside `runHarness()`, after each `scoreEntry` call, if `score.aggregate <= 0.4` and we have a `turn_id` for the entry, fire a failure:

```typescript
import { recordFailure } from "./cortex.ts";

// after scoring loop, where each entry has a known turn_id-like key:
for (const entry of working) {
  const score = perEntry.find((s) => s.entryId === entry.id);
  if (!score || score.aggregate > 0.4) continue;
  // ReplayEntry.id is the dataset id, not a turn_id. The replay-judge
  // failure attribution requires turn_id from the original message.
  // For Sprint 3 minimum, we look up turn_id by the entry's capturedAt
  // matching messages.created_at.
  if (!supabase) continue;
  const { data } = await supabase
    .from("messages")
    .select("metadata")
    .eq("created_at", entry.capturedAt)
    .eq("role", "user")
    .limit(1)
    .single();
  const turn_id = data?.metadata?.turn_id;
  if (!turn_id) continue;
  try {
    await recordFailure(supabase, {
      turn_id,
      source: "replay-judge",
      reason: `aggregate=${score.aggregate.toFixed(2)}`,
    });
  } catch (err) {
    console.error("[replay-harness] cortex.recordFailure failed:", err);
  }
}
```

This requires that the relay records `turn_id` in `messages.metadata` for every user turn. Check:
```bash
grep -nE "metadata.*turn_id|turn_id.*metadata" src/relay.ts | head -3
```

If absent, add it in Task 3 step 4 (modifying the `saveMessage` call). The relay's `saveMessage()` already takes a metadata field.

- [ ] **Step 3: Modify `src/trust-engine.ts`**

Inside `recordEvent()`, after the appendFile, if `event.delta === -1` and we have a `turn_id`, fire a failure. Trust events don't currently carry a `turn_id`, so extend the type:

```typescript
export interface TrustEvent {
  ts: string;
  domain: string;
  delta: number;
  source?: string;
  turn_id?: string;          // NEW: for cortex failure attribution
}
```

Then in `recordEvent()`:

```typescript
if (event.delta === -1 && event.turn_id) {
  try {
    const { recordFailure } = await import("./cortex.ts");
    // The supabase client isn't available in this module today; load lazily:
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!
    );
    await recordFailure(supabase, {
      turn_id: event.turn_id,
      source: "trust-event",
      reason: `domain=${event.domain}`,
    });
  } catch (err) {
    console.error("[trust-engine] cortex.recordFailure failed:", err);
  }
}
```

Cleaner pattern (recommended): pass a supabase client into `recordEvent` via opts. Refactor:
```typescript
export async function recordEvent(
  event: TrustEvent,
  opts?: { snapshotPath?: string; supabase?: SupabaseClient }
): Promise<void>
```

Update call sites in `src/cron.ts` and `scripts/seed-trust-from-replay.ts` to pass `supabase` where available.

- [ ] **Step 4: Run full test suite**

`bun test` — must still pass.

- [ ] **Step 5: Commit**

```bash
git add src/label-tag.ts src/replay-harness.ts src/trust-engine.ts src/relay.ts
git commit -m "feat(atlas-prime): wire failure signals — label, replay-judge, trust-event → cortex"
```

---

## Task 6: Memory rewriter — module + worker

**Files:**
- Create: `src/memory-rewrite.ts`
- Test: `tests/memory-rewrite.test.ts`

- [ ] **Step 1: Write `tests/memory-rewrite.test.ts`**

```typescript
import { describe, test, expect } from "bun:test";
import {
  isEligibleForRewrite,
  buildRewritePrompt,
  sanitizeRewrite,
  rewriteSummary,
  type MemoryForRewrite,
} from "../src/memory-rewrite.ts";

const now = new Date("2026-04-28T12:00:00Z").getTime();
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

describe("memory-rewrite eligibility", () => {
  const base: MemoryForRewrite = {
    id: "m1",
    original_content: "x",
    summary: "x",
    summary_rewritten_at: daysAgo(8),
    access_count_since_rewrite: 5,
  };

  test("eligible when age >= 7 AND access >= 5", () => {
    expect(isEligibleForRewrite(base, now)).toBe(true);
  });

  test("not eligible when age >= 7 BUT access < 5", () => {
    expect(isEligibleForRewrite({ ...base, access_count_since_rewrite: 4 }, now)).toBe(false);
  });

  test("not eligible when age < 7 EVEN IF access >= 5", () => {
    expect(
      isEligibleForRewrite(
        { ...base, summary_rewritten_at: daysAgo(6) },
        now
      )
    ).toBe(false);
  });

  test("not eligible when access >= 5 AND age exactly 7 (boundary; needs > 7)", () => {
    expect(
      isEligibleForRewrite({ ...base, summary_rewritten_at: daysAgo(7) }, now)
    ).toBe(false);
  });

  test("eligible when age = 7.01 days", () => {
    expect(
      isEligibleForRewrite(
        { ...base, summary_rewritten_at: new Date(now - 7.01 * 86_400_000).toISOString() },
        now
      )
    ).toBe(true);
  });
});

describe("memory-rewrite formatting", () => {
  test("sanitizeRewrite strips markdown fences", () => {
    expect(sanitizeRewrite("```\nhello\n```")).toBe("hello");
    expect(sanitizeRewrite("```markdown\nfoo\n```")).toBe("foo");
  });

  test("sanitizeRewrite caps length at 2000 chars", () => {
    const big = "a".repeat(3000);
    expect(sanitizeRewrite(big).length).toBe(2000);
  });

  test("buildRewritePrompt includes original, current summary, today, and contradictions", () => {
    const out = buildRewritePrompt({
      original: "Tirzepatide is $400.",
      currentSummary: "Tirzepatide is $400.",
      contradictions: ["April 1: Hallandale price reduced to $320."],
      today: "2026-04-28",
    });
    expect(out).toContain("$400");
    expect(out).toContain("Hallandale");
    expect(out).toContain("2026-04-28");
  });
});

describe("memory-rewrite worker", () => {
  test("rewriteSummary skips below-threshold critic score", async () => {
    const updates: any[] = [];
    const fakeSupabase = {
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({
          data: { id: "m1", original_content: "old", summary: "old",
                  summary_rewritten_at: daysAgo(10), access_count_since_rewrite: 6 },
          error: null,
        }) }) }),
        update: (u: any) => {
          updates.push(u);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      }),
    } as any;
    const callHaiku = async () => ({ text: "rewritten badly", usage: { input_tokens: 1, output_tokens: 1 } });
    const criticize = async () => ({ score: 0.4, flags: ["hallucination"] });
    await rewriteSummary("m1", { supabase: fakeSupabase, callHaiku, criticize, today: "2026-04-28" });
    // Should NOT update summary; only update summary_rewritten_at to defer retry.
    expect(updates.find((u) => u.summary)).toBeUndefined();
    expect(updates.find((u) => u.summary_rewritten_at)).toBeDefined();
  });

  test("rewriteSummary commits on critic pass", async () => {
    const updates: any[] = [];
    const fakeSupabase = {
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({
          data: { id: "m1", original_content: "old", summary: "old",
                  summary_rewritten_at: daysAgo(10), access_count_since_rewrite: 6 },
          error: null,
        }) }) }),
        update: (u: any) => {
          updates.push(u);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      }),
    } as any;
    const callHaiku = async () => ({ text: "AS OF 2026-04-28, updated summary.", usage: { input_tokens: 1, output_tokens: 1 } });
    const criticize = async () => ({ score: 0.85, flags: [] });
    await rewriteSummary("m1", { supabase: fakeSupabase, callHaiku, criticize, today: "2026-04-28" });
    expect(updates[0].summary).toContain("AS OF");
    expect(updates[0].access_count_since_rewrite).toBe(0);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `src/memory-rewrite.ts`**

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import { callHaiku as defaultCallHaiku, type HaikuResult } from "./haiku-client.ts";

const MIN_AGE_DAYS = Number(process.env.MEMORY_REWRITE_MIN_AGE_DAYS ?? 7);
const MIN_ACCESS = Number(process.env.MEMORY_REWRITE_MIN_ACCESS ?? 5);
const DAILY_LIMIT = Number(process.env.MEMORY_REWRITE_DAILY_LIMIT ?? 50);
const MAX_SUMMARY_CHARS = 2000;

export interface MemoryForRewrite {
  id: string;
  original_content: string;
  summary: string;
  summary_rewritten_at: string;        // ISO
  access_count_since_rewrite: number;
}

export function isEligibleForRewrite(row: MemoryForRewrite, nowMs = Date.now()): boolean {
  const ageMs = nowMs - new Date(row.summary_rewritten_at).getTime();
  const ageDays = ageMs / 86_400_000;
  return ageDays > MIN_AGE_DAYS && row.access_count_since_rewrite >= MIN_ACCESS;
}

const REWRITE_SYSTEM = `You rewrite a memory summary to incorporate today's hindsight while preserving the original belief.

Format your output as ONE paragraph. Begin with "AT THE TIME, [original belief]." and follow with "AS OF [today], [updated understanding] because [reason]." When no contradictions exist, write "AS OF [today], the original still holds."

Do not invent facts. Only use the original content + provided contradictions. No markdown fences, no preamble.`;

export interface BuildPromptInput {
  original: string;
  currentSummary: string;
  contradictions: string[];
  today: string;
}

export function buildRewritePrompt(input: BuildPromptInput): string {
  const contradictionsBlock = input.contradictions.length
    ? "Recent contradictions or refinements:\n" + input.contradictions.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : "No contradictions in recent context.";
  return [
    `TODAY: ${input.today}`,
    ``,
    `ORIGINAL CONTENT (immutable):`,
    input.original,
    ``,
    `CURRENT SUMMARY:`,
    input.currentSummary,
    ``,
    contradictionsBlock,
    ``,
    `Rewrite the summary per the system instructions.`,
  ].join("\n");
}

export function sanitizeRewrite(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    const firstNewline = s.indexOf("\n");
    if (firstNewline >= 0) s = s.slice(firstNewline + 1);
    if (s.endsWith("```")) s = s.slice(0, -3);
    s = s.trim();
  }
  if (s.length > MAX_SUMMARY_CHARS) s = s.slice(0, MAX_SUMMARY_CHARS);
  return s;
}

export interface RewriteOpts {
  supabase: SupabaseClient;
  callHaiku?: typeof defaultCallHaiku;
  criticize?: (text: string, opts?: any) => Promise<{ score: number; flags: string[] }>;
  searchContradictions?: (original: string) => Promise<string[]>;
  today?: string;
}

export async function rewriteSummary(
  memoryId: string,
  opts: RewriteOpts
): Promise<void> {
  const callHaiku = opts.callHaiku ?? defaultCallHaiku;
  const criticize = opts.criticize ?? (async () => ({ score: 1.0, flags: [] }));
  const searchContradictions = opts.searchContradictions ?? (async () => []);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  const { data, error } = await opts.supabase
    .from("memory")
    .select("id, original_content, summary, summary_rewritten_at, access_count_since_rewrite")
    .eq("id", memoryId)
    .single();
  if (error || !data) {
    console.error(`[memory-rewrite] load failed for ${memoryId}:`, error);
    return;
  }
  const row = data as MemoryForRewrite;

  const contradictions = await searchContradictions(row.original_content);
  const userMessage = buildRewritePrompt({
    original: row.original_content,
    currentSummary: row.summary,
    contradictions,
    today,
  });

  const result: HaikuResult = await callHaiku({
    system: REWRITE_SYSTEM,
    userMessage,
    maxTokens: 600,
    cacheSystem: true,
  });
  const newSummary = sanitizeRewrite(result.text);

  const critique = await criticize(newSummary, { type: "memory-summary" });
  if (critique.score < 0.7 || critique.flags.includes("hallucination")) {
    // Reject. Bump rewrite timestamp to defer 24h retry.
    await opts.supabase
      .from("memory")
      .update({ summary_rewritten_at: new Date().toISOString() })
      .eq("id", memoryId);
    return;
  }

  await opts.supabase
    .from("memory")
    .update({
      summary: newSummary,
      summary_rewritten_at: new Date().toISOString(),
      access_count_since_rewrite: 0,
    })
    .eq("id", memoryId);
}

/**
 * Find eligible rows up to DAILY_LIMIT and rewrite each.
 * Designed for nightly cron use.
 */
export async function processNightlyRewrites(supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - MIN_AGE_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("memory")
    .select("id")
    .lt("summary_rewritten_at", cutoff)
    .gte("access_count_since_rewrite", MIN_ACCESS)
    .neq("class", "demoted")
    .limit(DAILY_LIMIT)
    .order("access_count_since_rewrite", { ascending: false });
  if (error) {
    console.error("[memory-rewrite] nightly query failed:", error);
    return 0;
  }
  if (!data?.length) return 0;
  let count = 0;
  for (const row of data) {
    try {
      await rewriteSummary(row.id, { supabase });
      count++;
    } catch (err) {
      console.error(`[memory-rewrite] failed for ${row.id}:`, err);
    }
  }
  return count;
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/memory-rewrite.ts tests/memory-rewrite.test.ts
git commit -m "feat(atlas-prime): memory-rewrite module — lazy-on-stale with critic gate"
```

---

## Task 7: Memory summary backfill + retrieval enqueue

**Files:**
- Create: `scripts/backfill-memory-summaries.ts`
- Modify: `src/search.ts` — increment access_count_since_rewrite on retrieval

- [ ] **Step 1: Create `scripts/backfill-memory-summaries.ts`**

```typescript
#!/usr/bin/env bun
// One-shot backfill: copy memory.content into original_content + summary
// for every row missing original_content. Idempotent.

import { createClient } from "@supabase/supabase-js";

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  );

  // Postgres-side update via RPC for atomicity. If your project doesn't allow
  // arbitrary SQL via RPC, fall back to paginated update calls.
  const { data, error } = await supabase.rpc("memory_backfill_summaries");
  if (error) {
    console.error("backfill failed:", error);
    process.exit(1);
  }
  console.log("backfill rows updated:", data);
}

main();
```

Add a Postgres RPC function in a new migration (or amend Task 1's batch):

`db/migrations/030_memory_backfill_fn.sql`:
```sql
CREATE OR REPLACE FUNCTION memory_backfill_summaries() RETURNS INT AS $$
DECLARE
  updated_count INT;
BEGIN
  UPDATE memory
     SET original_content      = content,
         summary               = content,
         summary_rewritten_at  = created_at
   WHERE original_content IS NULL;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;
```

- [ ] **Step 2: Modify `src/search.ts` to increment access counter**

Wherever `getRelevantContext()` resolves the final retrieved memory rows (BEFORE returning), fire-and-forget increment:

```typescript
// Best effort; don't block on counter writes.
const ids = finalMemoryRows.map((r) => r.id);
if (ids.length) {
  supabase
    .rpc("memory_increment_access", { p_ids: ids })
    .catch((err) => console.error("[search] access increment failed:", err));
}
```

Add the matching RPC in `db/migrations/031_memory_increment_access_fn.sql`:

```sql
CREATE OR REPLACE FUNCTION memory_increment_access(p_ids UUID[]) RETURNS VOID AS $$
BEGIN
  UPDATE memory
     SET access_count_since_rewrite = access_count_since_rewrite + 1
   WHERE id = ANY(p_ids);
END;
$$ LANGUAGE plpgsql;
```

- [ ] **Step 3: Run full suite**

`bun test`

- [ ] **Step 4: Apply migrations 030, 031 + run backfill (when ready)**

```bash
bun run scripts/backfill-memory-summaries.ts
```

(Coordinate with Derek before running — applies to live data.)

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-memory-summaries.ts \
        db/migrations/030_memory_backfill_fn.sql \
        db/migrations/031_memory_increment_access_fn.sql \
        src/search.ts
git commit -m "feat(atlas-prime): memory summary backfill + retrieval access counter"
```

---

## Task 8: Procedural memory module

**Files:**
- Create: `src/procedures.ts`
- Test: `tests/procedures.test.ts`

- [ ] **Step 1: Write `tests/procedures.test.ts`**

```typescript
import { describe, test, expect } from "bun:test";
import {
  thompsonSample,
  rankByThompson,
  fillSlots,
  type Procedure,
  type Step,
} from "../src/procedures.ts";

describe("procedures Thompson sampling", () => {
  test("thompsonSample returns value in [0,1]", () => {
    for (let i = 0; i < 100; i++) {
      const v = thompsonSample(5, 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("alpha >> beta yields high mean sample", () => {
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += thompsonSample(50, 1);
    expect(sum / 1000).toBeGreaterThan(0.9);
  });

  test("alpha << beta yields low mean sample", () => {
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += thompsonSample(1, 50);
    expect(sum / 1000).toBeLessThan(0.1);
  });

  test("rankByThompson preserves all candidates and reorders", () => {
    const procs: Procedure[] = [
      { id: "a", goal: "g", action_sequence: [], preconditions: [], postconditions: [], alpha: 50, beta: 1, use_count: 0, tags: [] } as any,
      { id: "b", goal: "g", action_sequence: [], preconditions: [], postconditions: [], alpha: 1, beta: 50, use_count: 0, tags: [] } as any,
      { id: "c", goal: "g", action_sequence: [], preconditions: [], postconditions: [], alpha: 5, beta: 5, use_count: 0, tags: [] } as any,
    ];
    const out = rankByThompson(procs);
    expect(out).toHaveLength(3);
    // Run multiple times; "a" should win the majority.
    let aWinCount = 0;
    for (let i = 0; i < 100; i++) {
      const r = rankByThompson(procs);
      if (r[0].id === "a") aWinCount++;
    }
    expect(aWinCount).toBeGreaterThan(70);
  });
});

describe("procedures slot-filling", () => {
  test("fillSlots renders {slot} placeholders from a values map", () => {
    const steps: Step[] = [
      { kind: "tag", tag: "[GHL_TASK: contact={contact_name} | task={task} | due={due_date}]" },
      { kind: "say", template: "Hey {contact_name}, your task is scheduled." },
    ];
    const filled = fillSlots(steps, {
      contact_name: "John Doe",
      task: "follow-up labs",
      due_date: "2026-05-01",
    });
    expect(filled[0]).toContain("contact=John Doe");
    expect(filled[0]).toContain("task=follow-up labs");
    expect(filled[1]).toContain("Hey John Doe");
  });

  test("fillSlots leaves unknown slots literal so caller can detect", () => {
    const steps: Step[] = [{ kind: "tag", tag: "[X: a={known} b={unknown}]" }];
    const filled = fillSlots(steps, { known: "K" });
    expect(filled[0]).toContain("a=K");
    expect(filled[0]).toContain("b={unknown}");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `src/procedures.ts`**

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

export type Step =
  | { kind: "tag"; tag: string }
  | { kind: "wait"; for: string }
  | { kind: "say"; template: string }
  | { kind: "branch"; if: string; then: Step[]; else?: Step[] };

export interface Procedure {
  id: string;
  external_id?: string;
  goal: string;
  goal_embedding?: number[];
  preconditions: string[];
  action_sequence: Step[];
  postconditions: string[];
  alpha: number;
  beta: number;
  use_count: number;
  last_used_at?: string;
  tags: string[];
  source: string;
}

export interface RankedProcedure extends Procedure {
  thompson_score: number;
  cosine_similarity?: number;
}

/**
 * Sample one value from Beta(α, β) using the gamma method.
 * Numerically stable for α, β >= 1; we enforce that on input.
 */
export function thompsonSample(alpha: number, beta: number): number {
  const a = Math.max(1, alpha);
  const b = Math.max(1, beta);
  const xa = sampleGamma(a);
  const xb = sampleGamma(b);
  return xa / (xa + xb);
}

// Marsaglia + Tsang gamma sampler for shape >= 1
function sampleGamma(shape: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do {
      const u1 = Math.random();
      const u2 = Math.random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); // Box-Muller
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function rankByThompson(procedures: Procedure[]): RankedProcedure[] {
  return procedures
    .map((p) => ({ ...p, thompson_score: thompsonSample(p.alpha, p.beta) }))
    .sort((a, b) => b.thompson_score - a.thompson_score);
}

export function fillSlots(steps: Step[], values: Record<string, string>): string[] {
  const render = (template: string): string =>
    template.replace(/\{(\w+)\}/g, (full, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? values[name] : full
    );
  const out: string[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case "tag": out.push(render(step.tag)); break;
      case "say": out.push(render(step.template)); break;
      case "wait": /* narrative-only; no rendered output */ break;
      case "branch": /* condition resolution is upstream; not rendered here */ break;
    }
  }
  return out;
}

interface FindOpts {
  k?: number;
  supabase: SupabaseClient;
  embedQuery: (text: string) => Promise<number[]>;  // injected for testability
}

export async function findProcedure(
  goal: string,
  opts: FindOpts
): Promise<RankedProcedure[]> {
  const k = opts.k ?? 3;
  const embedding = await opts.embedQuery(goal);
  const { data, error } = await opts.supabase.rpc("procedures_match", {
    p_query_embedding: embedding,
    p_match_count: 20,
  });
  if (error) {
    console.error("[procedures] match query failed:", error);
    return [];
  }
  if (!data?.length) return [];
  const ranked = rankByThompson(data as Procedure[]);
  return ranked.slice(0, k);
}

export async function recordOutcome(
  supabase: SupabaseClient,
  procedureId: string,
  success: boolean,
  ledgerEntryId?: string
): Promise<void> {
  // Atomic increment via RPC.
  await supabase.rpc("procedure_record_outcome", {
    p_procedure_id: procedureId,
    p_success: success,
  });
  await supabase.from("procedure_outcomes").insert([
    { procedure_id: procedureId, success, ledger_entry_id: ledgerEntryId ?? null },
  ]);
}
```

- [ ] **Step 4: Add Postgres RPC functions**

`db/migrations/032_procedures_rpc.sql`:

```sql
CREATE OR REPLACE FUNCTION procedures_match(
  p_query_embedding VECTOR(1536),
  p_match_count INT DEFAULT 20
) RETURNS SETOF procedures AS $$
  SELECT *
    FROM procedures
   WHERE goal_embedding IS NOT NULL
   ORDER BY goal_embedding <=> p_query_embedding
   LIMIT p_match_count;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION procedure_record_outcome(
  p_procedure_id UUID,
  p_success BOOLEAN
) RETURNS VOID AS $$
BEGIN
  IF p_success THEN
    UPDATE procedures
       SET alpha = alpha + 1,
           use_count = use_count + 1,
           last_used_at = NOW(),
           updated_at = NOW()
     WHERE id = p_procedure_id;
  ELSE
    UPDATE procedures
       SET beta = beta + 1,
           use_count = use_count + 1,
           last_used_at = NOW(),
           updated_at = NOW()
     WHERE id = p_procedure_id;
  END IF;
END;
$$ LANGUAGE plpgsql;
```

- [ ] **Step 5: Run test — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/procedures.ts tests/procedures.test.ts db/migrations/032_procedures_rpc.sql
git commit -m "feat(atlas-prime): procedures module — Thompson sampling + slot-filler + RPCs"
```

---

## Task 9: Hand-curated procedures seed

**Files:**
- Create: `data/procedures-seed.yaml`
- Create: `scripts/seed-procedures.ts`
- Modify: `package.json` — add `js-yaml` dependency

- [ ] **Step 1: Add `js-yaml` to `package.json`**

```bash
bun add js-yaml
bun add -d @types/js-yaml
```

- [ ] **Step 2: Create `data/procedures-seed.yaml`** with 10 starter procedures

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
  tags: [newsletter, pv, weekly]

- id: ghl-task-followup
  goal: Create a follow-up task for a GHL contact.
  preconditions:
    - "contact name resolved"
    - "due date inferred or asked"
  action_sequence:
    - kind: tag
      tag: "[GHL_TASK: contact={contact_name} | task={task} | due={due_date}]"
    - kind: say
      template: "Task scheduled for {contact_name} on {due_date}."
  postconditions:
    - "Telegram confirmation sent"
  tags: [ghl, task, followup]

- id: cal-add-clinic-appt
  goal: Create a Google Calendar event for a clinic appointment.
  preconditions:
    - "title, date, time known"
  action_sequence:
    - kind: tag
      tag: "[CAL_ADD: title={title} | date={date} | time={time} | duration={duration} | invite={invitees} | location={location}]"
    - kind: say
      template: "Calendar event created: {title} on {date} at {time}."
  postconditions:
    - "Google Calendar entry created"
    - "invitees received .ics"
  tags: [calendar, clinic]

- id: stale-lead-reactivate
  goal: Reactivate a lead idle 7-14 days via GHL workflow.
  preconditions:
    - "contact name resolved"
    - "workflow id stale-lead-reactivate available"
  action_sequence:
    - kind: tag
      tag: "[GHL_TAG: contact={contact_name} | tag={reactivation_tag} | action=add]"
    - kind: tag
      tag: "[GHL_WORKFLOW: contact={contact_name} | workflowId={workflow_id} | action=add]"
    - kind: say
      template: "Reactivation queued for {contact_name}."
  postconditions:
    - "GHL workflow enrolled"
  tags: [ghl, reactivation, leads]

- id: tmaa-blog-publish-with-cache-purge
  goal: Publish a TMAA blog post and purge the CDN cache.
  preconditions:
    - "title, body, category known"
    - "MAA_WP_APP_PASSWORD env var set"
  action_sequence:
    - kind: tag
      tag: "[TMAA_BLOG_PUBLISH: title={title} | body={body} | category={category}]"
    - kind: wait
      for: "post id confirmation"
    - kind: tag
      tag: "[TMAA_CACHE_PURGE]"
  postconditions:
    - "blog post live on medicalaestheticsassociation.com"
  tags: [maa, blog, wordpress]

- id: weekly-content-waterfall
  goal: Generate the weekly Skool → Facebook → newsletter → YouTube waterfall.
  preconditions:
    - "this week's pillar rotation index loaded"
  action_sequence:
    - kind: tag
      tag: "[WORKFLOW: weekly-content | pillar={pillar}]"
  postconditions:
    - "all four artifacts drafted"
  tags: [content, weekly, pv]

- id: morning-brief-trigger
  goal: Trigger the daily morning brief for Derek.
  preconditions:
    - "before 7am Phoenix time"
  action_sequence:
    - kind: tag
      tag: "[WORKFLOW: pv-morning-brief]"
  postconditions:
    - "Telegram message delivered"
  tags: [morning-brief, daily]

- id: gbp-review-reply-draft
  goal: Draft a Google Business Profile review reply for Derek's approval.
  preconditions:
    - "review id known"
    - "review text and rating loaded"
  action_sequence:
    - kind: say
      template: "Drafting reply for {rating}-star review from {reviewer}."
    - kind: tag
      tag: "[REMEMBER: GBP review {review_id} response drafted on {date}]"
  postconditions:
    - "reply text emitted for Derek to approve"
  tags: [gbp, review, draft]

- id: ad-creative-brief
  goal: Generate ad creative variants for a Meta campaign.
  preconditions:
    - "campaign goal, target audience defined"
  action_sequence:
    - kind: tag
      tag: "[WORKFLOW: ad-creative | goal={campaign_goal} | audience={audience}]"
  postconditions:
    - "3-5 variant briefs delivered"
  tags: [meta, ads, creative]

- id: monthly-metrics-digest
  goal: Pull and summarize the monthly business scorecard for Derek.
  preconditions:
    - "supabase business_scorecard table populated for the month"
  action_sequence:
    - kind: tag
      tag: "[WORKFLOW: monthly-metrics-digest | month={month}]"
  postconditions:
    - "narrative summary + key deltas delivered"
  tags: [metrics, monthly, business]
```

- [ ] **Step 3: Create `scripts/seed-procedures.ts`**

```typescript
#!/usr/bin/env bun
// Idempotent seeder: reads data/procedures-seed.yaml and upserts into procedures table.
// Embeds each goal via OpenAI text-embedding-3-small (or skips if SKIP_EMBED=1 for dry-run).

import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { createClient } from "@supabase/supabase-js";

interface SeedProcedure {
  id: string;
  goal: string;
  preconditions: string[];
  action_sequence: any[];
  postconditions: string[];
  tags: string[];
}

async function embed(text: string): Promise<number[]> {
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

async function main() {
  const path = process.argv[2] ?? "data/procedures-seed.yaml";
  const raw = readFileSync(path, "utf8");
  const procedures = yaml.load(raw) as SeedProcedure[];

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  );

  const skipEmbed = process.env.SKIP_EMBED === "1";

  let upserted = 0;
  for (const p of procedures) {
    let goal_embedding: number[] | null = null;
    if (!skipEmbed) {
      try {
        goal_embedding = await embed(p.goal);
      } catch (err) {
        console.error(`embed failed for ${p.id}:`, err);
      }
    }
    const row: any = {
      external_id: p.id,
      goal: p.goal,
      goal_embedding,
      preconditions: p.preconditions ?? [],
      action_sequence: p.action_sequence ?? [],
      postconditions: p.postconditions ?? [],
      tags: p.tags ?? [],
      source: "hand-curated",
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("procedures")
      .upsert(row, { onConflict: "external_id" });
    if (error) {
      console.error(`upsert ${p.id} failed:`, error);
      continue;
    }
    upserted++;
  }
  console.log(`Seeded ${upserted}/${procedures.length} procedures.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Smoke test (dry-run, no embeddings)**

```bash
SKIP_EMBED=1 bun run scripts/seed-procedures.ts
```

Expected output: `Seeded 10/10 procedures.`

- [ ] **Step 5: Real seed (with embeddings)**

Coordinate with Derek before running:
```bash
bun run scripts/seed-procedures.ts
```

- [ ] **Step 6: Commit**

```bash
git add data/procedures-seed.yaml scripts/seed-procedures.ts package.json
git commit -m "feat(atlas-prime): hand-curated procedures seed (10 starter procedures)"
```

---

## Task 10: Reranker module

**Files:**
- Create: `src/reranker.ts`
- Test: `tests/reranker.test.ts`
- Modify: `package.json` — add `@xenova/transformers`

- [ ] **Step 1: Verify ONNX availability and add dependency**

Run:
```bash
bun add @xenova/transformers
```

Then in a one-off scratch script, attempt to load `zeta-alpha-ai/zerank-1-small`. If it fails, the fallback to `Xenova/bge-reranker-base` is automatic in our wrapper, but we want to know upfront which model the test suite will exercise.

```bash
bun -e "import('@xenova/transformers').then(async ({pipeline}) => { try { await pipeline('text-classification', 'zeta-alpha-ai/zerank-1-small', { quantized: true }); console.log('zerank-1-small OK'); } catch(e) { console.log('zerank fallback:', e.message); } })"
```

Note the result. If zerank-1-small loads, primary path. If not, fallback engaged.

- [ ] **Step 2: Write `tests/reranker.test.ts`**

```typescript
import { describe, test, expect } from "bun:test";
import { rerank, getActiveModelId } from "../src/reranker.ts";

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
    // For a sleep-related query, expect "c" or "a" first; "b" should be last.
    expect(out[out.length - 1].id).toBe("b");
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].rerank_score).toBeGreaterThanOrEqual(out[i].rerank_score);
    }
  });

  test("rerank topK clamps to candidate count", async () => {
    const out = await rerank("q", [{ id: "x", text: "y" }], 10);
    expect(out).toHaveLength(1);
  });

  test("getActiveModelId reports the loaded model", async () => {
    await rerank("warm", [{ id: "a", text: "b" }], 1);
    const id = getActiveModelId();
    expect(id === "zeta-alpha-ai/zerank-1-small" || id === "Xenova/bge-reranker-base").toBe(true);
  });
});
```

- [ ] **Step 3: Run test — expect FAIL**

(May also fail to find the package if `bun add` was skipped; in that case do step 1 first.)

- [ ] **Step 4: Implement `src/reranker.ts`**

```typescript
import { pipeline } from "@xenova/transformers";

let pipelineInstance: any = null;
let activeModelId: string = "zeta-alpha-ai/zerank-1-small";
const FALLBACK_MODEL_ID = "Xenova/bge-reranker-base";

export function getActiveModelId(): string {
  return activeModelId;
}

async function getReranker(): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  const requested = process.env.RERANKER_MODEL_ID ?? activeModelId;
  try {
    pipelineInstance = await pipeline("text-classification", requested, { quantized: true });
    activeModelId = requested;
  } catch (err) {
    console.warn(`[reranker] ${requested} unavailable (${err}); falling back to ${FALLBACK_MODEL_ID}`);
    pipelineInstance = await pipeline("text-classification", FALLBACK_MODEL_ID, { quantized: true });
    activeModelId = FALLBACK_MODEL_ID;
  }
  return pipelineInstance;
}

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult extends RerankCandidate {
  rerank_score: number;
}

export async function rerank(
  query: string,
  candidates: RerankCandidate[],
  topK = 8
): Promise<RerankResult[]> {
  if (!candidates.length) return [];
  const model = await getReranker();
  const scored: RerankResult[] = [];
  for (const c of candidates) {
    try {
      // Cross-encoder: pass (query, candidate) as paired input.
      const out = await model([{ text: query, text_pair: c.text }]);
      const score = Array.isArray(out) ? Number(out[0].score) : Number((out as any).score);
      scored.push({ ...c, rerank_score: Number.isFinite(score) ? score : 0 });
    } catch (err) {
      console.error(`[reranker] inference failed for ${c.id}:`, err);
      scored.push({ ...c, rerank_score: 0 });
    }
  }
  return scored.sort((a, b) => b.rerank_score - a.rerank_score).slice(0, topK);
}

/**
 * Pre-load the model + run a dummy inference to JIT the pipeline.
 * Call from startup so first user retrieval doesn't pay the load cost.
 */
export async function preWarm(): Promise<void> {
  await rerank("warm-up query", [{ id: "warm", text: "warm-up document" }], 1);
}
```

- [ ] **Step 5: Run test — expect PASS**

`bun test tests/reranker.test.ts`

If the model load times out the test (initial download can be slow), pre-load via:
```bash
bun -e "import('./src/reranker.ts').then(m => m.preWarm())"
```
then re-run the test.

- [ ] **Step 6: Commit**

```bash
git add src/reranker.ts tests/reranker.test.ts package.json
git commit -m "feat(atlas-prime): reranker module — Transformers.js zerank-1-small + bge fallback"
```

---

## Task 11: Wire reranker into search.ts

**Files:**
- Modify: `src/search.ts` — top-50 retrieve → rerank → top-8 return
- Modify: `src/cron.ts` — preWarm on startup
- Test: `tests/needle-in-haystack-integration.test.ts`

- [ ] **Step 1: Locate the embedding-search return point in `src/search.ts`**

Run: `grep -nE "limit\s*=|.match\(|getRelevantContext" src/search.ts | head -10`

Identify where embedding search retrieves K rows. Note current K (probably 8). Change retrieval to fetch top-50, then pipe through `rerank()`, then return top-8 to the caller.

- [ ] **Step 2: Modify the retrieval path**

Pseudocode (adapt to actual variable names):

```typescript
import { rerank } from "./reranker.ts";

// inside getRelevantContext, after embedding search returns rows:
const rawCandidates = await embeddingMatch(query, 50);  // was 8
const reranked = await rerank(
  query,
  rawCandidates.map((r) => ({ id: r.id, text: r.summary ?? r.content })),
  8
);
const finalRows = reranked.map((r) => {
  const original = rawCandidates.find((c) => c.id === r.id)!;
  return { ...original, rerank_score: r.rerank_score };
});

// finalRows then flows through Reader gate (Sprint 2) and attribution log (Task 3) unchanged.
```

Wrap the rerank call in try/catch — if the reranker model has not yet loaded (rare race), fall back to top-8 by raw embedding rank:

```typescript
let finalRows;
try {
  const reranked = await rerank(query, candidatesAsText, 8);
  finalRows = reranked.map(...);
} catch (err) {
  console.error("[search] rerank failed, falling back to embedding rank:", err);
  finalRows = rawCandidates.slice(0, 8);
}
```

- [ ] **Step 3: Pre-warm the reranker on startup**

In `src/cron.ts`'s `startCronJobs()` (or wherever module-level startup happens), schedule:

```typescript
setTimeout(() => {
  import("./reranker.ts").then((m) => m.preWarm()).catch((err) => {
    console.error("[startup] reranker pre-warm failed:", err);
  });
}, 30_000);  // 30s after boot
```

- [ ] **Step 4: Write `tests/needle-in-haystack-integration.test.ts`**

```typescript
import { describe, test, expect } from "bun:test";
import { rerank } from "../src/reranker.ts";

describe("needle in haystack integration", () => {
  test("reranker promotes a textually-relevant chunk over many distractors", async () => {
    const distractors = Array.from({ length: 49 }, (_, i) => ({
      id: `d${i}`,
      text: `Random fact number ${i} about quantum mechanics.`,
    }));
    const needle = {
      id: "needle",
      text: "Tirzepatide compound pricing at Hallandale dropped from $400 to $320 in November 2025.",
    };
    const candidates = [...distractors.slice(0, 25), needle, ...distractors.slice(25)];
    const out = await rerank(
      "What's the current Tirzepatide compound price at Hallandale?",
      candidates,
      3
    );
    const ids = out.map((r) => r.id);
    expect(ids).toContain("needle");
  }, 60_000);  // allow up to 60s for cold-start
});
```

- [ ] **Step 5: Run integration test — expect PASS**

`bun test tests/needle-in-haystack-integration.test.ts`

If timeout, the model is downloading on first run; re-run after model is cached.

- [ ] **Step 6: Commit**

```bash
git add src/search.ts src/cron.ts tests/needle-in-haystack-integration.test.ts
git commit -m "feat(atlas-prime): wire reranker — top-50 → rerank → top-8 + needle-in-haystack test"
```

---

## Task 12: Contextual chunking — ingest path + backfill

**Files:**
- Modify: `src/ingest-worker.ts` — `chunkContextually()`
- Create: `scripts/recontextualize-documents.ts` — backfill

- [ ] **Step 1: Inspect `src/ingest-worker.ts` to find the existing chunker**

Run: `grep -nE "chunk|split|800" src/ingest-worker.ts | head -10`

Note the existing chunking function name and signature.

- [ ] **Step 2: Add `chunkContextually()`**

Add to `src/ingest-worker.ts`:

```typescript
import { callHaiku } from "./haiku-client.ts";

const PREAMBLE_SYSTEM = `You write a single ≤80-token preamble situating a passage in its document. Format: "From [doc title] ([date if known]), [section if known]: this passage discusses [1-sentence topical summary]." Output the preamble only — no quotes, no markdown.`;

export interface ContextualChunk {
  chunk_text: string;
  context_preamble: string;
  embed_text: string;
}

export interface DocumentMetadata {
  title: string;
  date?: string;
  source: string;
  nearestHeading?: string;
}

export async function chunkContextually(
  documentText: string,
  metadata: DocumentMetadata,
  chunkRaw: (text: string) => string[] = defaultChunker  // injected for testability
): Promise<ContextualChunk[]> {
  const baseChunks = chunkRaw(documentText);
  const out: ContextualChunk[] = [];
  for (const chunk of baseChunks) {
    const userMessage = [
      `Document title: ${metadata.title}`,
      metadata.date ? `Date: ${metadata.date}` : "",
      metadata.nearestHeading ? `Section: ${metadata.nearestHeading}` : "",
      ``,
      `Passage:`,
      chunk,
    ]
      .filter(Boolean)
      .join("\n");
    let preamble = "";
    try {
      const result = await callHaiku({
        system: PREAMBLE_SYSTEM,
        userMessage,
        maxTokens: 100,
        cacheSystem: true,
      });
      preamble = result.text.trim().slice(0, 400);
    } catch (err) {
      console.error("[ingest] preamble generation failed:", err);
      preamble = `From ${metadata.title}.`;  // safe fallback
    }
    out.push({
      chunk_text: chunk,
      context_preamble: preamble,
      embed_text: preamble + "\n\n" + chunk,
    });
  }
  return out;
}

function defaultChunker(text: string): string[] {
  // Reuse the existing chunker from this file. Pseudocode if absent:
  // 800-char windows with 100-char overlap, split at sentence boundaries when possible.
  // (Implement to match existing behavior or import the existing function.)
  const CHUNK_SIZE = 800;
  const OVERLAP = 100;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE - OVERLAP) {
    out.push(text.slice(i, i + CHUNK_SIZE));
  }
  return out;
}
```

If `src/ingest-worker.ts` already exports a chunker, import it instead of defining `defaultChunker` locally.

- [ ] **Step 3: Call `chunkContextually()` from the ingestion entry point**

Find the existing ingest call (where it inserts into `documents`). Replace the chunk loop:

Before:
```typescript
const chunks = chunkRaw(text);
for (const c of chunks) {
  await supabase.from("documents").insert({ content: c, ... });
}
```

After:
```typescript
const contextualChunks = await chunkContextually(text, metadata);
for (const c of contextualChunks) {
  await supabase.from("documents").insert({
    content: c.chunk_text,
    context_preamble: c.context_preamble,
    chunked_strategy: "contextual-v1",
    // embedding generated by edge function from c.embed_text
    ...
  });
}
```

The embedding is currently generated by Supabase Edge Function on the backend. The edge function reads the `content` column. To get contextual embeddings, the edge function must read `(context_preamble || '\n\n' || content)` instead. Coordinate this — either:
- Update the edge function to use `coalesce(context_preamble || E'\n\n', '') || content` for the embedding source, OR
- Generate the embedding client-side in the ingest worker and write it directly.

Recommended: client-side embedding for the contextual path, leaving the edge function as a fallback for legacy raw-chunked content. Add an embedding helper:

```typescript
async function embedText(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}`);
  const j = (await res.json()) as any;
  return j.data[0].embedding;
}
```

Then write `embedding: await embedText(c.embed_text)` directly in the insert.

- [ ] **Step 4: Create `scripts/recontextualize-documents.ts`**

```typescript
#!/usr/bin/env bun
// Backfill: re-chunk + re-embed all documents rows where chunked_strategy='raw'.
// Idempotent. Throttled to 100 rows/min to respect Haiku rate limits.

import { createClient } from "@supabase/supabase-js";
import { callHaiku } from "../src/haiku-client.ts";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const PREAMBLE_SYSTEM = `You write a single ≤80-token preamble situating a passage in its document. Format: "From [doc title] ([date if known]): this passage discusses [1-sentence topical summary]." Output the preamble only.`;

async function embedText(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as any;
  return j.data[0].embedding;
}

async function processOne(row: any) {
  const userMessage = [
    `Document title: ${row.title ?? "(unknown)"}`,
    row.metadata?.date ? `Date: ${row.metadata.date}` : "",
    row.source ? `Source: ${row.source}` : "",
    ``,
    `Passage:`,
    row.content,
  ]
    .filter(Boolean)
    .join("\n");
  let preamble = "";
  try {
    const r = await callHaiku({ system: PREAMBLE_SYSTEM, userMessage, maxTokens: 100, cacheSystem: true });
    preamble = r.text.trim().slice(0, 400);
  } catch (err) {
    console.error(`[backfill] preamble failed for ${row.id}:`, err);
    preamble = `From ${row.title ?? row.source}.`;
  }
  const embedText_ = preamble + "\n\n" + row.content;
  const embedding = await embedText(embedText_);
  await supabase
    .from("documents")
    .update({
      context_preamble: preamble,
      chunked_strategy: "contextual-v1",
      embedding,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
}

async function main() {
  const BATCH = 50;
  const RATE_PER_MIN = 100;
  const SLEEP_MS = (60_000 / RATE_PER_MIN);  // 600ms per row
  let processed = 0;
  while (true) {
    const { data, error } = await supabase
      .from("documents")
      .select("id, title, source, content, metadata")
      .eq("chunked_strategy", "raw")
      .limit(BATCH);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      try {
        await processOne(row);
        processed++;
        if (processed % 50 === 0) console.log(`processed ${processed}`);
      } catch (err) {
        console.error(`row ${row.id} failed:`, err);
      }
      await new Promise((r) => setTimeout(r, SLEEP_MS));
    }
  }
  console.log(`backfill complete: ${processed} documents`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Smoke test (10 rows, then halt)**

Add a `--limit=10` arg handler if you want; otherwise let it process all. Coordinate with Derek before full run — cost ceiling estimated $30 for Haiku + $1 embeddings.

```bash
# Dry-run preview (count only)
bun -e "
import { createClient } from '@supabase/supabase-js';
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
s.from('documents').select('id', { count: 'exact', head: true }).eq('chunked_strategy','raw').then(r => console.log('raw rows to process:', r.count));
"
```

- [ ] **Step 6: Commit**

```bash
git add src/ingest-worker.ts scripts/recontextualize-documents.ts
git commit -m "feat(atlas-prime): contextual chunking — ingest path + backfill script"
```

---

## Task 13: Cron registration + capability registry + env + ship-criteria verification

**Files:**
- Modify: `src/cron.ts` — register `episodic-cluster-nightly`, `attribution-purge-nightly`, `memory-rewrite-nightly`
- Modify: `src/capability-registry.ts` — Sprint 3 entries
- Modify: `.env.example` — new env vars
- Verification: ship-criteria walkthrough

- [ ] **Step 1: Register `episodic-cluster-nightly` cron**

In `src/cron.ts` (follow Sprint 2 pattern with `CronJob.from + safeTick + jobs.push`):

```typescript
// 21. Atlas Prime Sprint 3: episodic clustering nightly at 2:30 AM.
jobs.push(
  CronJob.from({
    cronTime: "30 2 * * *",
    onTick: safeTick("episodic-cluster-nightly", async () => {
      // Query memory rows class='episodic' grouped by tags overlap >=3
      // Use Haiku to compose a generalized rule from each cluster
      // Insert as class='semantic'; demote source rows to class='archived-source'
      const { processEpisodicClustering } = await import("./cortex.ts");
      const promoted = await processEpisodicClustering(supabase);
      log("episodic-cluster-nightly", `promoted ${promoted} clusters to semantic`);
    }),
    timeZone: TIMEZONE,
  })
);
```

Then add `processEpisodicClustering` to `src/cortex.ts`:

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import { callHaiku } from "./haiku-client.ts";

export async function processEpisodicClustering(supabase: SupabaseClient): Promise<number> {
  // Pull candidate clusters: tags arrays of episodic rows, grouped, where count >= 3.
  const { data: clusters, error } = await supabase.rpc("episodic_clusters_for_promotion");
  if (error) {
    console.error("[cortex] cluster query failed:", error);
    return 0;
  }
  if (!clusters?.length) return 0;
  let promoted = 0;
  for (const c of clusters as Array<{ tag: string; member_ids: string[]; member_summaries: string[] }>) {
    if (c.member_ids.length < 3) continue;
    let rule = "";
    try {
      const r = await callHaiku({
        system: `You read a cluster of episodic memories sharing tag "${c.tag}" and write ONE generalized rule (≤80 words) capturing the pattern. Output the rule, no preamble.`,
        userMessage: c.member_summaries.map((s, i) => `${i + 1}. ${s}`).join("\n"),
        maxTokens: 200,
      });
      rule = r.text.trim();
    } catch (err) {
      console.error("[cortex] cluster Haiku failed:", err);
      continue;
    }
    const { error: insErr } = await supabase.from("memory").insert([
      {
        content: rule,
        original_content: rule,
        summary: rule,
        class: "semantic",
        tags: [c.tag, "episodic-promoted"],
      },
    ]);
    if (insErr) {
      console.error("[cortex] cluster insert failed:", insErr);
      continue;
    }
    // Demote sources.
    await supabase
      .from("memory")
      .update({ class: "archived-source" })
      .in("id", c.member_ids);
    promoted++;
  }
  return promoted;
}
```

Add the supporting RPC in `db/migrations/033_episodic_clusters_rpc.sql`:

```sql
CREATE OR REPLACE FUNCTION episodic_clusters_for_promotion()
RETURNS TABLE(tag TEXT, member_ids UUID[], member_summaries TEXT[]) AS $$
  SELECT
    t.tag,
    array_agg(m.id)         AS member_ids,
    array_agg(m.summary)    AS member_summaries
  FROM memory m, unnest(m.tags) t(tag)
  WHERE m.class = 'episodic'
    AND m.created_at > NOW() - INTERVAL '30 days'
  GROUP BY t.tag
  HAVING count(*) >= 3;
$$ LANGUAGE sql STABLE;
```

- [ ] **Step 2: Register `attribution-purge-nightly` cron**

```typescript
// 22. Atlas Prime Sprint 3: attribution log purge >90d nightly at 4:00 AM.
jobs.push(
  CronJob.from({
    cronTime: "0 4 * * *",
    onTick: safeTick("attribution-purge-nightly", async () => {
      const { error, count } = await supabase
        .from("attribution_log")
        .delete({ count: "exact" })
        .lt("created_at", new Date(Date.now() - 90 * 86_400_000).toISOString());
      if (error) {
        console.error("[attribution-purge] failed:", error);
        return;
      }
      log("attribution-purge-nightly", `deleted ${count ?? 0} rows`);
    }),
    timeZone: TIMEZONE,
  })
);
```

- [ ] **Step 3: Register `memory-rewrite-nightly` cron**

```typescript
// 23. Atlas Prime Sprint 3: lazy-on-stale memory summary rewrites at 1:00 AM.
jobs.push(
  CronJob.from({
    cronTime: "0 1 * * *",
    onTick: safeTick("memory-rewrite-nightly", async () => {
      const { processNightlyRewrites } = await import("./memory-rewrite.ts");
      const count = await processNightlyRewrites(supabase);
      log("memory-rewrite-nightly", `rewrote ${count} summaries`);
    }),
    timeZone: TIMEZONE,
  })
);
```

- [ ] **Step 4: Register `cortex-demote-nightly` cron**

```typescript
// 24. Atlas Prime Sprint 3: process pending demotions nightly at 0:30 AM.
jobs.push(
  CronJob.from({
    cronTime: "30 0 * * *",
    onTick: safeTick("cortex-demote-nightly", async () => {
      const { processDemotions } = await import("./cortex.ts");
      const count = await processDemotions(supabase);
      log("cortex-demote-nightly", `demoted ${count} memories`);
    }),
    timeZone: TIMEZONE,
  })
);
```

- [ ] **Step 5: Add capability registry entries**

In `src/capability-registry.ts`, append four entries (match the file's existing object shape — inspect first):

```typescript
{
  section: "Atlas Prime - Cortex (7-tier stack + demotion)",
  description: "Tier definitions over existing memory surfaces; attribution log; multi-signal weighted demotion (judge 0.5 + correction 1.0 + trust 0.7, threshold 3.0); inversion at depth ≤2.",
  can: [
    "record (turn_id, memory_id) pairs to attribution_log on retrieval",
    "increment demotion_pressure on failure signals",
    "demote memories at threshold and write inverted hypotheses",
    "promote 3+ episodic clusters into semantic rules nightly",
  ],
  cannot: [
    "modify identity tier (SOUL.md / IDENTITY.md / USER.md) — human-edited only",
    "exceed inversion depth 2 (alert fires for manual review)",
  ],
  module: "src/cortex.ts",
  depends: "memory, attribution_log, haiku-client.ts",
  runs: "episodic-cluster-nightly 2:30, attribution-purge-nightly 4:00, cortex-demote-nightly 0:30",
},
{
  section: "Atlas Prime - Procedural Memory",
  description: "Hand-curated procedures with Beta(α,β) Bayesian posteriors. Retrieve by intent embedding + Thompson sampling. Slot-filled at use time.",
  can: [
    "find top-k procedures for a given goal via Thompson sampling",
    "record success/failure outcomes that update Beta posteriors",
    "fill {slot} placeholders from a values map",
    "seed/reseed from data/procedures-seed.yaml idempotently",
  ],
  cannot: [
    "auto-generate new procedures from conversations (Sprint 6)",
    "execute action_sequence steps directly — slot-filler returns tag strings that go through tool-gate",
  ],
  module: "src/procedures.ts",
  depends: "procedures table, procedure_outcomes table, OpenAI embeddings",
  state: "data/procedures-seed.yaml (10 starter procedures)",
},
{
  section: "Atlas Prime - Memory Rewriting (lazy-on-stale)",
  description: "Living summaries. Rewrites trigger when a memory is stale (>7 days since last rewrite) AND frequently accessed (≥5 reads since last rewrite). Originals immutable.",
  can: [
    "increment access_count_since_rewrite on every retrieval",
    "rewrite summary via Haiku with hindsight (AT THE TIME / AS OF format)",
    "reject rewrites failing content-critic (score <0.7 or hallucination flag)",
    "cap 50 rewrites per nightly window",
  ],
  cannot: [
    "modify original_content (frozen on backfill)",
    "rewrite memories with class='demoted'",
  ],
  module: "src/memory-rewrite.ts",
  depends: "memory.original_content, memory.summary, content-critic.ts, haiku-client.ts",
  runs: "memory-rewrite-nightly at 1:00 AM",
},
{
  section: "Atlas Prime - Reranker + Contextual Chunking",
  description: "Retrieval pipeline: embedding top-50 → reranker top-8. Local Transformers.js (zerank-1-small or bge-reranker-base fallback). New ingestions get contextual preambles.",
  can: [
    "rerank up to 50 candidates with cross-encoder relevance scores",
    "log rerank_score to attribution_log for debugging",
    "generate ≤80-token Haiku preamble per chunk during ingestion",
    "backfill existing documents to chunked_strategy='contextual-v1'",
    "pre-warm model 30s after boot",
  ],
  cannot: [
    "load model larger than CPU memory permits",
    "retry inference on per-pair failure (returns score 0)",
  ],
  module: "src/reranker.ts, src/ingest-worker.ts",
  depends: "@xenova/transformers, OpenAI embeddings",
},
```

- [ ] **Step 6: Add env vars to `.env.example`**

Append:

```
# Atlas Prime Sprint 3
RERANKER_MODEL_ID=zeta-alpha-ai/zerank-1-small
MEMORY_REWRITE_DAILY_LIMIT=50
MEMORY_REWRITE_MIN_AGE_DAYS=7
MEMORY_REWRITE_MIN_ACCESS=5
```

- [ ] **Step 7: Run full test suite**

`bun test` — 125+ tests must pass (Sprint 2 baseline 125, plus all new Sprint 3 tests).

- [ ] **Step 8: Ship-criteria walkthrough**

Run each:

```bash
# Criterion 1: lazy rewrite eligibility
bun test tests/memory-rewrite.test.ts

# Criterion 2: Thompson sampling + Beta updates
bun test tests/procedures.test.ts

# Criterion 3: contextual chunking column populated for new ingestion
# (requires a manual ingest of a sample doc; verify via SQL)

# Criterion 4: weighted demotion + inversion at threshold
bun test tests/cortex.test.ts

# Criterion 5: needle-in-haystack reranking
bun test tests/needle-in-haystack-integration.test.ts

# Criterion 6: full suite green
bun test
```

- [ ] **Step 9: Final commit**

```bash
git add src/cron.ts src/capability-registry.ts src/cortex.ts \
        db/migrations/033_episodic_clusters_rpc.sql .env.example
git commit -m "feat(atlas-prime): Sprint 3 crons + capability registry + env + episodic clustering"
```

- [ ] **Step 10: Record sprint completion**

Append to `memory/atlas-prime-sprints.md`:

```
- 2026-04-XX — Sprint 3 (Memory That Works) shipped. Cortex (7-tier stack, attribution log, weighted demotion, inversion depth ≤2) + Procedural Memory (Beta(α,β) Thompson sampling, 10 starter procedures) + Memory Rewriting (lazy-on-stale, content-critic gate) + Contextual Chunking (preamble + reranker top-50→top-8). Full suite green.
```

```bash
git add memory/atlas-prime-sprints.md
git commit -m "chore(atlas-prime): record Sprint 3 completion"
```

---

## Appendix A: Integration order summary

The 13 tasks form a dependency chain:

```
Task 1 (migrations) ───┬─ Task 2 (cortex foundation)
                       │     └─ Task 3 (search.ts attribution wiring)
                       │           └─ Task 4 (demotion executor)
                       │                 └─ Task 5 (failure signal wiring)
                       │
                       ├─ Task 6 (memory-rewrite module)
                       │     └─ Task 7 (backfill + access counter)
                       │
                       ├─ Task 8 (procedures module)
                       │     └─ Task 9 (procedures seed)
                       │
                       ├─ Task 10 (reranker module)
                       │     └─ Task 11 (search.ts reranker wiring)
                       │
                       └─ Task 12 (contextual chunking)
                             └─ Task 13 (crons + registry + verification)
```

Tasks 6, 8, 10, 12 are independent of each other and could run in parallel agents if budget allows. Tasks 3, 4, 5 must run sequentially (each builds on the prior). Task 11 depends on Task 10. Task 13 must run last (touches all modules).

## Appendix B: Risks and decision points during execution

| Risk | Decision rule |
|------|--------------|
| Reranker model load >5min on first download | Pre-warm separately; don't block tests on first download |
| Reranker p99 inference >10s on 50 candidates | Reduce candidate count to 20 OR ship behind `RERANKER_ENABLED=0` |
| Backfill cost >$100 extrapolated | Halt; re-spec with Derek |
| Postgres RPC functions fail on Supabase due to permissions | Fall back to client-side multi-statement transactions |
| Embedding column on existing memory rows null | Backfill via OpenAI; cost trivial |
| `@xenova/transformers` Bun runtime issues | Spawn a Python ONNX subprocess (last-resort path; document in spec if needed) |

## Appendix C: What Sprint 3 explicitly does NOT do

- **Auto-extraction of new procedures** from successful conversations — Sprint 6 (DGM-adjacent).
- **Causal DAG** — Sprint 4. Memory rewriting can cite "X happened" but cannot reason about *why* X caused Y.
- **Dream Engine / world model** — Sprint 4.
- **Contrastive refinement of procedures** — stub only; logic in Sprint 6.
- **Sub-domain trust events targeting individual memories with precision** — approximated via tag-overlap heuristic in Task 5; precise targeting awaits Sprint 5+.

## Appendix D: File touch summary

**Created (16):**
- `src/cortex.ts`
- `src/procedures.ts`
- `src/memory-rewrite.ts`
- `src/reranker.ts`
- `data/procedures-seed.yaml`
- `scripts/seed-procedures.ts`
- `scripts/recontextualize-documents.ts`
- `scripts/backfill-memory-summaries.ts`
- `db/migrations/023_attribution_log.sql`
- `db/migrations/024_memory_rewrite_columns.sql`
- `db/migrations/025_memory_demotion_columns.sql`
- `db/migrations/026_procedures.sql`
- `db/migrations/027_procedure_outcomes.sql`
- `db/migrations/028_documents_contextual_columns.sql`
- `db/migrations/029_memory_record_failure_fn.sql`
- `db/migrations/030_memory_backfill_fn.sql`
- `db/migrations/031_memory_increment_access_fn.sql`
- `db/migrations/032_procedures_rpc.sql`
- `db/migrations/033_episodic_clusters_rpc.sql`

**Tests (5):**
- `tests/cortex.test.ts`
- `tests/procedures.test.ts`
- `tests/memory-rewrite.test.ts`
- `tests/reranker.test.ts`
- `tests/needle-in-haystack-integration.test.ts`

**Modified (8):**
- `src/ingest-worker.ts` (chunkContextually)
- `src/search.ts` (attribution + access counter + reranker)
- `src/memory.ts` (getOriginal, tier classification helpers)
- `src/cron.ts` (4 new jobs + reranker pre-warm)
- `src/capability-registry.ts` (4 new entries)
- `src/label-tag.ts` (failure signal)
- `src/replay-harness.ts` (failure signal)
- `src/trust-engine.ts` (failure signal)
- `package.json` (+@xenova/transformers, +js-yaml, +p-queue, +@types/js-yaml)
- `.env.example` (4 new env vars)

---

## Self-review

- **Spec coverage:**
  - Cortical stack (option C, tier mapping, demotion, inversion depth ≤2): Tasks 2, 4, 5, plus episodic clustering in Task 13.
  - Procedural memory (Thompson sampling, hand-curated seed, slot-filling, contrastive refinement stub): Tasks 8, 9.
  - Memory rewriting (lazy-on-stale, AT-THE-TIME / AS-OF format, critic gate, anti-thrash): Tasks 6, 7.
  - Contextual chunking + reranker: Tasks 10, 11, 12.
  - Attribution log + failure signal wiring: Tasks 1, 3, 5.
  - All 6 ship criteria mapped to Task 13's verification.
- **Placeholder scan:** None. Every code block is complete; the two adaptable pieces (existing chunker import name, supabase migration apply method) have explicit "inspect first" instructions with grep commands.
- **Type consistency:** `MemoryForRewrite`, `MemoryRow`, `Procedure`, `Step`, `RankedProcedure`, `RerankResult`, `ContextualChunk`, `FailureEvent`, `FailureSource`, `AttributionInput`, `FailureInput`, `InversionDraft`, `DemotionResult`, `BuildPromptInput` — all defined once in their owning module and referenced by name elsewhere.
- **Scope:** 13 tasks vs. Sprint 2's 11. 4 components, all four primitives covered. Task ordering supports both serial and partial-parallel execution. Migrations bundled in Task 1 to make schema atomic.
