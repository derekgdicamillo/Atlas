/**
 * Atlas -- Observational Memory Module
 *
 * Fine-grained observation extraction, classification, reflection,
 * and block compilation for prompt-ready context injection.
 *
 * Pipeline:
 * 1. OBSERVER: extractObservations() parses conversation turns via haiku,
 *    classifies each against existing observations (new/reinforce/supersede),
 *    and stores them with salience scoring and embeddings.
 *
 * 2. REFLECTOR: runReflector() periodically synthesizes higher-level
 *    insights from accumulated observations.
 *
 * 3. BLOCK COMPILER: compileBlocks() groups observations into priority
 *    tiers and produces stable, hashable blocks for prompt injection.
 *
 * 4. PROMPT INTEGRATION: getObservationContext() and getObservationBlocks()
 *    provide formatted text or structured blocks for buildPrompt().
 *
 * 5. MAINTENANCE: pruneObservations() cleans up superseded observations
 *    and recompiles blocks.
 *
 * Tables: observations, observation_blocks (see db/migrations/009_observational_memory.sql)
 * Embedding: OpenAI text-embedding-3-small (1536 dims) via direct API call.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { info, warn, error as logError } from "./logger.ts";
import { scoreSalience, invalidateCache } from "./cognitive.ts";

// ============================================================
// CONSTANTS
// ============================================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_MAX_INPUT = 8000; // cap input to avoid token limits

const SIMILARITY_THRESHOLD_REINFORCE = 0.92; // nearly identical, just bump stability
const SIMILARITY_THRESHOLD_SUPERSEDE = 0.75; // related but updated info
const SIMILARITY_THRESHOLD_SEARCH = 0.65;    // minimum for find_similar_observation RPC

const REFLECTOR_MIN_OBSERVATIONS = 5; // need at least this many to generate insights
const REFLECTOR_LOOKBACK_HOURS = 24;

const MAX_OBSERVATIONS_PER_EXTRACTION = 3;
const MAX_ACTIVE_OBSERVATIONS = 100;

const PRUNE_AGE_DAYS = 30; // superseded observations older than this get deleted

const DEFAULT_MAX_CHARS = 6000; // default max chars for getObservationContext

const BLOCK_SECTION_HEADERS: Record<number, string> = {
  0: "=== KNOWN FACTS & PREFERENCES ===",
  1: "=== ACTIVE CONTEXT ===",
  2: "=== PATTERNS & INSIGHTS ===",
};

// ============================================================
// TYPES
// ============================================================

export type ObservationType = "fact" | "preference" | "decision" | "context" | "insight" | "pattern";

export interface Observation {
  id: string;
  text: string;
  type: ObservationType;
  salience: number;
  stability: number;
  createdAt: string;
}

export interface ObservationBlock {
  id: string;
  blockText: string;
  contentHash: string;
  priority: number;
  estimatedTokens: number;
  consecutiveStableBuilds: number;
}

// ============================================================
// TURN TRACKING (in-memory, per-session)
// ============================================================

const turnTrackers: Map<string, { turnsSinceExtraction: number }> = new Map();

export function getTurnsSinceLastExtraction(sessionKey: string): number {
  return turnTrackers.get(sessionKey)?.turnsSinceExtraction ?? 0;
}

export function markExtractionRan(sessionKey: string): void {
  const tracker = turnTrackers.get(sessionKey);
  if (tracker) {
    tracker.turnsSinceExtraction = 0;
  } else {
    turnTrackers.set(sessionKey, { turnsSinceExtraction: 0 });
  }
}

export function incrementTurnCount(sessionKey: string): void {
  const tracker = turnTrackers.get(sessionKey);
  if (tracker) {
    tracker.turnsSinceExtraction++;
  } else {
    turnTrackers.set(sessionKey, { turnsSinceExtraction: 1 });
  }
}

// ============================================================
// EMBEDDING GENERATION (direct OpenAI call, same pattern as feedback.ts/tts.ts)
// ============================================================

/**
 * Generate an embedding vector via OpenAI text-embedding-3-small.
 * Returns null on failure (callers degrade gracefully).
 */
