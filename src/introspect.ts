/**
 * Atlas Prime Sprint 6 — /why Introspection Module
 *
 * Answers "why did I say this, and would I say it again?" for any past turn.
 * Pulls contributing memories (via attribution_log), approved DAG edges at the
 * time vs. since, and Shadow Council review records, then asks Opus to reason
 * over the delta. Results are cached in introspect_cache for 30 days.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntrospectionResult {
  turn_id: string;
  message_ts: string;
  time_then: string;
  time_now: string;
  delta_reasoning: string;
  cited: {
    memory_ids: string[];
    ledger_shas: string[];
    dag_edges: string[];
    council_review_ids: string[];
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TTL_DAYS = Number(process.env.INTROSPECT_TTL_DAYS ?? 30);

const INTROSPECT_SYSTEM = `You answer two questions about a past Atlas message:
1. Why did Atlas say this given what it knew then?
2. Given what Atlas knows today, would it say it again?

Output a structured response with exactly three sections:

## At the time, Atlas knew:
- (bullet list of memories, edges, scorecard values, etc. that contributed)

## Today, Atlas knows:
- (bullet list of what has changed since — updated memories, new edges, corrections)

## Would I say it again? — [Yes / No / Updated]
(one paragraph explaining your verdict, citing memory IDs, ledger SHAs, edge IDs where relevant)

No preamble. No markdown fences.`;

// ---------------------------------------------------------------------------
// Exported pure helpers (tested without Supabase)
// ---------------------------------------------------------------------------

/**
 * Returns true if the message timestamp is within the configured TTL window.
 */
export function isWithinTTL(messageTsIso: string): boolean {
  const ageDays = (Date.now() - new Date(messageTsIso).getTime()) / 86_400_000;
  return ageDays <= TTL_DAYS;
}

/**
 * Parses a turn identifier from user input.
 *
 * Accepts:
 *   - A UUID string  → returns the UUID directly
 *   - A t.me message link (https://t.me/c/<chat_id>/<message_id>) → returns { chat_id, message_id }
 *   - Anything else  → returns null
 */
export function resolveTurnId(
  input: string
): string | { chat_id: string; message_id: string } | null {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(input.trim())) return input.trim();

  const tgRe = /t\.me\/c\/(\d+)\/(\d+)/;
  const m = input.match(tgRe);
  if (m) return { chat_id: m[1], message_id: m[2] };

  return null;
}

// ---------------------------------------------------------------------------
// Main reconstruction function
// ---------------------------------------------------------------------------

/**
 * Reconstructs the reasoning behind a past Atlas message and evaluates whether
 * Atlas would say the same thing today given updated knowledge.
 *
 * Uses cached results when available. Caches new results after generation.
 */
export async function reconstruct(
  supabase: SupabaseClient,
  turn_id: string,
  deps: {
    callClaude: (prompt: string, opts?: any) => Promise<string>;
  }
): Promise<IntrospectionResult | { error: string }> {
  // 1. Pull the message(s) for this turn
  const { data: msg } = await supabase
    .from("messages")
    .select("id, content, created_at, metadata")
    .filter("metadata->>turn_id", "eq", turn_id)
    .order("created_at", { ascending: true })
    .limit(2);
  const messages = (msg ?? []) as any[];

  if (!messages.length) {
    return { error: `no messages found for turn_id ${turn_id}` };
  }

  const messageTs = messages[0].created_at;

  if (!isWithinTTL(messageTs)) {
    return {
      error: `that turn was archived. Use /dag walk or /dreams search for general history.`,
    };
  }

  // 2. Check cache — avoid burning Opus tokens on repeats
  const { data: cached } = await supabase
    .from("introspect_cache")
    .select("*")
    .eq("turn_id", turn_id)
    .maybeSingle();

  if (cached) {
    const c = cached as any;
    return {
      turn_id,
      message_ts: messageTs,
      time_then: c.time_then,
      time_now: c.time_now,
      delta_reasoning: c.delta_reasoning,
      cited: {
        memory_ids: c.cited_memory_ids ?? [],
        ledger_shas: c.cited_ledger_shas ?? [],
        dag_edges: c.cited_dag_edges ?? [],
        council_review_ids: c.cited_council_review_ids ?? [],
      },
    };
  }

  // 3. Pull contributing memories via attribution_log
  const { data: attr } = await supabase
    .from("attribution_log")
    .select("memory_id")
    .eq("turn_id", turn_id);
  const memoryIds = ((attr ?? []) as any[]).map((a) => a.memory_id);

  const { data: mems } = await supabase
    .from("memory")
    .select("id, original_content, summary, summary_rewritten_at")
    .in("id", memoryIds.length ? memoryIds : ["00000000-0000-0000-0000-000000000000"]);

  // 4. DAG edges approved at-or-before message_ts ("what Atlas knew then")
  const { data: edges } = await supabase
    .from("causal_edges")
    .select("id, from_node, to_node, effect_size, approved_at")
    .eq("approved", true)
    .lte("approved_at", messageTs)
    .limit(40);

  // 5. DAG edges approved AFTER message_ts ("what changed since")
  const { data: newEdges } = await supabase
    .from("causal_edges")
    .select("id, from_node, to_node, effect_size, approved_at, notes")
    .eq("approved", true)
    .gt("approved_at", messageTs)
    .limit(20);

  // 6. Shadow Council reviews (Sprint 5 schema — council_votes table)
  const { data: reviews } = await supabase
    .from("council_votes")
    .select("vote_id, role_id, vote, reason, action_id")
    .limit(10);

  const context = {
    messages_in_turn: messages,
    message_ts: messageTs,
    contributing_memories: (mems ?? []) as any[],
    dag_edges_at_time: (edges ?? []) as any[],
    dag_edges_new_since: (newEdges ?? []) as any[],
    council_reviews: (reviews ?? []) as any[],
  };

  const prompt = `${INTROSPECT_SYSTEM}\n\n---\n\n${JSON.stringify(context, null, 2)}`;
  const raw = await deps.callClaude(prompt, {
    model: "opus",
    isolated: true,
    agentId: "introspect",
  });

  // 7. Parse the three-section output
  const sections = raw.split(/^## /m).filter(Boolean);
  const findSection = (key: string): string =>
    (
      sections
        .find((s) => s.toLowerCase().startsWith(key.toLowerCase()))
        ?.replace(new RegExp(`^${key}[^\n]*\n`, "i"), "")
        .trim() ?? ""
    );

  const time_then = findSection("At the time");
  const time_now = findSection("Today");
  const delta_reasoning = findSection("Would I say it again");

  const result: IntrospectionResult = {
    turn_id,
    message_ts: messageTs,
    time_then,
    time_now,
    delta_reasoning,
    cited: {
      memory_ids: memoryIds,
      ledger_shas: [],
      dag_edges: ((edges ?? []) as any[]).map((e) => e.id),
      council_review_ids: ((reviews ?? []) as any[])
        .map((r) => r.vote_id)
        .filter(Boolean),
    },
  };

  // 8. Cache result
  await supabase.from("introspect_cache").upsert(
    {
      turn_id,
      time_then,
      time_now,
      delta_reasoning,
      cited_memory_ids: result.cited.memory_ids,
      cited_ledger_shas: result.cited.ledger_shas,
      cited_dag_edges: result.cited.dag_edges,
      cited_council_review_ids: result.cited.council_review_ids,
    },
    { onConflict: "turn_id" }
  );

  return result;
}
