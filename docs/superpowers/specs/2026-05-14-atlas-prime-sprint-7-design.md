# Atlas Prime — Sprint 7 (Bulletproofing) — Design Spec

**Date:** 2026-05-14
**Owner:** Derek DiCamillo
**Status:** Locked. Ready for plan.
**Source vision:** `ATLAS-PRIME.md` lines 158-165 (Sprint 7: Bulletproofing — final sprint of the arc)
**Builds on:** Sprints 1-6 (atlas.spec, ledger, Haiku CLI client, replay harness, trust budget, cortex, procedural memory, causal DAG, world model, dream engine, Derek twin, role registry, shadow council, marketplace, joint protocol, git blackboard, DGM fork, skill shadow-routing, soft-DPO, `/why` introspection)

---

## Goal

Atlas becomes verifiably honest about itself, in five concrete senses:

1. A **second Atlas instance** with cold context replays every prompt in shadow. If the two diverge in semantic content without an explanation traceable to new memory writes since the last sync, Atlas freezes and alerts Derek. MemoryGraft-class slow compromise (arXiv:2512.16962) is caught before it matters.
2. Every **ambiguous tool selection** gets a 5-sample semantic-entropy probe before dispatch. High-entropy choices (clusters > 1 with no clear winner) get logged, surfaced to Derek for review, and short-circuited to a clarifying question instead of guessing. The "Atlas guessed wrong about which integration to use" failure class becomes measurable.
3. Every **memory write** carries a ed25519 signature from a per-session keypair, chained back to the global Merkle ledger. Forging a memory after-the-fact fails verification at retrieval; the cortex stack rejects entries whose signature doesn't match either the session key or the chain root.
4. The **Saturday weekly knowledge audit** measures actual decay against staleness-sentinel half-lives. Domains that drifted faster than their half-life get their `half_life_days` ratcheted down automatically (with Derek-approval surface). The classifier sharpens on its own misses, closing the loop opened in Sprint 1.
5. The **public transparency beacon** publishes Merkle roots hourly to a public GitHub repo (`atlas-prime-beacon`). Anyone — including Derek six months from now — can pull a root and verify the local ledger against it. The standing bounty README invites external audit. Atlas becomes externally checkable, not just internally consistent.

Together: any attempt to poison Atlas's memory fails verification. Drift gets caught before it matters. The audit trail is public.

---

## Ship criteria (from ATLAS-PRIME.md and our locks)

1. **Shadow-Atlas runs as a separate Bun process** with cold context. Every relay prompt fans out to it on a fire-and-forget basis with a 90-second budget. A semantic-distance scorer (Haiku, CLI-backed) compares the two responses. Divergence ≥ threshold without a matching memory-write event in the divergence window triggers `[SHADOW_DRIFT_ALARM:]` → Telegram + freeze.
2. **Freeze on unexplained drift** is real: `data/shadow-atlas/freeze.flag` is checked by `callClaude` and refuses outbound external action tools until cleared by `/shadow resume`. Read tools remain available so Derek can investigate.
3. **Semantic-entropy probe on tool selection** runs whenever the tool-gate sees ≥2 candidate tools for a single ambiguous action. 5 samples via Haiku, clustered by Haiku-judge into semantically-equivalent groups; H = -Σ p_k log p_k. Entropy > `ENTROPY_THRESHOLD` (default 0.8 nats; tunable env var) → log to `tool_entropy_probes` table, surface to `/entropy review`, and substitute a clarifying-question response instead of dispatching.
4. **Memory write signing**: per-session ed25519 keypair generated at session start, public key registered in `session_keys` table, private key kept in-process. Every `memory` insert writes a signature over the canonical row hash. `session_keys.chain_root` anchors to the global ledger (a ledger entry is appended on key generation with `actor='atlas-session'` and `action.tool='session_key_register'`).
5. **Memory retrieval verifies** every loaded row. Failures log to `memory_verification_failures`, exclude the row from results, and emit `[MEMORY_VERIFY_FAIL:]` Telegram alert. Verification cost is per-row (~0.05 ms ed25519 verify).
6. **Saturday 9 AM knowledge audit** runs and updates `hot-domains.json`. For each fast/real-time domain: pulls a sample of Atlas's answers over the past 7 days, fetches the current authoritative source via WebFetch, diffs the claims, scores drift. If drift exceeds half-life expectation, proposes a new `half_life_days` to Derek via Telegram (3-button: ✓ apply, ✗ ignore, ✏ override). Approval emits `[HALF_LIFE_UPDATE:]` and updates `hot-domains.json` via tracked write + ledger entry.
7. **Public beacon publishes hourly** via GitHub Actions to `https://github.com/<owner>/atlas-prime-beacon`. The workflow pulls `data/atlas-ledger-roots.jsonl` from a private mirror, derives the latest root, and commits a public file `roots/YYYY-MM-DD.jsonl` containing `{ts, root, entries, sig}` per hour, plus `roots/latest.json` with the most recent root. The repo's README hosts a standing bounty: anyone who finds a tampered root or a divergence between published and locally-verified ledger wins a real-cash reward (amount left to Derek's discretion, $500 default).
8. **All model calls via Claude CLI subprocess (Max-plan OAuth).** No `@anthropic-ai/sdk` imports in Sprint 7 modules. Shadow-Atlas, entropy probes, weekly audit, drift-alarm scorer all route through `callClaude` or `callHaiku`. Ship verification includes a grep proving this.
9. **Full test suite green.** Sprint 7-specific tests cover divergence detection, freeze flag, entropy clustering math, memory signature verify-on-load, knowledge audit half-life proposals, beacon export format, and the GitHub Actions workflow YAML round-trip. No regression in Sprints 1-6.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Main Atlas-Prime process (relay)                              │
│  ──────────────────────────────────────────────────             │
│  user msg → callClaude(...)                                     │
│      │                                                           │
│      ├─→ Shadow-Atlas IPC (UNIX domain socket / named pipe)     │
│      │     fire-and-forget; 90s timeout                          │
│      │                                                           │
│      ├─→ Tool-gate (Sprint 1)                                   │
│      │     ↓                                                     │
│      │   if ambiguous → entropy-probe (5 Haiku samples + judge) │
│      │     ↓                                                     │
│      │   freeze.flag check (block external tools if set)        │
│      │                                                           │
│      └─→ Memory write hook                                       │
│            ↓                                                     │
│         sign(row_hash, session_priv) → memory.signature         │
└────────────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
┌──────────────────────────────┐   ┌──────────────────────────────┐
│  Shadow-Atlas process (Bun)  │   │  Knowledge Audit (Sat 9 AM)  │
│  ─────────────────────────── │   │  ─────────────────────────── │
│  bun src/shadow-atlas.ts     │   │  for each fast/real_time     │
│  cold context, only          │   │    domain in hot-domains:    │
│  CLAUDE.md + atlas.spec      │   │    pull last-7d answers,     │
│                              │   │    WebFetch authoritative    │
│  responds via IPC            │   │    source, Haiku-diff claims │
│                              │   │    propose new half_life     │
│  Drift scorer (Haiku)        │   │    surface to Derek          │
│  semantic distance + reason  │   │                              │
│      ↓                       │   │  on ✓ → update hot-domains   │
│  ≥ threshold → freeze flag   │   │    + ledger entry            │
└──────────────────────────────┘   └──────────────────────────────┘
                                              │
                                              ▼
                                ┌──────────────────────────────┐
                                │  Public Beacon (hourly)      │
                                │  ─────────────────────────── │
                                │  GitHub Actions cron          │
                                │  in atlas-prime-beacon repo  │
                                │                              │
                                │  pulls atlas-ledger-roots    │
                                │  → roots/YYYY-MM-DD.jsonl    │
                                │  → roots/latest.json         │
                                │  publishes README + bounty   │
                                └──────────────────────────────┘
