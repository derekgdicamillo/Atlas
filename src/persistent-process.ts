/**
 * Atlas — Persistent Claude CLI Subprocess
 *
 * Manages a single long-running `claude -p --input-format stream-json --output-format stream-json`
 * process. Messages are sent as NDJSON on stdin; responses stream back on stdout.
 *
 * Benefits over one-shot spawning:
 * - Eliminates cold start latency (~2-5s per message)
 * - Maintains session context via --resume
 * - Supports streaming responses
 *
 * Crash recovery: auto-restarts with exponential backoff (2s, 4s, 8s... max 30s).
 * Gives up after 5 consecutive failures. Counter resets on successful turn.
 *
 * MCP: The persistent process always gets the full MCP config (all servers).
 * Claude CLI lazy-loads MCP servers, so unused ones have zero runtime cost.
 * This avoids needing to restart the process when intent changes between turns.
 */

import { spawn, type Subprocess } from "bun";
import { info, warn, error as logError } from "./logger.ts";
import { createStreamParser, validateSpawnArgs, type StreamEvent } from "./claude.ts";
import { parseCodeTaskFromTodoContent } from "./supervisor.ts";
import {
  PERSISTENT_MAX_RESTART_ATTEMPTS,
  PERSISTENT_RESTART_DELAY_MS,
  PERSISTENT_MAX_RESTART_DELAY_MS,
  PERSISTENT_IDLE_KILL_MS,
  PERSISTENT_SHUTDOWN_GRACE_MS,
  MAX_TOOL_CALLS_PER_REQUEST,
} from "./constants.ts";

// ============================================================
// TYPES
// ============================================================

export interface PersistentProcessConfig {
  agentId: string;
  modelId: string;
  claudePath: string;
  cwd: string;
  env: Record<string, string | undefined>;
  mcpConfigPath?: string;
  sessionId?: string;
  /** Called when a CODE_TASK: prefixed todo is intercepted from TodoWrite */
  onCodeTaskCaptured?: (task: { cwd: string; prompt: string; timeoutMs?: number }) => void;
}

export type ProcessStatus = "idle" | "spawning" | "alive" | "turn_active" | "crashed" | "restarting" | "shutdown";

export interface ProcessState {
  status: ProcessStatus;
  restartCount: number;
  turnInProgress: boolean;
  lastActivityAt: number;
  pid: number | null;
}

export interface TurnResult {
  text: string;
  sessionId: string;
  isError: boolean;
  errorInfo: string;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  durationMs: number;
}

export interface SendTurnOptions {
  /** Image URLs or base64 data to include before the text */
  images?: Array<{ type: "base64"; media_type: string; data: string } | { type: "url"; url: string }>;
  /** Called on each text_delta event for streaming delivery */
  onTextDelta?: (delta: string) => void;
  /** Called on tool use events for status updates */
  onToolUse?: (toolName: string, toolInput?: Record<string, any>) => void;
  /** Called when typing indicator should be sent */
  onTyping?: () => void;
  /** Called for periodic status updates */
  onStatus?: (msg: string) => void;
  /** Called when CODE_TASK entries are captured from TodoWrite tool calls (per-turn override) */
  onCodeTaskCaptured?: (tasks: Array<{ cwd: string; prompt: string; timeoutMs?: number }>) => void;
}

// ============================================================
// MODEL MULTIPLIERS (for per-turn watchdog)
// ============================================================

function getModelMultiplier(modelId: string): number {
  if (modelId.includes("opus")) return 3.0;
  if (modelId.includes("sonnet")) return 2.0;
  return 1.0; // haiku or unknown
}

const BASE_INACTIVITY_MS = 180_000; // 180s
const BASE_WALL_CLOCK_MS = 900_000; // 900s (15 min)
const WATCHDOG_CHECK_INTERVAL_MS = 10_000; // check every 10s

// ============================================================
// PERSISTENT PROCESS CLASS
// ============================================================

export class PersistentProcess {
  private config: PersistentProcessConfig;
  private proc: Subprocess | null = null;
  private status: ProcessStatus = "idle";
  private restartCount = 0;
  private lastActivityAt: number = Date.now();
  private lastSessionId: string | null = null;

