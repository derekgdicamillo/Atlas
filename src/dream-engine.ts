import type { SupabaseClient } from "@supabase/supabase-js";

export interface SalienceWeights {
  access: number;
  trust: number;
  incident: number;
  demotion: number;
}

export const DEFAULT_SALIENCE_WEIGHTS: SalienceWeights = {
  access: 0.3,
  trust: 0.3,
  incident: 0.2,
  demotion: 0.2,
};

export interface SalienceResult {
  memoryId: string;
  score: number;
  components: { access: number; trust: number; incident: number; demotion: number };
}

const INCIDENT_TAGS = new Set(["decision", "incident", "regret", "surprise", "correction"]);

export async function computeSalience(
  supabase: SupabaseClient,
  memoryId: string,
  weights: SalienceWeights = DEFAULT_SALIENCE_WEIGHTS
): Promise<SalienceResult> {
  const { data: row } = await supabase
    .from("memory")
    .select("id, access_count_since_rewrite, demotion_pressure, tags")
    .eq("id", memoryId)
    .single();

  if (!row) {
    return {
      memoryId,
      score: 0,
      components: { access: 0, trust: 0, incident: 0, demotion: 0 },
    };
  }

  const r = row as any;

  // Access component: capped at 1 (saturates at 10 accesses)
  const accessRaw = Number(r.access_count_since_rewrite ?? 0);
  const access = Math.min(accessRaw / 10, 1);

  // Incident component: 1 if any incident-class tag is present
  const tags: string[] = Array.isArray(r.tags) ? r.tags : [];
  const incident = tags.some((t) => INCIDENT_TAGS.has(t)) ? 1 : 0;

  // Demotion component: scales linearly 0-1 over pressure range [0, 3]
  const demotionPressure = Number(r.demotion_pressure ?? 0);
  const demotion = Math.min(demotionPressure, 3) / 3;

  // Trust component: 1.0 if any trust-negative event in last 7d shares a turn_id
  // with this memory via attribution_log
  let trust = 0;
  try {
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: attrTurns } = await supabase
      .from("attribution_log")
      .select("turn_id")
      .eq("memory_id", memoryId)
      .gte("created_at", cutoff);

    const turnIds = new Set((attrTurns ?? []).map((a: any) => a.turn_id));
    if (turnIds.size > 0) {
      const { readFile } = await import("node:fs/promises");
      try {
        const raw = await readFile("data/trust-snapshots.jsonl", "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.delta === -1 && ev.turn_id && turnIds.has(ev.turn_id)) {
              trust = 1;
              break;
            }
          } catch {
            // skip malformed lines
          }
        }
      } catch {
        // file may not exist yet
      }
    }
  } catch (err) {
    console.error("[dream-engine] trust component lookup failed:", err);
  }

  const score =
    weights.access * access +
    weights.trust * trust +
    weights.incident * incident +
    weights.demotion * demotion;

  return { memoryId, score, components: { access, trust, incident, demotion } };
}

/**
 * Return the top-k most salient memories updated within the last `hoursBack` hours.
 * Excludes demoted memories. Used by SWS + REM consolidation stages.
 */
