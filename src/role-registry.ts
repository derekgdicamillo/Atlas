/**
 * Atlas Prime — Role Registry
 * 8 hand-curated named seats + 32 Opus-generated roles. ed25519 contracts.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from "crypto";
import * as YAML from "js-yaml";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Role {
  id: string;
  name: string;
  description: string;
  prompt_fragment: string;
  domain_tags: string[];
  mandatory_for: string[];
  created_at: string;
  version: number;
}

export interface SignedContract {
  role_id: string;
  payload: unknown;
  payload_canonical: string;
  signature: Buffer;
  timestamp: string;
}

export interface PendingRole {
  pending_id: string;
  role: Omit<Role, "id">;
}

const DEFAULT_ROLES_ROOT = join(process.env.PROJECT_DIR || process.cwd(), "data/roles");
function rolesRoot(root?: string): string { return root ?? DEFAULT_ROLES_ROOT; }
function roleDir(roleId: string, root?: string): string { return join(rolesRoot(root), roleId); }
function privKeyPath(roleId: string, root?: string): string { return join(roleDir(roleId, root), "key.priv"); }
function pubKeyPath(roleId: string, root?: string): string { return join(roleDir(roleId, root), "key.pub"); }
function rolePath(roleId: string, root?: string): string { return join(roleDir(roleId, root), "role.yaml"); }

function canonicalize(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return JSON.stringify(payload);
  if (Array.isArray(payload)) return "[" + payload.map(canonicalize).join(",") + "]";
  const keys = Object.keys(payload as Record<string, unknown>).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalize((payload as Record<string, unknown>)[k]));
  return "{" + parts.join(",") + "}";
}

export async function generateRoleKeypair(roleId: string, root?: string): Promise<{ publicKey: Buffer; privateKeyPem: string; publicKeyPem: string }> {
  mkdirSync(roleDir(roleId, root), { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(privKeyPath(roleId, root), privPem, { mode: 0o600 });
  writeFileSync(pubKeyPath(roleId, root), pubPem);
  const der = publicKey.export({ type: "spki", format: "der" });
  const pubBytes = Buffer.from(der.subarray(der.length - 32));
  return { publicKey: pubBytes, privateKeyPem: privPem, publicKeyPem: pubPem };
}

export async function signContract(roleId: string, payload: unknown, root?: string): Promise<SignedContract> {
  const privPem = readFileSync(privKeyPath(roleId, root), "utf-8");
  const privKey = createPrivateKey(privPem);
  const canonical = canonicalize(payload);
  const signature = sign(null, Buffer.from(canonical, "utf-8"), privKey);
  return { role_id: roleId, payload, payload_canonical: canonical, signature, timestamp: new Date().toISOString() };
}

export async function verifyContract(contract: SignedContract, root?: string): Promise<boolean> {
  try {
    const pubPem = readFileSync(pubKeyPath(contract.role_id, root), "utf-8");
    const pubKey = createPublicKey(pubPem);
    const canonical = canonicalize(contract.payload);
    if (canonical !== contract.payload_canonical) return false;
    const sig = Buffer.isBuffer(contract.signature) ? contract.signature : Buffer.from(contract.signature as unknown as string, "base64");
    return verify(null, Buffer.from(canonical, "utf-8"), pubKey, sig);
  } catch {
    return false;
  }
}

export async function loadRole(roleId: string, root?: string): Promise<Role> {
  const raw = readFileSync(rolePath(roleId, root), "utf-8");
  const data = YAML.load(raw) as Omit<Role, "id">;
  return { id: roleId, ...data };
}

export async function listRoles(filter?: { domain?: string; mandatoryFor?: string }, root?: string): Promise<Role[]> {
  const dir = rolesRoot(root);
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir).filter((d) => !d.startsWith("_") && existsSync(rolePath(d, root)));
  const roles = await Promise.all(ids.map((id) => loadRole(id, root)));
  return roles.filter((r) => {
    if (filter?.domain && !r.domain_tags.includes(filter.domain)) return false;
    if (filter?.mandatoryFor && !r.mandatory_for.includes(filter.mandatoryFor)) return false;
    return true;
  });
}

export async function getReputation(supabase: SupabaseClient, roleId: string, domain: string): Promise<{ alpha: number; beta: number; mean: number }> {
  const { data } = await supabase.from("role_reputation").select("alpha,beta").eq("role_id", roleId).eq("domain", domain).maybeSingle();
  const alpha = data?.alpha ?? 2.0;
  const beta = data?.beta ?? 2.0;
  return { alpha, beta, mean: alpha / (alpha + beta) };
}

export async function updateReputation(supabase: SupabaseClient, roleId: string, domain: string, outcome: "win" | "loss"): Promise<void> {
  const { data } = await supabase.from("role_reputation").select("alpha,beta").eq("role_id", roleId).eq("domain", domain).maybeSingle();
  const alpha = (data?.alpha ?? 2.0) + (outcome === "win" ? 1 : 0);
  const beta = (data?.beta ?? 2.0) + (outcome === "loss" ? 1 : 0);
  await supabase.from("role_reputation").upsert({ role_id: roleId, domain, alpha, beta, last_outcome_at: new Date().toISOString() }, { onConflict: "role_id,domain" });
}

// ============================================================
// AUCTIONEER (E3 hybrid: mandatory floor + reputation-weighted ceiling)
// ============================================================

export interface Action {
  tool: string;
  args: Record<string, unknown>;
}

const TOOL_TO_DOMAIN: Record<string, string> = {
  "gmail.send": "email",
  "gmail.draft": "email",
  "brevo.campaign.send": "email",
  "google.calendar.create": "email",
  "ghl.send.email": "email",
  "ghl.send.sms": "email",
  "ghl.workflow.enroll": "email",
  "gbp.post.create": "gbp-post",
  "social.publish.facebook": "social",
  "social.publish.instagram": "social",
  "wp.post.publish": "marketing",
  "wp.post.update": "marketing",
  "pv-newsletter.push": "newsletter",
  "maa-newsletter.send": "newsletter",
  "ad.creative.review": "ad-creative",
  "code.task": "code",
};

export function domainFor(action: Action): string {
  return TOOL_TO_DOMAIN[action.tool] ?? "default";
}

// Sprint 5 ships a TF-cosine stub. Sprint 6 swaps in the reranker for real embeddings.
function tfVec(text: string): Map<string, number> {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const v = new Map<string, number>();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0; let na = 0; let nb = 0;
  for (const [k, v] of a) { na += v * v; dot += v * (b.get(k) ?? 0); }
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export async function auctionFor(
  supabase: SupabaseClient,
  action: Action,
  opts: { mandatoryFloor?: string[]; ceilingSeats?: number } = {},
  root?: string
): Promise<{ seats: Role[]; reasoning: string }> {
  const ceiling = opts.ceilingSeats ?? 3;
  const allRoles = await listRoles(undefined, root);

  const mandatorySet = new Set<string>(opts.mandatoryFloor ?? []);
  for (const r of allRoles) {
    if (r.mandatory_for.includes(action.tool)) mandatorySet.add(r.id);
  }
  const mandatory = allRoles.filter((r) => mandatorySet.has(r.id));

  const remaining = ceiling - mandatory.length;
  let elected: Role[] = [];
  if (remaining > 0) {
    const queryText = action.tool + " " + JSON.stringify(action.args).slice(0, 1000);
    const queryVec = tfVec(queryText);
    const domain = domainFor(action);
    const candidates = allRoles.filter((r) => !mandatorySet.has(r.id));
    const scored = await Promise.all(
      candidates.map(async (r) => {
        const cardText = r.name + " " + r.description + " " + r.prompt_fragment + " " + r.domain_tags.join(" ");
        const cardVec = tfVec(cardText);
        const cos = cosine(queryVec, cardVec);
        const rep = await getReputation(supabase, r.id, domain);
        return { role: r, score: cos * Math.sqrt(rep.mean) };
      })
    );
    scored.sort((a, b) => b.score - a.score);
    elected = scored.slice(0, remaining).map((s) => s.role);
  }

  const seats = [...mandatory, ...elected];
  const reasoning = "Mandatory floor: [" + (mandatory.map((r) => r.id).join(", ") || "none") + "]. Elected: [" + (elected.map((r) => r.id).join(", ") || "none") + "].";
  return { seats, reasoning };
}

// ============================================================
// PENDING / BOOTSTRAP WORKFLOW
// ============================================================
import { appendEntry } from "./ledger";

const PENDING_DIR = "_pending";
function pendingDir(root?: string): string { return join(rolesRoot(root), PENDING_DIR); }

export async function listPending(root?: string): Promise<PendingRole[]> {
  const dir = pendingDir(root);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  const out: PendingRole[] = [];
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf-8");
    const data = YAML.load(raw) as { id?: string } & Omit<Role, "id">;
    const pendingId = f.replace(/\.yaml$/, "");
    const { id: _ignore, ...rest } = data;
    out.push({ pending_id: pendingId, role: rest as Omit<Role, "id"> });
  }
  return out;
}

export async function approvePending(
  supabase: SupabaseClient,
  pendingId: string,
  root?: string
): Promise<{ roleId: string; pubkeyLedgerEntryId: string }> {
  const pendingFile = join(pendingDir(root), pendingId + ".yaml");
  if (!existsSync(pendingFile)) throw new Error("pending not found: " + pendingId);
  const raw = readFileSync(pendingFile, "utf-8");
  const data = YAML.load(raw) as { id?: string } & Omit<Role, "id">;
  const roleId = data.id ?? pendingId;
  if (!/^[a-z0-9-]+$/.test(roleId)) throw new Error("invalid role id: " + roleId);
  if (existsSync(roleDir(roleId, root))) throw new Error("role already exists: " + roleId);

  mkdirSync(roleDir(roleId, root), { recursive: true });
  const { id: _drop, ...rest } = data;
  writeFileSync(rolePath(roleId, root), YAML.dump(rest));

  const { publicKey } = await generateRoleKeypair(roleId, root);
  const pubkey_b64 = publicKey.toString("base64");

  const entry = await appendEntry({
    actor: "system",
    action: {
      tool: "role.publish_pubkey",
      args: { role_id: roleId, pubkey_b64, approved_from_pending: pendingId },
    },
    sourceClaims: [],
  });

  await supabase.from("role_pubkeys").upsert({
    role_id: roleId,
    pubkey: publicKey,
    ledger_publication_entry_id: entry.entryHash,
  });

  unlinkSync(pendingFile);
  return { roleId, pubkeyLedgerEntryId: entry.entryHash };
}

export async function rejectPending(pendingId: string, reason: string, root?: string): Promise<void> {
  const pendingFile = join(pendingDir(root), pendingId + ".yaml");
  if (!existsSync(pendingFile)) throw new Error("pending not found: " + pendingId);
  await appendEntry({
    actor: "system",
    action: {
      tool: "role.pending_rejected",
      args: { pending_id: pendingId, reason },
    },
    sourceClaims: [],
  });
  unlinkSync(pendingFile);
}
