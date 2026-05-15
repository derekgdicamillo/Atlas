import type { SupabaseClient } from "@supabase/supabase-js";

export const DGM_EXCLUDED_PATHS = [
  "atlas.spec",
  "data/atlas-ledger/",
  "data/atlas-ledger.key",
  "data/atlas-ledger.pub",
  "db/migrations/",
  "src/ledger.ts",
  "src/tool-gate.ts",
  "src/claude.ts",
  "src/haiku-client.ts",
  "package.json",
  "bun.lock",
  ".env",
  ".env.example",
] as const;

export type DgmTargetKind = "skill" | "role-prompt" | "behavioral-fix" | "heuristic" | "rule" | "system-prompt";

export interface MutationTarget {
  target_file: string;
  target_kind: DgmTargetKind;
  reason: string;
}

export interface VariantProposal {
  target_file: string;
  target_kind: DgmTargetKind;
  new_content: string;
  rationale: string;
}

export interface VariantScoreDeltas {
  aggregate: number;
  groundedness: number;
  tool: number;
  refusal: number;
}

export interface DgmVariantRow {
  id: string;
  target_file: string;
  target_kind: DgmTargetKind;
  variant_branch: string;
  diff_summary: string;
  opus_rationale: string;
  status: string;
  smoke_aggregate?: number;
  full_aggregate?: number;
  main_aggregate?: number;
  delta_aggregate?: number;
  delta_groundedness?: number;
  delta_tool?: number;
  delta_refusal?: number;
}

export function isPathExcluded(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  for (const p of DGM_EXCLUDED_PATHS) {
    if (p.endsWith("/")) {
      if (normalized.startsWith(p)) return true;
    } else if (normalized === p) {
      return true;
    }
  }
  return false;
}

export function qualifiesForMergeList(deltas: VariantScoreDeltas): boolean {
  if (deltas.aggregate < 0.02) return false;
  const axes = [deltas.groundedness, deltas.tool, deltas.refusal];
  if (axes.some((d) => d < -0.05)) return false;
  return true;
}

const PROPOSE_VARIANT_SYSTEM = `You propose ONE focused mutation to a target file in Atlas's source tree to improve performance on recent failures.

You receive:
- target_file: the path being mutated
- target_kind: skill | role-prompt | behavioral-fix | heuristic | rule | system-prompt
- current_content: the file's current text
- recent_failures: 0-30 short descriptions of recent failures involving this file

Output a strict JSON object:
{
  "new_content": "<the full proposed replacement content for the file>",
  "rationale": "<one paragraph: why this change, what failure it addresses, expected effect on replay axes>"
}

Rules:
- ONE focused change per variant. Do not rewrite the file from scratch unless the file is <500 chars.
- Preserve YAML / Markdown / TypeScript structure exactly.
- Do not introduce new imports, new exports, or new dependencies.
- The change must be defensible against replay-harness axes (groundedness, tool-correctness, refusal-calibration).
- Output ONLY the JSON object. No preamble, no markdown fences.`;

interface ProposeVariantDeps {
  currentContent: string;
  recentFailures: string[];
  callClaude: (prompt: string, opts?: { model?: string; isolated?: boolean; agentId?: string }) => Promise<string>;
}

