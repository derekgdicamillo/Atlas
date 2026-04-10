/**
 * Atlas — Cognitive Memory Architecture: Anticipatory Context Loading
 *
 * Predicts what context will be needed BEFORE each turn based on:
 *   - Time of day / day of week patterns
 *   - Topic continuity (same topic = same context)
 *   - Working memory registers (current state signals)
 *   - User frustration signals (load everything)
 *   - Restart recovery (load recent facts + episodes)
 *
 * Pure heuristics, no LLM. <10ms per prediction.
 * Learns from context misses via Darwin loop feedback.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn } from "./logger.ts";
import { CMA_ENABLED } from "./constants.ts";
import type { WorkingMemory } from "./working-memory.ts";

// ============================================================
// TYPES
// ============================================================

export interface ContextPrediction {
  source: "semantic" | "episodic" | "graph" | "facts" | "journal";
  query: string;
  confidence: number;
  reason: string;
}

export interface ContextMiss {
  topic: string;
  whatWasNeeded: string;
  whatWasLoaded: string | null;
}

interface MessageIntent {
  [key: string]: boolean;
}

// ============================================================
// FRUSTRATION DETECTION
// ============================================================

const FRUSTRATION_PATTERNS = [
  /no,?\s*(I|that's|not|wrong)/i,
  /I (already|just) (told|said|mentioned)/i,
  /why (are|did|do) you/i,
  /that's not what I/i,
  /\?\?{2,}/,
  /!{3,}/,
  /stop\s+(doing|asking|saying)/i,
  /I said\s/i,
  /can you (just|please)\s+(listen|read|look)/i,
];

export function detectFrustration(message: string): boolean {
  return FRUSTRATION_PATTERNS.some(p => p.test(message));
}

// ============================================================
// CORRECTION DETECTION
// ============================================================

const CORRECTION_PATTERNS = [
  /no,?\s*(it's|that's|the)\s/i,
  /actually,?\s/i,
  /not\s+\w+,?\s+(it's|but)\s/i,
  /wrong[.,]?\s/i,
  /I meant\s/i,
  /correct(ion|ed)?:\s/i,
];

export function detectCorrection(message: string): boolean {
  return CORRECTION_PATTERNS.some(p => p.test(message));
}

// ============================================================
// CONTEXT PREDICTION
// ============================================================

/**
 * Predict what context will be needed for the upcoming turn.
 * Pure heuristics, no LLM, <10ms.
 */
