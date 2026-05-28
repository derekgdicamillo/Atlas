/**
 * Atlas Prime Sprint 6 — Skill Shadow Router
 *
 * judge + promotion/demotion math + score-recording.
 * Uses callHaiku (CLI-backed) exclusively — no @anthropic-ai/sdk imports.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { callHaiku as defaultCallHaiku } from "./haiku-client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskInput {
  task_description: string;
  task_id?: string;
  domain?: string;
}

export type ShadowVerdict = "shadow_wins" | "baseline_wins" | "tie";

export interface ShadowScoreRow {
  id?: number;
  task_id?: string;
  skill_id?: string;
  baseline_skill_id?: string;
  task_kind?: string;
  domain?: string;
  judge_verdict: ShadowVerdict;
  judge_reason?: string;
  derek_veto: boolean;
  derek_veto_at?: string | null;
  scored_at?: string;
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM = `You judge which of two outputs better serves the task.

Output a strict JSON object: {"verdict": "shadow_wins" | "baseline_wins" | "tie", "reason": "<one short sentence>"}.

No preamble. No markdown fences.`;

interface JudgeDeps {
  callHaiku?: typeof defaultCallHaiku;
}

export async function judgeShadowOutput(
  task: TaskInput,
  baseline_output: any,
  shadow_output: any,
  deps: JudgeDeps = {}
): Promise<{ verdict: ShadowVerdict; reason: string }> {
  const haiku = deps.callHaiku ?? defaultCallHaiku;
  const userMessage = JSON.stringify({
    task: task.task_description,
    baseline_output: String(baseline_output).slice(0, 4000),
    shadow_output: String(shadow_output).slice(0, 4000),
  });

  const result = await haiku({
    system: JUDGE_SYSTEM,
    userMessage,
    maxTokens: 200,
    cacheSystem: true,
    caller: "skill-shadow-judge",
  });

  let parsed: any;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new Error(
      `skill-shadow-router: failed to parse judge output: ${result.text.slice(0, 200)}`
    );
  }

  const VALID_VERDICTS: ShadowVerdict[] = ["shadow_wins", "baseline_wins", "tie"];
  if (!VALID_VERDICTS.includes(parsed.verdict)) {
    throw new Error(`skill-shadow-router: invalid verdict "${parsed.verdict}"`);
  }

  return {
    verdict: parsed.verdict as ShadowVerdict,
    reason: String(parsed.reason ?? "").slice(0, 400),
  };
}

// ---------------------------------------------------------------------------
// Promotion / Demotion math
// ---------------------------------------------------------------------------

const PROMOTE_WINDOW = Number(process.env.SHADOW_WINDOW_SIZE ?? 10);
const PROMOTE_THRESHOLD = Number(process.env.SHADOW_PROMOTE_THRESHOLD ?? 7);

export function computePromotion(
  scores: Pick<ShadowScoreRow, "judge_verdict" | "derek_veto">[]
): { promote: boolean; window: number; wins: number } {
  const active = scores.filter((s) => !s.derek_veto);
  const wins = active.filter((s) => s.judge_verdict === "shadow_wins").length;

  if (active.length < PROMOTE_WINDOW) {
    return { promote: false, window: active.length, wins };
  }

  const window = active.slice(0, PROMOTE_WINDOW);
  const windowWins = window.filter((s) => s.judge_verdict === "shadow_wins").length;
  return { promote: windowWins >= PROMOTE_THRESHOLD, window: window.length, wins: windowWins };
}

export function computeDemotion(
  scores: Pick<ShadowScoreRow, "judge_verdict" | "derek_veto">[]
): { demote: boolean; window: number; losses: number } {
  const active = scores.filter((s) => !s.derek_veto);
  const losses = active.filter((s) => s.judge_verdict === "baseline_wins").length;

  if (active.length < PROMOTE_WINDOW) {
    return { demote: false, window: active.length, losses };
  }

  const window = active.slice(0, PROMOTE_WINDOW);
  const windowLosses = window.filter((s) => s.judge_verdict === "baseline_wins").length;
  return { demote: windowLosses >= PROMOTE_THRESHOLD, window: window.length, losses: windowLosses };
}

// ---------------------------------------------------------------------------
// Supabase persistence
// ---------------------------------------------------------------------------

export async function recordScore(
  supabase: SupabaseClient,
  row: Omit<ShadowScoreRow, "id" | "scored_at" | "derek_veto" | "derek_veto_at">
): Promise<{ promote: boolean; demote: boolean }> {
  await supabase
    .from("skill_shadow_scores")
    .insert({ ...row, derek_veto: false });

  const { data: history } = await supabase
    .from("skill_shadow_scores")
    .select("judge_verdict, derek_veto")
    .eq("skill_id", row.skill_id)
    .order("scored_at", { ascending: false })
    .limit(PROMOTE_WINDOW);

  const promotion = computePromotion((history ?? []) as ShadowScoreRow[]);
  const demotion = computeDemotion((history ?? []) as ShadowScoreRow[]);
  return { promote: promotion.promote, demote: demotion.demote };
}

export async function vetoShadowWin(
  supabase: SupabaseClient,
  scoreId: number,
  _by: "derek" | "esther"
): Promise<void> {
  await supabase
    .from("skill_shadow_scores")
    .update({
      derek_veto: true,
      derek_veto_at: new Date().toISOString(),
    })
    .eq("id", scoreId);
}