```

**New modules (5):**
- `src/shadow-atlas.ts` — second-process entrypoint + IPC server (cold context, no MCP, no tools)
- `src/shadow-driver.ts` — main-process client + drift scorer + freeze-flag write
- `src/entropy-probe.ts` — semantic-entropy clustering + tool-gate hook
- `src/memory-signing.ts` — per-session keypair + sign-on-write + verify-on-load
- `src/knowledge-audit.ts` — Saturday audit + half-life proposal pipeline

**New scripts (2):**
- `scripts/beacon-export.ts` — pull ledger roots into the public-beacon format (run by GitHub Actions)
- `scripts/verify-beacon.ts` — cross-check published roots against local ledger (Derek-runnable any time)

**New workflows (1):**
- `.github/workflows/publish-beacon.yml` — hourly cron job that runs `scripts/beacon-export.ts` and commits to the public mirror repo

**New migrations (5):**
- `060_shadow_divergence_log.sql`
- `061_tool_entropy_probes.sql`
- `062_session_keys.sql`
- `063_memory_signature.sql`
- `064_knowledge_audit_log.sql`

**Modified modules:**
- `src/relay.ts` — `/shadow`, `/entropy`, `/audit`, `/beacon` commands; shadow-fire hook in prompt pipeline; freeze-flag external-action gate; memory-sign hook on insert
- `src/cron.ts` — 3 new crons (`knowledge-audit-weekly` Sat 9 AM, `shadow-process-watchdog` every 5 min, `beacon-roots-export` every hour calling local `scripts/beacon-export.ts` for the *local* publishing copy)
- `src/tool-gate.ts` — entropy-probe hook before allow (only when ≥2 candidate tools and the dispatch path flagged the choice as ambiguous; non-intrusive otherwise)
- `src/cortex.ts` — `verifyMemorySignature` on load; `signMemoryRow` on insert
- `src/capability-registry.ts` — 5 new entries
- `.env.example` — `SHADOW_ATLAS_ENABLED=true`, `SHADOW_DRIFT_THRESHOLD=0.45`, `ENTROPY_THRESHOLD=0.8`, `ENTROPY_PROBE_SAMPLES=5`, `KNOWLEDGE_AUDIT_SAMPLE_SIZE=8`, `BEACON_PUBLIC_REPO=atlas-prime-beacon`, `BEACON_BOUNTY_USD=500`

---

## §1. Shadow-Atlas Divergence Monitor

### Design

**Why a separate process, not in-process re-run?** Real drift detection requires *cold* context — a second Atlas that hasn't been gradually poisoned by the same memory writes, the same DPO injections, the same skill regenerations as the primary. In-process would share the cortex cache, the soft-DPO selector state, the persistent-process system prompt. A separate Bun process loads only the static files (CLAUDE.md, atlas.spec, hot-domains.json, the canonical memory rows that pass verification) at startup and resyncs on a slow cadence. The point is to catch slow compromise *that the primary cannot see in itself.*

**IPC choice:** UNIX domain socket on POSIX; named pipe on Windows. Bun has first-class support for both. Avoids the network attack surface of a TCP port. The socket path is `data/shadow-atlas/shadow.sock` (or `\\.\pipe\shadow-atlas` on Windows).

**Sync cadence:** Shadow-Atlas re-syncs its memory-row snapshot every 4 hours. Between syncs it operates from the snapshot frozen at last sync. This means a memory-graft attack lands in primary but not shadow → next prompt response in those two diverges → alarm fires.

### Schema

```sql
-- db/migrations/060_shadow_divergence_log.sql
CREATE TABLE IF NOT EXISTS shadow_divergence_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  turn_id         UUID,
  primary_text    TEXT NOT NULL,
  shadow_text     TEXT NOT NULL,
  distance        REAL NOT NULL,                    -- 0=identical, 1=opposite
  judge_reason    TEXT,
  memory_writes_in_window INT NOT NULL DEFAULT 0,   -- explanatory signal
  classified      TEXT NOT NULL CHECK (classified IN ('benign','explained','suspicious','alarm')),
  froze           BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_shadow_divergence_ts ON shadow_divergence_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_divergence_class ON shadow_divergence_log(classified);
