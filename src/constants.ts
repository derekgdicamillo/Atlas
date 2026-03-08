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
// Haiku 4.5: $1.00/$5.00 (not $0.80/$4.00 — that was Haiku 3.5 pricing)
export const TOKEN_COSTS: Record<ModelTier, { input: number; output: number }> = {
  opus:   { input: 15.00, output: 75.00 },
  sonnet: { input: 3.00,  output: 15.00 },
  haiku:  { input: 1.00,  output: 5.00 },
};

// Max tool calls per request before kill (loop detection)
// Smart loop detection (duplicate signatures, ping-pong, global circuit breaker) catches
// most real loops. This hard ceiling is a defense-in-depth safety net for novel patterns
// that evade signature-based detection. Set high enough for complex tasks.
export const MAX_TOOL_CALLS_PER_REQUEST = 300;

// Concurrent subagent limit (code + research share pool)
export const MAX_CONCURRENT_SUBAGENTS = 8;

// Code agent — dedicated coding subagent with higher limits
export const CODE_AGENT_MAX_TOOL_CALLS = 500;
export const CODE_AGENT_WALL_CLOCK_MS = 180 * 60 * 1000;      // 180 min (was 90, too short for complex refactors)
export const CODE_AGENT_INACTIVITY_MS = 10 * 60 * 1000;       // 10 min (was 5, long builds/reasoning need more)
export const CODE_AGENT_PROGRESS_INTERVAL_MS = 30_000;         // 30s Telegram updates
export const CODE_AGENT_DEFAULT_MODEL: ModelTier = "opus";
export const CODE_AGENT_MAX_BUDGET_USD = 20.00;                // was $5, too tight for complex Opus tasks

// Git worktree isolation for parallel code agents
import { join } from "path";
const _projectDir = process.env.PROJECT_DIR || process.cwd();
export const WORKTREE_BASE_DIR = join(_projectDir, ".worktrees");
export const WORKTREE_STATE_FILE = join(_projectDir, "data", "worktrees.json");
export const WORKTREE_MAX_AGE_MS = 3 * 60 * 60 * 1000;              // 3 hours (was 2h, too short for code agents with retries)
export const WORKTREE_BRANCH_PREFIX = "atlas/agent/";

// Announce retry — exponential backoff for task completion delivery (OpenClaw pattern)
export const ANNOUNCE_MAX_RETRIES = 3;
export const ANNOUNCE_BACKOFF_BASE_MS = 2_000;  // 2s, 4s, 8s

// Swarm system
export const MAX_QUEUE_SIZE = 25;
export const MAX_SWARM_NODES = 20;
export const DEFAULT_SWARM_BUDGET_USD = 3.00;
export const MAX_SWARM_BUDGET_USD = 10.00;
export const DEFAULT_SWARM_WALL_CLOCK_MS = 30 * 60 * 1000;   // 30 min
export const SWARM_TICK_INTERVAL_MS = 30_000;                  // 30s DAG tick
export const CIRCUIT_BREAKER_THRESHOLD = 3;
export const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000;        // 5 min

// Model routing defaults per task type
// Budget is irrelevant ($200/mo Max plan, never close to limit).
// Use the best model for everything except validation (haiku is fine for quick checks).
export const RESEARCH_DEFAULT_MODEL: ModelTier = "opus";
export const CODE_DEFAULT_MODEL: ModelTier = "opus";
export const SYNTHESIZE_DEFAULT_MODEL: ModelTier = "opus";
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

// ============================================================
// BROWSER (agent-browser CLI)
// ============================================================

/** Max time per browser command execution (open, snapshot, click, etc.) */
export const BROWSER_COMMAND_TIMEOUT_MS = 30_000;

/** Max output chars from browser commands (prevents context bloat) */
export const BROWSER_MAX_OUTPUT_CHARS = 50_000;

// URL allowlist for web search/fetch tools
// Empty array = no restrictions (Atlas can search any domain).
// Previously had a 16-domain whitelist, but that's an unnecessary handcuff.
// The blocked domains list below handles actual security concerns (SSRF prevention).
export const WEB_ALLOWED_DOMAINS: string[] = [];

