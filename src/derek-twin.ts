/**
 * Atlas Prime — Derek Twin Foundation
 *
 * Tracks the divergence between Derek's stated preferences and his revealed
 * behaviour, enabling Atlas to model the "real Derek" rather than the
 * declared one.
 *
 * Three public primitives:
 *   classifyObservation  — label a single Atlas→user exchange
 *   recomputeDivergence  — recalculate gap score for a preference and persist
 *   formatTwinReport     — render calibration + top divergences for Telegram
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { callHaiku as defaultCallHaiku } from "./haiku-client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObservationSignal = "accept" | "rewrite_align" | "rewrite_diverge" | "reject";

export interface DivergenceRow {
  preference_id: string;
  preference_text: string;
  domain: string | null;
  stated_score: number;
  revealed_score: number;
  gap: number;
  sample_size: number;
}

export interface TwinPrediction {
  id: string;
  prediction: string;
  confidence: number;
  basis: string;
  basis_refs: any;
  matched_turn_id: string | null;
  match_score: number | null;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const SIGNALS: ObservationSignal[] = ["accept", "rewrite_align", "rewrite_diverge", "reject"];

const CLASSIFY_SYSTEM = `You classify how a user response relates to a prior Atlas output, given a stated user preference.

Output a strict JSON object: {"signal": "accept" | "rewrite_align" | "rewrite_diverge" | "reject", "rationale": "<one short sentence>"}.

- accept: the user's followup accepts Atlas's output without rewriting (a thanks, a yes, an action taken).
- rewrite_align: the user rewrote Atlas's output, AND the rewrite is consistent with the stated preference.
- rewrite_diverge: the user rewrote Atlas's output, AND the rewrite contradicts the stated preference.
- reject: the user rejected the output (asked for redo, "no", "wrong", etc.).

Output only the JSON object. No preamble.`;

// ---------------------------------------------------------------------------
// classifyObservation
// ---------------------------------------------------------------------------

/**
 * Ask Haiku to label a single Atlas→user exchange relative to a stated
 * preference.  Throws on JSON parse failure or invalid signal value.
 */
export async function classifyObservation(opts: {
  preference_text: string;
  atlas_output: string;
  user_followup: string;
  callHaiku?: typeof defaultCallHaiku;
}): Promise<{ signal: ObservationSignal; rationale: string }> {
  const callHaiku = opts.callHaiku ?? defaultCallHaiku;

  const userMessage = JSON.stringify({
    preference: opts.preference_text,
    atlas_output: opts.atlas_output,
    user_followup: opts.user_followup,
  });

  const result = await callHaiku({
    system: CLASSIFY_SYSTEM,
    userMessage,
    maxTokens: 200,
    cacheSystem: true,
  });

  let parsed: any;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new Error(
      `derek-twin: failed to parse classifier output: ${result.text.slice(0, 200)}`
    );
  }

  if (!SIGNALS.includes(parsed.signal)) {
    throw new Error(`derek-twin: invalid signal "${parsed.signal}"`);
  }

  return {
    signal: parsed.signal as ObservationSignal,
    rationale: String(parsed.rationale ?? "").slice(0, 400),
  };
}

// ---------------------------------------------------------------------------
// recomputeDivergence
// ---------------------------------------------------------------------------

/**
 * Recompute the revealed_score for a preference by counting aligned
 * observations (accept | rewrite_align) over the full observation history,
 * then persist a row to twin_divergence.
 *
 * revealed_score = (accept + rewrite_align) / total
 * gap            = |1 - revealed_score|   (stated_score is always 1.0)
 */
export async function recomputeDivergence(
  supabase: SupabaseClient,
  preference_id: string,
  domain: string | null = null
): Promise<DivergenceRow> {
  // 1. Fetch the preference record
  const { data: pref } = await supabase
    .from("twin_stated_preferences")
    .select("*")
    .eq("id", preference_id)
    .single();

  if (!pref) throw new Error(`derek-twin: preference ${preference_id} not found`);

  // 2. Fetch all observations for this preference (+ optional domain filter)
  let q = supabase
    .from("twin_revealed_observations")
    .select("signal")
    .eq("preference_id", preference_id);

  if (domain) {
    q = (q as any).eq("domain", domain);
  }

  const { data: obs } = await (q as any).order("observed_at", { ascending: false });

  const observations = (obs ?? []) as Array<{ signal: ObservationSignal }>;
  const total = observations.length;
  const aligned = observations.filter(
    (o) => o.signal === "accept" || o.signal === "rewrite_align"
  ).length;

  const revealed_score = total > 0 ? aligned / total : 1;
  const gap = Math.abs(1 - revealed_score);

  const row: DivergenceRow = {
    preference_id,
    preference_text: (pref as any).preference,
    domain,
    stated_score: 1.0,
    revealed_score,
    gap,
    sample_size: total,
  };

  // 3. Persist computed divergence row
  await supabase.from("twin_divergence").insert({
    user_id: (pref as any).user_id,
    preference_id,
    domain,
    stated_score: 1.0,
    revealed_score,
    gap,
    sample_size: total,
  });

  return row;
}

// ---------------------------------------------------------------------------
// formatTwinReport
// ---------------------------------------------------------------------------

/**
 * Render a Telegram-friendly Twin Report summarising:
 *   - 30-day prediction calibration score
 *   - Top divergences (up to 5, sorted by gap descending)
 *   - Today's predictions with match status
 */
export function formatTwinReport(opts: {
  divergences: DivergenceRow[];
  todays_predictions: TwinPrediction[];
  calibration_30d: number;
}): string {
  const lines: string[] = [];

  lines.push(`**Twin Report** — calibration_30d: ${opts.calibration_30d.toFixed(2)}`);
  lines.push("");

  if (opts.divergences.length > 0) {
    lines.push("**Top divergences (stated ↔ revealed)**");
    const sorted = [...opts.divergences].sort((a, b) => b.gap - a.gap).slice(0, 5);
    for (const d of sorted) {
      const dom = d.domain ? ` [${d.domain}]` : "";
      lines.push(
        `- ${d.preference_text}${dom} — gap ${d.gap.toFixed(2)} (n=${d.sample_size})`
      );
    }
    lines.push("");
  }

  if (opts.todays_predictions.length > 0) {
    lines.push("**Today's predictions**");
    for (const p of opts.todays_predictions) {
      let status = "";
      if (p.match_score != null) {
        status = p.matched_turn_id
          ? ` ✓ (${p.match_score.toFixed(2)})`
          : " ✗";
      }
      lines.push(`- ${p.prediction} (${p.confidence.toFixed(2)}, ${p.basis})${status}`);
    }
  }

  return lines.join("\n");
}
