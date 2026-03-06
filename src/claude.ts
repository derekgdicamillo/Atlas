/**
 * Atlas — Claude CLI Interface + Session Management
 *
 * Extracted from relay.ts to allow shared access from both the relay
 * (user messages) and heartbeat (cron-driven health checks).
 *
 * Session locking prevents concurrent CLI calls on the same session:
 * - User messages: wait for lock (lockBehavior: "wait")
 * - Heartbeat: skip if busy (lockBehavior: "skip")
 */

import { spawn } from "bun";
import { writeFile, readFile, appendFile, mkdir, rename } from "fs/promises";
import { join, dirname } from "path";
import { randomBytes } from "crypto";
import {
  info,
  warn,
  error as logError,
  trackClaudeCall,
  trackTimeout,
} from "./logger.ts";
import { MODELS, DEFAULT_MODEL, TOKEN_COSTS, MAX_TOOL_CALLS_PER_REQUEST, TOOL_PHASE_NAMES, SESSION_IDLE_RESET_MS, type ModelTier } from "./constants.ts";
import { addEntry, formatForPrompt } from "./conversation.ts";
import { parseCodeTaskFromTodoContent } from "./supervisor.ts";

// ============================================================
// CONFIGURATION
// ============================================================

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

// ============================================================
// MCP SERVER CONFIGURATION
// ============================================================

/** Full MCP config path (all 7 servers) */
const MCP_CONFIG_PATH = join(
  process.env.PROJECT_DIR || dirname(dirname(import.meta.path)),
  "mcp-servers", "mcp.json"
);

/** Map intent flags to MCP server names */
const INTENT_TO_MCP_SERVERS: Record<string, string[]> = {
  // atlas core is always included (memory, graph, alerts, facts)
  google:    ["google-suite"],
  pipeline:  ["ghl-crm"],
  financial: ["pv-dashboard"],
  marketing: ["pv-dashboard", "ga4-analytics"],
  reputation: ["gbp"],
  analytics: ["ga4-analytics"],
  coding:    [],   // code tasks go through subagents, not MCP
  browser:   [],   // browser uses agent-browser CLI via Bash, not MCP
  todos:     [],
};

/**
 * Build a filtered MCP config based on detected intent.
 * Atlas core is always included. Additional servers are added
 * based on which intent flags are true.
 * Returns the path to a temp config file, or the full config if
 * intent requires 4+ servers (not worth filtering at that point).
 */
export function buildMcpConfigArgs(intentFlags?: Record<string, boolean>): string[] {
  // No intent info or casual = atlas core only
  if (!intentFlags) {
    return ["--mcp-config", MCP_CONFIG_PATH];
  }

  // Collect which servers are needed based on intent
  const neededServers = new Set<string>(["atlas"]); // always include core
  for (const [intentKey, serverNames] of Object.entries(INTENT_TO_MCP_SERVERS)) {
    if (intentFlags[intentKey]) {
      for (const name of serverNames) {
        neededServers.add(name);
      }
    }
  }

  // If 5+ servers needed, just use the full config (not worth the temp file)
  if (neededServers.size >= 5) {
    return ["--mcp-config", MCP_CONFIG_PATH];
  }

  // Build filtered config as inline JSON string
  try {
    const fullConfig = JSON.parse(require("fs").readFileSync(MCP_CONFIG_PATH, "utf-8"));
    const filtered: Record<string, unknown> = {};
    for (const name of neededServers) {
      if (fullConfig.mcpServers[name]) {
        filtered[name] = fullConfig.mcpServers[name];
      }
    }
    const configStr = JSON.stringify({ mcpServers: filtered });
    return ["--mcp-config", configStr];
  } catch {
    // Fallback to full config if anything goes wrong
    return ["--mcp-config", MCP_CONFIG_PATH];
  }
}

// ============================================================
// ACTIVE CALL TRACKING (for polling watchdog)
// ============================================================

/**
 * Track active Claude CLI invocations so the polling watchdog doesn't
 * incorrectly fire during long-running calls (Opus can take 6+ minutes).
 * Simple counter: increment on call start, decrement on call end.
 */
let activeClaudeCalls = 0;

/** Returns true if at least one Claude call is currently in progress. */
export function isClaudeCallActive(): boolean {
  return activeClaudeCalls > 0;
}

/**
 * Track active Claude child processes per session key.
 * Used by queue "interrupt" mode to kill a running process when a new message arrives.
 */
const activeProcesses = new Map<string, { pid: number; kill: () => void }>();

/** Kill the active Claude process for a session key (queue interrupt mode). Returns true if a process was killed. */
export function killActiveProcess(sessionKey: string): boolean {
  const entry = activeProcesses.get(sessionKey);
  if (!entry) return false;
  info("claude", `[interrupt] Killing active process PID ${entry.pid} for ${sessionKey}`);
  entry.kill();
  activeProcesses.delete(sessionKey);
  return true;
}
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const PROJECT_ROOT = dirname(dirname(import.meta.path));
const RELAY_DIR =
  process.env.RELAY_DIR || join(process.env.HOME || process.env.USERPROFILE || require("os").homedir(), ".claude-relay");
const CLAUDE_TIMEOUT_MS = parseInt(
  process.env.CLAUDE_TIMEOUT_MS || "180000",
  10
);

// Scale timeout by model — Opus needs more runway for complex tasks
const MODEL_TIMEOUT_MULTIPLIERS: Record<string, number> = {
  opus: 3.0,   // 15 min with 300s base
  sonnet: 2.0, // 10 min
  haiku: 1.0,  // 5 min
};

// Fallback chain: if a model fails with rate-limit or unavailability, try next
const MODEL_FALLBACK: Record<string, ModelTier | null> = {
  opus: "sonnet",
  sonnet: "haiku",
  haiku: null, // nowhere to fall back to
};