// Domains that should never be accessed (security blocklist)
export const WEB_BLOCKED_DOMAINS: string[] = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "169.254.169.254",  // AWS metadata
  "metadata.google.internal",
];

// ============================================================
// SUBAGENT DEPTH LIMITS (OpenClaw cascade prevention)
// ============================================================

/** Maximum subagent nesting depth. 0 = main session, 1 = first subagent, 2 = sub-subagent (max). */
export const SUBAGENT_MAX_DEPTH = 2;

// ============================================================
// SUBAGENT OUTPUT SIZE LIMITS
// ============================================================

/** Maximum chars to keep from subagent output (prevents context bloat) */
export const SUBAGENT_MAX_OUTPUT_CHARS = 50_000;

/** Maximum chars to keep from code agent result text (for announcements) */
export const CODE_AGENT_MAX_RESULT_CHARS = 20_000;

// ============================================================
// PHASE-SPECIFIC STATUS (OpenClaw contextual status)
// ============================================================

/** Map tool names to human-readable phase descriptions for Telegram status updates */
export const TOOL_PHASE_NAMES: Record<string, string> = {
  Glob: "Searching files",
  Grep: "Searching code",
  Read: "Reading",
  Write: "Writing",
  Edit: "Editing",
  Bash: "Running command",
  WebSearch: "Researching",
  WebFetch: "Fetching page",
  TodoWrite: "Planning",
  Task: "Delegating",
  ListDirectory: "Browsing",
  Search: "Searching",
  NotebookEdit: "Editing notebook",
};

// ============================================================
// PER-AGENT TOOL POLICIES (OpenClaw granular policies)
// ============================================================

/** Tool restrictions per agent type. Empty array = no restrictions.
 *  Opus 4.6 doesn't loop on Bash/Write/Edit like earlier models did.
 *  Main session is now fully unrestricted. Research agents still restricted
 *  to prevent accidental file writes from fire-and-forget tasks. */
export const TOOL_POLICIES: Record<string, string[]> = {
  /** Main session: FULL access (Opus 4.6 is disciplined enough) */
  main_session: [],
  /** Code agents: full access (need all tools) */
  code_agent: [],
  /** Research agents: no shell, no bulk edits (needs Write for output file) */
  research_agent: ["Bash", "Edit", "NotebookEdit"],
  /** Validation agents: read-only (cheapest, safest) */
  validation_agent: ["Bash", "Write", "Edit", "NotebookEdit", "WebSearch", "WebFetch"],
};

// ============================================================
// PER-MODEL CACHE RETENTION (OpenClaw cache tuning)
// ============================================================

/** Cache TTL multipliers per model tier. Haiku is fast (short cache), Opus is slow (long cache). */
export const CACHE_TTL_MULTIPLIERS: Record<ModelTier, number> = {
  haiku: 0.5,   // 50% of base TTL (fast agent, needs fresh data)
  sonnet: 1.0,  // 100% base TTL (standard)
  opus: 1.5,    // 150% of base TTL (long-running, stable data acceptable)
};

// ============================================================
// DELIVERY BACKOFF PERSISTENCE
// ============================================================

/** Max exponential backoff cap for persistent delivery failures */
export const DELIVERY_MAX_BACKOFF_MS = 30 * 60_000; // 30 min cap

/** Minimum time between delivery retries to the same target */
export const DELIVERY_MIN_RETRY_INTERVAL_MS = 5_000; // 5s floor

// ============================================================
// VERBOSE MODE (OpenClaw verbose gating)
// ============================================================

/** Default verbose mode state (user toggles via /verbose) */
export const VERBOSE_MODE_DEFAULT = false;

// ============================================================
// SENTINEL TEXT PATTERNS (OpenClaw sentinel suppression)
// ============================================================

