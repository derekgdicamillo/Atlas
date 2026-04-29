import type { SupabaseClient } from "@supabase/supabase-js";

export const TIERS = [
  "sensory",
  "working",
  "session",
  "episodic",
  "semantic",
  "procedural",
  "identity",
] as const;
export type Tier = (typeof TIERS)[number];

export type FailureSource = "replay-judge" | "derek-correction" | "trust-event";

export const FAILURE_WEIGHTS: Record<FailureSource, number> = {
  "replay-judge": 0.5,
  "derek-correction": 1.0,
  "trust-event": 0.7,
};

export const DEMOTION_THRESHOLD = 3.0;
export const MAX_INVERSION_DEPTH = 2;

export interface FailureEvent {
  source: FailureSource;
  ts: string;
  reason?: string;
}

export function computePressure(events: FailureEvent[]): number {
  return events.reduce((acc, e) => acc + (FAILURE_WEIGHTS[e.source] ?? 0), 0);
}

export interface AttributionInput {
  turn_id: string;
  user_id: string;
  agent: "atlas" | "ishtar";
  memories: Array<{ id: string; rank: number; rerank_score?: number | null }>;
}

export async function recordAttribution(
  supabase: SupabaseClient,
  input: AttributionInput
): Promise<void> {
  if (!input.memories.length) return;
  const rows = input.memories.map((m) => ({
    turn_id: input.turn_id,
    user_id: input.user_id,
    agent: input.agent,
    memory_id: m.id,
    rank: m.rank,
    rerank_score: m.rerank_score ?? null,
  }));
  const { error } = await supabase.from("attribution_log").insert(rows);
  if (error) {
    console.error("[cortex] recordAttribution failed:", error);
  }
}

export interface FailureInput {
  turn_id: string;
  source: FailureSource;
  reason?: string;
}

export async function recordFailure(
  supabase: SupabaseClient,
  input: FailureInput
): Promise<void> {
  const { data: contributors, error: lookupErr } = await supabase
    .from("attribution_log")
    .select("memory_id")
    .eq("turn_id", input.turn_id);
  if (lookupErr) {
    console.error("[cortex] recordFailure lookup failed:", lookupErr);
    return;
  }
  if (!contributors?.length) return;

  const weight = FAILURE_WEIGHTS[input.source];
  const event: FailureEvent = {
    source: input.source,
    ts: new Date().toISOString(),
    reason: input.reason,
  };

  for (const row of contributors) {
    const { error } = await supabase.rpc("memory_record_failure", {
      p_memory_id: row.memory_id,
      p_weight: weight,
      p_event: event,
    });
    if (error) {
      console.error(`[cortex] recordFailure update failed for ${row.memory_id}:`, error);
    }
  }
}