export async function proposeVariant(target: MutationTarget, deps: ProposeVariantDeps): Promise<VariantProposal> {
  const userMessage = JSON.stringify({
    target_file: target.target_file,
    target_kind: target.target_kind,
    current_content: deps.currentContent,
    recent_failures: deps.recentFailures.slice(0, 30),
  });
  const prompt = `${PROPOSE_VARIANT_SYSTEM}\n\n---\n\n${userMessage}`;
  const raw = await deps.callClaude(prompt, { model: "opus", isolated: true, agentId: "dgm-fork" });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`dgm-fork: failed to parse variant proposal: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed.new_content !== "string" || typeof parsed.rationale !== "string") {
    throw new Error("dgm-fork: variant proposal missing new_content or rationale");
  }
  return {
    target_file: target.target_file,
    target_kind: target.target_kind,
    new_content: parsed.new_content,
    rationale: parsed.rationale,
  };
}

import { spawn } from "node:child_process";

export function buildMergeList(rows: DgmVariantRow[]): DgmVariantRow[] {
  const out: DgmVariantRow[] = [];
  for (const r of rows) {
    if (r.status !== "scored") continue;
    const deltas: VariantScoreDeltas = {
      aggregate: r.delta_aggregate ?? 0,
      groundedness: r.delta_groundedness ?? 0,
      tool: r.delta_tool ?? 0,
      refusal: r.delta_refusal ?? 0,
    };
    if (qualifiesForMergeList(deltas)) out.push(r);
  }
  out.sort((a, b) => (b.delta_aggregate ?? 0) - (a.delta_aggregate ?? 0));
  return out;
}

interface BuildAndTestResult {
  build_passed: boolean;
  tests_passed: boolean;
  stderr?: string;
}

export async function buildAndTest(worktreePath: string): Promise<BuildAndTestResult> {
  const runIn = (cmd: string, args: string[]) =>
    new Promise<{ code: number; stderr: string }>((resolve) => {
      const p = spawn(cmd, args, { cwd: worktreePath, shell: process.platform === "win32" });
      let stderr = "";
      p.stderr?.on("data", (d) => (stderr += d.toString()));
      p.on("close", (code) => resolve({ code: code ?? 1, stderr }));
      p.on("error", (err) => resolve({ code: 1, stderr: String(err) }));
    });
  const build = await runIn("bun", ["build", "src/relay.ts", "--target=bun", "--outfile", process.platform === "win32" ? "NUL" : "/dev/null"]);
  if (build.code !== 0) return { build_passed: false, tests_passed: false, stderr: build.stderr };
  const tests = await runIn("bun", ["test"]);
  return { build_passed: true, tests_passed: tests.code === 0, stderr: tests.stderr };
}

interface ScoreReplayDeps {
  loadDataset: (path: string) => Promise<any[]>;
  scoreEntry: (entry: any) => Promise<{ aggregate: number; groundedness: number; tool_correctness: number; refusal_calibration: number }>;
}

export async function scoreSmoke(datasetPath: string, deps: ScoreReplayDeps): Promise<{ aggregate: number; per_axis: VariantScoreDeltas }> {
  const all = await deps.loadDataset(datasetPath);
  const sample = all.slice(0, 10);
  return scoreOver(sample, deps);
}

export async function scoreFull(datasetPath: string, deps: ScoreReplayDeps): Promise<{ aggregate: number; per_axis: VariantScoreDeltas }> {
  const all = await deps.loadDataset(datasetPath);
  const sample = all.slice(0, 50);
  return scoreOver(sample, deps);
}

async function scoreOver(entries: any[], deps: ScoreReplayDeps): Promise<{ aggregate: number; per_axis: VariantScoreDeltas }> {
  if (!entries.length) return { aggregate: 0, per_axis: { aggregate: 0, groundedness: 0, tool: 0, refusal: 0 } };
  const scores = await Promise.all(entries.map((e) => deps.scoreEntry(e)));
  const mean = (key: "aggregate" | "groundedness" | "tool_correctness" | "refusal_calibration") =>
    scores.reduce((s, x) => s + x[key], 0) / scores.length;
  return {
    aggregate: mean("aggregate"),
    per_axis: {
      aggregate: mean("aggregate"),
      groundedness: mean("groundedness"),
      tool: mean("tool_correctness"),
      refusal: mean("refusal_calibration"),
    },
  };
}

export async function runNightly(
  supabase: SupabaseClient,
  opts: {
    pickN?: number;
    resolveTargetFile: (agent_id: string) => string;
    callClaude: (prompt: string, opts?: any) => Promise<string>;
    loadDataset: (path: string) => Promise<any[]>;
    scoreEntry: (entry: any) => Promise<any>;
    readFile: (path: string) => Promise<string>;
    fetchRecentFailures: (target_file: string) => Promise<string[]>;
    setupWorktree: (variantId: string, target_file: string, new_content: string) => Promise<string>;
  }
): Promise<{ proposed: number; queued: number; archived: number }> {
  const pickN = opts.pickN ?? 5;
  const targets = await pickTargets(supabase, pickN, { resolveTargetFile: opts.resolveTargetFile });
  let proposed = 0;
  let queued = 0;
  let archived = 0;
  for (const target of targets) {
    let proposal: VariantProposal;
    try {
      const currentContent = await opts.readFile(target.target_file);
      const recentFailures = await opts.fetchRecentFailures(target.target_file);
      proposal = await proposeVariant(target, { currentContent, recentFailures, callClaude: opts.callClaude });
    } catch (err) {
      console.error(`[dgm-fork] proposeVariant failed for ${target.target_file}:`, err);
      continue;
    }
    proposed++;
    const { data: ins } = await supabase
      .from("dgm_variants")
      .insert({
        target_file: target.target_file,
        target_kind: target.target_kind,
        variant_branch: `dgm/${target.target_file.replace(/[\/\\.]/g, "-")}-${Date.now()}`,
        diff_summary: proposal.rationale.split("\n")[0].slice(0, 200),
        opus_rationale: proposal.rationale,
        status: "proposed",
      })
      .select("id, variant_branch")
      .single();
    if (!ins) continue;
    const variantId = (ins as any).id as string;
    const worktreePath = await opts.setupWorktree(variantId, target.target_file, proposal.new_content);
    const bt = await buildAndTest(worktreePath);
    await supabase.from("dgm_variants").update({
      build_passed: bt.build_passed,
      tests_passed: bt.tests_passed,
      status: bt.tests_passed ? "tested" : "rejected",
      rejected_reason: bt.tests_passed ? null : (bt.build_passed ? "tests_failed" : "build_failed"),
    }).eq("id", variantId);
    if (!bt.tests_passed) { archived++; continue; }
    const smoke = await scoreSmoke("data/replay-dataset.jsonl", { loadDataset: opts.loadDataset, scoreEntry: opts.scoreEntry });
    await supabase.from("dgm_variants").update({
      smoke_aggregate: smoke.aggregate,
      status: "smoked",
    }).eq("id", variantId);
  }
  // Top-2 by smoke get full evaluation; baseline aggregate captured once.
  const { data: smoked } = await supabase
    .from("dgm_variants")
    .select("*")
    .eq("status", "smoked")
    .order("smoke_aggregate", { ascending: false })
    .limit(2);
  const baseline = await scoreFull("data/replay-dataset.jsonl", { loadDataset: opts.loadDataset, scoreEntry: opts.scoreEntry });
  for (const v of (smoked ?? []) as any[]) {
    const full = await scoreFull("data/replay-dataset.jsonl", { loadDataset: opts.loadDataset, scoreEntry: opts.scoreEntry });
    const delta_aggregate = full.aggregate - baseline.aggregate;
    const delta_groundedness = full.per_axis.groundedness - baseline.per_axis.groundedness;
    const delta_tool = full.per_axis.tool - baseline.per_axis.tool;
    const delta_refusal = full.per_axis.refusal - baseline.per_axis.refusal;
    const passes = qualifiesForMergeList({ aggregate: delta_aggregate, groundedness: delta_groundedness, tool: delta_tool, refusal: delta_refusal });
    await supabase.from("dgm_variants").update({
      full_aggregate: full.aggregate,
      main_aggregate: baseline.aggregate,
      delta_aggregate,
      delta_groundedness,
      delta_tool,
      delta_refusal,
      status: passes ? "queued" : "rejected",
      rejected_reason: passes ? null : "delta_below_threshold",
    }).eq("id", v.id);
    if (passes) queued++; else archived++;
  }
  return { proposed, queued, archived };
}

interface PickTargetsDeps {
  resolveTargetFile: (agent_id: string) => string;
}

export async function pickTargets(
  supabase: SupabaseClient,
  n: number,
  deps: PickTargetsDeps
): Promise<MutationTarget[]> {
  const { data, error } = await supabase
    .from("agent_reputation")
    .select("agent_kind, agent_id, domain, alpha, beta, use_count, updated_at")
    .gte("use_count", 3)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  const candidates: Array<{ row: any; lossRate: number }> = [];
  for (const row of data) {
    const a = Number(row.alpha ?? 1);
    const b = Number(row.beta ?? 1);
    const lossRate = b / Math.max(1, a + b);
    if (lossRate <= 0.6) continue;
    candidates.push({ row, lossRate });
  }
  candidates.sort((x, y) => y.lossRate - x.lossRate);
  const picked: MutationTarget[] = [];
  for (const { row, lossRate } of candidates) {
    if (picked.length >= n) break;
    const target_file = deps.resolveTargetFile(row.agent_id);
    if (!target_file || isPathExcluded(target_file)) continue;
    const target_kind: DgmTargetKind = row.agent_kind === "role" ? "role-prompt" : "skill";
    picked.push({
      target_file,
      target_kind,
      reason: `${row.agent_kind}=${row.agent_id} loss_rate=${lossRate.toFixed(2)} in ${row.domain}`,
    });
  }
  return picked;
}