export function predictContext(
  userMessage: string,
  wm: WorkingMemory | null,
  currentIntent: MessageIntent,
  previousIntent: MessageIntent | null,
  options?: {
    isFirstTurnAfterRestart?: boolean;
    timeOfDay?: number;
    dayOfWeek?: number;
  },
): ContextPrediction[] {
  if (!CMA_ENABLED) return [];

  const predictions: ContextPrediction[] = [];
  const hour = options?.timeOfDay ?? new Date().getHours();
  const day = options?.dayOfWeek ?? new Date().getDay();
  const isRestart = options?.isFirstTurnAfterRestart ?? false;
  const isFrustrated = detectFrustration(userMessage);

  // ── RESTART RECOVERY ──
  if (isRestart) {
    predictions.push({
      source: "facts",
      query: "recent decisions and work in progress",
      confidence: 0.95,
      reason: "first turn after restart: load recent consolidated facts",
    });
    predictions.push({
      source: "episodic",
      query: "recent task episodes with lessons",
      confidence: 0.9,
      reason: "first turn after restart: load recent episodes",
    });
    predictions.push({
      source: "journal",
      query: "today",
      confidence: 0.85,
      reason: "first turn after restart: check today's journal",
    });
  }

  // ── FRUSTRATION: LOAD EVERYTHING ──
  if (isFrustrated) {
    predictions.push({
      source: "semantic",
      query: userMessage,
      confidence: 1.0,
      reason: "frustration detected: full context reload",
    });
    predictions.push({
      source: "facts",
      query: userMessage,
      confidence: 1.0,
      reason: "frustration detected: load all relevant facts",
    });
    predictions.push({
      source: "episodic",
      query: userMessage,
      confidence: 1.0,
      reason: "frustration detected: load related episodes",
    });
  }

  // ── TOPIC CONTINUITY ──
  if (previousIntent && !isTopicChange(currentIntent, previousIntent)) {
    // Same topic: high confidence that same context is needed
    if (wm?.task.activeIntent) {
      predictions.push({
        source: "facts",
        query: wm.task.activeIntent,
        confidence: 0.9,
        reason: "topic continuity: same intent as last turn",
      });
    }
  }

  // ── RECALL LANGUAGE ──
  if (/(?:remember|recall|we discussed|last time|earlier|before)/i.test(userMessage)) {
    predictions.push({
      source: "episodic",
      query: userMessage,
      confidence: 0.9,
      reason: "user referencing past conversation",
    });
    predictions.push({
      source: "semantic",
      query: userMessage,
      confidence: 0.85,
      reason: "user referencing past knowledge",
    });
  }

  // ── TIME-BASED PATTERNS ──
  // Monday morning = pipeline review
  if (day === 1 && hour >= 6 && hour <= 10) {
    predictions.push({
      source: "facts",
      query: "pipeline metrics leads close rate",
      confidence: 0.7,
      reason: "Monday morning pattern: pipeline review likely",
    });
  }

  // Morning first message (6-9am)
  if (hour >= 6 && hour <= 9 && wm && wm.totalTurns === 0) {
    predictions.push({
      source: "facts",
      query: "business metrics daily brief",
      confidence: 0.8,
      reason: "morning first message: daily brief context",
    });
  }

  // ── INTENT-DRIVEN ──
  if (currentIntent.financial) {
    predictions.push({
      source: "facts",
      query: "revenue profit expenses financial decisions",
      confidence: 0.85,
      reason: "financial intent detected",
    });
  }

  if (currentIntent.coding) {
    predictions.push({
      source: "facts",
      query: "code architecture implementation decisions artifacts",
      confidence: 0.8,
      reason: "coding intent detected",
    });
  }

  if (currentIntent.marketing) {
    predictions.push({
      source: "facts",
      query: "ads campaigns CPL creative marketing decisions",
      confidence: 0.8,
      reason: "marketing intent detected",
    });
  }

  // Deduplicate by source+query
  const seen = new Set<string>();
  return predictions.filter(p => {
    const key = `${p.source}:${p.query}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================
// CONTEXT MISS TRACKING
// ============================================================

/**
 * Record a context miss for later analysis.
 */
export async function recordContextMiss(
  miss: ContextMiss,
  agentId: string,
  turnNumber: number,
  supabase: SupabaseClient,
): Promise<void> {
  try {
    await supabase.from("context_misses").insert({
      agent_id: agentId,
      topic: miss.topic,
      what_was_needed: miss.whatWasNeeded,
      what_was_loaded: miss.whatWasLoaded,
      turn_number: turnNumber,
    });
  } catch { /* non-fatal */ }
}

/**
 * Record a knowledge gap for the learning queue.
 */
export async function recordKnowledgeGap(
  agentId: string,
  topic: string,
  context: string,
  severity: "low" | "medium" | "high",
  supabase: SupabaseClient,
): Promise<void> {
  try {
    // Check for existing unresolved gap on same topic
    const { data: existing } = await supabase
      .from("knowledge_gaps")
      .select("id")
      .eq("agent_id", agentId)
      .eq("topic", topic)
      .is("resolved_at", null)
      .limit(1);

    if (existing && existing.length > 0) return; // already tracked

    await supabase.from("knowledge_gaps").insert({
      agent_id: agentId,
      topic,
      context,
      severity,
      resolution: severity === "high" ? "ask_user" : "research",
    });

    info("anticipatory", `Knowledge gap recorded: ${topic} (${severity})`);
  } catch { /* non-fatal */ }
}

// ============================================================
// HELPERS
// ============================================================

function isTopicChange(
  current: MessageIntent,
  previous: MessageIntent,
): boolean {
  const currentActive = Object.entries(current)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const previousActive = Object.entries(previous)
    .filter(([, v]) => v)
    .map(([k]) => k);

  if (previousActive.length === 0) return true;

  // Check if any currently active flag was not active before
  for (const flag of currentActive) {
    if (!previous[flag]) return true;
  }
  // Check if any previously active flag is no longer active
  for (const flag of previousActive) {
    if (!current[flag]) return true;
  }

  return false;
}
