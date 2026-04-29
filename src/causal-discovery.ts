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

import { spawn } from "node:child_process";
import { Anthropic } from "@anthropic-ai/sdk";

export interface PCEdgeCandidate {
  from: string;
  to: string;
  stability: number;
}

export async function runPCDiscovery(
  supabase: SupabaseClient,
  opts?: { stabilityThreshold?: number; nIter?: number; daysBack?: number }
): Promise<{ inserted: number; edges: PCEdgeCandidate[]; error?: string }> {
  const stabilityThreshold = opts?.stabilityThreshold ??
    Number(process.env.CAUSAL_PC_STABILITY_THRESHOLD ?? 0.7);
  const nIter = opts?.nIter ?? 100;
  const daysBack = opts?.daysBack ?? 90;

  const cutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString();
  const { data: obs } = await supabase
    .from("causal_observations")
    .select("node_id, observed_at, value")
    .gte("observed_at", cutoff);
  if (!obs || obs.length === 0) {
    return { inserted: 0, edges: [], error: "no observations" };
  }

  const { data: nodes } = await supabase.from("causal_nodes").select("id, name");
  const idToName = new Map((nodes ?? []).map((n: any) => [n.id, n.name]));
  const nameSet = new Set((nodes ?? []).map((n: any) => n.name));
  const varNames = Array.from(nameSet) as string[];

  const dayMap = new Map<string, Record<string, number>>();
  for (const o of obs as any[]) {
    const day = String(o.observed_at).slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, {});
    const name = idToName.get(o.node_id);
    if (!name) continue;
    dayMap.get(day)![name as string] = Number(o.value);
  }

  const matrix: number[][] = [];
  for (const day of Array.from(dayMap.keys()).sort()) {
    const row = varNames.map((n) => dayMap.get(day)![n] ?? 0);
    if (row.every((v) => Number.isFinite(v))) matrix.push(row);
  }
  if (matrix.length < 30) {
    return { inserted: 0, edges: [], error: `only ${matrix.length} complete observation days; need >= 30` };
  }

  const result = await new Promise<{ edges?: PCEdgeCandidate[]; error?: string }>((resolve) => {
    const py = spawn("python", ["scripts/causal_pc.py"]);
    let stdout = "";
    let stderr = "";
    py.stdout.on("data", (d) => (stdout += d.toString()));
    py.stderr.on("data", (d) => (stderr += d.toString()));
    py.on("close", () => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ error: stderr || "pc subprocess failed (non-JSON output)" });
      }
    });
    py.on("error", (err) => resolve({ error: String(err) }));
    py.stdin.write(JSON.stringify({
      observations: matrix,
      var_names: varNames,
      n_iter: nIter,
      stability_threshold: stabilityThreshold,
    }));
    py.stdin.end();
  });

  if (result.error) return { inserted: 0, edges: [], error: result.error };
  const edges = result.edges ?? [];
  if (!edges.length) return { inserted: 0, edges };

  const nameToId = new Map((nodes ?? []).map((n: any) => [n.name, n.id]));
  let inserted = 0;
  for (const e of edges) {
    const fromId = nameToId.get(e.from);
    const toId = nameToId.get(e.to);
    if (!fromId || !toId) continue;
    const { data: existing } = await supabase
      .from("causal_edges")
      .select("id")
      .eq("from_node", fromId)
      .eq("to_node", toId)
      .eq("proposed_by", "pc-algo")
      .maybeSingle();
    if (existing) continue;
    await supabase.from("causal_edges").insert({
      from_node: fromId,
      to_node: toId,
      effect_size: null,
      evidence: [{ kind: "pc-algo", stability: e.stability, n_observations: matrix.length }],
      status: "hypothesized",
      proposed_by: "pc-algo",
      approved: false,
    });
    inserted++;
  }
  return { inserted, edges };
}

export interface LLMEdgeProposal {
  from_node: string;
  to_node: string;
  hypothesized_effect_size?: number;
  direction: "positive" | "negative" | "unknown";
  confidence: number;
  evidence_pointers: string[];
  rationale: string;
}

