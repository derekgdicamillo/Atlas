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
import { MODELS, DEFAULT_MODEL, TOKEN_COSTS, MAX_TOOL_CALLS_PER_REQUEST, type ModelTier } from "./constants.ts";
import { addEntry } from "./conversation.ts";

// ============================================================
// CONFIGURATION
// ============================================================

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

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
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const PROJECT_ROOT = dirname(dirname(import.meta.path));
const RELAY_DIR =
  process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
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
  "GHL_API_TOKEN", "GHL_WEBHOOK_SECRET",
  "SUPABASE_SERVICE_KEY", "SUPABASE_KEY",
  "DASHBOARD_API_TOKEN",
  "OPENAI_API_KEY",
  "GOOGLE_CLIENT_SECRET",
  // Atlas tokens that Claude CLI doesn't need
  "TELEGRAM_BOT_TOKEN",
  "ISHTAR_BOT_TOKEN", // OpenClaw 2.19 security: strip all bot tokens from child envs
  "GROQ_API_KEY",
];

/** Return a cleaned copy of process.env safe for spawned Claude CLI. */
export function sanitizedEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of STRIP_ENV_VARS) {
    delete env[key];
  }
  // Also strip any var whose key contains "SECRET" or "PASSWORD" (defensive)
  for (const key of Object.keys(env)) {
    if (/SECRET|PASSWORD|PRIVATE_KEY/i.test(key) && !key.startsWith("ANTHROPIC")) {
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
function validateSpawnArgs(args: string[]): void {
  for (const arg of args) {
    if (/[\r\n]/.test(arg)) {
      throw new Error(`Spawn arg contains CR/LF (potential injection): ${arg.substring(0, 50)}`);
    }
  }
}

/** OpenClaw 2.19: Max prompt payload size (2 MiB) to prevent OOM/excessive token burn. */
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;

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
  type: "system" | "assistant" | "result" | "thinking";
  sessionId?: string;
  toolName?: string;
  toolInput?: Record<string, any>;
  isError?: boolean;
  errorSubtype?: string;
  resultText?: string;
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
            // OpenClaw #20774: Track content blocks as activity. Reasoning deltas
            // keep the inactivity timer alive during extended thinking.
            case "content_block_start":
            case "content_block_stop":
              break;
            case "content_block_delta":
              // Reasoning deltas should be treated as thinking activity
              if (raw.delta?.type === "thinking_delta" || raw.content_block?.type === "thinking") {
                onEvent({ type: "thinking", sessionId });
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

// Inactivity timeout: kill if Claude goes silent for this long
const INACTIVITY_TIMEOUT_MS = parseInt(
  process.env.CLAUDE_INACTIVITY_MS || "120000",
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
    model?: ModelTier;
    agentId?: string;
    userId?: string;
    lockBehavior?: "wait" | "skip";
    skipLock?: boolean; // caller already holds the session lock
    isolated?: boolean; // don't persist session ID back (cron/background jobs)
    onTyping?: () => void;
    onStatus?: (msg: string) => void;
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

    args.push(
      "--output-format", "stream-json",
      "--verbose",
      "--model", modelId,
      "--dangerously-skip-permissions"
    );

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

    // Scale inactivity and wall clock timeouts by model (Opus tasks run longer)
    const modelMultiplier = MODEL_TIMEOUT_MULTIPLIERS[modelTier] ?? 1.0;
    const effectiveInactivityMs = Math.round(INACTIVITY_TIMEOUT_MS * modelMultiplier);
    const effectiveWallClockMs = Math.round(MAX_WALL_CLOCK_MS * modelMultiplier);

    info(
      "claude",
      `[${agentId}] Calling ${modelTier}: ${prompt.substring(0, 80)}... (inactivity: ${Math.round(effectiveInactivityMs / 1000)}s, wall: ${Math.round(effectiveWallClockMs / 1000)}s)`
    );
    const startTime = Date.now();

    const proc = spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || PROJECT_ROOT,
      env: sanitizedEnv(),
      windowsHide: true,
    });

    // Pipe prompt via stdin (avoids Windows command-line length limits)
    proc.stdin.write(prompt);
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
    const SEARCH_TOOLS = new Set(["Glob", "Read", "Grep", "Search", "ListDirectory"]);
    const NO_PROGRESS_TOOLS = new Set(["process"]); // known no-progress loops (poll/log)
    const toolCallSignatures: string[] = []; // "ToolName:inputHash" for dedup detection
    const DUPLICATE_THRESHOLD = 4; // same exact call 4+ times = definitely stuck
    const FRUITLESS_SEARCH_THRESHOLD = 15; // 15+ search calls without any non-search call = warn
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
            const inputStr = event.toolInput ? JSON.stringify(event.toolInput).substring(0, 200) : "";
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

            // Phase 2: Detect exact duplicate calls (same tool + same input repeated)
            const dupeCount = toolCallSignatures.filter(s => s === sig).length;
            if (dupeCount >= DUPLICATE_THRESHOLD) {
              warn("claude", `[${agentId}] Duplicate call loop: "${toolName}" called ${dupeCount} times with same input at call #${toolCallCount}. Killing.`);
              proc.kill();
              timeoutReason = `duplicate call loop (${toolName} x${dupeCount})`;
              noProgressRepeats += dupeCount;
              break;
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
            if (dupeCount > 1) noProgressRepeats++;
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
          }
          // Send progress indicator on tool use
          {
            const now = Date.now();
            if (now - lastStatusAt > STATUS_INTERVAL_MS && options?.onStatus) {
              const elapsed = Math.round((now - startTime) / 1000);
              options.onStatus(`${event.toolName || "working"}... (${elapsed}s, ${toolCallCount} tool calls)`);
              lastStatusAt = now;
            }
          }
          break;

        // OpenClaw #20635: Thinking events keep session alive during extended reasoning
        case "thinking":
          lastActivityAt = Date.now();
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

          // Periodic status (for non-tool-use periods)
          const now = Date.now();
          if (now - lastStatusAt > STATUS_INTERVAL_MS && options?.onStatus) {
            const elapsed = Math.round((now - startTime) / 1000);
            options.onStatus(`Still working... (${elapsed}s)`);
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

        return callClaude(prompt, {
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

      // Clear typing interval before retry (lock stays with caller if skipLock)
      if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }

      return callClaude(prompt, {
        ...options,
        resume: false,
        skipLock: options?.skipLock ?? false,
        _isEmptyRetry: true,
      });
    }

    return resultText.trim() || "No response generated.";
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