// Exec preflight: strip env vars that should never leak to spawned CLI processes
// (OpenClaw #12836 — shell env var injection guard)
const STRIP_ENV_VARS = [
  // === API tokens / secrets (Claude CLI doesn't need these) ===
  "GHL_API_TOKEN", "GHL_WEBHOOK_SECRET",
  "SUPABASE_SERVICE_KEY", "SUPABASE_KEY",
  "DASHBOARD_API_TOKEN",
  "OPENAI_API_KEY",
  "GOOGLE_CLIENT_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "ISHTAR_BOT_TOKEN",
  "GROQ_API_KEY",

  // === Shell escape vectors (OpenClaw 2026.2.23) ===
  // Bash startup/config injection
  "SHELLOPTS",       // Forces shell options (e.g. xtrace, posix) in child bash
  "BASHOPTS",        // Same as SHELLOPTS for `shopt` options
  "BASH_ENV",        // Script sourced on non-interactive bash startup
  "ENV",             // Script sourced on POSIX sh startup
  "BASH_XTRACEFD",  // Redirects xtrace output to arbitrary file descriptor
  "BASH_COMPAT",     // Changes bash behavior to emulate older versions
  "PS4",             // Xtrace prompt. Expanded via command substitution = arbitrary exec
  "PROMPT_COMMAND",  // Executed before every prompt display in interactive bash
  "INPUTRC",         // Overrides readline config (key bindings, macros)

  // Dotfile/homedir override prevention
  "HOME",            // Controls where ~/. dotfiles are read from
  "ZDOTDIR",         // Controls where zsh reads .zshrc/.zprofile

  // Field splitting / globbing manipulation
  "IFS",             // Internal field separator. Classic shell injection primitive.
  "CDPATH",          // Modifies cd resolution. Can redirect to attacker-controlled dirs.
  "GLOBIGNORE",      // Hides files from glob expansion (security bypass)

  // History exfiltration
  "HISTFILE",        // Can redirect shell history to attacker-controlled path
  "HISTCONTROL",     // Can disable history dedup, forcing sensitive commands to persist

  // Library/runtime injection vectors
  "LD_PRELOAD",      // Injects shared libraries into every spawned process (Linux)
  "LD_LIBRARY_PATH", // Redirects dynamic linker search path (Linux)
  "DYLD_INSERT_LIBRARIES", // macOS equivalent of LD_PRELOAD

  // Language runtime abuse vectors
  "PYTHONSTARTUP",   // Python script executed on interpreter startup
  "NODE_OPTIONS",    // Injects Node.js CLI flags (--require, --inspect, etc.)
  "PERL5OPT",        // Injects Perl command-line options
  "RUBYOPT",         // Injects Ruby command-line options
  "COMP_WORDBREAKS", // Completion injection via word break manipulation

  // Claude Code nesting guard (added in CLI 2.1.70)
  "CLAUDECODE",      // Prevents "cannot launch inside another session" error
];

// Pattern-based stripping: env var keys matching these regexes are removed.
// Catches dynamic/numbered variants that a static list can't enumerate.
const STRIP_ENV_PATTERNS = [
  /^BASH_FUNC_/,     // Bash exported functions via env (Shellshock vector: CVE-2014-6271)
  /^LC_/,            // Locale vars that can trigger format string issues in child processes
];

// Critical shell escape vars that MUST never survive sanitization.
// Defense-in-depth: post-strip assertion checks these specifically.
const CRITICAL_SHELL_VARS = [
  "SHELLOPTS", "PS4", "BASH_ENV", "ENV", "HOME", "ZDOTDIR",
  "IFS", "PROMPT_COMMAND", "LD_PRELOAD", "BASH_XTRACEFD",
  "NODE_OPTIONS", "PYTHONSTARTUP",
];

/** Return a cleaned copy of process.env safe for spawned Claude CLI. */
export function sanitizedEnv(): Record<string, string | undefined> {
  const env = { ...process.env };

  // Phase 1: Strip exact-match dangerous vars
  for (const key of STRIP_ENV_VARS) {
    delete env[key];
  }

  // Phase 2: Strip pattern-matched vars (BASH_FUNC_*, LC_*, secrets)
  for (const key of Object.keys(env)) {
    // Credential pattern: any var containing SECRET, PASSWORD, or PRIVATE_KEY
    // (except ANTHROPIC_* which Claude CLI needs for auth)
    if (/SECRET|PASSWORD|PRIVATE_KEY/i.test(key) && !key.startsWith("ANTHROPIC")) {
      delete env[key];
      continue;
    }
    // Dynamic shell escape patterns (e.g. BASH_FUNC_x%%, LC_ALL, LC_CTYPE)
    for (const pattern of STRIP_ENV_PATTERNS) {
      if (pattern.test(key)) {
        delete env[key];
        break;
      }
    }
  }

  // Phase 3: Defense-in-depth assertion. If any critical shell var survived
  // stripping (e.g. due to a future refactor removing it from the list),
  // log a warning and force-delete it. This catches regressions.
  for (const key of CRITICAL_SHELL_VARS) {
    if (key in env) {
      warn("claude", `SECURITY: critical shell var "${key}" survived sanitization. Force-deleting.`);
      delete env[key];
    }
  }

  return env;
}

/**
 * OpenClaw 2.19 Windows security: Validate spawn arguments.
 * Rejects args containing CR/LF (command injection vector on Windows)
 * and warns on cmd metacharacters that could cause issues.
 */
export function validateSpawnArgs(args: string[]): void {
  for (const arg of args) {
    if (/[\r\n]/.test(arg)) {
      throw new Error(`Spawn arg contains CR/LF (potential injection): ${arg.substring(0, 50)}`);
    }
  }
}

/** OpenClaw 2.19: Max prompt payload size (2 MiB) to prevent OOM/excessive token burn. */
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;

/**
 * OpenClaw 2026.2.23 (Discord #e8a4d5d, Matrix #1298bd4): Strip reasoning tags
 * that may leak into text output as literal strings. These should never reach
 * Telegram or other user-facing surfaces.
 */
function stripReasoningTags(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
}

/** OpenClaw 2.19 (#20670): Strip prototype pollution keys from parsed JSON. */
const POISON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function safeParse(json: string): any {
  return JSON.parse(json, (key, value) => {
    if (POISON_KEYS.has(key)) return undefined;
    return value;
  });
}

// ============================================================
// SESSION MANAGEMENT (per-agent, per-user)
// ============================================================

export interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

const sessions: Map<string, SessionState> = new Map();

export function sessionKey(agentId: string, userId: string): string {
  return `${agentId}:${userId}`;
}

export function sessionFilePath(agentId: string, userId: string): string {
  return join(RELAY_DIR, `session-${agentId}-${userId}.json`);
}

export async function getSession(
  agentId: string,
  userId: string
): Promise<SessionState> {
  const key = sessionKey(agentId, userId);
  if (sessions.has(key)) return sessions.get(key)!;
  try {
    const content = await readFile(
      sessionFilePath(agentId, userId),
      "utf-8"
    );
    const state = safeParse(content);
    sessions.set(key, state);
    return state;
  } catch {
    const state: SessionState = {
      sessionId: null,
      lastActivity: new Date().toISOString(),
    };
    sessions.set(key, state);
    return state;
  }
}

/** Atomic write: write to temp file then rename to prevent partial writes on crash (OpenClaw #18347). */
export async function saveSessionState(
  agentId: string,
  userId: string,
  state: SessionState
): Promise<void> {
  sessions.set(sessionKey(agentId, userId), state);
  const target = sessionFilePath(agentId, userId);
  const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, target);
}

// ============================================================
// SESSION LOCKS (concurrency guard)
// ============================================================

