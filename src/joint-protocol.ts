/**
 * Atlas Prime — Joint Protocol
 * Atlas + Ishtar negotiation on shared-owner decisions.
 * I3 hard-shortlist trigger + J3 sync/async by urgency + K3 transcript-as-memo.
 *
 * Task 16: foundation — types + openDeliberation + postCounter + listOpen + get.
 * Task 17: shouldFireJoint (trigger detection)
 * Task 18: arbitrate (full resolution) + requestIshtarMirrorReview + sweepDeadlines
 * Task 19: /joint command
 * Task 20: cron registration
 */
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { existsSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Anthropic } from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  openDeliberation as openBlackboard,
  commitContract,
  walkTranscript,
  mergeDeliberation,
  type TranscriptCommit,
} from "./blackboard-git";
import { signContract, type Action } from "./role-registry";
import { processPool } from "./persistent-pool";
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

// ============================================================
// ARBITRATOR PROMPT (K3)
// ============================================================

const ARBITRATOR_PROMPT = `You are the Joint Protocol Arbitrator. Below is the full git-log transcript of a joint deliberation between Atlas (Derek's voice) and Ishtar Mirror (Esther's voice).

Read the entire transcript. Decide:
- Did they agree?
- What is the final decision?
- If they did NOT agree, output a majority position + minority report.
- Cite specific commits as evidence pointers.

Output strict JSON:
{
  "agreed": bool,
  "memo": "final decision in plain English, max 8 sentences",
  "majority_position": "(only if !agreed)",
  "minority_report": "(only if !agreed)",
  "evidence_pointers": ["<commit>:<file>", ...]
}

TRANSCRIPT:
{transcript}
`;

/**
 * Thin Opus wrapper.
 *
 * DEVIATION FROM PLAN: The plan calls `runOpus` from `./claude`, but `claude.ts`
 * only exports `callClaude` (a CLI subprocess launcher). Role-bootstrap.ts uses
 * `@anthropic-ai/sdk` directly, but `ANTHROPIC_API_KEY` is not in the project
 * .env — Sprint 4/5 Opus calls go through Derek's Max-plan Claude CLI OAuth.
 *
 * Strategy (dual-path):
 * 1. If ANTHROPIC_API_KEY is set → use SDK directly (same as role-bootstrap.ts).
 * 2. Otherwise → use Claude CLI subprocess with --model opus (same pattern as
 *    haiku-client.ts, which is the established Max-plan pattern for this project).
 */