async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY) {
    warn("observations", "OPENAI_API_KEY not set, cannot generate embedding");
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.substring(0, EMBEDDING_MAX_INPUT),
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      warn("observations", `OpenAI embedding error: ${err}`);
      return null;
    }

    const { data } = await response.json();
    return data?.[0]?.embedding || null;
  } catch (err) {
    warn("observations", `generateEmbedding exception: ${err}`);
    return null;
  }
}

// ============================================================
// OBSERVER: extractObservations
// ============================================================

/**
 * Extract 0-3 observations from recent conversation turns via haiku.
 * For each observation: generate embedding, classify (new/reinforce/supersede),
 * and store in the observations table.
 *
 * @returns Count of new observations created.
 */
export async function extractObservations(
  supabase: SupabaseClient,
  recentTurns: Array<{ role: string; content: string; timestamp: string }>,
  sessionKey: string,
  summarize: (prompt: string) => Promise<string>,
): Promise<number> {
  if (!recentTurns.length) return 0;

  try {
    // Format turns for the extraction prompt
    const formattedTurns = recentTurns
      .map((t) => {
        const role = t.role === "user" ? "User" : "Atlas";
        return `${role}: ${t.content}`;
      })
      .join("\n");

    const prompt =
      "Extract 0-3 important observations from this conversation excerpt.\n" +
      "Each observation should be a single sentence capturing a fact, preference, decision, or context shift.\n" +
      "Only extract genuinely new or important information. Skip routine greetings and small talk.\n\n" +
      "Format each as:\n" +
      "[TYPE: fact|preference|decision|context] observation text\n\n" +
      "If nothing noteworthy, respond with: NONE\n\n" +
      "Conversation:\n" +
      formattedTurns;

    const response = await summarize(prompt);
    if (!response || response.trim().toUpperCase() === "NONE") {
      markExtractionRan(sessionKey);
      return 0;
    }

    // Parse [TYPE: x] lines from the response
    const parsed: Array<{ type: ObservationType; text: string }> = [];
    const typePattern = /\[TYPE:\s*(fact|preference|decision|context)\]\s*(.+)/gi;
    for (const match of response.matchAll(typePattern)) {
      const type = match[1].toLowerCase() as ObservationType;
      const text = match[2].trim();
      if (text.length > 5) {
        parsed.push({ type, text });
      }
    }

    if (!parsed.length) {
      markExtractionRan(sessionKey);
      return 0;
    }

    // Limit to MAX_OBSERVATIONS_PER_EXTRACTION
    const toProcess = parsed.slice(0, MAX_OBSERVATIONS_PER_EXTRACTION);
    let created = 0;

    for (const obs of toProcess) {
      try {
        // Generate embedding for this observation
        const embedding = await generateEmbedding(obs.text);

        // Classify against existing observations
        const classification = await classifyObservation(supabase, obs.text, embedding);

        if (classification.action === "reinforce" && classification.existingId) {
          // Nearly identical observation exists. Bump stability and update reinforcement time.
          // Fetch current stability to increment it (no raw SQL increment in supabase-js).
          const { data: current } = await supabase
            .from("observations")
            .select("stability")
            .eq("id", classification.existingId)
            .single();

          const newStability = (current?.stability ?? 1) + 1;

          await supabase
            .from("observations")
            .update({
              stability: newStability,
              last_reinforced_at: new Date().toISOString(),
            })
            .eq("id", classification.existingId);

          info("observations", `Reinforced observation ${classification.existingId} (stability: ${newStability})`);

        } else if (classification.action === "supersede" && classification.existingId) {
          // Related but updated info. Supersede old, insert new.
          const salience = scoreSalience(obs.text, { containsNewInfo: true });

          const { data: newObs, error: insertErr } = await supabase
            .from("observations")
            .insert({
              observation_text: obs.text,
              observation_type: obs.type,
              salience: salience.overall,
              stability: 1,
              session_key: sessionKey,
              embedding: embedding ? JSON.stringify(embedding) : undefined,
            })
            .select("id")
            .single();

          if (!insertErr && newObs) {
            // Mark old as superseded
            await supabase
              .from("observations")
              .update({
                superseded: true,
                superseded_by: newObs.id,
              })
              .eq("id", classification.existingId);

            created++;
            info("observations", `Superseded ${classification.existingId} with ${newObs.id}: "${obs.text.substring(0, 60)}..."`);
          }

        } else {
          // New observation
          const salience = scoreSalience(obs.text, { containsNewInfo: true });

          const { error: insertErr } = await supabase
            .from("observations")
            .insert({
              observation_text: obs.text,
              observation_type: obs.type,
              salience: salience.overall,
              stability: 1,
              session_key: sessionKey,
              embedding: embedding ? JSON.stringify(embedding) : undefined,
            });

          if (!insertErr) {
            created++;
            info("observations", `New ${obs.type}: "${obs.text.substring(0, 60)}..."`);
          } else {
            warn("observations", `Failed to insert observation: ${insertErr.message}`);
          }
        }
      } catch (err) {
        warn("observations", `Error processing observation: ${err}`);
      }
    }

    // Invalidate observation context cache after writes
    if (created > 0) {
      invalidateCache("observations", "observationBlocks");
    }

    markExtractionRan(sessionKey);
    return created;
  } catch (err) {
    logError("observations", `extractObservations failed: ${err}`);
    markExtractionRan(sessionKey);
    return 0;
  }
}

