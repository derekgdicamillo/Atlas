/**
 * Atlas Prime — Joint Protocol
 * Atlas + Ishtar negotiation on shared-owner decisions.
 * I3 hard-shortlist trigger + J3 sync/async by urgency + K3 transcript-as-memo.
 *
 * Task 16: foundation — types + openDeliberation + postCounter + listOpen + get.
 * Task 17: shouldFireJoint (trigger detection)
 * Task 18: arbitrate (full resolution)
 * Task 19: /joint command
 * Task 20: cron registration
 */
import { randomUUID } from "crypto";
import { existsSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  openDeliberation as openBlackboard,
  commitContract,
  walkTranscript,
  type TranscriptCommit,
} from "./blackboard-git";
import { signContract, type Action } from "./role-registry";
import { I3_TRIGGERS } from "./joint-triggers";

// ============================================================
// TYPES
// ============================================================

export interface JointDeliberation {
  id: string;
  branch: string;
  opened_by: "atlas" | "ishtar" | "derek" | "esther";
  trigger_reason: string;
  urgency: "urgent" | "routine";
  status: "pending" | "converging" | "closed" | "expired";
  opened_at: string;
  deadline_at: string | null;
  closed_at: string | null;
  final_commit: string | null;
  agreed: boolean | null;
}

export { TranscriptCommit };

// ============================================================
// CONSTANTS
// ============================================================

export const ROUTINE_DEADLINE_MS = 2 * 3_600_000;   // 2 hours
export const URGENT_TIMEOUT_MS = 60_000;             // 60 seconds

const WORKTREES_ROOT = join(process.cwd(), "data", "blackboard-worktrees");

// ============================================================
// PATH HELPER (mirrors blackboard-git.branchToDir — safe for branches ≤ 80 chars)
// ============================================================

function branchToDir(branch: string): string {
  const safe = branch.replace(/[/\\]/g, "_");
  // Joint branches are always < 80 chars; simple replace is safe.
  return safe;
}

