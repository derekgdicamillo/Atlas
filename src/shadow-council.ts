/**
 * Atlas Prime — Shadow Council
 * 3 trust-weighted critics on every patient-facing send. Per-surface shadow/live mode.
 */
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role, Action } from "./role-registry";
import { auctionFor, signContract, getReputation, domainFor } from "./role-registry";
import { openDeliberation, commitContract } from "./blackboard-git";
import { callHaiku } from "./haiku-client";

export interface Vote {
  role_id: string;
  vote: "approve" | "veto" | "abstain";
  reason: string;
  confidence: number;
  weight: number;
  blackboard_commit?: string;
}

export interface CouncilReviewResult {
  allowed: boolean;
  vetoes: Vote[];
  votes: Vote[];
  weightedScore: number;
  threshold: number;
  deliberationBranch: string;
  mode: "shadow" | "live";
  actionId: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const INTERNAL_DOMAINS = ["pvmedispa.com", "medicalaestheticsassociation.com", "bsfehealth.com"];

function isInternalDomain(addr: unknown): boolean {
  if (typeof addr !== "string") return false;
  const at = addr.lastIndexOf("@");
  if (at < 0) return false;
  const dom = addr.slice(at + 1).toLowerCase();
  return INTERNAL_DOMAINS.some((d) => dom === d || dom.endsWith("." + d));
}

// ---------------------------------------------------------------------------
// surfaceFor — pure function, no async, no DB
// ---------------------------------------------------------------------------

export function surfaceFor(a: Action): string {
  if (a.tool === "gmail.send" || a.tool === "gmail.draft") {
    return isInternalDomain(a.args.to) ? "internal_email" : "outbound_email";
  }
  if (a.tool === "brevo.campaign.send") return "brevo_campaign";
  if (a.tool === "google.calendar.create" && a.args.has_external_attendee === true)
    return "cal_invite_external";
  if (a.tool.startsWith("ghl.send.") || a.tool === "ghl.workflow.enroll")
    return "ghl_patient_message";
  if (a.tool === "gbp.post.create") return "gbp_post";
  if (a.tool.startsWith("social.publish.")) return "social_publish";
  if (a.tool === "wp.post.publish") return "wp_post_publish";
  if (a.tool === "pv-newsletter.push" || a.tool === "maa-newsletter.send") return "newsletter_push";
  return "unconfigured";
}

// ---------------------------------------------------------------------------
// Mode resolution — queries council_surfaces table
// ---------------------------------------------------------------------------

export async function getSurfaceMode(
  supabase: SupabaseClient,
  surface: string
): Promise<"shadow" | "live"> {
  const { data } = await supabase
    .from("council_surfaces")
    .select("mode")
    .eq("surface", surface)
    .maybeSingle();
  return (data?.mode as "shadow" | "live") ?? "shadow";
}

export async function promoteSurface(
  supabase: SupabaseClient,
  surface: string,
  byUser: string
): Promise<void> {
  await supabase.from("council_surfaces").upsert(
    { surface, mode: "live", promoted_by: byUser, promoted_at: new Date().toISOString() },
    { onConflict: "surface" }
  );
}

export async function demoteSurface(
  supabase: SupabaseClient,
  surface: string,
  byUser: string
): Promise<void> {
  await supabase.from("council_surfaces").upsert(
    { surface, mode: "shadow", promoted_by: byUser, promoted_at: new Date().toISOString() },
    { onConflict: "surface" }
  );
}

export async function listSurfaces(
  supabase: SupabaseClient
): Promise<{ surface: string; mode: string; vote_count_24h: number; veto_rate_24h: number }[]> {
  const { data: surfaces } = await supabase.from("council_surfaces").select("surface,mode");
  const out: {
    surface: string;
    mode: string;
    vote_count_24h: number;
    veto_rate_24h: number;
  }[] = [];
  for (const s of surfaces ?? []) {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { data: votes } = await supabase
      .from("council_votes")
      .select("vote")
      .gte("created_at", since)
      .like("action_id", "%" + s.surface + "%");
    const total = votes?.length ?? 0;
    const vetoes = (votes ?? []).filter((v) => v.vote === "veto").length;
    out.push({
      surface: s.surface,
      mode: s.mode,
      vote_count_24h: total,
      veto_rate_24h: total > 0 ? vetoes / total : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// review() — 3 trust-weighted Haiku critics, Promise.race 3s SLA, signed votes
// ---------------------------------------------------------------------------

function sleepReturning<T>(ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(fallback), ms));
}

const COUNCIL_SLA_MS = 3000;

async function promptCritic(role: Role, action: Action): Promise<Vote> {
  const sys = "You are " + role.name + ". " + role.prompt_fragment;
  const userMessage =
    "Vote on this action.\n\nTool: " +
    action.tool +
    "\nArgs: " +
    JSON.stringify(action.args).slice(0, 800) +
    '\n\nOutput strict JSON only: {"vote":"approve"|"veto","reason":"...","confidence":0..1}';
  try {
    const out = await callHaiku({ system: sys, userMessage, maxTokens: 200, cacheSystem: true });
    const m = out.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no json");
    const parsed = JSON.parse(m[0]) as { vote: "approve" | "veto"; reason: string; confidence: number };
    return {
      role_id: role.id,
      vote: parsed.vote === "veto" ? "veto" : "approve",
      reason: String(parsed.reason ?? ""),
      confidence: Number(parsed.confidence ?? 0.5),
      weight: 0,
    };
  } catch (e) {
    return {
      role_id: role.id,
      vote: "abstain",
      reason: "parse-error: " + (e as Error).message,
      confidence: 0,
      weight: 0,
    };
  }
}

export async function review(
  supabase: SupabaseClient,
  action: Action
): Promise<CouncilReviewResult> {
  const surface = surfaceFor(action);
  const mode = await getSurfaceMode(supabase, surface);
  const actionId = randomUUID();

  const { seats, reasoning } = await auctionFor(supabase, action, {
    mandatoryFloor: ["patient-advocate", "compliance-lawyer"],
    ceilingSeats: 3,
  });

  // Open a blackboard branch for this review
  const { branch } = await openDeliberation(actionId.slice(0, 8), "council");

  // Race critics against SLA
  const timeoutVotes: Vote[] = seats.map((s) => ({
    role_id: s.id,
    vote: "abstain" as const,
    reason: "timeout",
    confidence: 0,
    weight: 0,
  }));
  const responses = await Promise.race([
    Promise.all(seats.map((s) => promptCritic(s, action))),
    sleepReturning(COUNCIL_SLA_MS, timeoutVotes),
  ]);

  // Compute weights from role_reputation per critic
  const domain = domainFor(action);
  const votesWithWeights: Vote[] = await Promise.all(
    responses.map(async (v) => {
      const rep = await getReputation(supabase, v.role_id, domain);
      return { ...v, weight: rep.mean };
    })
  );

  // Sign + commit each vote to the blackboard, then insert into Postgres
  for (const v of votesWithWeights) {
    try {
      const contract = await signContract(v.role_id, {
        action_id: actionId,
        tool: action.tool,
        vote: v.vote,
        reason: v.reason,
        confidence: v.confidence,
      });
      const { commitHash } = await commitContract(branch, contract, v.role_id + ":" + v.vote);
      v.blackboard_commit = commitHash;
    } catch {
      // continue — we still record vote in Postgres
    }
    await supabase.from("council_votes").insert({
      vote_id: randomUUID(),
      action_id: actionId,
      role_id: v.role_id,
      vote: v.vote,
      reason: v.reason,
      confidence: v.confidence,
      blackboard_commit: v.blackboard_commit,
      mode,
    });
  }

  // Trust-weighted tally
  const weightedVeto = votesWithWeights
    .filter((v) => v.vote === "veto")
    .reduce((s, v) => s + v.weight, 0);
  const weightedTotal = votesWithWeights
    .filter((v) => v.vote !== "abstain")
    .reduce((s, v) => s + v.weight, 0);
  const threshold = 0.5 * weightedTotal;
  const respondedCount = votesWithWeights.filter((v) => v.vote !== "abstain").length;

  let allowed: boolean;
  if (respondedCount < 2) {
    allowed = mode === "shadow";
  } else if (mode === "shadow") {
    allowed = true;
  } else {
    allowed = weightedVeto < threshold;
  }

  void reasoning; // logged in deliberation.json
  return {
    allowed,
    vetoes: votesWithWeights.filter((v) => v.vote === "veto"),
    votes: votesWithWeights,
    weightedScore: weightedVeto,
    threshold,
    deliberationBranch: branch,
    mode,
    actionId,
  };
}