async function runOpus(prompt: string, opts: { maxTokens?: number } = {}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey) {
    // SDK path (when running with a direct API key)
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: opts.maxTokens ?? 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    if (!block || block.type !== "text") {
      throw new Error("Unexpected Opus response block type: " + (block as any)?.type);
    }
    return block.text;
  }

  // CLI subprocess path (Max-plan OAuth — same pattern as haiku-client.ts)
  const { spawn } = await import("bun");
  const { sanitizedEnv, validateSpawnArgs } = await import("./claude.ts");
  const { extractFirstAssistantText } = await import("./prompt-runner.ts");
  const { error: logError } = await import("./logger.ts");

  const claudePath = process.env.CLAUDE_PATH || "claude";
  const projectDir = process.env.PROJECT_DIR || process.cwd();

  const args = [
    claudePath,
    "-p",
    "--model", "opus",
    "--output-format", "stream-json",
    "--verbose",
    "--allowedTools", "",
  ];

  validateSpawnArgs(args);

  try {
    const proc = spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectDir,
      env: sanitizedEnv(),
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`runOpus CLI exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    return extractFirstAssistantText(output);
  } catch (err) {
    logError("joint-protocol", `runOpus failed: ${err}`);
    throw err;
  }
}

/**
 * arbitrate() — Task 18.
 * Reads the full git-log transcript of a deliberation branch, calls Opus to
 * produce a structured arbitration result, merges to final-memo.md, and closes
 * the DB row.
 */
export async function arbitrate(
  supabase: SupabaseClient,
  deliberationId: string
): Promise<{ memo: string; agreed: boolean; mergeCommit: string }> {
  // 1. Fetch deliberation row
  const { data: row, error } = await supabase
    .from("joint_deliberations")
    .select("*")
    .eq("id", deliberationId)
    .maybeSingle();

  if (error) throw new Error("joint_deliberations select failed: " + error.message);
  if (!row) throw new Error("deliberation not found: " + deliberationId);

  // 2. Build full transcript via git log -p
  const repoPath = join(process.cwd(), "data", "atlas-blackboard.git");
  let transcript: string;
  try {
    // Use quoted git-dir path; branch name must not contain spaces (safe for joint/ names)
    transcript = execSync(
      `git --git-dir="${repoPath}" log -p ${row.branch}`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    ).slice(0, 30000);
  } catch (gitErr: any) {
    // Fallback: simpleGit (already a dep via blackboard-git.ts)
    const { simpleGit } = await import("simple-git");
    const sg = simpleGit({ baseDir: process.cwd() });
    const raw = await sg.raw([
      "--git-dir=" + repoPath,
      "log",
      "-p",
      row.branch,
    ]);
    transcript = raw.slice(0, 30000);
  }

  // 3. Call Opus arbitrator
  const opusInput = ARBITRATOR_PROMPT.replace("{transcript}", transcript);
  const out = await runOpus(opusInput, { maxTokens: 2000 });

  // 4. Parse strict JSON from response
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("arbitrator returned no JSON: " + out.slice(0, 200));
  const parsed = JSON.parse(m[0]) as {
    agreed: boolean;
    memo: string;
    majority_position?: string;
    minority_report?: string;
    evidence_pointers?: string[];
  };

  // 5. Build memo text
  let memoText = parsed.memo;
  if (!parsed.agreed) {
    memoText =
      parsed.memo +
      "\n\n## Majority\n" +
      (parsed.majority_position ?? "") +
      "\n\n## Minority\n" +
      (parsed.minority_report ?? "");
  }

  // 6. Append evidence pointers
  if (parsed.evidence_pointers?.length) {
    memoText += "\n\n## Evidence\n" + parsed.evidence_pointers.map((e) => "- " + e).join("\n");
  }

  // 7. Merge to final-memo.md via blackboard-git
  const { mergeCommit } = await mergeDeliberation(
    row.branch,
    memoText,
    "arbitrator-opus",
    parsed.agreed
  );

  // 8. Update DB row: status=closed, closed_at, final_commit, agreed
  await supabase
    .from("joint_deliberations")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      final_commit: mergeCommit,
      agreed: parsed.agreed,
    })
    .eq("id", deliberationId);

  // 9. Return result
  return { memo: memoText, agreed: parsed.agreed, mergeCommit };
}

/**
 * requestIshtarMirrorReview() — Task 18 (J3 routing).
 * Sends a review request to Ishtar's persistent-pool entry.
 * If urgent: polls for status change up to URGENT_TIMEOUT_MS (60s).
 *
 * DEVIATION FROM PLAN: plan calls sendToPool("ishtar", ...) but persistent-pool.ts
 * exports processPool (ProcessPool class) with a .get(agentId) => PersistentProcess
 * that has .sendTurn(prompt). We adapt accordingly.
 */
export async function requestIshtarMirrorReview(
  supabase: SupabaseClient,
  deliberationId: string,
  urgent: boolean
): Promise<void> {
  try {
    const proc = processPool.get("ishtar");
    // Fire-and-forget: don't await (Ishtar's pool may be idle; ensureAlive handles it)
    proc.sendTurn("joint:review " + deliberationId).catch(() => {
      // best-effort silent — deadline sweeper will catch it
    });
  } catch {
    // If pool throws (e.g., not configured), swallow — deadline sweeper will handle it
  }

  if (urgent) {
    // Poll up to URGENT_TIMEOUT_MS for status change to converging or closed
    const start = Date.now();
    while (Date.now() - start < URGENT_TIMEOUT_MS) {
      const { data } = await supabase
        .from("joint_deliberations")
        .select("status")
        .eq("id", deliberationId)
        .maybeSingle();
      if (data?.status === "converging" || data?.status === "closed") return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    // Timeout — caller decides next action (escalation is Task 19/20)
  }
}

/**
 * sweepDeadlines() — Task 18 (J3 deadline cron).
 * Marks overdue pending deliberations as expired.
 * Called by the cron registered in Task 20.
 */
export async function sweepDeadlines(
  supabase: SupabaseClient
): Promise<{ expired: number }> {
  const now = new Date().toISOString();
  const { data: pending, error } = await supabase
    .from("joint_deliberations")
    .select("id")
    .eq("status", "pending")
    .lt("deadline_at", now);

  if (error) throw new Error("sweepDeadlines select failed: " + error.message);

  let expired = 0;
  for (const p of pending ?? []) {
    await supabase
      .from("joint_deliberations")
      .update({ status: "expired", closed_at: now })
      .eq("id", p.id);
    expired += 1;
  }

  return { expired };
}
