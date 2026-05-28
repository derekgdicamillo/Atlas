/**
 * Atlas Prime — Shadow Council
 * 3 trust-weighted critics on every patient-facing send. Per-surface shadow/live mode.
 */
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role, Action } from "./role-registry";
import { auctionFor, signContract, getReputation, domainFor, updateReputation } from "./role-registry";
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
  // Sprint 5: per-surface vote stats require a `surface` column on council_votes (Sprint 6).
  // action_id is a randomUUID() — .like("action_id", "%surface%") always returns 0 rows.
  // Return surface + mode only; /council output notes that stats land in Sprint 6.
  for (const s of surfaces ?? []) {
    out.push({ surface: s.surface, mode: s.mode, vote_count_24h: 0, veto_rate_24h: 0 });
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
    const out = await callHaiku({ system: sys, userMessage, maxTokens: 200, cacheSystem: true, caller: "shadow-council" });
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

// ============================================================
// OUTCOME SCORING (per vote) + DAILY REVIEWER
// ============================================================

export type ActionFinalOutcome = "sent_as_drafted" | "rewritten" | "cancelled";

/**
 * After Derek's post-hoc decision (sent_as_drafted | rewritten | cancelled),
 * score each council vote on this action as win or loss for the role.
 *
 * Rule:
 * - Vote=veto + outcome=rewritten or cancelled → win (critic was right)
 * - Vote=veto + outcome=sent_as_drafted → loss (critic over-vetoed)
 * - Vote=approve + outcome=sent_as_drafted → win
 * - Vote=approve + outcome=rewritten or cancelled → loss
 * - Vote=abstain → no update
 *
 * Sprint 5 simplification: domain is hard-coded to "email" for outbound_email surfaces.
 * Future: store domain on the council_votes row so it can be resolved accurately per surface.
 */
export async function scoreVoteOutcome(
  supabase: SupabaseClient,
  actionId: string,
  outcome: ActionFinalOutcome
): Promise<void> {
  const { data: votes } = await supabase
    .from("council_votes")
    .select("role_id,vote,action_id")
    .eq("action_id", actionId);
  if (!votes) return;
  const wasOverridden = outcome !== "sent_as_drafted";
  for (const v of votes) {
    if (v.vote === "abstain") continue;
    const correct =
      (v.vote === "veto" && wasOverridden) || (v.vote === "approve" && !wasOverridden);
    // TODO(sprint6): store domain on vote row and resolve it here instead of defaulting to "email"
    const domain = "email";
    await updateReputation(supabase, v.role_id, domain, correct ? "win" : "loss");
  }
}

/**
 * Build a daily Markdown summary of all shadow-mode council votes in the given day window.
 * Groups by role_id; shows approve/veto/abstain counts and veto rate per role.
 * Surface column shows "(mixed)" since vote rows don't store surface in Sprint 5.
 */
export async function dailyShadowReview(supabase: SupabaseClient, day: Date): Promise<string> {
  const start = new Date(day);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const { data } = await supabase
    .from("council_votes")
    .select("role_id,vote,action_id,mode,reason")
    .gte("created_at", start.toISOString())
    .lt("created_at", end.toISOString())
    .eq("mode", "shadow");

  const rows = data ?? [];
  const byRole = new Map<string, { veto: number; approve: number; abstain: number }>();
  for (const r of rows) {
    const k = r.role_id as string;
    if (!byRole.has(k)) byRole.set(k, { veto: 0, approve: 0, abstain: 0 });
    const c = byRole.get(k)!;
    (c as Record<string, number>)[r.vote as string] =
      ((c as Record<string, number>)[r.vote as string] ?? 0) + 1;
  }

  const lines: string[] = [
    "# Council Shadow Report — " + start.toISOString().slice(0, 10),
    "",
    "Surface | Role | Approves | Vetoes | Abstains | Veto rate",
    "--- | --- | --- | --- | --- | ---",
  ];

  for (const [role, c] of byRole) {
    const total = c.approve + c.veto + c.abstain;
    const rate = total > 0 ? (c.veto / total).toFixed(2) : "—";
    lines.push(
      "(mixed) | " +
        role +
        " | " +
        c.approve +
        " | " +
        c.veto +
        " | " +
        c.abstain +
        " | " +
        rate
    );
  }

  if (byRole.size === 0) lines.push("_(no shadow votes in window)_");
  return lines.join("\n");
}