// ============================================================
// OBSERVER: classifyObservation
// ============================================================

/**
 * Check if an observation duplicates or updates an existing one.
 * Uses vector similarity via find_similar_observation RPC.
 *
 * @param embedding Pre-generated embedding (optional, generates if missing)
 * @returns Classification action and optional existing observation ID.
 */
export async function classifyObservation(
  supabase: SupabaseClient,
  observationText: string,
  embedding?: number[] | null,
): Promise<{ action: "new" | "reinforce" | "supersede"; existingId?: string }> {
  try {
    // Generate embedding if not provided
    const queryEmbedding = embedding || await generateEmbedding(observationText);

    if (!queryEmbedding) {
      // Can't do vector similarity without an embedding. Fall back to FTS.
      return classifyObservationFTS(supabase, observationText);
    }

    // Call find_similar_observation RPC
    const { data, error } = await supabase.rpc("find_similar_observation", {
      query_embedding: JSON.stringify(queryEmbedding),
      similarity_threshold: SIMILARITY_THRESHOLD_SEARCH,
    });

    if (error || !data?.length) {
      return { action: "new" };
    }

    const best = data[0];
    const similarity = best.similarity ?? 0;

    // Very high similarity: reinforce (nearly identical)
    if (similarity > SIMILARITY_THRESHOLD_REINFORCE) {
      return {
        action: "reinforce",
        existingId: best.id,
      };
    }

    // Moderate similarity: supersede (related but updated)
    if (similarity > SIMILARITY_THRESHOLD_SUPERSEDE) {
      return {
        action: "supersede",
        existingId: best.id,
      };
    }

    return { action: "new" };
  } catch (err) {
    warn("observations", `classifyObservation failed: ${err}`);
    return { action: "new" }; // fail open
  }
}

/**
 * Fallback classification using full-text search when embedding generation fails.
 * Less precise than vector similarity but still catches obvious duplicates.
 */
