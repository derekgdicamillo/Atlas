/**
 * Atlas Prime Sprint 6 — Soft-DPO Foundation
 *
 * capturePair   — store a preference pair (chosen/rejected) with embedding
 * findMatchingPairs — semantic retrieval of relevant past corrections
 * buildInjectionBlock — render corrections into a system-prompt block
 */

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
