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
