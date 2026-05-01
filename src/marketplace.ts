/**
 * Atlas Prime — Marketplace
 * Skills + named subagents bid for tasks. Vow-cards (routine) + active bids (novel).
 * Beta posteriors with per-domain decay.
 *
 * Task 12: Foundation — registerBidder, betaSummary, recordOutcome.
 * Task 13 (next): routeTask, currentRouting, promoteTaskType.
 * Task 14 (next): decayAll.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface VowCard {
  cost_estimate_usd?: number;
  expected_latency_ms?: number;
  confidence_baseline?: number;
  notes?: string;
}

export interface Bidder {
  id: string;
  type: "skill" | "subagent";
  domains: string[];
  vowCard: VowCard;
}

export interface Bid {
  bid_id: string;
  task_id: string;
  bidder_id: string;
  want: boolean;
  confidence_now: number;
  cost_now: number;
  reason: string;
  won?: boolean;
}

export interface RouteTaskResult {
  winner: string;
  bids: Bid[];
  reasoning: string;
  mode: "shadow" | "live";
  novelPath: boolean;
}

export const DEFAULT_HALF_LIVES: Record<string, number> = {
  email: 90,
  careplan: 60,
  marketing: 30,
  "ad-creative": 14,
  code: 120,
  newsletter: 30,
  "gbp-post": 21,
  social: 14,
  default: 60,
};

export const NOVEL_THRESHOLD = 50;

/**
 * Upsert a bidder row and seed Beta posterior reputation rows for each declared domain.
 * Existing reputation rows are NOT reset (ignoreDuplicates: true on reputation upsert).
 */
export async function registerBidder(supabase: SupabaseClient, b: Bidder): Promise<void> {
  await supabase.from("marketplace_bidders").upsert(
    { bidder_id: b.id, type: b.type, vow_card_json: b.vowCard },
    { onConflict: "bidder_id" }
  );

  // Seed reputation rows for declared domains — never overwrite existing posteriors.
  for (const d of b.domains) {
    const halfLife = DEFAULT_HALF_LIVES[d] ?? DEFAULT_HALF_LIVES.default;
    await supabase.from("marketplace_reputation").upsert(
      {
        bidder_id: b.id,
        domain: d,
        alpha: 2.0,
        beta: 2.0,
        half_life_days: halfLife,
      },
      { onConflict: "bidder_id,domain", ignoreDuplicates: true }
    );
  }
}

/**
 * Return mean + 95% CI of the Beta posterior for a bidder/domain pair.
 * Defaults to α=2, β=2 (uninformative) when no row exists.
 */
export async function betaSummary(
  supabase: SupabaseClient,
  bidderId: string,
  domain: string
): Promise<{ alpha: number; beta: number; mean: number; ci95: [number, number] }> {
  const { data } = await supabase
    .from("marketplace_reputation")
    .select("alpha,beta")
    .eq("bidder_id", bidderId)
    .eq("domain", domain)
    .maybeSingle();

  const alpha = data?.alpha ?? 2.0;
  const beta = data?.beta ?? 2.0;
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1));
  const sd = Math.sqrt(variance);
  const lo = Math.max(0, mean - 1.96 * sd);
  const hi = Math.min(1, mean + 1.96 * sd);
  return { alpha, beta, mean, ci95: [lo, hi] };
}

/**
 * Record the outcome of a task and update the winning bidder's Beta posterior.
 *
 * Sprint 5 simplicity: domain is always "default" here because the bid row
 * doesn't store the routing domain yet. Sprint 6 will add domain to marketplace_bids.
 */
export async function recordOutcome(
  supabase: SupabaseClient,
  taskId: string,
  outcome: "win" | "loss",
  latencyMs: number,
  costUsd: number,
  scoredBy: "derek" | "judge" | "heuristic"
): Promise<void> {
  // Find the winning bidder for this task.
  const { data: bid } = await supabase
    .from("marketplace_bids")
    .select("bidder_id")
    .eq("task_id", taskId)
    .eq("won", true)
    .maybeSingle();

  if (!bid) return;

  // Write the outcome record.
  await supabase.from("marketplace_outcomes").upsert(
    {
      task_id: taskId,
      winning_bidder_id: bid.bidder_id,
      outcome,
      latency_ms: latencyMs,
      cost_actual_usd: costUsd,
      scored_by: scoredBy,
    },
    { onConflict: "task_id" }
  );

  // Update Beta posterior. Domain is "default" for Sprint 5; Sprint 6 will use the
  // actual routing domain stored on the bid row.
  const domain = "default";
  const { data: rep } = await supabase
    .from("marketplace_reputation")
    .select("alpha,beta")
    .eq("bidder_id", bid.bidder_id)
    .eq("domain", domain)
    .maybeSingle();

  const newAlpha = (rep?.alpha ?? 2.0) + (outcome === "win" ? 1 : 0);
  const newBeta = (rep?.beta ?? 2.0) + (outcome === "loss" ? 1 : 0);

  await supabase.from("marketplace_reputation").upsert(
    {
      bidder_id: bid.bidder_id,
      domain,
      alpha: newAlpha,
      beta: newBeta,
      last_outcome_at: new Date().toISOString(),
    },
    { onConflict: "bidder_id,domain" }
  );
}
