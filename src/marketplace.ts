/**
 * Atlas Prime — Marketplace
 * Skills + named subagents bid for tasks. Vow-cards (routine) + active bids (novel).
 * Beta posteriors with per-domain decay.
 *
 * Task 12: Foundation — registerBidder, betaSummary, recordOutcome.
 * Task 13: routeTask, currentRouting, promoteTaskType, getTaskTypeMode.
 * Task 14 (next): decayAll.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { callHaiku } from "./haiku-client";
import { judgeShadowOutput, recordScore } from "./skill-shadow-router.ts";

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

// ============================================================
// ROUTING (Task 13 — vow-cards routine + active bid novel)
// ============================================================

let routingCache: Record<string, string> | null = null;
function loadRouting(): Record<string, string> {
  if (routingCache) return routingCache;
  const path = join(process.cwd(), "data/marketplace-current-routing.json");
  routingCache = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  return routingCache;
}

/**
 * Synchronous lookup of the baseline routing table.
 * Returns the hard-coded winner for the given task type, or the "default" entry.
 */
export function currentRouting(taskType: string): string {
  const r = loadRouting();
  return r[taskType] ?? r["default"] ?? "code-research";
}

/**
 * Issue a real-time bid from a bidder via Haiku (novel path).
 */
async function activeBidPrompt(
  bidder: { id: string; type: string; vowCard: VowCard },
  task: { type: string; description: string; domain: string }
): Promise<Bid | null> {
  const sys =
    "You are " +
    bidder.id +
    ", a " +
    bidder.type +
    ". Vow card: " +
    JSON.stringify(bidder.vowCard);
  const userMessage =
    "Bid on this task.\nTask type: " +
    task.type +
    "\nDescription: " +
    task.description +
    "\nDomain: " +
    task.domain +
    '\n\nOutput strict JSON only: {"want":bool,"confidence_now":0..1,"cost_now":number,"reason":"..."}';
  try {
    const out = await callHaiku({ system: sys, userMessage, maxTokens: 200, cacheSystem: true, caller: "marketplace-bid" });
    const m = out.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as {
      want: boolean;
      confidence_now: number;
      cost_now: number;
      reason: string;
    };
    return {
      bid_id: randomUUID(),
      task_id: "",
      bidder_id: bidder.id,
      want: !!parsed.want,
      confidence_now: Number(parsed.confidence_now ?? 0.5),
      cost_now: Number(parsed.cost_now ?? bidder.vowCard.cost_estimate_usd ?? 0.1),
      reason: String(parsed.reason ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * Return the current mode and sample count for a task type.
 * Defaults to shadow mode with 0 samples when no row exists.
 */
export async function getTaskTypeMode(
  supabase: SupabaseClient,
  taskType: string
): Promise<{ mode: "shadow" | "live"; sampleCount: number }> {
  const { data } = await supabase
    .from("marketplace_task_types")
    .select("mode,sample_count")
    .eq("task_type", taskType)
    .maybeSingle();
  return {
    mode: (data?.mode as "shadow" | "live") ?? "shadow",
    sampleCount: data?.sample_count ?? 0,
  };
}

/**
 * Promote a task type from shadow to live mode.
 */
export async function promoteTaskType(
  supabase: SupabaseClient,
  taskType: string,
  byUser: string
): Promise<void> {
  await supabase.from("marketplace_task_types").upsert(
    {
      task_type: taskType,
      mode: "live",
      promoted_by: byUser,
      promoted_at: new Date().toISOString(),
    },
    { onConflict: "task_type" }
  );
}

// ============================================================
// DECAY (H3 per-domain half-life)
// ============================================================

export async function decayAll(
  supabase: SupabaseClient
): Promise<{ bidderCount: number; domainCount: number; rowsUpdated: number }> {
  const { data: rows } = await supabase
    .from("marketplace_reputation")
    .select("bidder_id,domain,alpha,beta,last_decay_at,prior_alpha,prior_beta,half_life_days");
  if (!rows) return { bidderCount: 0, domainCount: 0, rowsUpdated: 0 };

  const now = Date.now();
  const bidders = new Set<string>();
  const domains = new Set<string>();
  let updated = 0;
  for (const r of rows) {
    const lastMs = new Date(r.last_decay_at).getTime();
    const tDays = (now - lastMs) / 86400_000;
    if (tDays <= 0) continue;
    const halfLife = r.half_life_days ?? 60;
    const shrink = Math.exp((-tDays * Math.LN2) / halfLife);
    const alphaNew = r.alpha * shrink + r.prior_alpha * (1 - shrink);
    const betaNew = r.beta * shrink + r.prior_beta * (1 - shrink);
    await supabase
      .from("marketplace_reputation")
      .update({
        alpha: alphaNew,
        beta: betaNew,
        last_decay_at: new Date(now).toISOString(),
      })
      .eq("bidder_id", r.bidder_id)
      .eq("domain", r.domain);
    bidders.add(r.bidder_id as string);
    domains.add(r.domain as string);
    updated += 1;
  }
  return { bidderCount: bidders.size, domainCount: domains.size, rowsUpdated: updated };
}

async function bumpSampleCount(
  supabase: SupabaseClient,
  taskType: string
): Promise<void> {
  const { data } = await supabase
    .from("marketplace_task_types")
    .select("sample_count,mode")
    .eq("task_type", taskType)
    .maybeSingle();
  await supabase.from("marketplace_task_types").upsert(
    {
      task_type: taskType,
      sample_count: (data?.sample_count ?? 0) + 1,
      mode: data?.mode ?? "shadow",
    },
    { onConflict: "task_type" }
  );
}

/**
 * Route a task through the marketplace.
 *
 * - Novel path (sample_count < NOVEL_THRESHOLD): real-time Haiku bids per bidder.
 * - Routine path: synthesize bids from vow-cards (no Haiku call).
 *
 * In shadow mode: returns the baseline currentRouting() winner but logs the
 * scored "would-have-won" in the reasoning field for comparison.
 * In live mode: returns the scored winner.
 */
export async function routeTask(
  supabase: SupabaseClient,
  task: { type: string; description: string; payload: unknown; domain: string }
): Promise<RouteTaskResult> {
  const { mode, sampleCount } = await getTaskTypeMode(supabase, task.type);
  const novel = sampleCount < NOVEL_THRESHOLD;

  // Load bidders that have declared competence in this domain (have a reputation row for it).
  // Falls back to all bidders if no domain-specific registrations exist.
  const { data: repRows } = await supabase
    .from("marketplace_reputation")
    .select("bidder_id")
    .eq("domain", task.domain);
  const domainBidderIds = new Set((repRows ?? []).map((r) => r.bidder_id as string));

  const { data: bidderRows } = await supabase.from("marketplace_bidders").select("*");
  const allCandidates = (bidderRows ?? []).map((b) => ({
    id: b.bidder_id as string,
    type: b.type as "skill" | "subagent",
    vowCard: b.vow_card_json as VowCard,
  }));
  // Prefer domain-matched bidders; if none declared for this domain, use all.
  const candidates =
    domainBidderIds.size > 0
      ? allCandidates.filter((b) => domainBidderIds.has(b.id))
      : allCandidates;

  // Collect bids: novel or live path → active Haiku bids; routine shadow → synthesize from vow-card.
  const bids: Bid[] = [];
  if (novel || mode === "live") {
    const responses = await Promise.all(
      candidates.map((b) => activeBidPrompt(b, task))
    );
    for (const b of responses) {
      if (b) {
        b.task_id = randomUUID();
        bids.push(b);
      }
    }
    // Fallback: if all active bids failed (e.g., CLI unavailable), synthesize from vow-cards.
    if (bids.length === 0) {
      for (const c of candidates) {
        bids.push({
          bid_id: randomUUID(),
          task_id: "",
          bidder_id: c.id,
          want: true,
          confidence_now: c.vowCard.confidence_baseline ?? 0.5,
          cost_now: c.vowCard.cost_estimate_usd ?? 0.1,
          reason: "vow-card fallback (active bid failed)",
        });
      }
    }
  } else {
    // Routine path — synthesize bid from vow-card without calling Haiku.
    for (const c of candidates) {
      bids.push({
        bid_id: randomUUID(),
        task_id: "",
        bidder_id: c.id,
        want: true,
        confidence_now: c.vowCard.confidence_baseline ?? 0.5,
        cost_now: c.vowCard.cost_estimate_usd ?? 0.1,
        reason: "vow-card synthesized",
      });
    }
  }

  // Score each bid where want === true: confidence_now × Beta_mean / max(cost_now, 0.01).
  const scored = await Promise.all(
    bids
      .filter((b) => b.want)
      .map(async (b) => {
        const rep = await betaSummary(supabase, b.bidder_id, task.domain);
        const score = (b.confidence_now * rep.mean) / Math.max(b.cost_now, 0.01);
        return { bid: b, score, betaMean: rep.mean };
      })
  );
  scored.sort((a, b) => b.score - a.score);

  const scoredWinner = scored[0]?.bid.bidder_id ?? currentRouting(task.type);
  // Shadow mode returns baseline routing; live mode returns the scored winner.
  const returnedWinner = mode === "live" ? scoredWinner : currentRouting(task.type);

  // Persist bids to marketplace_bids.
  const taskId = randomUUID();
  for (const s of scored) {
    s.bid.task_id = taskId;
    const won = mode === "live" ? s.bid.bidder_id === scoredWinner : false;
    s.bid.won = won;
    await supabase.from("marketplace_bids").insert({
      bid_id: s.bid.bid_id,
      task_id: taskId,
      bidder_id: s.bid.bidder_id,
      want: s.bid.want,
      confidence_now: s.bid.confidence_now,
      cost_now: s.bid.cost_now,
      reason: s.bid.reason,
      won,
      mode,
    });
  }

  await bumpSampleCount(supabase, task.type);

  return {
    winner: returnedWinner,
    bids,
    reasoning:
      "novel=" + novel + " mode=" + mode + " scored_winner=" + scoredWinner,
    mode,
    novelPath: novel,
  };
}

// ============================================================
// SHADOW EXECUTION (Task 7 — run baseline + candidate in parallel)
// ============================================================

export interface ShadowExecutionOpts {
  taskId: string;
  taskKind: string;
  domain: string;
  task_description: string;
  baselineSkillId: string;
  candidateSkillId: string;
  executeBaseline: () => Promise<any>;
  executeCandidate: () => Promise<any>;
}

/**
 * Run baseline and candidate in parallel. Judge + score fire-and-forget.
 * Returns the live (baseline) output immediately; promote/demote flags are
 * always false because judging is async — check skill_shadow_scores later.
 */
export async function executeWithShadow(
  supabase: SupabaseClient,
  opts: ShadowExecutionOpts
): Promise<{ liveOutput: any; promote: boolean; demote: boolean }> {
  const [liveOutput, shadowOutput] = await Promise.all([
    opts.executeBaseline(),
    opts.executeCandidate().catch((err) => ({ __shadow_error: String(err) })),
  ]);
  // Fire-and-forget judge + score
  judgeShadowOutput(
    { task_description: opts.task_description, task_id: opts.taskId, domain: opts.domain },
    liveOutput,
    shadowOutput
  )
    .then(async (judged) => {
      const { promote, demote } = await recordScore(supabase, {
        task_id: opts.taskId,
        skill_id: opts.candidateSkillId,
        baseline_skill_id: opts.baselineSkillId,
        task_kind: opts.taskKind,
        domain: opts.domain,
        judge_verdict: judged.verdict,
        judge_reason: judged.reason,
      });
      if (promote)
        console.log(`[shadow-router] PROMOTE ${opts.candidateSkillId} over ${opts.baselineSkillId}`);
      if (demote)
        console.log(`[shadow-router] DEMOTE ${opts.candidateSkillId}`);
    })
    .catch((err) => console.error("[shadow-router] judge/record failed:", err));
  return { liveOutput, promote: false, demote: false };
}
