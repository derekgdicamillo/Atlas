/**
 * Atlas -- Feedback Loop Module
 *
 * Detects implicit and explicit feedback from user messages,
 * stores corrections for future retrieval, and consolidates
 * recurring patterns into learned preferences.
 *
 * Cycle:
 * 1. Detection -- regex-based signal extraction from user messages
 * 2. Storage   -- persist feedback with embeddings for hybrid search
 * 3. Retrieval -- surface relevant past corrections during prompt building
 * 4. Consolidation -- nightly pattern detection -> preference rules
 *
 * DB schema: db/migrations/007_feedback_loop.sql
 * RPCs: search_feedback, get_feedback_patterns
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn } from "./logger.ts";
import { invalidateCache } from "./cognitive.ts";

// ============================================================
// TYPES
// ============================================================

export type FeedbackOutcome = "positive" | "negative" | "correction";
export type FeedbackCategory = "tone" | "accuracy" | "format" | "strategy" | "content" | "behavior" | "delegation" | "general";

export interface FeedbackSignal {
  outcome: FeedbackOutcome;
  category: FeedbackCategory;
  confidence: number;
  correctionText?: string;
}

export interface FeedbackEntry {
  id: string;
  taskType: string;
  category: FeedbackCategory;
  outcome: FeedbackOutcome;
  correctionText: string | null;
  originalOutput: string | null;
  contextSummary: string | null;
  similarity: number;
  createdAt: string;
}

// ============================================================
// CONSTANTS
// ============================================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = "text-embedding-3-small";

// Detection regex patterns
const POSITIVE_RE = /\b(perfect|exactly|nailed it|love it|that's? (?:it|right|correct)|yes[!.]|great|nice|good job|well done|spot on|bingo)\b/i;
const POSITIVE_EMOJI_RE = /💯|👍|✅/;
const NEGATIVE_RE = /\b(wrong|incorrect|no(?:\s|,|\.)|that's? not|not (?:what|how|right)|too (?:formal|casual|long|short|wordy|brief|clinical|vague)|don't|shouldn't|stop|never do that|bad|terrible|nope)\b/i;
const CORRECTION_RE = /\b(instead|rather|should (?:be|have|say)|try|more like|what I (?:meant|want)|let me rephrase|actually|I (?:meant|want|need)|change (?:it|that|this) to)\b/i;

// Category markers
const TONE_RE = /\b(too (?:formal|casual|wordy|brief|clinical|stiff|friendly)|tone|voice|sound(?:s|ing)?)\b/i;
const FORMAT_RE = /\b(format|structure|layout|bullet|paragraph|list|heading|section|length|shorter|longer)\b/i;
const ACCURACY_RE = /\b(wrong|incorrect|inaccurate|false|mistake|error|factual|fact)\b/i;

// ============================================================
// 1. DETECTION
// ============================================================

/**
 * Detect feedback signals in a user message relative to the previous response.
 * Returns null if no feedback signal is detected.
 */
export function detectFeedback(
  userMessage: string,
  previousResponse: string,
  recentTurns: Array<{ role: string; content: string }>,
): FeedbackSignal | null {
  const msg = userMessage.trim();
  if (!msg || !previousResponse) return null;

  // Check for re-ask: >60% word overlap with previous user message
  const prevUserMsg = [...recentTurns].reverse().find(
    (t) => t.role === "user" && t.content !== msg,
  );
  const isReask = prevUserMsg ? computeWordOverlap(msg, prevUserMsg.content) > 0.6 : false;

  // Score each outcome
  const isPositive = POSITIVE_RE.test(msg) || POSITIVE_EMOJI_RE.test(msg);
  const isNegative = NEGATIVE_RE.test(msg) || isReask;
  const isCorrection = CORRECTION_RE.test(msg);

  // Determine outcome (correction > negative > positive)
  let outcome: FeedbackOutcome | null = null;
  let confidence = 0;

  if (isCorrection) {
    outcome = "correction";
    confidence = 0.85;
    if (isNegative) confidence = 0.9; // correction + negative = very confident
  } else if (isNegative) {
    outcome = "negative";
    confidence = isReask ? 0.7 : 0.75;
  } else if (isPositive) {
    outcome = "positive";
    confidence = 0.7;
  }

  if (!outcome) return null;

  const category = classifyFeedbackCategory(msg, previousResponse);

  return {
    outcome,
    category,
    confidence,
    correctionText: outcome === "correction" || outcome === "negative" ? msg : undefined,
  };
}