interface LockState {
  locked: boolean;
  lockedAt: number; // timestamp when lock was acquired
  waiters: (() => void)[];
}

const sessionLocks: Map<string, LockState> = new Map();

// Maximum time a lock can be held before auto-release.
// Uses max model multiplier (opus=3.0) so long-running opus turns
// aren't force-unlocked mid-run (OpenClaw #18060).
const maxModelMultiplier = Math.max(...Object.values(MODEL_TIMEOUT_MULTIPLIERS));
const LOCK_TIMEOUT_MS = Math.round(parseInt(process.env.CLAUDE_MAX_WALL_MS || "900000", 10) * maxModelMultiplier) + 2 * 60_000;

// Maximum time a waiter will wait for the lock.
// Set to lock timeout + 2min so waiters outlive the lock holder.
const LOCK_WAIT_TIMEOUT_MS = LOCK_TIMEOUT_MS + 2 * 60_000;

function getLockState(key: string): LockState {
  if (!sessionLocks.has(key)) {
    sessionLocks.set(key, { locked: false, lockedAt: 0, waiters: [] });
  }
  return sessionLocks.get(key)!;
}

/**
 * Acquire a per-session lock.
 * - "wait": blocks until the lock is available (for user messages), with timeout
 * - "skip": returns immediately with acquired: false if locked (for heartbeat)
 */
export async function acquireSessionLock(
  key: string,
  behavior: "wait" | "skip"
): Promise<{ acquired: boolean; release: () => void }> {
  const lock = getLockState(key);

  const release = () => {
    lock.locked = false;
    lock.lockedAt = 0;
    if (lock.waiters.length > 0) {
      const next = lock.waiters.shift()!;
      lock.locked = true;
      lock.lockedAt = Date.now();
      next();
    }
  };

  // Check for stale lock: if held longer than LOCK_TIMEOUT_MS, force-release
  if (lock.locked && lock.lockedAt > 0 && Date.now() - lock.lockedAt > LOCK_TIMEOUT_MS) {
    warn("claude", `Session lock for ${key} held for ${Math.round((Date.now() - lock.lockedAt) / 1000)}s. Force-releasing stale lock.`);
    release();
  }

  if (!lock.locked) {
    lock.locked = true;
    lock.lockedAt = Date.now();
    return { acquired: true, release };
  }

  if (behavior === "skip") {
    return { acquired: false, release: () => {} };
  }

  // behavior === "wait": queue until lock is released, with timeout
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Remove this waiter from the queue
      const idx = lock.waiters.indexOf(waiterFn);
      if (idx >= 0) lock.waiters.splice(idx, 1);
      warn("claude", `Lock wait timeout for ${key} after ${LOCK_WAIT_TIMEOUT_MS / 1000}s. Force-releasing.`);
      // Force-release the lock so the next message can proceed
      release();
      resolve({ acquired: true, release });
    }, LOCK_WAIT_TIMEOUT_MS);

    const waiterFn = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ acquired: true, release });
    };
    lock.waiters.push(waiterFn);
  });
}

// ============================================================
// STREAM PARSER (reusable for callClaude + code agents)
// ============================================================

