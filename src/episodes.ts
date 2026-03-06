/**
 * Atlas -- Episodic Memory Module
 *
 * Records complete task/conversation/decision episodes with
 * outcomes, lessons learned, and linkages to existing memory.
 *
 * Two layers:
 *  1. In-memory tracker: ActiveEpisode per session, ephemeral until closed.
 *  2. Persistence: Closed episodes are scored, embedded, and stored in
 *     the episodes table for future retrieval via hybrid search.
 *
 * Lifecycle:
 *  detectEpisodeStart -> startEpisode -> addEpisodeAction (repeated)
 *  -> shouldCloseEpisode -> closeAndSaveEpisode / autoCloseEpisode
 *
 * Retrieval:
 *  getRelevantEpisodes (context injection) / searchEpisodes (raw query)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn } from "./logger.ts";
import { scoreSalience, extractEntities } from "./cognitive.ts";

// ============================================================
// CONSTANTS (will move to constants.ts during integration)
// ============================================================

const EPISODE_TIMEOUT_MS = 15 * 60 * 1000;    // 15 minutes inactivity
const EPISODE_MAX_ACTIONS = 50;                 // cap actions per episode
const EPISODE_MIN_ACTIONS = 2;                  // don't persist trivial episodes
const EPISODE_ACTION_MAX_LEN = 200;             // truncate action/result text
const EPISODE_TRIGGER_MAX_LEN = 100;            // trigger text cap
const EPISODE_MAX_RESULTS = 3;                  // max episodes in context
const EPISODE_MAX_CONTEXT_CHARS = 2000;         // total chars for context block
const EPISODE_COMPLETION_WORDS = /\b(done|thanks|thank you|that's all|perfect|great|good|finished|all set)\b/i;

// Backoff: skip embedding calls for 5 min after a failure
let episodeEmbedCooldownUntil = 0;
const EPISODE_TASK_LANGUAGE = /\b(draft|build|create|write|plan|analyze|review|fix|debug|implement|design|research|update|change|add|remove|delete|edit|refactor)\b/i;
const EPISODE_REQUEST_LANGUAGE = /\b(help me|I need|can you|could you|please|let's|show me|tell me about)\b/i;
const EPISODE_DECISION_WORDS = /\b(decide|choose|should we|option|either|or should|which one|pick|select|go with)\b/i;
const EPISODE_INCIDENT_WORDS = /\b(broken|error|down|issue|bug|crash|fail|wrong|not working|outage)\b/i;
const TOPIC_SHIFT_THRESHOLD = 0.3;              // word overlap below this = topic shift

// ============================================================
// TYPES
// ============================================================

export type EpisodeType = "task" | "conversation" | "decision" | "incident" | "learning";

export interface EpisodeAction {
  step: number;
  action: string;
  result: string;
  timestamp: string;
}

export interface ActiveEpisode {
  trigger: string;
  episodeType: EpisodeType;
  actions: EpisodeAction[];
  participantNames: string[];
  startedAt: string;
  turnCount: number;
  firstMessageText: string;
}

export interface EpisodeRecord {
  id: string;
  trigger: string;
  episodeType: EpisodeType;
  outcome: string | null;
  outcomeValence: string;
  lessons: string[];
  similarity: number;
  turnCount: number;
  durationSeconds: number | null;
  startedAt: string;
  endedAt: string | null;
}

// ============================================================
// IN-MEMORY TRACKER
// ============================================================

const activeEpisodes: Map<string, ActiveEpisode> = new Map();

/**
 * Start tracking a new episode for a session.
 * Replaces any existing active episode (caller should close it first).
 */
export function startEpisode(
  sessionKey: string,
  trigger: string,
  episodeType: EpisodeType,
  firstMessageText: string,
): void {
  const episode: ActiveEpisode = {
    trigger: trigger.substring(0, EPISODE_TRIGGER_MAX_LEN),
    episodeType,
    actions: [],
    participantNames: [],
    startedAt: new Date().toISOString(),
    turnCount: 0,
    firstMessageText,
  };
  activeEpisodes.set(sessionKey, episode);
  info("episodes", `Started ${episodeType} episode for ${sessionKey}: "${episode.trigger}"`);
}