export async function topSalient(
  supabase: SupabaseClient,
  hoursBack = 24,
  k = 10,
  weights: SalienceWeights = DEFAULT_SALIENCE_WEIGHTS
): Promise<SalienceResult[]> {
  const cutoff = new Date(Date.now() - hoursBack * 3_600_000).toISOString();
  const { data: rows } = await supabase
    .from("memory")
    .select("id")
    .gte("updated_at", cutoff)
    .neq("class", "demoted")
    .limit(200);

  const ids = (rows ?? []).map((r: any) => r.id);
  const out: SalienceResult[] = [];
  for (const id of ids) {
    out.push(await computeSalience(supabase, id, weights));
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

import { callHaiku } from "./haiku-client.ts";
import { mkdir, writeFile } from "node:fs/promises";

const SWS_VARIANT_SYSTEM = `You read a past episode and generate 3-5 counterfactual variants.

Each variant explores 'what if [different decision]?', 'what if [different timing]?', or 'what if [different actor]?'

Output a JSON array: [{"variant": "...", "probable_outcome": "...", "key_uncertainty": "..."}, ...]

Rules:
- 3 to 5 variants
- No invented facts beyond what the memory implies
- Output only the JSON array. No preamble.`;

const SWS_RULE_SYSTEM = `You read a set of counterfactual variants of a past episode and write ONE generalized rule (≤80 words) that captures any pattern across them.

If no clear pattern, output the literal string "NO_RULE" (without quotes).

Output the rule text only. No preamble.`;

const SWS_DOUBT_SYSTEM = `You read a set of counterfactual variants. Output a JSON array of DOUBT topics — short noun phrases for any cases where two variants' probable_outcomes contradict each other.

If no contradictions, output [].

Output only the JSON array.`;

export async function runSWS(supabase: SupabaseClient): Promise<{
  dreamId: string | null;
  rulesEmitted: number;
  doubts: string[];
}> {
  const top = await topSalient(supabase, 24, 10);
  if (!top.length) return { dreamId: null, rulesEmitted: 0, doubts: [] };

  const allVariants: Record<string, any[]> = {};
  const allRules: string[] = [];
  const allDoubts: string[] = [];

  for (const s of top) {
    const { data: row } = await supabase
      .from("memory")
      .select("id, summary, tags, created_at")
      .eq("id", s.memoryId)
      .single();
    if (!row) continue;

    let variants: any[] = [];
    try {
      const r = await callHaiku({
        system: SWS_VARIANT_SYSTEM,
        userMessage: `Episode (created ${(row as any).created_at}, tags: ${(row as any).tags?.join(", ") ?? ""}):\n\n${(row as any).summary}`,
        maxTokens: 800,
        cacheSystem: true,
      });
      const text = r.text;
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      variants = JSON.parse(text.slice(start, end + 1));
    } catch (err) {
      console.error(`[dream-sws] variants failed for ${s.memoryId}:`, err);
      continue;
    }
    if (!variants.length) continue;
    allVariants[s.memoryId] = variants;

    try {
      const r = await callHaiku({
        system: SWS_RULE_SYSTEM,
        userMessage: variants
          .map((v, i) => `${i + 1}. ${v.variant} → ${v.probable_outcome}`)
          .join("\n"),
        maxTokens: 200,
        cacheSystem: true,
      });
      const rule = r.text.trim();
      if (rule && rule !== "NO_RULE") {
        allRules.push(rule);
      }
    } catch { /* skip rule */ }

    try {
      const r = await callHaiku({
        system: SWS_DOUBT_SYSTEM,
        userMessage: variants
          .map((v, i) => `${i + 1}. ${v.variant} → ${v.probable_outcome}`)
          .join("\n"),
        maxTokens: 200,
        cacheSystem: true,
      });
      const text = r.text;
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      const arr = JSON.parse(text.slice(start, end + 1)) as string[];
      for (const d of arr) {
        if (d && !allDoubts.includes(d)) allDoubts.push(d);
      }
    } catch { /* skip doubts */ }
  }

  // Insert each rule as a memory row (semantic, from-dream)
  const ruleIds: string[] = [];
  for (const rule of allRules) {
    const { data: ins } = await supabase
      .from("memory")
      .insert({
        content: rule,
        original_content: rule,
        summary: rule,
        class: "semantic",
        tags: ["from-dream", "sws"],
      })
      .select("id")
      .single();
    if (ins) ruleIds.push((ins as any).id);
  }

  const today = new Date().toISOString().slice(0, 10);
  const variantSection = Object.entries(allVariants)
    .flatMap(([id, vs]) => [
      `### ${id}`,
      ...vs.map(
        (v: any, i: number) =>
          `${i + 1}. **${v.variant}** → ${v.probable_outcome} (uncertainty: ${v.key_uncertainty})`
      ),
      ``,
    ]);
  const narrative = [
    `# Atlas SWS Dream — ${today}`,
    ``,
    `## Top-salient memories`,
    ...top.map((s, i) => `${i + 1}. ${s.memoryId} — score ${s.score.toFixed(2)}`),
    ``,
    `## Counterfactual variants`,
    ...variantSection,
    ``,
    `## Generalized rules`,
    ...allRules.map((r, i) => `${i + 1}. ${r}`),
    ``,
    `## DOUBTs raised`,
    ...allDoubts.map((d) => `- [DOUBT: ${d}]`),
  ].join("\n");

  await mkdir("memory/dreams", { recursive: true });
  await writeFile(`memory/dreams/${today}-sws.md`, narrative, "utf8");

  const { data: dreamRow } = await supabase
    .from("dreams")
    .insert({
      phase: "SWS",
      trigger: "nightly-sws-cron",
      source_refs: top.map((s) => ({ kind: "memory", id: s.memoryId, score: s.score })),
      content: narrative.slice(0, 30000),
      rules_emitted: ruleIds,
      doubts: allDoubts,
    })
    .select("id")
    .single();

  return {
    dreamId: dreamRow ? (dreamRow as any).id : null,
    rulesEmitted: ruleIds.length,
    doubts: allDoubts,
  };
}

import { Anthropic } from "@anthropic-ai/sdk";

interface UncertaintyItem {
  kind: "doubt" | "hypothesized-edge" | "failing-procedure" | "low-trust-domain";
  ref_id: string;
  description: string;
  recency_days: number;
  magnitude: number;
}

const REM_SYSTEM = `You are dreaming a tomorrow scenario. Compose ONE plausible scenario in which a given uncertainty becomes consequential.

Output a strict JSON object:
{
  "scenario":           "<200-400 word narrative>",
  "validated_claims":   ["<claim>: <forecast result>", ...],
  "unprep_score":       0..1,
  "preparation_notes":  "<one paragraph on what Atlas would need to handle this>"
}

unprep_score: how unprepared Atlas would feel if this happened tomorrow.

Output only the JSON object. No preamble.`;

async function buildUncertaintyPool(supabase: SupabaseClient): Promise<UncertaintyItem[]> {
  const out: UncertaintyItem[] = [];

  // 1. Open DOUBTs from last 7 days
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: dreamDoubts } = await supabase
    .from("dreams")
    .select("id, doubts, occurred_at")
    .gte("occurred_at", cutoff);
  for (const d of (dreamDoubts ?? []) as any[]) {
    const recency = Math.max(1, (Date.now() - new Date(d.occurred_at).getTime()) / 86_400_000);
    for (const topic of d.doubts ?? []) {
      out.push({
        kind: "doubt",
        ref_id: d.id,
        description: topic,
        recency_days: recency,
        magnitude: 0.7,
      });
    }
  }

  // 2. Hypothesized edges with approved=false
  const { data: hypEdges } = await supabase
    .from("causal_edges")
    .select("id, from_node, to_node, evidence")
    .eq("approved", false)
    .eq("status", "hypothesized")
    .limit(20);
  for (const e of (hypEdges ?? []) as any[]) {
    const conf = e.evidence?.[0]?.confidence ?? e.evidence?.[0]?.stability ?? 0.5;
    out.push({
      kind: "hypothesized-edge",
      ref_id: e.id,
      description: `untested edge ${e.from_node.slice(0, 8)}→${e.to_node.slice(0, 8)}`,
      recency_days: 1,
      magnitude: Number(conf) || 0.5,
    });
  }

  // 3. Failing procedures
  const { data: procs } = await supabase
    .from("procedures")
    .select("id, goal, alpha, beta, use_count")
    .gte("use_count", 3);
  for (const p of (procs ?? []) as any[]) {
    const failureRate = p.beta / (p.alpha + p.beta);
    if (failureRate > 0.5) {
      out.push({
        kind: "failing-procedure",
        ref_id: p.id,
        description: p.goal,
        recency_days: 1,
        magnitude: failureRate,
      });
    }
  }

  // 4. Low-trust domains: read data/trust-snapshots.jsonl
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile("data/trust-snapshots.jsonl", "utf8");
    const recentDomains = new Map<string, { score: number; ts: string }>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.kind === "daily-snapshot" && ev.byDomain) {
          for (const [domain, score] of Object.entries(ev.byDomain)) {
            recentDomains.set(domain, { score: Number(score), ts: ev.ts });
          }
        }
      } catch { /* skip */ }
    }
    for (const [domain, { score }] of recentDomains.entries()) {
      if (score < 0.55) {
        out.push({
          kind: "low-trust-domain",
          ref_id: domain,
          description: `low trust in ${domain}`,
          recency_days: 1,
          magnitude: 1 - score,
        });
      }
    }
  } catch { /* file may not exist */ }

  return out;
}

