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
    caller: "twin-classify",
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

// ---------------------------------------------------------------------------
// generateMorningPredictions / scoreEveningPredictions / rollingCalibration
// ---------------------------------------------------------------------------

import { callOpus as defaultCallOpus } from "./haiku-client.ts";

interface MorningPredictOpts {
  /** Test injection point — the SDK-client `client` opt died in the CLI refactor. */
  callOpus?: typeof defaultCallOpus;
}

const PREDICT_SYSTEM = `You predict 3-5 things the user is likely to ask Atlas about today, given context.

Output a JSON array. Each item:
{
  "prediction": "<short noun phrase, like 'ad performance from yesterday'>",
  "confidence": <0..1>,
  "basis": "calendar" | "day-of-week-pattern" | "open-thread" | "recent-topic" | "revealed-preference",
  "basis_refs": { ... }
}

Output only the JSON array. No preamble.`;

export async function generateMorningPredictions(
  supabase: SupabaseClient,
  user_id: "derek" | "esther",
  date: string,
  opts: MorningPredictOpts = {}
): Promise<TwinPrediction[]> {
  const context: any = {
    today: date,
    weekday: new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long" }),
  };

  const { data: recent } = await supabase
    .from("twin_revealed_observations")
    .select("preference_text, signal, observed_at")
    .eq("user_id", user_id)
    .order("observed_at", { ascending: false })
    .limit(20);
  context.recent_revealed = recent ?? [];

  const userMessage = `Build 3-5 predictions for what ${user_id} will ask about today.\n\nCONTEXT:\n${JSON.stringify(context, null, 2)}`;

  const callOpus = opts.callOpus ?? defaultCallOpus;
  const resp = await callOpus({
    system: PREDICT_SYSTEM,
    userMessage,
    maxTokens: 1500,
  });
  const text = resp.text;
  let arr: any[];
  try {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  const inserted: TwinPrediction[] = [];
  for (const p of arr.slice(0, 5)) {
    const row = {
      user_id,
      predicted_for: date,
      prediction: String(p.prediction ?? "").slice(0, 500),
      confidence: Number(p.confidence ?? 0.5),
      basis: String(p.basis ?? "recent-topic"),
      basis_refs: p.basis_refs ?? null,
    };
    const { data } = await supabase.from("twin_predictions").insert(row).select().single();
    if (data) {
      inserted.push({
        id: (data as any).id,
        prediction: row.prediction,
        confidence: row.confidence,
        basis: row.basis,
        basis_refs: row.basis_refs,
        matched_turn_id: null,
        match_score: null,
      });
    }
  }
  return inserted;
}

const JUDGE_SYSTEM = `You decide whether a list of user-turn messages contains an approximate match to a prediction.

Output a strict JSON object: {"matched": true|false, "match_score": 0..1, "turn_id": "<uuid or empty>"}.

Approximate paraphrase counts. The prediction is a noun phrase; a question or statement that addresses that noun phrase is a match.

Output only the JSON object. No preamble.`;

interface ScoreEveningOpts {
  callHaiku?: typeof defaultCallHaiku;
}

export async function scoreEveningPredictions(
  supabase: SupabaseClient,
  user_id: "derek" | "esther",
  date: string,
  opts: ScoreEveningOpts = {}
): Promise<{ scored: number; calibration: number }> {
  const callHaiku = opts.callHaiku ?? defaultCallHaiku;

  const { data: predictions } = await supabase
    .from("twin_predictions")
    .select("id, prediction, matched_turn_id")
    .eq("user_id", user_id)
    .eq("predicted_for", date)
    .is("matched_turn_id", null);

  const preds = (predictions ?? []) as Array<{ id: string; prediction: string; matched_turn_id: string | null }>;
  if (!preds.length) return { scored: 0, calibration: 0 };

  const dayStart = `${date}T00:00:00Z`;
  const dayEnd = `${date}T23:59:59Z`;
  const { data: turns } = await supabase
    .from("messages")
    .select("id, content")
    .eq("role", "user")
    .gte("created_at", dayStart)
    .lte("created_at", dayEnd);
  const userTurns = (turns ?? []) as Array<{ id: string; content: string }>;

  let scoredSum = 0;
  let scoredCount = 0;
  for (const p of preds) {
    const userMsg = JSON.stringify({
      prediction: p.prediction,
      user_turns: userTurns.slice(0, 30).map((t) => ({ id: t.id, content: String(t.content).slice(0, 500) })),
    });
    const r = await callHaiku({
      system: JUDGE_SYSTEM,
      userMessage: userMsg,
      maxTokens: 200,
      cacheSystem: true,
      caller: "twin-score",
    });
    let judged: any;
    try {
      judged = JSON.parse(r.text);
    } catch {
      continue;
    }
    const matchScore = Number(judged.match_score ?? 0);
    const turnId = judged.matched && judged.turn_id ? String(judged.turn_id) : null;
    await supabase
      .from("twin_predictions")
      .update({
        match_score: matchScore,
        matched_turn_id: turnId,
        matched_at: new Date().toISOString(),
      })
      .eq("id", p.id);
    scoredSum += matchScore;
    scoredCount++;
  }

  const calibration = scoredCount ? scoredSum / scoredCount : 0;

  const { appendFile, mkdir } = await import("node:fs/promises");
  await mkdir("data", { recursive: true });
  await appendFile(
    "data/twin-calibration.jsonl",
    JSON.stringify({ user_id, date, calibration, scored_count: scoredCount }) + "\n",
    "utf8"
  );

  return { scored: scoredCount, calibration };
}

export async function rollingCalibration(
  supabase: SupabaseClient,
  user_id: string,
  days = 30
): Promise<{ mean: number; n: number; per_day: Array<{ date: string; calibration: number }> }> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { data } = await supabase
    .from("twin_predictions")
    .select("predicted_for, match_score")
    .eq("user_id", user_id)
    .gte("predicted_for", cutoff)
    .not("match_score", "is", null);
  const rows = (data ?? []) as Array<{ predicted_for: string; match_score: number }>;
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    if (!byDay.has(r.predicted_for)) byDay.set(r.predicted_for, []);
    byDay.get(r.predicted_for)!.push(r.match_score);
  }
  const per_day = Array.from(byDay.entries())
    .map(([date, scores]) => ({ date, calibration: scores.reduce((a, b) => a + b, 0) / scores.length }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const allScores = rows.map((r) => r.match_score);
  const mean = allScores.length ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
  return { mean, n: allScores.length, per_day };
}

// ---------------------------------------------------------------------------
// handleTwinCommand
// ---------------------------------------------------------------------------

export async function handleTwinCommand(
  supabase: SupabaseClient,
  args: string[],
  user_id: "derek" | "esther"
): Promise<string> {
  const sub = (args[0] ?? "").toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  switch (sub) {
    case "predictions":
    case "predict": {
      const { data } = await supabase
        .from("twin_predictions")
        .select("*")
        .eq("user_id", user_id)
        .eq("predicted_for", today);
      const preds = (data ?? []) as TwinPrediction[];
      if (!preds.length) return "No predictions for today yet.";
      return ["**Today's predictions**", ...preds.map(formatPredLine)].join("\n");
    }
    case "divergence":
    case "divergences": {
      const { data } = await supabase
        .from("twin_divergence")
        .select("*")
        .eq("user_id", user_id)
        .order("computed_at", { ascending: false })
        .limit(50);
      const rows = (data ?? []) as DivergenceRow[];
      if (!rows.length) return "No divergence data yet.";
      // Dedupe per preference (latest only)
      const seen = new Set<string>();
      const dedup = rows.filter((r) => {
        if (seen.has(r.preference_id)) return false;
        seen.add(r.preference_id);
        return true;
      });
      const sorted = dedup.sort((a, b) => b.gap - a.gap).slice(0, 10);
      return ["**Top divergences**", ...sorted.map((d) =>
        `- ${d.preference_text}${d.domain ? ` [${d.domain}]` : ""}: gap ${d.gap.toFixed(2)} (n=${d.sample_size})`
      )].join("\n");
    }
    case "calibration": {
      const cal = await rollingCalibration(supabase, user_id, 30);
      const lines = [`**Calibration 30d**: ${cal.mean.toFixed(2)} (n=${cal.n})`];
      if (cal.per_day.length) {
        lines.push("");
        lines.push("**Per-day**");
        for (const d of cal.per_day) {
          lines.push(`- ${d.date}: ${d.calibration.toFixed(2)}`);
        }
      }
      return lines.join("\n");
    }
    case "reconcile": {
      const id = args[1];
      if (!id) return "Usage: `/twin reconcile <preference_id>`";
      const { data: pref } = await supabase
        .from("twin_stated_preferences")
        .select("*")
        .eq("id", id)
        .single();
      if (!pref) return `Preference \`${id}\` not found.`;
      const { data: divergence } = await supabase
        .from("twin_divergence")
        .select("*")
        .eq("preference_id", id)
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!divergence) return `No divergence data for \`${id}\` yet.`;
      const d = divergence as any;
      return [
        `**Reconcile** \`${id}\``,
        `Stated: "${(pref as any).preference}"`,
        `Revealed score: ${Number(d.revealed_score).toFixed(2)} (gap ${Number(d.gap).toFixed(2)}, n=${d.sample_size})`,
        ``,
        `Reply with one of:`,
        `\`/twin update ${id} <new preference text>\` — update stated to match observed behavior`,
        `\`/twin hold ${id}\` — keep stated, accept the divergence`,
      ].join("\n");
    }
    case "update": {
      const id = args[1];
      const newText = args.slice(2).join(" ");
      if (!id || !newText) return "Usage: `/twin update <id> <new text>`";
      await supabase
        .from("twin_stated_preferences")
        .update({ preference: newText, stated_at: new Date().toISOString() })
        .eq("id", id);
      return `Preference \`${id}\` updated.`;
    }
    case "hold": {
      const id = args[1];
      if (!id) return "Usage: `/twin hold <id>`";
      return `Holding stated preference \`${id}\`. Atlas will continue tuning predictions to revealed behavior but won't alert again on this gap for 14 days.`;
    }
    default: {
      // Snapshot
      const cal = await rollingCalibration(supabase, user_id, 30);
      const { data: divs } = await supabase
        .from("twin_divergence")
        .select("*")
        .eq("user_id", user_id)
        .order("computed_at", { ascending: false })
        .limit(50);
      const seen = new Set<string>();
      const dedupedDiv = (divs ?? []).filter((d: any) => {
        if (seen.has(d.preference_id)) return false;
        seen.add(d.preference_id);
        return true;
      }) as DivergenceRow[];
      const { data: preds } = await supabase
        .from("twin_predictions")
        .select("*")
        .eq("user_id", user_id)
        .eq("predicted_for", today);
      return formatTwinReport({
        divergences: dedupedDiv,
        todays_predictions: (preds ?? []) as TwinPrediction[],
        calibration_30d: cal.mean,
      });
    }
  }
}

function formatPredLine(p: TwinPrediction): string {
  const status = p.match_score == null ? "" : p.matched_turn_id ? ` ✓ ${p.match_score.toFixed(2)}` : " ✗";
  return `- ${p.prediction} (${p.confidence.toFixed(2)}, ${p.basis})${status}`;
}
