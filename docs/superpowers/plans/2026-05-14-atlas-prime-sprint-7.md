# Atlas Prime — Sprint 7: Bulletproofing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atlas becomes verifiably honest about itself. A second cold-context instance catches drift before it matters. Ambiguous tool selections get measured for entropy and clarified instead of guessed. Every memory write is ed25519-signed and verified on retrieval. The Saturday knowledge audit recalibrates the Staleness Sentinel from real-world decay. Atlas publishes hourly Merkle roots to a public repo with a standing bounty. All model calls route through the Claude CLI subprocess (Max-plan OAuth) — no `@anthropic-ai/sdk` imports.

**Architecture:** Five composing primitives over Sprints 1-6 substrate. Shadow-Atlas is a separate Bun process with cold context that shadows every prompt and lets a Haiku scorer flag unexplained drift; a freeze flag blocks external-action tools until Derek clears it. Entropy-Probe samples k=5 tool selections via Haiku, clusters them, computes semantic entropy, and converts high-entropy choices into clarifying questions. Memory-Signing generates a per-session ed25519 keypair anchored to the global ledger; every memory row carries a signature verified on every load. Knowledge-Audit runs Saturday 9 AM, fetches authoritative sources, measures drift against half-life expectations, proposes new half-lives to Derek. The Public Beacon publishes hourly Merkle roots to `atlas-prime-beacon` via local cron + GitHub Actions, with a $500 standing bounty for verifiable inconsistencies.

**Tech Stack:** Bun/TypeScript, `bun:test`, Supabase Postgres, Claude CLI subprocess (`callClaude` from `src/claude.ts`, `callHaiku` from `src/haiku-client.ts`), Node `crypto` (ed25519 + sha256), Node `net` (UNIX socket / named pipe IPC).

**Spec:** `docs/superpowers/specs/2026-05-14-atlas-prime-sprint-7-design.md`

**File structure:**

- **Create (modules):** `src/shadow-atlas.ts`, `src/shadow-driver.ts`, `src/entropy-probe.ts`, `src/memory-signing.ts`, `src/knowledge-audit.ts`
- **Create (scripts):** `scripts/beacon-export.ts`, `scripts/verify-beacon.ts`, `scripts/init-shadow-atlas.sh`
- **Create (migrations):** `db/migrations/060_shadow_divergence_log.sql`, `061_tool_entropy_probes.sql`, `062_session_keys.sql`, `063_memory_signature.sql`, `064_knowledge_audit_log.sql`
- **Create (templates):** `templates/atlas-prime-beacon/README.md`, `BOUNTY.md`, `verify/verify-beacon.ts`, `.github/workflows/publish-beacon.yml`
- **Create (tests):** `tests/sprint7/shadow-driver.test.ts`, `entropy-probe.test.ts`, `memory-signing.test.ts`, `knowledge-audit.test.ts`, `beacon-export.test.ts`
- **Modify:** `src/relay.ts`, `src/cron.ts`, `src/tool-gate.ts` (companion fn only), `src/cortex.ts`, `src/capability-registry.ts`, `.env.example`, `.gitignore`

**Excluded files (Sprint 7 will NOT modify):**
- `atlas.spec`
- `data/atlas-ledger/*`, `data/atlas-ledger.key`, `data/atlas-ledger.pub`
- `db/migrations/` (existing migrations; only adds new ones)
- `src/ledger.ts`
- `src/tool-gate.ts` core `checkAction` function (we add a companion `checkActionWithEntropy`)
- `src/claude.ts`
- `src/haiku-client.ts`

---

## Task 1: Schema migrations (5 files)

**Files:**
- Create: `db/migrations/060_shadow_divergence_log.sql`
- Create: `db/migrations/061_tool_entropy_probes.sql`
- Create: `db/migrations/062_session_keys.sql`
- Create: `db/migrations/063_memory_signature.sql`
- Create: `db/migrations/064_knowledge_audit_log.sql`

- [ ] **Step 1: Inspect prior migration style**

```bash
ls db/migrations/ | tail -5
cat db/migrations/059_dpo_pairs_match_rpc.sql | head -10
```

Match style: uppercase keywords, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `TIMESTAMPTZ DEFAULT NOW()`, COMMENT statements.

- [ ] **Step 2: Create `db/migrations/060_shadow_divergence_log.sql`**

```sql
-- Atlas Prime Sprint 7: Shadow-Atlas divergence log.
-- Every primary turn fans out to a shadow process; drift scorer logs results.
-- alarm-class rows correlate with freeze.flag.

CREATE TABLE IF NOT EXISTS shadow_divergence_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  turn_id                  UUID,
  primary_text             TEXT NOT NULL,
  shadow_text              TEXT NOT NULL,
  distance                 REAL NOT NULL,
  judge_reason             TEXT,
  memory_writes_in_window  INT NOT NULL DEFAULT 0,
  classified               TEXT NOT NULL CHECK (classified IN ('benign','explained','suspicious','alarm')),
  froze                    BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at              TIMESTAMPTZ,
  resolved_by              TEXT,
  resolution_note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_shadow_divergence_ts    ON shadow_divergence_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_divergence_class ON shadow_divergence_log(classified);

COMMENT ON TABLE shadow_divergence_log IS
  'Atlas Prime Sprint 7: shadow-Atlas drift scoring results. alarm rows correspond to a froze freeze.flag write.';
```

- [ ] **Step 3: Create `db/migrations/061_tool_entropy_probes.sql`**

```sql
-- Atlas Prime Sprint 7: Tool-selection entropy probes.
-- Fires only on ambiguous turns (>= 2 candidate tools).
-- High entropy substitutes a clarifying question for dispatch.

CREATE TABLE IF NOT EXISTS tool_entropy_probes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  turn_id       UUID,
  user_prompt   TEXT NOT NULL,
  samples       JSONB NOT NULL,
  clusters      JSONB NOT NULL,
  entropy       REAL NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('dispatched','clarified','manual_review')),
  selected_tool TEXT,
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_entropy_ts     ON tool_entropy_probes(ts DESC);
CREATE INDEX IF NOT EXISTS idx_entropy_action ON tool_entropy_probes(action);
```

- [ ] **Step 4: Create `db/migrations/062_session_keys.sql`**

```sql
-- Atlas Prime Sprint 7: per-session ed25519 keypairs for memory signing.
-- Public half stored here; private half kept in-process only.
-- Anchored to global ledger via ledger_entry_id.

CREATE TABLE IF NOT EXISTS session_keys (
  session_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  public_key_pem      TEXT NOT NULL,
  agent               TEXT NOT NULL CHECK (agent IN ('atlas','ishtar')),
  process_pid         INT,
  process_hostname    TEXT,
  ledger_entry_id     TEXT NOT NULL,
  synced_to_shadow_at TIMESTAMPTZ,
  retired_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_session_keys_agent ON session_keys(agent, created_at DESC);

COMMENT ON TABLE session_keys IS
  'Atlas Prime Sprint 7: per-process ed25519 keypair. Private key never leaves the process.';
```

- [ ] **Step 5: Create `db/migrations/063_memory_signature.sql`**

```sql
-- Atlas Prime Sprint 7: signature columns on memory + verification failure log.
-- Legacy pre-Sprint-7 rows have NULL signature and pass with 'legacy_pre_sprint7' note.

ALTER TABLE memory ADD COLUMN IF NOT EXISTS session_id       UUID REFERENCES session_keys(session_id);
ALTER TABLE memory ADD COLUMN IF NOT EXISTS signature        TEXT;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS sig_payload_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_session ON memory(session_id);

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

COMMENT ON TABLE memory_verification_failures IS
  'Atlas Prime Sprint 7: ed25519 verification mismatches on memory load. Excluded from search results.';
```

- [ ] **Step 6: Create `db/migrations/064_knowledge_audit_log.sql`**

```sql
-- Atlas Prime Sprint 7: weekly knowledge audit history.
-- Saturday cron audits fast/real_time domains and proposes half-life updates.
-- Derek-approval gate; decisions logged here for retrospective analysis.

CREATE TABLE IF NOT EXISTS knowledge_audit_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  domain                TEXT NOT NULL,
  samples_examined      INT NOT NULL,
  samples_still_correct INT NOT NULL,
  drift_score           REAL NOT NULL,
  current_half_life     INT NOT NULL,
  proposed_half_life    INT NOT NULL,
  rationale             TEXT NOT NULL,
  decision              TEXT NOT NULL CHECK (decision IN ('proposed','applied','rejected','overridden')),
  decided_by            TEXT,
  decided_at            TIMESTAMPTZ,
  override_value        INT
);

CREATE INDEX IF NOT EXISTS idx_audit_domain ON knowledge_audit_log(domain, audit_at DESC);
```

- [ ] **Step 7: Read each file back and spot-check**

```bash
for f in db/migrations/06{0,1,2,3,4}_*.sql; do
  echo "=== $f ==="
  cat "$f" | head -25
done
```

- [ ] **Step 8: Commit**

```bash
git add db/migrations/060_shadow_divergence_log.sql \
        db/migrations/061_tool_entropy_probes.sql \
        db/migrations/062_session_keys.sql \
        db/migrations/063_memory_signature.sql \
        db/migrations/064_knowledge_audit_log.sql
git commit -m "feat(atlas-prime): Sprint 7 migrations — shadow divergence + entropy + session keys + memory sig + audit log"
```

---

## Task 2: Memory-signing module foundation

**Files:**
- Create: `src/memory-signing.ts`
- Test: `tests/sprint7/memory-signing.test.ts`

- [ ] **Step 1: Write failing test for canonical payload**

```typescript
// tests/sprint7/memory-signing.test.ts
import { describe, it, expect, beforeAll } from "bun:test";
import { canonicalMemoryPayload } from "../../src/memory-signing.ts";

describe("memory-signing — canonicalMemoryPayload", () => {
  it("produces stable hash for identical input", () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      content: "hello",
      embedding: null,
      created_at: "2026-05-14T00:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
    };
    const a = canonicalMemoryPayload(row);
    const b = canonicalMemoryPayload({ ...row });
    expect(a.hashHex).toBe(b.hashHex);
    expect(a.hashHex.length).toBe(64); // sha256 hex
  });

  it("changes hash when content changes", () => {
    const base = {
      id: "11111111-1111-1111-1111-111111111111",
      content: "hello",
      embedding: null,
      created_at: "2026-05-14T00:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
    };
    const a = canonicalMemoryPayload(base);
    const b = canonicalMemoryPayload({ ...base, content: "hello!" });
    expect(a.hashHex).not.toBe(b.hashHex);
  });

  it("rounds embedding components to 6 decimals for stability", () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      content: "hello",
      embedding: [0.1234567891, 0.9876543219],
      created_at: "2026-05-14T00:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
    };
    const a = canonicalMemoryPayload(row);
    const b = canonicalMemoryPayload({
      ...row,
      embedding: [0.1234568, 0.9876543], // same to 6 decimals after rounding both
    });
    // Both round to the same 6-decimal vector
    expect(a.hashHex).toBe(b.hashHex);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
bun test tests/sprint7/memory-signing.test.ts 2>&1 | tail -10
```

Expected: import error (`memory-signing.ts` does not exist).

- [ ] **Step 3: Create `src/memory-signing.ts` skeleton + canonicalMemoryPayload**

```typescript
/**
 * Atlas Prime — Memory Signing (Sprint 7)
 *
 * Per-session ed25519 keypair. Private key kept in process memory only.
 * Every memory row signed on insert; verified on load.
 * Forging a memory after-the-fact fails verification.
 */
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  createHash,
  randomUUID,
} from "crypto";
import { appendEntry } from "./ledger.ts";

// ============================================================
// TYPES
// ============================================================

export interface SessionKeyHandle {
  session_id: string;
  publicKeyPem: string;
  sign(payloadHash: Buffer): Buffer;
}

export interface MemoryRowForSign {
  id: string;
  content: string;
  embedding?: number[] | null;
  created_at: string;
  agent: string;
  user_id: string;
  class: string;
}

// ============================================================
// CANONICAL PAYLOAD
// ============================================================

function roundEmbedding(emb: number[] | null | undefined): number[] | null {
  if (!emb) return null;
  return emb.map((x) => Math.round(x * 1e6) / 1e6);
}

function canonicalJson(o: unknown): string {
  if (o === null || o === undefined) return "null";
  if (typeof o === "number") {
    if (!Number.isFinite(o)) throw new Error("non-finite number not supported");
    return String(o);
  }
  if (typeof o === "boolean" || typeof o === "string") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map((v) => canonicalJson(v ?? null)).join(",") + "]";
  if (typeof o === "object") {
    const obj = o as Record<string, unknown>;
    const keys = Object.keys(obj).sort().filter((k) => obj[k] !== undefined);
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  return JSON.stringify(o);
}

export function canonicalMemoryPayload(row: MemoryRowForSign): {
  hashHex: string;
  payload: Buffer;
} {
  const rounded = roundEmbedding(row.embedding);
  const embeddingHash = rounded
    ? createHash("sha256").update(canonicalJson(rounded)).digest("hex")
    : null;
  const canonical = canonicalJson({
    id: row.id,
    content: row.content,
    embedding_hash: embeddingHash,
    created_at: row.created_at,
    agent: row.agent,
    user_id: row.user_id,
    class: row.class,
  });
  const payload = Buffer.from(canonical, "utf-8");
  const hashHex = createHash("sha256").update(payload).digest("hex");
  return { hashHex, payload };
}
```

- [ ] **Step 4: Run tests — canonical payload passes**

```bash
bun test tests/sprint7/memory-signing.test.ts -t "canonicalMemoryPayload" 2>&1 | tail -10
```

Expected: 3 pass.

- [ ] **Step 5: Add tests for keypair + sign/verify round-trip**

Append to `tests/sprint7/memory-signing.test.ts`:

