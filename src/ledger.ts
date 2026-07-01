/**
 * Atlas Prime — Merkle Action Ledger
 *
 * Append-only, hash-chained, ed25519-signed record of every externally-visible
 * Atlas action. Enables tamper-evident audit trails and "why did Atlas do X on
 * March 12?" queries against an immutable record.
 *
 * Storage: data/atlas-ledger/YYYY-MM-DD.jsonl (one file per UTC day).
 * Each entry chains to the previous via SHA-256 and is signed with ed25519.
 * Security boundary (Sprint 1): key reads + signing happen in the same process
 * as Atlas-Prime. Sprint 7's Shield process moves signing to an isolated helper.
 */
import { appendFile, readFile, readdir, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  createHash,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPrivateKey,
  createPublicKey,
} from "crypto";

// Read at call-time so tests can set process.env.LEDGER_DIR in beforeAll/afterAll
// without hitting the module-level-constant-is-cached-once bun test pitfall.
function getLedgerDir(): string {
  return process.env.LEDGER_DIR || join(process.env.PROJECT_DIR || process.cwd(), "data", "atlas-ledger");
}
const KEY_FILE = join(process.env.PROJECT_DIR || process.cwd(), "data", "atlas-ledger.key");
const PUBKEY_FILE = join(process.env.PROJECT_DIR || process.cwd(), "data", "atlas-ledger.pub");

// ============================================================
// TYPES
// ============================================================

export interface SourceClaim {
  claim_id: string;
  source_file?: string;
  line_range?: string;
  sha256?: string;
}

export interface LedgerInput {
  actor: "atlas" | "ishtar" | "shield" | "system";
  action: {
    tool: string;
    args: Record<string, unknown>;
  };
  sourceClaims: SourceClaim[];
  outcome?: {
    success: boolean;
    apiResponseHash?: string;
  };
  policyDecision?: {
    spec_result: "allow" | "deny" | "defer";
    shield_result?: "allow" | "deny";
  };
}

export interface LedgerEntry extends LedgerInput {
  seq: number;
  ts: string;
  prevHash: string;
  entryHash: string;
  signature: string;
}

// ============================================================
// KEY MANAGEMENT (lazy; generate on first use, persist to disk)
// ============================================================

async function ensureKeys(): Promise<void> {
  if (existsSync(KEY_FILE)) return;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  await mkdir(join(process.env.PROJECT_DIR || process.cwd(), "data"), { recursive: true });
  await Bun.write(KEY_FILE, priv);
  await Bun.write(PUBKEY_FILE, pub);
}

// ============================================================
// APPEND
// ============================================================

function dayFile(date: Date = new Date()): string {
  const d = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(getLedgerDir(), `${d}.jsonl`);
}

function canonicalJson(o: unknown): string {
  if (o === null) return "null";
  if (typeof o === "undefined") return "null"; // defensive; callers should not pass undefined at top-level
  if (typeof o === "bigint") {
    throw new Error("canonicalJson: BigInt values are not supported in ledger entries");
  }
  if (typeof o === "number") {
    if (!Number.isFinite(o)) {
      throw new Error(`canonicalJson: non-finite number (${o}) not supported in ledger entries`);
    }
    return String(o);
  }
  if (typeof o === "boolean" || typeof o === "string") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map((v) => canonicalJson(v === undefined ? null : v)).join(",") + "]";
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

async function lastEntry(): Promise<LedgerEntry | null> {
  if (!existsSync(getLedgerDir())) return null;
  const files = (await readdir(getLedgerDir())).filter((f) => f.endsWith(".jsonl")).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const content = await readFile(join(getLedgerDir(), files[i]), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > 0) return JSON.parse(lines[lines.length - 1]);
  }
  return null;
}

export async function appendEntry(input: LedgerInput): Promise<LedgerEntry> {
  await ensureKeys();
  await mkdir(getLedgerDir(), { recursive: true });

  const prev = await lastEntry();
  const seq = (prev?.seq ?? 0) + 1;
  const prevHash = prev?.entryHash ?? "GENESIS";
  const ts = new Date().toISOString();

  const partial: Omit<LedgerEntry, "entryHash" | "signature"> = {
    ...input,
    seq,
    ts,
    prevHash,
  };
  const entryHash = computeEntryHash(partial);

  const privKeyPem = (await readFile(KEY_FILE, "utf-8")).trim();
  const privKey = createPrivateKey(privKeyPem);
  const signature = nodeSign(null, Buffer.from(entryHash, "hex"), privKey).toString("hex");

  const entry: LedgerEntry = { ...partial, entryHash, signature };
  await appendFile(dayFile(), JSON.stringify(entry) + "\n");
  return entry;
}

// ============================================================
// VERIFY
// ============================================================

export interface VerifyResult {
  valid: boolean;
  entries: number;
  brokenAt?: number;
  reason?: string;
}

export async function verifyChain(): Promise<VerifyResult> {
  if (!existsSync(getLedgerDir())) return { valid: true, entries: 0 };
  const files = (await readdir(getLedgerDir())).filter((f) => f.endsWith(".jsonl")).sort();
  const pubPem = (await readFile(PUBKEY_FILE, "utf-8")).trim();
  const pubKey = createPublicKey(pubPem);

  let expectedPrev = "GENESIS";
  let expectedSeq = 1;
  let count = 0;

  for (const f of files) {
    const content = await readFile(join(getLedgerDir(), f), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    for (const line of lines) {
      const e: LedgerEntry = JSON.parse(line);
      if (e.seq !== expectedSeq) {
        return { valid: false, entries: count, brokenAt: e.seq, reason: `seq gap: expected ${expectedSeq}, got ${e.seq}` };
      }
      if (e.prevHash !== expectedPrev) {
        return { valid: false, entries: count, brokenAt: e.seq, reason: "prevHash mismatch" };
      }
      const { entryHash: _eh, signature: _s, ...rest } = e;
      const recomputed = computeEntryHash(rest);
      if (recomputed !== e.entryHash) {
        return { valid: false, entries: count, brokenAt: e.seq, reason: "entryHash mismatch (tampering)" };
      }
      const sigOk = nodeVerify(null, Buffer.from(e.entryHash, "hex"), pubKey, Buffer.from(e.signature, "hex"));
      if (!sigOk) {
        return { valid: false, entries: count, brokenAt: e.seq, reason: "signature invalid" };
      }
      expectedPrev = e.entryHash;
      expectedSeq = e.seq + 1;
      count++;
    }
  }
  return { valid: true, entries: count };
}

// ============================================================
// PUBLISH ROOT (for hourly cron + transparency log)
// ============================================================

export async function computeRoot(): Promise<{ root: string; entries: number }> {
  const last = await lastEntry();
  return { root: last?.entryHash ?? "GENESIS", entries: last?.seq ?? 0 };
}

// ============================================================
// PUBLISH ROOT (for hourly cron + transparency beacon)
// ============================================================

/**
 * Writes the current Merkle root + timestamp + entry count to
 * data/atlas-ledger-roots.jsonl. Meant to be called hourly from cron.
 * A future step can push this file to a public repo for transparency.
 */
export async function publishRoot(): Promise<{ ts: string; root: string; entries: number }> {
  const { root, entries } = await computeRoot();
  const record = { ts: new Date().toISOString(), root, entries };
  const path = join(process.env.PROJECT_DIR || process.cwd(), "data", "atlas-ledger-roots.jsonl");
  await appendFile(path, JSON.stringify(record) + "\n");
  return record;
}
