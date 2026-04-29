import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureNode } from "./causal-graph.ts";

export function computeDelta(pre: number[], post: number[]): number {
  if (!pre.length || !post.length) return 0;
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  return mean(post) - mean(pre);
}

export function permutationPValue(
  pre: number[],
  post: number[],
  iterations = 1000
): number {
  if (!pre.length || !post.length) return 1;
  const observed = Math.abs(computeDelta(pre, post));
  const all = [...pre, ...post];
  let extreme = 0;
  for (let i = 0; i < iterations; i++) {
    const shuffled = [...all].sort(() => Math.random() - 0.5);
    const shufPre = shuffled.slice(0, pre.length);
    const shufPost = shuffled.slice(pre.length);
    const delta = Math.abs(computeDelta(shufPre, shufPost));
    if (delta >= observed) extreme++;
  }
  return extreme / iterations;
}

export interface NaturalExperiment {
  action_name: string;
  action_at: string;
  metric_name: string;
  pre: number[];
  post: number[];
  delta: number;
  p_value: number;
  evidence_ref: string;
}

export interface InterventionEvent {
  action_name: string;
  occurred_at: string;
  source_ref: string;
}

export async function loadInterventions(opts?: { daysBack?: number }): Promise<InterventionEvent[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const daysBack = opts?.daysBack ?? 30;
  const cutoff = Date.now() - daysBack * 86_400_000;
  const dir = "data/atlas-ledger";
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"));
  const out: InterventionEvent[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = await readFile(`${dir}/${f}`, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n").filter(Boolean);
    for (const l of lines) {
      try {
        const entry = JSON.parse(l);
        const ts = entry.ts || entry.timestamp;
        if (!ts) continue;
        const t = new Date(ts).getTime();
        if (t < cutoff) continue;
        const action = mapTagToAction(entry);
        if (!action) continue;
        out.push({
          action_name: action,
          occurred_at: ts,
          source_ref: entry.entryHash || entry.id || f,
        });
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

function mapTagToAction(entry: any): string | null {
  const tag = String(entry.tag || entry.action || entry.tool || "");
  if (tag.startsWith("GHL_WORKFLOW") || tag.includes("workflow_enroll")) return "workflow_enroll";
  if (tag.startsWith("CAL_ADD")) return "calendar_add";
  if (tag.startsWith("WP_POST") || tag.includes("blog_publish")) return "blog_publish";
  if (tag.startsWith("PV_NEWSLETTER_PUSH") || tag.includes("newsletter_send")) return "newsletter_send";
  if (tag.startsWith("GHL_SOCIAL")) return "social_post";
  if (tag.includes("ad_pause") || tag.includes("AD_PAUSE")) return "ad_pause";
  if (tag.includes("ad_launch") || tag.includes("AD_LAUNCH")) return "ad_launch";
  return null;
}

export async function detectNaturalExperiments(
  supabase: SupabaseClient,
  opts?: { windowDays?: number; daysBack?: number; iterations?: number }
): Promise<{ inserted: number; experiments: NaturalExperiment[] }> {
  const windowDays = opts?.windowDays ?? 14;
  const iterations = opts?.iterations ?? 1000;

  const interventions = await loadInterventions({ daysBack: opts?.daysBack ?? 30 });
  if (!interventions.length) return { inserted: 0, experiments: [] };

  const { data: scorecard } = await supabase
    .from("business_scorecard")
    .select("*")
    .eq("period_type", "daily")
    .order("period_start", { ascending: true });
  if (!scorecard || !scorecard.length) return { inserted: 0, experiments: [] };

  const sample = scorecard[0] as any;
  const metricNames = Object.keys(sample).filter(
    (k) =>
      typeof sample[k] === "number" &&
      !["id", "period_type"].includes(k)
  );

  const out: NaturalExperiment[] = [];
  for (const intervention of interventions) {
    const tIv = new Date(intervention.occurred_at).getTime();
    for (const m of metricNames) {
      const pre: number[] = [];
      const post: number[] = [];
      for (const row of scorecard as any[]) {
        const ts = new Date(row.period_start).getTime();
        const v = row[m];
        if (typeof v !== "number") continue;
        if (ts >= tIv - windowDays * 86_400_000 && ts < tIv) pre.push(v);
        else if (ts >= tIv && ts <= tIv + windowDays * 86_400_000) post.push(v);
      }
      if (pre.length < 3 || post.length < 3) continue;
      const delta = computeDelta(pre, post);
      const p = permutationPValue(pre, post, iterations);
      if (p >= 0.05) continue;
      out.push({
        action_name: intervention.action_name,
        action_at: intervention.occurred_at,
        metric_name: m,
        pre, post, delta, p_value: p,
        evidence_ref: intervention.source_ref,
      });
    }
  }

  let inserted = 0;
  for (const ex of out) {
    const fromNode = await ensureNode(supabase, { kind: "action", name: ex.action_name });
    const toNode = await ensureNode(supabase, { kind: "metric", name: ex.metric_name });

    // Dedup via evidence containment
    const { data: existing } = await supabase
      .from("causal_edges")
      .select("id, evidence")
      .eq("from_node", fromNode.id)
      .eq("to_node", toNode.id)
      .eq("proposed_by", "natural-experiment");
    const dup = (existing ?? []).some((e: any) =>
      Array.isArray(e.evidence) &&
      e.evidence.some((ev: any) => ev?.ledger_entry_id === ex.evidence_ref)
    );
    if (dup) continue;

    await supabase.from("causal_edges").insert({
      from_node: fromNode.id,
      to_node: toNode.id,
      effect_size: ex.delta,
      effect_ci: null,
      evidence: [{
        kind: "natural-experiment",
        ledger_entry_id: ex.evidence_ref,
        action_at: ex.action_at,
        pre_n: ex.pre.length,
        post_n: ex.post.length,
        p_value: ex.p_value,
      }],
      status: "observed",
      proposed_by: "natural-experiment",
      approved: false,
    });
    inserted++;
  }

  return { inserted, experiments: out };
}