```

### Module: `src/shadow-atlas.ts` (the shadow process)

Entrypoint script — runs as its own Bun process, started by `pm2` via a second app definition in `ecosystem.config.cjs` (added as part of Sprint 7 setup, not deployed automatically; Derek launches manually for the first cycle, then sprint completion enables auto-start).

```typescript
// Cold-context, minimal-dependency entrypoint
// NO imports from cortex.ts, dream-engine.ts, derek-twin.ts, marketplace.ts
// (anything that pulls live state). Static reads only.

import { readFile } from "fs/promises";
import { spawn } from "bun";
import { createServer } from "net";          // POSIX socket
// On Windows, use net.createServer with named-pipe path '\\\\.\\pipe\\shadow-atlas'

async function loadColdContext(): Promise<{ system: string; ts: string }> {
  // Read CLAUDE.md, SOUL.md, IDENTITY.md, USER.md, SHIELD.md, TOOLS.md, GOOGLE.md
  // hot-domains.json, atlas.spec (read-only mirror)
  // Most recent memory snapshot from data/shadow-atlas/memory-snapshot.jsonl
  // Return as concatenated system prompt + the snapshot timestamp.
}

async function handleRequest(prompt: string): Promise<{ text: string; usage: any }> {
  // callClaude with isolated:true, model:'sonnet', cold context as system,
  // NO MCP servers, NO tools (--allowedTools "").
  // Return raw text.
}

// IPC loop: accept JSON-RPC-style {id, prompt, deadline} -> {id, text, error?}
```

### Module: `src/shadow-driver.ts` (main-process client)

```typescript
export interface ShadowFireResult {
  ok: boolean;
  shadowText?: string;
  reason?: string;
}

export async function fireShadow(prompt: string, opts?: { budgetMs?: number }): Promise<ShadowFireResult>;

export async function scoreDrift(primaryText: string, shadowText: string): Promise<{ distance: number; reason: string }>;

export async function recordDivergence(opts: {
  supabase: any;
  turn_id: string | null;
  primaryText: string;
  shadowText: string;
  distance: number;
  reason: string;
  memoryWritesInWindow: number;
}): Promise<{ classified: 'benign'|'explained'|'suspicious'|'alarm'; froze: boolean }>;

export async function isFrozen(): Promise<boolean>;
export async function freeze(reason: string): Promise<void>;
export async function resume(by: string, note?: string): Promise<void>;
```

### Drift scorer (Haiku)

Cached system prompt:
> "You score the semantic distance between two responses to the same user prompt. 0 = identical meaning, 0.5 = different emphasis or detail, 1 = contradictory or unrelated. Output strict JSON: `{distance: <0..1 number, 2 decimals>, reason: <one sentence>}`."

User: `{prompt, primary: <text>, shadow: <text>}`.

### Classification logic

After `scoreDrift` returns:
- `distance < 0.2` → `'benign'`, no log entry (cost optimization; explicit threshold).
- `0.2 ≤ distance < SHADOW_DRIFT_THRESHOLD (default 0.45)` → `'explained'` if there are recent memory-write events in the window since last shadow sync, else `'suspicious'`. Logged.
- `distance ≥ SHADOW_DRIFT_THRESHOLD` and `memoryWritesInWindow == 0` → `'alarm'`. Logged. Freeze flag set. Telegram alert with both texts + reason.

The "memory writes in window" signal comes from `cortex.ts`'s `memory.created_at` between the last `session_keys.synced_to_shadow_at` and now. If a graft slipped past signing, this signal is the explanation; if it didn't, divergence has no excuse.

### Freeze flag mechanics

`data/shadow-atlas/freeze.flag` is a JSON file: `{frozen: true, since: ISO, reason: string, divergence_id: UUID}`.

Hooks:
- `src/claude.ts:callClaude` — before sending the prompt, if the action will dispatch external tools (any tool not in a read-only allowlist), check freeze flag. Frozen → return canned response: *"Atlas is frozen pending Derek's review of a shadow divergence. Run `/shadow status` for details, `/shadow resume` to clear once reviewed."*
- Read tools remain available (Read, Grep, search-memory, retrieve-context, scorecard reads).
- Cron jobs (heartbeat, etc.) check the flag and skip external-action steps when frozen.

`/shadow resume <divergence_id>` writes a ledger entry, clears the flag, populates `resolved_*` columns.

### Cron: `shadow-process-watchdog` every 5 min

Checks that shadow-atlas process is alive (probes IPC). If down, attempts auto-restart up to 3x with backoff; emits Telegram alert if still down. Shadow being down does NOT freeze Atlas — primary continues with logged warning. The shadow is a watchdog, not a single point of failure.

### Tests

- Unit: `scoreDrift` math; classification thresholds; freeze flag round-trip; IPC handshake (mocked).
- Integration: spawn shadow-atlas process, send a prompt to both, score, assert classification matches expected for distance buckets.

---

## §2. Semantic-Entropy Probe on Tool Selection

### Design

The trigger is **ambiguity at the dispatch layer**, not every tool call. The probe runs when the prompt produces ≥2 candidate tool dispatches in a single turn (e.g., "send this to Derek and put it on the calendar" → ambiguous between `[SEND:]` and `[CAL_ADD:]` framing, or two competing send paths). Most turns have one obvious tool; the probe doesn't fire there.

Source signal: relay.ts already parses outgoing tags. The new wrinkle is detecting that *the model proposed equivalent reformulations* — typically the same content rendered into two different tags. We don't try to predict ambiguity ahead of dispatch; we detect it from the model's own output, then optionally re-prompt with 5 samples to measure how stable the choice is.

The semantic-entropy theory (Kuhn et al. 2023, arXiv:2302.09664, replicated by Farquhar et al. *Nature* 2024) shows that clustering K samples by entailment and computing H = -Σ p_k log p_k on cluster proportions is a reliable hallucination signal. We use it on **action choice** rather than freeform answer content.

### Schema

```sql
-- db/migrations/061_tool_entropy_probes.sql
CREATE TABLE IF NOT EXISTS tool_entropy_probes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  turn_id       UUID,
  user_prompt   TEXT NOT NULL,
  samples       JSONB NOT NULL,                      -- array of {idx, tool, args_canonical}
  clusters      JSONB NOT NULL,                      -- array of {cluster_id, members:[idx], representative}
  entropy       REAL NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('dispatched','clarified','manual_review')),
  selected_tool TEXT,
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_entropy_ts ON tool_entropy_probes(ts DESC);
CREATE INDEX IF NOT EXISTS idx_entropy_action ON tool_entropy_probes(action);
```

### Module: `src/entropy-probe.ts`

```typescript
export interface Sample {
  idx: number;
  tool: string;
  args_canonical: string;   // canonicalized JSON of args
}

