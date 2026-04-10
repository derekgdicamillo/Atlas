/**
 * Atlas — Cognitive Memory Architecture: Consolidation Engine
 *
 * Two-phase structured fact extraction (Mem0 pattern):
 *   Phase 1: Extract typed facts from conversation (Haiku)
 *   Phase 2: Consolidate against existing facts (dedup/update/supersede)
 *
 * Ebbinghaus forgetting curves per fact type.
 * Nightly sweep for decay + pruning.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn, error as logError } from "./logger.ts";
import { CMA_ENABLED, CMA_FACT_DECAY, CMA_DECAY_THRESHOLD, CMA_DELETE_THRESHOLD } from "./constants.ts";

// ============================================================
// TYPES
// ============================================================

export type FactType = "decision" | "artifact" | "config" | "wip" | "blocker" | "insight" | "correction";

export interface ExtractedFact {
  type: FactType;
  content: string;
  reasoning?: string;
}

export interface ConsolidatedFact {
  id: string;
  agent_id: string;
  fact_type: FactType;
  content: string;
  reasoning: string | null;
  confidence: number;
  valence: "positive" | "negative" | "neutral";
  valence_intensity: number;
  is_correction: boolean;
  decay_half_life_days: number;
  last_accessed: string;
  access_count: number;
  historical: boolean;
  created_at: string;
}

// ============================================================
// PHASE 1: EXTRACT FACTS FROM CONVERSATION
// ============================================================

const EXTRACTION_PROMPT = `Extract structured facts from this conversation. Return ONLY a JSON array of facts.

Each fact must have:
- "type": one of "decision", "artifact", "config", "wip", "blocker", "insight", "correction"
- "content": the fact itself (be specific: include file paths, function names, values)
- "reasoning": why this is worth remembering (1 sentence)

Type definitions:
- decision: A choice made and its reasoning. Include what was chosen AND what was rejected.
- artifact: A file created, modified, or deleted. Include the full path.
- config: A setting, parameter, or value discussed. Include the actual value.
- wip: Work in progress, unfinished task with explicit next step.
- blocker: Something that stopped progress. Include what's blocked and why.
- insight: Something learned about the domain, user, or system.
- correction: User corrected the agent. HIGHEST priority. Include both the wrong thing and the right thing.

Rules:
- Max 8 facts per extraction
- Skip trivial, obvious, or purely conversational information
- Each fact must be independently useful without surrounding context
- Be specific enough that someone with zero context can understand

CONVERSATION:
`;

/**
 * Extract typed facts from recent conversation turns.
 * Phase 1 of two-phase consolidation (Mem0 pattern).
 */
export async function extractFacts(
  recentConversation: string,
  summarizeFn: (prompt: string) => Promise<string>,
): Promise<ExtractedFact[]> {
  if (!CMA_ENABLED) return [];

  try {
    const raw = await summarizeFn(EXTRACTION_PROMPT + recentConversation);
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((f: any) => f.type && f.content && CMA_FACT_DECAY[f.type] !== undefined)
      .slice(0, 8)
      .map((f: any) => ({
        type: f.type as FactType,
        content: String(f.content).substring(0, 500),
        reasoning: f.reasoning ? String(f.reasoning).substring(0, 200) : undefined,
      }));
  } catch (err) {
    warn("consolidation", `Fact extraction failed: ${err}`);
    return [];
  }
}

// ============================================================
// PHASE 2: CONSOLIDATE AGAINST EXISTING FACTS
// ============================================================

/**
 * Consolidate extracted facts against existing memory.
 * For each fact: embed, search for similar, decide ADD/UPDATE/SUPERSEDE.
 */
