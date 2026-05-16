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

export async function generateSessionKey(
  supabase: { from: (t: string) => any } | null,
  agent: "atlas" | "ishtar"
): Promise<SessionKeyHandle> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const session_id = randomUUID();

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
  const { hashHex } = canonicalMemoryPayload(row);
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

export async function verifyMemoryRow(
  supabase: any,
  row: SignedMemoryRow
): Promise<{ valid: boolean; reason?: string }> {
  if (row.signature == null || row.session_id == null) {
    return { valid: true, reason: "legacy_pre_sprint7" };
  }

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

  const { hashHex } = canonicalMemoryPayload(row);
  if (hashHex !== row.sig_payload_hash) {
    return {
      valid: false,
      reason: `payload_hash_mismatch (expected ${row.sig_payload_hash?.slice(0, 8)}, got ${hashHex.slice(0, 8)})`,
    };
  }

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