export interface Cluster {
  cluster_id: number;
  members: number[];
  representative: Sample;
}

export interface ProbeResult {
  entropy: number;          // nats
  clusters: Cluster[];
  recommendation: 'dispatch_consensus' | 'clarify' | 'manual_review';
  selectedTool?: string;
}

export async function generateSamples(prompt: string, contextSystem: string, k?: number): Promise<Sample[]>;
export async function clusterSamples(samples: Sample[]): Promise<Cluster[]>;
export function entropyOf(clusters: Cluster[], totalSamples: number): number;
export async function probe(prompt: string, contextSystem: string): Promise<ProbeResult>;
```

### Sample generation (Haiku, 5 calls in parallel)

System prompt (cached):
> "You decide which tool tag to emit for this user request. Output ONLY a JSON object: `{tool: '<TAG_NAME>', args: {<key>: <value>, ...}}`. Valid TAG_NAMEs: SEND, DRAFT, CAL_ADD, GHL_NOTE, GHL_TASK, GHL_TAG, GHL_WORKFLOW, WP_POST, WP_UPDATE, PLANNER_TASK, REMEMBER, TODO. Pick one; do not narrate."

User: the original prompt + a minimal context. 5 parallel `callHaiku` calls. Temperature is determined by the CLI defaults; the variance comes from sampling, not from explicit temp control (CLI exposes none).

### Clustering (Haiku-judge)

Pairwise comparison would be N² calls; we use a single batched judge call instead:

> "Below are 5 tool-choice samples. Cluster them by semantic equivalence (same tool + same effective args). Output JSON: `[{cluster_id: 0, members: [0,2]}, {cluster_id: 1, members: [1,3,4]}]`."

Cluster representative = first member by index.

### Entropy computation

```typescript
function entropyOf(clusters: Cluster[], total: number): number {
  let H = 0;
  for (const c of clusters) {
    const p = c.members.length / total;
    if (p > 0) H -= p * Math.log(p);
  }
  return H;  // 0 nats = unanimous; ln(5) ≈ 1.609 = max for k=5
}
```

### Recommendation logic

- `entropy <= 0.2` and 1 cluster ≥ 4 members → `dispatch_consensus`; return the dominant tool.
- `entropy <= ENTROPY_THRESHOLD (default 0.8)` and 1 cluster ≥ 3 members → `dispatch_consensus` with a logged warning.
- `entropy > ENTROPY_THRESHOLD` → `clarify`; instead of dispatching, return a short clarifying question to the user. Insert a `tool_entropy_probes` row with `action='clarified'`.
- Special case: if any sample picks a *destructive* tool (SEND, GHL_WORKFLOW, CAL_REMOVE) and another picks a *non-destructive* alternative (DRAFT, CAL_ADD without invite) → always force `clarify` regardless of entropy. Asymmetric cost.

### Tool-gate integration

`src/tool-gate.ts` exposes `checkAction(action)`. New companion function:

```typescript
export async function checkActionWithEntropy(
  action: Action,
  opts: { ambiguous: boolean; userPrompt?: string }
): Promise<GateResult & { entropy?: ProbeResult }>;
```

When `opts.ambiguous` is true (set by relay.ts when it sees ≥2 candidate tags from the same turn), the gate calls `probe` first; if recommendation is `clarify`, the gate returns `{allowed: false, reason: 'entropy: clarify required'}`. Relay turns this into a clarifying question to the user.

### `/entropy review` command

Lists last 10 probes with `action='manual_review'` or `'clarified'`. Inline buttons:
- `[✓ Dispatch top cluster]` — dispatches the representative tool now.
- `[✗ Cancel]` — drops the probe entry.

### Tests

- Unit: entropy math (1 cluster → 0; 5 singletons → ln(5)); destructive-asymmetry override; clustering parse.
- Integration: synthetic 5-sample fixture with known clusters → entropy matches manual calc to 3 decimals.

---

## §3. Signed Memory Entries

### Design

Per-session ed25519 keypair. Private key kept in process memory (never written to disk in current process; on restart, a new keypair generates and a new session-key row writes). Public key registered to Supabase `session_keys` with a ledger anchor. Every memory row signed with the session private key over a canonical hash of `(id, content, embedding_hash, created_at, agent, user_id, class)`. Signature stored alongside in a new `memory.signature` column + the `session_keys.session_id` foreign key.

**Why per-session, not global?** Compromise of a single session's signing key only forges memories from that session forward — past sessions remain verifiable under their own keys. The chain-of-custody is: session-key registration is itself a ledger entry, so to forge memories you'd need to forge a ledger entry, which requires the global key, which is held outside this process by Sprint 1's design.

**Why not just hash?** A hash chain lets anyone replay the chain; a signature lets only the holder of the private key write valid entries. With a session-scoped private key, an attacker who steals a memory-snapshot file can't append valid forged rows.

### Schema

```sql
-- db/migrations/062_session_keys.sql
CREATE TABLE IF NOT EXISTS session_keys (
  session_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  public_key_pem    TEXT NOT NULL,
  agent             TEXT NOT NULL CHECK (agent IN ('atlas','ishtar')),
  process_pid       INT,                       -- best-effort, for debugging only
  process_hostname  TEXT,
  ledger_entry_id   TEXT NOT NULL,             -- anchored to atlas-ledger.jsonl
  synced_to_shadow_at TIMESTAMPTZ,             -- updated when shadow re-syncs
  retired_at        TIMESTAMPTZ                -- set on graceful shutdown
);