/**
 * Record an action step in the active episode.
 * Caps at EPISODE_MAX_ACTIONS. Truncates text to EPISODE_ACTION_MAX_LEN.
 */
export function addEpisodeAction(sessionKey: string, action: string, result: string): void {
  const episode = activeEpisodes.get(sessionKey);
  if (!episode) return;

  if (episode.actions.length >= EPISODE_MAX_ACTIONS) {
    return; // silently drop, episode is already very long
  }

  episode.actions.push({
    step: episode.actions.length + 1,
    action: action.substring(0, EPISODE_ACTION_MAX_LEN),
    result: result.substring(0, EPISODE_ACTION_MAX_LEN),
    timestamp: new Date().toISOString(),
  });

  episode.turnCount++;
}

/** Get the active episode for a session, or null. */
export function getActiveEpisode(sessionKey: string): ActiveEpisode | null {
  return activeEpisodes.get(sessionKey) || null;
}

/**
 * Heuristic check: should the current episode be closed?
 *
 * Signals:
 *  1. Completion language ("done", "thanks", etc.)
 *  2. Topic shift (low word overlap with trigger)
 *  3. Inactivity timeout
 *  4. Never close an episode with 0 actions (just started)
 */
export function shouldCloseEpisode(
  sessionKey: string,
  currentMessage: string,
  timeSinceLastAction: number,
): { shouldClose: boolean; reason: string } {
  const episode = activeEpisodes.get(sessionKey);
  if (!episode) {
    return { shouldClose: false, reason: "no active episode" };
  }

  // Never close an episode that just started with no actions
  if (episode.actions.length === 0) {
    return { shouldClose: false, reason: "episode has no actions yet" };
  }

  // Check completion signals
  if (EPISODE_COMPLETION_WORDS.test(currentMessage)) {
    return { shouldClose: true, reason: "completion language detected" };
  }

  // Check topic shift via word overlap
  const triggerWords = significantWords(episode.trigger);
  const messageWords = significantWords(currentMessage);
  if (triggerWords.size > 0 && messageWords.size > 0) {
    const overlap = wordOverlap(triggerWords, messageWords);
    if (overlap < TOPIC_SHIFT_THRESHOLD) {
      return { shouldClose: true, reason: `topic shift (${(overlap * 100).toFixed(0)}% overlap)` };
    }
  }

  // Check inactivity timeout
  if (timeSinceLastAction > EPISODE_TIMEOUT_MS) {
    return { shouldClose: true, reason: "inactivity timeout" };
  }

  return { shouldClose: false, reason: "episode still active" };
}

// ============================================================
// EPISODE DETECTION
// ============================================================

/**
 * Detect whether a new message should start an episode.
 * Returns the trigger text (first 100 chars) or null if no episode should start.
 */
export function detectEpisodeStart(
  sessionKey: string,
  messageText: string,
  intent: Record<string, boolean>,
): string | null {
  // Don't start if there's already an active episode
  if (activeEpisodes.has(sessionKey)) return null;

  // Don't start on casual/greeting messages
  if (intent.casual) return null;

  // Check for task language
  if (EPISODE_TASK_LANGUAGE.test(messageText)) {
    return messageText.substring(0, EPISODE_TRIGGER_MAX_LEN);
  }

  // Check for explicit requests
  if (EPISODE_REQUEST_LANGUAGE.test(messageText)) {
    return messageText.substring(0, EPISODE_TRIGGER_MAX_LEN);
  }

  // Check for known substantive intents
  if (intent.coding || intent.marketing || intent.financial || intent.pipeline) {
    return messageText.substring(0, EPISODE_TRIGGER_MAX_LEN);
  }

  return null;
}

/**
 * Infer the episode type from intent flags and message text.
 */