export interface StreamEvent {
  type: "system" | "assistant" | "result" | "thinking" | "text_delta";
  sessionId?: string;
  toolName?: string;
  toolInput?: Record<string, any>;
  isError?: boolean;
  errorSubtype?: string;
  resultText?: string;
  textDelta?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Reusable JSON-stream parser for Claude CLI output.
 * Handles line buffering, JSON parsing, and event extraction.
 * Both callClaude() and spawnCodeAgent() use this.
 */
export function createStreamParser(onEvent: (event: StreamEvent) => void) {
  let lineBuffer = "";

  return {
    /** Feed raw chunk data from the stream */
    feed(chunk: string): void {
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const raw = safeParse(trimmed);
          const sessionId = raw.session_id || undefined;

          switch (raw.type) {
            case "system":
              onEvent({ type: "system", sessionId });
              break;

            case "assistant":
              if (raw.message?.content) {
                for (const block of raw.message.content) {
                  if (block.type === "tool_use") {
                    onEvent({
                      type: "assistant",
                      sessionId,
                      toolName: block.name || "unknown",
                      toolInput: block.input,
                    });
                  }
                  // OpenClaw #20635: Handle thinking blocks in assistant messages
                  if (block.type === "thinking" || block.type === "redacted_thinking") {
                    onEvent({ type: "thinking", sessionId });
                  }
                }
              }
              break;

            // OpenClaw #20635: Handle native thinking_* stream events
            case "thinking":
            case "thinking_delta":
            case "thinking_stop":
              onEvent({ type: "thinking", sessionId });
              break;

            // Handle content_block events (partial streaming)
            // OpenClaw #20774: Track content blocks as activity. All content block
            // events indicate active work and should reset the inactivity timer.
            case "content_block_start":
            case "content_block_stop":
              onEvent({ type: "thinking", sessionId }); // signal activity to keep timer alive
              break;
            case "content_block_delta":
              // All deltas indicate active work (reasoning, text generation, tool use)
              onEvent({ type: "thinking", sessionId });
              // Extract text deltas for streaming delivery
              if (raw.delta?.type === "text_delta" && raw.delta.text) {
                onEvent({ type: "text_delta", sessionId, textDelta: raw.delta.text });
              }
              break;

            case "result":
              onEvent({
                type: "result",
                sessionId,
                resultText: raw.result || "",
                isError: !!raw.is_error,
                errorSubtype: raw.subtype,
                inputTokens: raw.usage?.input_tokens || 0,
                outputTokens: raw.usage?.output_tokens || 0,
              });
              break;
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    },

    /** Flush remaining buffer (call after stream ends) */
    flush(): void {
      if (lineBuffer.trim()) {
        // Try to parse any remaining buffered data
        try {
          const raw = safeParse(lineBuffer.trim());
          if (raw.type === "result") {
            onEvent({
              type: "result",
              sessionId: raw.session_id,
              resultText: raw.result || "",
              isError: !!raw.is_error,
              errorSubtype: raw.subtype,
              inputTokens: raw.usage?.input_tokens || 0,
              outputTokens: raw.usage?.output_tokens || 0,
            });
          }
        } catch {
          // Not valid JSON
        }
        lineBuffer = "";
      }
    },
  };
}

// ============================================================
// CORE: Call Claude CLI
// ============================================================

// Inactivity timeout: kill if Claude goes silent for this long.
// Base 180s x opus 3.0 = 540s (9 min). Previous 120s base gave 360s which
// killed skills mid-execution (youtube-transcribe, TTS, long tool calls).
const INACTIVITY_TIMEOUT_MS = parseInt(
  process.env.CLAUDE_INACTIVITY_MS || "180000",
  10
);

// Absolute wall-clock cap (safety net)
const MAX_WALL_CLOCK_MS = parseInt(
  process.env.CLAUDE_MAX_WALL_MS || "900000",
  10
);

// How often to send "still working" status to Telegram
const STATUS_INTERVAL_MS = 60_000;

// Runtime override for base timeout (set via /timeout command)
let runtimeTimeoutOverride: number | null = null;

export function setRuntimeTimeout(ms: number | null): void {
  runtimeTimeoutOverride = ms;
}

export function getEffectiveTimeout(modelTier: string): number {
  const base = runtimeTimeoutOverride ?? CLAUDE_TIMEOUT_MS;
  const multiplier = MODEL_TIMEOUT_MULTIPLIERS[modelTier] ?? 1.0;
  return Math.round(base * multiplier);
}

export async function callClaude(
  prompt: string,
  options?: {
    resume?: boolean;
    imagePath?: string;
    imageBase64?: string; // base64-encoded image data for inline passing
    imageMimeType?: string; // MIME type of the image (e.g. "image/jpeg")
    model?: ModelTier;
    agentId?: string;
    userId?: string;
    lockBehavior?: "wait" | "skip";
    skipLock?: boolean; // caller already holds the session lock
    isolated?: boolean; // don't persist session ID back (cron/background jobs)
    onTyping?: () => void;
    onStatus?: (msg: string) => void;
    onTextDelta?: (text: string) => void; // streaming text deltas for progressive delivery
    onCodeTaskCaptured?: (tasks: Array<{ cwd: string; prompt: string; timeoutMs?: number }>) => void;
    mcpIntentFlags?: Record<string, boolean>; // intent flags for dynamic MCP server selection
    workspaceDir?: string; // per-agent workspace directory (overrides cwd for Claude CLI)
    _isFallback?: boolean; // internal: tracks fallback depth to prevent infinite chains
    _fallbackDepth?: number; // internal: how many fallbacks have been attempted (max 2: opus->sonnet->haiku)
    _isEmptyRetry?: boolean; // internal: prevents infinite empty-result retries
    _isSpawnRetry?: boolean; // internal: prevents infinite spawn-error retries
  }
): Promise<string> {
  const modelTier = options?.model || DEFAULT_MODEL;
  const modelId = MODELS[modelTier];
  const agentId = options?.agentId || "atlas";
  const userId = options?.userId || process.env.TELEGRAM_USER_ID || "";
  const lockBehavior = options?.lockBehavior || "wait";

  // Acquire session lock (unless caller already holds it)
  const key = sessionKey(agentId, userId);
  let release: () => void;

  if (options?.skipLock) {
    release = () => {}; // caller manages the lock
  } else {
    const lock = await acquireSessionLock(key, lockBehavior);
    if (!lock.acquired) {
      return ""; // Caller checks for empty string (heartbeat skips)
    }
    release = lock.release;
  }

  // Hoist so finally can always clean up
  let typingInterval: ReturnType<typeof setInterval> | null = null;

  // Track active call for polling watchdog (prevents false-positive shutdown during long calls)
  activeClaudeCalls++;

  try {
    const session = await getSession(agentId, userId);
    // Prompt is piped via stdin to avoid Windows ENAMETOOLONG (~32K char limit).
    const args = [CLAUDE_PATH, "-p"];

    if (options?.resume && session.sessionId) {
      args.push("--resume", session.sessionId);
    }

    // When image data is present, use stream-json input format to pass image content blocks
    const hasInlineImage = !!(options?.imageBase64 && options?.imageMimeType);
    if (hasInlineImage) {
      args.push("--input-format", "stream-json");
    }

    args.push(
      "--output-format", "stream-json",
      "--verbose",
      "--model", modelId,
      "--dangerously-skip-permissions"
      // Tool restrictions removed. Opus 4.6 is disciplined enough to use
      // Bash/Write/Edit without looping. The old restriction was a workaround
      // for weaker models (Sonnet/Haiku) that would enter edit loop storms.
      // Main session now has full tool access, matching interactive Claude Code.
    );

    // MCP servers: dynamic selection based on intent (Phase B)
    if (options?.mcpIntentFlags) {
      args.push(...buildMcpConfigArgs(options.mcpIntentFlags));
    }

    // OpenClaw 2.19: Validate spawn args (reject CR/LF injection)
    validateSpawnArgs(args);

    // OpenClaw 2.19: Cap prompt payload size to prevent OOM/excessive token burn
    const promptBytes = Buffer.byteLength(prompt, "utf-8");
    if (promptBytes > MAX_PROMPT_BYTES) {
      warn("claude", `[${agentId}] Prompt exceeds ${MAX_PROMPT_BYTES / 1024 / 1024}MiB (${Math.round(promptBytes / 1024)}KiB). Truncating.`);
      // Truncate to fit. Slice by chars (approximate, but safe)
      const ratio = MAX_PROMPT_BYTES / promptBytes;
      prompt = prompt.substring(0, Math.floor(prompt.length * ratio));
    }

    const effectiveTimeout = getEffectiveTimeout(modelTier);

    // OpenClaw-inspired differential timeouts: resumed sessions get much shorter
    // timeouts than fresh sessions. A resumed session already has context loaded,
    // so if it goes silent for >60s or runs >3min, it's stuck, not thinking.
    // Fresh sessions legitimately take longer (cold start, tool exploration).
    const modelMultiplier = MODEL_TIMEOUT_MULTIPLIERS[modelTier] ?? 1.0;
    const isResuming = !!(options?.resume && session.sessionId);
    // Resume penalty: tighter timeouts for resumed sessions since context is
    // already loaded. Originally 0.3/0.33 but that caused false-positive kills
    // on complex tasks dispatched within resumed sessions (skills, audits, CRO
    // analysis). Bumped to 1.0/0.5 so inactivity detection uses the full base
    // window (360s opus) while wall clock stays disciplined (22.5 min opus).
    const RESUME_INACTIVITY_RATIO = 1.0; // no penalty — base timeout already catches stuck sessions
    const RESUME_WALL_RATIO = 0.5;       // 50% of fresh wall timeout

    const effectiveInactivityMs = isResuming
      ? Math.round(INACTIVITY_TIMEOUT_MS * modelMultiplier * RESUME_INACTIVITY_RATIO)
      : Math.round(INACTIVITY_TIMEOUT_MS * modelMultiplier);
    const effectiveWallClockMs = isResuming
      ? Math.round(MAX_WALL_CLOCK_MS * modelMultiplier * RESUME_WALL_RATIO)
      : Math.round(MAX_WALL_CLOCK_MS * modelMultiplier);

    info(
      "claude",
      `[${agentId}] Calling ${modelTier}: ${prompt.substring(0, 80)}... (inactivity: ${Math.round(effectiveInactivityMs / 1000)}s, wall: ${Math.round(effectiveWallClockMs / 1000)}s${isResuming ? ", RESUME" : ""})`
    );
    const startTime = Date.now();

    const proc = spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: options?.workspaceDir || PROJECT_DIR || PROJECT_ROOT,
      env: sanitizedEnv(),
      windowsHide: true,
    });

    // Register for queue interrupt mode
    activeProcesses.set(key, {
      pid: proc.pid ?? 0,
      kill: () => { try { proc.kill("SIGTERM"); } catch {} },
    });

    // Pipe prompt via stdin (avoids Windows command-line length limits)
    // When image data is present, use stream-json format with content blocks
    if (hasInlineImage) {
      // Build content blocks array: image first, then text (per Anthropic Vision API)
      const contentBlocks = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: options!.imageMimeType,
            data: options!.imageBase64,
          },
        },
        {
          type: "text",
          text: prompt,
        },
      ];
      // stream-json input format: Claude CLI SDK expects nested message structure
      const userMessage = {
        type: "user",
        message: {
          role: "user",
          content: contentBlocks,
        },
        parent_tool_use_id: null,
      };
      proc.stdin.write(JSON.stringify(userMessage) + "\n");
      info("claude", `[${agentId}] Sending image inline via stream-json (${Math.round(options!.imageBase64!.length / 1024)}KB base64)`);
    } else {
      proc.stdin.write(prompt);
    }
    proc.stdin.end();

    // Keep Telegram typing indicator alive every 4s while waiting
    if (options?.onTyping) {
      typingInterval = setInterval(() => options.onTyping!(), 4000);
    }

    // Stream-JSON parsing via reusable stream parser
    let resultText = "";
    let sessionId = "";
    let lastActivityAt = Date.now();
    let lastStatusAt = Date.now();
    let timeoutReason = "";
    let isError = false;
    let errorInfo = "";
    let gotResultEvent = false;
    let toolCallCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    // Progress-aware phased loop detection (OpenClaw #16808).
    // Phases: hard-block known no-progress loops, warn on identical repeats,
    // detect ping-pong alternation (A-B-A-B), global circuit breaker.
    // Read is excluded: targeted file retrieval is progress, not fruitless searching.
    // Search tools are discovery/scanning. Only count these for fruitless search detection.
    const SEARCH_TOOLS = new Set(["Glob", "Grep", "Search", "ListDirectory"]);
    const NO_PROGRESS_TOOLS = new Set(["process"]); // known no-progress loops (poll/log)
    // Tools that legitimately repeat with similar inputs. Excluded from duplicate detection.
    // Read: targeted file retrieval is progress. TodoWrite: state tracking, called every task transition.
    // Bash: build/check commands repeat legitimately (checked separately via consecutive window).
    const DUPE_EXEMPT_TOOLS = new Set(["Read", "TodoWrite", "Bash"]);
    const toolCallSignatures: string[] = []; // "ToolName:inputHash" for dedup detection
    const DUPLICATE_THRESHOLD = 4; // same exact call 4+ times in recent window = stuck
    const DUPLICATE_WINDOW = 10; // only check last N calls for duplicates (not all-time)
    const BASH_CONSECUTIVE_THRESHOLD = 5; // 5 identical consecutive Bash calls = stuck
    const FRUITLESS_SEARCH_THRESHOLD = 12; // 12+ consecutive search calls without any non-search call = warn
    const PINGPONG_THRESHOLD = 10; // A-B-A-B alternation 10 times = stuck
    const GLOBAL_CIRCUIT_BREAKER = 30; // 30 no-progress repeats across all patterns = kill
    let consecutiveSearchCalls = 0;
    let noProgressRepeats = 0; // global counter for no-progress repeated calls
    let warningInjected = false; // true if we already sent a "slow down" signal
    let lastTwoSigs: string[] = []; // track last 2 sigs for ping-pong detection
    let pingPongCount = 0; // consecutive A-B-A-B alternations

    const parser = createStreamParser((event) => {
      if (event.sessionId) sessionId = event.sessionId;

      switch (event.type) {
        case "assistant":
          toolCallCount++;
          // Loop detection: kill process if tool calls exceed threshold
          if (toolCallCount > MAX_TOOL_CALLS_PER_REQUEST) {
            warn("claude", `[${agentId}] Tool call loop detected: ${toolCallCount} calls (limit: ${MAX_TOOL_CALLS_PER_REQUEST}). Killing process.`);
            proc.kill();
            timeoutReason = `tool call loop (${toolCallCount} calls)`;
            break;
          }
          // Progress-aware phased loop detection (OpenClaw #16808)
          {
            const toolName = event.toolName || "unknown";
            const isSearch = SEARCH_TOOLS.has(toolName);
            const toolAction = event.toolInput?.action as string | undefined;

            // Build a signature from tool name + key input to detect duplicate calls
            // Use 500 chars (was 200) to reduce false collisions on tools like TodoWrite
            // where the differentiating content (status changes) appears later in the JSON
            const inputStr = event.toolInput ? JSON.stringify(event.toolInput).substring(0, 500) : "";
            const sig = `${toolName}:${inputStr}`;
            toolCallSignatures.push(sig);

            // Phase 1: Hard-block known no-progress loops (e.g. process(action=poll|log))
            if (NO_PROGRESS_TOOLS.has(toolName) && (toolAction === "poll" || toolAction === "log")) {
              const recentNoProgress = toolCallSignatures.slice(-5).filter(s => s === sig).length;
              if (recentNoProgress >= 3) {
                warn("claude", `[${agentId}] No-progress loop: "${toolName}(${toolAction})" repeated ${recentNoProgress}x in last 5 calls. Killing.`);
                proc.kill();
                timeoutReason = `no-progress loop (${toolName}.${toolAction})`;
                break;
              }
            }

            // Phase 1.5: Consecutive identical Bash detection (separate from general dupes)
            // Bash legitimately repeats different commands but identical consecutive runs = stuck
            if (toolName === "Bash") {
              const recent = toolCallSignatures.slice(-BASH_CONSECUTIVE_THRESHOLD);
              if (recent.length >= BASH_CONSECUTIVE_THRESHOLD && recent.every(s => s === sig)) {
                warn("claude", `[${agentId}] Bash loop: identical command repeated ${BASH_CONSECUTIVE_THRESHOLD}x consecutively at call #${toolCallCount}. Killing.`);
                proc.kill();
                timeoutReason = `duplicate call loop (Bash x${BASH_CONSECUTIVE_THRESHOLD})`;
                noProgressRepeats += BASH_CONSECUTIVE_THRESHOLD;
                break;
              }
            }

            // Phase 2: Detect exact duplicate calls (same tool + same input repeated)
            // Skip exempt tools (Read, TodoWrite, Bash - handled above or legitimately repeat)
            // Use sliding window (last DUPLICATE_WINDOW calls) instead of all-time to avoid
            // false positives from spread-out repeated calls across long sessions
            if (!DUPE_EXEMPT_TOOLS.has(toolName)) {
              const window = toolCallSignatures.slice(-DUPLICATE_WINDOW);
              const dupeCount = window.filter(s => s === sig).length;
              if (dupeCount >= DUPLICATE_THRESHOLD) {
                warn("claude", `[${agentId}] Duplicate call loop: "${toolName}" called ${dupeCount} times in last ${DUPLICATE_WINDOW} calls at call #${toolCallCount}. Killing.`);
                proc.kill();
                timeoutReason = `duplicate call loop (${toolName} x${dupeCount})`;
                noProgressRepeats += dupeCount;
                break;
              }
            }

            // Phase 3: Ping-pong alternation detection (A-B-A-B)
            if (lastTwoSigs.length >= 2) {
              const [prevPrev, prev] = lastTwoSigs;
              if (sig === prevPrev && sig !== prev) {
                pingPongCount++;
                if (pingPongCount >= PINGPONG_THRESHOLD) {
                  const otherSig = prev.split(":")[0];
                  warn("claude", `[${agentId}] Ping-pong loop: "${toolName}" <-> "${otherSig}" alternating ${pingPongCount}x at call #${toolCallCount}. Killing.`);
                  proc.kill();
                  timeoutReason = `ping-pong loop (${toolName} <-> ${otherSig})`;
                  break;
                }
              } else {
                pingPongCount = 0;
              }
            }
            lastTwoSigs = [lastTwoSigs.length > 0 ? lastTwoSigs[lastTwoSigs.length - 1] : "", sig];

            // Phase 4: Track no-progress repeats for global circuit breaker
            // Use windowed count for non-exempt tools, skip exempt ones for this counter
            const windowDupeCount = DUPE_EXEMPT_TOOLS.has(toolName) ? 0 : toolCallSignatures.slice(-DUPLICATE_WINDOW).filter(s => s === sig).length;
            if (windowDupeCount > 1) noProgressRepeats++;
            if (noProgressRepeats >= GLOBAL_CIRCUIT_BREAKER) {
              warn("claude", `[${agentId}] Global circuit breaker: ${noProgressRepeats} no-progress repeats across all patterns at call #${toolCallCount}. Killing.`);
              proc.kill();
              timeoutReason = `global circuit breaker (${noProgressRepeats} no-progress)`;
              break;
            }

            // Track consecutive search calls for fruitless search detection
            if (isSearch) {
              consecutiveSearchCalls++;
            } else {
              consecutiveSearchCalls = 0; // reset on any non-search tool
            }

            // After many consecutive search calls, log a warning but don't kill.
            if (consecutiveSearchCalls === FRUITLESS_SEARCH_THRESHOLD && !warningInjected) {
              warningInjected = true;
              warn("claude", `[${agentId}] ${FRUITLESS_SEARCH_THRESHOLD} consecutive search calls without progress. Monitoring but not killing yet.`);
              if (options?.onStatus) {
                options.onStatus(`Deep searching... (${toolCallCount} tool calls, still working)`);
              }
            }

            // Escalation: if search calls double the threshold without progress, kill.
            // 16+ consecutive searches with no other tool = definitively stuck in a loop.
            const FRUITLESS_SEARCH_KILL_THRESHOLD = FRUITLESS_SEARCH_THRESHOLD * 2;
            if (consecutiveSearchCalls >= FRUITLESS_SEARCH_KILL_THRESHOLD) {
              warn("claude", `[${agentId}] ${consecutiveSearchCalls} consecutive search calls without progress. Search loop detected. Killing.`);
              proc.kill();
              timeoutReason = `fruitless search loop (${consecutiveSearchCalls} consecutive searches)`;
              break;
            }
          }
          // Send progress indicator on tool use (phase-specific status)
          {
            const now = Date.now();
            if (now - lastStatusAt > STATUS_INTERVAL_MS && options?.onStatus) {
              const elapsed = Math.round((now - startTime) / 1000);
              const phase = TOOL_PHASE_NAMES[event.toolName || ""] || event.toolName || "Working";
              options.onStatus(`${phase}... (${elapsed}s, ${toolCallCount} tools)`);
              lastStatusAt = now;
            }
          }
          // TodoWrite interception: capture CODE_TASK entries from structured tool calls.
          // This is more reliable than text tag parsing because tool calls are structured JSON.
          if (event.toolName === "TodoWrite" && event.toolInput?.todos && options?.onCodeTaskCaptured) {
            const todos = event.toolInput.todos as Array<{ content: string; status: string }>;
            const captured: Array<{ cwd: string; prompt: string; timeoutMs?: number }> = [];
            for (const todo of todos) {
              if (typeof todo.content === "string" && todo.content.startsWith("CODE_TASK:")) {
                const parsed = parseCodeTaskFromTodoContent(todo.content);
                if (parsed) captured.push(parsed);
              }
            }
            if (captured.length > 0) {
              info("claude", `[${agentId}] TodoWrite interception: captured ${captured.length} code task(s)`);
              options.onCodeTaskCaptured(captured);
            }
          }
          break;

        // OpenClaw #20635: Thinking events keep session alive during extended reasoning
        case "thinking":
          lastActivityAt = Date.now();
          break;

        case "text_delta":
          lastActivityAt = Date.now();
          if (event.textDelta && options?.onTextDelta) {
            options.onTextDelta(event.textDelta);
          }
          break;

        case "result":
          gotResultEvent = true;
          resultText = event.resultText || "";
          if (event.isError) {
            isError = true;
            errorInfo = event.errorSubtype || "unknown error";
          } else {
            // OpenClaw #20635: Clear stale error state after successful result
            // (handles case where tool retry succeeds after earlier failure)
            if (isError && resultText.trim()) {
              isError = false;
              errorInfo = "";
            }
          }
          inputTokens = event.inputTokens || 0;
          outputTokens = event.outputTokens || 0;
          break;
      }
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    const readLoop = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          lastActivityAt = Date.now();
          parser.feed(chunk);

          // Periodic status (for non-tool-use periods: reasoning, generating)
          const now = Date.now();
          if (now - lastStatusAt > STATUS_INTERVAL_MS && options?.onStatus) {
            const elapsed = Math.round((now - startTime) / 1000);
            const phase = toolCallCount > 0 ? "Thinking" : "Starting up";
            options.onStatus(`${phase}... (${elapsed}s)`);
            lastStatusAt = now;
          }
        }
        parser.flush();
      } catch {
        // Stream closed or errored, handled below
      }
    })();

    // Watchdog: checks inactivity and wall clock periodically
    const watchdog = new Promise<"timeout">((resolve) => {
      const check = setInterval(() => {
        const now = Date.now();
        const wallElapsed = now - startTime;
        const idleElapsed = now - lastActivityAt;

        if (wallElapsed > effectiveWallClockMs) {
          timeoutReason = `wall clock exceeded (${Math.round(wallElapsed / 1000)}s)`;
          clearInterval(check);
          resolve("timeout");
        } else if (idleElapsed > effectiveInactivityMs) {
          timeoutReason = `inactive for ${Math.round(idleElapsed / 1000)}s (limit: ${Math.round(effectiveInactivityMs / 1000)}s)`;
          clearInterval(check);
          resolve("timeout");
        }
      }, 5000); // Check every 5 seconds

      // Also resolve when readLoop finishes (process exited)
      readLoop.then(() => clearInterval(check));
    });

    const raceResult = await Promise.race([
      (async () => {
        await readLoop;
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stderr, exitCode } as const;
      })(),
      watchdog,
    ]);

    if (raceResult === "timeout") {
      proc.kill();
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      trackTimeout();
      const isLoop = timeoutReason.includes("tool call loop") || timeoutReason.includes("duplicate call loop");
      logError("claude", `${isLoop ? "Loop killed" : "Timed out"} after ${elapsed}s: ${timeoutReason}`, {
        prompt: prompt.substring(0, 200),
        model: modelTier,
        toolCallCount,
      });
      if (timeoutReason.includes("duplicate call loop")) {
        return `I got stuck repeating the same operation (${timeoutReason}). Try rephrasing or breaking this into smaller steps.`;
      }
      if (isLoop) {
        return `Hit the tool call limit (${toolCallCount} calls). For complex tasks like this, try the /code command or break it into smaller pieces.`;
      }
      return `Sorry, that took too long (${timeoutReason}). Try again or simplify your request.`;
    }

    const durationMs = Date.now() - startTime;

    // Calculate cost from token usage
    const costRates = TOKEN_COSTS[modelTier] || TOKEN_COSTS.sonnet;
    const callCostUsd = (inputTokens * costRates.input + outputTokens * costRates.output) / 1_000_000;

    trackClaudeCall(durationMs, {
      model: modelTier,
      inputTokens,
      outputTokens,
      costUsd: callCostUsd,
    });

    const { stderr, exitCode } = raceResult;

    if (exitCode !== 0) {
      const wasResuming = options?.resume && session.sessionId;
      const stderrEmpty = !stderr.trim();
      const stderrLower = stderr.toLowerCase();

      logError("claude", `Exit code ${exitCode}: ${stderr.substring(0, 200)}`);

      // Tool call loop: process was killed by our own loop detector (SIGTERM = 143)
      if (timeoutReason.includes("tool call loop") || timeoutReason.includes("duplicate call loop")) {
        trackTimeout();
        const elapsed = Math.round(durationMs / 1000);
        logError("claude", `Loop killed after ${elapsed}s: ${timeoutReason}`, {
          prompt: prompt.substring(0, 200),
          model: modelTier,
          toolCallCount,
        });

        // Clear the session so next message starts fresh (loop often means bad session state)
        // Skip for isolated sessions (don't touch the shared session)
        if (session.sessionId && !options?.isolated) {
          const oldSid = session.sessionId;
          warn("claude", `[${agentId}] Clearing session ${oldSid} after tool call loop`);
          session.sessionId = null;
          session.lastActivity = new Date().toISOString();
          await saveSessionState(agentId, userId, session);
          archiveSessionTranscript(oldSid, agentId, userId).catch(() => {});
        }

        if (timeoutReason.includes("duplicate call loop")) {
          return `I got stuck repeating the same operation (${timeoutReason}). Try rephrasing or breaking this into smaller steps.`;
        }
        return `Hit the tool call limit (${toolCallCount} calls). For complex tasks like this, try the /code command or break it into smaller pieces.`;
      }

      // Model fallback: if rate-limited or model unavailable, retry with next tier
      const isRateLimit = stderrLower.includes("rate limit") || stderrLower.includes("429") || stderrLower.includes("overloaded");
      const isModelError = stderrLower.includes("model") && (stderrLower.includes("unavailable") || stderrLower.includes("not found") || stderrLower.includes("capacity"));
      const fallbackModel = MODEL_FALLBACK[modelTier];

      // OpenClaw #18210: Multi-hop fallback chain (opus -> sonnet -> haiku), max 2 hops
      const fallbackDepth = (options as any)?._fallbackDepth || 0;
      if ((isRateLimit || isModelError) && fallbackModel && fallbackDepth < 2) {
        warn("claude", `[${agentId}] ${modelTier} failed (${isRateLimit ? "rate limit" : "model error"}), falling back to ${fallbackModel} (depth ${fallbackDepth + 1})`);

        if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }

        return callClaude(prompt, {
          ...options,
          model: fallbackModel,
          skipLock: options?.skipLock ?? false,
          _isFallback: true,
          _fallbackDepth: fallbackDepth + 1,
        } as any);
      }

      // Auto-recover: if resume caused a crash with no stderr, the session
      // is likely corrupted. Clear it and retry once without --resume.
      if (wasResuming && stderrEmpty && exitCode === 1) {
        const oldSid = session.sessionId;
        warn("claude", `[${agentId}] Session ${oldSid} appears corrupted (exit 1, empty stderr). Clearing and retrying without resume.`);
        session.sessionId = null;
        session.lastActivity = new Date().toISOString();
        await saveSessionState(agentId, userId, session);
        archiveSessionTranscript(oldSid!, agentId, userId).catch(() => {});

        // Note in conversation buffer that session was reset (so Claude knows context may be incomplete)
        await addEntry(key, {
          role: "system",
          content: "Session was reset due to an error. Previous conversation context may be incomplete.",
          timestamp: new Date().toISOString(),
        });

        // Clear typing interval before recursive retry (lock stays with caller if skipLock)
        if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }

        // Inject conversation context into retry prompt (original prompt was built for resume = no context)
        const corruptConvoCtx = await formatForPrompt(key);
        const corruptRetryPrompt = corruptConvoCtx ? `${corruptConvoCtx}\n\n${prompt}` : prompt;

        return callClaude(corruptRetryPrompt, {
          ...options,
          resume: false,  // Force fresh session
          skipLock: options?.skipLock ?? false,
        });
      }

      // OpenClaw #18425: Non-zero exit with captured output = completed-with-errors.
      // Claude CLI exits non-zero when tool calls fail but still produces useful results.
      // Return the result text instead of discarding it.
      if (resultText.trim()) {
        warn("claude", `[${agentId}] Non-zero exit (${exitCode}) but has result text (${resultText.length} chars). Treating as completed.`);
        // Still update session state normally
        if (sessionId && !options?.isolated) {
          session.sessionId = sessionId;
          session.lastActivity = new Date().toISOString();
          await saveSessionState(agentId, userId, session);
        }
        // Fall through to normal result handling below
      } else {
        // OpenClaw #20510: Include model in error messages for billing/rate-limit triage
        return `Error (${modelTier}): ${stderr || "Claude exited with code " + exitCode}`;
      }
    }

    // Warn if process exited without a result event (CLI bug #1920)
    if (!gotResultEvent) {
      warn("claude", `[${agentId}] Process exited without result event (CLI bug #1920). Using any captured text.`);
    }

    info(
      "claude",
      `[${agentId}] Responded in ${Math.round(durationMs / 1000)}s (${modelTier}) | ` +
      `${inputTokens}in/${outputTokens}out | $${callCostUsd.toFixed(4)} | ${toolCallCount} tools`
    );

    // Save session ID (skip for isolated/cron sessions to prevent contamination)
    if (sessionId && !options?.isolated) {
      session.sessionId = sessionId;
      session.lastActivity = new Date().toISOString();
      await saveSessionState(agentId, userId, session);
    }

    // Handle errors
    if (isError && !resultText) {
      logError("claude", `Execution error: ${errorInfo}`);
      return `Claude ran into an issue during execution. No output was produced. Try again or rephrase.`;
    }

    // Retry once on empty result with clean exit (CLI bug #1920: no result event)
    if (!resultText.trim() && !isError && !options?._isEmptyRetry) {
      warn("claude", `[${agentId}] Empty result with clean exit (CLI bug #1920). Retrying without resume.`);

      // Clear potentially corrupted session (skip for isolated sessions)
      if (session.sessionId && !options?.isolated) {
        const oldSid = session.sessionId;
        session.sessionId = null;
        session.lastActivity = new Date().toISOString();
        await saveSessionState(agentId, userId, session);
        archiveSessionTranscript(oldSid, agentId, userId).catch(() => {});
      }

      // Note in conversation buffer that session was reset
      await addEntry(key, {
        role: "system",
        content: "Session was reset due to empty CLI response (bug #1920). Previous conversation context may be incomplete.",
        timestamp: new Date().toISOString(),
      });

      // Clear typing interval before retry (lock stays with caller if skipLock)
      if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }

      // Inject conversation context into retry prompt (original prompt was built for resume = no context)
      const emptyConvoCtx = await formatForPrompt(key);
      const emptyRetryPrompt = emptyConvoCtx ? `${emptyConvoCtx}\n\n${prompt}` : prompt;

      return callClaude(emptyRetryPrompt, {
        ...options,
        resume: false,
        skipLock: options?.skipLock ?? false,
        _isEmptyRetry: true,
      });
    }

    // OpenClaw 2026.2.23: Strip reasoning tags before returning to user
    return stripReasoningTags(resultText) || "No response generated.";
  } catch (err) {
    logError("claude", `Spawn error: ${err}`);

    // Auto-retry once on transient spawn errors (ENAMETOOLONG, EPERM, etc.)
    if (!options?._isSpawnRetry) {
      warn("claude", `[${agentId}] Spawn failed, retrying in 2s: ${err}`);
      await new Promise((r) => setTimeout(r, 2000));
      return callClaude(prompt, {
        ...options,
        resume: false, // fresh session on retry
        skipLock: options?.skipLock ?? false,
        _isSpawnRetry: true,
      });
    }

    // Second spawn failure: notify user with actionable message
    logError("claude", `[${agentId}] Spawn failed twice: ${err}`);
    return "I couldn't start the Claude CLI. This is usually a transient Windows issue. Try sending your message again in a moment.";
  } finally {
    activeClaudeCalls--;
    activeProcesses.delete(key);
    if (typingInterval) clearInterval(typingInterval);
    release();
  }
}