export async function consolidateFacts(
  facts: ExtractedFact[],
  agentId: string,
  userId: string,
  supabase: SupabaseClient,
  embedFn: (text: string) => Promise<number[]>,
): Promise<{ added: number; updated: number; superseded: number }> {
  if (!CMA_ENABLED || facts.length === 0) return { added: 0, updated: 0, superseded: 0 };

  let added = 0, updated = 0, superseded = 0;

  for (const fact of facts) {
    try {
      // Generate embedding
      const embedding = await embedFn(fact.content);

      // Search for similar existing facts
      const { data: similar } = await supabase.rpc("search_consolidated_facts", {
        query_embedding: embedding,
        query_text: fact.content,
        p_agent_id: agentId,
        p_fact_types: [fact.type],
        match_limit: 3,
        include_historical: false,
      });

      const topMatch = similar?.[0];

      if (topMatch && topMatch.score > 0.025) {
        // High similarity: check if update or duplicate
        if (topMatch.score > 0.03) {
          // Very similar -- update existing (keep the more detailed one)
          const keepNew = fact.content.length > topMatch.content.length;
          if (keepNew) {
            await supabase
              .from("consolidated_facts")
              .update({
                content: fact.content,
                reasoning: fact.reasoning || topMatch.reasoning,
                embedding,
                confidence: Math.min(1.0, (topMatch.confidence || 0.9) + 0.05),
                updated_at: new Date().toISOString(),
                last_accessed: new Date().toISOString(),
                access_count: (topMatch.access_count || 0) + 1,
              })
              .eq("id", topMatch.id);
            updated++;
          }
          // If existing is more detailed, just bump access count (reconsolidation)
          else {
            await supabase
              .from("consolidated_facts")
              .update({
                last_accessed: new Date().toISOString(),
                access_count: (topMatch.access_count || 0) + 1,
              })
              .eq("id", topMatch.id);
          }
        } else {
          // Moderate similarity: might be a supersede (contradiction)
          // For now, add as new and let manual review handle conflicts
          await insertFact(fact, agentId, userId, embedding, supabase);
          added++;
        }
      } else {
        // No similar fact: insert new
        await insertFact(fact, agentId, userId, embedding, supabase);
        added++;
      }
    } catch (err) {
      warn("consolidation", `Failed to consolidate fact "${fact.content.substring(0, 50)}": ${err}`);
    }
  }

  if (added + updated + superseded > 0) {
    info("consolidation", `Consolidated ${facts.length} facts: ${added} added, ${updated} updated, ${superseded} superseded`);
  }

  return { added, updated, superseded };
}

async function insertFact(
  fact: ExtractedFact,
  agentId: string,
  userId: string,
  embedding: number[],
  supabase: SupabaseClient,
): Promise<void> {
  const halfLife = CMA_FACT_DECAY[fact.type] || 30;

  await supabase.from("consolidated_facts").insert({
    agent_id: agentId,
    user_id: userId,
    fact_type: fact.type,
    content: fact.content,
    reasoning: fact.reasoning || null,
    embedding,
    confidence: fact.type === "correction" ? 1.0 : 0.9,
    valence: "neutral",
    valence_intensity: 0,
    is_correction: fact.type === "correction",
    decay_half_life_days: halfLife,
  });
}

// ============================================================
// FORGETTING CURVE (Ebbinghaus)
// ============================================================

/**
 * Calculate retention score for a fact.
 * R = e^(-t / (S * reinforcement))
 * where t = days since creation, S = half-life, reinforcement = 1 + 0.2 * access_count
 */
export function calculateRetention(fact: {
  created_at: string;
  decay_half_life_days: number;
  access_count: number;
  is_correction?: boolean;
}): number {
  // Corrections never decay
  if (fact.is_correction) return 1.0;

  const daysSinceCreation = (Date.now() - new Date(fact.created_at).getTime()) / (1000 * 60 * 60 * 24);
  const reinforcement = 1 + 0.2 * (fact.access_count || 0);
  const effectiveHalfLife = fact.decay_half_life_days * reinforcement;

  return Math.exp(-daysSinceCreation / effectiveHalfLife);
}

// ============================================================
// NIGHTLY SWEEP
// ============================================================

/**
 * Apply forgetting curves to all consolidated facts.
 * Mark decayed facts as historical, hard-delete fully expired ones.
 * Called nightly via cron.
 */