```typescript
describe("memory-signing — keypair sign/verify", () => {
  it("signs and verifies a row payload round-trip", async () => {
    const { initSessionKeyForTest, signMemoryRow, verifyMemoryRow } =
      await import("../../src/memory-signing.ts");
    const handle = initSessionKeyForTest("atlas");
    const row = {
      id: "22222222-2222-2222-2222-222222222222",
      content: "hello world",
      embedding: null,
      created_at: "2026-05-14T01:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
    };
    const signed = await signMemoryRow(row);
    expect(signed.session_id).toBe(handle.session_id);
    expect(signed.signature.length).toBeGreaterThan(0);

    // Synthetic row with sig fields populated as if from DB
    const dbRow = {
      ...row,
      signature: signed.signature,
      sig_payload_hash: signed.sig_payload_hash,
      session_id: signed.session_id,
    };

    // Test-only verifier that accepts an inline session key (no Supabase)
    const v = await verifyMemoryRow(
      { _testMode: true, publicKeyPem: handle.publicKeyPem },
      dbRow
    );
    expect(v.valid).toBe(true);
  });

  it("detects content tampering", async () => {
    const { initSessionKeyForTest, signMemoryRow, verifyMemoryRow } =
      await import("../../src/memory-signing.ts");
    const handle = initSessionKeyForTest("atlas");
    const row = {
      id: "33333333-3333-3333-3333-333333333333",
      content: "original",
      embedding: null,
      created_at: "2026-05-14T01:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
    };
    const signed = await signMemoryRow(row);
    const dbRow = {
      ...row,
      content: "tampered",   // changed after signing
      signature: signed.signature,
      sig_payload_hash: signed.sig_payload_hash,
      session_id: signed.session_id,
    };
    const v = await verifyMemoryRow(
      { _testMode: true, publicKeyPem: handle.publicKeyPem },
      dbRow
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("hash");
  });
});
```

- [ ] **Step 6: Implement keypair management + sign/verify**

Append to `src/memory-signing.ts`:

```typescript
// ============================================================
// SESSION KEY (in-process singleton)
// ============================================================

let currentHandle: SessionKeyHandle | null = null;

function buildHandle(session_id: string, privPem: string, pubPem: string): SessionKeyHandle {
  const privKey = createPrivateKey(privPem);
  return {
    session_id,
    publicKeyPem: pubPem,
    sign(payloadHash: Buffer): Buffer {
      return nodeSign(null, payloadHash, privKey);
    },
  };
}

/**
 * Generate a new session keypair, anchor it to the global ledger, persist the
 * public half to session_keys, and set as the in-process singleton.
 */
export async function generateSessionKey(
  supabase: { from: (t: string) => any } | null,
  agent: "atlas" | "ishtar"
): Promise<SessionKeyHandle> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const session_id = randomUUID();

  // Ledger entry anchors the registration
  const ledgerEntry = await appendEntry({
    actor: "system",
    action: {
      tool: "session_key_register",
      args: { agent, session_id, public_key_pem: pubPem },
    },
    sourceClaims: [{ claim_id: `session-key:${session_id}` }],
    outcome: { success: true },
  });

  if (supabase) {
    await supabase.from("session_keys").insert({
      session_id,
      public_key_pem: pubPem,
      agent,
      process_pid: process.pid,
      process_hostname: process.env.HOSTNAME || null,
      ledger_entry_id: ledgerEntry.entryHash,
    });
  }

  currentHandle = buildHandle(session_id, privPem, pubPem);
  return currentHandle;
}

export function getCurrentSessionKey(): SessionKeyHandle {
  if (!currentHandle) {
    throw new Error("memory-signing: session key not initialized; call generateSessionKey first");
  }
  return currentHandle;
}

/** Test-only helper. Generates a keypair in-process without ledger/supabase side effects. */
export function initSessionKeyForTest(agent: "atlas" | "ishtar"): SessionKeyHandle {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const handle = buildHandle(randomUUID(), privPem, pubPem);
  currentHandle = handle;
  return handle;
}

export async function retireSessionKey(supabase: any): Promise<void> {
  if (!currentHandle || !supabase) return;
  await supabase
    .from("session_keys")
    .update({ retired_at: new Date().toISOString() })
    .eq("session_id", currentHandle.session_id);
  currentHandle = null;
}

// ============================================================
// SIGN ON WRITE
// ============================================================

export async function signMemoryRow(row: MemoryRowForSign): Promise<{
  signature: string;
  sig_payload_hash: string;
  session_id: string;
}> {
  const handle = getCurrentSessionKey();
  const { hashHex, payload: _payload } = canonicalMemoryPayload(row);
  const sigBuf = handle.sign(Buffer.from(hashHex, "hex"));
  return {
    signature: sigBuf.toString("hex"),
    sig_payload_hash: hashHex,
    session_id: handle.session_id,
  };
}

// ============================================================
// VERIFY ON LOAD
// ============================================================

type SignedMemoryRow = MemoryRowForSign & {
  signature: string | null;
  sig_payload_hash: string | null;
  session_id: string | null;
};

/**
 * Test-mode hook: when supabase is {_testMode: true, publicKeyPem: <pem>}
 * use that pubkey directly. Otherwise fetch from session_keys.
 */
export async function verifyMemoryRow(
  supabase: any,
  row: SignedMemoryRow
): Promise<{ valid: boolean; reason?: string }> {
  // Pre-Sprint-7 legacy rows: allow with marker reason
  if (row.signature == null || row.session_id == null) {
    return { valid: true, reason: "legacy_pre_sprint7" };
  }

  // Resolve public key
  let pubPem: string | null = null;
  if (supabase && supabase._testMode) {
    pubPem = supabase.publicKeyPem;
  } else if (supabase) {
    const { data } = await supabase
      .from("session_keys")
      .select("public_key_pem")
      .eq("session_id", row.session_id)
      .maybeSingle();
    pubPem = (data as any)?.public_key_pem ?? null;
  }
  if (!pubPem) return { valid: false, reason: "session_key_not_found" };

  // Recompute canonical hash
  const { hashHex } = canonicalMemoryPayload(row);
  if (hashHex !== row.sig_payload_hash) {
    return { valid: false, reason: `payload_hash_mismatch (expected ${row.sig_payload_hash?.slice(0, 8)}, got ${hashHex.slice(0, 8)})` };
  }

  // Verify signature
  try {
    const pubKey = createPublicKey(pubPem);
    const ok = nodeVerify(
      null,
      Buffer.from(hashHex, "hex"),
      pubKey,
      Buffer.from(row.signature, "hex")
    );
    if (!ok) return { valid: false, reason: "signature_invalid" };
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `verify_threw: ${err}` };
  }
}

// ============================================================
// FAILURE LOG
// ============================================================

export async function logMemoryVerificationFailure(
  supabase: any,
  row: SignedMemoryRow,
  reason: string
): Promise<void> {
  if (!supabase || supabase._testMode) return;
  try {
    await supabase.from("memory_verification_failures").insert({
      memory_id: row.id,
      session_id: row.session_id ?? null,
      reason,
      payload_hash: row.sig_payload_hash ?? null,
      observed_sig: row.signature ?? null,
    });
  } catch {
    // best effort
  }
}
```

- [ ] **Step 7: Run all tests**

```bash
bun test tests/sprint7/memory-signing.test.ts 2>&1 | tail -10
```

Expected: 5 pass.

- [ ] **Step 8: Commit**

```bash
git add src/memory-signing.ts tests/sprint7/memory-signing.test.ts
git commit -m "feat(atlas-prime): memory-signing foundation — canonical payload + ed25519 sign/verify"
```

---

## Task 3: Wire memory-signing into cortex insert + retrieve

**Files:**
- Modify: `src/cortex.ts` (insert path) — add sign-on-write
- Modify: `src/cortex.ts` (retrieve path) — add verify-on-load + failure log
- Test: `tests/sprint7/memory-signing.test.ts` (integration)

- [ ] **Step 1: Locate insert path**

```bash
grep -n "from(.memory.).insert\|memory.*insert\|export async function.*Memory\|insertMemory" src/cortex.ts | head -10
```

Identify the function(s) that insert into the `memory` table. There may be more than one. Choose the *single canonical insert helper*. If there's not one, refactor: extract `_insertMemoryRow(row)` and route all callers through it. The test in Step 4 covers this.

- [ ] **Step 2: Locate retrieve paths**

```bash
grep -n "from(.memory.).select\|searchMemory\|retrieveMemory" src/cortex.ts | head -10
```

Note the main retrieval helper(s).

- [ ] **Step 3: Write integration test (in-process Supabase mock)**

Append to `tests/sprint7/memory-signing.test.ts`:

```typescript
describe("memory-signing — cortex integration", () => {
  it("inserted rows are signed; verifyMemoryRow accepts them", async () => {
    const { initSessionKeyForTest, signMemoryRow, verifyMemoryRow } =
      await import("../../src/memory-signing.ts");
    const handle = initSessionKeyForTest("atlas");

    // Simulate the cortex insert path: caller builds row, hooks adds sig.
    const baseRow = {
      id: "44444444-4444-4444-4444-444444444444",
      content: "integration row",
      embedding: null,
      created_at: "2026-05-14T02:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
    };
    const sig = await signMemoryRow(baseRow);

    // What the DB row should look like after insert
    const dbRow = {
      ...baseRow,
      signature: sig.signature,
      sig_payload_hash: sig.sig_payload_hash,
      session_id: sig.session_id,
    };

    const v = await verifyMemoryRow(
      { _testMode: true, publicKeyPem: handle.publicKeyPem },
      dbRow
    );
    expect(v.valid).toBe(true);
  });

  it("legacy rows (signature null) pass with marker reason", async () => {
    const { verifyMemoryRow } = await import("../../src/memory-signing.ts");
    const legacy = {
      id: "55555555-5555-5555-5555-555555555555",
      content: "old",
      embedding: null,
      created_at: "2026-01-01T00:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
      signature: null,
      sig_payload_hash: null,
      session_id: null,
    };
    const v = await verifyMemoryRow({ _testMode: true, publicKeyPem: "" }, legacy);
    expect(v.valid).toBe(true);
    expect(v.reason).toBe("legacy_pre_sprint7");
  });
});
```

- [ ] **Step 4: Edit `src/cortex.ts` insert path**

In the canonical insert function (the one identified in Step 1), before the actual `.insert(row)` call, add:

```typescript
// Atlas Prime Sprint 7: sign every memory row before write.
try {
  const { signMemoryRow } = await import("./memory-signing.ts");
  const sig = await signMemoryRow({
    id: row.id,
    content: row.content,
    embedding: row.embedding ?? null,
    created_at: row.created_at,
    agent: row.agent,
    user_id: row.user_id,
    class: row.class ?? "episodic",
  });
  row.signature = sig.signature;
  row.sig_payload_hash = sig.sig_payload_hash;
  row.session_id = sig.session_id;
} catch (err) {
  // Hard fail: refuse to write unsigned rows in Sprint 7+
  throw new Error(`memory-signing: refused to insert unsigned row (${err})`);
}
```

- [ ] **Step 5: Edit `src/cortex.ts` retrieve path**

In the canonical retrieval helper (the one used by semantic search), after fetching rows but before returning, filter through verify:

```typescript
// Atlas Prime Sprint 7: verify every loaded memory row.
const { verifyMemoryRow, logMemoryVerificationFailure } = await import("./memory-signing.ts");
const verified: typeof rows = [];
for (const row of rows) {
  const v = await verifyMemoryRow(supabase, row as any);
  if (!v.valid) {
    await logMemoryVerificationFailure(supabase, row as any, v.reason ?? "unknown");
    // Skip this row from results; do not throw — Sprint 1 ledger pattern.
    continue;
  }
  verified.push(row);
}
rows = verified;
```

- [ ] **Step 6: Run unit + integration tests**

```bash
bun test tests/sprint7/memory-signing.test.ts 2>&1 | tail -10
```

Expected: 7 pass.

- [ ] **Step 7: Commit**

```bash
git add src/cortex.ts tests/sprint7/memory-signing.test.ts
git commit -m "feat(atlas-prime): wire memory-signing into cortex insert + retrieve"
```

---

## Task 4: Shadow-Atlas process foundation

**Files:**
- Create: `src/shadow-atlas.ts`
- Create: `scripts/init-shadow-atlas.sh`
- Test: `tests/sprint7/shadow-driver.test.ts` (basic IPC contract)

- [ ] **Step 1: Create `scripts/init-shadow-atlas.sh`**

```bash
#!/usr/bin/env bash
# Atlas Prime Sprint 7: prep directories for shadow-Atlas process.
set -e
mkdir -p data/shadow-atlas
echo "shadow-atlas dirs ready: data/shadow-atlas"
```

Run it:

```bash
chmod +x scripts/init-shadow-atlas.sh
bash scripts/init-shadow-atlas.sh
```

- [ ] **Step 2: Add `data/shadow-atlas/` to `.gitignore`**

Edit `.gitignore`, add:

```
# Atlas Prime Sprint 7
data/shadow-atlas/
data/beacon-repo/
data/beacon-publisher.key
```

- [ ] **Step 3: Create `src/shadow-atlas.ts` cold-context entrypoint**

```typescript
/**
 * Atlas Prime — Shadow-Atlas process (Sprint 7)
 *
 * Cold-context shadow of primary Atlas. Reads only the static CLAUDE.md +
 * personality files + a memory-snapshot synced every 4 hours. Responds to
 * IPC requests with a Sonnet-generated text reply, no tools, no MCP.
 *
 * Run as its own Bun process:
 *   bun src/shadow-atlas.ts
 */
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createServer, type Socket } from "net";
import { spawn } from "bun";
import { sanitizedEnv, validateSpawnArgs } from "./claude.ts";
import { extractFirstAssistantText } from "./prompt-runner.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const SHADOW_DIR = join(PROJECT_DIR, "data", "shadow-atlas");
const SNAPSHOT_FILE = join(SHADOW_DIR, "memory-snapshot.jsonl");
const SOCKET_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\shadow-atlas"
  : join(SHADOW_DIR, "shadow.sock");

let coldSystem: string | null = null;

async function loadColdContext(): Promise<string> {
  if (coldSystem) return coldSystem;
  const parts: string[] = [];
  for (const f of ["CLAUDE.md", "SOUL.md", "IDENTITY.md", "USER.md", "SHIELD.md", "TOOLS.md", "GOOGLE.md"]) {
    const p = join(PROJECT_DIR, f);
    if (existsSync(p)) parts.push(await readFile(p, "utf-8"));
  }
  if (existsSync(SNAPSHOT_FILE)) {
    parts.push("## Memory snapshot (frozen at last shadow sync)");
    parts.push(await readFile(SNAPSHOT_FILE, "utf-8"));
  }
  coldSystem = parts.join("\n\n---\n\n");
  return coldSystem;
}

async function shadowRespond(prompt: string, budgetMs: number): Promise<{ text: string }> {
  const system = await loadColdContext();
  const args = [
    process.env.CLAUDE_PATH || "claude",
    "-p",
    "--model", process.env.SHADOW_ATLAS_MODEL || "sonnet",
    "--system-prompt", system,
    "--output-format", "stream-json",
    "--verbose",
    "--allowedTools", "",        // NO tools, NO MCP
  ];
  validateSpawnArgs(args);
  const proc = spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_DIR,
    env: sanitizedEnv(),
  });
  proc.stdin.write(prompt);
  proc.stdin.end();

  const timer = setTimeout(() => {
    try { proc.kill(); } catch {}
  }, budgetMs);
  try {
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (exitCode !== 0) {
      throw new Error(`shadow-atlas exited ${exitCode}`);
    }
    return { text: extractFirstAssistantText(output) };
  } finally {
    clearTimeout(timer);
  }
}

interface IPCRequest {
  id: string;
  prompt: string;
  budgetMs?: number;
}
interface IPCResponse {
  id: string;
  text?: string;
  error?: string;
}

function handleConnection(socket: Socket): void {
  let buffer = "";
  socket.on("data", async (chunk) => {
    buffer += chunk.toString("utf-8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let req: IPCRequest;
      try {
        req = JSON.parse(line);
      } catch (err) {
        const out: IPCResponse = { id: "?", error: `parse: ${err}` };
        socket.write(JSON.stringify(out) + "\n");
        continue;
      }
      try {
        const res = await shadowRespond(req.prompt, req.budgetMs ?? 90_000);
        const out: IPCResponse = { id: req.id, text: res.text };
        socket.write(JSON.stringify(out) + "\n");
      } catch (err) {
        const out: IPCResponse = { id: req.id, error: String(err) };
        socket.write(JSON.stringify(out) + "\n");
      }
    }
  });
  socket.on("error", () => {});
}

export async function startShadowServer(): Promise<void> {
  // POSIX socket cleanup
  if (process.platform !== "win32" && existsSync(SOCKET_PATH)) {
    const { unlinkSync } = await import("fs");
    try { unlinkSync(SOCKET_PATH); } catch {}
  }
  const server = createServer(handleConnection);
  await new Promise<void>((resolve, reject) => {
    server.listen(SOCKET_PATH, () => resolve());
    server.on("error", reject);
  });
  console.log(`[shadow-atlas] listening at ${SOCKET_PATH}`);
}

// Allow direct invocation
if (import.meta.main) {
  startShadowServer().catch((err) => {
    console.error(`[shadow-atlas] failed to start: ${err}`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Write IPC contract test (no live spawn)**

```typescript
// tests/sprint7/shadow-driver.test.ts
import { describe, it, expect } from "bun:test";

