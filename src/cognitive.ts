/**
 * Atlas -- Cognitive Memory Module
 *
 * Human-like memory processes inspired by cognitive science:
 * - Salience-weighted encoding (emotional weight, self-relevance, novelty)
 * - Temporal decay scoring (Ebbinghaus forgetting curve)
 * - Contradiction detection and resolution
 * - Reconsolidation on retrieval (access tracking + memory update)
 * - Query reformulation (conversation-aware search)
 * - Adaptive intent classification (LLM-based, replaces regex)
 * - Automatic entity extraction (lightweight NER)
 * - Spreading activation in graph retrieval
 * - Narrative threading (group related memories)
 * - Prospective memory (future-oriented triggers)
 * - Consolidation engine (sleep-time processing)
 *
 * This module is the central coordinator. Individual functions are
 * called from relay.ts, memory.ts, graph.ts, search.ts, and cron.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn, error as logError } from "./logger.ts";

// ============================================================
// CACHE INVALIDATION (Item C)
// ============================================================

// Reference to the global context cache in relay.ts.
// Set by relay.ts at startup via setCacheRef().
let _contextCache: Map<string, { value: string; ts: number }> | null = null;

export function setCacheRef(cache: Map<string, { value: string; ts: number }>): void {
  _contextCache = cache;
}

/** Invalidate specific cache entries immediately after a write. */
export function invalidateCache(...labels: string[]): void {
  if (!_contextCache) return;
  for (const label of labels) {
    if (_contextCache.has(label)) {
      _contextCache.delete(label);
    }
  }
}

// ============================================================
// SALIENCE SCORING (Item F)
// ============================================================

