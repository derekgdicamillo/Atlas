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
