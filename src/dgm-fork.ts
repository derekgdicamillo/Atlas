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
