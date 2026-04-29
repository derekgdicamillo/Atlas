import { spawn } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findEffects, type CausalEdge } from "./causal-graph.ts";
import { callHaiku } from "./haiku-client.ts";

export interface ForecastBands {
  p05: number[];
  p50: number[];
  p95: number[];
}

export interface CounterfactualForecastResult {
  baseline: ForecastBands;
  conditional: ForecastBands;
  dagEdgesUsed: string[];
  reasoning: string;
}

export type { CausalEdge } from "./causal-graph.ts";

async function runChronosSubprocess(history: number[], horizon: number): Promise<ForecastBands> {
  return new Promise((resolve, reject) => {
    const py = spawn("python", ["scripts/chronos_forecast.py"]);
    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d) => (stdout += d.toString()));
    py.stderr.on("data", (d) => (stderr += d.toString()));
    py.on("close", () => {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) return reject(new Error(parsed.error));
        resolve({ p05: parsed.p05, p50: parsed.p50, p95: parsed.p95 });
      } catch {
        reject(new Error(`chronos subprocess failed: ${stderr || "unknown"}`));
      }
    });
    py.on("error", (err) => reject(err));
    py.stdin.write(JSON.stringify({ history, horizon }));
    py.stdin.end();
  });
}

export async function forecast(opts: {
  metric: string;
  horizonDays: number;
  history: Array<{ date: string; value: number }>;
}): Promise<ForecastBands> {
  const values = opts.history.map((h) => h.value);
  return await runChronosSubprocess(values, opts.horizonDays);
}

export function applyDagEffects(
  baseline: ForecastBands,
  edges: CausalEdge[],
  actionDay: number
): ForecastBands {
  const p05 = [...baseline.p05];
  const p50 = [...baseline.p50];
  const p95 = [...baseline.p95];
  for (const e of edges) {
    if (e.effect_size == null) continue;
    const ciWidth = e.effect_ci ? e.effect_ci.high - e.effect_ci.low : Math.abs(e.effect_size) * 0.4;
    for (let t = Math.max(0, actionDay); t < p50.length; t++) {
      p05[t] += e.effect_size - ciWidth / 2;
      p50[t] += e.effect_size;
      p95[t] += e.effect_size + ciWidth / 2;
    }
  }
  return { p05, p50, p95 };
}

export async function forecastCounterfactual(
  supabase: SupabaseClient,
  opts: {
    metric: string;
    horizonDays: number;
    history: Array<{ date: string; value: number }>;
    action: { kind: string; when: string; magnitude?: number };
  }
): Promise<CounterfactualForecastResult> {
  const baseline = await forecast({
    metric: opts.metric,
    horizonDays: opts.horizonDays,
    history: opts.history,
  });

  const allEdges = await findEffects(supabase, opts.action.kind);
  const { data: metricNode } = await supabase
    .from("causal_nodes")
    .select("id")
    .eq("name", opts.metric)
    .single();
  const directEdges = metricNode
    ? allEdges.filter((e) => e.to_node === (metricNode as any).id)
    : [];

  const lastHistoryDate = opts.history.length
    ? new Date(opts.history[opts.history.length - 1].date)
    : new Date();
  const actionDate = new Date(opts.action.when);
  const actionDay = Math.max(
    0,
    Math.floor((actionDate.getTime() - lastHistoryDate.getTime()) / 86_400_000)
  );

  const conditional = applyDagEffects(baseline, directEdges, actionDay);
  const dagEdgesUsed = directEdges.map((e) => e.id);

  let reasoning = `Forecast comparison for ${opts.metric} over ${opts.horizonDays} days.`;
  if (directEdges.length) {
    const edgesSummary = directEdges
      .map((e) => `edge ${e.id.slice(0, 8)}… effect ${e.effect_size}`)
      .join(", ");
    try {
      const r = await callHaiku({
        system:
          "Compose ONE short paragraph (≤80 words) explaining how an action's DAG-encoded effects shift a forecast. Cite each edge by short id.",
        userMessage:
          `Action: ${opts.action.kind} on ${opts.action.when}. Metric: ${opts.metric}. ` +
          `Edges applied: ${edgesSummary}. ` +
          `Baseline p50 final: ${baseline.p50[baseline.p50.length - 1].toFixed(0)}. ` +
          `Conditional p50 final: ${conditional.p50[conditional.p50.length - 1].toFixed(0)}.`,
        maxTokens: 200,
        cacheSystem: true,
      });
      reasoning = r.text.trim();
    } catch {
      /* keep default */
    }
  }

  await supabase.from("world_model_forecasts").insert({
    metric: opts.metric,
    horizon_days: opts.horizonDays,
    counterfactual: opts.action,
    baseline_p50: baseline.p50,
    baseline_p05: baseline.p05,
    baseline_p95: baseline.p95,
    conditional_p50: conditional.p50,
    conditional_p05: conditional.p05,
    conditional_p95: conditional.p95,
    dag_edges_used: dagEdgesUsed,
    notes: reasoning.slice(0, 1000),
  });

  return { baseline, conditional, dagEdgesUsed, reasoning };
}

