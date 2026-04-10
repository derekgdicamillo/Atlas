/**
 * Atlas — Cognitive Memory Architecture: Metacognitive Monitor
 *
 * Atlas should know what it knows and what it doesn't.
 *
 * Components:
 *   1. Enhanced salience scoring with emotional valence
 *   2. Frustration-triggered full context reload
 *   3. Knowledge gap detection (feeds learning queue)
 *   4. Context miss detection (feeds anticipatory model)
 *   5. Confidence tracking on retrieved memories
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn } from "./logger.ts";
import { CMA_ENABLED } from "./constants.ts";
import { detectFrustration, detectCorrection, recordKnowledgeGap } from "./anticipatory.ts";

// ============================================================
// TYPES
// ============================================================

export interface EnhancedSalience {
  emotional: number;
  importance: number;
  selfRelevance: number;
  depth: number;
  novelty: number;
  overall: number;
  // Metacognitive extensions
  valence: "positive" | "negative" | "neutral";
  intensity: number;
  isCorrection: boolean;
  isFrustration: boolean;
  isExcitement: boolean;
  stakesLevel: "low" | "medium" | "high" | "critical";
}

// ============================================================
// ENHANCED SALIENCE WITH EMOTIONAL VALENCE
// ============================================================

const POSITIVE_PATTERNS = [
  /(?:great|perfect|excellent|awesome|love|nice|thanks|thank you|good job|well done)/i,
  /(?:exactly|that's it|nailed it|spot on)/i,
  /!+\s*$/,  // trailing exclamation (positive context)
];

const NEGATIVE_PATTERNS = [
  /(?:wrong|bad|terrible|awful|hate|broken|failed|useless)/i,
  /(?:don't|stop|no|never|worst)/i,
  /(?:frustrated|annoyed|angry|disappointed)/i,
];

const STAKES_PATTERNS = {
  critical: /(?:deadline|production|patient|urgent|emergency|critical|breaking|down)/i,
  high: /(?:client|revenue|launch|deploy|billing|legal|compliance)/i,
  medium: /(?:project|feature|meeting|schedule|plan|strategy)/i,
};

/**
 * Score emotional valence and stakes of a message.
 * Extends the existing scoreSalience() from cognitive.ts with
 * metacognitive dimensions.
 */
export function scoreEmotionalValence(text: string): EnhancedSalience {
  // Base salience factors (simplified version of cognitive.ts scoreSalience)
  const wordCount = text.split(/\s+/).length;
  const depth = Math.min(wordCount / 100, 1.0);

  // Emotional detection
  const posScore = POSITIVE_PATTERNS.reduce((s, p) => s + (p.test(text) ? 0.3 : 0), 0);
  const negScore = NEGATIVE_PATTERNS.reduce((s, p) => s + (p.test(text) ? 0.4 : 0), 0);
  const emotional = Math.min(Math.max(posScore, negScore), 1.0);

  // Valence determination
  let valence: "positive" | "negative" | "neutral" = "neutral";
  if (negScore > posScore && negScore > 0.2) valence = "negative";
  else if (posScore > negScore && posScore > 0.2) valence = "positive";

  const intensity = Math.min(Math.max(posScore, negScore), 1.0);

  // Specific signal detection
  const isCorrection = detectCorrection(text);
  const isFrustration = detectFrustration(text);
  const isExcitement = posScore > 0.5;

  // Stakes level
  let stakesLevel: "low" | "medium" | "high" | "critical" = "low";
  if (STAKES_PATTERNS.critical.test(text)) stakesLevel = "critical";
  else if (STAKES_PATTERNS.high.test(text)) stakesLevel = "high";
  else if (STAKES_PATTERNS.medium.test(text)) stakesLevel = "medium";

  // Importance (corrections and frustration are high importance)
  let importance = 0.5;
  if (isCorrection) importance = 1.0;
  else if (isFrustration) importance = 0.9;
  else if (stakesLevel === "critical") importance = 0.9;
  else if (stakesLevel === "high") importance = 0.7;

  // Self-relevance (personal/business references)
  const selfRelevance = /(?:I|my|we|our|Derek|Esther|PV|MediSpa|clinic)/i.test(text) ? 0.8 : 0.3;

  // Overall composite
  const overall = Math.min(
    (emotional * 3.0 + importance * 4.0 + selfRelevance * 2.5 + depth * 1.5 + 0.5 * 2.0) / 13.0,
    1.0,
  );

  return {
    emotional,
    importance,
    selfRelevance,
    depth,
    novelty: 0.5, // default, needs context to compute
    overall,
    valence,
    intensity,
    isCorrection,
    isFrustration,
    isExcitement,
    stakesLevel,
  };
}

// ============================================================
// RETRIEVAL SCORE BOOSTING
// ============================================================

/**
 * Boost a retrieval score based on emotional relevance.
 * Corrections get 2x boost, frustration moments 1.5x, excitement 1.2x.
 */
export function boostByEmotionalRelevance(
  baseScore: number,
  memoryValence: { valence_intensity?: number; is_correction?: boolean },
): number {
  const intensity = memoryValence.valence_intensity ?? 0;
  const multiplier = memoryValence.is_correction ? 2.0 : (1.0 + intensity * 0.5);
  return baseScore * multiplier;
}

// ============================================================
// HEDGING / UNCERTAINTY DETECTION
// ============================================================

const HEDGING_PATTERNS = [
  /I('m| am) not (sure|certain)/i,
  /I (think|believe|assume)/i,
  /(?:probably|possibly|maybe|perhaps|might)/i,
  /if I recall correctly/i,
  /I don't have (?:access|information|data)/i,
  /I('m| am) not (?:able|sure how)/i,
];

/**
 * Detect if Atlas's response contains hedging language,
 * indicating a potential knowledge gap.
 */
export function detectHedging(response: string): string[] {
  const hedges: string[] = [];
  for (const pattern of HEDGING_PATTERNS) {
    const match = response.match(pattern);
    if (match) {
      // Extract surrounding context (up to 100 chars)
      const idx = response.indexOf(match[0]);
      const start = Math.max(0, idx - 30);
      const end = Math.min(response.length, idx + match[0].length + 70);
      hedges.push(response.substring(start, end).trim());
    }
  }
  return hedges;
}

/**
 * Analyze Atlas's response for knowledge gaps and record them.
 * Called after each response. Non-blocking.
 */
export async function analyzeResponseForGaps(
  response: string,
  userMessage: string,
  agentId: string,
  supabase: SupabaseClient | null,
): Promise<void> {
  if (!CMA_ENABLED || !supabase) return;

  const hedges = detectHedging(response);
  if (hedges.length === 0) return;

  // Extract the topic from the user's message (first 100 chars)
  const topic = userMessage.substring(0, 100).trim();

  for (const hedge of hedges.slice(0, 2)) { // max 2 gaps per response
    await recordKnowledgeGap(
      agentId,
      topic,
      `Atlas hedged: "${hedge}"`,
      "medium",
      supabase,
    ).catch(() => {});
  }
}

// ============================================================
// SHOULD FORCE FULL CONTEXT
// ============================================================

/**
 * Determine if we should override tiered context and load everything.
 * Returns true on frustration detection or high-stakes situations.
 */
export function shouldForceFullContext(
  userMessage: string,
  salience: EnhancedSalience,
): boolean {
  if (!CMA_ENABLED) return false;

  // Frustration = load everything
  if (salience.isFrustration) return true;

  // Correction + high stakes = load everything
  if (salience.isCorrection && salience.stakesLevel !== "low") return true;

  // Critical stakes = load everything
  if (salience.stakesLevel === "critical") return true;

  return false;
}
