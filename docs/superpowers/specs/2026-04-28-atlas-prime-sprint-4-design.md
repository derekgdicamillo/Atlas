# Atlas Prime — Sprint 4 (Anticipation) — Design Spec

**Date:** 2026-04-28
**Owner:** Derek DiCamillo
**Status:** Locked. Ready for plan.
**Source vision:** `ATLAS-PRIME.md` lines 126-132 (Sprint 4: Atlas Starts to Anticipate)
**Builds on:** Sprint 1 (ledger, Haiku client, atlas.spec, tool-gate, Staleness Sentinel), Sprint 2 (replay harness, trust budget, CaMeL Reader, hooks), Sprint 3 (cortex tiers + attribution, procedural memory, memory rewriting, contextual chunking, reranker)

---

## Goal

Each morning Atlas tells Derek what it expects he'll need today. Causal queries like *"why did revenue drop last March"* return cited reasoning chains. Atlas writes its first dream file. The agent thinks ahead, not just at you.

## Ship criteria (from ATLAS-PRIME.md and our scoping decisions)

1. `findCauses(metric_name, since)` returns cited causal edges with effect sizes; `walkPath(from, to)` returns a reasoning chain. Hand-curated seed edges + Derek-approved hypothesized edges from PC algorithm + LLM + natural-experiment.
2. `forecastCounterfactual(metric, action, horizon)` returns paired baseline + conditional forecasts with 95% CI; conditional forecast cites specific Causal DAG edges as the audit chain.
3. Dream Engine SWS produces nightly `memory/dreams/YYYY-MM-DD-sws.md` with counterfactual variants of high-salience episodes; emits semantic rules to `memory.class='semantic'` with `tags ⊃ {'from-dream'}`; emits `[DOUBT:]` tags on conflict.
4. Dream Engine REM produces nightly `memory/dreams/YYYY-MM-DD-rem.md` with top-3 tomorrow scenarios ranked by `unprep_score`; each scenario uses World Model `forecastCounterfactual` to validate any quantitative claim.
5. Derek Twin morning prediction injected into the daily brief; evening self-score per prediction; 30-day rolling calibration tracked.
6. Stated/revealed preference divergence: `gap > 0.4` with sample_size ≥ 5 emits `[TWIN_ALERT:]` in the next morning brief.
7. New Telegram commands work: `/dag pending`, `/dag approve <id>`, `/dag falsify <id>`, `/dag walk <node>`, `/forecast <metric> <h>`, `/forecast <metric> <h> if <action> on <date>`, `/twin`, `/twin predictions`, `/twin divergence`, `/twin reconcile <pref_id>`, `/twin calibration`.
8. Full test suite green. Atlas restart healthy. No regression in Sprint 1-3 modules.

---

## Architecture overview

```
                 ┌─────────────────────────┐
                 │  Causal DAG (foundation)│
                 │  ─ causal_nodes         │
                 │  ─ causal_edges         │
                 │  ─ causal_observations  │
                 │                         │
                 │  3 discovery paths:     │
                 │  • PC algorithm (Py)    │
                 │  • LLM-proposed (Opus)  │
                 │  • Natural-experiment   │
                 │                         │
                 │  Derek-approval gate    │
                 └────────────┬────────────┘
                              │
                              ▼
                 ┌─────────────────────────┐
                 │  World Model            │
                 │  ─ Chronos-Bolt fcaster │
                 │  ─ DAG action effects   │
                 │  ─ world_model_         │
                 │      forecasts table    │
                 └────────────┬────────────┘
                              │
                              ▼
                 ┌─────────────────────────┐
                 │  Dream Engine           │
                 │  ─ SWS 23:00 (replay)   │
                 │  ─ REM 03:00 (predict)  │
                 │  ─ dreams table + .md   │
                 └─────────────────────────┘

   ┌─────────────────────────────┐
   │  Derek Twin (independent)   │
   │  ─ stated_preferences       │
   │  ─ revealed_observations    │
   │  ─ divergence               │
   │  ─ predictions              │
   │  ─ feeds REM uncertainty    │
   └─────────────────────────────┘
```

