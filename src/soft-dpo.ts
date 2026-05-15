/**
 * Atlas Prime Sprint 6 — Soft-DPO Foundation
 *
 * capturePair        — store a preference pair (chosen/rejected) with embedding
 * findMatchingPairs  — semantic retrieval of relevant past corrections
 * buildInjectionBlock — render corrections into a compact system-prompt block
 * embedTextOpenAI    — OpenAI text-embedding-3-small helper
 * runNightlyDigest   — generate data/behavioral-soft-dpo.md from last 7 days
 */

import { writeFile, mkdir } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DpoSource = "label_bad" | "haiku_classifier" | "dpo_tag";

export interface DpoPair {
  id: string;
  captured_at?: string;
  source: DpoSource;
  turn_id?: string;
  user_id: string;
  agent: "atlas" | "ishtar";
  user_turn: string;
  atlas_original: string;
  derek_corrected: string;
  domain?: string;
  reason?: string;
}

export interface MatchingPair extends DpoPair {
  similarity?: number;
}

// ─── capturePair ──────────────────────────────────────────────────────────────

interface CaptureDeps {
  embedText: (text: string) => Promise<number[]>;
}

const MAX_FIELD = 4000;

/**
 * Store a preference pair in the dpo_pairs table with a combined embedding.
 * The embedding is computed from user_turn + atlas_original + derek_corrected
 * so semantic match covers all three axes.
 */
export async function capturePair(
  supabase: SupabaseClient,
  pair: Omit<DpoPair, "id" | "captured_at">,
  deps: CaptureDeps
): Promise<DpoPair> {
  const userTurn = pair.user_turn.slice(0, MAX_FIELD);
  const original = pair.atlas_original.slice(0, MAX_FIELD);
  const corrected = pair.derek_corrected.slice(0, MAX_FIELD);

  const embedInput = `${userTurn}\n${original}\n${corrected}`;
  const embedding = await deps.embedText(embedInput);

  const row = {
    source: pair.source,
    turn_id: pair.turn_id ?? null,
    user_id: pair.user_id,
    agent: pair.agent,
    user_turn: userTurn,
    atlas_original: original,
    derek_corrected: corrected,
    domain: pair.domain ?? null,
    reason: pair.reason ?? null,
    embedding,
  };

  const { data, error } = await supabase
    .from("dpo_pairs")
    .insert(row)
    .select()
    .single();

  if (error || !data) {
    throw new Error(`soft-dpo: capture failed: ${error?.message}`);
  }

  return data as DpoPair;
}

// ─── findMatchingPairs ────────────────────────────────────────────────────────

interface FindMatchOpts {
  query: string;
  domain?: string;
  k?: number;
  embedText?: (text: string) => Promise<number[]>;
}

/**
 * Retrieve the top-K most semantically similar past correction pairs for
 * a given query string (typically the current user message).
 * Uses the dpo_pairs_match Postgres RPC (vector cosine distance).
 */
export async function findMatchingPairs(
  supabase: SupabaseClient,
  opts: FindMatchOpts
): Promise<MatchingPair[]> {
  if (!opts.embedText) throw new Error("embedText dep required");

  const queryEmbedding = await opts.embedText(opts.query);
  const k = opts.k ?? 3;

  const { data, error } = await supabase.rpc("dpo_pairs_match", {
    p_query_embedding: queryEmbedding,
    p_match_count: k,
    p_domain: opts.domain ?? null,
  });

  if (error) {
    console.error("[soft-dpo] match RPC failed:", error);
    return [];
  }

  return (data ?? []) as MatchingPair[];
}

// ─── buildInjectionBlock ──────────────────────────────────────────────────────

const SNIPPET_MAX = 200;

/**
 * Render a list of matching correction pairs into a compact Markdown block
 * suitable for injection at the top of a system prompt.
 * Returns empty string when pairs list is empty (no-op injection).
 */
export function buildInjectionBlock(pairs: MatchingPair[]): string {
  if (!pairs.length) return "";

  const lines: string[] = [
    "## Recent corrections (soft-DPO)",
    "When responding, weight these patterns from prior corrections in this domain:",
  ];

  for (const p of pairs) {
    lines.push(`- You said "${p.atlas_original.slice(0, SNIPPET_MAX)}"`);
    lines.push(`  But ${p.user_id} wanted "${p.derek_corrected.slice(0, SNIPPET_MAX)}"`);
    if (p.reason) lines.push(`  Reason: ${p.reason}`);
  }

  return lines.join("\n");
}

// ─── embedTextOpenAI ─────────────────────────────────────────────────────────

/**
 * Thin wrapper around OpenAI text-embedding-3-small.
 * Exported so relay-side code can pass it as a dep without importing the full OpenAI SDK.
 */
export async function embedTextOpenAI(text: string): Promise<number[]> {
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

// ─── runNightlyDigest ─────────────────────────────────────────────────────────

/**
 * Aggregate dpo_pairs from the last 7 days into a human-readable Markdown file
 * at data/behavioral-soft-dpo.md, grouped by domain.
 * Returns per-domain counts + total for the Telegram digest message.
 */
export async function runNightlyDigest(
  supabase: SupabaseClient
): Promise<{ pairs_by_domain: Record<string, number>; total: number }> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data } = await supabase
    .from("dpo_pairs")
    .select("domain, user_turn, atlas_original, derek_corrected, reason, captured_at, user_id, source")
    .gte("captured_at", since)
    .order("captured_at", { ascending: false })
    .limit(500);
  const pairs = (data ?? []) as any[];

  const byDomain = new Map<string, any[]>();
  for (const p of pairs) {
    const d = (p.domain as string | null) ?? "uncategorized";
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(p);
  }

  const out: string[] = [
    "# Behavioral Soft-DPO Digest",
    "",
    "Auto-generated nightly from `dpo_pairs`.",
    "Per-turn relay injection picks the top-K by semantic match to the active turn.",
    "",
  ];
  const stats: Record<string, number> = {};

  for (const [domain, items] of byDomain.entries()) {
    stats[domain] = items.length;
    out.push(`## ${domain}`, "");
    for (const p of items.slice(0, 20)) {
      out.push(`- **User asked:** "${(p.user_turn as string).slice(0, 200)}"`);
      out.push(`  **Atlas said:** "${(p.atlas_original as string).slice(0, 200)}"`);
      out.push(`  **${p.user_id as string} wanted:** "${(p.derek_corrected as string).slice(0, 200)}"`);
      if (p.reason) out.push(`  *Reason:* ${p.reason as string}`);
      out.push(`  *(Captured ${String(p.captured_at).slice(0, 10)} via ${p.source as string})*`, "");
    }
    out.push("");
  }

  await mkdir("data", { recursive: true });
  await writeFile("data/behavioral-soft-dpo.md", out.join("\n"), "utf8");
  return { pairs_by_domain: stats, total: pairs.length };
}
