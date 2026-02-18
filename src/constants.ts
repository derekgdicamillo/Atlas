/**
 * Atlas — Shared Constants
 */

export const MODELS = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
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
// 25 was too low — Claude Code uses 100+ on complex tasks.
// Raised to 75 for main session; code agents keep 200.
export const MAX_TOOL_CALLS_PER_REQUEST = 75;

// Concurrent subagent limit (code + research share pool)
export const MAX_CONCURRENT_SUBAGENTS = 5;

// Code agent — dedicated coding subagent with higher limits
export const CODE_AGENT_MAX_TOOL_CALLS = 200;
export const CODE_AGENT_WALL_CLOCK_MS = 90 * 60 * 1000;       // 90 min
export const CODE_AGENT_INACTIVITY_MS = 5 * 60 * 1000;        // 5 min (coding has long pauses)
export const CODE_AGENT_PROGRESS_INTERVAL_MS = 30_000;         // 30s Telegram updates
export const CODE_AGENT_DEFAULT_MODEL: ModelTier = "opus";
export const CODE_AGENT_MAX_BUDGET_USD = 5.00;

// Announce retry — exponential backoff for task completion delivery (OpenClaw pattern)
export const ANNOUNCE_MAX_RETRIES = 3;
export const ANNOUNCE_BACKOFF_BASE_MS = 2_000;  // 2s, 4s, 8s

// Swarm system
export const MAX_QUEUE_SIZE = 25;
export const MAX_SWARM_NODES = 15;
export const DEFAULT_SWARM_BUDGET_USD = 3.00;
export const MAX_SWARM_BUDGET_USD = 10.00;
export const DEFAULT_SWARM_WALL_CLOCK_MS = 30 * 60 * 1000;   // 30 min
export const SWARM_TICK_INTERVAL_MS = 30_000;                  // 30s DAG tick
export const CIRCUIT_BREAKER_THRESHOLD = 3;
export const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000;        // 5 min

// Model routing defaults per task type
export const RESEARCH_DEFAULT_MODEL: ModelTier = "sonnet";
export const CODE_DEFAULT_MODEL: ModelTier = "opus";
export const SYNTHESIZE_DEFAULT_MODEL: ModelTier = "sonnet";
export const VALIDATE_DEFAULT_MODEL: ModelTier = "haiku";
export const BUDGET_PRESSURE_THRESHOLD = 0.10;                 // $/node triggers haiku

// Convergent Exploration system
export type StrategyLens = "orthodox" | "lateral" | "contrarian" | "minimalist" | "speculative" | "empirical" | "historical";

export interface ExplorationTierConfig {
  tier: 0 | 1 | 2 | 3;
  branchCount: number;
  branchModel: ModelTier;
  scorerModel: ModelTier;
  synthModel: ModelTier;
  maxBudgetUsd: number;
  maxWallClockMs: number;
  maxAgents: number;
}

export const EXPLORATION_TIERS: Record<number, ExplorationTierConfig> = {
  0: { tier: 0, branchCount: 0, branchModel: "haiku", scorerModel: "haiku", synthModel: "haiku", maxBudgetUsd: 0, maxWallClockMs: 0, maxAgents: 0 },
  1: { tier: 1, branchCount: 2, branchModel: "haiku", scorerModel: "haiku", synthModel: "haiku", maxBudgetUsd: 0.50, maxWallClockMs: 10 * 60 * 1000, maxAgents: 3 },
  2: { tier: 2, branchCount: 3, branchModel: "sonnet", scorerModel: "sonnet", synthModel: "sonnet", maxBudgetUsd: 2.00, maxWallClockMs: 15 * 60 * 1000, maxAgents: 4 },
  3: { tier: 3, branchCount: 4, branchModel: "sonnet", scorerModel: "sonnet", synthModel: "opus", maxBudgetUsd: 5.00, maxWallClockMs: 25 * 60 * 1000, maxAgents: 5 },
};

export const EXPLORATION_LOG_MAX_ENTRIES = 100;
export const STRATEGY_LENSES: readonly StrategyLens[] = ["orthodox", "lateral", "contrarian", "minimalist", "speculative", "empirical", "historical"] as const;

// URL allowlist for web search/fetch tools (OpenClaw tool-policy pattern)
// When non-empty, Claude's web tools will be instructed to only access these domains.
// Empty array = no restrictions (default). Applied via prompt injection.
export const WEB_ALLOWED_DOMAINS: string[] = [
  // Business-relevant domains Atlas should always be able to access
  "pvmedispa.com",
  "landing.pvmedispa.com",
  "github.com",
  "docs.anthropic.com",
  "api.anthropic.com",
  "developers.google.com",
  "analytics.google.com",
  "ads.google.com",
  "support.google.com",
  "schema.org",
  "developer.mozilla.org",
  "stackoverflow.com",
  "npmjs.com",
  "bun.sh",
  "supabase.com",
  "highlevel.com",
  "wikipedia.org",
];

// Domains that should never be accessed (security blocklist)
export const WEB_BLOCKED_DOMAINS: string[] = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "169.254.169.254",  // AWS metadata
  "metadata.google.internal",
];

// Cron notification modes (inspired by OpenClaw delivery.ts)
export type CronNotifyMode = "announce" | "webhook" | "none";

// Cron job notification config
export interface CronJobNotifyConfig {
  mode: CronNotifyMode;
  /** Webhook URL for webhook mode (validated to http/https only) */
  webhookUrl?: string;
  /** Whether to notify on success (default: false for most jobs) */
  notifyOnSuccess?: boolean;
  /** Whether to notify on failure (default: true) */
  notifyOnFailure?: boolean;
}
