/**
 * Atlas Prime — Role Registry
 * 8 hand-curated named seats + 32 Opus-generated roles. ed25519 contracts.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
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

const DEFAULT_ROLES_ROOT = join(process.cwd(), "data/roles");
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