  // Turn tracking (Phase 2: tiered context loading)
  private turnCount = 0;

  // Turn state
  private turnResolve: ((result: TurnResult) => void) | null = null;
  private turnReject: ((err: Error) => void) | null = null;
  private turnText = "";
  private turnToolCallCount = 0;
  private turnStartedAt = 0;
  private turnLastEventAt = 0;
  private turnOptions: SendTurnOptions | null = null;

  // Timers
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  private typingInterval: ReturnType<typeof setInterval> | null = null;

  // Read loop abort
  private readLoopAbort: AbortController | null = null;

  // Stream parser
  private parser: ReturnType<typeof createStreamParser> | null = null;

  constructor(config: PersistentProcessConfig) {
    this.config = config;
    if (config.sessionId) {
      this.lastSessionId = config.sessionId;
    }
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  /** True if the process is running and ready to accept turns */
  isAlive(): boolean {
    return this.status === "alive" || this.status === "turn_active";
  }

  /** True if a turn is currently in progress */
  isBusy(): boolean {
    return this.status === "turn_active";
  }

  /** Returns a snapshot of the current process state */
  getState(): ProcessState {
    return {
      status: this.status,
      restartCount: this.restartCount,
      turnInProgress: this.status === "turn_active",
      lastActivityAt: this.lastActivityAt,
      pid: this.proc?.pid ?? null,
    };
  }

  /** Set session ID for --resume on next spawn */
  setSessionId(id: string | null): void {
    this.lastSessionId = id;
  }

  /** Get last known session ID */
  getSessionId(): string | null {
    return this.lastSessionId;
  }

  /** How many turns have completed on this process instance */
  getTurnCount(): number {
    return this.turnCount;
  }

  /** True if this is the first turn (process just spawned or was reset) */
  isFirstTurn(): boolean {
    return this.turnCount <= 1;
  }

  /** Reset turn count without restarting the process (e.g., on /session reset) */
  resetTurnCount(): void {
    this.turnCount = 0;
    info("persistent", `[${this.config.agentId}] Turn count reset`);
  }

  /** Get the agent ID */
  get agentId(): string {
    return this.config.agentId;
  }

  /**
   * Ensure the process is alive. Spawns if not running.
   * Returns true if the process is ready, false if spawn failed.
   */
  async ensureAlive(): Promise<boolean> {
    if (this.isAlive()) return true;
    if (this.status === "shutdown") return false;
    if (this.status === "spawning" || this.status === "restarting") {
      // Wait for the current spawn to finish
      await this.waitForReady(15_000);
      return this.isAlive();
    }
    return this.spawnProcess();
  }

  /**
   * Send a user message and wait for the result event.
   * Throws if the process is not alive or a turn is already in progress.
   */
  async sendTurn(prompt: string, options?: SendTurnOptions): Promise<TurnResult> {
    if (!this.isAlive()) {
      const started = await this.ensureAlive();
      if (!started) {
        return {
          text: "",
          sessionId: this.lastSessionId || "",
          isError: true,
          errorInfo: "Process not alive and could not be started",
          inputTokens: 0,
          outputTokens: 0,
          toolCallCount: 0,
          durationMs: 0,
        };
      }
    }

    if (this.isBusy()) {
      return {
        text: "",
        sessionId: this.lastSessionId || "",
        isError: true,
        errorInfo: "Turn already in progress",
        inputTokens: 0,
        outputTokens: 0,
        toolCallCount: 0,
        durationMs: 0,
      };
    }

    // Clear idle timer during turn
    this.clearIdleTimer();

    this.status = "turn_active";
    this.turnText = "";
    this.turnToolCallCount = 0;
    this.turnStartedAt = Date.now();
    this.turnLastEventAt = Date.now();
    this.turnOptions = options || null;
    this.lastActivityAt = Date.now();

    // Build the message payload
    const contentBlocks: any[] = [];

    // Add images if provided
    if (options?.images) {
      for (const img of options.images) {
        if (img.type === "base64") {
          contentBlocks.push({
            type: "image",
            source: { type: "base64", media_type: img.media_type, data: img.data },
          });
        } else if (img.type === "url") {
          contentBlocks.push({
            type: "image",
            source: { type: "url", url: img.url },
          });
        }
      }
    }

    // Add text block
    contentBlocks.push({ type: "text", text: prompt });

    const message = {
      type: "user",
      message: {
        role: "user",
        content: contentBlocks,
      },
      parent_tool_use_id: null,
    };

    // Write to stdin as NDJSON
    const payload = JSON.stringify(message) + "\n";

    return new Promise<TurnResult>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;

      // Start watchdog
      this.startWatchdog();

      // Start typing indicator (fires every 4s, matches Telegram's 5s typing action TTL)
      if (this.turnOptions?.onTyping) {
        this.turnOptions.onTyping(); // fire immediately
        this.typingInterval = setInterval(() => this.turnOptions?.onTyping?.(), 4000);
      }

      try {
        this.proc!.stdin.write(payload);
        this.proc!.stdin.flush();
        this.turnCount++;
      } catch (err: any) {
        this.cleanupTurn();
        resolve({
          text: "",
          sessionId: this.lastSessionId || "",
          isError: true,
          errorInfo: `Failed to write to stdin: ${err.message}`,
          inputTokens: 0,
          outputTokens: 0,
          toolCallCount: 0,
          durationMs: Date.now() - this.turnStartedAt,
        });
      }
    });
  }

  /**
   * Graceful shutdown: SIGTERM, then SIGKILL after grace period.
   */
  async shutdown(): Promise<void> {
    if (this.status === "shutdown") return;
    this.status = "shutdown";
    this.turnCount = 0;
    this.clearIdleTimer();
    this.clearWatchdog();

    // Resolve any in-progress turn
    if (this.turnResolve) {
      this.resolveTurn({
        text: this.turnText,
        sessionId: this.lastSessionId || "",
        isError: true,
        errorInfo: "Process shutting down",
        inputTokens: 0,
        outputTokens: 0,
        toolCallCount: this.turnToolCallCount,
        durationMs: Date.now() - this.turnStartedAt,
      });
    }

    if (!this.proc) return;

    info("persistent", `Shutting down process (pid=${this.proc.pid}) for agent ${this.config.agentId}`);

    // Abort read loop
    this.readLoopAbort?.abort();

    try {
      // Try graceful close of stdin first
      this.proc.stdin.end();
    } catch {
      // stdin may already be closed
    }

    // Send SIGTERM
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // Process may already be dead
    }

    // Wait for grace period, then force kill
    const pid = this.proc.pid;
    const exitedPromise = this.proc.exited;

    const graceTimeout = setTimeout(() => {
      try {
        if (this.proc && this.proc.pid === pid) {
          warn("persistent", `Force killing process (pid=${pid}) after grace period`);
          this.proc.kill("SIGKILL");
        }
      } catch {
        // Already dead
      }
    }, PERSISTENT_SHUTDOWN_GRACE_MS);

    try {
      await Promise.race([
        exitedPromise,
        new Promise(r => setTimeout(r, PERSISTENT_SHUTDOWN_GRACE_MS + 2000)),
      ]);
    } catch {
      // Ignore exit errors
    }

    clearTimeout(graceTimeout);
    this.proc = null;
  }

  /**
   * Kill and respawn the process. Resets the restart counter.
   */
  async restart(): Promise<boolean> {
    info("persistent", `Manual restart requested for agent ${this.config.agentId}`);
    this.turnCount = 0;

    // Kill existing process
    if (this.proc) {
      this.readLoopAbort?.abort();
      try { this.proc.stdin.end(); } catch { /* ignore */ }
      try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }

      // Wait briefly for exit
      try {
        await Promise.race([
          this.proc.exited,
          new Promise(r => setTimeout(r, 5000)),
        ]);
      } catch { /* ignore */ }

      try { this.proc.kill("SIGKILL"); } catch { /* ignore */ }
      this.proc = null;
    }

    // Resolve any in-progress turn
    if (this.turnResolve) {
      this.resolveTurn({
        text: this.turnText,
        sessionId: this.lastSessionId || "",
        isError: true,
        errorInfo: "Process restarting",
        inputTokens: 0,
        outputTokens: 0,
        toolCallCount: this.turnToolCallCount,
        durationMs: Date.now() - this.turnStartedAt,
      });
    }

    this.restartCount = 0;
    this.status = "idle";
    this.clearIdleTimer();
    this.clearWatchdog();

    return this.spawnProcess();
  }

  // ============================================================
  // PRIVATE: Process Lifecycle
  // ============================================================

  private async spawnProcess(): Promise<boolean> {
    if (this.status === "shutdown") return false;
    this.status = "spawning";

    const args = [
      this.config.claudePath,
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--model", this.config.modelId,
      "--dangerously-skip-permissions",
    ];

    if (this.config.mcpConfigPath) {
      args.push("--mcp-config", this.config.mcpConfigPath);
    }

    if (this.lastSessionId) {
      args.push("--resume", this.lastSessionId);
    }

    try {
      validateSpawnArgs(args);
    } catch (err: any) {
      logError("persistent", `Invalid spawn args: ${err.message}`);
      this.status = "crashed";
      return false;
    }

    const [command, ...spawnArgs] = args;

    info("persistent", `Spawning persistent process for agent ${this.config.agentId} (model=${this.config.modelId}, session=${this.lastSessionId || "new"})`);

    try {
      this.proc = spawn({
        cmd: [command, ...spawnArgs],
        cwd: this.config.cwd,
        env: this.config.env as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      info("persistent", `Process spawned (pid=${this.proc.pid}) for agent ${this.config.agentId}`);

      // Set up stream parser
      this.parser = createStreamParser((event) => this.handleEvent(event));

      // Start read loops
      this.readLoopAbort = new AbortController();
      this.startStdoutLoop();
      this.startStderrLoop();

      // Monitor process exit
      this.monitorExit();

      this.status = "alive";
      this.lastActivityAt = Date.now();

      // Start idle timer
      this.resetIdleTimer();

      return true;
    } catch (err: any) {
      logError("persistent", `Failed to spawn process for agent ${this.config.agentId}: ${err.message}`);
      this.status = "crashed";
      this.proc = null;
      return false;
    }
  }

  // ============================================================
  // PRIVATE: Read Loops
  // ============================================================

  private async startStdoutLoop(): Promise<void> {
    if (!this.proc?.stdout) return;
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    const signal = this.readLoopAbort?.signal;

    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        this.parser?.feed(chunk);
      }
    } catch (err: any) {
      if (!signal?.aborted) {
        warn("persistent", `stdout read error for agent ${this.config.agentId}: ${err.message}`);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  private async startStderrLoop(): Promise<void> {
    if (!this.proc?.stderr) return;
    const reader = (this.proc.stderr as ReadableStream).getReader();
    const decoder = new TextDecoder();
    const signal = this.readLoopAbort?.signal;

    try {
      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        // Log stderr incrementally, don't block
        if (chunk.trim()) {
          warn("persistent", `[stderr:${this.config.agentId}] ${chunk.trim().substring(0, 500)}`);
        }
      }
    } catch (err: any) {
      if (!signal?.aborted) {
        // stderr errors are not critical
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  // ============================================================
  // PRIVATE: Event Handling
  // ============================================================

  private handleEvent(event: StreamEvent): void {
    this.lastActivityAt = Date.now();
    this.turnLastEventAt = Date.now();

    switch (event.type) {
      case "system":
        // Session ID tracking
        if (event.sessionId) {
          this.lastSessionId = event.sessionId;
        }
        break;

      case "assistant":
        // Track tool calls
        if (event.toolName) {
          this.turnToolCallCount++;

          // Notify caller
          this.turnOptions?.onToolUse?.(event.toolName, event.toolInput);

          // TodoWrite interception for CODE_TASK:
          if (event.toolName === "TodoWrite" && event.toolInput) {
            this.interceptCodeTasks(event.toolInput);
          }

          // Loop detection
          if (this.turnToolCallCount > MAX_TOOL_CALLS_PER_REQUEST) {
            warn("persistent", `Loop detected: ${this.turnToolCallCount} tool calls for agent ${this.config.agentId}`);
            this.resolveTurn({
              text: this.turnText,
              sessionId: this.lastSessionId || "",
              isError: true,
              errorInfo: `Loop detected: exceeded ${MAX_TOOL_CALLS_PER_REQUEST} tool calls`,
              inputTokens: 0,
              outputTokens: 0,
              toolCallCount: this.turnToolCallCount,
              durationMs: Date.now() - this.turnStartedAt,
            });
          }
        }
        break;

      case "text_delta":
        if (event.textDelta) {
          this.turnText += event.textDelta;
          this.turnOptions?.onTextDelta?.(event.textDelta);
        }
        break;

      case "thinking":
        // Activity signal — already updated lastActivityAt above
        break;

      case "result":
        // Session ID from result event
        if (event.sessionId) {
          this.lastSessionId = event.sessionId;
        }

        // Debug: log what we have for text sources
        if (!this.turnText && !event.resultText) {
          warn("persistent", `[${this.config.agentId}] EMPTY RESULT: turnText="${this.turnText}" resultText="${event.resultText}" isError=${event.isError} errorSubtype=${event.errorSubtype}`);
        } else {
          info("persistent", `[${this.config.agentId}] Result: turnText=${this.turnText.length}chars resultText=${(event.resultText || "").length}chars`);
        }

        this.resolveTurn({
          // Prefer accumulated text from deltas (clean, no thinking tags) over
          // result event text (which may contain thinking artifacts that get stripped).
          // Fall back to resultText only if no deltas were received.
          text: this.turnText || event.resultText || "",
          sessionId: event.sessionId || this.lastSessionId || "",
          isError: !!event.isError,
          errorInfo: event.isError ? (event.errorSubtype || "unknown error") : "",
          inputTokens: event.inputTokens || 0,
          outputTokens: event.outputTokens || 0,
          toolCallCount: this.turnToolCallCount,
          durationMs: Date.now() - this.turnStartedAt,
        });
        break;
    }
  }

  /**
   * Intercept TodoWrite tool calls to capture CODE_TASK: prefixed entries.
   */
  private interceptCodeTasks(toolInput: Record<string, any>): void {
    // Per-turn callback takes priority over config-level callback
    const perTurnCb = this.turnOptions?.onCodeTaskCaptured;
    const configCb = this.config.onCodeTaskCaptured;
    if (!perTurnCb && !configCb) return;

    const todos = toolInput.todos || toolInput.content;
    if (!Array.isArray(todos)) return;

    const captured: Array<{ cwd: string; prompt: string; timeoutMs?: number }> = [];

    for (const todo of todos) {
      const content = todo.content || todo.text || "";
      if (typeof content !== "string" || !content.startsWith("CODE_TASK:")) continue;

      const parsed = parseCodeTaskFromTodoContent(content);
      if (parsed) {
        info("persistent", `Intercepted CODE_TASK from agent ${this.config.agentId}: ${parsed.prompt.substring(0, 100)}`);
        captured.push(parsed);
        // Also fire config-level callback (single task)
        configCb?.(parsed);
      }
    }

    // Fire per-turn callback with all captured tasks at once
    if (captured.length > 0 && perTurnCb) {
      perTurnCb(captured);
    }
  }

  // ============================================================
  // PRIVATE: Turn Resolution
  // ============================================================

  private resolveTurn(result: TurnResult): void {
    const resolve = this.turnResolve;
    this.cleanupTurn();

    // Reset restart count on successful turn (NOT on spawn)
    if (!result.isError) {
      this.restartCount = 0;
    }

    // Reset idle timer
    if (this.status !== "shutdown") {
      this.status = "alive";
      this.resetIdleTimer();
    }

    resolve?.(result);
  }

  private cleanupTurn(): void {
    this.turnResolve = null;
    this.turnReject = null;
    this.turnOptions = null;
    this.clearWatchdog();
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  // ============================================================
  // PRIVATE: Crash Recovery
  // ============================================================

  private monitorExit(): void {
    if (!this.proc) return;

    this.proc.exited.then((exitCode) => {
      if (this.status === "shutdown") return;

      warn("persistent", `Process exited (code=${exitCode}) for agent ${this.config.agentId}`);

      // Resolve any in-progress turn with error
      if (this.turnResolve) {
        this.resolveTurn({
          text: this.turnText,
          sessionId: this.lastSessionId || "",
          isError: true,
          errorInfo: `Process exited unexpectedly (code=${exitCode})`,
          inputTokens: 0,
          outputTokens: 0,
          toolCallCount: this.turnToolCallCount,
          durationMs: Date.now() - this.turnStartedAt,
        });
      }

      this.proc = null;
      this.readLoopAbort?.abort();

      // Auto-restart with exponential backoff
      this.autoRestart();
    }).catch((err) => {
      if (this.status !== "shutdown") {
        logError("persistent", `Error monitoring process exit: ${err.message}`);
      }
    });
  }

  private async autoRestart(): Promise<void> {
    this.restartCount++;

    if (this.restartCount > PERSISTENT_MAX_RESTART_ATTEMPTS) {
      logError("persistent", `Giving up on agent ${this.config.agentId} after ${PERSISTENT_MAX_RESTART_ATTEMPTS} restart attempts`);
      this.status = "crashed";
      return;
    }

    this.status = "restarting";

    // Exponential backoff: 2s, 4s, 8s, 16s, 30s (capped)
    const delay = Math.min(
      PERSISTENT_RESTART_DELAY_MS * Math.pow(2, this.restartCount - 1),
      PERSISTENT_MAX_RESTART_DELAY_MS,
    );

    info("persistent", `Auto-restart attempt ${this.restartCount}/${PERSISTENT_MAX_RESTART_ATTEMPTS} for agent ${this.config.agentId} in ${delay}ms`);

    await new Promise(r => setTimeout(r, delay));

    if (this.status === "shutdown") return;

    const ok = await this.spawnProcess();
    if (!ok) {
      warn("persistent", `Restart attempt ${this.restartCount} failed for agent ${this.config.agentId}`);
      // monitorExit won't fire since spawn failed, so retry manually
      this.autoRestart();
    }
  }

  // ============================================================
  // PRIVATE: Watchdog (per-turn timeout)
  // ============================================================

  private startWatchdog(): void {
    this.clearWatchdog();

    const multiplier = getModelMultiplier(this.config.modelId);
    const maxInactivity = BASE_INACTIVITY_MS * multiplier;
    const maxWallClock = BASE_WALL_CLOCK_MS * multiplier;

    this.watchdogInterval = setInterval(() => {
      const now = Date.now();

      // Inactivity check
      const idleMs = now - this.turnLastEventAt;
      if (idleMs > maxInactivity) {
        warn("persistent", `Turn timed out (inactive for ${Math.round(idleMs / 1000)}s) for agent ${this.config.agentId}`);
        this.resolveTurn({
          text: this.turnText,
          sessionId: this.lastSessionId || "",
          isError: true,
          errorInfo: `Turn timed out: inactive for ${Math.round(idleMs / 1000)}s`,
          inputTokens: 0,
          outputTokens: 0,
          toolCallCount: this.turnToolCallCount,
          durationMs: now - this.turnStartedAt,
        });
        return;
      }

      // Wall clock check
      const wallMs = now - this.turnStartedAt;
      if (wallMs > maxWallClock) {
        warn("persistent", `Turn timed out (wall clock ${Math.round(wallMs / 1000)}s) for agent ${this.config.agentId}`);
        this.resolveTurn({
          text: this.turnText,
          sessionId: this.lastSessionId || "",
          isError: true,
          errorInfo: `Turn timed out: wall clock exceeded ${Math.round(maxWallClock / 1000)}s`,
          inputTokens: 0,
          outputTokens: 0,
          toolCallCount: this.turnToolCallCount,
          durationMs: now - this.turnStartedAt,
        });
        return;
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  // ============================================================
  // PRIVATE: Idle Timer
  // ============================================================

  private resetIdleTimer(): void {
    this.clearIdleTimer();

    this.idleTimer = setTimeout(() => {
      if (this.status === "alive") {
        info("persistent", `Idle timeout (${PERSISTENT_IDLE_KILL_MS / 60_000}min) for agent ${this.config.agentId}, shutting down`);
        this.shutdown();
      }
    }, PERSISTENT_IDLE_KILL_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ============================================================
  // PRIVATE: Utility
  // ============================================================

  private waitForReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (this.isAlive() || this.status === "crashed" || this.status === "shutdown" || this.status === "idle") {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve();
          return;
        }
        setTimeout(check, 200);
      };
      check();
    });
  }
}