**Build order:** Causal DAG (foundation) → Derek Twin (parallel) → World Model (depends on DAG) → Dream Engine (depends on World Model + DAG + Derek Twin's emotional/uncertainty signals).

**New modules:**
- `src/causal-graph.ts` — graph operations, query API, Derek-approval gate
- `src/causal-discovery.ts` — natural-experiment detection + PC subprocess wrapper + LLM proposer
- `src/world-model.ts` — Chronos-Bolt wrapper + counterfactual rollout
- `src/dream-engine.ts` — salience scorer + SWS + REM
- `src/derek-twin.ts` — stated/revealed tracking + prediction + scoring

**New scripts:**
- `scripts/causal_pc.py` — Python entry point for PC algorithm via `causaldag` lib
- `scripts/seed-causal-graph.ts` — hand-seed initial nodes from existing scorecard metrics + recent ledger events

**Extended modules:**
- `src/cron.ts` — register 7 new crons
- `src/relay.ts` — register 5 new commands (`/dag`, `/forecast`, `/twin`, plus subcommands)
- `src/capability-registry.ts` — 5 new entries
- `src/pv-morning-brief` (existing) — inject twin predictions, dream highlights, twin alerts, dag pending count
- `package.json` — `@xenova/transformers` already present; ensure Chronos-Bolt loads; add Python deps documented

---

## §1. Causal DAG

### Schema

```sql
-- db/migrations/034_causal_nodes.sql
CREATE TABLE IF NOT EXISTS causal_nodes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL CHECK (kind IN ('metric', 'action', 'event')),
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  unit         TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_causal_nodes_kind ON causal_nodes(kind);

-- db/migrations/035_causal_edges.sql
CREATE TABLE IF NOT EXISTS causal_edges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_node     UUID NOT NULL REFERENCES causal_nodes(id) ON DELETE CASCADE,
  to_node       UUID NOT NULL REFERENCES causal_nodes(id) ON DELETE CASCADE,
  effect_size   REAL,
  effect_ci     JSONB,
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL CHECK (status IN ('hypothesized', 'observed', 'falsified')),
  proposed_by   TEXT NOT NULL CHECK (proposed_by IN ('pc-algo', 'llm', 'natural-experiment', 'manual')),
  approved      BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_causal_edges_from ON causal_edges(from_node);
CREATE INDEX IF NOT EXISTS idx_causal_edges_to ON causal_edges(to_node);
CREATE INDEX IF NOT EXISTS idx_causal_edges_pending
  ON causal_edges(status, approved) WHERE approved = FALSE;

-- db/migrations/036_causal_observations.sql
CREATE TABLE IF NOT EXISTS causal_observations (
  id          BIGSERIAL PRIMARY KEY,
  node_id     UUID NOT NULL REFERENCES causal_nodes(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL,
  value       REAL,
  source      TEXT NOT NULL,
  source_ref  TEXT
);
CREATE INDEX IF NOT EXISTS idx_causal_observations_node_time
  ON causal_observations(node_id, observed_at);
```

### Module: `src/causal-graph.ts`

```typescript
export interface CausalNode { id, kind, name, description, unit, metadata }
export interface CausalEdge { id, from_node, to_node, effect_size, effect_ci, evidence,
                              status, proposed_by, approved, approved_by, approved_at, notes }

// Query API
export async function findCauses(supabase, metric_name: string, since?: Date): Promise<CausalEdge[]>;
export async function findEffects(supabase, action_name: string, horizon_days?: number): Promise<CausalEdge[]>;
export async function walkPath(supabase, from_name: string, to_name: string, max_depth = 4):
  Promise<{ path: CausalEdge[]; reasoning: string } | null>;
export async function pendingApprovals(supabase, limit = 20): Promise<CausalEdge[]>;

// Mutations (gated by /dag commands; not exposed to general code)
export async function approveEdge(supabase, edge_id: string, approver: 'derek' | 'esther'): Promise<void>;
export async function falsifyEdge(supabase, edge_id: string, reason: string): Promise<void>;
export async function manuallyAddEdge(supabase, opts: { from, to, effect_size?, evidence?, notes? }):
  Promise<CausalEdge>;
```

### Discovery path A: natural-experiment detection

Module: `src/causal-discovery.ts`. Cron `causal-natural-experiments` at 0:30 PHX.

```typescript
export async function detectNaturalExperiments(supabase): Promise<{ inserted: number }>;
```

Algorithm:
1. Query `data/atlas-ledger/*.jsonl` (Sprint 1 ledger) for entries in the last 30 days where the action tag indicates a distinct intervention (filter list: `[GHL_WORKFLOW: ... | action=add]`, `[CAL_ADD: ...]`, `[WP_UPDATE: ...]`, `[GHL_SOCIAL: ...]`, `[PV_NEWSLETTER_PUSH]`, manual `[REMEMBER:]` entries with tags `['intervention','launch','price-change','pause']`).
2. For each candidate intervention, find its corresponding `causal_node` (insert if absent with `kind='action'`).
3. For each `business_scorecard` daily metric, fetch 14 days pre and 14 days post the intervention timestamp.
4. Compute `delta = mean(post) − mean(pre)` and a permutation-test p-value (1000 resamples).
5. If `p < 0.05`, insert a `causal_edges` row: `from_node = action_id`, `to_node = metric_id`, `effect_size = delta`, `effect_ci = {low, high}` from bootstrap, `status='observed'`, `approved=false`, `proposed_by='natural-experiment'`, `evidence = [{ledger_entry_id, pre_window, post_window, p_value}]`.
6. Idempotent: dedupe by `(from_node, to_node, evidence[0].ledger_entry_id)` to avoid duplicate inserts on re-run.

### Discovery path B: PC algorithm

Module: `src/causal-discovery.ts` + `scripts/causal_pc.py`. Cron `causal-pc-discovery` at 1:30 PHX (daily but only if last successful run > 7 days OR manually triggered).

The Python subprocess pattern matches Atlas's existing pattern (search the codebase for `spawn('python` to confirm the conventions used by other Python helpers; if none, document this as a new pattern).

`scripts/causal_pc.py`:
```python
#!/usr/bin/env python3
# Reads stdin: JSON {"observations": [[v1, v2, ...], ...], "var_names": [...]}
# Writes stdout: JSON {"edges": [{"from": "i", "to": "j", "stability": 0.85}, ...]}
import json, sys
from causaldag import partial_correlation, pcalg
import numpy as np

def main():
    payload = json.load(sys.stdin)
    X = np.array(payload["observations"])
    names = payload["var_names"]
    # Bootstrap-stability selection: 100 resamples
    edge_counts = {}
    n_iter = 100
    for _ in range(n_iter):
        sample = X[np.random.choice(len(X), len(X), replace=True)]
        ci_test = partial_correlation(sample)
        cpdag = pcalg(ci_test, alpha=0.05)
        for i, j in cpdag.directed_edges:
            edge_counts[(i, j)] = edge_counts.get((i, j), 0) + 1
    # FDR control: stability >= 0.7
    edges = []
    for (i, j), count in edge_counts.items():
        stability = count / n_iter
        if stability >= 0.7:
            edges.append({"from": names[i], "to": names[j], "stability": stability})
    print(json.dumps({"edges": edges}))

if __name__ == "__main__":
    main()
```

TypeScript wrapper: `runPCDiscovery(supabase): Promise<{ inserted: number }>` builds the observation matrix from `causal_observations` over last 90 days, spawns the Python subprocess, parses output, inserts edges with `proposed_by='pc-algo'`, `status='hypothesized'`, `approved=false`, `effect_size=null`, `evidence = [{stability, n_observations}]`.

If Python or `causaldag` lib unavailable, the cron logs a warning and skips. The other two discovery paths still produce edges, so this is a soft dependency.

### Discovery path C: LLM-proposed

Cron `causal-llm-propose` at 2:00 PHX on Sundays only.

```typescript
export async function proposeLLMEdges(supabase): Promise<{ inserted: number }>;
```

1. Build context: last 7 days of journal entries (`memory/YYYY-MM-DD.md`), summary of `business_scorecard` weekly aggregates, last 50 ledger entries, list of currently-approved edges (so Opus knows what's already known).
2. Opus call with structured output (Zod schema):
   ```typescript
   const EdgeProposal = z.object({
     from_node: z.string(),
     to_node: z.string(),
     hypothesized_effect_size: z.number().optional(),
     direction: z.enum(["positive", "negative", "unknown"]),
     confidence: z.number().min(0).max(1),
     evidence_pointers: z.array(z.string()),
     rationale: z.string(),
   });
   ```
3. For each proposal, ensure both nodes exist (insert `kind='metric'` or `kind='action'` based on Opus's classification — it picks via tool-call), then insert the edge with `proposed_by='llm'`, `status='hypothesized'`, `approved=false`, `evidence = [{rationale, evidence_pointers}]`.

### Derek-approval gate (`/dag` command)

Sub-commands:

| Sub-command            | Action                                                                    |
|------------------------|---------------------------------------------------------------------------|
| `/dag pending`         | List up to 20 pending edges, ranked by `(confidence × novelty)` — newest first within rank tie |
| `/dag approve <id>`    | Set `approved=true`, `approved_by`, `approved_at`. If `proposed_by='natural-experiment'` and `effect_size` present, status flips to `'observed'`. |
| `/dag falsify <id> <reason>` | Set `status='falsified'`, append reason to `notes`. Edge stays in DB for audit. |
| `/dag walk <node_name>`| Calls `walkPath(node_name, ...)` for downstream effects up to depth 4, formatted for Telegram. |
| `/dag stats`           | Counts: nodes by kind, edges by status × proposed_by, pending count. |

### Hand-seeded initial graph

`scripts/seed-causal-graph.ts`:
- Reads `business_scorecard` schema (column names = metric names) and inserts each as a `causal_node` with `kind='metric'`.
- Reads recent `data/atlas-ledger/*.jsonl` entries for the last 30 days; canonical action types (`SEND_EMAIL`, `GHL_WORKFLOW_ENROLL`, `CAL_ADD`, `WP_POST`, `PV_NEWSLETTER_PUSH`, `TMAA_BLOG_PUBLISH`) become `causal_node` rows with `kind='action'`.
- Inserts ~5 manual seed edges from Derek's known causal beliefs (e.g., `meta_ad_spend → leads_count`, `cpl_increase → roi_decline`, `pdo_threads_cut → gross_profit`). These start `approved=true`, `proposed_by='manual'`, `status='observed'`, `effect_size` from his stated values.
- Idempotent: upsert by `name`.

Run once on first deploy; idempotent thereafter.

---

## §2. World Model

### Architecture

Foundation forecaster (Chronos-Bolt-Base via @xenova/transformers, ONNX) for natural-trend forecasting of any scorecard metric, plus Causal DAG action effects applied as deterministic shifts on top.

### Schema

```sql
-- db/migrations/037_world_model_forecasts.sql
CREATE TABLE IF NOT EXISTS world_model_forecasts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metric          TEXT NOT NULL,
  horizon_days    INT NOT NULL,
  counterfactual  JSONB,
  baseline_p50    REAL[] NOT NULL,
  baseline_p05    REAL[] NOT NULL,
  baseline_p95    REAL[] NOT NULL,
  conditional_p50 REAL[],
  conditional_p05 REAL[],
  conditional_p95 REAL[],
  dag_edges_used  UUID[] NOT NULL DEFAULT '{}',
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_world_model_forecasts_asked
  ON world_model_forecasts(asked_at DESC);
CREATE INDEX IF NOT EXISTS idx_world_model_forecasts_metric
  ON world_model_forecasts(metric, asked_at DESC);
```

### Module: `src/world-model.ts`

```typescript
export interface ForecastBands { p05: number[]; p50: number[]; p95: number[] }

export interface CounterfactualForecastResult {
  baseline: ForecastBands;
  conditional: ForecastBands;
  dagEdgesUsed: string[];
  reasoning: string;
}

export async function forecast(opts: {
  metric: string;
  horizonDays: number;
  history: Array<{ date: string; value: number }>;
}): Promise<ForecastBands>;

export async function forecastCounterfactual(
  supabase: SupabaseClient,
  opts: {
    metric: string;
    horizonDays: number;
    history: Array<{ date: string; value: number }>;
    action: { kind: string; when: string; magnitude?: number };
  }
): Promise<CounterfactualForecastResult>;

export async function preWarm(): Promise<void>;
```

### Loading Chronos-Bolt

Same pattern as Sprint 3 reranker:

```typescript
import { pipeline } from "@xenova/transformers";

let chronosInstance: any = null;
const PRIMARY = "amazon/chronos-bolt-base";
const FALLBACK = "Xenova/chronos-bolt-tiny";  // smaller, ONNX-confirmed available

async function getChronos() {
  if (chronosInstance) return chronosInstance;
  try {
    chronosInstance = await pipeline("zero-shot-classification", PRIMARY, { quantized: true });
  } catch (err) {
    console.warn(`[world-model] ${PRIMARY} unavailable (${err}); falling back to ${FALLBACK}`);
    chronosInstance = await pipeline("zero-shot-classification", FALLBACK, { quantized: true });
  }
  return chronosInstance;
}
```

(Note: Chronos-Bolt is `text-generation` style time-series; the actual Transformers.js task name + invocation API will be confirmed during implementation. Plan Task 1 verifies. Fallback to ARIMA via Python subprocess if Transformers.js can't host Chronos-Bolt yet — same risk-register pattern as Sprint 3 reranker.)

### Counterfactual algorithm

`forecastCounterfactual` is the auditable centerpiece:

1. **Baseline rollout** — `forecast(metric, horizonDays, history)` returns p05/p50/p95.
2. **Find applicable DAG effects** — `findEffects(action.kind, action.when)` returns approved edges where `from_node` corresponds to the action and `to_node` corresponds to (or transitively reaches) `metric`.
3. **Apply effects to baseline** — for each applicable edge:
   - **Direct edge** (action → metric): for `t ≥ days_since(action.when)`, shift `conditional_pXX[t] += effect_size × magnitude_multiplier`. The CI widens by `effect_ci.high − effect_ci.low`.
   - **Indirect edge** (action → intermediate → metric): chained product of effect sizes; CI widens proportionally to chain depth.
   - Effects stack (additive) when multiple paths exist between action and metric.
4. **Persist** — insert one `world_model_forecasts` row with both forecasts + `dag_edges_used` IDs.
5. **Reasoning string** — Haiku composes a one-paragraph natural-language summary citing each DAG edge by ID and effect size. Example:
   > *"Cutting telehealth ad spend on 2026-05-01 forecasts revenue at $52,400 ± $4,800 over the next 30 days vs. unconditional $58,100 ± $3,900. Drop traces to DAG edge `e6f...` (telehealth_pause → leads, effect −15.2 leads/week, p=0.03 from Feb 12 natural experiment) which propagates through edge `b3a...` (leads → revenue, conversion 18%) over the standard 21-day pipeline lag."*

### Cold start

Pre-warm via `setTimeout(preWarm, 60_000)` in `startCronJobs()`, same pattern as Sprint 3.

### `/forecast` command

```
/forecast <metric> <horizon_days>
/forecast <metric> <horizon_days> if <action_name> on <YYYY-MM-DD>
```

Examples:
- `/forecast revenue_mtd 30`
- `/forecast revenue_mtd 30 if peptides_launch on 2026-07-01`
- `/forecast leads 14 if telehealth_pause on 2026-05-01`

Output format (Markdown):
```
**revenue_mtd · 30-day forecast**

Baseline:    $58,100 ± $3,900 (p05–p95: $54,200–$62,000)
Counterfactual ("if telehealth_pause on 2026-05-01"):
             $52,400 ± $4,800 (p05–p95: $47,600–$57,200)

Audit chain:
- e6f… telehealth_pause → leads (−15.2/wk, p=0.03)
- b3a… leads → revenue (×0.18 conv, ~21d lag)

Saved as world_model_forecasts row {id}.
```

---

## §3. Dream Engine

### Schema

```sql
-- db/migrations/038_dreams.sql
CREATE TABLE IF NOT EXISTS dreams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phase         TEXT NOT NULL CHECK (phase IN ('SWS', 'REM')),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger       TEXT NOT NULL,
  source_refs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  content       TEXT NOT NULL,
  rules_emitted UUID[] NOT NULL DEFAULT '{}',
  doubts        TEXT[] NOT NULL DEFAULT '{}',
  unprep_score  REAL,
  embedding     VECTOR(1536),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_dreams_embedding
  ON dreams USING ivfflat (embedding vector_cosine_ops) WITH (lists = 30);
CREATE INDEX IF NOT EXISTS idx_dreams_occurred ON dreams(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_dreams_phase ON dreams(phase, occurred_at DESC);
```

### Module: `src/dream-engine.ts`

```typescript
export interface SalienceWeights {
  access: number; trust: number; incident: number; demotion: number;
}
export const DEFAULT_SALIENCE_WEIGHTS: SalienceWeights = {
  access: 0.3, trust: 0.3, incident: 0.2, demotion: 0.2,
};

export interface SalienceResult {
  memoryId: string;
  score: number;
  components: { access: number; trust: number; incident: number; demotion: number };
}

export async function computeSalience(
  supabase: SupabaseClient,
  memoryId: string,
  weights?: SalienceWeights
): Promise<SalienceResult>;

export async function topSalient(
  supabase: SupabaseClient,
  hoursBack = 24,
  k = 10
): Promise<SalienceResult[]>;

export async function runSWS(supabase: SupabaseClient): Promise<{ dreamId: string; rulesEmitted: number; doubts: string[] }>;
export async function runREM(supabase: SupabaseClient): Promise<{ dreamIds: string[]; topUnprep: number }>;
```

### Salience scorer

Per-memory components:
- **`access`** = `min(access_count_since_rewrite / 10, 1)` (Sprint 3 column on `memory`)
- **`trust`** = `1.0` if any trust event in last 7d cited turns where this memory appeared in `attribution_log` (join on `attribution_log.memory_id` and `data/trust-snapshots.jsonl` events with same `turn_id`); else 0
- **`incident`** = `1.0` if `tags && ARRAY['decision','incident','regret','surprise','correction']`; else 0
- **`demotion`** = `min(demotion_pressure, 3) / 3` (Sprint 3 column)

`score = Σ weight_i × component_i`. Top-10 by score from last 24h are SWS candidates.

### Phase 1: SWS (cron `dream-sws-nightly` at 23:00 PHX)

1. `topSalient(supabase, 24, 10)` → 10 memory rows with salience metadata.
2. For each memory:
   - Haiku generates 3-5 counterfactual variants:
     - System: *"You generate 3-5 counterfactual variants of a past episode. Each variant explores 'what if [different decision/timing/actor]?' Output JSON array of `{variant, probable_outcome, key_uncertainty}`. No invented facts beyond what the memory implies."*
     - User message: the memory's `summary` + tags + `created_at`.
3. Cluster pass: for each memory's variant set, Haiku writes one **abstract rule** if a pattern emerges (e.g., *"When a campaign pivot is announced same-day as the change, lead volume drops less than when announced retroactively."*). New row in `memory` with `class='semantic'`, `tags ⊃ {'from-dream', 'sws'}`, `original_content` = the rule text.
4. **Conflict detection**: for any two variants whose `probable_outcome` contradict (Haiku-judged), append `[DOUBT: <topic>]` to the dreams row's `doubts` array AND emit the same DOUBT to the next morning brief block.
5. Write `memory/dreams/YYYY-MM-DD-sws.md` (human narrative composed from variants + rules + doubts) AND insert `dreams` row with `phase='SWS'`, `source_refs = [memory_ids of the 10 originals]`, `rules_emitted = [new memory IDs]`, `doubts = [...]`, `embedding` of the narrative.

### Phase 2: REM (cron `dream-rem-nightly` at 03:00 PHX)

1. **Build the uncertainty pool:**
   - All open DOUBTs from `dreams` rows in last 7 days (where the doubt topic hasn't been resolved by a later approved DAG edge or memory).
   - All `causal_edges` with `status='hypothesized' AND approved=false`.
   - All `procedures` with `beta / (alpha + beta) > 0.5 AND use_count >= 3`.
   - All trust domains where `domain_score < 0.55` (Sprint 2 trust-engine).
2. Sample 5 prompts from the pool, weighted by `recency × magnitude`.
3. For each prompt, **Opus** call:
   - System: *"You are dreaming a tomorrow scenario. Compose a plausible scenario in which the given uncertainty becomes consequential. Use the World Model `forecastCounterfactual` tool to validate any quantitative claim. Output `{scenario, validated_claims: [...], unprep_score: 0..1}`. unprep_score = how unprepared Atlas would feel if this happened tomorrow."*
   - Tools available: `forecastCounterfactual(metric, action, horizon)` — Opus calls it 0–3 times per scenario.
4. Top-3 scenarios by `unprep_score` written to `memory/dreams/YYYY-MM-DD-rem.md` AND inserted as `dreams` rows with `phase='REM'`, `unprep_score` populated, `source_refs` listing the prompt's source IDs (doubt topic, edge ID, procedure ID, or domain), `metadata` capturing the World Model forecast IDs cited.
5. Each REM dream is embedded so it's retrievable by `getRelevantContext()` (Sprint 3 search.ts already does cross-source retrieval; the `dreams` table joins via the same pattern as `documents` and `memory`).

### Wiring into morning brief

`src/pv-morning-brief.ts` (existing skill at `.claude/skills/pv-morning-brief/`) gains a "Atlas dreamt last night" block. Block content (≤ 150 words):
- Top-1 REM scenario summary (from highest `unprep_score`)
- Up to 3 unresolved DOUBTs from yesterday's SWS
- Count of new approved DAG edges from the past day
- Count of pending DAG approvals (call to action)

### `/dreams` command

```
/dreams                    → today's REM scenarios + open doubts
/dreams sws                → today's SWS rules emitted
/dreams search <topic>     → search dream embeddings by topic
```

---

## §4. Derek Twin

### Schema

```sql
-- db/migrations/039_twin_stated_preferences.sql
CREATE TABLE IF NOT EXISTS twin_stated_preferences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL CHECK (user_id IN ('derek', 'esther')),
  preference   TEXT NOT NULL,
  domain       TEXT,
  source       TEXT NOT NULL,
  source_ref   TEXT,
  stated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_twin_stated_active
  ON twin_stated_preferences(user_id, active) WHERE active = TRUE;

-- db/migrations/040_twin_revealed_observations.sql
CREATE TABLE IF NOT EXISTS twin_revealed_observations (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  preference_id   UUID REFERENCES twin_stated_preferences(id) ON DELETE SET NULL,
  preference_text TEXT NOT NULL,
  domain          TEXT,
  signal          TEXT NOT NULL CHECK (signal IN ('accept', 'rewrite_align', 'rewrite_diverge', 'reject')),
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_twin_revealed_pref
  ON twin_revealed_observations(preference_id, observed_at DESC);

-- db/migrations/041_twin_divergence.sql
CREATE TABLE IF NOT EXISTS twin_divergence (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  preference_id   UUID NOT NULL REFERENCES twin_stated_preferences(id) ON DELETE CASCADE,
  domain          TEXT,
  stated_score    REAL NOT NULL,
  revealed_score  REAL NOT NULL,
  gap             REAL NOT NULL,
  sample_size     INT NOT NULL,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_twin_divergence_pref
  ON twin_divergence(preference_id, computed_at DESC);

-- db/migrations/042_twin_predictions.sql
CREATE TABLE IF NOT EXISTS twin_predictions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  predicted_for   DATE NOT NULL,
  prediction      TEXT NOT NULL,
  confidence      REAL NOT NULL,
  basis           TEXT NOT NULL,
  basis_refs      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_turn_id UUID,
  match_score     REAL,
  matched_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_twin_predictions_user_date
  ON twin_predictions(user_id, predicted_for);
```

### Module: `src/derek-twin.ts`

```typescript
export type ObservationSignal = 'accept' | 'rewrite_align' | 'rewrite_diverge' | 'reject';

export interface DivergenceRow {
  preference_id: string;
  preference_text: string;
  domain: string | null;
  stated_score: number;
  revealed_score: number;
  gap: number;
  sample_size: number;
}

export interface TwinPrediction {
  id: string;
  prediction: string;
  confidence: number;
  basis: string;
  basis_refs: any;
  matched_turn_id: string | null;
  match_score: number | null;
}

export async function classifyObservation(opts: {
  preference_text: string;
  atlas_output: string;
  user_followup: string;
  callHaiku?: typeof callHaikuDefault;
}): Promise<{ signal: ObservationSignal; rationale: string }>;

export async function recomputeDivergence(supabase, preference_id: string, domain?: string): Promise<DivergenceRow>;

export async function generateMorningPredictions(supabase, user_id: 'derek' | 'esther', date: string):
  Promise<TwinPrediction[]>;

export async function scoreEveningPredictions(supabase, user_id: 'derek' | 'esther', date: string):
  Promise<{ scored: number; calibration: number }>;

export async function rollingCalibration(supabase, user_id: string, days = 30): Promise<{
  mean: number; n: number; per_day: Array<{ date: string; calibration: number }>;
}>;

export function formatTwinReport(opts: {
  divergences: DivergenceRow[];
  todays_predictions: TwinPrediction[];
  calibration_30d: number;
}): string;
```

### Update mechanism (cron `twin-update-nightly` at 22:30 PHX)

1. For each active `twin_stated_preferences` row:
2. Pull last 24h `messages` rows where role='assistant' and (preference.domain matches metadata.channel OR preference.domain IS NULL).
3. For each Atlas output, look for a Derek/Esther follow-up turn within 2h of the assistant turn (matched on user_id + chronological proximity in same conversation).
4. If a follow-up exists, call `classifyObservation({preference_text, atlas_output, user_followup})` — Haiku returns `{signal, rationale}`.
5. Insert into `twin_revealed_observations`. Recompute `twin_divergence` for that preference: `revealed_score = (accept + rewrite_align) / total_observations`, `gap = 1 − revealed_score`.
6. Divergence alert: if `gap > 0.4` AND `sample_size >= 5` AND no `twin_divergence` row in last 7d for this preference recorded the same gap (de-dupe), emit `[TWIN_ALERT: <pref>]` for the next morning brief.

### Morning prediction (cron `twin-predict-morning` at 05:30 PHX)

Runs before the 6 AM brief.

1. Build Opus context:
   - Today's calendar events (already fetched by morning brief).
   - Last 4 same-weekday `messages.user` topics (e.g., for a Tuesday: pull last 4 Tuesdays' opening user messages).
   - Open threads from yesterday: any assistant turn ending in a question, where Derek hadn't answered as of midnight.
   - Procedures used in the last 7d (sorted by `last_used_at`).
   - Top-5 recent revealed-preference observations (so predictions tune to behavior, not stated).
2. Opus produces 3-5 predictions (structured Zod output): `{prediction, confidence, basis, basis_refs}`. Insert each as a `twin_predictions` row with `predicted_for = today (PHX)`, user_id.
3. Top-3 by confidence rendered for the morning brief block:
   ```
   **Atlas predicts today**
   - You'll likely ask about ad performance from yesterday's launch (0.74 — calendar shows 9am ad review)
   - You'll bring up Esther's review of patient flow (0.61 — open thread from yesterday)
   - You'll check PDO inventory (0.45 — Tuesday pattern over last 4 weeks)
   ```

### Evening self-score (cron `twin-score-evening` at 21:00 PHX)

1. For each `twin_predictions` row with `predicted_for = today` and `matched_turn_id IS NULL`:
2. Pull all today's user-turn messages from `messages` (role='user', user_id matches, created_at::date = today).
3. Haiku-as-judge call: *"Did any of these user turns approximately match this prediction? Output `{matched: bool, match_score: 0..1, turn_id: <uuid>}`. Approximate match counts."*
4. Update prediction row: `matched_turn_id`, `match_score`, `matched_at`.
5. Compute today's calibration: `accuracy = mean(match_score)` across today's predictions. Append to `data/twin-calibration.jsonl` as a daily snapshot.
6. **Rolling 30d calibration** below 0.5 → append a learning-queue entry (`data/learning-queue.json`, Sprint 1+2 night-shift) titled "Atlas calibration low — investigate prediction failures."

### `/twin` command

```
/twin                       → snapshot block: top divergences, today's predictions, 30d calibration
/twin predictions           → today's predictions with matched/unmatched status
/twin divergence            → table of preferences sorted by gap descending
/twin reconcile <pref_id>   → present divergence; ask "update stated to match revealed?" — replies handled by relay
/twin calibration           → 30-day rolling chart text-rendered + per-day pass-rate
```

### The reward signal claim

- `accuracy` from evening self-score becomes a **Sprint 6 DGM-fork fitness component**. Variants of Atlas that improve calibration without sacrificing replay-harness scores get merged.
- Below-threshold calibration auto-creates a learning-queue entry (Sprint 1's night-shift pipeline).
- Derek Twin's calibration is the **first metric exposed to Sprint 6's self-improvement loop that isn't a synthetic test score** — it measures whether Atlas is becoming more useful, not just more correct on the replay set.

---

## File touch summary

**Created (modules — 5):**
- `src/causal-graph.ts`
- `src/causal-discovery.ts`
- `src/world-model.ts`
- `src/dream-engine.ts`
- `src/derek-twin.ts`

**Created (scripts — 2):**
- `scripts/causal_pc.py`
- `scripts/seed-causal-graph.ts`

**Created (migrations — 9):**
- `db/migrations/034_causal_nodes.sql`
- `db/migrations/035_causal_edges.sql`
- `db/migrations/036_causal_observations.sql`
- `db/migrations/037_world_model_forecasts.sql`
- `db/migrations/038_dreams.sql`
- `db/migrations/039_twin_stated_preferences.sql`
- `db/migrations/040_twin_revealed_observations.sql`
- `db/migrations/041_twin_divergence.sql`
- `db/migrations/042_twin_predictions.sql`

**Created (tests — 5):**
- `tests/causal-graph.test.ts`
- `tests/causal-discovery.test.ts`
- `tests/world-model.test.ts`
- `tests/dream-engine.test.ts`
- `tests/derek-twin.test.ts`

**Modified:**
- `src/cron.ts` — register 7 new crons (`causal-natural-experiments`, `causal-pc-discovery`, `causal-llm-propose`, `dream-sws-nightly`, `dream-rem-nightly`, `twin-update-nightly`, `twin-predict-morning`, `twin-score-evening` — actually 8 if you count both twin updates)
- `src/relay.ts` — register `/dag`, `/forecast`, `/twin`, `/dreams` commands (each with sub-routing)
- `src/capability-registry.ts` — 4 new entries (Causal DAG, World Model, Dream Engine, Derek Twin)
- `src/pv-morning-brief.ts` — inject twin predictions, dream highlights, twin alerts, dag pending count
- `package.json` — confirm `@xenova/transformers` covers Chronos-Bolt; document Python deps (`pip install causaldag numpy`) in README
- `.env.example` — `TWIN_DIVERGENCE_GAP_ALERT=0.4`, `TWIN_MIN_SAMPLE_SIZE=5`, `WORLD_MODEL_PRIMARY=amazon/chronos-bolt-base`, `WORLD_MODEL_FALLBACK=Xenova/chronos-bolt-tiny`, `CAUSAL_PC_STABILITY_THRESHOLD=0.7`

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Chronos-Bolt not Transformers.js-compatible (yet) | Plan Task 1 verifies via `bun -e` probe. If incompatible, Python subprocess wrapping `chronos` HuggingFace lib. Same pattern as `causal_pc.py`. |
| `causaldag` Python lib unavailable in Atlas's environment | Document `pip install causaldag` in README; cron logs warning + skips if Python lookup fails. Other 2 discovery paths still produce edges. |
| PC algorithm produces false-positive edges from noisy data | All PC-discovered edges land `approved=false` and require `/dag approve`. Stability threshold 0.7 (raise to 0.8 if false-positive rate complains). |
| LLM-proposed edges hallucinate | Same gate. Plus: Opus prompt requires `evidence_pointers` to specific journal lines or scorecard observations — empty pointers is auto-reject. |
| World Model forecasts overconfident under counterfactual | DAG-effect application widens CI proportionally to chain depth (built-in mitigation). Plus: forecast row stores both baseline and conditional, so Derek can always see the unconditional. |
| Dream Engine writes too many semantic rules | SWS Cluster pass writes ONE rule per memory cluster, max 10 rules per night. Rules tagged `from-dream` so they're identifiable + revertible. |
| Derek Twin makes Atlas "predict" things that didn't happen | Match scoring is per-prediction (Haiku-judged); calibration tracked. Below 0.5 30d rolling = learning-queue alert. Predictions are *suggestions* in the morning brief, not commitments. |
| 9 SQL migrations is a lot; partial apply leaves DB inconsistent | Migrations are idempotent (`IF NOT EXISTS`). Apply order doesn't matter except: `causal_observations` must exist before `causal-natural-experiments` cron fires. Cron checks `EXISTS (SELECT FROM causal_nodes LIMIT 1)` before running. |
| Sprint scope blowout (this is the largest sprint) | Hard cut candidate: PC algorithm path is droppable (LLM + natural-experiment still produce edges). Soft cut candidate: REM dreams (SWS alone delivers the basic Dream Engine claim). Plan tasks rank by ship-criterion priority. |

---

## What Sprint 4 explicitly does NOT do

- **Real Dreamer-style RL training** — the pragmatic foundation-model path delivers the user-facing capability without months of RL engineering. Real Dreamer is an enhancement candidate for a future sprint.
- **Auto-discovery of new procedures from successful conversations** — Sprint 6 (DGM-adjacent).
- **Society / role marketplace / Shadow Council pre-send veto** — Sprint 5.
- **Self-modifying code** — Sprint 6.
- **Shadow-Atlas divergence monitor** — Sprint 7.
- **Causal-graph contrastive refinement** — when an edge is `falsified`, we don't auto-propose its inverse. Sprint 6 candidate.

---

## Self-review

- **Spec coverage:** All 4 ATLAS-PRIME Sprint 4 primitives covered (#3 Causal DAG, #5 Dream Engine, #6 World Model, #7 Derek Twin). Eight ship criteria each map to specific test paths in §1-4.
- **Placeholder scan:** None. Every option is concrete: schemas, function signatures, weight numbers, file paths, cron times, command formats. The two adaptable pieces (Chronos-Bolt Transformers.js compatibility, exact PC algorithm Python lib version) have explicit "Plan Task 1 verifies" instructions.
- **Internal consistency:** `causal_nodes`/`causal_edges` named the same in §1 / Risk register / File summary. `dreams.unprep_score` referenced consistently in §3 design and ship criterion 4. `twin_predictions.match_score` referenced consistently in §4 design and reward-signal claim.
- **Scope check:** Largest sprint yet — 4 components, 9 migrations, ~17-20 implementation tasks. The dependency chain (DAG → World Model → Dream Engine REM) is the schedule constraint. Plan task ordering must respect it.
- **Ambiguity check:** Two pieces flagged for runtime resolution (not spec ambiguity): Chronos-Bolt loading API, `causaldag` Python invocation. Both have decision rules, fallback paths, and explicit "Plan Task verifies" notes — not TBDs.
