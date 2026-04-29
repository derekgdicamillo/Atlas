import type { SupabaseClient } from "@supabase/supabase-js";

export type Step =
  | { kind: "tag"; tag: string }
  | { kind: "wait"; for: string }
  | { kind: "say"; template: string }
  | { kind: "branch"; if: string; then: Step[]; else?: Step[] };

export interface Procedure {
  id: string;
  external_id?: string;
  goal: string;
  goal_embedding?: number[];
  preconditions: string[];
  action_sequence: Step[];
  postconditions: string[];
  alpha: number;
  beta: number;
  use_count: number;
  last_used_at?: string;
  tags: string[];
  source: string;
}

export interface RankedProcedure extends Procedure {
  thompson_score: number;
  cosine_similarity?: number;
}

/**
 * Sample one value from Beta(α, β) using ratio-of-gammas.
 * Numerically stable for α, β >= 1; we enforce that on input.
 */
export function thompsonSample(alpha: number, beta: number): number {
  const a = Math.max(1, alpha);
  const b = Math.max(1, beta);
  const xa = sampleGamma(a);
  const xb = sampleGamma(b);
  return xa / (xa + xb);
}

// Marsaglia + Tsang gamma sampler for shape >= 1
function sampleGamma(shape: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do {
      const u1 = Math.random();
      const u2 = Math.random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); // Box-Muller
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function rankByThompson(procedures: Procedure[]): RankedProcedure[] {
  return procedures
    .map((p) => ({ ...p, thompson_score: thompsonSample(p.alpha, p.beta) }))
    .sort((a, b) => b.thompson_score - a.thompson_score);
}

export function fillSlots(steps: Step[], values: Record<string, string>): string[] {
  const render = (template: string): string =>
    template.replace(/\{(\w+)\}/g, (full, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? values[name] : full
    );
  const out: string[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case "tag":
        out.push(render(step.tag));
        break;
      case "say":
        out.push(render(step.template));
        break;
      case "wait":
        // narrative-only; no rendered output
        break;
      case "branch":
        // condition resolution is upstream; not rendered here
        break;
    }
  }
  return out;
}

interface FindOpts {
  k?: number;
  supabase: SupabaseClient;
  embedQuery: (text: string) => Promise<number[]>;
}

export async function findProcedure(
  goal: string,
  opts: FindOpts
): Promise<RankedProcedure[]> {
  const k = opts.k ?? 3;
  const embedding = await opts.embedQuery(goal);
  const { data, error } = await opts.supabase.rpc("procedures_match", {
    p_query_embedding: embedding,
    p_match_count: 20,
  });
  if (error) {
    console.error("[procedures] match query failed:", error);
    return [];
  }
  if (!data?.length) return [];
  const ranked = rankByThompson(data as Procedure[]);
  return ranked.slice(0, k);
}

export async function recordOutcome(
  supabase: SupabaseClient,
  procedureId: string,
  success: boolean,
  ledgerEntryId?: string
): Promise<void> {
  await supabase.rpc("procedure_record_outcome", {
    p_procedure_id: procedureId,
    p_success: success,
  });
  await supabase.from("procedure_outcomes").insert([
    {
      procedure_id: procedureId,
      success,
      ledger_entry_id: ledgerEntryId ?? null,
    },
  ]);
}