-- db/migrations/063_memory_signature.sql
ALTER TABLE memory ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES session_keys(session_id);
ALTER TABLE memory ADD COLUMN IF NOT EXISTS signature TEXT;       -- hex ed25519 sig
ALTER TABLE memory ADD COLUMN IF NOT EXISTS sig_payload_hash TEXT; -- hex sha256 of canonical payload

CREATE TABLE IF NOT EXISTS memory_verification_failures (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  memory_id     UUID NOT NULL,
  session_id    UUID,
  reason        TEXT NOT NULL,
  payload_hash  TEXT,
  expected_sig  TEXT,
  observed_sig  TEXT
);
CREATE INDEX IF NOT EXISTS idx_mvf_ts ON memory_verification_failures(ts DESC);
```

### Module: `src/memory-signing.ts`

```typescript
export interface SessionKeyHandle {
  session_id: string;
  publicKeyPem: string;
  sign(payloadHash: Buffer): Buffer;        // returns ed25519 signature
}

export async function generateSessionKey(supabase: any, agent: 'atlas'|'ishtar'): Promise<SessionKeyHandle>;
export async function getCurrentSessionKey(): SessionKeyHandle;       // in-process singleton
export async function retireSessionKey(supabase: any): Promise<void>; // graceful shutdown

export function canonicalMemoryPayload(row: {
  id: string;
  content: string;
  embedding?: number[] | null;
  created_at: string;
  agent: string;
  user_id: string;
  class: string;
}): { hashHex: string; payload: Buffer };

export async function signMemoryRow(row: any): Promise<{ signature: string; sig_payload_hash: string; session_id: string }>;
export async function verifyMemoryRow(supabase: any, row: any): Promise<{ valid: boolean; reason?: string }>;
```

**Embedding handling:** Embeddings are large; we don't sign the raw vector. Instead, the canonical payload includes `embedding_hash = sha256(JSON.stringify(roundedEmbedding))` if present, or `null` if not. Round each component to 6 decimal places for hash stability (embeddings sometimes return microscopic FP variance across SDK versions). The hash makes "modify the vector after-the-fact" detectable while keeping signature payload small.

### Sign-on-write hook

In `src/cortex.ts:insertMemory` (or whichever helper writes to the `memory` table), after row construction but before the `.insert(...)` call:
```typescript
const { signature, sig_payload_hash, session_id } = await signMemoryRow(row);
row.signature = signature;
row.sig_payload_hash = sig_payload_hash;
row.session_id = session_id;
```

### Verify-on-load hook

In the memory retrieval functions (the semantic search RPC, cortex demotion scanner, dream engine consolidation reader):
```typescript
for (const row of rows) {
  const v = await verifyMemoryRow(supabase, row);
  if (!v.valid) {
    await logMemoryVerificationFailure(supabase, row, v.reason);
    await sendTelegramAlert(`[MEMORY_VERIFY_FAIL] mem=${row.id} reason=${v.reason}`);
    continue;     // exclude this row from results
  }
}
```

**Pre-Sprint-7 backfill:** Memory rows that pre-date Sprint 7 lack a signature. Strategy: on first verify attempt, if `signature IS NULL` AND `created_at < <sprint7_landing_ts>`, log a once-per-row "legacy unsigned" entry to `memory_verification_failures` with `reason='legacy_pre_sprint7'`, but **allow** the row through (the alternative is breaking 4 sprints of accumulated memory). New rows from Sprint 7 onward MUST be signed. This is enforced by `signMemoryRow` failing loudly if the session-key handle is not initialized.

### Tests

- Unit: keypair generation; sign/verify round-trip; tamper detection (change content, expect failure); embedding rounding stability.
- Integration: insert a memory, retrieve it, verify passes. Manually corrupt the signature in DB, retrieve, expect exclusion + failure log row.

---

## §4. Weekly Knowledge Audit + Half-Life Recalibration

### Design

The Sprint 1 staleness sentinel encodes a half-life per fast/real-time domain. Those numbers are guesses. The weekly audit measures actual decay: pull recent Atlas answers in a domain, fetch the current authoritative source via WebFetch, ask Haiku how many of those answers are still correct, and propose a new half-life.

The output is a Telegram surface with proposed changes, gated on Derek approval (so a bad WebFetch doesn't auto-rewrite Atlas's staleness floor).

### Schema

```sql
-- db/migrations/064_knowledge_audit_log.sql
CREATE TABLE IF NOT EXISTS knowledge_audit_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  domain               TEXT NOT NULL,
  samples_examined     INT NOT NULL,
  samples_still_correct INT NOT NULL,
  drift_score          REAL NOT NULL,                -- 1 - (correct/examined)
  current_half_life    INT NOT NULL,
  proposed_half_life   INT NOT NULL,
  rationale            TEXT NOT NULL,
  decision             TEXT NOT NULL CHECK (decision IN ('proposed','applied','rejected','overridden')),
  decided_by           TEXT,
  decided_at           TIMESTAMPTZ,
  override_value       INT
);
CREATE INDEX IF NOT EXISTS idx_audit_domain ON knowledge_audit_log(domain, audit_at DESC);
```

### Module: `src/knowledge-audit.ts`

```typescript
export interface AuditResult {
  domain: string;
  samples_examined: number;
  samples_still_correct: number;
  drift_score: number;
  current_half_life: number;
  proposed_half_life: number;
  rationale: string;
}

export async function auditDomain(opts: {
  domain: string;
  spec: HotDomain;       // from staleness-sentinel
  sampleSize?: number;
}): Promise<AuditResult>;

export async function runWeeklyAudit(supabase: any): Promise<AuditResult[]>;