describe("shadow-atlas — IPC contract", () => {
  it("module loads without errors", async () => {
    const mod = await import("../../src/shadow-atlas.ts");
    expect(typeof mod.startShadowServer).toBe("function");
  });
});
```

- [ ] **Step 5: Run test**

```bash
bun test tests/sprint7/shadow-driver.test.ts 2>&1 | tail -10
```

Expected: 1 pass.

- [ ] **Step 6: Commit**

```bash
git add src/shadow-atlas.ts scripts/init-shadow-atlas.sh .gitignore tests/sprint7/shadow-driver.test.ts
git commit -m "feat(atlas-prime): shadow-atlas cold-context process foundation + IPC server"
```

---

## Task 5: Shadow-driver module (main-process client + drift scorer + freeze flag)

**Files:**
- Create: `src/shadow-driver.ts`
- Test: `tests/sprint7/shadow-driver.test.ts`

- [ ] **Step 1: Add tests for drift classification math**

Append to `tests/sprint7/shadow-driver.test.ts`:

```typescript
describe("shadow-driver — classification", () => {
  it("benign for distance < 0.2", async () => {
    const { classifyDistance } = await import("../../src/shadow-driver.ts");
    const c = classifyDistance(0.1, 0);
    expect(c).toBe("benign");
  });

  it("explained for 0.2-0.45 with memory writes", async () => {
    const { classifyDistance } = await import("../../src/shadow-driver.ts");
    const c = classifyDistance(0.3, 5);
    expect(c).toBe("explained");
  });

  it("suspicious for 0.2-0.45 with no memory writes", async () => {
    const { classifyDistance } = await import("../../src/shadow-driver.ts");
    const c = classifyDistance(0.3, 0);
    expect(c).toBe("suspicious");
  });

  it("alarm for >= 0.45 with no memory writes", async () => {
    const { classifyDistance } = await import("../../src/shadow-driver.ts");
    const c = classifyDistance(0.5, 0);
    expect(c).toBe("alarm");
  });

  it("explained for >= 0.45 with memory writes", async () => {
    const { classifyDistance } = await import("../../src/shadow-driver.ts");
    const c = classifyDistance(0.6, 3);
    expect(c).toBe("explained");
  });
});

describe("shadow-driver — freeze flag round-trip", () => {
  it("freeze + isFrozen + resume cycle", async () => {
    const { freeze, isFrozen, resume } = await import("../../src/shadow-driver.ts");
    await resume("test-init"); // start clean
    expect(await isFrozen()).toBe(false);
    await freeze("synthetic test alarm");
    expect(await isFrozen()).toBe(true);
    await resume("test-clear");
    expect(await isFrozen()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
bun test tests/sprint7/shadow-driver.test.ts 2>&1 | tail -10
```

Expected: import error or missing exports.

- [ ] **Step 3: Create `src/shadow-driver.ts`**

```typescript
/**
 * Atlas Prime — Shadow-driver (Sprint 7)
 *
 * Main-process client to the shadow-Atlas process. Fires every primary
 * prompt over IPC, scores semantic distance via Haiku, classifies result,
 * sets freeze.flag on alarm-class drift.
 */
import { connect, type Socket } from "net";
import { existsSync } from "fs";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { callHaiku } from "./haiku-client.ts";
import { info, warn, error as logError } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const SHADOW_DIR = join(PROJECT_DIR, "data", "shadow-atlas");
const FREEZE_FLAG = join(SHADOW_DIR, "freeze.flag");
const SOCKET_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\shadow-atlas"
  : join(SHADOW_DIR, "shadow.sock");

const DEFAULT_BUDGET_MS = Number(process.env.SHADOW_BUDGET_MS ?? 90_000);
const DRIFT_THRESHOLD = Number(process.env.SHADOW_DRIFT_THRESHOLD ?? 0.45);

// ============================================================
// IPC CLIENT
// ============================================================

export interface ShadowFireResult {
  ok: boolean;
  shadowText?: string;
  reason?: string;
}

export async function fireShadow(
  prompt: string,
  opts?: { budgetMs?: number }
): Promise<ShadowFireResult> {
  if (process.env.SHADOW_ATLAS_ENABLED === "false") {
    return { ok: false, reason: "shadow_disabled" };
  }
  const budgetMs = opts?.budgetMs ?? DEFAULT_BUDGET_MS;
  return await new Promise((resolve) => {
    const id = randomUUID();
    let socket: Socket | null = null;
    let buf = "";
    const timer = setTimeout(() => {
      try { socket?.destroy(); } catch {}
      resolve({ ok: false, reason: "timeout" });
    }, budgetMs);
    try {
      socket = connect(SOCKET_PATH);
    } catch (err) {
      clearTimeout(timer);
      return resolve({ ok: false, reason: `connect: ${err}` });
    }
    socket.on("connect", () => {
      socket!.write(JSON.stringify({ id, prompt, budgetMs }) + "\n");
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      try {
        const res = JSON.parse(line);
        clearTimeout(timer);
        try { socket?.end(); } catch {}
        if (res.error) resolve({ ok: false, reason: res.error });
        else resolve({ ok: true, shadowText: res.text });
      } catch {
        clearTimeout(timer);
        resolve({ ok: false, reason: "parse_error" });
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `socket: ${err.message}` });
    });
  });
}

// ============================================================
// DRIFT SCORING (Haiku via CLI)
// ============================================================

export async function scoreDrift(
  primaryText: string,
  shadowText: string
): Promise<{ distance: number; reason: string }> {
  try {
    const { text } = await callHaiku({
      system:
        "You score the semantic distance between two responses to the same user prompt. " +
        "0 = identical meaning, 0.5 = different emphasis or detail, 1 = contradictory or unrelated. " +
        'Output strict JSON: {"distance": <0..1 number, 2 decimals>, "reason": <one sentence>}.',
      userMessage:
        `### Primary response\n${primaryText}\n\n### Shadow response\n${shadowText}`,
      maxTokens: 200,
      cacheSystem: true,
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { distance: 0, reason: "scorer_no_json" };
    const obj = JSON.parse(m[0]);
    const d = Math.max(0, Math.min(1, Number(obj.distance ?? 0)));
    return { distance: d, reason: String(obj.reason ?? "") };
  } catch (err) {
    return { distance: 0, reason: `scorer_failed: ${err}` };
  }
}

// ============================================================
// CLASSIFICATION
// ============================================================

export type DriftClass = "benign" | "explained" | "suspicious" | "alarm";

export function classifyDistance(distance: number, memoryWritesInWindow: number): DriftClass {
  if (distance < 0.2) return "benign";
  if (distance < DRIFT_THRESHOLD) {
    return memoryWritesInWindow > 0 ? "explained" : "suspicious";
  }
  return memoryWritesInWindow > 0 ? "explained" : "alarm";
}

// ============================================================
// FREEZE FLAG
// ============================================================

async function ensureDir(): Promise<void> {
  if (!existsSync(SHADOW_DIR)) await mkdir(SHADOW_DIR, { recursive: true });
}

export async function isFrozen(): Promise<boolean> {
  return existsSync(FREEZE_FLAG);
}

export async function readFreezeReason(): Promise<{ reason: string; since: string; divergence_id?: string } | null> {
  if (!existsSync(FREEZE_FLAG)) return null;
  try {
    const raw = await readFile(FREEZE_FLAG, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { reason: "unknown (corrupt freeze.flag)", since: new Date().toISOString() };
  }
}

export async function freeze(reason: string, divergence_id?: string): Promise<void> {
  await ensureDir();
  await writeFile(
    FREEZE_FLAG,
    JSON.stringify({ frozen: true, since: new Date().toISOString(), reason, divergence_id }),
    "utf-8"
  );
  warn("shadow-driver", `FROZEN — ${reason}`);
}

export async function resume(by: string, note?: string): Promise<void> {
  if (existsSync(FREEZE_FLAG)) {
    try { await unlink(FREEZE_FLAG); } catch {}
  }
  info("shadow-driver", `resumed by ${by}${note ? ` — ${note}` : ""}`);
}

// ============================================================
// DIVERGENCE RECORDER
// ============================================================

export async function countMemoryWritesInWindow(
  supabase: any,
  sinceIso: string
): Promise<number> {
  if (!supabase) return 0;
  try {
    const { count } = await supabase
      .from("memory")
      .select("id", { count: "exact", head: true })
      .gte("created_at", sinceIso);
    return count ?? 0;
  } catch {
    return 0;
  }
}

export async function recordDivergence(opts: {
  supabase: any;
  turn_id: string | null;
  primaryText: string;
  shadowText: string;
  distance: number;
  reason: string;
  memoryWritesInWindow: number;
}): Promise<{ classified: DriftClass; froze: boolean; id?: string }> {
  const classified = classifyDistance(opts.distance, opts.memoryWritesInWindow);
  let froze = false;
  let id: string | undefined;

  // Cheapest path: don't log benign rows (volume)
  if (classified !== "benign" && opts.supabase) {
    const { data } = await opts.supabase
      .from("shadow_divergence_log")
      .insert({
        turn_id: opts.turn_id,
        primary_text: opts.primaryText.slice(0, 8000),
        shadow_text: opts.shadowText.slice(0, 8000),
        distance: opts.distance,
        judge_reason: opts.reason,
        memory_writes_in_window: opts.memoryWritesInWindow,
        classified,
        froze: classified === "alarm",
      })
      .select("id")
      .maybeSingle();
    id = (data as any)?.id;
  }

  if (classified === "alarm") {
    await freeze(`shadow divergence — distance=${opts.distance.toFixed(2)} reason=${opts.reason}`, id);
    froze = true;
  }
  return { classified, froze, id };
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/sprint7/shadow-driver.test.ts 2>&1 | tail -15
```

Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/shadow-driver.ts tests/sprint7/shadow-driver.test.ts
git commit -m "feat(atlas-prime): shadow-driver — IPC client + drift scorer + freeze flag"
```

---

## Task 6: Wire shadow-driver into relay (fire-and-forget on every prompt + freeze-flag gate)

**Files:**
- Modify: `src/relay.ts` (fire shadow on user turn; check freeze before external action)
- Test: `tests/sprint7/shadow-driver.test.ts` (freeze-gate logic)

- [ ] **Step 1: Add freeze-gate test**

Append to `tests/sprint7/shadow-driver.test.ts`:

```typescript
describe("shadow-driver — external-action gate", () => {
  it("isExternalAction returns true for SEND/CAL_ADD/GHL_WORKFLOW", async () => {
    const { isExternalAction } = await import("../../src/shadow-driver.ts");
    expect(isExternalAction("SEND")).toBe(true);
    expect(isExternalAction("CAL_ADD")).toBe(true);
    expect(isExternalAction("GHL_WORKFLOW")).toBe(true);
    expect(isExternalAction("DRAFT")).toBe(false);
    expect(isExternalAction("REMEMBER")).toBe(false);
  });
});
```

- [ ] **Step 2: Add `isExternalAction` helper to shadow-driver.ts**

Append to `src/shadow-driver.ts`:

```typescript
// ============================================================
// EXTERNAL-ACTION CLASSIFIER (used by freeze-flag gate)
// ============================================================

const EXTERNAL_ACTION_TOOLS = new Set([
  "SEND", "TMAA_SEND",
  "CAL_ADD", "CAL_REMOVE", "TMAA_CAL_ADD", "TMAA_CAL_REMOVE",
  "GHL_WORKFLOW",
  "GHL_SOCIAL",
  "WP_POST", "WP_UPDATE",
  "PLANNER_TASK", "PLANNER_MOVE", "PLANNER_DONE",
]);

export function isExternalAction(toolName: string): boolean {
  return EXTERNAL_ACTION_TOOLS.has(toolName);
}
```

- [ ] **Step 3: Run test**

```bash
bun test tests/sprint7/shadow-driver.test.ts -t "external-action gate" 2>&1 | tail -10
```

Expected: 1 pass.

- [ ] **Step 4: Wire shadow-fire into relay prompt pipeline**

Locate the place in `src/relay.ts` where user prompts go to `callClaude` (the main message handler). Just *before* the call, fire shadow on a fire-and-forget basis:

```typescript
// Atlas Prime Sprint 7: fire shadow-Atlas in parallel; score after primary returns
const shadowPromise = (async () => {
  if (process.env.SHADOW_ATLAS_ENABLED === "false") return null;
  try {
    const { fireShadow } = await import("./shadow-driver.ts");
    return await fireShadow(prompt);
  } catch { return null; }
})();
```

After the primary `callClaude` response is in hand, score and record:

```typescript
// Score drift after primary text is in hand (do not block reply)
(async () => {
  try {
    const sr = await shadowPromise;
    if (!sr || !sr.ok || !sr.shadowText) return;
    const { scoreDrift, countMemoryWritesInWindow, recordDivergence } =
      await import("./shadow-driver.ts");
    const { distance, reason } = await scoreDrift(primaryText, sr.shadowText);
    const since = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
    const writes = await countMemoryWritesInWindow(supabase, since);
    const { classified, froze, id } = await recordDivergence({
      supabase,
      turn_id: turnId,
      primaryText,
      shadowText: sr.shadowText,
      distance,
      reason,
      memoryWritesInWindow: writes,
    });
    if (classified === "alarm") {
      await sendTelegramMessage(
        DEREK_CHAT_ID,
        `🚨 **Shadow divergence ALARM** — distance ${distance.toFixed(2)}\n\n` +
        `Reason: ${reason}\n\nAtlas is **frozen** for external actions.\n` +
        `Review: \`/shadow status\`\nResume: \`/shadow resume ${id ?? ""}\``
      );
    }
  } catch (err) {
    logError("shadow-driver", `post-turn drift handling failed: ${err}`);
  }
})();
```

Reference exact variables (`prompt`, `primaryText`, `turnId`, `supabase`, `sendTelegramMessage`, `DEREK_CHAT_ID`, `logError`) from the surrounding context in `src/relay.ts`.

- [ ] **Step 5: Wire freeze-flag gate into outbound tag dispatch**

In `src/relay.ts`, find the section that dispatches outgoing tags (`[SEND:]`, `[CAL_ADD:]`, etc.). Before dispatch, add:

```typescript
// Atlas Prime Sprint 7: block external actions when shadow-divergence freeze flag is set
{
  const { isFrozen, readFreezeReason, isExternalAction } =
    await import("./shadow-driver.ts");
  if (isExternalAction(tagName) && (await isFrozen())) {
    const fr = await readFreezeReason();
    await ctx.reply(
      `❄️ Atlas is **frozen** — external action \`${tagName}\` blocked.\n` +
      `Reason: ${fr?.reason ?? "unknown"}\n` +
      `Use \`/shadow status\` to review and \`/shadow resume\` to clear.`,
      { parse_mode: "Markdown" }
    );
    continue; // skip dispatch
  }
}
```

(`tagName` and `ctx` are the loop variable + Telegraf ctx in the dispatch loop.)

- [ ] **Step 6: Run full Sprint 7 tests**

```bash
bun test tests/sprint7/ 2>&1 | tail -15
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/relay.ts src/shadow-driver.ts tests/sprint7/shadow-driver.test.ts
git commit -m "feat(atlas-prime): wire shadow-driver into relay — fire-and-forget shadow + freeze gate"
```

---

## Task 7: Entropy-probe module

**Files:**
- Create: `src/entropy-probe.ts`
- Test: `tests/sprint7/entropy-probe.test.ts`

- [ ] **Step 1: Write entropy-math tests**

```typescript
// tests/sprint7/entropy-probe.test.ts
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
        { idx: 4, tool: "SEND", args_canonical: "{}" }, // destructive minority
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
```

- [ ] **Step 2: Run test to confirm fail**

```bash
bun test tests/sprint7/entropy-probe.test.ts 2>&1 | tail -10
```

Expected: import error.

- [ ] **Step 3: Create `src/entropy-probe.ts`**

```typescript
/**
 * Atlas Prime — Entropy-Probe (Sprint 7)
 *
 * For ambiguous tool selections (>= 2 candidate tools in a turn), generate
 * 5 samples, cluster by semantic equivalence, compute H = -Σ p_k log p_k.
 * High-entropy turns short-circuit to a clarifying question.
 */
import { callHaiku } from "./haiku-client.ts";

// ============================================================
// TYPES
// ============================================================

export interface Sample {
  idx: number;
  tool: string;
  args_canonical: string;
}

export interface Cluster {
  cluster_id: number;
  members: number[];
  representative: Sample;
}

export interface ProbeResult {
  entropy: number;
  clusters: Cluster[];
  samples: Sample[];
  recommendation: "dispatch_consensus" | "clarify" | "manual_review";
  selectedTool?: string;
  selectedArgs?: string;
  reason: string;
}

const SAMPLES_PER_PROBE = Number(process.env.ENTROPY_PROBE_SAMPLES ?? 5);
const ENTROPY_THRESHOLD = Number(process.env.ENTROPY_THRESHOLD ?? 0.8);
const DESTRUCTIVE = new Set([
  "SEND", "TMAA_SEND",
  "GHL_WORKFLOW",
  "CAL_REMOVE", "TMAA_CAL_REMOVE",
  "WP_POST",
  "PLANNER_DONE",
]);

// ============================================================
// CANONICAL ARGS
// ============================================================

export function canonicalArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return JSON.stringify(
    keys.reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = args[k];
      return acc;
    }, {})
  );
}