// ============================================================
// SESSION TRANSCRIPT ARCHIVAL
// ============================================================

const SESSION_ARCHIVE_DIR = join(RELAY_DIR, "session-archive");

/** Log a session ID to the archive when a session is reset, for audit trail. */
export async function archiveSessionTranscript(
  sessionId: string,
  agentId: string,
  userId: string
): Promise<void> {
  try {
    await mkdir(SESSION_ARCHIVE_DIR, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId,
      agentId,
      userId,
    });
    await appendFile(join(SESSION_ARCHIVE_DIR, "archive-log.jsonl"), entry + "\n");
    info("session", `Archived session ${sessionId} for ${agentId}/${userId}`);
  } catch (err) {
    logError("session", `Failed to archive session: ${err}`);
  }
}

/**
 * Structured session cleanup (OpenClaw cleanup tooling).
 * Consolidates all session reset steps into one function:
 * 1. Archives the session transcript
 * 2. Clears session state (nullifies sessionId)
 * 3. Adds a system note to the conversation buffer
 * 4. Logs the cleanup action
 *
 * Replaces ad-hoc session clearing scattered across callClaude().
 */
export async function cleanupSession(
  agentId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const key = sessionKey(agentId, userId);
  const session = await getSession(agentId, userId);

  if (!session.sessionId) {
    info("session", `[cleanup] No active session for ${key}, nothing to clean`);
    return;
  }

  const oldSid = session.sessionId;
  info("session", `[cleanup] Cleaning session ${oldSid} for ${key}: ${reason}`);

  // 1. Archive transcript
  await archiveSessionTranscript(oldSid, agentId, userId).catch(() => {});

  // 2. Clear session state
  session.sessionId = null;
  session.lastActivity = new Date().toISOString();
  await saveSessionState(agentId, userId, session);

  // 3. Note in conversation buffer
  await addEntry(key, {
    role: "system",
    content: `Session reset: ${reason}. Previous context may be incomplete.`,
    timestamp: new Date().toISOString(),
  });

  info("session", `[cleanup] Session ${oldSid} cleaned: ${reason}`);
}

/**
 * Check if a session has been idle too long and auto-reset it.
 * Called before lock acquisition on each new user message.
 * Returns true if session was reset.
 */
export async function checkIdleReset(
  agentId: string,
  userId: string,
  thresholdMs: number = SESSION_IDLE_RESET_MS,
): Promise<boolean> {
  const session = await getSession(agentId, userId);
  if (!session.sessionId) return false;

  const lastActive = new Date(session.lastActivity).getTime();
  const idleMs = Date.now() - lastActive;

  if (idleMs >= thresholdMs) {
    const idleHours = (idleMs / 3_600_000).toFixed(1);
    info("session", `[idle-reset] ${agentId}:${userId} idle ${idleHours}h. Auto-resetting.`);
    await cleanupSession(agentId, userId, `idle ${idleHours}h (threshold: ${Math.round(thresholdMs / 3_600_000)}h)`);
    return true;
  }
  return false;
}