export function inferEpisodeType(intent: Record<string, boolean>, messageText: string): EpisodeType {
  // Coding intent -> task
  if (intent.coding) return "task";

  // Business intents -> task
  if (intent.marketing || intent.financial || intent.pipeline) return "task";

  // Decision language
  if (EPISODE_DECISION_WORDS.test(messageText)) return "decision";

  // Incident language
  if (EPISODE_INCIDENT_WORDS.test(messageText)) return "incident";

  // Default
  return "conversation";
}

// ============================================================
// PERSISTENCE
// ============================================================

/**
 * Close the active episode and persist it to the database.
 * Returns the episode ID or null if the episode was discarded.
 *
 * Discards episodes with fewer than EPISODE_MIN_ACTIONS actions
 * (not enough substance to be worth remembering).
 */
export async function closeAndSaveEpisode(
  supabase: SupabaseClient,
  sessionKey: string,
  outcome: string,
  lessons: string[],
  outcomeValence: string = "neutral",
): Promise<string | null> {
  const episode = activeEpisodes.get(sessionKey);
  if (!episode) {
    warn("episodes", `closeAndSaveEpisode: no active episode for ${sessionKey}`);
    return null;
  }

  // Remove from in-memory map immediately (regardless of save outcome)
  activeEpisodes.delete(sessionKey);

  // Discard trivial episodes
  if (episode.actions.length < EPISODE_MIN_ACTIONS) {
    info("episodes", `Discarded trivial episode for ${sessionKey} (${episode.actions.length} actions)`);
    return null;
  }

  try {
    // Calculate duration
    const startedAt = new Date(episode.startedAt);
    const endedAt = new Date();
    const durationSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

    // Extract participant names from action text
    const allActionText = episode.actions.map(a => `${a.action} ${a.result}`).join(" ");
    const entities = extractEntities(allActionText + " " + episode.trigger + " " + outcome);
    const participantNames = [
      ...new Set([
        ...episode.participantNames,
        ...entities.filter(e => e.type === "person").map(e => e.name),
      ]),
    ];

    // Resolve participant names to entity IDs
    const participantEntityIds: string[] = [];
    for (const name of participantNames) {
      try {
        const { data: match } = await supabase
          .from("memory_entities")
          .select("id")
          .ilike("name", name)
          .limit(1);
        if (match?.length) {
          participantEntityIds.push(match[0].id);
        }
      } catch {
        // Non-critical, continue
      }
    }

    // Score salience on trigger + outcome
    const salienceText = `${episode.trigger} ${outcome}`;
    const salience = scoreSalience(salienceText, {
      containsNewInfo: true,
      mentionsEntities: participantNames.length > 0,
    });

    // Generate embedding via Edge Function
    let embedding: number[] | null = null;
    try {
      const embedText = `${episode.trigger} ${outcome} ${lessons.join(" ")}`.substring(0, 1000);
      const { data: embedData, error: embedError } = await supabase.functions.invoke("embed", {
        body: { text: embedText },
      });
      if (!embedError && embedData?.embedding) {
        embedding = embedData.embedding;
      }
    } catch (err) {
      warn("episodes", `Embedding generation failed: ${err}`);
    }

    // Insert into episodes table
    const { data: inserted, error: insertError } = await supabase
      .from("episodes")
      .insert({
        trigger: episode.trigger,
        episode_type: episode.episodeType,
        actions_taken: episode.actions,
        outcome,
        outcome_valence: outcomeValence,
        lessons,
        participant_entity_ids: participantEntityIds,
        started_at: episode.startedAt,
        ended_at: endedAt.toISOString(),
        duration_seconds: durationSeconds,
        turn_count: episode.turnCount,
        salience: salience.overall,
        embedding,
        metadata: { participant_names: participantNames },
      })
      .select("id")
      .single();

    if (insertError) {
      warn("episodes", `Failed to save episode: ${insertError.message}`);
      return null;
    }

    const episodeId = inserted?.id || null;
    info("episodes", `Saved ${episode.episodeType} episode ${episodeId} for ${sessionKey} (${episode.actions.length} actions, ${durationSeconds}s, salience=${salience.overall.toFixed(2)})`);
    return episodeId;
  } catch (err) {
    warn("episodes", `closeAndSaveEpisode exception: ${err}`);
    return null;
  }
}