async function classifyObservationFTS(
  supabase: SupabaseClient,
  observationText: string,
): Promise<{ action: "new" | "reinforce" | "supersede"; existingId?: string }> {
  try {
    // Extract key words for FTS query (first 5 meaningful words)
    const words = observationText
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 5);

    if (!words.length) return { action: "new" };

    const ftsQuery = words.join(" & ");

    const { data } = await supabase
      .from("observations")
      .select("id, observation_text, stability")
      .eq("superseded", false)
      .textSearch("search_vector", ftsQuery)
      .limit(3);

    if (!data?.length) return { action: "new" };

    // Simple text overlap heuristic
    const bestMatch = data[0];
    const overlapScore = computeWordOverlap(observationText, bestMatch.observation_text);

    if (overlapScore > 0.8) {
      return { action: "reinforce", existingId: bestMatch.id };
    }
    if (overlapScore > 0.5) {
      return { action: "supersede", existingId: bestMatch.id };
    }

    return { action: "new" };
  } catch {
    return { action: "new" }; // fail open
  }
}

/** Jaccard-like word overlap between two strings. */
function computeWordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

// ============================================================
// REFLECTOR
// ============================================================

/**
 * Synthesize higher-level insights from recent observations.
 * Runs periodically (e.g., nightly via cron alongside consolidation).
 *
 * @returns Count of insights created.
 */
export async function runReflector(
  supabase: SupabaseClient,
  summarize: (prompt: string) => Promise<string>,
): Promise<number> {
  try {
    // Fetch recent non-insight observations from last 24h
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - REFLECTOR_LOOKBACK_HOURS);

    const { data: recentObs, error } = await supabase
      .from("observations")
      .select("id, observation_text, observation_type, salience, stability, created_at")
      .eq("superseded", false)
      .not("observation_type", "in", '("insight","pattern")')
      .gte("created_at", cutoff.toISOString())
      .order("salience", { ascending: false })
      .limit(30);

    if (error) {
      warn("observations", `runReflector fetch failed: ${error.message}`);
      return 0;
    }

    if (!recentObs?.length || recentObs.length < REFLECTOR_MIN_OBSERVATIONS) {
      info("observations", `Reflector skipped: only ${recentObs?.length ?? 0} recent observations (need ${REFLECTOR_MIN_OBSERVATIONS})`);
      return 0;
    }

    // Build prompt for haiku
    const formattedObs = recentObs
      .map((o) => `- [${o.observation_type}] ${o.observation_text}`)
      .join("\n");

    const prompt =
      "Review these recent observations and identify 0-2 higher-level insights or patterns.\n" +
      "An insight combines multiple observations into a behavioral pattern or strategic principle.\n\n" +
      "Observations:\n" +
      formattedObs +
      "\n\nFormat each insight as: [INSIGHT] observation text\n" +
      "If no meaningful insights emerge, respond with: NONE";

    const response = await summarize(prompt);
    if (!response || response.trim().toUpperCase() === "NONE") {
      return 0;
    }

    // Parse [INSIGHT] lines
    const insights: string[] = [];
    const insightPattern = /\[INSIGHT\]\s*(.+)/gi;
    for (const match of response.matchAll(insightPattern)) {
      const text = match[1].trim();
      if (text.length > 10) {
        insights.push(text);
      }
    }

    if (!insights.length) return 0;

    let created = 0;
    for (const insightText of insights.slice(0, 2)) {
      try {
        const embedding = await generateEmbedding(insightText);

        // Check if a very similar insight already exists
        const classification = await classifyObservation(supabase, insightText, embedding);
        if (classification.action === "reinforce") {
          info("observations", `Insight already exists (reinforcing): "${insightText.substring(0, 60)}..."`);
          // Still reinforce the existing one
          if (classification.existingId) {
            await supabase
              .from("observations")
              .update({ last_reinforced_at: new Date().toISOString() })
              .eq("id", classification.existingId);
          }
          continue;
        }

        const { error: insertErr } = await supabase
          .from("observations")
          .insert({
            observation_text: insightText,
            observation_type: "insight",
            salience: 0.7,
            stability: 1,
            embedding: embedding ? JSON.stringify(embedding) : undefined,
          });

        if (!insertErr) {
          created++;
          info("observations", `New insight: "${insightText.substring(0, 60)}..."`);
        }
      } catch (err) {
        warn("observations", `Error inserting insight: ${err}`);
      }
    }

    if (created > 0) {
      invalidateCache("observations", "observationBlocks");
    }

    return created;
  } catch (err) {
    logError("observations", `runReflector failed: ${err}`);
    return 0;
  }
}