/**
 * Classify the feedback into a category based on content markers.
 */
export function classifyFeedbackCategory(
  userMessage: string,
  previousResponse: string,
): FeedbackCategory {
  const combined = `${userMessage} ${previousResponse}`;

  if (TONE_RE.test(userMessage)) return "tone";
  if (FORMAT_RE.test(userMessage)) return "format";
  if (ACCURACY_RE.test(userMessage)) return "accuracy";

  // Strategy: mentions approach, plan, recommendation
  if (/\b(strategy|approach|plan|recommendation|suggest|idea|proposal)\b/i.test(userMessage)) return "strategy";

  // Content: mentions writing, copy, text, message, post
  if (/\b(writing|copy|text|message|post|caption|email|draft)\b/i.test(combined)) return "content";

  // Behavior: mentions how the bot acts
  if (/\b(behavior|behavio?ur|act|respond|do that|stop doing|don't do)\b/i.test(userMessage)) return "behavior";

  // Delegation: mentions tasks, subagents, code tasks
  if (/\b(task|delegate|subagent|code.?task|research)\b/i.test(userMessage)) return "delegation";

  return "general";
}

/**
 * Infer a task type string from the current intent flags.
 * Used to tag feedback with what kind of task was happening.
 */
export function inferTaskType(intent: Record<string, boolean>): string {
  if (intent.coding) return "coding";
  if (intent.marketing) return "marketing";
  if (intent.financial) return "financial";
  if (intent.pipeline) return "pipeline";
  if (intent.google) return "google";
  if (intent.reputation) return "reputation";
  if (intent.analytics) return "analytics";
  if (intent.skool) return "skool";
  if (intent.website) return "website";
  if (intent.ghl) return "ghl";
  if (intent.casual) return "casual";
  return "general";
}

// ============================================================
// 2. STORAGE
// ============================================================

/**
 * Persist a feedback signal to the database.
 * Embedding is generated async via DB webhook (same as memory table).
 * Returns the feedback row ID, or null on failure.
 */
export async function saveFeedback(
  supabase: SupabaseClient,
  signal: FeedbackSignal,
  context: {
    originalOutput: string;
    feedbackMessage: string;
    taskType: string;
    contextSummary: string;
  },
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("feedback")
      .insert({
        task_type: context.taskType,
        category: signal.category,
        outcome: signal.outcome,
        correction_text: signal.correctionText || null,
        original_output: context.originalOutput.substring(0, 2000), // cap stored output
        feedback_message: context.feedbackMessage.substring(0, 1000),
        context_summary: context.contextSummary.substring(0, 500),
        detection_confidence: signal.confidence,
        metadata: {},
      })
      .select("id")
      .single();

    if (error) {
      warn("feedback", `saveFeedback insert error: ${error.message}`);
      return null;
    }

    // Invalidate any cached context so next prompt build picks up new feedback
    invalidateCache("feedback");

    info("feedback", `Saved ${signal.outcome} feedback [${signal.category}] conf=${signal.confidence.toFixed(2)} task=${context.taskType}`);
    return data?.id || null;
  } catch (err) {
    warn("feedback", `saveFeedback exception: ${err}`);
    return null;
  }
}

// ============================================================
// 3. RETRIEVAL
// ============================================================

/**
 * Get formatted lessons learned from past corrections, suitable for
 * injection into Claude's system prompt. Uses hybrid search (vector + FTS)
 * via the search_feedback RPC.
 *
 * Returns empty string if no relevant feedback found or on error.
 * Max 5 results, max 2000 chars output.
 */
export async function getLessonsLearned(
  supabase: SupabaseClient,
  currentContext: string,
  taskType?: string,
): Promise<string> {
  try {
    const embedding = await generateEmbedding(currentContext);
    if (!embedding) return "";

    const { data, error } = await supabase.rpc("search_feedback", {
      query_embedding: embedding,
      query_text: currentContext,
      match_count: 5,
      category_filter: null,
      min_confidence: 0.6,
    });

    if (error) {
      warn("feedback", `search_feedback RPC error: ${error.message}`);
      return "";
    }

    if (!data?.length) return "";

    // Filter by task type if provided (post-filter since RPC doesn't support it)
    let results = data as FeedbackRPCRow[];
    if (taskType) {
      const typed = results.filter((r) => r.task_type === taskType);
      // Fall back to all results if no task-specific ones found
      if (typed.length > 0) results = typed;
    }

    // Format as lessons
    const lines: string[] = [];
    let totalLen = 0;

    for (const row of results.slice(0, 5)) {
      if (!row.correction_text) continue;

      const ctx = row.context_summary ? ` (${row.context_summary})` : "";
      const line = `- [${row.category}] ${row.correction_text}${ctx}`;

      if (totalLen + line.length > 2000) break;
      lines.push(line);
      totalLen += line.length;
    }

    if (lines.length === 0) return "";

    return "LESSONS LEARNED (from past corrections):\n" + lines.join("\n");
  } catch (err) {
    warn("feedback", `getLessonsLearned exception: ${err}`);
    return "";
  }
}

/**
 * Search feedback entries with optional filters.
 * Returns structured FeedbackEntry objects.
 */
export async function searchFeedback(
  supabase: SupabaseClient,
  query: string,
  options: { category?: FeedbackCategory; limit?: number; minConfidence?: number } = {},
): Promise<FeedbackEntry[]> {
  const { category, limit = 10, minConfidence = 0.5 } = options;

  try {
    const embedding = await generateEmbedding(query);
    if (!embedding) return [];

    const { data, error } = await supabase.rpc("search_feedback", {
      query_embedding: embedding,
      query_text: query,
      match_count: limit,
      category_filter: category || null,
      min_confidence: minConfidence,
    });

    if (error) {
      warn("feedback", `searchFeedback RPC error: ${error.message}`);
      return [];
    }

    if (!data?.length) return [];

    return (data as FeedbackRPCRow[]).map(mapRPCToEntry);
  } catch (err) {
    warn("feedback", `searchFeedback exception: ${err}`);
    return [];
  }
}

// ============================================================
// 4. CONSOLIDATION
// ============================================================

/**
 * Detect recurring feedback patterns and generate preference rules.
 * Called from the nightly consolidation cycle (runConsolidation).
 *
 * Steps:
 * 1. Query get_feedback_patterns for groups with 3+ occurrences
 * 2. For each pattern, use summarize callback to generate a rule
 * 3. Insert rule as a memory fact (type=preference, salience=0.85)
 * 4. Mark contributing feedback as consolidated
 *
 * Returns the number of rules created.
 */
export async function consolidateFeedback(
  supabase: SupabaseClient,
  summarize: (prompt: string) => Promise<string>,
): Promise<number> {
  let rulesCreated = 0;

  try {
    const { data: patterns, error } = await supabase.rpc("get_feedback_patterns", {
      min_occurrences: 3,
      max_age_days: 90,
    });

    if (error) {
      warn("feedback", `get_feedback_patterns RPC error: ${error.message}`);
      return 0;
    }

    if (!patterns?.length) {
      info("feedback", "No recurring feedback patterns found for consolidation");
      return 0;
    }

    for (const pattern of patterns) {
      const corrections = pattern.sample_corrections as string[] | null;
      if (!corrections?.length) continue;

      // Generate a rule from the sample corrections
      const prompt = [
        `The user has given the same type of feedback ${pattern.occurrence_count} times.`,
        `Category: ${pattern.category}. Task type: ${pattern.task_type}. Outcome: ${pattern.outcome}.`,
        `Sample corrections from the user:`,
        ...corrections.slice(0, 5).map((c: string, i: number) => `${i + 1}. ${c}`),
        ``,
        `Distill this into one concise rule or preference (1-2 sentences) that the assistant should follow going forward.`,
        `Write the rule in second person ("You should..." or "Always..." or "Never...").`,
      ].join("\n");

      try {
        const rule = await summarize(prompt);
        if (!rule || rule.length < 10) continue;

        // Insert as a preference memory
        const { error: insertError } = await supabase.from("memory").insert({
          type: "preference",
          content: rule,
          salience: 0.85,
          confidence: 0.9,
          source: "feedback_consolidation",
          metadata: {
            feedback_category: pattern.category,
            feedback_task_type: pattern.task_type,
            feedback_outcome: pattern.outcome,
            occurrence_count: pattern.occurrence_count,
          },
        });

        if (insertError) {
          warn("feedback", `Failed to insert preference rule: ${insertError.message}`);
          continue;
        }

        // Mark all unconsolidated feedback in this group as consolidated
        await supabase
          .from("feedback")
          .update({ consolidated: true })
          .eq("category", pattern.category)
          .eq("task_type", pattern.task_type)
          .eq("outcome", pattern.outcome)
          .eq("consolidated", false);

        rulesCreated++;
        info("feedback", `Created preference rule from ${pattern.occurrence_count}x ${pattern.category}/${pattern.task_type} feedback: "${rule.substring(0, 80)}..."`);
      } catch (err) {
        warn("feedback", `Failed to consolidate pattern ${pattern.category}/${pattern.task_type}: ${err}`);
      }
    }

    // Invalidate caches so new preferences are picked up
    if (rulesCreated > 0) {
      invalidateCache("memory", "feedback");
    }
  } catch (err) {
    warn("feedback", `consolidateFeedback exception: ${err}`);
  }

  return rulesCreated;
}

// ============================================================
// INTERNAL HELPERS
// ============================================================

/** Row shape returned by the search_feedback RPC. */
interface FeedbackRPCRow {
  id: string;
  task_type: string;
  category: string;
  outcome: string;
  correction_text: string | null;
  original_output: string | null;
  context_summary: string | null;
  detection_confidence: number;
  similarity: number;
  created_at: string;
}

/** Map RPC row to public FeedbackEntry. */
function mapRPCToEntry(row: FeedbackRPCRow): FeedbackEntry {
  return {
    id: row.id,
    taskType: row.task_type,
    category: row.category as FeedbackCategory,
    outcome: row.outcome as FeedbackOutcome,
    correctionText: row.correction_text,
    originalOutput: row.original_output,
    contextSummary: row.context_summary,
    similarity: row.similarity,
    createdAt: row.created_at,
  };
}

/**
 * Compute word overlap ratio between two messages.
 * Only considers words longer than 3 characters.
 * Returns 0-1 (fraction of msg1 words found in msg2).
 */
function computeWordOverlap(msg1: string, msg2: string): number {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 3);

  const words1 = normalize(msg1);
  const words2Set = new Set(normalize(msg2));

  if (words1.length === 0) return 0;

  const overlap = words1.filter((w) => words2Set.has(w)).length;
  return overlap / words1.length;
}

/**
 * Generate an embedding vector via OpenAI text-embedding-3-small.
 * The relay has OPENAI_API_KEY available (same pattern as tts.ts).
 * Returns null on failure (caller should degrade gracefully).
 */
async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY) {
    warn("feedback", "OPENAI_API_KEY not set, cannot generate embedding");
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
        input: text.substring(0, 8000), // cap input to avoid token limits
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      warn("feedback", `OpenAI embedding error: ${err}`);
      return null;
    }

    const { data } = await response.json();
    return data?.[0]?.embedding || null;
  } catch (err) {
    warn("feedback", `generateEmbedding exception: ${err}`);
    return null;
  }
}