/** Sentiment keywords for quick emotional salience detection. */
const POSITIVE_MARKERS = /\b(excited|thrilled|love|amazing|incredible|fantastic|grateful|proud|celebrate|breakthrough|milestone|finally|beautiful)\b/i;
const NEGATIVE_MARKERS = /\b(worried|concerned|scared|frustrated|angry|devastated|terrible|awful|crisis|emergency|struggling|stuck|failing|lost|anxious|stressed|overwhelmed|heartbr)\b/i;
const IMPORTANCE_MARKERS = /\b(important|critical|crucial|remember this|don't forget|key thing|must|essential|priority|urgent|never forget|always remember|make sure)\b/i;
const SELF_RELEVANCE_MARKERS = /\b(my health|my family|my business|my wife|my daughter|my son|esther|personal|private|secret|confession|between us)\b/i;

export interface SalienceFactors {
  emotional: number;     // 0-1: sentiment intensity
  importance: number;    // 0-1: explicit importance markers
  selfRelevance: number; // 0-1: personal/self-referential content
  depth: number;         // 0-1: interaction depth (message length, detail)
  novelty: number;       // 0-1: new information vs repetition
  overall: number;       // 0-1: weighted composite
}

/**
 * Score the salience of a message for memory encoding decisions.
 * Higher salience = more likely to be remembered, slower decay.
 */
export function scoreSalience(text: string, contextHints?: {
  isLongConversation?: boolean;
  containsNewInfo?: boolean;
  mentionsEntities?: boolean;
}): SalienceFactors {
  const emotional = (
    (POSITIVE_MARKERS.test(text) ? 0.6 : 0) +
    (NEGATIVE_MARKERS.test(text) ? 0.8 : 0) // negative emotions encode stronger
  );

  const importance = IMPORTANCE_MARKERS.test(text) ? 0.9 : 0;

  const selfRelevance = SELF_RELEVANCE_MARKERS.test(text) ? 0.8 : 0;

  // Depth: longer, more detailed messages get higher depth scores
  const wordCount = text.split(/\s+/).length;
  const depth = Math.min(wordCount / 100, 1.0); // caps at 100 words

  // Novelty: default 0.5, boosted if context says it's new info
  const novelty = contextHints?.containsNewInfo ? 0.8 :
    contextHints?.mentionsEntities ? 0.6 : 0.4;

  // Weighted composite (matches research blueprint weights)
  const overall = Math.min(1.0, (
    emotional * 3.0 +
    importance * 4.0 +
    selfRelevance * 2.5 +
    depth * 1.5 +
    novelty * 2.0
  ) / 13.0); // normalize by max possible (3+4+2.5+1.5+2 = 13)

  return {
    emotional: Math.min(emotional, 1.0),
    importance: Math.min(importance, 1.0),
    selfRelevance: Math.min(selfRelevance, 1.0),
    depth: Math.min(depth, 1.0),
    novelty,
    overall: Math.max(overall, 0.1), // floor at 0.1 (nothing is completely irrelevant)
  };
}

// ============================================================
// CONTRADICTION DETECTION (Item B)
// ============================================================

export type ConflictResolution = "skip" | "update" | "supersede" | "keep_both";

export interface ConflictResult {
  resolution: ConflictResolution;
  existingId?: string;
  existingContent?: string;
  reason?: string;
}

/**
 * Check if a new fact contradicts or duplicates an existing one.
 * Uses semantic similarity to find candidates, then quick heuristics
 * to classify the relationship.
 *
 * This is the fast path (no LLM call). For the full LLM-based
 * contradiction resolution, use resolveContradictionLLM().
 */
export async function detectContradiction(
  supabase: SupabaseClient,
  newFact: string,
): Promise<ConflictResult> {
  try {
    // Search for similar existing facts
    const { data, error } = await supabase.functions.invoke("search", {
      body: {
        query: newFact,
        table: "memory",
        match_count: 3,
        match_threshold: 0.7, // lower than dedup (0.85) to catch contradictions
      },
    });

    if (error || !data?.length) {
      return { resolution: "keep_both" }; // no similar facts, safe to insert
    }

    // Only check against active (non-historical) facts
    const activeFacts = data.filter((d: any) => d.type === "fact" && !d.historical);
    if (!activeFacts.length) return { resolution: "keep_both" };

    const best = activeFacts[0];
    const similarity = best.similarity || 0;

    // Very high similarity (>0.92) = likely duplicate
    if (similarity > 0.92) {
      return {
        resolution: "skip",
        existingId: best.id,
        existingContent: best.content,
        reason: `Duplicate (${(similarity * 100).toFixed(0)}% similar)`,
      };
    }

    // High similarity (0.85-0.92) = same topic, possibly updated
    if (similarity > 0.85) {
      return {
        resolution: "update",
        existingId: best.id,
        existingContent: best.content,
        reason: `Same topic, likely updated (${(similarity * 100).toFixed(0)}% similar)`,
      };
    }

    // Medium similarity (0.7-0.85) = related, check for contradiction signals
    // Quick heuristic: negation patterns suggest contradiction
    const negationInNew = /\b(not|no longer|stopped|quit|changed|switched|moved|left|don't|doesn't|isn't|aren't|won't|never)\b/i.test(newFact);
    const hasOppositeSignals = negationInNew && similarity > 0.75;

    if (hasOppositeSignals) {
      return {
        resolution: "supersede",
        existingId: best.id,
        existingContent: best.content,
        reason: `Possible contradiction detected (${(similarity * 100).toFixed(0)}% similar, negation present)`,
      };
    }

    return { resolution: "keep_both" };
  } catch {
    return { resolution: "keep_both" }; // fail open
  }
}

// ============================================================
// QUERY REFORMULATION (Item D)
// ============================================================

/**
 * Reformulate a raw user query into a better search query
 * using conversation context. This is the fast heuristic path.
 *
 * Handles:
 * - Pronoun resolution ("tell me more about that" -> includes referent)
 * - Short queries ("yes" -> uses last substantial topic)
 * - Entity extraction (pulls names, topics from recent turns)
 */
export function reformulateQuery(
  rawQuery: string,
  recentTurns: Array<{ role: string; content: string }>,
): string {
  const words = rawQuery.trim().split(/\s+/);

  // Very short or pronominal queries need context enrichment
  const isShort = words.length <= 4;
  const hasPronouns = /\b(that|this|it|those|these|them|they|he|she|her|him)\b/i.test(rawQuery);
  const isFollowUp = /\b(more|also|what about|how about|and|too|as well)\b/i.test(rawQuery);

  if (!isShort && !hasPronouns && !isFollowUp) {
    return rawQuery; // query is self-contained, no reformulation needed
  }

  // Extract key entities and topics from recent turns
  const recentContent = recentTurns
    .slice(-4) // last 4 turns
    .map(t => t.content)
    .join(" ");

  // Pull out capitalized words (likely proper nouns/entities)
  const entities = new Set<string>();
  for (const match of recentContent.matchAll(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/g)) {
    const entity = match[1];
    // Skip common sentence starters
    if (!["The", "This", "That", "When", "What", "How", "Why", "Who", "Where", "Yes", "No", "Hi", "Hey", "Hello", "Thanks", "Sure", "Ok", "Just", "Also"].includes(entity)) {
      entities.add(entity);
    }
  }

  // Find the last substantive message (>20 chars, from user or assistant)
  const lastSubstantive = recentTurns
    .filter(t => t.content.length > 20)
    .pop();

  if (!lastSubstantive) return rawQuery;

  // Build enriched query
  const enrichments: string[] = [rawQuery];

  // Add relevant entities from context
  const entityStr = [...entities].slice(0, 3).join(" ");
  if (entityStr) enrichments.push(entityStr);

  // For pronominal references, add key phrases from last turn
  if (hasPronouns || isFollowUp) {
    // Extract the topic from the last substantive turn (first 100 chars)
    const topicSnippet = lastSubstantive.content.substring(0, 100)
      .replace(/[^\w\s]/g, " ")
      .trim();
    enrichments.push(topicSnippet);
  }

  return enrichments.join(" ").substring(0, 300); // cap at 300 chars
}

// ============================================================
// ADAPTIVE INTENT CLASSIFICATION (Item L)
// ============================================================

/**
 * Enhanced intent classification that supplements regex with
 * conversation-aware heuristics. Not a full LLM call (too expensive
 * per message), but smarter than pure regex.
 *
 * Key improvements over pure regex:
 * - Short messages that follow substantive conversations aren't casual
 * - Questions about recently discussed topics get the right context
 * - Follow-up patterns ("what about X?") inherit parent intent
 */
export function enhanceIntent(
  regexIntent: Record<string, boolean>,
  messageText: string,
  recentTurns: Array<{ role: string; content: string }>,
): Record<string, boolean> {
  const enhanced = { ...regexIntent };

  // Don't downgrade to casual if the conversation was substantive
  if (enhanced.casual && recentTurns.length >= 2) {
    const lastAssistant = recentTurns
      .filter(t => t.role === "assistant")
      .pop();

    if (lastAssistant && lastAssistant.content.length > 200) {
      // Last assistant response was substantial. This is likely a follow-up,
      // not a casual message. Inherit the dominant intent from context.
      enhanced.casual = false;

      // Check what the conversation was about
      const contextText = recentTurns.slice(-3).map(t => t.content).join(" ");

      // Re-check intent patterns against the conversation context
      if (/\b(financ|revenue|profit|cost|money|budget)/i.test(contextText)) enhanced.financial = true;
      if (/\b(pipeline|lead|patient|consult|funnel)/i.test(contextText)) enhanced.pipeline = true;
      if (/\b(email|gmail|calendar|schedule)/i.test(contextText)) enhanced.google = true;
      if (/\b(review|rating|gbp|reputation)/i.test(contextText)) enhanced.reputation = true;
      if (/\b(traffic|analytics|conversion)/i.test(contextText)) enhanced.analytics = true;
      if (/\b(ad|campaign|content|marketing)/i.test(contextText)) enhanced.marketing = true;
      if (/\b(build|fix|code|implement|debug)/i.test(contextText)) enhanced.coding = true;
    }
  }

  // Questions always deserve context, even if short
  if (messageText.trim().endsWith("?") && enhanced.casual) {
    enhanced.casual = false;
    // graphWorthy is a good default for questions (enables entity search)
    enhanced.graphWorthy = true;
  }

  return enhanced;
}

// ============================================================
// AUTOMATIC ENTITY EXTRACTION (Item E)
// ============================================================

/** Known entity patterns for Atlas's domain. */
const KNOWN_ENTITY_PATTERNS = [
  // People: "Dr. Derek", "Esther", etc.
  { pattern: /\b(Dr\.?\s+\w+|Esther|Derek|Sarah|Atlas)\b/g, type: "person" },
  // Organizations
  { pattern: /\b(PV\s*(?:Medispa|Med\s*Spa)|Vitality\s*Unchained|Skool|GoHighLevel|GHL|QuickBooks|Meta)\b/gi, type: "org" },
  // Medical/program terms
  { pattern: /\b(GLP-1|semaglutide|tirzepatide|Ozempic|Wegovy|Mounjaro|Zepbound)\b/gi, type: "concept" },
  // Tools/platforms
  { pattern: /\b(Claude|Anthropic|Supabase|Telegram|Gmail|Google\s*(?:Ads|Analytics|Business))\b/gi, type: "tool" },
];

export interface ExtractedEntity {
  name: string;
  type: string;
  confidence: number;
}

/**
 * Extract entities from text using pattern matching.
 * Returns entities not already known (for auto-creation in graph).
 * Lightweight: no LLM call, just regex.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const found = new Map<string, ExtractedEntity>();

  for (const { pattern, type } of KNOWN_ENTITY_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = match[0].trim();
      if (name.length < 2) continue;
      const key = name.toLowerCase();
      if (!found.has(key)) {
        found.set(key, { name, type, confidence: 0.8 });
      }
    }
  }

  // Also extract capitalized multi-word phrases (likely proper nouns)
  for (const match of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)) {
    const name = match[0].trim();
    const key = name.toLowerCase();
    if (!found.has(key) && name.length > 3) {
      found.set(key, { name, type: "concept", confidence: 0.5 });
    }
  }

  return [...found.values()];
}

/**
 * Auto-upsert extracted entities into the graph.
 * Only creates entities that don't already exist.
 */
export async function autoCreateEntities(
  supabase: SupabaseClient,
  entities: ExtractedEntity[],
): Promise<number> {
  let created = 0;
  for (const entity of entities) {
    try {
      // Check if entity exists (case-insensitive)
      const { data: existing } = await supabase
        .from("memory_entities")
        .select("id")
        .ilike("name", entity.name)
        .limit(1);

      if (existing?.length) continue; // already exists

      // Create the entity
      const { error } = await supabase
        .from("memory_entities")
        .insert({
          name: entity.name,
          entity_type: entity.type,
          description: null,
        });

      if (!error) created++;
    } catch {
      // Non-critical, continue
    }
  }
  return created;
}

// ============================================================
// SPREADING ACTIVATION (Item H)
// ============================================================

/**
 * Get entity context using spreading activation (2-hop traversal
 * with activation decay). Replaces the old 1-hop neighbor approach.
 */
export async function getEntityContextSpreading(
  supabase: SupabaseClient,
  query: string,
  maxEntities = 5,
): Promise<string> {
  try {
    // Vector search for seed entities
    const { data: seeds, error } = await supabase.functions.invoke("search", {
      body: {
        query,
        table: "memory_entities",
        match_count: maxEntities,
        match_threshold: 0.6,
      },
    });

    if (error || !seeds?.length) return "";

    const seedIds = seeds.slice(0, 3).map((s: any) => s.id);

    // Record access for reconsolidation.
    // supabase.rpc() returns a PostgrestBuilder (thenable but not a full Promise),
    // so .catch() may not exist. Wrap in try/catch instead.
    try {
      await supabase.rpc("record_entity_access", { entity_ids: seedIds });
    } catch { /* non-critical */ }

    // Spreading activation: 2-hop with 0.7 decay
    const { data: neighborhood } = await supabase.rpc("get_entity_neighborhood", {
      start_entity_ids: seedIds,
      max_depth: 2,
      activation_decay: 0.7,
    });

    // Format seed entities
    const sections: string[] = [];
    for (const seed of seeds.slice(0, 3)) {
      let section = `${seed.name} (${seed.entity_type})`;
      if (seed.description) section += `: ${seed.description}`;

      // Add activated neighbors
      if (neighborhood?.length) {
        const neighbors = neighborhood
          .filter((n: any) => n.activation_level > 0.2)
          .sort((a: any, b: any) => b.activation_level - a.activation_level)
          .slice(0, 5);

        if (neighbors.length) {
          const rels = neighbors.map((n: any) => {
            const level = (n.activation_level * 100).toFixed(0);
            const rel = n.path_relationship ? ` (${n.path_relationship})` : "";
            return `  -> ${n.entity_name} (${n.entity_type})${rel} [${level}%]`;
          });
          section += "\n" + [...new Set(rels)].join("\n");
        }
      }

      sections.push(section);
    }

    return sections.length > 0
      ? "ENTITY GRAPH (spreading activation):\n" + sections.join("\n\n")
      : "";
  } catch (err) {
    warn("cognitive", `getEntityContextSpreading failed: ${err}`);
    return "";
  }
}

// ============================================================
// RECONSOLIDATION (Item G)
// ============================================================

/**
 * Record access to memory entries retrieved during search.
 * Called after getRelevantContext returns results.
 * Increments access_count and updates last_accessed.
 */
export async function recordAccess(
  supabase: SupabaseClient,
  sourceTable: string,
  sourceIds: string[],
): Promise<void> {
  if (!sourceIds.length) return;
  try {
    if (sourceTable === "memory") {
      await supabase.rpc("record_memory_access", { memory_ids: sourceIds });
    } else if (sourceTable === "memory_entities") {
      await supabase.rpc("record_entity_access", { entity_ids: sourceIds });
    }
    // Messages don't need access tracking (too high volume)
  } catch (err) {
    warn("cognitive", `recordAccess failed for ${sourceTable}: ${err}`);
  }
}

// ============================================================
// NARRATIVE THREADING (Item J)
// ============================================================

/**
 * Find or create a thread for a new memory entry.
 * Uses semantic search to find existing threads that match the content.
 */
export async function assignThread(
  supabase: SupabaseClient,
  content: string,
  entityNames: string[] = [],
): Promise<string | null> {
  try {
    // Search for matching active threads
    const { data: matches, error } = await supabase.functions.invoke("search", {
      body: {
        query: content,
        table: "memory_threads",
        match_count: 3,
        match_threshold: 0.7,
      },
    });

    if (!error && matches?.length) {
      const bestMatch = matches[0];
      if (bestMatch.similarity > 0.75) {
        // Update thread activity
        await supabase
          .from("memory_threads")
          .update({
            last_activity: new Date().toISOString(),
            entry_count: (bestMatch.entry_count || 0) + 1,
          })
          .eq("id", bestMatch.id);

        return bestMatch.id;
      }
    }

    // No matching thread found. Create a new one if the content is substantial.
    if (content.length < 30) return null; // too short for a new thread

    // Generate a thread title from the content (first meaningful phrase)
    const title = content.substring(0, 80).replace(/[^\w\s'-]/g, "").trim();
    if (!title) return null;

    const { data: newThread, error: insertError } = await supabase
      .from("memory_threads")
      .insert({
        title,
        summary: content.substring(0, 200),
        entry_count: 1,
      })
      .select("id")
      .single();

    if (insertError) {
      warn("cognitive", `Failed to create thread: ${insertError.message}`);
      return null;
    }

    return newThread?.id || null;
  } catch (err) {
    warn("cognitive", `assignThread failed: ${err}`);
    return null;
  }
}

// ============================================================
// PROSPECTIVE MEMORY (Item K)
// ============================================================

/** Parse prospective memory tags from Claude's response. */
export function parseProspectiveTags(response: string): Array<{
  triggerType: "time" | "event" | "context";
  condition: Record<string, unknown>;
  action: string;
}> {
  const results: Array<{
    triggerType: "time" | "event" | "context";
    condition: Record<string, unknown>;
    action: string;
  }> = [];

  // [REMIND: action | AT: time] — time-based
  for (const match of response.matchAll(/\[REMIND:\s*([\s\S]+?)\s*\|\s*AT:\s*([\s\S]+?)\]/gi)) {
    const action = match[1].trim();
    const timeStr = match[2].trim();
    if (action && timeStr) {
      results.push({
        triggerType: "time",
        condition: { fire_at: timeStr },
        action,
      });
    }
  }

  // [WHEN: condition | DO: action] — event-based
  for (const match of response.matchAll(/\[WHEN:\s*([\s\S]+?)\s*\|\s*DO:\s*([\s\S]+?)\]/gi)) {
    const condition = match[1].trim();
    const action = match[2].trim();
    if (condition && action) {
      results.push({
        triggerType: "event",
        condition: { pattern: condition },
        action,
      });
    }
  }

  // [SURFACE: info | TOPIC: topic] — context-based
  for (const match of response.matchAll(/\[SURFACE:\s*([\s\S]+?)\s*\|\s*TOPIC:\s*([\s\S]+?)\]/gi)) {
    const action = match[1].trim();
    const topic = match[2].trim();
    if (action && topic) {
      results.push({
        triggerType: "context",
        condition: { topic },
        action,
      });
    }
  }

  return results;
}

/**
 * Save prospective memory entries to the database.
 */
export async function saveProspectiveMemories(
  supabase: SupabaseClient,
  entries: ReturnType<typeof parseProspectiveTags>,
): Promise<number> {
  let saved = 0;
  for (const entry of entries) {
    try {
      // For time-based triggers, parse the time string
      let condition = entry.condition;
      if (entry.triggerType === "time") {
        const fireAt = entry.condition.fire_at as string;
        // Try to parse as ISO or relative time
        const parsed = new Date(fireAt);
        if (!isNaN(parsed.getTime())) {
          condition = { fire_at: parsed.toISOString() };
        }
        // else keep as-is (will be parsed by the trigger checker)
      }

      const { error } = await supabase.from("prospective_memory").insert({
        trigger_type: entry.triggerType,
        trigger_condition: condition,
        action: entry.action,
        expires_at: entry.triggerType === "time"
          ? new Date(Date.now() + 30 * 24 * 3600_000).toISOString() // 30 day expiry for time triggers
          : new Date(Date.now() + 90 * 24 * 3600_000).toISOString(), // 90 day expiry for event/context
      });

      if (!error) saved++;
    } catch (err) {
      warn("cognitive", `Failed to save prospective memory: ${err}`);
    }
  }
  return saved;
}

/**
 * Check for triggered prospective memories.
 * Called on every message to check event-based and context-based triggers.
 */
export async function checkProspectiveTriggers(
  supabase: SupabaseClient,
  messageText: string,
  entities: string[] = [],
): Promise<string[]> {
  const triggered: string[] = [];

  try {
    // Get all unfired event and context triggers
    const { data: eventTriggers } = await supabase
      .from("prospective_memory")
      .select("id, trigger_type, trigger_condition, action")
      .eq("fired", false)
      .in("trigger_type", ["event", "context"])
      .or("expires_at.is.null,expires_at.gt." + new Date().toISOString());

    if (!eventTriggers?.length) return triggered;

    for (const trigger of eventTriggers) {
      let shouldFire = false;

      if (trigger.trigger_type === "event") {
        // Check if the message matches the event pattern
        const pattern = trigger.trigger_condition?.pattern;
        if (pattern) {
          try {
            const regex = new RegExp(pattern, "i");
            shouldFire = regex.test(messageText);
          } catch {
            // If pattern isn't valid regex, do substring match
            shouldFire = messageText.toLowerCase().includes(pattern.toLowerCase());
          }
        }
      } else if (trigger.trigger_type === "context") {
        // Check if the topic is being discussed
        const topic = trigger.trigger_condition?.topic;
        if (topic) {
          shouldFire = messageText.toLowerCase().includes(topic.toLowerCase());
          // Also check entity overlap
          const triggerEntities = trigger.trigger_condition?.entities as string[] | undefined;
          if (triggerEntities?.length && entities.length) {
            const overlap = entities.some(e =>
              triggerEntities.some(te => te.toLowerCase() === e.toLowerCase())
            );
            if (overlap) shouldFire = true;
          }
        }
      }

      if (shouldFire) {
        triggered.push(trigger.action);
        // Mark as fired
        await supabase
          .from("prospective_memory")
          .update({ fired: true, fired_at: new Date().toISOString() })
          .eq("id", trigger.id);
      }
    }
  } catch (err) {
    warn("cognitive", `checkProspectiveTriggers failed: ${err}`);
  }

  return triggered;
}

/**
 * Check for due time-based triggers.
 * Called from cron every minute.
 */
export async function checkTimeTriggers(
  supabase: SupabaseClient,
): Promise<Array<{ id: string; action: string }>> {
  try {
    const { data } = await supabase.rpc("get_due_triggers", { check_type: "time" });
    if (!data?.length) return [];

    // Mark all as fired
    for (const trigger of data) {
      await supabase
        .from("prospective_memory")
        .update({ fired: true, fired_at: new Date().toISOString() })
        .eq("id", trigger.id);
    }

    return data.map((d: any) => ({ id: d.id, action: d.action }));
  } catch (err) {
    warn("cognitive", `checkTimeTriggers failed: ${err}`);
    return [];
  }
}

// ============================================================
// CONSOLIDATION ENGINE (Item I)
// ============================================================

/**
 * Full consolidation cycle. Runs nightly as upgrade to simple summarization.
 *
 * Steps:
 * 1. Run standard summarization (existing behavior)
 * 2. Detect and resolve contradictory facts
 * 3. Merge near-duplicate entities in the graph
 * 4. Prune decayed memories (low salience, never accessed, old)
 * 5. Update thread summaries
 * 6. Archive dormant threads
 */
export async function runConsolidation(
  supabase: SupabaseClient,
  summarize: (text: string) => Promise<string>,
): Promise<{
  summariesCreated: number;
  contradictionsResolved: number;
  memoriesPruned: number;
  threadsUpdated: number;
  entitiesMerged: number;
  feedbackConsolidated: number;
  observationsPruned: number;
}> {
  const result = {
    summariesCreated: 0,
    contradictionsResolved: 0,
    memoriesPruned: 0,
    threadsUpdated: 0,
    entitiesMerged: 0,
    feedbackConsolidated: 0,
    observationsPruned: 0,
  };

  // Step 1: Standard summarization (delegate to existing code)
  // This is called separately from cron.ts via runSummarization()

  // Step 2: Detect and resolve contradictory facts
  try {
    const { data: allFacts } = await supabase
      .from("memory")
      .select("id, content, created_at, salience, access_count")
      .eq("type", "fact")
      .eq("historical", false)
      .order("created_at", { ascending: false })
      .limit(100);

    if (allFacts?.length) {
      // Compare each pair of recent facts for contradiction
      for (let i = 0; i < Math.min(allFacts.length, 20); i++) {
        const conflict = await detectContradiction(supabase, allFacts[i].content);
        if (conflict.resolution === "supersede" && conflict.existingId && conflict.existingId !== allFacts[i].id) {
          // Mark the older fact as historical
          await supabase
            .from("memory")
            .update({ historical: true })
            .eq("id", conflict.existingId);
          result.contradictionsResolved++;
          info("consolidation", `Superseded fact ${conflict.existingId}: "${conflict.existingContent?.substring(0, 50)}..."`);
        }
      }
    }
  } catch (err) {
    warn("consolidation", `Contradiction detection failed: ${err}`);
  }

  // Step 3: Prune decayed memories
  try {
    const { data: decayed } = await supabase.rpc("get_decayed_memories", {
      min_age_hours: 168, // 7 days minimum age
      salience_threshold: 0.15,
      max_results: 20,
    });

    if (decayed?.length) {
      for (const mem of decayed) {
        if (mem.decay_score < 0.1) {
          // Very decayed: mark as historical
          await supabase
            .from("memory")
            .update({ historical: true })
            .eq("id", mem.id);
          result.memoriesPruned++;
        }
      }
      if (result.memoriesPruned > 0) {
        info("consolidation", `Pruned ${result.memoriesPruned} decayed memories`);
      }
    }
  } catch (err) {
    warn("consolidation", `Memory pruning failed: ${err}`);
  }

  // Step 4: Update thread summaries
  try {
    const { data: activeThreads } = await supabase
      .from("memory_threads")
      .select("id, title, entry_count")
      .eq("status", "active")
      .order("last_activity", { ascending: false })
      .limit(10);

    if (activeThreads?.length) {
      for (const thread of activeThreads) {
        // Get recent entries in this thread
        const { data: entries } = await supabase
          .from("memory")
          .select("content, created_at")
          .eq("thread_id", thread.id)
          .order("created_at", { ascending: false })
          .limit(10);

        if (entries?.length && entries.length >= 3) {
          const entriesText = entries.map(e => e.content).join("\n");
          const summary = await summarize(
            `Summarize this narrative thread titled "${thread.title}" in 1-2 sentences:\n${entriesText}`
          );

          if (summary) {
            await supabase
              .from("memory_threads")
              .update({ summary, entry_count: entries.length })
              .eq("id", thread.id);
            result.threadsUpdated++;
          }
        }
      }
    }

    // Archive dormant threads (no activity in 14 days)
    const dormantCutoff = new Date();
    dormantCutoff.setDate(dormantCutoff.getDate() - 14);
    await supabase
      .from("memory_threads")
      .update({ status: "dormant" })
      .eq("status", "active")
      .lt("last_activity", dormantCutoff.toISOString());
  } catch (err) {
    warn("consolidation", `Thread update failed: ${err}`);
  }

  // Step 5: Auto-merge near-duplicate entities
  try {
    const { data: similarPairs } = await supabase.rpc("find_similar_entities", {
      similarity_threshold: 0.8,
    });

    if (similarPairs?.length) {
      const { mergeEntities } = await import("./graph.ts");
      const merged = new Set<string>(); // track already-merged IDs

      for (const pair of similarPairs) {
        if (merged.has(pair.entity1_id) || merged.has(pair.entity2_id)) continue;

        // Keep the entity with more edges or the older one as canonical
        const canonical = pair.entity1_id;
        const duplicate = pair.entity2_id;

        const mergeResult = await mergeEntities(supabase, canonical, [duplicate]);
        if (mergeResult.entitiesDeleted > 0) {
          merged.add(duplicate);
          result.entitiesMerged = (result.entitiesMerged || 0) + 1;
          info("consolidation", `Merged entity "${pair.entity2_name}" into "${pair.entity1_name}" (${(pair.similarity * 100).toFixed(0)}% similar)`);
        }
      }
    }
  } catch (err) {
    warn("consolidation", `Entity auto-merge failed: ${err}`);
  }

  // Step 6: Consolidate feedback patterns into durable rules
  try {
    const { consolidateFeedback } = await import("./feedback.ts");
    const rulesCreated = await consolidateFeedback(supabase, summarize);
    result.feedbackConsolidated = rulesCreated;
    if (rulesCreated > 0) {
      info("consolidation", `Created ${rulesCreated} feedback rules`);
    }
  } catch (err) {
    warn("consolidation", `Feedback consolidation failed: ${err}`);
  }

  // Step 7: Prune superseded observations
  try {
    const { pruneObservations } = await import("./observations.ts");
    const obsResult = await pruneObservations(supabase);
    result.observationsPruned = obsResult.pruned;
    if (obsResult.pruned > 0) {
      info("consolidation", `Pruned ${obsResult.pruned} superseded observations`);
    }
  } catch (err) {
    warn("consolidation", `Observation pruning failed: ${err}`);
  }

  return result;
}