// ============================================================
// BLOCK COMPILER
// ============================================================

/**
 * Group active observations into priority-tiered blocks for prompt injection.
 * Each block gets a content hash for stability tracking.
 *
 * Priority tiers:
 *   0 (identity): facts/preferences with stability >= 3
 *   1 (context): decisions/context, or low-stability facts/preferences
 *   2 (insights): insights and patterns
 */
export async function compileBlocks(supabase: SupabaseClient): Promise<ObservationBlock[]> {
  try {
    // Fetch all active observations
    const { data: observations, error } = await supabase.rpc("get_active_observations", {
      max_count: MAX_ACTIVE_OBSERVATIONS,
    });

    if (error) {
      warn("observations", `compileBlocks fetch failed: ${error.message}`);
      return [];
    }

    if (!observations?.length) return [];

    // Group into priority tiers
    const tiers: Map<number, Array<{ type: string; text: string; id: string }>> = new Map([
      [0, []], // identity: stable facts/preferences
      [1, []], // context: decisions, context, unstable facts
      [2, []], // insights: insights and patterns
    ]);

    for (const obs of observations) {
      const type = obs.observation_type as ObservationType;
      const stability = obs.stability ?? 1;
      const entry = { type, text: obs.observation_text, id: obs.id };

      if ((type === "fact" || type === "preference") && stability >= 3) {
        tiers.get(0)!.push(entry);
      } else if (type === "insight" || type === "pattern") {
        tiers.get(2)!.push(entry);
      } else {
        tiers.get(1)!.push(entry);
      }
    }

    const blocks: ObservationBlock[] = [];

    for (const [priority, entries] of tiers) {
      if (!entries.length) continue;

      // Build block text
      const blockText = entries
        .map((e) => `[${e.type}] ${e.text}`)
        .join("\n");

      // Content hash for stability tracking
      const contentHash = createHash("sha256").update(blockText).digest("hex");

      // Estimate tokens (~4 chars per token)
      const estimatedTokens = Math.ceil(blockText.length / 4);

      // Observation IDs in this block
      const observationIds = entries.map((e) => e.id);

      // Check if an existing block at this priority has the same hash
      const { data: existingBlock } = await supabase
        .from("observation_blocks")
        .select("id, content_hash, consecutive_stable_builds")
        .eq("block_priority", priority)
        .limit(1)
        .single();

      let blockId: string;
      let consecutiveStableBuilds = 1;

      if (existingBlock) {
        if (existingBlock.content_hash === contentHash) {
          // Content unchanged, increment stable builds counter
          consecutiveStableBuilds = (existingBlock.consecutive_stable_builds || 0) + 1;
          await supabase
            .from("observation_blocks")
            .update({
              consecutive_stable_builds: consecutiveStableBuilds,
              observation_ids: observationIds,
              estimated_tokens: estimatedTokens,
            })
            .eq("id", existingBlock.id);
          blockId = existingBlock.id;
        } else {
          // Content changed, reset stability counter
          consecutiveStableBuilds = 1;
          await supabase
            .from("observation_blocks")
            .update({
              block_text: blockText,
              content_hash: contentHash,
              observation_ids: observationIds,
              estimated_tokens: estimatedTokens,
              consecutive_stable_builds: 1,
            })
            .eq("id", existingBlock.id);
          blockId = existingBlock.id;
        }
      } else {
        // No existing block at this priority, create new
        const { data: newBlock, error: insertErr } = await supabase
          .from("observation_blocks")
          .insert({
            block_text: blockText,
            content_hash: contentHash,
            observation_ids: observationIds,
            block_priority: priority,
            estimated_tokens: estimatedTokens,
            consecutive_stable_builds: 1,
          })
          .select("id")
          .single();

        if (insertErr || !newBlock) {
          warn("observations", `Failed to create block at priority ${priority}: ${insertErr?.message}`);
          continue;
        }
        blockId = newBlock.id;
      }

      blocks.push({
        id: blockId,
        blockText,
        contentHash,
        priority,
        estimatedTokens,
        consecutiveStableBuilds,
      });
    }

    invalidateCache("observationBlocks");
    return blocks;
  } catch (err) {
    logError("observations", `compileBlocks failed: ${err}`);
    return [];
  }
}

