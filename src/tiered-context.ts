// src/tiered-context.ts
/**
 * Atlas — Tiered Context Loading (Phase 2)
 *
 * Determines when to inject heavy context (Tier 1) vs minimal context (Tier 0)
 * based on turn position and topic changes.
 */

export interface TurnContext {
  /** True on first turn after process spawn/restart/session reset */
  isFirstTurn: boolean;
  /** Intent flags from the previous turn (null on first turn) */
  previousIntentFlags: Record<string, boolean> | null;
  /** Whether tiered context loading is enabled */
  tieredContextEnabled: boolean;
}

/**
 * Detect if the conversation topic changed between turns.
 * Compares active intent flags (true values only) as sets.
 *
 * Returns true if:
 * - previous is null (first turn)
 * - any currently-active flag was not active before
 * - any previously-active flag is no longer active
 */
export function isTopicChange(
  current: Record<string, boolean>,
  previous: Record<string, boolean> | null,
): boolean {
  if (!previous) return true;
  const currentActive = Object.keys(current).filter(k => current[k]);
  const previousActive = Object.keys(previous).filter(k => previous[k]);
  if (currentActive.length !== previousActive.length) return true;
  // Check both directions for correctness
  if (currentActive.some(k => !previous[k])) return true;
  if (previousActive.some(k => !current[k])) return true;
  return false;
}

/**
 * Determine whether Tier 1 context should be injected this turn.
 * Returns true if:
 * - Tiered context is disabled (always inject, legacy behavior)
 * - It's the first turn on this process
 * - The topic changed since the last turn
 */
export function shouldInjectTier1(
  turnContext: TurnContext,
  currentIntent: Record<string, boolean>,
): boolean {
  if (!turnContext.tieredContextEnabled) return true; // flag off = always inject
  if (turnContext.isFirstTurn) return true;
  return isTopicChange(currentIntent, turnContext.previousIntentFlags);
}
