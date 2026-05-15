import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Atlas Prime Sprint 7: sign a memory row pre-insert.
 * Lenient by default — if no session key is initialized (e.g., tests, scripts),
 * log a warning and proceed with an unsigned (legacy) row. Set
 * MEMORY_SIGNING_STRICT=true to make the throw propagate.
 */
async function maybeSignRow(row: Record<string, unknown>): Promise<void> {
  if (!row.id) {
    // Some inserts let Postgres assign id via default. We can still sign the
    // server-assigned id after insert in a future iteration; for now, skip
    // signing rows without a pre-assigned id when not strict.
    if (process.env.MEMORY_SIGNING_STRICT === "true") {
      throw new Error("memory-signing strict mode: row has no id");
    }
    return;
  }
  try {
    const { signMemoryRow } = await import("./memory-signing.ts");
    const sig = await signMemoryRow({
      id: String(row.id),
      content: String(row.content ?? ""),
      embedding: (row.embedding as number[] | null | undefined) ?? null,
      created_at: String(row.created_at ?? new Date().toISOString()),
      agent: String(row.agent ?? "atlas"),
      user_id: String(row.user_id ?? ""),
      class: String(row.class ?? "episodic"),
    });
    row.signature = sig.signature;
    row.sig_payload_hash = sig.sig_payload_hash;
    row.session_id = sig.session_id;
  } catch (err) {
    if (process.env.MEMORY_SIGNING_STRICT === "true") throw err;
    console.warn(`[cortex] memory signing skipped (lenient mode): ${err}`);
  }
}

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

export interface MemoryRow {
  id: string;
  content: string;
  summary: string;
  original_content: string;
  class: string;
  demotion_pressure: number;
  demotion_events: FailureEvent[];
  inverted_from: string | null;
  inversion_depth: number;
  tags: string[];
  created_at: string;
}

export interface InversionDraft {
  content: string;
  summary: string;
  original_content: string;
  class: "episodic";
  inverted_from: string;
  inversion_depth: number;
  tags: string[];
}

export function composeInversion(row: MemoryRow, today: string): InversionDraft {
  const reasons = row.demotion_events
    .map((e) => e.reason)
    .filter((r): r is string => Boolean(r))
    .slice(0, 5);
  const reasonsBlock = reasons.length
    ? "Failed because: " + reasons.join("; ") + "."
    : "";
  const content = [
    `AS OF ${today}, original belief: "${row.summary}".`,
    `Failed ${row.demotion_events.length} times.`,
    reasonsBlock,
    `Open question: is the inverse true?`,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    content,
    summary: content,
    original_content: content,
    class: "episodic",
    inverted_from: row.id,
    inversion_depth: row.inversion_depth + 1,
    tags: [...row.tags, "inversion"],
  };
}

export interface DemotionResult {
  demoted: boolean;
  inverted: boolean;
  alertReason?: string;
  inversionDraft?: InversionDraft;
}

export async function executeDemotion(
  supabase: SupabaseClient,
  row: MemoryRow,
  todayIso?: string
): Promise<DemotionResult> {
  if (row.demotion_pressure < DEMOTION_THRESHOLD) {
    return { demoted: false, inverted: false };
  }

  const today = (todayIso ?? new Date().toISOString()).slice(0, 10);

  const { error: updErr } = await supabase
    .from("memory")
    .update({ class: "demoted" })
    .eq("id", row.id);
  if (updErr) {
    return { demoted: false, inverted: false, alertReason: `update failed: ${updErr.message}` };
  }

  if (row.inversion_depth >= MAX_INVERSION_DEPTH) {
    return {
      demoted: true,
      inverted: false,
      alertReason: `max inversion depth (${MAX_INVERSION_DEPTH}) reached for ${row.id} — manual review required`,
    };
  }

  const draft = composeInversion(row, today);
  await maybeSignRow(draft as unknown as Record<string, unknown>);
  const { error: insErr } = await supabase.from("memory").insert([draft]);
  if (insErr) {
    return { demoted: true, inverted: false, alertReason: `insert failed: ${insErr.message}` };
  }
  return { demoted: true, inverted: true, inversionDraft: draft };
}

/**
 * Scan memory rows whose pressure crossed threshold but aren't already demoted.
 * Returns count demoted. Designed for nightly cron.
 */
export async function processDemotions(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from("memory")
    .select("*")
    .gte("demotion_pressure", DEMOTION_THRESHOLD)
    .neq("class", "demoted")
    .limit(50);
  if (error) {
    console.error("[cortex] processDemotions query failed:", error);
    return 0;
  }
  if (!data?.length) return 0;
  // Atlas Prime Sprint 7: verify signatures on loaded rows; skip + log failures.
  const { verifyMemoryRow, logMemoryVerificationFailure } = await import("./memory-signing.ts");
  const verified: typeof data = [];
  for (const r of data) {
    const v = await verifyMemoryRow(supabase, r as any);
    if (!v.valid) {
      await logMemoryVerificationFailure(supabase, r as any, v.reason ?? "unknown");
      console.warn(`[cortex] memory verify fail for ${(r as any).id}: ${v.reason}`);
      continue;
    }
    verified.push(r);
  }
  let count = 0;
  for (const row of verified as MemoryRow[]) {
    const result = await executeDemotion(supabase, row);
    if (result.demoted) count++;
    if (result.alertReason) console.warn("[cortex] demotion alert:", result.alertReason);
  }
  return count;
}

export async function processEpisodicClustering(supabase: SupabaseClient): Promise<number> {
  const { callHaiku } = await import("./haiku-client.ts");
  const { data: clusters, error } = await supabase.rpc("episodic_clusters_for_promotion");
  if (error) {
    console.error("[cortex] cluster query failed:", error);
    return 0;
  }
  if (!clusters?.length) return 0;
  let promoted = 0;
  for (const c of clusters as Array<{ tag: string; member_ids: string[]; member_summaries: string[] }>) {
    if (c.member_ids.length < 3) continue;
    let rule = "";
    try {
      const r = await callHaiku({
        system: `You read a cluster of episodic memories sharing tag "${c.tag}" and write ONE generalized rule (≤80 words) capturing the pattern. Output the rule, no preamble.`,
        userMessage: c.member_summaries.map((s, i) => `${i + 1}. ${s}`).join("\n"),
        maxTokens: 200,
      });
      rule = r.text.trim();
    } catch (err) {
      console.error("[cortex] cluster Haiku failed:", err);
      continue;
    }
    const newRow: Record<string, unknown> = {
      content: rule,
      original_content: rule,
      summary: rule,
      class: "semantic",
      tags: [c.tag, "episodic-promoted"],
    };
    await maybeSignRow(newRow);
    const { error: insErr } = await supabase.from("memory").insert([newRow]);
    if (insErr) {
      console.error("[cortex] cluster insert failed:", insErr);
      continue;
    }
    await supabase
      .from("memory")
      .update({ class: "archived-source" })
      .in("id", c.member_ids);
    promoted++;
  }
  return promoted;
}