/**
 * Auto-close an episode by generating outcome + lessons via summarization.
 * Used for timeout closures and topic-shift closures where the user
 * didn't explicitly state the outcome.
 */
export async function autoCloseEpisode(
  supabase: SupabaseClient,
  sessionKey: string,
  summarize: (prompt: string) => Promise<string>,
  reason: string,
): Promise<string | null> {
  const episode = activeEpisodes.get(sessionKey);
  if (!episode) return null;

  // Build summarization prompt from episode data
  const actionsText = episode.actions
    .map(a => `Step ${a.step}: ${a.action} -> ${a.result}`)
    .join("\n");

  const prompt =
    `Summarize this episode concisely.\n` +
    `Trigger: ${episode.trigger}\n` +
    `Type: ${episode.episodeType}\n` +
    `Actions:\n${actionsText}\n` +
    `Close reason: ${reason}\n\n` +
    `Respond in exactly this format:\n` +
    `Outcome: <1 sentence summary of what happened>\n` +
    `Lessons:\n- <lesson 1>\n- <lesson 2>`;

  try {
    const response = await summarize(prompt);

    // Parse the response
    const outcomeMatch = response.match(/Outcome:\s*(.+?)(?:\n|$)/i);
    const outcome = outcomeMatch?.[1]?.trim() || `Episode closed: ${reason}`;

    const lessons: string[] = [];
    const lessonMatches = response.matchAll(/^-\s*(.+)$/gm);
    for (const match of lessonMatches) {
      const lesson = match[1].trim();
      if (lesson) lessons.push(lesson);
    }

    // Infer valence from outcome text
    const valence = inferValence(outcome);

    info("episodes", `Auto-closing episode for ${sessionKey}: ${reason}`);
    return await closeAndSaveEpisode(supabase, sessionKey, outcome, lessons, valence);
  } catch (err) {
    warn("episodes", `autoCloseEpisode summarization failed: ${err}`);
    // Fall back to a basic close
    return await closeAndSaveEpisode(
      supabase,
      sessionKey,
      `Episode closed: ${reason}`,
      [],
      "neutral",
    );
  }
}

// ============================================================
// RETRIEVAL
// ============================================================

/**
 * Get relevant past episodes for context injection into Claude's prompt.
 * Uses hybrid search (vector + FTS) via the search_episodes RPC.
 * Returns formatted text block, max EPISODE_MAX_RESULTS episodes,
 * max EPISODE_MAX_CONTEXT_CHARS total.
 */
export async function getRelevantEpisodes(
  supabase: SupabaseClient,
  currentContext: string,
  options: {
    episodeType?: EpisodeType;
    limit?: number;
    minSalience?: number;
  } = {},
): Promise<string> {
  const { episodeType, limit = EPISODE_MAX_RESULTS, minSalience = 0.0 } = options;

  try {
    // Backoff: skip embedding calls for 5 min after a failure (prevents hammering a down Edge Function)
    if (episodeEmbedCooldownUntil > Date.now()) {
      return "";
    }

    // Generate embedding for current context
    const { data: embedData, error: embedError } = await supabase.functions.invoke("embed", {
      body: { text: currentContext.substring(0, 500) },
    });

    if (embedError || !embedData?.embedding) {
      warn("episodes", `Embedding for episode search failed: ${embedError}`);
      episodeEmbedCooldownUntil = Date.now() + 5 * 60_000; // back off 5 min
      return "";
    }

    // Call search_episodes RPC
    const { data: episodes, error: searchError } = await supabase.rpc("search_episodes", {
      query_embedding: embedData.embedding,
      query_text: currentContext.substring(0, 200),
      match_count: limit,
      type_filter: episodeType || null,
      min_salience: minSalience,
    });

    if (searchError || !episodes?.length) {
      if (searchError) warn("episodes", `search_episodes RPC failed: ${searchError.message}`);
      return "";
    }

    // Record access for reconsolidation (fire-and-forget)
    const episodeIds = episodes.map((e: any) => e.id);
    supabase.rpc("record_episode_access", { episode_ids: episodeIds })
      .then(() => {})
      .catch(() => {});

    // Format episodes for context
    let output = "RELEVANT PAST EPISODES:\n\n";
    let totalChars = output.length;

    for (const ep of episodes) {
      const lessonsText = ep.lessons?.length
        ? ep.lessons.join("; ")
        : "none recorded";

      const durationText = formatDuration(ep.turn_count, ep.duration_seconds);

      const block =
        `Episode: ${ep.trigger}\n` +
        `Outcome: ${ep.outcome || "unknown"} (${ep.outcome_valence})\n` +
        `Lessons: ${lessonsText}\n` +
        `Duration: ${durationText}\n` +
        `---\n`;

      if (totalChars + block.length > EPISODE_MAX_CONTEXT_CHARS) break;
      output += block;
      totalChars += block.length;
    }

    return output.trim();
  } catch (err) {
    warn("episodes", `getRelevantEpisodes failed: ${err}`);
    return "";
  }
}