export async function applyHalfLifeUpdate(opts: {
  domain: string;
  newHalfLife: number;
  decidedBy: string;
}): Promise<void>;
```

### Per-domain audit flow

1. Pull recent Atlas turns (last 7 days) whose staleness classification matched `domain`. Up to `KNOWLEDGE_AUDIT_SAMPLE_SIZE` (default 8). Source: `messages` table joined to staleness classification log (added in Sprint 1; if no log, fall back to domain-trigger string match on user messages).
2. For each sample, take Atlas's claim and the cited source (if present).
3. WebFetch the authoritative source for that domain (`hot-domains.json[domain].authoritative_sources[0]`) with a prompt: *"Given this current vendor documentation, is the following claim still correct? Yes/No + 1-sentence reason."*
4. Compute `drift_score = 1 - (correct / examined)`.
5. Compute proposed half-life: bayesian half-decay model — if observed drift over 7 days = D, then `proposed_half_life = ceil(-7 / log2(1-D))` clipped to [1, current_half_life * 1.5]. The clip prevents pathological growth from one good week or collapse from one bad fetch.

### Surface to Derek (Saturday 9 AM)

After all domains audit, build a single Telegram message:

```
📚 **Weekly Knowledge Audit — 2026-05-23**

8 domains examined.

🔻 **GoHighLevel** — drift 50% (4/8 stale)
  current: 30 days · proposed: 14 days
  Rationale: GHL shipped 3 UI changes this week including the new Intent node.

🔻 **Meta Ads** — drift 25% (2/8 stale)
  current: 45 days · proposed: 32 days
  Rationale: Advantage+ creative API endpoint deprecation effective today.

✓ **WordPress** — drift 0% (0/4 stale, small sample)
  current: 90 days · proposed: 90 days (unchanged)

Apply all? [✓ Apply] [Edit] [Skip]
```

The `[✓ Apply]` button emits `[AUDIT_APPLY:]` tags which `applyHalfLifeUpdate` consumes, writing the new value to `hot-domains.json` (via tracked file write + ledger entry tagged `actor='atlas', action.tool='hot_domains_update'`).

### Cron: `knowledge-audit-weekly` Saturday 9:00 PHX

```typescript
// 0 9 * * 6   (Saturday at 9 AM Phoenix time)
```

### Tests

- Unit: drift→half-life math; clipping behavior; bayesian formula stability at boundaries (D=0, D=1).
- Integration: mocked WebFetch returns canned vendor docs; audit produces expected proposal; apply writes hot-domains correctly.

---

## §5. Public Transparency Beacon

### Design

A separate **public** GitHub repo (`atlas-prime-beacon`) hosts hourly Merkle roots, a README explaining the protocol, and the standing bounty offer.

The publishing path is decoupled from the main Atlas process:
1. Atlas writes to `data/atlas-ledger-roots.jsonl` (already exists from Sprint 1's `publishRoot()`).
2. **Local export cron** (every hour) runs `scripts/beacon-export.ts` which:
   - Reads the last 24h of roots from the JSONL.
   - Writes a `roots/YYYY-MM-DD.jsonl` file in a local clone of `atlas-prime-beacon` at `data/beacon-repo/`.
   - Updates `roots/latest.json`.
   - Commits + pushes to the public repo with a deterministic message.
3. **Optional GitHub Actions cron** (also hourly, in the beacon repo itself) acts as the canonical publishing path if the local Atlas process is down. The workflow:
   - Pulls a private mirror via repository secret (a private repo `atlas-prime-beacon-source` that the local cron pushes ledger roots to).
   - Derives and commits the public files.
   - Ensures continuity even when Derek's machine is offline.

For Sprint 7 ship, **the local export cron is mandatory** (works without external setup); **the GitHub Actions workflow is provided as a .yml template** that Derek wires up after committing to the new repo.

### Why two paths?

The local cron gives immediate transparency; the GitHub Actions cron gives resilience. If Atlas dies, the actions cron keeps publishing what was last synced. If Actions has an outage, the local cron handles it. The two never disagree because both ultimately read the same signed root chain — if they diverged, it's itself detectable.

### Public repo layout (auto-populated)

```
atlas-prime-beacon/
├── README.md                  # Protocol explainer + bounty
├── BOUNTY.md                  # Terms, payout amount, how to claim
├── roots/
│   ├── latest.json            # { ts, root, entries, sig, day }
│   ├── 2026-05-14.jsonl       # one record per hour
│   ├── 2026-05-15.jsonl
│   └── ...
├── verify/
│   └── verify-beacon.ts       # standalone TypeScript verifier (no deps beyond Node)
└── .github/
    └── workflows/
        └── publish-from-mirror.yml
```

### README content (drafted in spec, written in plan)

The README explains:
- What this repo is (a public Merkle-root beacon for Atlas Prime's action ledger).
- The protocol: every action Atlas takes is signed and chained; hourly the latest root is published here.
- How to verify: clone, run `verify/verify-beacon.ts` against a local ledger snapshot Derek shares.
- The standing bounty: $500 (configurable via env) for the first verified report of (a) a root in this repo that does not match the locally-signed chain, OR (b) two consecutive published roots whose chain is inconsistent.

### Module: `scripts/beacon-export.ts`

```typescript
// Run by local cron (every hour) and by GitHub Actions (workflow template provided)
async function main() {
  // 1. Read data/atlas-ledger-roots.jsonl
  // 2. Group by UTC day
  // 3. For each day, write data/beacon-repo/roots/YYYY-MM-DD.jsonl (overwrite — idempotent)
  // 4. Write data/beacon-repo/roots/latest.json
  // 5. cd data/beacon-repo && git add . && git commit -m "beacon update <ISO>" && git push origin main
  //    (only if git diff --stat is non-empty; idempotent re-runs are no-ops)
}
```

The script signs its commit using a separate publisher key (`data/beacon-publisher.key`, ed25519, auto-generated on first run, public half embedded in BOUNTY.md). This means a malicious actor with write access to the beacon repo cannot quietly forge published roots — every commit's signature must verify against the published publisher pubkey.

### Module: `scripts/verify-beacon.ts`

```typescript
// Pulls latest.json + a local ledger snapshot. Walks the chain, verifies
// every signature, asserts the chain root equals the published root.
// Exit 0 = match. Exit 1 = mismatch. Exit 2 = setup error.
```

Derek can run this any time. The same script is what a bounty-claimant runs against the public files.

### Cron: `beacon-roots-export` every hour

```typescript
// '0 * * * *'  — top of every hour
```

### GitHub Actions workflow template

`.github/workflows/publish-beacon.yml` (committed to `atlas-prime-beacon-source` private mirror, *not* the main Atlas repo):

```yaml
name: publish-beacon-hourly
on:
  schedule:
    - cron: '15 * * * *'      # 15 min past the hour (after local-cron publishes)
  workflow_dispatch: {}
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: ${{ secrets.BEACON_SOURCE_REPO }}
          token: ${{ secrets.BEACON_PAT }}
      - uses: oven-sh/setup-bun@v1
      - run: bun scripts/beacon-export.ts --mode=mirror
      - run: |
          cd data/beacon-repo
          git remote set-url origin https://x-access-token:${{ secrets.BEACON_PAT }}@github.com/${{ secrets.BEACON_PUBLIC_REPO }}.git
          git push origin main