function worktreePath(branch: string): string {
  return join(WORKTREES_ROOT, branchToDir(branch));
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Open a new joint deliberation.
 * Creates a blackboard branch, writes proposal.md, and inserts a DB row.
 */
export async function openDeliberation(
  supabase: SupabaseClient,
  opener: "atlas" | "ishtar" | "derek" | "esther",
  proposal: string,
  urgency: "urgent" | "routine",
  triggerReason: string
): Promise<{ deliberationId: string; branch: string }> {
  const id = randomUUID();
  const slug = "deliberation-" + id.slice(0, 8);

  // Open the blackboard branch (primitive = "joint")
  const { branch, worktreePath: wt } = await openBlackboard(slug, "joint");

  // Write proposal.md to the worktree
  writeFileSync(
    join(wt, "proposal.md"),
    `# Proposal — opened by ${opener}\n\n${proposal}\n`
  );

  // Sign + commit (best-effort; ignore key-not-found errors)
  // Human openers route through Atlas; ishtar opener uses ishtar-mirror key.
  const signerRoleId = opener === "esther" ? "ishtar-mirror" : opener === "ishtar" ? "ishtar-mirror" : "atlas";
  try {
    const contract = await signContract(signerRoleId, {
      proposal,
      opener,
      urgency,
      trigger_reason: triggerReason,
    });
    await commitContract(branch, contract, "proposal: " + opener);
  } catch {
    // key not found or commit error — continue without signed commit
  }

  // Persist to DB
  const deadline =
    urgency === "routine"
      ? new Date(Date.now() + ROUTINE_DEADLINE_MS).toISOString()
      : null;

  const { error } = await supabase.from("joint_deliberations").insert({
    id,
    branch,
    opened_by: opener,
    trigger_reason: triggerReason,
    urgency,
    status: "pending",
    deadline_at: deadline,
  });
  if (error) throw new Error("joint_deliberations insert failed: " + error.message);

  return { deliberationId: id, branch };
}

/**
 * Post a counter-proposal to an existing deliberation.
 * Writes counter-proposal-N.md to the worktree, commits it, and sets status=converging.
 */
export async function postCounter(
  supabase: SupabaseClient,
  deliberationId: string,
  agent: "atlas" | "ishtar",
  counter: string
): Promise<void> {
  const { data: row, error } = await supabase
    .from("joint_deliberations")
    .select("branch, status")
    .eq("id", deliberationId)
    .maybeSingle();

  if (error) throw new Error("joint_deliberations select failed: " + error.message);
  if (!row) throw new Error("deliberation not found: " + deliberationId);
  if (row.status === "closed" || row.status === "expired") {
    throw new Error("cannot post counter to " + row.status + " deliberation");
  }

  const wt = worktreePath(row.branch);
  if (!existsSync(wt)) {
    throw new Error("worktree not found for branch: " + row.branch);
  }

  // Count existing counter files to derive the round number
  const existing = readdirSync(wt).filter((f) => f.startsWith("counter-proposal-")).length;
  const round = existing + 1;
  const filename = `counter-proposal-${round}.md`;

  writeFileSync(
    join(wt, filename),
    `# Counter ${round} — by ${agent}\n\n${counter}\n`
  );

  const signerRoleId = agent === "ishtar" ? "ishtar-mirror" : "atlas";
  try {
    const contract = await signContract(signerRoleId, {
      counter,
      agent,
      round,
      deliberation_id: deliberationId,
    });
    await commitContract(row.branch, contract, `${agent}: counter ${round}`);
  } catch {
    // best-effort; signing or commit failure doesn't block the counter
  }

  // Update status to converging
  const { error: upErr } = await supabase
    .from("joint_deliberations")
    .update({ status: "converging" })
    .eq("id", deliberationId);
  if (upErr) throw new Error("joint_deliberations update failed: " + upErr.message);
}

/**
 * List all open deliberations (status = pending | converging).
 */
export async function listOpen(supabase: SupabaseClient): Promise<JointDeliberation[]> {
  const { data, error } = await supabase
    .from("joint_deliberations")
    .select("*")
    .in("status", ["pending", "converging"])
    .order("opened_at", { ascending: false });

  if (error) throw new Error("joint_deliberations select failed: " + error.message);
  return (data ?? []) as JointDeliberation[];
}

/**
 * Get a deliberation by ID, including its full transcript and final memo (if closed).
 */
export async function get(
  supabase: SupabaseClient,
  deliberationId: string
): Promise<{
  deliberation: JointDeliberation;
  transcript: TranscriptCommit[];
  finalMemo: string | null;
}> {
  const { data, error } = await supabase
    .from("joint_deliberations")
    .select("*")
    .eq("id", deliberationId)
    .maybeSingle();

  if (error) throw new Error("joint_deliberations select failed: " + error.message);
  if (!data) throw new Error("deliberation not found: " + deliberationId);

  const transcript = await walkTranscript(data.branch);

  let finalMemo: string | null = null;
  if (data.status === "closed") {
    const memoPath = join(worktreePath(data.branch), "final-memo.md");
    try {
      finalMemo = readFileSync(memoPath, "utf-8");
    } catch {
      finalMemo = null;
    }
  }

  return {
    deliberation: data as JointDeliberation,
    transcript,
    finalMemo,
  };
}

/**
 * shouldFireJoint — I3 hard-coded trigger detection.
 * Pure regex in the hot path; no Haiku classifier.
 * Looks up per-trigger mode from joint_trigger_modes table (default: 'shadow').
 */
export async function shouldFireJoint(
  supabase: SupabaseClient,
  action: Action,
  conversationContext: string
): Promise<{ fire: boolean; trigger: string | null; mode: "shadow" | "live" }> {
  const text = (conversationContext + " " + JSON.stringify(action.args)).slice(0, 4000);
  for (const t of I3_TRIGGERS) {
    if (!t.match.test(text)) continue;
    if (t.contextKeywords && !t.contextKeywords.some((k) => text.toLowerCase().includes(k.toLowerCase()))) continue;
    if (t.requiresAction && !(action.args as Record<string, unknown>).actionRequested) continue;
    // Look up per-trigger mode from DB (default: 'shadow')
    const { data } = await supabase
      .from("joint_trigger_modes")
      .select("mode")
      .eq("trigger_name", t.name)
      .maybeSingle();
    const mode = (data?.mode as "shadow" | "live") ?? "shadow";
    return { fire: true, trigger: t.name, mode };
  }
  return { fire: false, trigger: null, mode: "shadow" };
}

/**
 * promoteTrigger — move a trigger from shadow to live mode.
 * Upserts joint_trigger_modes row with mode='live'.
 */
export async function promoteTrigger(
  supabase: SupabaseClient,
  triggerName: string,
  byUser: string
): Promise<void> {
  await supabase.from("joint_trigger_modes").upsert(
    { trigger_name: triggerName, mode: "live", promoted_by: byUser, promoted_at: new Date().toISOString() },
    { onConflict: "trigger_name" }
  );
}

/**
 * arbitrate() — implemented in Task 18.
 */
export async function arbitrate(
  _supabase: SupabaseClient,
  _deliberationId: string
): Promise<{ memo: string; agreed: boolean; mergeCommit: string }> {
  throw new Error("arbitrate() implemented in Task 18");
}