function sampleWeighted<T extends { recency_days: number; magnitude: number }>(items: T[], k: number): T[] {
  const out: T[] = [];
  const pool = [...items];
  const w = items.map((i) => i.magnitude / Math.max(1, i.recency_days));
  for (let n = 0; n < k && pool.length; n++) {
    const total = w.reduce((s, x) => s + x, 0);
    if (total <= 0) break;
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < w.length; idx++) {
      r -= w[idx];
      if (r <= 0) break;
    }
    if (idx >= pool.length) idx = pool.length - 1;
    out.push(pool[idx]);
    pool.splice(idx, 1);
    w.splice(idx, 1);
  }
  return out;
}

export async function runREM(
  supabase: SupabaseClient,
  opts: { client?: Anthropic } = {}
): Promise<{ dreamIds: string[]; topUnprep: number }> {
  const client = opts.client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const pool = await buildUncertaintyPool(supabase);
  if (!pool.length) return { dreamIds: [], topUnprep: 0 };

  const sampled = sampleWeighted(pool, 5);
  const scenarios: Array<{
    scenario: string;
    validated_claims: string[];
    unprep_score: number;
    preparation_notes: string;
    source: UncertaintyItem;
  }> = [];

  for (const u of sampled) {
    try {
      const userMessage = JSON.stringify({
        uncertainty_kind: u.kind,
        uncertainty_description: u.description,
        instructions: "Compose a tomorrow scenario in which this uncertainty becomes consequential.",
      });
      const resp = await client.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 1500,
        system: REM_SYSTEM,
        messages: [{ role: "user", content: userMessage }],
      });
      const text = (resp.content[0] as any)?.text ?? "{}";
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      const obj = JSON.parse(text.slice(start, end + 1));
      scenarios.push({
        scenario: String(obj.scenario ?? "").slice(0, 4000),
        validated_claims: Array.isArray(obj.validated_claims) ? obj.validated_claims : [],
        unprep_score: Math.max(0, Math.min(1, Number(obj.unprep_score ?? 0))),
        preparation_notes: String(obj.preparation_notes ?? ""),
        source: u,
      });
    } catch (err) {
      console.error(`[dream-rem] scenario generation failed for ${u.ref_id}:`, err);
    }
  }

  scenarios.sort((a, b) => b.unprep_score - a.unprep_score);
  const top3 = scenarios.slice(0, 3);

  const today = new Date().toISOString().slice(0, 10);
  const narrative = [
    `# Atlas REM Dream — ${today}`,
    ``,
    `## Top-3 tomorrow scenarios (ranked by unprep_score)`,
    ``,
    ...top3.flatMap((s, i) => [
      `### ${i + 1}. unprep_score=${s.unprep_score.toFixed(2)} (source: ${s.source.kind})`,
      ``,
      s.scenario,
      ``,
      `**Validated claims:** ${s.validated_claims.join("; ") || "none"}`,
      ``,
      `**Preparation notes:** ${s.preparation_notes}`,
      ``,
    ]),
  ].join("\n");

  await mkdir("memory/dreams", { recursive: true });
  await writeFile(`memory/dreams/${today}-rem.md`, narrative, "utf8");

  const dreamIds: string[] = [];
  for (const s of top3) {
    const { data } = await supabase
      .from("dreams")
      .insert({
        phase: "REM",
        trigger: `uncertainty:${s.source.kind}`,
        source_refs: [{ kind: s.source.kind, ref_id: s.source.ref_id }],
        content: s.scenario,
        rules_emitted: [],
        doubts: [],
        unprep_score: s.unprep_score,
        metadata: {
          validated_claims: s.validated_claims,
          preparation_notes: s.preparation_notes,
        },
      })
      .select("id")
      .single();
    if (data) dreamIds.push((data as any).id);
  }

  return {
    dreamIds,
    topUnprep: top3[0]?.unprep_score ?? 0,
  };
}