export async function proposeLLMEdges(
  supabase: SupabaseClient,
  opts?: { weeksBack?: number; client?: Anthropic }
): Promise<{ inserted: number; proposals: LLMEdgeProposal[] }> {
  const client = opts?.client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const weeksBack = opts?.weeksBack ?? 1;

  const { readdir, readFile } = await import("node:fs/promises");
  const journals: string[] = [];
  try {
    const files = (await readdir("memory")).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    const recent = files.sort().slice(-7 * weeksBack);
    for (const f of recent) {
      const text = await readFile(`memory/${f}`, "utf8");
      journals.push(`=== ${f} ===\n${text.slice(0, 4000)}`);
    }
  } catch {
    /* no journals */
  }

  const { data: scorecard } = await supabase
    .from("business_scorecard")
    .select("*")
    .eq("period_type", "daily")
    .order("period_start", { ascending: false })
    .limit(7 * weeksBack);
  const scorecardSummary = JSON.stringify(scorecard ?? [], null, 2).slice(0, 6000);

  const { data: nodes } = await supabase.from("causal_nodes").select("name, kind");
  const knownNodeNames = (nodes ?? []).map((n: any) => `${n.kind}:${n.name}`).join(", ");

  const { data: approved } = await supabase
    .from("causal_edges")
    .select("from_node, to_node, effect_size, proposed_by")
    .eq("approved", true)
    .eq("status", "observed")
    .limit(50);
  const approvedSummary = JSON.stringify(approved ?? []).slice(0, 4000);

  const SYSTEM = `You propose causal edges for a personal AI's causal graph based on journals, business scorecard, and known nodes.

Output a strict JSON array of edge proposals. Each edge:
{
  "from_node": "<existing node name OR descriptive new node name>",
  "to_node":   "<existing node name OR descriptive new node name>",
  "hypothesized_effect_size": <number, in to_node's natural unit, optional>,
  "direction": "positive" | "negative" | "unknown",
  "confidence": <0..1>,
  "evidence_pointers": ["<journal line, scorecard date, ledger event ID, etc.>", ...],
  "rationale": "<one sentence>"
}

Rules:
- Do NOT propose edges already in the approved list.
- Prefer using existing node names when they fit; only invent new node names when truly novel.
- evidence_pointers must reference real artifacts in the provided context. Empty pointers = auto-reject.
- Return at most 5 proposals per call.
- Output only the JSON array. No preamble.`;

  const userMessage = [
    `KNOWN NODES: ${knownNodeNames}`,
    ``,
    `APPROVED EDGES (do not duplicate):`,
    approvedSummary,
    ``,
    `JOURNAL ENTRIES (last ${weeksBack} weeks):`,
    journals.join("\n\n").slice(0, 12000),
    ``,
    `SCORECARD (last ${7 * weeksBack} days):`,
    scorecardSummary,
  ].join("\n");

  const resp = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 2000,
    system: SYSTEM,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = (resp.content[0] as any)?.text ?? "";
  let proposals: LLMEdgeProposal[];
  try {
    const jsonStart = text.indexOf("[");
    const jsonEnd = text.lastIndexOf("]");
    proposals = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    return { inserted: 0, proposals: [] };
  }

  let inserted = 0;
  for (const p of proposals) {
    if (!p.evidence_pointers?.length) continue;

    const fromKind: "metric" | "action" | "event" =
      /pause|launch|cut|change|enroll|publish|post|send/i.test(p.from_node) ? "action" : "metric";
    const fromNode = await ensureNode(supabase, { kind: fromKind, name: p.from_node });
    const toNode = await ensureNode(supabase, { kind: "metric", name: p.to_node });

    const { data: existing } = await supabase
      .from("causal_edges")
      .select("id")
      .eq("from_node", fromNode.id)
      .eq("to_node", toNode.id)
      .eq("proposed_by", "llm")
      .maybeSingle();
    if (existing) continue;

    const effectSize =
      typeof p.hypothesized_effect_size === "number"
        ? p.direction === "negative"
          ? -Math.abs(p.hypothesized_effect_size)
          : Math.abs(p.hypothesized_effect_size)
        : null;
    await supabase.from("causal_edges").insert({
      from_node: fromNode.id,
      to_node: toNode.id,
      effect_size: effectSize,
      evidence: [{
        kind: "llm",
        confidence: p.confidence,
        evidence_pointers: p.evidence_pointers,
        rationale: p.rationale,
        direction: p.direction,
      }],
      status: "hypothesized",
      proposed_by: "llm",
      approved: false,
    });
    inserted++;
  }

  return { inserted, proposals };
}
