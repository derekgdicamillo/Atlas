/**
 * Atlas Prime — Shadow Council
 * 3 trust-weighted critics on every patient-facing send. Per-surface shadow/live mode.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Action } from "./role-registry";

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
// review() — STUB. Critic prompts + Promise.race SLA implemented in Task 9.
// ---------------------------------------------------------------------------

export async function review(
  _supabase: SupabaseClient,
  _action: Action
): Promise<CouncilReviewResult> {
  throw new Error("review() implemented in Task 9");
}
