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
import { writeFile, readFile, appendFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
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
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const PROJECT_ROOT = dirname(dirname(import.meta.path));
const RELAY_DIR =
  process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const CLAUDE_TIMEOUT_MS = parseInt(
  process.env.CLAUDE_TIMEOUT_MS || "120000",
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
    const state = JSON.parse(content);
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

export async function saveSessionState(
  agentId: string,
  userId: string,
  state: SessionState
): Promise<void> {
  sessions.set(sessionKey(agentId, userId), state);
  await writeFile(
    sessionFilePath(agentId, userId),
    JSON.stringify(state, null, 2)
  );
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

// Maximum time a lock can be held before auto-release (10 minutes).
// This prevents deadlocks when a Claude process crashes without releasing.
const LOCK_TIMEOUT_MS = 10 * 60_000;

// Maximum time a waiter will wait for the lock (12 minutes).
// Prevents user messages from queuing forever if something goes wrong.
const LOCK_WAIT_TIMEOUT_MS = 12 * 60_000;

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
  type: "system" | "assistant" | "result";
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
          const raw = JSON.parse(trimmed);
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
                }
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
          const raw = JSON.parse(lineBuffer.trim());
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
    onTyping?: () => void;
    onStatus?: (msg: string) => void;
    _isFallback?: boolean; // internal: prevents infinite fallback chains
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

    const effectiveTimeout = getEffectiveTimeout(modelTier);

    // Scale inactivity timeout by model (Opus tasks have longer gaps between output)
    const inactivityMultiplier = MODEL_TIMEOUT_MULTIPLIERS[modelTier] ?? 1.0;
    const effectiveInactivityMs = Math.round(INACTIVITY_TIMEOUT_MS * inactivityMultiplier);

    info(
      "claude",
      `[${agentId}] Calling ${modelTier}: ${prompt.substring(0, 80)}... (inactivity: ${Math.round(effectiveInactivityMs / 1000)}s, wall: ${Math.round(MAX_WALL_CLOCK_MS / 1000)}s)`
    );
    const startTime = Date.now();

    const proc = spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || PROJECT_ROOT,
      env: { ...process.env },
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

    // Smart loop detection: tracks actual repeated tool calls, not just tool types.
    // A "loop" = same tool with same/similar input called multiple times (spinning).
    // Sequential search tools with DIFFERENT inputs = normal research, not a loop.
    const SEARCH_TOOLS = new Set(["Glob", "Read", "Grep", "Search", "ListDirectory"]);
    const toolCallSignatures: string[] = []; // "ToolName:inputHash" for dedup detection
    const DUPLICATE_THRESHOLD = 4; // same exact call 4+ times = definitely stuck
    const FRUITLESS_SEARCH_THRESHOLD = 15; // 15+ search calls without any non-search call = warn
    let consecutiveSearchCalls = 0;
    let warningInjected = false; // true if we already sent a "slow down" signal

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
          // Smart loop detection: detect actual repeated calls, not just sequential search use
          {
            const toolName = event.toolName || "unknown";
            const isSearch = SEARCH_TOOLS.has(toolName);

            // Build a signature from tool name + key input to detect duplicate calls
            const inputStr = event.toolInput ? JSON.stringify(event.toolInput).substring(0, 200) : "";
            const sig = `${toolName}:${inputStr}`;
            toolCallSignatures.push(sig);

            // Check for exact duplicate calls (same tool + same input repeated)
            const dupeCount = toolCallSignatures.filter(s => s === sig).length;
            if (dupeCount >= DUPLICATE_THRESHOLD) {
              warn("claude", `[${agentId}] Duplicate call loop: "${toolName}" called ${dupeCount} times with same input at call #${toolCallCount}. Killing.`);
              proc.kill();
              timeoutReason = `duplicate call loop (${toolName} x${dupeCount})`;
              break;
            }

            // Track consecutive search calls for fruitless search detection
            if (isSearch) {
              consecutiveSearchCalls++;
            } else {
              consecutiveSearchCalls = 0; // reset on any non-search tool
            }

            // After many consecutive search calls, log a warning but don't kill.
            // Claude might still find what it needs. Only kill at hard cap.
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

        case "result":
          gotResultEvent = true;
          resultText = event.resultText || "";
          if (event.isError) {
            isError = true;
            errorInfo = event.errorSubtype || "unknown error";
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

        if (wallElapsed > MAX_WALL_CLOCK_MS) {
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
        if (session.sessionId) {
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

      if ((isRateLimit || isModelError) && fallbackModel && !options?._isFallback) {
        warn("claude", `[${agentId}] ${modelTier} failed (${isRateLimit ? "rate limit" : "model error"}), falling back to ${fallbackModel}`);

        if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
        release();

        return callClaude(prompt, {
          ...options,
          model: fallbackModel,
          skipLock: false,
          _isFallback: true,
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

        // Release lock + typing interval before recursive retry
        if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
        release();

        return callClaude(prompt, {
          ...options,
          resume: false,  // Force fresh session
          skipLock: false, // Retry must acquire its own lock
        });
      }

      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
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

    // Save session ID
    if (sessionId) {
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

      // Clear potentially corrupted session
      if (session.sessionId) {
        const oldSid = session.sessionId;
        session.sessionId = null;
        session.lastActivity = new Date().toISOString();
        await saveSessionState(agentId, userId, session);
        archiveSessionTranscript(oldSid, agentId, userId).catch(() => {});
      }

      // Release lock + typing before retry (retry acquires its own)
      if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
      release();

      return callClaude(prompt, {
        ...options,
        resume: false,
        skipLock: false,
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
        skipLock: false,
        _isSpawnRetry: true,
      });
    }

    // Second spawn failure: notify user with actionable message
    logError("claude", `[${agentId}] Spawn failed twice: ${err}`);
    return "I couldn't start the Claude CLI. This is usually a transient Windows issue. Try sending your message again in a moment.";
  } finally {
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
