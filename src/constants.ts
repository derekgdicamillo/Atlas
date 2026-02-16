/**
 * Atlas — Shared Constants
 */

export const MODELS = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5-20250929",
  haiku: "claude-haiku-4-5-20251001",
} as const;

export type ModelTier = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelTier = "opus";

// Cost per million tokens (USD) — updated Feb 2026
// https://docs.anthropic.com/en/docs/about-claude/models
export const TOKEN_COSTS: Record<ModelTier, { input: number; output: number }> = {
  opus:   { input: 15.00, output: 75.00 },
  sonnet: { input: 3.00,  output: 15.00 },
  haiku:  { input: 0.80,  output: 4.00 },
};

// Max tool calls per request before kill (loop detection)
export const MAX_TOOL_CALLS_PER_REQUEST = 25;

// Concurrent subagent limit (code + research share pool)
export const MAX_CONCURRENT_SUBAGENTS = 5;

// Code agent — dedicated coding subagent with higher limits
export const CODE_AGENT_MAX_TOOL_CALLS = 200;
export const CODE_AGENT_WALL_CLOCK_MS = 30 * 60 * 1000;       // 30 min
export const CODE_AGENT_INACTIVITY_MS = 5 * 60 * 1000;        // 5 min (coding has long pauses)
export const CODE_AGENT_PROGRESS_INTERVAL_MS = 30_000;         // 30s Telegram updates
export const CODE_AGENT_DEFAULT_MODEL: ModelTier = "opus";
export const CODE_AGENT_MAX_BUDGET_USD = 5.00;