// ============================================================
// PROMPT INTEGRATION
// ============================================================

/**
 * Get formatted observation context for prompt injection.
 * Fetches compiled blocks and formats them with section headers.
 * Truncates to maxChars.
 */
export async function getObservationContext(
  supabase: SupabaseClient,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<string> {
  try {
    const { data: blocks, error } = await supabase
      .from("observation_blocks")
      .select("block_text, block_priority, estimated_tokens")
      .order("block_priority", { ascending: true });

    if (error || !blocks?.length) return "";

    const sections: string[] = [];

    for (const block of blocks) {
      const header = BLOCK_SECTION_HEADERS[block.block_priority] || `=== TIER ${block.block_priority} ===`;
      sections.push(`${header}\n${block.block_text}`);
    }

    let result = sections.join("\n\n");

    // Truncate to maxChars
    if (result.length > maxChars) {
      result = result.substring(0, maxChars);
      // Try to cut at a clean line boundary
      const lastNewline = result.lastIndexOf("\n");
      if (lastNewline > maxChars * 0.8) {
        result = result.substring(0, lastNewline);
      }
    }

    return result;
  } catch (err) {
    warn("observations", `getObservationContext failed: ${err}`);
    return "";
  }
}

/**
 * Get observation blocks as structured data (for callers that need
 * more control over formatting and token budgeting).
 */
export async function getObservationBlocks(supabase: SupabaseClient): Promise<ObservationBlock[]> {
  try {
    const { data, error } = await supabase
      .from("observation_blocks")
      .select("id, block_text, content_hash, block_priority, estimated_tokens, consecutive_stable_builds")
      .order("block_priority", { ascending: true });

    if (error || !data?.length) return [];

    return data.map((b) => ({
      id: b.id,
      blockText: b.block_text,
      contentHash: b.content_hash,
      priority: b.block_priority,
      estimatedTokens: b.estimated_tokens,
      consecutiveStableBuilds: b.consecutive_stable_builds,
    }));
  } catch (err) {
    warn("observations", `getObservationBlocks failed: ${err}`);
    return [];
  }
}

// ============================================================
// MAINTENANCE
// ============================================================

/**
 * Prune old superseded observations and recompile blocks if needed.
 */
export async function pruneObservations(
  supabase: SupabaseClient,
): Promise<{ pruned: number; blocksRecompiled: boolean }> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - PRUNE_AGE_DAYS);

    // Delete superseded observations older than PRUNE_AGE_DAYS
    const { data: deleted, error } = await supabase
      .from("observations")
      .delete()
      .eq("superseded", true)
      .lt("created_at", cutoff.toISOString())
      .select("id");

    if (error) {
      warn("observations", `pruneObservations delete failed: ${error.message}`);
      return { pruned: 0, blocksRecompiled: false };
    }

    const pruned = deleted?.length ?? 0;
    let blocksRecompiled = false;

    if (pruned > 0) {
      info("observations", `Pruned ${pruned} superseded observations older than ${PRUNE_AGE_DAYS} days`);
      // Recompile blocks since the observation set changed
      await compileBlocks(supabase);
      blocksRecompiled = true;
      invalidateCache("observations", "observationBlocks");
    }

    return { pruned, blocksRecompiled };
  } catch (err) {
    logError("observations", `pruneObservations failed: ${err}`);
    return { pruned: 0, blocksRecompiled: false };
  }
}
