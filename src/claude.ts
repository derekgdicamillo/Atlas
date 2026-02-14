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
import { MODELS, DEFAULT_MODEL, type ModelTier } from "./constants.ts";
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
  waiters: (() => void)[];
}

const sessionLocks: Map<string, LockState> = new Map();

function getLockState(key: string): LockState {
  if (!sessionLocks.has(key)) {
    sessionLocks.set(key, { locked: false, waiters: [] });
  }
  return sessionLocks.get(key)!;
}

/**
 * Acquire a per-session lock.
 * - "wait": blocks until the lock is available (for user messages)
 * - "skip": returns immediately with acquired: false if locked (for heartbeat)
 */
export async function acquireSessionLock(
  key: string,
  behavior: "wait" | "skip"
): Promise<{ acquired: boolean; release: () => void }> {
  const lock = getLockState(key);

  const release = () => {
    lock.locked = false;
    if (lock.waiters.length > 0) {
      const next = lock.waiters.shift()!;
      lock.locked = true;
      next();
    }
  };

  if (!lock.locked) {
    lock.locked = true;
    return { acquired: true, release };
  }

  if (behavior === "skip") {
    return { acquired: false, release: () => {} };
  }

  // behavior === "wait": queue until lock is released
  return new Promise((resolve) => {
    lock.waiters.push(() => {
      resolve({ acquired: true, release });
    });
  });
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
    const args = [CLAUDE_PATH, "-p", prompt];

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
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || PROJECT_ROOT,
      env: { ...process.env },
    });

    // Keep Telegram typing indicator alive every 4s while waiting
    if (options?.onTyping) {
      typingInterval = setInterval(() => options.onTyping!(), 4000);
    }

    // Stream-JSON parsing: each line is a JSON event
    let resultText = "";
    let sessionId = "";
    let lastActivityAt = Date.now();
    let lastStatusAt = Date.now();
    let timeoutReason = "";
    let isError = false;
    let errorInfo = "";
    let lineBuffer = "";
    let gotResultEvent = false;

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    const readLoop = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          lineBuffer += chunk;
          lastActivityAt = Date.now();

          // Process complete JSON lines
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const event = JSON.parse(trimmed);

              // Extract session ID from any event that has it
              if (event.session_id) {
                sessionId = event.session_id;
              }

              // Handle different event types
              switch (event.type) {
                case "system":
                  // Init event, session info
                  break;

                case "assistant":
                  // Text or tool use from Claude
                  if (event.message?.content) {
                    for (const block of event.message.content) {
                      if (block.type === "tool_use") {
                        // Send progress indicator on tool use
                        const now = Date.now();
                        if (now - lastStatusAt > STATUS_INTERVAL_MS && options?.onStatus) {
                          const elapsed = Math.round((now - startTime) / 1000);
                          const toolName = block.name || "working";
                          options.onStatus(`${toolName}... (${elapsed}s)`);
                          lastStatusAt = now;
                        }
                      }
                    }
                  }
                  break;

                case "result":
                  // Final result
                  gotResultEvent = true;
                  if (event.result) {
                    resultText = event.result;
                  }
                  if (event.is_error) {
                    isError = true;
                    errorInfo = event.subtype || "unknown error";
                  }
                  break;
              }
            } catch {
              // Not valid JSON, skip
            }
          }

          // Periodic status (for non-tool-use periods)
          const now = Date.now();
          if (now - lastStatusAt > STATUS_INTERVAL_MS && options?.onStatus) {
            const elapsed = Math.round((now - startTime) / 1000);
            options.onStatus(`Still working... (${elapsed}s)`);
            lastStatusAt = now;
          }
        }
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
      logError("claude", `Timed out after ${elapsed}s: ${timeoutReason}`, {
        prompt: prompt.substring(0, 200),
        model: modelTier,
      });
      return `Sorry, that took too long (${timeoutReason}). Try again or simplify your request.`;
    }

    const durationMs = Date.now() - startTime;
    trackClaudeCall(durationMs);

    const { stderr, exitCode } = raceResult;

    if (exitCode !== 0) {
      const wasResuming = options?.resume && session.sessionId;
      const stderrEmpty = !stderr.trim();

      logError("claude", `Exit code ${exitCode}: ${stderr.substring(0, 200)}`);

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
      `[${agentId}] Responded in ${Math.round(durationMs / 1000)}s (${modelTier})`
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

    return resultText.trim() || "No response generated.";
  } catch (err) {
    logError("claude", `Spawn error: ${err}`);
    return `Error: Could not run Claude CLI`;
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