/** Internal tag patterns that must NEVER reach Telegram. Comprehensive list. */
export const SENTINEL_TAG_PATTERNS = [
  /\[TASK:\s*[^\]]*\]/gi,
  /\[CODE_TASK:\s*(?:[^\[\]]|\[[^\]]*\])*\]/gi,
  /\[ENTITY:\s*[^\]]*\]/gi,
  /\[RELATE:\s*[^\]]*\]/gi,
  /\[REMEMBER:\s*[^\]]*\]/gi,
  /\[GOAL:\s*[^\]]*\]/gi,
  /\[DONE:\s*[^\]]*\]/gi,
  /\[TODO:\s*[^\]]*\]/gi,
  /\[TODO_DONE:\s*[^\]]*\]/gi,
  /\[SEND:\s*[^\]]*\]/gi,
  /\[DRAFT:\s*[^\]]*\]/gi,
  /\[CAL_ADD:\s*[^\]]*\]/gi,
  /\[CAL_REMOVE:\s*[^\]]*\]/gi,
  /\[SCHEDULE:\s*[^\]]*\]/gi,
  /\[SURFACE:\s*[^\]]*\]/gi,
  /\[REMIND:\s*[^\]]*\]/gi,
  /\[WHEN:\s*[^\]]*\]/gi,
  /\[GHL_NOTE:\s*[^\]]*\]/gi,
  /\[GHL_TASK:\s*[^\]]*\]/gi,
  /\[GHL_TAG:\s*[^\]]*\]/gi,
  /\[GHL_WORKFLOW:\s*[^\]]*\]/gi,
  /\[WP_UPDATE:\s*(?:[^\[\]]|\[[^\]]*\])*\]/gi,
  /\[WP_POST:\s*(?:[^\[\]]|\[[^\]]*\])*\]/gi,
  /\[INGEST_FOLDER:\s*[^\]]*\]/gi,
  /\[WORKFLOW:\s*[^\]]*\]/gi,
  /\[PAUSE_AUTOMATIONS:\s*[^\]]*\]/gi,
  /\[RESUME_AUTOMATIONS:\s*[^\]]*\]/gi,
  /\[EXPLORE:\s*[^\]]*\]/gi,
  /\[BROWSE:\s*[^\]]*\]/gi,
  /\[BROWSE_SCREENSHOT:\s*[^\]]*\]/gi,
  /\[BROWSE_CLICK:\s*[^\]]*\]/gi,
  /\[BROWSE_FILL:\s*[^\]]*\]/gi,
];

// ============================================================
// CONTEXT WINDOW PRUNING
// ============================================================

/** Entries older than this in the ring buffer get aggressively truncated */
export const CONTEXT_PRUNE_AGE_ENTRIES = 10;

/** Max chars for old (pruned) entries in ring buffer prompt injection */
export const CONTEXT_PRUNE_MAX_CHARS = 400;

/** Image entries older than this many positions from tail are stripped to "[image]" */
export const IMAGE_DEDUP_TAIL_KEEP = 3;

// ============================================================
// TOX TRAY BUSINESS OPERATOR
// ============================================================

/** Business identifier for trust config and content queue */
export const TOX_TRAY_BUSINESS = "tox_tray";

/** Content generation cron schedule (9 AM MST daily) */
export const TOX_CONTENT_CRON = "0 9 * * *";

/** Post approved content (every 30 min, 8 AM - 8 PM MST) */
export const TOX_POST_CRON = "*/30 8-20 * * *";

/** Collect social analytics (11 PM daily) */
export const TOX_ANALYTICS_CRON = "0 23 * * *";

/** Weekly tox tray digest (Sunday 5 PM, before PV exec report) */
export const TOX_WEEKLY_CRON = "0 17 * * 0";

/** Etsy listing sync (6 AM daily) */
export const TOX_ETSY_SYNC_CRON = "0 6 * * *";

/** Max content items to generate per day */
export const TOX_MAX_DAILY_CONTENT = 4;

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

// ============================================================
// CODE AGENT SUPERVISOR SYSTEM
// ============================================================
// Live supervision with pattern detection, shadow evaluation,
// intervention, and learning. See src/patterns.ts, src/shadow-evaluator.ts,
// src/learned-patterns.ts, src/checkpoints.ts, src/context-injector.ts.

/** Master switch for the supervisor system */
export const SUPERVISOR_ENABLED = process.env.SUPERVISOR_ENABLED !== "false";

/** Enable signature-based pattern detection (no LLM cost) */
export const SUPERVISOR_PATTERN_DETECT = process.env.SUPERVISOR_PATTERN_DETECT !== "false";

/** Enable LLM-based shadow evaluation */
export const SUPERVISOR_SHADOW_EVAL = process.env.SUPERVISOR_SHADOW_EVAL === "true";