/**
 * Raw episode search. Returns structured EpisodeRecord array.
 */
export async function searchEpisodes(
  supabase: SupabaseClient,
  query: string,
  limit: number = 5,
): Promise<EpisodeRecord[]> {
  try {
    // Generate embedding
    const { data: embedData, error: embedError } = await supabase.functions.invoke("embed", {
      body: { text: query.substring(0, 500) },
    });

    if (embedError || !embedData?.embedding) {
      warn("episodes", `Embedding for searchEpisodes failed: ${embedError}`);
      return [];
    }

    const { data, error } = await supabase.rpc("search_episodes", {
      query_embedding: embedData.embedding,
      query_text: query.substring(0, 200),
      match_count: limit,
      type_filter: null,
      min_salience: 0.0,
    });

    if (error || !data?.length) {
      if (error) warn("episodes", `searchEpisodes RPC error: ${error.message}`);
      return [];
    }

    return data.map((row: any) => ({
      id: row.id,
      trigger: row.trigger,
      episodeType: row.episode_type,
      outcome: row.outcome,
      outcomeValence: row.outcome_valence,
      lessons: row.lessons || [],
      similarity: row.similarity,
      turnCount: row.turn_count,
      durationSeconds: row.duration_seconds,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    }));
  } catch (err) {
    warn("episodes", `searchEpisodes exception: ${err}`);
    return [];
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Extract significant words (>3 chars, lowercased) from text.
 * Used for topic-shift detection via word overlap.
 */
function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 3),
  );
}

/**
 * Calculate word overlap ratio between two word sets.
 * Returns 0-1 (1 = perfect overlap).
 */
function wordOverlap(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const smaller = Math.min(setA.size, setB.size);
  return intersection / smaller;
}

/**
 * Infer outcome valence from outcome text.
 * Simple heuristic, not a full sentiment analysis.
 */
function inferValence(outcome: string): string {
  const lower = outcome.toLowerCase();
  if (/\b(success|completed|fixed|resolved|done|great|improved|working)\b/.test(lower)) return "positive";
  if (/\b(failed|error|broken|stuck|issue|problem|unable|couldn't)\b/.test(lower)) return "negative";
  if (/\b(partial|some|mixed|trade-?off|compromise)\b/.test(lower)) return "mixed";
  return "neutral";
}

/**
 * Format duration for human-readable display.
 */
function formatDuration(turnCount: number | null, durationSeconds: number | null): string {
  const parts: string[] = [];
  if (turnCount != null) parts.push(`${turnCount} turns`);
  if (durationSeconds != null) {
    if (durationSeconds < 60) {
      parts.push(`${durationSeconds}s`);
    } else {
      parts.push(`${Math.round(durationSeconds / 60)} minutes`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "unknown";
}