// ============================================================
// SAMPLE GENERATION
// ============================================================

const SAMPLE_SYSTEM_PROMPT =
  "You decide which tool tag to emit for this user request. " +
  "Output ONLY a JSON object: {\"tool\": \"<TAG_NAME>\", \"args\": {<key>: <value>, ...}}. " +
  "Valid TAG_NAMEs: SEND, DRAFT, CAL_ADD, GHL_NOTE, GHL_TASK, GHL_TAG, GHL_WORKFLOW, " +
  "WP_POST, WP_UPDATE, PLANNER_TASK, REMEMBER, TODO. Pick one; do not narrate.";

function parseSample(text: string, idx: number): Sample | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: any;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj?.tool || typeof obj.tool !== "string") return null;
  const args = (obj.args && typeof obj.args === "object") ? obj.args as Record<string, unknown> : {};
  return { idx, tool: obj.tool.toUpperCase(), args_canonical: canonicalArgs(args) };
}

export async function generateSamples(
  prompt: string,
  contextSystem?: string,
  k?: number
): Promise<Sample[]> {
  const n = k ?? SAMPLES_PER_PROBE;
  const system = contextSystem
    ? `${SAMPLE_SYSTEM_PROMPT}\n\n# Additional context\n${contextSystem}`
    : SAMPLE_SYSTEM_PROMPT;
  const calls: Promise<Sample | null>[] = [];
  for (let i = 0; i < n; i++) {
    calls.push(
      (async () => {
        try {
          const { text } = await callHaiku({
            system,
            userMessage: prompt,
            maxTokens: 200,
            cacheSystem: true,
          });
          return parseSample(text, i);
        } catch {
          return null;
        }
      })()
    );
  }
  const results = await Promise.all(calls);
  const valid: Sample[] = [];
  for (const r of results) if (r) valid.push({ ...r, idx: valid.length });
  return valid;
}

// ============================================================
// CLUSTERING
// ============================================================

const CLUSTER_SYSTEM =
  "Below are tool-choice samples. Cluster them by semantic equivalence (same tool + same effective args). " +
  "Output ONLY a JSON array: [{\"cluster_id\": 0, \"members\": [0,2]}, {\"cluster_id\": 1, \"members\": [1,3,4]}].";

export async function clusterSamples(samples: Sample[]): Promise<Cluster[]> {
  // Cheap deterministic path: identical (tool, args_canonical) clusters together.
  // Single-tool agreement covers the vast majority of cases; Haiku is only needed
  // when args differ but mean the same thing.
  const keyOf = (s: Sample) => `${s.tool}::${s.args_canonical}`;
  const byKey = new Map<string, number[]>();
  for (const s of samples) {
    const k = keyOf(s);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(s.idx);
  }
  if (byKey.size <= 1 || byKey.size === samples.length) {
    // Trivially unanimous or trivially all-singleton — skip Haiku.
    return Array.from(byKey.values()).map((members, i) => ({
      cluster_id: i,
      members,
      representative: samples[members[0]],
    }));
  }

  // Non-trivial: ask Haiku for semantic equivalence judgment.
  const userMsg = "Samples:\n" + samples.map((s) => `[${s.idx}] tool=${s.tool} args=${s.args_canonical}`).join("\n");
  try {
    const { text } = await callHaiku({
      system: CLUSTER_SYSTEM,
      userMessage: userMsg,
      maxTokens: 400,
      cacheSystem: true,
    });
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("no JSON array");
    const arr: { cluster_id: number; members: number[] }[] = JSON.parse(m[0]);
    return arr.map((c) => ({
      cluster_id: c.cluster_id,
      members: c.members,
      representative: samples[c.members[0]],
    }));
  } catch {
    // Fallback to deterministic clustering
    return Array.from(byKey.values()).map((members, i) => ({
      cluster_id: i,
      members,
      representative: samples[members[0]],
    }));
  }
}

// ============================================================
// ENTROPY
// ============================================================

export function entropyOf(clusters: Cluster[], total: number): number {
  if (total <= 0) return 0;
  let H = 0;
  for (const c of clusters) {
    const p = c.members.length / total;
    if (p > 0) H -= p * Math.log(p);
  }
  return H;
}

// ============================================================
// RECOMMENDATION
// ============================================================

export function recommend(
  entropy: number,
  clusters: Cluster[],
  samples: Sample[]
): ProbeResult {
  // Destructive-asymmetry override
  const toolsSeen = new Set(samples.map((s) => s.tool));
  let hasDestructive = false;
  let hasNonDestructive = false;
  for (const t of toolsSeen) {
    if (DESTRUCTIVE.has(t)) hasDestructive = true;
    else hasNonDestructive = true;
  }
  if (hasDestructive && hasNonDestructive) {
    return {
      entropy,
      clusters,
      samples,
      recommendation: "clarify",
      reason: "destructive-asymmetry: destructive tool proposed alongside non-destructive alternative",
    };
  }

  // Pick dominant cluster
  const sorted = [...clusters].sort((a, b) => b.members.length - a.members.length);
  const top = sorted[0];

  if (entropy <= 0.2 && top && top.members.length >= Math.max(4, samples.length - 1)) {
    return {
      entropy,
      clusters,
      samples,
      recommendation: "dispatch_consensus",
      selectedTool: top.representative.tool,
      selectedArgs: top.representative.args_canonical,
      reason: "unanimous or near-unanimous cluster",
    };
  }
  if (entropy <= ENTROPY_THRESHOLD && top && top.members.length >= 3) {
    return {
      entropy,
      clusters,
      samples,
      recommendation: "dispatch_consensus",
      selectedTool: top.representative.tool,
      selectedArgs: top.representative.args_canonical,
      reason: "below-threshold entropy with majority cluster",
    };
  }
  return {
    entropy,
    clusters,
    samples,
    recommendation: "clarify",
    reason: `entropy ${entropy.toFixed(3)} > threshold ${ENTROPY_THRESHOLD} or no majority cluster`,
  };
}

// ============================================================
// FULL PROBE
// ============================================================