export async function runDecaySweep(supabase: SupabaseClient): Promise<{
  marked_historical: number;
  deleted: number;
}> {
  if (!CMA_ENABLED) return { marked_historical: 0, deleted: 0 };

  let marked = 0, deleted = 0;

  try {
    // Fetch all active (non-historical) facts
    const { data: facts, error } = await supabase
      .from("consolidated_facts")
      .select("id, fact_type, created_at, decay_half_life_days, access_count, is_correction, historical")
      .eq("historical", false);

    if (error || !facts) {
      logError("consolidation", `Decay sweep fetch failed: ${error?.message}`);
      return { marked_historical: 0, deleted: 0 };
    }

    const toMarkHistorical: string[] = [];

    for (const fact of facts) {
      const retention = calculateRetention(fact);

      if (retention < CMA_DECAY_THRESHOLD) {
        toMarkHistorical.push(fact.id);
      }
    }

    // Batch mark as historical
    if (toMarkHistorical.length > 0) {
      const { error: updateError } = await supabase
        .from("consolidated_facts")
        .update({ historical: true, valid_to: new Date().toISOString() })
        .in("id", toMarkHistorical);

      if (!updateError) marked = toMarkHistorical.length;
    }

    // Hard delete: historical facts with retention < CMA_DELETE_THRESHOLD and older than 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: candidates } = await supabase
      .from("consolidated_facts")
      .select("id, created_at, decay_half_life_days, access_count, is_correction")
      .eq("historical", true)
      .lt("created_at", thirtyDaysAgo);

    if (candidates) {
      const toDelete = candidates
        .filter(f => calculateRetention(f) < CMA_DELETE_THRESHOLD && !f.is_correction)
        .map(f => f.id);

      if (toDelete.length > 0) {
        await supabase
          .from("consolidated_facts")
          .delete()
          .in("id", toDelete);
        deleted = toDelete.length;
      }
    }

    if (marked + deleted > 0) {
      info("consolidation", `Decay sweep: ${marked} marked historical, ${deleted} hard deleted`);
    }
  } catch (err) {
    logError("consolidation", `Decay sweep error: ${err}`);
  }

  return { marked_historical: marked, deleted };
}

// ============================================================
// SEARCH CONSOLIDATED FACTS (for context injection)
// ============================================================

/**
 * Search consolidated facts and format for prompt injection.
 */
export async function getRelevantFacts(
  query: string,
  agentId: string,
  supabase: SupabaseClient,
  embedFn: (text: string) => Promise<number[]>,
  options?: { factTypes?: FactType[]; limit?: number; maxChars?: number },
): Promise<string> {
  if (!CMA_ENABLED) return "";

  const limit = options?.limit ?? 5;
  const maxChars = options?.maxChars ?? 2000;

  try {
    const embedding = await embedFn(query);
    const { data: facts } = await supabase.rpc("search_consolidated_facts", {
      query_embedding: embedding,
      query_text: query,
      p_agent_id: agentId,
      p_fact_types: options?.factTypes || null,
      match_limit: limit,
      include_historical: false,
    });

    if (!facts || facts.length === 0) return "";

    // Record access for reconsolidation
    const factIds = facts.map((f: any) => f.id);
    supabase
      .from("consolidated_facts")
      .update({ last_accessed: new Date().toISOString() })
      .in("id", factIds)
      .then(() => {
        // Also increment access_count
        // (Supabase doesn't support increment in update, do it via RPC or separate query)
      })
      .catch(() => {});

    // Format
    const lines = facts.map((f: any) => {
      const tag = f.fact_type.toUpperCase();
      return `[${tag}] ${f.content}`;
    });

    const result = "CONSOLIDATED FACTS:\n" + lines.join("\n");
    return result.length > maxChars ? result.substring(0, maxChars) + "\n[truncated]" : result;
  } catch (err) {
    warn("consolidation", `Fact retrieval failed: ${err}`);
    return "";
  }
}