/** Shadow evaluation interval (every N tool calls) */
export const SUPERVISOR_SHADOW_INTERVAL = parseInt(process.env.SUPERVISOR_SHADOW_INTERVAL || "10", 10);

/** Model for shadow evaluation (haiku is cheap and fast) */
export const SUPERVISOR_SHADOW_MODEL: ModelTier = (process.env.SUPERVISOR_SHADOW_MODEL as ModelTier) || "haiku";

/** Maximum restarts before giving up on a task */
export const SUPERVISOR_MAX_RESTARTS = parseInt(process.env.SUPERVISOR_MAX_RESTARTS || "4", 10);

/** Enable learning system (extract patterns from completed tasks) */
export const SUPERVISOR_LEARNING = process.env.SUPERVISOR_LEARNING !== "false";

/** Enable context injection (rich prompts with CLAUDE.md, SOUL.md, etc.) */
export const SUPERVISOR_CONTEXT_INJECTION = process.env.SUPERVISOR_CONTEXT_INJECTION !== "false";

/** Maximum tokens for injected context (budget control) */
export const SUPERVISOR_CONTEXT_MAX_TOKENS = parseInt(process.env.SUPERVISOR_CONTEXT_MAX_TOKENS || "8000", 10);

/** Enable checkpoint system for complex tasks */
export const SUPERVISOR_CHECKPOINTS = process.env.SUPERVISOR_CHECKPOINTS === "true";

/** Intervention modes: "log_only" logs issues but doesn't kill, "active" takes action */
export type SupervisorMode = "log_only" | "active";
export const SUPERVISOR_MODE: SupervisorMode = (process.env.SUPERVISOR_MODE as SupervisorMode) || "log_only";

// ============================================================
// FEEDBACK LOOP
// ============================================================

/** Minimum detection confidence to store a feedback signal */
export const FEEDBACK_MIN_CONFIDENCE = 0.5;
/** Number of similar feedback entries needed to consolidate into a durable rule */
export const FEEDBACK_CONSOLIDATION_THRESHOLD = 3;
/** Max feedback lessons injected per prompt */
export const FEEDBACK_MAX_LESSONS_PER_PROMPT = 5;
/** Look-back window for consolidation pattern detection */
export const FEEDBACK_MAX_AGE_DAYS_CONSOLIDATION = 90;

// ============================================================
// EPISODIC MEMORY
// ============================================================

/** Auto-close an episode after this much inactivity */
export const EPISODE_TIMEOUT_MS = 15 * 60 * 1000;
/** Minimum actions before saving an episode (discard trivial ones) */
export const EPISODE_MIN_ACTIONS = 2;
/** Cap actions per episode to prevent unbounded growth */
export const EPISODE_MAX_ACTIONS = 50;
/** Max episodes surfaced in prompt context */
export const EPISODE_MAX_RELEVANT = 3;
/** Word overlap below this threshold = topic shift (triggers episode close) */
export const EPISODE_TOPIC_SHIFT_THRESHOLD = 0.3;

// ============================================================
// OBSERVATIONAL MEMORY
// ============================================================

/** Run observer every N conversation turns */
export const OBSERVATION_EXTRACT_EVERY_N_TURNS = 4;
/** Max observations extracted per observer invocation */
export const OBSERVATION_MAX_PER_EXTRACTION = 3;
/** Minimum observations before running reflector */
export const OBSERVATION_REFLECTOR_MIN_OBSERVATIONS = 5;
/** Max chars for observation blocks in prompt */
export const OBSERVATION_BLOCK_MAX_CHARS = 6000;
/** Above this similarity = reinforce existing observation */
export const OBSERVATION_SIMILARITY_THRESHOLD = 0.85;
/** Between this and similarity threshold = supersede */
export const OBSERVATION_SUPERSEDE_THRESHOLD = 0.75;
/** Delete superseded observations older than this */
export const OBSERVATION_PRUNE_AGE_DAYS = 30;

// ============================================================
// PROACTIVE MONITORING
// ============================================================