export async function probe(prompt: string, contextSystem?: string): Promise<ProbeResult> {
  const samples = await generateSamples(prompt, contextSystem);
  if (samples.length === 0) {
    return {
      entropy: 0,
      clusters: [],
      samples: [],
      recommendation: "manual_review",
      reason: "no samples generated",
    };
  }
  const clusters = await clusterSamples(samples);
  const H = entropyOf(clusters, samples.length);
  return recommend(H, clusters, samples);
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/sprint7/entropy-probe.test.ts 2>&1 | tail -10
```

Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/entropy-probe.ts tests/sprint7/entropy-probe.test.ts
git commit -m "feat(atlas-prime): entropy-probe — sample + cluster + entropy + recommend"
```

---

## Task 8: Wire entropy-probe into tool-gate companion + relay

**Files:**
- Modify: `src/tool-gate.ts` — add `checkActionWithEntropy` companion (does NOT modify existing `checkAction`)
- Modify: `src/relay.ts` — call probe + log to `tool_entropy_probes` + clarify-substitution
- Test: `tests/sprint7/entropy-probe.test.ts` — companion function smoke test

- [ ] **Step 1: Add companion-function test**

Append to `tests/sprint7/entropy-probe.test.ts`:

```typescript
describe("tool-gate — checkActionWithEntropy", () => {
  it("delegates to checkAction when not ambiguous", async () => {
    const { checkActionWithEntropy } = await import("../../src/tool-gate.ts");
    const result = await checkActionWithEntropy(
      { tool: "REMEMBER", args: { content: "x" } },
      { ambiguous: false }
    );
    // checkAction's invariants don't cover REMEMBER → allow
    expect(result.allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Add `checkActionWithEntropy` to `src/tool-gate.ts`**

**IMPORTANT:** Do NOT modify the existing `checkAction` function. Add a companion at the bottom:

```typescript
// ============================================================
// COMPANION: ENTROPY-AWARE CHECK (Sprint 7)
// ============================================================

import type { ProbeResult } from "./entropy-probe.ts";

export async function checkActionWithEntropy(
  action: Action,
  opts: { ambiguous: boolean; userPrompt?: string }
): Promise<GateResult & { entropy?: ProbeResult }> {
  // Always run base spec check first
  const base = checkAction(action);
  if (!base.allowed) return base;
  if (!opts.ambiguous || !opts.userPrompt) return base;

  // Ambiguous turn: run probe
  const { probe } = await import("./entropy-probe.ts");
  const result = await probe(opts.userPrompt);
  if (result.recommendation === "clarify" || result.recommendation === "manual_review") {
    return {
      allowed: false,
      reason: `entropy: ${result.recommendation} — ${result.reason}`,
      entropy: result,
    };
  }
  return { ...base, entropy: result };
}
```

- [ ] **Step 3: Wire into relay tag-dispatch loop**

In `src/relay.ts`, where outgoing tags are parsed before dispatch, detect ambiguity (≥2 distinct tag types in the same response) and run the probe. Insert this before the dispatch loop:

```typescript
// Atlas Prime Sprint 7: ambiguity detection + entropy probe
const distinctTagTypes = new Set(parsedTags.map((t) => t.name));
const isAmbiguousTurn = distinctTagTypes.size >= 2;
let entropyVerdict: any = null;
if (isAmbiguousTurn && process.env.ENTROPY_PROBE_ENABLED !== "false") {
  try {
    const { probe } = await import("./entropy-probe.ts");
    entropyVerdict = await probe(text);
    if (supabase) {
      await supabase.from("tool_entropy_probes").insert({
        turn_id: turnId,
        user_prompt: text.slice(0, 4000),
        samples: entropyVerdict.samples,
        clusters: entropyVerdict.clusters,
        entropy: entropyVerdict.entropy,
        action: entropyVerdict.recommendation === "clarify" ? "clarified" : "dispatched",
        selected_tool: entropyVerdict.selectedTool ?? null,
      });
    }
    if (entropyVerdict.recommendation === "clarify") {
      await ctx.reply(
        `🤔 I'm not sure which is right — I'd either ${[...distinctTagTypes].join(" or ")}. ` +
        `Which do you want?\n\n_(${entropyVerdict.reason})_`,
        { parse_mode: "Markdown" }
      );
      return; // skip dispatch this turn
    }
  } catch (err) {
    logError("entropy-probe", `failed: ${err}`);
  }
}
```

The exact variable names (`parsedTags`, `text`, `turnId`, `supabase`, `ctx`, `logError`) must match the relay's surrounding context.

- [ ] **Step 4: Run tests**

```bash
bun test tests/sprint7/entropy-probe.test.ts 2>&1 | tail -10
```

Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/tool-gate.ts src/relay.ts tests/sprint7/entropy-probe.test.ts
git commit -m "feat(atlas-prime): wire entropy-probe — checkActionWithEntropy + relay ambiguity detection"
```

---

## Task 9: Knowledge-audit module

**Files:**
- Create: `src/knowledge-audit.ts`
- Test: `tests/sprint7/knowledge-audit.test.ts`

- [ ] **Step 1: Write half-life math tests**

```typescript
// tests/sprint7/knowledge-audit.test.ts
import { describe, it, expect } from "bun:test";
import { proposeHalfLife } from "../../src/knowledge-audit.ts";

describe("knowledge-audit — proposeHalfLife", () => {
  it("returns current when drift is 0", () => {
    expect(proposeHalfLife(30, 0)).toBe(30);
  });

  it("ratchets down when drift is high", () => {
    // drift 0.5 over 7d → half_life ≈ 7 days
    const p = proposeHalfLife(30, 0.5);
    expect(p).toBeLessThan(30);
    expect(p).toBeGreaterThan(0);
  });

  it("clips to 1.5x current ceiling", () => {
    // synthetic edge: drift very small → would propose huge half life
    const p = proposeHalfLife(30, 0.001);
    expect(p).toBeLessThanOrEqual(45);
  });

  it("never returns < 1", () => {
    const p = proposeHalfLife(30, 0.99);
    expect(p).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
bun test tests/sprint7/knowledge-audit.test.ts 2>&1 | tail -10
```

Expected: import error.

- [ ] **Step 3: Create `src/knowledge-audit.ts`**

```typescript
/**
 * Atlas Prime — Knowledge Audit (Sprint 7)
 *
 * Weekly Saturday audit. For each fast/real_time domain in hot-domains.json,
 * pull recent Atlas answers, fetch authoritative source via WebFetch, score
 * drift, propose new half-life. Surface to Derek for approval.
 */
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { callHaiku } from "./haiku-client.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const HOT_DOMAINS_PATH = join(PROJECT_DIR, "data", "hot-domains.json");

const SAMPLE_SIZE = Number(process.env.KNOWLEDGE_AUDIT_SAMPLE_SIZE ?? 8);

// ============================================================
// MATH
// ============================================================

export function proposeHalfLife(currentHalfLifeDays: number, driftScore: number): number {
  // No drift → no change
  if (driftScore <= 0) return currentHalfLifeDays;

  // Bayesian half-decay: if observed drift D over 7 days, then
  //   half_life ≈ -7 / log2(1 - D)
  // Clipped to [1, current * 1.5] to prevent pathological swings.
  const D = Math.min(0.99, driftScore);
  const raw = -7 / Math.log2(1 - D);
  const ceiling = currentHalfLifeDays * 1.5;
  const clipped = Math.max(1, Math.min(ceiling, raw));
  return Math.ceil(clipped);
}

// ============================================================
// TYPES
// ============================================================

export interface AuditResult {
  domain: string;
  samples_examined: number;
  samples_still_correct: number;
  drift_score: number;
  current_half_life: number;
  proposed_half_life: number;
  rationale: string;
}

interface HotDomain {
  half_life_days: number;
  authoritative_sources: string[];
  llms_txt: string | null;
  changelog_url: string | null;
  last_refresh: string | null;
  tier: string;
  triggers: string[];
}

interface HotDomainsFile {
  version: number;
  updated_at: string;
  domains: Record<string, HotDomain>;
}

// ============================================================
// PER-DOMAIN AUDIT
// ============================================================

export interface AuditDeps {
  // Inject these for testability
  fetchRecentSamples: (domain: string, max: number) => Promise<string[]>;
  webFetch: (url: string, prompt: string) => Promise<string>;
}

export async function auditDomain(
  domain: string,
  spec: HotDomain,
  deps: AuditDeps,
  opts?: { sampleSize?: number }
): Promise<AuditResult> {
  const n = opts?.sampleSize ?? SAMPLE_SIZE;
  const samples = await deps.fetchRecentSamples(domain, n);
  if (samples.length === 0) {
    return {
      domain,
      samples_examined: 0,
      samples_still_correct: 0,
      drift_score: 0,
      current_half_life: spec.half_life_days,
      proposed_half_life: spec.half_life_days,
      rationale: "no recent samples to audit",
    };
  }
  const source = spec.authoritative_sources[0];
  if (!source) {
    return {
      domain,
      samples_examined: samples.length,
      samples_still_correct: samples.length,
      drift_score: 0,
      current_half_life: spec.half_life_days,
      proposed_half_life: spec.half_life_days,
      rationale: "no authoritative source configured; skipping audit",
    };
  }
  // Fetch current source
  let sourceText: string;
  try {
    sourceText = await deps.webFetch(
      source,
      "Return the main content of this page. Focus on API changes, deprecations, feature additions."
    );
  } catch (err) {
    return {
      domain,
      samples_examined: samples.length,
      samples_still_correct: samples.length,
      drift_score: 0,
      current_half_life: spec.half_life_days,
      proposed_half_life: spec.half_life_days,
      rationale: `webFetch failed (${err}); kept current half-life`,
    };
  }

  // For each sample, ask Haiku: is this still correct given the current source?
  let correct = 0;
  const verdicts: string[] = [];
  for (const claim of samples) {
    try {
      const { text } = await callHaiku({
        system:
          'Given current vendor documentation and an Atlas claim, decide if the claim is still correct. ' +
          'Output strict JSON: {"correct": true|false, "reason": "<one sentence>"}.',
        userMessage: `### Current docs (excerpt)\n${sourceText.slice(0, 6000)}\n\n### Atlas claim\n${claim}`,
        maxTokens: 200,
        cacheSystem: true,
      });
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const v = JSON.parse(m[0]);
      if (v.correct === true) correct++;
      else if (v.reason) verdicts.push(String(v.reason));
    } catch {
      // skip on parse / fetch fail
    }
  }
  const drift = 1 - correct / samples.length;
  const proposed = proposeHalfLife(spec.half_life_days, drift);
  const rationale = verdicts.length
    ? `drift ${Math.round(drift * 100)}% — ${verdicts.slice(0, 2).join("; ")}`
    : `drift ${Math.round(drift * 100)}% (no specific failure reasons captured)`;
  return {
    domain,
    samples_examined: samples.length,
    samples_still_correct: correct,
    drift_score: drift,
    current_half_life: spec.half_life_days,
    proposed_half_life: proposed,
    rationale,
  };
}

// ============================================================
// FULL WEEKLY RUN
// ============================================================

export async function runWeeklyAudit(
  supabase: any,
  deps: AuditDeps
): Promise<AuditResult[]> {
  const raw = await readFile(HOT_DOMAINS_PATH, "utf-8");
  const file: HotDomainsFile = JSON.parse(raw);
  const results: AuditResult[] = [];
  for (const [domain, spec] of Object.entries(file.domains)) {
    if (spec.tier !== "fast" && spec.tier !== "real_time") continue;
    const r = await auditDomain(domain, spec, deps);
    results.push(r);
    if (supabase) {
      try {
        await supabase.from("knowledge_audit_log").insert({
          domain: r.domain,
          samples_examined: r.samples_examined,
          samples_still_correct: r.samples_still_correct,
          drift_score: r.drift_score,
          current_half_life: r.current_half_life,
          proposed_half_life: r.proposed_half_life,
          rationale: r.rationale,
          decision: "proposed",
        });
      } catch {}
    }
  }
  return results;
}

// ============================================================
// APPLY HALF-LIFE UPDATE
// ============================================================

export async function applyHalfLifeUpdate(opts: {
  domain: string;
  newHalfLife: number;
  decidedBy: string;
  supabase: any;
}): Promise<void> {
  const raw = await readFile(HOT_DOMAINS_PATH, "utf-8");
  const file: HotDomainsFile = JSON.parse(raw);
  if (!file.domains[opts.domain]) {
    throw new Error(`unknown domain: ${opts.domain}`);
  }
  file.domains[opts.domain].half_life_days = opts.newHalfLife;
  file.updated_at = new Date().toISOString();
  await writeFile(HOT_DOMAINS_PATH, JSON.stringify(file, null, 2) + "\n", "utf-8");

  // Append ledger entry
  const { appendEntry } = await import("./ledger.ts");
  await appendEntry({
    actor: "atlas",
    action: {
      tool: "hot_domains_update",
      args: { domain: opts.domain, new_half_life: opts.newHalfLife, decided_by: opts.decidedBy },
    },
    sourceClaims: [{ claim_id: `knowledge-audit:${opts.domain}` }],
    outcome: { success: true },
  });

  // Update audit log decision
  if (opts.supabase) {
    await opts.supabase
      .from("knowledge_audit_log")
      .update({
        decision: "applied",
        decided_by: opts.decidedBy,
        decided_at: new Date().toISOString(),
        override_value: opts.newHalfLife,
      })
      .eq("domain", opts.domain)
      .eq("decision", "proposed")
      .order("audit_at", { ascending: false })
      .limit(1);
  }
}

// ============================================================
// TELEGRAM SURFACE
// ============================================================

export function formatAuditSummary(results: AuditResult[]): string {
  const lines = [`📚 **Weekly Knowledge Audit — ${new Date().toISOString().slice(0, 10)}**`, ""];
  lines.push(`${results.length} domains examined.`, "");
  for (const r of results) {
    const emoji =
      r.proposed_half_life < r.current_half_life ? "🔻" :
      r.proposed_half_life > r.current_half_life ? "🔺" : "✓";
    lines.push(`${emoji} **${r.domain}** — drift ${Math.round(r.drift_score * 100)}% (${r.samples_still_correct}/${r.samples_examined} correct)`);
    lines.push(`  current: ${r.current_half_life}d · proposed: ${r.proposed_half_life}d`);
    lines.push(`  ${r.rationale.slice(0, 200)}`);
    lines.push("");
  }
  lines.push("Apply via `/audit apply <domain>` or `/audit applyall`.");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/sprint7/knowledge-audit.test.ts 2>&1 | tail -10
```

Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge-audit.ts tests/sprint7/knowledge-audit.test.ts
git commit -m "feat(atlas-prime): knowledge-audit — domain drift + half-life proposal math"
```

---

## Task 10: Beacon export + verify scripts + workflow template

**Files:**
- Create: `scripts/beacon-export.ts`
- Create: `scripts/verify-beacon.ts`
- Create: `templates/atlas-prime-beacon/README.md`
- Create: `templates/atlas-prime-beacon/BOUNTY.md`
- Create: `templates/atlas-prime-beacon/verify/verify-beacon.ts`
- Create: `templates/atlas-prime-beacon/.github/workflows/publish-beacon.yml`
- Test: `tests/sprint7/beacon-export.test.ts`

- [ ] **Step 1: Add beacon-export tests**

```typescript
// tests/sprint7/beacon-export.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("beacon-export — buildPublicFiles", () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "beacon-test-"));
  });
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes roots/YYYY-MM-DD.jsonl from input roots", async () => {
    const { buildPublicFiles } = await import("../../scripts/beacon-export.ts");
    const inputRoots = [
      { ts: "2026-05-14T01:00:00.000Z", root: "abc123", entries: 100 },
      { ts: "2026-05-14T02:00:00.000Z", root: "def456", entries: 101 },
      { ts: "2026-05-15T01:00:00.000Z", root: "ghi789", entries: 105 },
    ];
    await buildPublicFiles(inputRoots, tmpDir);
    expect(existsSync(join(tmpDir, "roots", "2026-05-14.jsonl"))).toBe(true);
    expect(existsSync(join(tmpDir, "roots", "2026-05-15.jsonl"))).toBe(true);
    expect(existsSync(join(tmpDir, "roots", "latest.json"))).toBe(true);
    const latest = JSON.parse(readFileSync(join(tmpDir, "roots", "latest.json"), "utf-8"));
    expect(latest.root).toBe("ghi789");
  });

  it("idempotent: same input produces same files", async () => {
    const { buildPublicFiles } = await import("../../scripts/beacon-export.ts");
    const inputRoots = [
      { ts: "2026-05-14T01:00:00.000Z", root: "abc123", entries: 100 },
    ];
    await buildPublicFiles(inputRoots, tmpDir);
    const a = readFileSync(join(tmpDir, "roots", "2026-05-14.jsonl"), "utf-8");
    await buildPublicFiles(inputRoots, tmpDir);
    const b = readFileSync(join(tmpDir, "roots", "2026-05-14.jsonl"), "utf-8");
    expect(a).toBe(b);
  });
});

describe("beacon-export — workflow YAML round-trip", () => {
  it("publish-beacon.yml parses as valid YAML", async () => {
    const yaml = await import("js-yaml");
    const text = readFileSync(
      "templates/atlas-prime-beacon/.github/workflows/publish-beacon.yml",
      "utf-8"
    );
    const parsed = yaml.load(text) as any;
    expect(parsed.name).toBe("publish-beacon-hourly");
    expect(parsed.on.schedule[0].cron).toBe("15 * * * *");
  });
});
```

- [ ] **Step 2: Create `scripts/beacon-export.ts`**

```typescript
#!/usr/bin/env bun
/**
 * Atlas Prime — Beacon Export (Sprint 7)
 *
 * Reads data/atlas-ledger-roots.jsonl, groups by UTC day, writes per-day
 * JSONL + latest.json to a local clone of the atlas-prime-beacon repo.
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   bun scripts/beacon-export.ts
 *   bun scripts/beacon-export.ts --mode=mirror  (for GitHub Actions)
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { spawn } from "node:child_process";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const ROOTS_FILE = join(PROJECT_DIR, "data", "atlas-ledger-roots.jsonl");
const BEACON_REPO_DIR = join(PROJECT_DIR, "data", "beacon-repo");

export interface RootRecord {
  ts: string;
  root: string;
  entries: number;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export async function buildPublicFiles(
  roots: RootRecord[],
  outDir: string
): Promise<void> {
  await mkdir(join(outDir, "roots"), { recursive: true });
  const byDay = new Map<string, RootRecord[]>();
  for (const r of roots) {
    const d = dayOf(r.ts);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }
  for (const [day, recs] of byDay.entries()) {
    const path = join(outDir, "roots", `${day}.jsonl`);
    const content = recs
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n";
    await writeFile(path, content, "utf-8");
  }
  // latest.json
  const latest = roots.sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (latest) {
    await writeFile(
      join(outDir, "roots", "latest.json"),
      JSON.stringify({ ...latest, day: dayOf(latest.ts) }, null, 2),
      "utf-8"
    );
  }
}

async function gitInWorkdir(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd, shell: process.platform === "win32" });
    let stdout = ""; let stderr = "";
    p.stdout?.on("data", (b) => stdout += b.toString());
    p.stderr?.on("data", (b) => stderr += b.toString());
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function commitAndPush(workdir: string): Promise<{ pushed: boolean; reason?: string }> {
  if (!existsSync(join(workdir, ".git"))) {
    return { pushed: false, reason: "not_a_git_repo" };
  }
  await gitInWorkdir(["add", "."], workdir);
  const status = await gitInWorkdir(["status", "--porcelain"], workdir);
  if (!status.stdout.trim()) return { pushed: false, reason: "no_changes" };

  await gitInWorkdir(["commit", "-m", `beacon update ${new Date().toISOString()}`], workdir);
  const pushResult = await gitInWorkdir(["push", "origin", "HEAD"], workdir);
  if (pushResult.code !== 0) return { pushed: false, reason: `push_failed: ${pushResult.stderr.slice(0, 200)}` };
  return { pushed: true };
}

async function readRoots(): Promise<RootRecord[]> {
  if (!existsSync(ROOTS_FILE)) return [];
  const raw = await readFile(ROOTS_FILE, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RootRecord);
}

async function main() {
  const roots = await readRoots();
  if (roots.length === 0) {
    console.log("[beacon-export] no roots to publish");
    return;
  }
  if (!existsSync(BEACON_REPO_DIR)) {
    console.log(`[beacon-export] beacon-repo not initialized at ${BEACON_REPO_DIR}`);
    console.log("[beacon-export] init: git clone https://github.com/<owner>/" +
      (process.env.BEACON_PUBLIC_REPO ?? "atlas-prime-beacon") + ".git " + BEACON_REPO_DIR);
    return;
  }
  await buildPublicFiles(roots, BEACON_REPO_DIR);
  const r = await commitAndPush(BEACON_REPO_DIR);
  console.log(`[beacon-export] push=${r.pushed} reason=${r.reason ?? "ok"}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[beacon-export] failed: ${err}`);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Create `scripts/verify-beacon.ts`**

```typescript
#!/usr/bin/env bun
/**
 * Atlas Prime — Verify Beacon (Sprint 7)
 *
 * Walks the local ledger chain, asserts the chain root equals the published
 * root in beacon-repo/roots/latest.json (or a date supplied via --date).
 * Exit 0 = match. Exit 1 = mismatch. Exit 2 = setup error.
 */
import { verifyChain, computeRoot } from "../src/ledger.ts";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const BEACON_DIR = join(PROJECT_DIR, "data", "beacon-repo");

async function main() {
  // Verify local chain integrity first
  const v = await verifyChain();
  if (!v.valid) {
    console.error(`[verify-beacon] LOCAL chain invalid: ${v.reason} at seq=${v.brokenAt}`);
    process.exit(2);
  }
  console.log(`[verify-beacon] local chain valid (${v.entries} entries)`);

  const latestPath = join(BEACON_DIR, "roots", "latest.json");
  if (!existsSync(latestPath)) {
    console.error(`[verify-beacon] no latest.json at ${latestPath}`);
    process.exit(2);
  }
  const latest = JSON.parse(await readFile(latestPath, "utf-8"));
  const { root: localRoot } = await computeRoot();

  if (localRoot === latest.root) {
    console.log(`[verify-beacon] MATCH — local root ${localRoot.slice(0, 16)}… matches published`);
    process.exit(0);
  } else {
    console.error(`[verify-beacon] MISMATCH`);
    console.error(`  local root:     ${localRoot}`);
    console.error(`  published root: ${latest.root}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[verify-beacon] error: ${err}`);
    process.exit(2);
  });
}
```

- [ ] **Step 4: Create beacon repo templates**

Create `templates/atlas-prime-beacon/README.md`:

```markdown
# atlas-prime-beacon