export async function preWarm(): Promise<void> {
  try {
    await runChronosSubprocess([1, 2, 3, 2, 1, 2, 3, 2, 1, 2, 3, 2], 3);
  } catch (err) {
    console.warn("[world-model] preWarm failed:", err);
  }
}

export async function handleForecastCommand(
  supabase: SupabaseClient,
  args: string[]
): Promise<string> {
  if (!args.length) {
    return [
      "**Forecast usage**",
      "`/forecast <metric> <horizon_days>`",
      "`/forecast <metric> <horizon_days> if <action_name> on YYYY-MM-DD`",
    ].join("\n");
  }
  const metric = args[0];
  const horizonDays = Math.max(1, Math.min(180, parseInt(args[1] ?? "30", 10)));

  // Pull history from business_scorecard
  const { data: scorecard } = await supabase
    .from("business_scorecard")
    .select(`period_start, ${metric}`)
    .eq("period_type", "daily")
    .order("period_start", { ascending: true });
  const history = ((scorecard ?? []) as any[])
    .map((r) => ({ date: String(r.period_start).slice(0, 10), value: Number(r[metric]) }))
    .filter((h) => Number.isFinite(h.value));
  if (history.length < 7) {
    return `Not enough history for \`${metric}\` (need >= 7 days, have ${history.length}).`;
  }

  const ifIdx = args.indexOf("if");
  if (ifIdx < 0) {
    try {
      const baseline = await forecast({ metric, horizonDays, history });
      const final = baseline.p50[baseline.p50.length - 1];
      const lo = baseline.p05[baseline.p05.length - 1];
      const hi = baseline.p95[baseline.p95.length - 1];
      return [
        `**${metric} · ${horizonDays}-day forecast**`,
        ``,
        `Baseline: ${final.toFixed(0)} (p05–p95: ${lo.toFixed(0)}–${hi.toFixed(0)})`,
      ].join("\n");
    } catch (err) {
      return `Forecast failed: ${(err as Error).message}`;
    }
  }
  const actionName = args[ifIdx + 1];
  const onIdx = args.indexOf("on", ifIdx);
  const when = onIdx > 0 ? args[onIdx + 1] : new Date().toISOString().slice(0, 10);
  if (!actionName || !when) {
    return "Usage: `/forecast <metric> <horizon> if <action> on YYYY-MM-DD`";
  }

  try {
    const result = await forecastCounterfactual(supabase, {
      metric,
      horizonDays,
      history,
      action: { kind: actionName, when },
    });

    const finalB = result.baseline.p50[result.baseline.p50.length - 1];
    const finalC = result.conditional.p50[result.conditional.p50.length - 1];
    const lines = [
      `**${metric} · ${horizonDays}-day forecast**`,
      ``,
      `Baseline: ${finalB.toFixed(0)} (p05–p95: ${result.baseline.p05[result.baseline.p05.length - 1].toFixed(0)}–${result.baseline.p95[result.baseline.p95.length - 1].toFixed(0)})`,
      `Conditional ("if ${actionName} on ${when}"): ${finalC.toFixed(0)} (p05–p95: ${result.conditional.p05[result.conditional.p05.length - 1].toFixed(0)}–${result.conditional.p95[result.conditional.p95.length - 1].toFixed(0)})`,
      ``,
      `**Audit chain**`,
      ...result.dagEdgesUsed.map((id) => `- \`${id.slice(0, 8)}…\``),
      ``,
      result.reasoning,
    ];
    return lines.join("\n");
  } catch (err) {
    return `Counterfactual forecast failed: ${(err as Error).message}`;
  }
}