/** Master switch for the proactive monitoring engine */
export const MONITOR_ENABLED = process.env.MONITOR_ENABLED !== "false";
/** DND start hour (suppress non-critical alerts) */
export const MONITOR_DND_START_HOUR = 22;
/** DND end hour */
export const MONITOR_DND_END_HOUR = 6;
/** Batch warning-level alerts for this interval before delivery */
export const MONITOR_BATCH_INTERVAL_MS = 30 * 60_000;
/** Metric snapshot retention in days */
export const METRIC_SNAPSHOT_RETENTION_DAYS = 90;
/** Default baseline window for dynamic threshold detection */
export const METRIC_BASELINE_WINDOW_HOURS = 168;
/** Max alerts per hour */
export const MONITOR_MAX_ALERTS_PER_HOUR = 15;
/** Per-category dedup windows in ms. Slow-moving metrics get longer windows. */
export const ALERT_DEDUP_WINDOWS: Record<string, number> = {
  Ads: 24 * 3600_000,        // 24h -- CPL/frequency/CTR move over days
  Financial: 24 * 3600_000,  // 24h
  Pipeline: 12 * 3600_000,   // 12h
  Website: 12 * 3600_000,    // 12h
  Reputation: 8 * 3600_000,  // 8h
  Operations: 8 * 3600_000,  // 8h
  Email: 4 * 3600_000,       // 4h (event-driven)
  Calendar: 4 * 3600_000,    // 4h
};
export const ALERT_DEDUP_DEFAULT_MS = 4 * 3600_000; // 4h fallback
/** Schedule tier intervals in minutes */
export const MONITOR_SCHEDULES = {
  fast: 5,
  medium: 15,
  slow: 60,
  daily: 1440,
} as const;
export type MonitorScheduleTier = keyof typeof MONITOR_SCHEDULES;

// ============================================================
// AUTOMATION PAUSE
// ============================================================

/** Categories that can be paused via [PAUSE_AUTOMATIONS:] tag or /automations command */
export const AUTOMATION_CATEGORIES = [
  "patient_engagement",
  "stale_leads",
  "appointment_reminders",
  "noshow_recovery",
] as const;
export type AutomationCategory = (typeof AUTOMATION_CATEGORIES)[number];

/** Parent -> children hierarchy. Pausing a parent effectively pauses all children. */
export const AUTOMATION_CATEGORY_CHILDREN: Partial<Record<AutomationCategory, readonly AutomationCategory[]>> = {
  patient_engagement: ["stale_leads", "appointment_reminders", "noshow_recovery"],
};

/** Workflow template names that belong to each category (for task suppression matching) */
export const AUTOMATION_WORKFLOW_MAP: Partial<Record<AutomationCategory, string[]>> = {
  stale_leads: ["stale-lead-reactivate"],
};

// ============================================================
// OPENCLAW-INSPIRED FEATURES (2026-03-05)
// ============================================================

// Cron jitter: random delay before each job fires to prevent load spikes
export const CRON_JITTER_MAX_MS = 45_000; // 0-45s random delay
export const CRON_JITTER_EXEMPT = new Set([
  "prospective-memory",  // every 1 min, time-sensitive triggers
  "alert-deliver",       // every 1 min, urgent alerts
  "scheduled-msgs",      // every 1 min, timed message delivery
  "supervisor-worker",   // every 30s, agent health monitoring
]);

// Session idle reset: auto-clear stale sessions
export const SESSION_IDLE_RESET_MS = 8 * 60 * 60 * 1000; // 8 hours idle = auto-reset (covers full workday gap)

// Queue mode: how to handle messages arriving while Claude is busy
export type QueueMode = "collect" | "interrupt";
export const DEFAULT_QUEUE_MODE: QueueMode = "collect";

// Session compaction: inline summarization when conversation exceeds budget
export const COMPACTION_BUDGET_THRESHOLD = 0.30; // compact if conversation > 30% of prompt budget
export const COMPACTION_MIN_ENTRIES = 10;         // don't compact tiny buffers

// Telegram streaming: progressive response delivery
export const STREAMING_ENABLED = process.env.STREAMING_ENABLED !== "false";
export const STREAMING_EDIT_INTERVAL_MS = 1_200;   // min ms between editMessageText calls
export const STREAMING_CHUNK_THRESHOLD = 3_800;     // start new message before hitting 4096 limit