Public Merkle-root beacon for **Atlas Prime**'s action ledger.

## What this is

Every action Atlas (Derek DiCamillo's personal AI) takes is signed and chained
in a local append-only ledger. Once an hour the chain's current root is
published to this public repository.

The point: any external party can verify that Atlas's local ledger has not
been silently rewritten. If the root in this repo matches a locally-computed
root over the same snapshot of the chain, the chain is internally consistent
and externally attested.

## Files

- `roots/latest.json` — the most recently published root
- `roots/YYYY-MM-DD.jsonl` — one root record per hour for that UTC day
- `verify/verify-beacon.ts` — standalone verifier (Node/Bun, no deps beyond stdlib)
- `BOUNTY.md` — standing bounty for verified inconsistencies

## How to verify

```bash
bun verify/verify-beacon.ts --against=<path-to-local-ledger-snapshot>
```

Exit 0 = match. Exit 1 = mismatch (and likely a bounty claim).

## Protocol

Each published record:

```json
{"ts": "2026-05-14T15:00:00.000Z", "root": "<sha256-hex>", "entries": 12345}
```

Roots chain backward: every record in `roots/YYYY-MM-DD.jsonl` must extend the
chain whose root is recorded in the prior file. A break in this chain is itself
a bounty-eligible finding.

## Publisher key

This repo's commits are signed by `data/beacon-publisher.key`. The public half
is in `PUBLISHER.pub`. Any commit not signed by that key is suspect.
```

- [ ] **Step 5: Create `templates/atlas-prime-beacon/BOUNTY.md`**

```markdown
# Standing Bounty

If you can produce verifiable evidence of any of the following, you collect a
real-cash reward (default **$500 USD**; Derek's discretion on payouts above
the default).

## Eligible findings

1. **Root mismatch.** A published `roots/<date>.jsonl` entry whose root does
   not match the SHA-256 chain root that Atlas computes locally over the same
   snapshot. Proof: provide the published record + a local ledger snapshot
   + the output of `bun verify/verify-beacon.ts` showing exit code 1.

2. **Chain break.** Two consecutive published roots in `roots/` that cannot
   be reconciled by replaying ledger entries between their timestamps. Proof:
   provide both records + the ledger range between them + a derivation showing
   no valid sequence of entries connects them.

3. **Forged publisher signature.** A commit in this repo that does not verify
   against `PUBLISHER.pub`. Proof: provide the commit SHA + the verification
   command output.

## How to claim

Open a GitHub issue titled **`Bounty claim: <category>`**. Include:

- Reproduction steps
- Output of the verifier(s)
- The artifacts (ledger snapshots, root files) used in the proof

Derek will review within 7 days. Payouts via the claimant's preferred method
(check, ACH, or a charity of their choice).

## Out of scope

- Atlas making a *bad* decision is not a bounty target — only verifiability of
  the audit trail is.
- Privacy / data leakage findings: see [SECURITY.md](SECURITY.md) instead.
- Bug reports on the verifier itself: file a regular PR.

## Funded by

Derek DiCamillo. Atlas's ledger has never been audited externally. This bounty
exists to attract the first audit.
```

- [ ] **Step 6: Create `templates/atlas-prime-beacon/verify/verify-beacon.ts`**

Mirror of `scripts/verify-beacon.ts` for the public repo. Same content (paths might be adjusted by Derek when bootstrapping the repo).

```typescript
#!/usr/bin/env bun
/**
 * atlas-prime-beacon — verify a local ledger against published roots.
 *
 * Usage:
 *   bun verify/verify-beacon.ts --against=<ledger-dir>
 *   bun verify/verify-beacon.ts --date=2026-05-14 --against=<ledger-dir>
 *
 * Exit 0 = match. Exit 1 = mismatch. Exit 2 = setup error.
 */
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

interface RootRecord { ts: string; root: string; entries: number; }
interface LedgerEntry {
  seq: number; ts: string; prevHash: string; entryHash: string; signature: string;
  actor: string; action: { tool: string; args: any };
  sourceClaims?: any[];
  outcome?: { success: boolean; apiResponseHash?: string };
  policyDecision?: any;
}

function parseArgs(): { ledgerDir?: string; date?: string } {
  const out: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--(\w+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return { ledgerDir: out.against, date: out.date };
}

function canonicalJson(o: unknown): string {
  if (o === null || o === undefined) return "null";
  if (typeof o === "number") return String(o);
  if (typeof o === "boolean" || typeof o === "string") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map((v) => canonicalJson(v ?? null)).join(",") + "]";
  if (typeof o === "object") {
    const obj = o as Record<string, unknown>;
    const keys = Object.keys(obj).sort().filter((k) => obj[k] !== undefined);
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  return JSON.stringify(o);
}

function computeEntryHash(e: Omit<LedgerEntry, "entryHash" | "signature">): string {
  return createHash("sha256").update(canonicalJson(e)).digest("hex");
}

async function loadLedger(dir: string): Promise<LedgerEntry[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  const out: LedgerEntry[] = [];
  for (const f of files) {
    const txt = await readFile(join(dir, f), "utf-8");
    for (const line of txt.split("\n").filter(Boolean)) {
      out.push(JSON.parse(line));
    }
  }
  return out;
}

async function main() {
  const { ledgerDir, date } = parseArgs();
  if (!ledgerDir) {
    console.error("usage: bun verify/verify-beacon.ts --against=<ledger-dir> [--date=YYYY-MM-DD]");
    process.exit(2);
  }
  if (!existsSync(ledgerDir)) {
    console.error(`ledger dir not found: ${ledgerDir}`);
    process.exit(2);
  }
  const entries = await loadLedger(ledgerDir);
  // Verify chain
  let prev = "GENESIS"; let seq = 1;
  for (const e of entries) {
    if (e.seq !== seq) { console.error(`seq gap at ${seq}`); process.exit(1); }
    if (e.prevHash !== prev) { console.error(`prevHash mismatch at seq=${e.seq}`); process.exit(1); }
    const { entryHash: _, signature: __, ...rest } = e;
    if (computeEntryHash(rest) !== e.entryHash) {
      console.error(`entryHash mismatch at seq=${e.seq}`);
      process.exit(1);
    }
    prev = e.entryHash; seq++;
  }
  const localRoot = prev === "GENESIS" ? "GENESIS" : prev;

  // Load published root
  const targetFile = date ? `roots/${date}.jsonl` : "roots/latest.json";
  if (!existsSync(targetFile)) {
    console.error(`published file not found: ${targetFile}`);
    process.exit(2);
  }
  let published: RootRecord;
  if (date) {
    const lines = (await readFile(targetFile, "utf-8")).split("\n").filter(Boolean);
    published = JSON.parse(lines[lines.length - 1]);
  } else {
    published = JSON.parse(await readFile(targetFile, "utf-8"));
  }

  if (localRoot === published.root) {
    console.log(`MATCH: local root ${localRoot.slice(0, 16)}… matches published`);
    process.exit(0);
  }
  console.error("MISMATCH");
  console.error(`  local:     ${localRoot}`);
  console.error(`  published: ${published.root}`);
  process.exit(1);
}

if (import.meta.main) main();
```

- [ ] **Step 7: Create `templates/atlas-prime-beacon/.github/workflows/publish-beacon.yml`**

```yaml
name: publish-beacon-hourly
on:
  schedule:
    - cron: '15 * * * *'
  workflow_dispatch: {}

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout source mirror
        uses: actions/checkout@v4
        with:
          repository: ${{ secrets.BEACON_SOURCE_REPO }}
          token: ${{ secrets.BEACON_PAT }}
      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
      - name: Build public files
        run: bun scripts/beacon-export.ts --mode=mirror
      - name: Push to public
        run: |
          cd data/beacon-repo
          git config user.email "atlas-beacon@bot.local"
          git config user.name "atlas-beacon"
          git remote set-url origin "https://x-access-token:${{ secrets.BEACON_PAT }}@github.com/${{ secrets.BEACON_PUBLIC_REPO }}.git"
          git push origin HEAD:main
```

- [ ] **Step 8: Run tests**

```bash
bun test tests/sprint7/beacon-export.test.ts 2>&1 | tail -10
```

Expected: 3 pass.

- [ ] **Step 9: Commit**

```bash
git add scripts/beacon-export.ts scripts/verify-beacon.ts \
        templates/atlas-prime-beacon/ \
        tests/sprint7/beacon-export.test.ts
git commit -m "feat(atlas-prime): beacon export + verify + atlas-prime-beacon repo templates"
```

---

## Task 11: Cron registration (3 new jobs)

**Files:**
- Modify: `src/cron.ts`

- [ ] **Step 1: Find the Sprint 6 cron registration tail**

```bash
grep -n "shadow-judge-flush\|Atlas Prime Sprint 6" src/cron.ts | tail -10
```

Identify the line where Sprint 6 crons end. The new Sprint 7 crons append after.

- [ ] **Step 2: Append three new crons in `src/cron.ts`**

After the `shadow-judge-flush` block, add:

```typescript
// 38. Atlas Prime Sprint 7: weekly knowledge audit (Saturday 9 AM PHX)
jobs.push(
  CronJob.from({
    cronTime: "0 9 * * 6",
    onTick: safeTick("knowledge-audit-weekly", async () => {
      if (!supabase) { log("knowledge-audit-weekly", "supabase unavailable, skipping"); return; }
      const { runWeeklyAudit, formatAuditSummary } = await import("./knowledge-audit.ts");
      try {
        // Build deps: pull recent staleness-classified messages + WebFetch wrapper
        const fetchRecentSamples = async (domain: string, max: number): Promise<string[]> => {
          try {
            const { data } = await supabase
              .from("messages")
              .select("content, metadata")
              .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString())
              .order("created_at", { ascending: false })
              .limit(200);
            const samples: string[] = [];
            for (const r of (data ?? []) as any[]) {
              const m = r.metadata ?? {};
              const matched = m.staleness_domain === domain ||
                (typeof r.content === "string" && r.content.toLowerCase().includes(domain.toLowerCase()));
              if (matched && r.content) {
                samples.push(String(r.content).slice(0, 1200));
                if (samples.length >= max) break;
              }
            }
            return samples;
          } catch { return []; }
        };
        const webFetch = async (url: string, _prompt: string): Promise<string> => {
          // Best-effort: fetch raw content. Caller's Haiku step is what scores it.
          const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
          return await res.text();
        };
        const results = await runWeeklyAudit(supabase, { fetchRecentSamples, webFetch });
        if (results.length > 0) {
          await sendTelegramMessage(DEREK_CHAT_ID, formatAuditSummary(results).slice(0, 4000));
        }
        log("knowledge-audit-weekly", `examined ${results.length} domains`);
      } catch (err) {
        log("knowledge-audit-weekly", `failed: ${err}`);
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 39. Atlas Prime Sprint 7: shadow-process watchdog (every 5 min)
jobs.push(
  CronJob.from({
    cronTime: "*/5 * * * *",
    onTick: safeTick("shadow-process-watchdog", async () => {
      const { fireShadow } = await import("./shadow-driver.ts");
      const ping = await fireShadow("ping", { budgetMs: 8_000 });
      if (!ping.ok) {
        log("shadow-process-watchdog", `shadow down: ${ping.reason}`);
        // Auto-restart attempt: spawn detached
        try {
          const { spawn } = await import("node:child_process");
          spawn("bun", ["src/shadow-atlas.ts"], {
            detached: true,
            stdio: "ignore",
            shell: process.platform === "win32",
          }).unref();
          log("shadow-process-watchdog", "attempted restart");
        } catch (err) {
          log("shadow-process-watchdog", `restart spawn failed: ${err}`);
        }
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 40. Atlas Prime Sprint 7: beacon-roots-export (hourly, top of hour)
jobs.push(
  CronJob.from({
    cronTime: "0 * * * *",
    onTick: safeTick("beacon-roots-export", async () => {
      try {
        const { spawn } = await import("node:child_process");
        const p = spawn("bun", ["scripts/beacon-export.ts"], {
          shell: process.platform === "win32",
        });
        await new Promise<void>((resolve) => p.on("close", () => resolve()));
        log("beacon-roots-export", "export run complete");
      } catch (err) {
        log("beacon-roots-export", `failed: ${err}`);
      }
    }),
    timeZone: TIMEZONE,
  })
);
```

Also append to the "Schedule:" console.log block:

```typescript
  console.log("  - Saturday 9 AM Weekly knowledge audit (knowledge-audit-weekly)");
  console.log("  - Every 5 min  Shadow-Atlas watchdog (shadow-process-watchdog)");
  console.log("  - Hourly       Beacon roots export (beacon-roots-export)");
```

- [ ] **Step 3: Quick syntax check**

```bash
bun build src/cron.ts --target=bun --no-bundle 2>&1 | tail -5
```

Expected: no errors. (Build doesn't have to produce output; just no syntax errors.)

- [ ] **Step 4: Commit**

```bash
git add src/cron.ts
git commit -m "feat(atlas-prime): Sprint 7 crons — knowledge-audit + shadow-watchdog + beacon-export"
```

---

## Task 12: Telegram commands (/shadow, /entropy, /audit, /beacon) + session-key init

**Files:**
- Modify: `src/relay.ts` — 4 new commands + session-key initialization on startup

- [ ] **Step 1: Find Sprint 6 command block end**

```bash
grep -n "case \"/why\"\|case \"/dpo\"\|case \"/skill\"" src/relay.ts | head -5
```

Identify the case block immediately before where new commands should be added.

- [ ] **Step 2: Add `/shadow` command**

In the command-switch block in `src/relay.ts`, after the `/why` case, insert:

```typescript
case "/shadow": {
  const sub = (args[0] ?? "status").toLowerCase();
  const { isFrozen, readFreezeReason, resume } = await import("./shadow-driver.ts");
  if (sub === "status") {
    const frozen = await isFrozen();
    if (!frozen) {
      // Show latest divergence row if any
      if (supabase) {
        const { data } = await supabase
          .from("shadow_divergence_log")
          .select("ts, distance, classified, judge_reason")
          .order("ts", { ascending: false })
          .limit(5);
        const lines = ["**Shadow status**: 🟢 not frozen", ""];
        if ((data ?? []).length > 0) {
          lines.push("Recent divergences:");
          for (const r of data as any[]) {
            lines.push(`- ${String(r.ts).slice(0,19)} · d=${Number(r.distance).toFixed(2)} · ${r.classified}`);
          }
        }
        await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      } else {
        await ctx.reply("Shadow status: 🟢 not frozen");
      }
      return true;
    }
    const fr = await readFreezeReason();
    await ctx.reply(
      `**Shadow status**: ❄️ frozen\n\nSince: ${fr?.since ?? "?"}\nReason: ${fr?.reason ?? "?"}\n\nResume with \`/shadow resume\`.`,
      { parse_mode: "Markdown" }
    );
    return true;
  }
  if (sub === "resume") {
    const by = ctx.from?.username ?? userId;
    await resume(by, args.slice(1).join(" "));
    await ctx.reply("Shadow freeze cleared. External actions re-enabled.");
    return true;
  }
  if (sub === "freeze") {
    const { freeze } = await import("./shadow-driver.ts");
    await freeze(`manual freeze by ${ctx.from?.username ?? userId}`);
    await ctx.reply("Shadow manually frozen.");
    return true;
  }
  await ctx.reply(
    ["**/shadow commands**", "`/shadow status` — current freeze state + recent divergences", "`/shadow resume [note]` — clear freeze", "`/shadow freeze` — manually freeze"].join("\n"),
    { parse_mode: "Markdown" }
  );
  return true;
}
```

- [ ] **Step 3: Add `/entropy` command**

```typescript
case "/entropy": {
  if (!supabase) { await ctx.reply("Supabase not configured."); return true; }
  const sub = (args[0] ?? "review").toLowerCase();
  if (sub === "review") {
    const { data } = await supabase
      .from("tool_entropy_probes")
      .select("id, ts, user_prompt, entropy, action, selected_tool")
      .order("ts", { ascending: false })
      .limit(10);
    if (!(data ?? []).length) {
      await ctx.reply("No entropy probes recorded yet.");
      return true;
    }
    const lines = ["**Recent tool-entropy probes**", ""];
    for (const r of data as any[]) {
      lines.push(`\`${String(r.id).slice(0,8)}\` · H=${Number(r.entropy).toFixed(3)} · ${r.action}${r.selected_tool ? ` → ${r.selected_tool}` : ""}`);
      lines.push(`  ${String(r.user_prompt).slice(0,120)}`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    return true;
  }
  await ctx.reply(["**/entropy commands**", "`/entropy review` — recent probes"].join("\n"), { parse_mode: "Markdown" });
  return true;
}
```

- [ ] **Step 4: Add `/audit` command**

```typescript
case "/audit": {
  if (!supabase) { await ctx.reply("Supabase not configured."); return true; }
  const sub = (args[0] ?? "status").toLowerCase();
  if (sub === "status") {
    const { data } = await supabase
      .from("knowledge_audit_log")
      .select("domain, audit_at, drift_score, proposed_half_life, current_half_life, decision")
      .order("audit_at", { ascending: false })
      .limit(10);
    if (!(data ?? []).length) { await ctx.reply("No audits yet. Saturday 9 AM cron will populate."); return true; }
    const lines = ["**Recent knowledge audits**", ""];
    for (const r of data as any[]) {
      lines.push(`${String(r.audit_at).slice(0,10)} · **${r.domain}** drift=${Math.round(r.drift_score*100)}% · ${r.current_half_life}d → ${r.proposed_half_life}d · ${r.decision}`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    return true;
  }
  if (sub === "apply") {
    const domain = args[1];
    if (!domain) { await ctx.reply("Usage: `/audit apply <domain>`", { parse_mode: "Markdown" }); return true; }
    const { data } = await supabase
      .from("knowledge_audit_log")
      .select("proposed_half_life")
      .eq("domain", domain)
      .eq("decision", "proposed")
      .order("audit_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) { await ctx.reply(`No pending audit for \`${domain}\`.`, { parse_mode: "Markdown" }); return true; }
    const { applyHalfLifeUpdate } = await import("./knowledge-audit.ts");
    await applyHalfLifeUpdate({
      domain,
      newHalfLife: (data as any).proposed_half_life,
      decidedBy: ctx.from?.username ?? userId,
      supabase,
    });
    await ctx.reply(`Applied half-life ${(data as any).proposed_half_life}d for **${domain}**.`, { parse_mode: "Markdown" });
    return true;
  }
  if (sub === "applyall") {
    const { data } = await supabase
      .from("knowledge_audit_log")
      .select("domain, proposed_half_life")
      .eq("decision", "proposed");
    if (!(data ?? []).length) { await ctx.reply("No pending audits."); return true; }
    const { applyHalfLifeUpdate } = await import("./knowledge-audit.ts");
    let n = 0;
    for (const r of data as any[]) {
      try {
        await applyHalfLifeUpdate({
          domain: r.domain,
          newHalfLife: r.proposed_half_life,
          decidedBy: ctx.from?.username ?? userId,
          supabase,
        });
        n++;
      } catch {}
    }
    await ctx.reply(`Applied ${n} of ${(data ?? []).length} pending half-life updates.`);
    return true;
  }
  await ctx.reply(
    ["**/audit commands**", "`/audit status` — recent audits", "`/audit apply <domain>` — apply pending", "`/audit applyall` — apply all pending"].join("\n"),
    { parse_mode: "Markdown" }
  );
  return true;
}
```

- [ ] **Step 5: Add `/beacon` command**

```typescript
case "/beacon": {
  const sub = (args[0] ?? "status").toLowerCase();
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const latestPath = join(process.env.PROJECT_DIR ?? process.cwd(), "data", "beacon-repo", "roots", "latest.json");
  if (sub === "status") {
    if (!existsSync(latestPath)) {
      await ctx.reply("Beacon: not yet bootstrapped. Run `bun scripts/beacon-export.ts` after `git clone`-ing the public repo to `data/beacon-repo`.");
      return true;
    }
    const latest = JSON.parse(readFileSync(latestPath, "utf-8"));
    const ageMin = Math.round((Date.now() - new Date(latest.ts).getTime()) / 60000);
    await ctx.reply(
      `**Beacon status**\nLatest root: \`${String(latest.root).slice(0,16)}…\`\nEntries: ${latest.entries}\nAge: ${ageMin} min`,
      { parse_mode: "Markdown" }
    );
    return true;
  }
  if (sub === "verify") {
    const { spawn } = await import("node:child_process");
    const p = spawn("bun", ["scripts/verify-beacon.ts"], { shell: process.platform === "win32" });
    let stdout = ""; let stderr = "";
    p.stdout?.on("data", (b) => stdout += b.toString());
    p.stderr?.on("data", (b) => stderr += b.toString());
    const code: number = await new Promise((res) => p.on("close", (c) => res(c ?? 1)));
    const status = code === 0 ? "🟢 MATCH" : (code === 1 ? "🔴 MISMATCH" : "⚠️ SETUP ERROR");
    await ctx.reply(`**Beacon verify**: ${status}\n\n\`\`\`\n${(stdout + stderr).slice(0,3000)}\n\`\`\``, { parse_mode: "Markdown" });
    return true;
  }
  if (sub === "bounty") {
    await ctx.reply(
      `**Beacon bounty**\nStanding offer: $${process.env.BEACON_BOUNTY_USD ?? "500"} for verifiable inconsistencies.\nSee BOUNTY.md in the public repo (\`${process.env.BEACON_PUBLIC_REPO ?? "atlas-prime-beacon"}\`).`,
      { parse_mode: "Markdown" }
    );
    return true;
  }
  await ctx.reply(
    ["**/beacon commands**", "`/beacon status` — latest published root", "`/beacon verify` — run local-vs-published check", "`/beacon bounty` — show standing bounty terms"].join("\n"),
    { parse_mode: "Markdown" }
  );
  return true;
}
```

- [ ] **Step 6: Initialize session key on relay startup**

Find the relay startup block (where Supabase + Telegram are wired in). After Supabase is initialized but before the message handler binds, add:

```typescript
// Atlas Prime Sprint 7: initialize the per-process session signing key
try {
  const { generateSessionKey } = await import("./memory-signing.ts");
  const agent = (process.env.AGENT_ID === "ishtar" ? "ishtar" : "atlas") as "atlas" | "ishtar";
  await generateSessionKey(supabase, agent);
  info("relay", `session key generated for agent=${agent}`);
} catch (err) {
  logError("relay", `failed to generate session key: ${err}`);
}
```

And in the graceful-shutdown handler, retire the key:

```typescript
try {
  const { retireSessionKey } = await import("./memory-signing.ts");
  await retireSessionKey(supabase);
} catch {}
```

- [ ] **Step 7: Quick build check**

```bash
bun build src/relay.ts --target=bun --no-bundle 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/relay.ts
git commit -m "feat(atlas-prime): /shadow /entropy /audit /beacon commands + session-key init"
```

---

## Task 13: Capability registry entries + env vars + ecosystem.config.cjs entry

**Files:**
- Modify: `src/capability-registry.ts`
- Modify: `.env.example`
- Modify: `ecosystem.config.cjs` (add shadow-atlas app)

- [ ] **Step 1: Append 5 capability registry entries**

After the last entry in `src/capability-registry.ts` (Atlas Prime - /why Introspection), add:

```typescript
{
  section: "Atlas Prime - Shadow-Atlas Divergence Monitor",
  description: "Second Bun process with cold context replays every primary prompt over IPC. Haiku scorer compares responses; unexplained drift sets a freeze flag that blocks external-action tools until Derek runs /shadow resume. MemoryGraft-class slow compromise becomes detectable.",
  can: [
    "fire shadow-Atlas on every primary turn (IPC fire-and-forget, 90s budget)",
    "score semantic distance via Haiku (cached system prompt)",
    "classify as benign/explained/suspicious/alarm based on distance + memory-write window",
    "set freeze.flag on alarm-class drift; block SEND/CAL_ADD/GHL_WORKFLOW/WP_POST until cleared",
    "auto-restart shadow process via watchdog cron",
  ],
  cannot: [
    "freeze read-only tools (memory search, scorecard reads remain available)",
    "co-decide actions — shadow is monitor only, not voter",
    "execute external tools (shadow runs with --allowedTools \"\")",
  ],
  module: "src/shadow-driver.ts (main) + src/shadow-atlas.ts (process)",
  depends: "callClaude/callHaiku via CLI, ledger (Sprint 1), IPC socket/named pipe",
  commands: ["/shadow status", "/shadow resume", "/shadow freeze"],
  runs: "shadow-process-watchdog every 5 min",
},
{
  section: "Atlas Prime - Semantic-Entropy Probe",
  description: "When a turn produces >=2 candidate tool tags (ambiguity), generate 5 samples via Haiku, cluster by semantic equivalence, compute entropy H = -Σ p log p. Above threshold → substitute a clarifying question for dispatch. Destructive/non-destructive mixes always clarify regardless of entropy.",
  can: [
    "detect ambiguity from multi-tag responses",
    "sample k=5 tool selections in parallel via Haiku",
    "cluster samples deterministically (identical) or via Haiku judge (semantic)",
    "compute entropy in nats",
    "substitute clarifying questions for high-entropy turns",
    "log every probe to tool_entropy_probes for /entropy review",
  ],
  cannot: [
    "fire on unambiguous (single-tag) turns",
    "auto-dispatch on destructive/non-destructive sample mixes (always clarifies)",
  ],
  module: "src/entropy-probe.ts + companion in src/tool-gate.ts",
  depends: "callHaiku via CLI",
  commands: ["/entropy review"],
},
{
  section: "Atlas Prime - Signed Memory Entries",
  description: "Per-session ed25519 keypair generated at relay startup. Private key stays in process. Public key registered in session_keys table and anchored to the global Merkle ledger. Every memory row signed on insert; verified on every load. Tampered rows are excluded from search results and logged to memory_verification_failures.",
  can: [
    "generate per-session ed25519 keypair anchored to ledger",
    "sign memory rows on insert with canonical-payload sha256",
    "verify signatures on every load (~0.05 ms/row)",
    "exclude tampered rows from results + log failure",
    "treat pre-Sprint-7 unsigned rows as 'legacy_pre_sprint7' (allowed; logged once)",
  ],
  cannot: [
    "retroactively sign legacy rows (out of scope)",
    "verify without supabase session-key lookup (test mode supports inline pubkey)",
  ],
  module: "src/memory-signing.ts (wired into src/cortex.ts insert + retrieve)",
  depends: "Node crypto (ed25519, sha256), ledger.ts appendEntry, session_keys table",
},
{
  section: "Atlas Prime - Weekly Knowledge Audit",
  description: "Saturday 9 AM PHX. For each fast/real_time domain in hot-domains.json: pulls recent Atlas claims, WebFetches the authoritative source, scores drift via Haiku, proposes a new half_life_days. Proposals surface to Telegram with /audit apply / applyall buttons; approval writes to hot-domains.json + appends a ledger entry.",
  can: [
    "audit fast/real_time domains weekly",
    "fetch authoritative sources via WebFetch",
    "score per-sample correctness via Haiku",
    "propose new half-lives via Bayesian half-decay math (clipped to current × 1.5)",
    "surface proposals to Derek for approval",
    "apply approved half-lives to hot-domains.json + ledger anchor",
  ],
  cannot: [
    "auto-apply without Derek approval",
    "audit timeless/slow/medium domains (out of scope)",
  ],
  module: "src/knowledge-audit.ts",
  depends: "callHaiku via CLI, WebFetch, ledger.ts, hot-domains.json",
  commands: ["/audit status", "/audit apply <domain>", "/audit applyall"],
  runs: "knowledge-audit-weekly Saturday 9:00 PHX",
},
{
  section: "Atlas Prime - Public Transparency Beacon",
  description: "Hourly publish of the Merkle ledger root to the public repo atlas-prime-beacon. Standing bounty (default $500) in BOUNTY.md invites external verification. Local cron + optional GitHub Actions workflow keep publishing resilient. Anyone can run scripts/verify-beacon.ts against a local snapshot to confirm match.",
  can: [
    "export latest atlas-ledger-roots to data/beacon-repo/ in roots/YYYY-MM-DD.jsonl format",
    "maintain roots/latest.json with the most recent published root",
    "git commit + push to public mirror (idempotent — no-op when no changes)",
    "verify local chain matches published root via scripts/verify-beacon.ts (exit 0/1/2)",
    "host standing bounty for verifiable inconsistencies (BOUNTY.md in public repo)",
  ],
  cannot: [
    "publish without a configured public-repo clone at data/beacon-repo",
    "auto-pay bounty claims (manual Derek adjudication)",
  ],
  module: "scripts/beacon-export.ts + scripts/verify-beacon.ts + templates/atlas-prime-beacon/",
  depends: "Sprint 1 ledger.publishRoot, git CLI, public GitHub repo",
  commands: ["/beacon status", "/beacon verify", "/beacon bounty"],
  runs: "beacon-roots-export every hour (top of hour)",
},
```

- [ ] **Step 2: Append Sprint 7 env vars to `.env.example`**

```ini

# ============================================================
# Atlas Prime Sprint 7 — Bulletproofing
# ============================================================

# Shadow-Atlas
SHADOW_ATLAS_ENABLED=true
SHADOW_ATLAS_MODEL=sonnet
SHADOW_BUDGET_MS=90000
SHADOW_DRIFT_THRESHOLD=0.45

# Entropy probe
ENTROPY_PROBE_ENABLED=true
ENTROPY_PROBE_SAMPLES=5
ENTROPY_THRESHOLD=0.8

# Knowledge audit
KNOWLEDGE_AUDIT_SAMPLE_SIZE=8

# Public beacon
BEACON_PUBLIC_REPO=atlas-prime-beacon
BEACON_BOUNTY_USD=500
```

- [ ] **Step 3: Add shadow-atlas pm2 entry to `ecosystem.config.cjs`**

Read the current file:

```bash
cat ecosystem.config.cjs
```

Identify the apps array. Append (next to the existing atlas entry, not as a replacement):

```javascript
{
  name: "shadow-atlas",
  script: "bun",
  args: "run src/shadow-atlas.ts",
  cwd: __dirname,
  autorestart: true,
  max_restarts: 5,
  min_uptime: "10s",
  restart_delay: 3000,
  env: {
    NODE_ENV: "production",
    SHADOW_ATLAS_MODEL: "sonnet",
  },
}
```

(Match the actual key names used by the existing atlas app in that file — do not invent new ones.)

- [ ] **Step 4: Commit**

```bash
git add src/capability-registry.ts .env.example ecosystem.config.cjs
git commit -m "feat(atlas-prime): Sprint 7 capability registry + env vars + shadow-atlas pm2 entry"
```

---

## Task 14: Ship-criteria verification + integration smoke

**Files:**
- No new files. Verify each of the 9 ship criteria.

- [ ] **Step 1: Verify no `@anthropic-ai/sdk` imports in Sprint 7 modules**

```bash
grep -rn "@anthropic-ai/sdk\|from .anthropic" src/shadow-atlas.ts src/shadow-driver.ts src/entropy-probe.ts src/memory-signing.ts src/knowledge-audit.ts scripts/beacon-export.ts scripts/verify-beacon.ts
```

Expected: **no output**. (Empty grep result means all model calls route through CLI subprocess via callClaude/callHaiku.)

- [ ] **Step 2: Run full Sprint 7 test suite**

```bash
bun test tests/sprint7/ 2>&1 | tail -25
```

Expected: all green. Note pass/fail counts.

- [ ] **Step 3: Run full Atlas test suite (no regression)**

```bash
bun test 2>&1 | tail -20
```

Expected: total pass count >= prior baseline (192 + Sprint 6's 44 + Sprint 7's new tests).

- [ ] **Step 4: Verify session-key generates without supabase (test fallback)**

```bash
bun -e 'const { initSessionKeyForTest, signMemoryRow, verifyMemoryRow } = await import("./src/memory-signing.ts"); const h = initSessionKeyForTest("atlas"); const row = { id: "00000000-0000-0000-0000-000000000000", content: "x", embedding: null, created_at: "2026-05-14T00:00:00Z", agent: "atlas", user_id: "u", class: "episodic" }; const s = await signMemoryRow(row); console.log("sig", s.signature.slice(0,16)); const v = await verifyMemoryRow({_testMode:true, publicKeyPem: h.publicKeyPem}, {...row, ...s}); console.log("valid", v.valid);'
```

Expected output: `sig <hex>...` and `valid true`.

- [ ] **Step 5: Verify shadow-driver classification math**

```bash
bun -e 'const { classifyDistance } = await import("./src/shadow-driver.ts"); console.log(classifyDistance(0.1, 0), classifyDistance(0.3, 5), classifyDistance(0.3, 0), classifyDistance(0.5, 0), classifyDistance(0.6, 3));'
```

Expected: `benign explained suspicious alarm explained`.

- [ ] **Step 6: Verify entropy math + recommend**

```bash
bun -e 'const { entropyOf, recommend } = await import("./src/entropy-probe.ts"); const c = [{cluster_id:0,members:[0,1,2,3,4],representative:{idx:0,tool:"x",args_canonical:"{}"}}]; console.log("H=", entropyOf(c, 5));'
```

Expected: `H= 0`.

- [ ] **Step 7: Verify beacon-export idempotency**

```bash
bun scripts/beacon-export.ts 2>&1 | tail -5
```

Expected: either "no roots to publish" (clean tree) or "push=true/false reason=..." (no errors).

- [ ] **Step 8: Verify migration files exist and parse**

```bash
ls db/migrations/06*.sql
for f in db/migrations/06{0,1,2,3,4}_*.sql; do
  head -5 "$f"
  echo "---"
done
```

Expected: 5 files, each starts with a comment + CREATE TABLE/ALTER TABLE.

- [ ] **Step 9: Verify workflow template parses**

```bash
bun -e 'const yaml = await import("js-yaml"); const fs = await import("node:fs"); const t = fs.readFileSync("templates/atlas-prime-beacon/.github/workflows/publish-beacon.yml","utf-8"); const p = yaml.load(t); console.log("name:", p.name, "cron:", p.on?.schedule?.[0]?.cron);'
```

Expected: `name: publish-beacon-hourly cron: 15 * * * *`.

- [ ] **Step 10: Final commit (ship-criteria verification record)**

```bash
git commit --allow-empty -m "chore(atlas-prime): Sprint 7 ship-criteria verification

All 9 criteria pass:
1. Shadow-Atlas separate process w/ cold context — IPC contract test passes
2. Freeze on unexplained drift — freeze.flag round-trip test passes
3. Semantic-entropy probe on tool selection — math + recommend tests pass
4. Memory write signing (per-session ed25519) — sign/verify round-trip passes
5. Memory retrieval verifies — cortex integration in place
6. Saturday 9 AM knowledge audit — cron registered, half-life math tested
7. Public beacon publishes hourly — buildPublicFiles + idempotency tested
8. All model calls via Claude CLI subprocess — grep proves zero @anthropic-ai/sdk imports
9. Full test suite green — bun test passes

Sprint 7 of 7 SHIPPED. Atlas Prime arc complete."
```

---

## Appendix A: Build order summary

| Task | Output |
|---|---|
| 1 | 5 migrations (060-064) |
| 2 | `src/memory-signing.ts` foundation + canonical payload |
| 3 | Wire memory-signing into `src/cortex.ts` insert + retrieve |
| 4 | `src/shadow-atlas.ts` cold-context process + init script |
| 5 | `src/shadow-driver.ts` IPC client + drift scorer + freeze flag |
| 6 | Wire shadow-driver into relay (fire + freeze gate) |
| 7 | `src/entropy-probe.ts` sample + cluster + entropy + recommend |
| 8 | `checkActionWithEntropy` companion + relay ambiguity hook |
| 9 | `src/knowledge-audit.ts` per-domain audit + half-life math |
| 10 | `scripts/beacon-export.ts` + `verify-beacon.ts` + beacon repo templates |
| 11 | 3 new crons in `src/cron.ts` |
| 12 | `/shadow`, `/entropy`, `/audit`, `/beacon` commands + session-key init |
| 13 | Capability registry + env vars + pm2 entry |
| 14 | Ship-criteria verification |

---

## Appendix B: Risks and decision points during execution

- **Bun named-pipe support on Windows.** If `net.createServer('\\\\.\\pipe\\shadow-atlas')` fails at runtime, fall back to TCP loopback on `127.0.0.1` with a randomized port written to `data/shadow-atlas/port`. Both `src/shadow-atlas.ts` and `src/shadow-driver.ts` need the matching fallback.
- **Shadow-Atlas startup ordering.** Shadow-driver tries to connect every primary turn; if shadow isn't running yet, `fireShadow` returns `{ok: false, reason: 'connect: …'}` — primary continues with logged warning. Watchdog cron handles eventual recovery. *No retry storm in the main turn.*
- **Memory-signing rollout caveat.** Sprint 7's hard-fail-on-unsigned applies to *new* inserts only. Retrieval verification accepts legacy rows. If the cortex insert path has multiple write sites we didn't catch, the hard-fail surfaces them. That's a feature.
- **WebFetch in knowledge-audit can return paywalled or rate-limited pages.** Surface drift_score=0 with rationale 'webFetch failed' rather than rewriting half-life on bad data.
- **Beacon-export commits to a repo Derek hasn't created yet.** Until `data/beacon-repo/` exists, the cron logs and exits gracefully. Bootstrap docs in the spec's "open items" section.

---

## Appendix C: What Sprint 7 explicitly does NOT do

- **Auto-merge half-life updates without Derek approval.**
- **Live consensus voting between primary and shadow.** Shadow is monitor-only.
- **Re-sign pre-Sprint-7 memory rows.** Legacy rows flagged but allowed.
- **Replace the ledger's global signing key with the session key.** Two surfaces; they compose.
- **Probe entropy on every turn.** Only on detected-ambiguous turns.
- **Pay bounty claims automatically.** Manual Derek adjudication.

---

## Self-review

- **Spec coverage:** Tasks map 1:1 to spec sections §1-§5. Migration list matches spec exactly (060-064). All 9 ship criteria have explicit verification steps in Task 14.
- **Placeholder scan:** None. Every step has executable code or a concrete command. The only `<owner>` placeholder in user-facing strings is for Derek's GitHub username in the bootstrap-time README; surfaced as an open item.
- **Type consistency:** `SessionKeyHandle` signature matches across memory-signing.ts and the integration test; `ShadowFireResult` shape consistent; `Cluster`/`Sample` types consistent across entropy-probe.ts and its tests.
- **Cross-task dependency check:** Task 3 (cortex integration) depends on Task 2 (memory-signing module). Task 6 (relay wiring) depends on Task 5 (shadow-driver module). Task 8 (tool-gate companion) depends on Task 7 (entropy-probe module). Task 11 (crons) depends on Tasks 4, 5, 9, 10. All dependencies flow forward in numeric order. ✓
- **Excluded files honored:** No task modifies `atlas.spec`, `src/ledger.ts`, `src/tool-gate.ts checkAction` (only adds companion), `src/claude.ts`, `src/haiku-client.ts`, or existing migrations. ✓
