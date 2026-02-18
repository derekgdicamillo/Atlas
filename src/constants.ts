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