```

The mirror approach keeps the main Atlas source private while still allowing public-side automation.

### `/beacon` command

```
/beacon status                  # last published root + age + integrity check
/beacon verify                  # run scripts/verify-beacon.ts inline
/beacon bounty                  # echo the bounty terms + claim instructions
```

### Tests

- Unit: ledger-root-to-beacon-file round trip; idempotent re-export; chain-walk verification.
- Integration: tamper a local ledger row, run verify, expect exit code 1.
- Spec test: workflow YAML round-trips through `js-yaml` (catches accidental syntax breakage).

---

## Cron registration (3 new jobs)

| Cron | Time | Module | Purpose |
|---|---|---|---|
| `knowledge-audit-weekly` | Sat 9:00 PHX | `src/knowledge-audit.ts` | Audit hot domains, propose half-life updates |
| `shadow-process-watchdog` | every 5 min | `src/shadow-driver.ts` | Probe shadow IPC, auto-restart on failure |
| `beacon-roots-export` | every hour, top of hour | `scripts/beacon-export.ts` | Publish latest root to local beacon-repo clone + push |

Cron numbering picks up at 38 (Sprint 6 went through 37).

---

## File touch summary

**Created (modules — 5):**
- `src/shadow-atlas.ts` — cold-context shadow process entrypoint
- `src/shadow-driver.ts` — main-process IPC client + drift scorer + freeze flag
- `src/entropy-probe.ts` — sample + cluster + entropy + recommendation
- `src/memory-signing.ts` — session keypair + sign-on-write + verify-on-load
- `src/knowledge-audit.ts` — weekly half-life recalibration

**Created (scripts — 2):**
- `scripts/beacon-export.ts` — local + Actions-runnable publisher
- `scripts/verify-beacon.ts` — standalone verifier (callable by Derek or claimants)

**Created (migrations — 5):**
- `060_shadow_divergence_log.sql`
- `061_tool_entropy_probes.sql`
- `062_session_keys.sql`
- `063_memory_signature.sql`
- `064_knowledge_audit_log.sql`

**Created (tests — 5):**
- `tests/sprint7/shadow-driver.test.ts`
- `tests/sprint7/entropy-probe.test.ts`
- `tests/sprint7/memory-signing.test.ts`
- `tests/sprint7/knowledge-audit.test.ts`
- `tests/sprint7/beacon-export.test.ts`

**Created (templates — 1):**
- `templates/atlas-prime-beacon/README.md` + `BOUNTY.md` + `verify/verify-beacon.ts` + `.github/workflows/publish-beacon.yml` (committed to atlas repo; copied into beacon-repo on first bootstrap)

**Modified:**
- `src/relay.ts` — 4 new commands (`/shadow`, `/entropy`, `/audit`, `/beacon`); freeze-flag external-action gate; entropy-probe call before dispatch on ambiguous turns; shadow-fire hook on every prompt
- `src/cron.ts` — 3 new crons
- `src/tool-gate.ts` — `checkActionWithEntropy` companion function
- `src/cortex.ts` — `signMemoryRow` on insert; `verifyMemoryRow` on load + failure log
- `src/capability-registry.ts` — 5 new entries
- `.env.example` — new env vars

**Excluded from any modification (DGM exclusion list + Sprint 7 lock):**
- `atlas.spec`
- `data/atlas-ledger/*`
- `db/migrations/` (existing migrations; new ones add only)
- `src/ledger.ts`
- `src/tool-gate.ts` core check logic (we add a companion function, never alter `checkAction`)
- `src/claude.ts`
- `src/haiku-client.ts`

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Shadow-Atlas false positives spam the freeze flag and disrupt normal work | Three-tier threshold (benign / explained / suspicious / alarm). `'suspicious'` does NOT freeze — only logs. `'alarm'` requires distance ≥ 0.45 AND zero memory writes in window. Telegram alert always precedes freeze, so Derek can `/shadow resume` immediately on a known false-positive. |
| Shadow-Atlas process dies and we lose monitoring without noticing | `shadow-process-watchdog` cron checks IPC every 5 min; auto-restart 3x; persistent Telegram alert if down ≥ 15 min. Primary continues to work. |
| Entropy probe doubles latency on every turn | Probe only fires when relay sees ≥2 candidate tags in the same turn — rare. For unambiguous single-tool turns, no extra calls. When it does fire, 5 Haiku calls in parallel ≈ 4 s wall-time. |
| Memory signature verify slows retrieval to a crawl | ed25519 verify is ~0.05 ms/row. Even 1000-row retrievals add ~50 ms total. Pre-Sprint-7 legacy rows skip verify with a once-per-row log. |
| Session key compromise → forged memories | Forgery is limited to the session window. Verification on load means a forged row inserted while the session was alive still has to match the *session-key's* signature, which an external attacker doesn't have. A compromised process is a worse problem (everything is at risk) — Sprint 7's contribution is making memory the *hardest* surface to forge silently, not impossible. |
| Knowledge audit relies on WebFetch quality; an outdated cited source poisons the loop | The audit's output is a *proposal*, not an auto-apply. Derek's approval surface is the gate. Audit log table preserves every proposal, decision, and overrride for retrospective analysis. |
| Beacon publishing fails (rate limit, GitHub outage, missing token) | Local cron logs failure and re-tries next hour. Roots accumulate in `data/atlas-ledger-roots.jsonl` regardless; nothing is lost. The standing bounty offer remains valid against the most recently published root — gaps are documented in the README. |
| Bounty creates incentive for false claims | Verification is automated by `scripts/verify-beacon.ts`. False claims trivially rejected. Real claims must produce reproducible evidence — the script's exit code + the published root + a local ledger snapshot. Derek's discretion on payout for ambiguous cases. |
| Backfill of unsigned memory rows masks real future tampering | Legacy rows log "legacy_pre_sprint7" to `memory_verification_failures` once each; this is bounded and noisy enough to not hide real failures, which carry different `reason` strings. |

---

## What Sprint 7 explicitly does NOT do

- **Live consensus voting between Atlas and Shadow.** Shadow is read-only monitor, not co-decider. Two-of-two agreement would create a single point of failure for legitimate disagreement.
- **Cryptographic re-encryption of pre-Sprint-7 memories.** Backfill is out of scope; legacy rows are flagged but allowed. Re-signing them would require Sprint 1's global key and an audit-trail surge we're not budgeting.
- **Replacing the ledger's signing key with the session key.** The ledger remains globally signed (Sprint 1); session keys sign *memory rows*. The two surfaces compose; they don't merge.
- **External audit-firm onboarding.** The bounty is open, but no formal SOC2/ISO process is initiated. That's a business decision, not a code one.
- **Tool-call entropy probing on already-clear single-tool turns.** Most turns are unambiguous; the probe only runs when the model proposed equivalent alternatives.
- **Automatic half-life updates without Derek approval.** Every audit proposal is gated behind a Telegram approval.
- **Shadow-Atlas full-MCP access.** Shadow operates with `--allowedTools ""` — text-only. It never executes external tools. This is intentional.

---

## Self-review

- **Spec coverage:** All 5 ATLAS-PRIME Sprint 7 primitives covered. 9 ship criteria each map to specific schema/module/test.
- **Placeholder scan:** None. Every schema, function signature, prompt, threshold, and env var is concrete. Beacon repo name `atlas-prime-beacon` recommended; substitutable via `BEACON_PUBLIC_REPO` env var.
- **Internal consistency:** Sprint 1's `atlas-ledger-roots.jsonl` is the input to beacon-export; Sprint 1's `hot-domains.json` is mutated by the knowledge-audit; Sprint 3's `memory` table is the surface for signing; Sprint 6's `/why` introspection benefits from signed memory (citations get a verifiability badge — minor follow-up wiring described in the plan).
- **Scope check:** 5 modules + 2 scripts + 5 migrations + 1 workflow template. Sprint 6 was 5 modules + 2 scripts + 6 migrations (close match). Implementation tasks expected: ~13-15.
- **Ambiguity check:** Two implementation choices flagged for runtime resolution: (a) IPC transport on Windows (named pipe via `net.createServer('\\\\.\\pipe\\shadow-atlas')`) — confirm Bun's `net` parity; if not, fall back to TCP loopback on a randomized port written to `data/shadow-atlas/port`. (b) Beacon repo name — recommend `atlas-prime-beacon`. Both surfaced as open items in the final summary.

---

## Cost projection

- Shadow-Atlas: 1 sonnet CLI call per primary turn × ~150 turns/day × $0.003/call = **$13.50/month**. The bigger driver. If too high, drop to haiku-only ($0.30/call ≈ $1.35/month) at the cost of some semantic-discrimination accuracy.
- Drift scorer Haiku: 1 call per primary turn × 150/day × $0.0003 = **$1.35/month**.
- Entropy probe: ~5 ambiguous turns/day × 6 Haiku calls (5 samples + 1 cluster judge) × $0.0003 = **$0.27/month**.
- Knowledge audit: 8 domains × 10 WebFetch + Haiku each = 80 ops/week × $0.001 ≈ **$0.32/month**.
- Memory signing: $0 (local crypto).
- Beacon publish: $0 (GitHub free tier).
- **Total new spend: ~$15.50/month.** With shadow-Atlas optionally downgraded to haiku, ~$3/month. Default ships with sonnet shadow; Derek can flip via env var.

---

## Decision log

- **All 5 primitives ship in one sprint** (matches the ATLAS-PRIME Sprint 7 listing and Sprints 4-6 cadence calibration).
- **Shadow-Atlas runs as a separate Bun process** (the ATLAS-PRIME spec literally says "a second Atlas instance" — in-process re-run would not be a second instance).
- **IPC via UNIX socket on POSIX, named pipe on Windows.** Avoids network attack surface vs. TCP loopback.
- **Sync cadence 4 hours.** Catches slow drift; long enough that memory writes that pre-date the attack do propagate to shadow on the next sync.
- **Public beacon repo name: `atlas-prime-beacon`.** Default; Derek can override via `BEACON_PUBLIC_REPO` env var.
- **Bounty default $500.** Standing offer in README; Derek funds + adjudicates.
- **Memory signing: ed25519 per-session.** Per-session (not per-action) keys keep signing fast; rotation on restart limits blast radius of process compromise.
- **Knowledge audit Saturday 9 AM Phoenix.** Derek's lowest-friction review slot per his calendar patterns.
- **Half-life update gated on Derek approval.** Audit proposes; Derek applies. Default ship behavior; tunable later.
- **Entropy probe k=5 samples, threshold 0.8 nats.** Matches semantic-entropy literature (Kuhn 2023, Farquhar 2024) for short structured-output tasks.
- **Destructive-tool asymmetry override.** If a probe sees any SEND/GHL_WORKFLOW/CAL_REMOVE among the 5 samples and any non-destructive alternative, clarify regardless of entropy. The asymmetric cost of false-action mandates extra caution.
- **All model calls via Claude CLI subprocess (`callClaude` / `callHaiku`).** No `@anthropic-ai/sdk` imports in Sprint 7 modules. Ship verification includes a grep.
- **Cron numbering: 38, 39, 40.** Continuing the Sprint 6 sequence.
- **Migration numbering: 060–064.** Sprint 6 ended at 059.
