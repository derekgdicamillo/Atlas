# Phase 1: Persistent Subprocess Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-shot `claude -p` spawning model with a persistent long-running subprocess per agent, eliminating cold starts, enabling prompt cache reuse, and delivering streaming responses immediately.

**Architecture:** Each agent (Atlas, Ishtar) gets a persistent Claude CLI process running with `--input-format stream-json --output-format stream-json`. User messages are piped as NDJSON; responses are read as NDJSON events. A `PersistentProcess` class manages lifecycle (spawn, crash recovery with backoff, graceful shutdown). The existing `callClaude()` function is refactored into two paths: persistent (for interactive user messages) and one-shot (for cron/background/isolated calls that don't need persistence). Session locking adapts from "wait for process exit" to "wait for current turn's result event."

**Tech Stack:** Bun `spawn()`, NDJSON stream parsing (existing `createStreamParser`), existing session lock system, PM2 lifecycle hooks.

---

## File Structure

| File | Role | Status |
|------|------|--------|
| `src/persistent-process.ts` | `PersistentProcess` class — spawn, write, read, crash recovery, shutdown | **Create** |
| `src/persistent-pool.ts` | `ProcessPool` — manages one `PersistentProcess` per agent key, lazy init, shutdown-all | **Create** |
| `src/claude.ts` | Refactor `callClaude()` to route through persistent process for interactive calls | **Modify** |
| `src/relay.ts` | Minimal: swap to `callClaudePersistent()` where it currently calls `callClaude()` | **Modify** |
| `src/constants.ts` | Add persistent process constants | **Modify** |
| `tests/persistent-process.test.ts` | Unit tests for PersistentProcess lifecycle | **Create** |
| `tests/persistent-pool.test.ts` | Unit tests for ProcessPool | **Create** |
| `tests/claude-routing.test.ts` | Tests for callClaude routing logic (persistent vs one-shot) | **Create** |

### Design Decisions

1. **Two files, not one.** `PersistentProcess` handles a single process lifecycle. `ProcessPool` manages the collection (one per agent). This keeps each file focused and testable.

2. **`callClaude()` stays as the public API.** Callers (relay.ts, cron.ts, orchestrator.ts, heartbeat.ts, exploration.ts) don't change their call signature. Routing happens internally based on `options.isolated` and a new `options.persistent` flag.

3. **One-shot path preserved.** Cron jobs, background tasks, code agents, and isolated calls keep using the existing `spawn()` logic. Only interactive user-facing calls (where `skipLock: true` is passed from relay.ts) go through the persistent pipe.

4. **Crash recovery with exponential backoff.** If the persistent process dies mid-turn, the current turn gets an error response. The process restarts with backoff (2s, 4s, 8s, max 30s). After 5 consecutive failures, falls back to one-shot for that turn. The restart counter only resets on a successful turn completion, NOT on spawn success (prevents infinite crash loops where a process spawns fine but crashes immediately).

5. **Turn-based concurrency.** Only one turn runs at a time per persistent process (enforced by the existing session lock). Messages arriving during an active turn accumulate in the existing message accumulator. No change needed.

6. **Session resume on spawn.** The persistent process accepts an optional `sessionId` to pass `--resume` to Claude CLI. On first spawn, no session ID exists (fresh conversation). After the first turn completes, the session ID is captured from the result event. On restart (crash recovery), the last known session ID is used so Claude CLI can reload its cached conversation prefix. This is critical for prompt cache reuse.

7. **stdin stays open.** Unlike the one-shot path which calls `stdin.end()`, the persistent process keeps stdin open so multiple turns can be written. Claude CLI with `--input-format stream-json` processes each `\n`-delimited JSON message independently. If the integration test (Task 8) reveals the CLI requires EOF per message, persistent mode is infeasible and we abort.

---

## Task 1: Add Constants

**Files:**
- Modify: `src/constants.ts`

- [ ] **Step 1: Add persistent process constants to constants.ts**

Add after the existing `SESSION_IDLE_RESET_MS` constant (search for it, add after):

```typescript
// ============================================================
// PERSISTENT PROCESS (Phase 1 — long-lived Claude CLI subprocess)
// ============================================================

/** Max consecutive crash restarts before giving up and falling back to one-shot */
export const PERSISTENT_MAX_RESTART_ATTEMPTS = 5;

/** Initial restart delay (doubles each attempt, capped at PERSISTENT_MAX_RESTART_DELAY_MS) */
export const PERSISTENT_RESTART_DELAY_MS = 2_000;

/** Maximum restart delay */
export const PERSISTENT_MAX_RESTART_DELAY_MS = 30_000;

/** How long a process can sit idle before we proactively kill it to save resources.
 *  Set to 30 min — if no message arrives in 30 min, kill the process.
 *  Next message will re-spawn it (cheap compared to keeping it alive). */
export const PERSISTENT_IDLE_KILL_MS = 30 * 60 * 1000;

/** Grace period after sending SIGTERM before escalating to SIGKILL */
export const PERSISTENT_SHUTDOWN_GRACE_MS = 10_000;
```

- [ ] **Step 2: Verify constants.ts still compiles**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/constants.ts --no-bundle 2>&1 | head -5`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/constants.ts
git commit -m "feat: add persistent process constants for Phase 1"
```

---

## Task 2: PersistentProcess Class

**Files:**
- Create: `src/persistent-process.ts`
- Create: `tests/persistent-process.test.ts`

This is the core primitive: a single long-running `claude -p --input-format stream-json --output-format stream-json` process with crash recovery.

- [ ] **Step 1: Write the test file**

```typescript
// tests/persistent-process.test.ts
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

// We'll test PersistentProcess in isolation by mocking spawn.
// For now, create the test structure. Implementation tests come after the class exists.

describe("PersistentProcess", () => {
  test("exports PersistentProcess class", async () => {
    const mod = await import("../src/persistent-process.ts");
    expect(mod.PersistentProcess).toBeDefined();
    expect(typeof mod.PersistentProcess).toBe("function");
  });

  test("constructor accepts config", async () => {
    const { PersistentProcess } = await import("../src/persistent-process.ts");
    const proc = new PersistentProcess({
      agentId: "atlas",
      modelId: "claude-opus-4-6",
      claudePath: "echo", // dummy command for testing
      cwd: process.cwd(),
      env: {},
    });
    expect(proc.agentId).toBe("atlas");
    expect(proc.isAlive()).toBe(false);
  });

  test("getState returns correct initial state", async () => {
    const { PersistentProcess } = await import("../src/persistent-process.ts");
    const proc = new PersistentProcess({
      agentId: "test",
      modelId: "claude-opus-4-6",
      claudePath: "echo",
      cwd: process.cwd(),
      env: {},
    });
    const state = proc.getState();
    expect(state.status).toBe("idle");
    expect(state.restartCount).toBe(0);
    expect(state.turnInProgress).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (module not found)**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/persistent-process.test.ts 2>&1 | tail -10`
Expected: FAIL — module `../src/persistent-process.ts` not found.

- [ ] **Step 3: Create persistent-process.ts with the class skeleton**

```typescript
// src/persistent-process.ts
/**
 * Atlas — Persistent Claude CLI Subprocess
 *
 * Manages a single long-running `claude -p --input-format stream-json --output-format stream-json`
 * process. Messages are sent as NDJSON lines on stdin; responses stream back as NDJSON on stdout.
 *
 * Lifecycle:
 *   idle → spawning → alive → (turn in progress) → alive → ...
 *   alive → crashed → restarting → alive (with backoff)
 *   alive → shutdown → dead
 *
 * One PersistentProcess per agent (Atlas, Ishtar). Managed by ProcessPool.
 */

import { spawn, type Subprocess } from "bun";
import { info, warn, error as logError } from "./logger.ts";
import { createStreamParser, sanitizedEnv, validateSpawnArgs, type StreamEvent } from "./claude.ts";
import { parseCodeTaskFromTodoContent } from "./supervisor.ts";
import { MAX_TOOL_CALLS_PER_REQUEST } from "./constants.ts";
import {
  PERSISTENT_MAX_RESTART_ATTEMPTS,
  PERSISTENT_RESTART_DELAY_MS,
  PERSISTENT_MAX_RESTART_DELAY_MS,
  PERSISTENT_IDLE_KILL_MS,
  PERSISTENT_SHUTDOWN_GRACE_MS,
} from "./constants.ts";

export interface PersistentProcessConfig {
  agentId: string;
  modelId: string;
  claudePath: string;
  cwd: string;
  env: Record<string, string | undefined>;
  mcpConfigPath?: string;
  sessionId?: string; // Resume from a previous session (passed to --resume)
}

export type ProcessStatus = "idle" | "spawning" | "alive" | "turn_active" | "crashed" | "restarting" | "shutdown";

export interface ProcessState {
  status: ProcessStatus;
  restartCount: number;
  turnInProgress: boolean;
  lastActivityAt: number;
  pid: number | null;
}

interface TurnContext {
  resolve: (result: TurnResult) => void;
  resultText: string;
  sessionId: string;
  isError: boolean;
  errorInfo: string;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  gotResult: boolean;
  onTextDelta?: (text: string) => void;
  onTyping?: () => void;
  onStatus?: (msg: string) => void;
  onCodeTaskCaptured?: (tasks: Array<{ cwd: string; prompt: string; timeoutMs?: number }>) => void;
  startTime: number;
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

export class PersistentProcess {
  readonly agentId: string;
  private config: PersistentProcessConfig;
  private proc: Subprocess | null = null;
  private status: ProcessStatus = "idle";
  private restartCount = 0;
  private lastActivityAt = 0;
  private lastSessionId: string | null = null; // Tracks session ID across turns for --resume on restart
  private currentTurn: TurnContext | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private decoder = new TextDecoder();
  private readLoopRunning = false;

  constructor(config: PersistentProcessConfig) {
    this.agentId = config.agentId;
    this.config = config;
    this.lastSessionId = config.sessionId || null;
  }

  /** Is the underlying process alive and accepting input? */
  isAlive(): boolean {
    return this.status === "alive" || this.status === "turn_active";
  }

  /** Is a turn currently in progress? */
  isBusy(): boolean {
    return this.status === "turn_active";
  }

  getState(): ProcessState {
    return {
      status: this.status,
      restartCount: this.restartCount,
      turnInProgress: this.status === "turn_active",
      lastActivityAt: this.lastActivityAt,
      pid: this.proc?.pid ?? null,
    };
  }

  /**
   * Ensure the process is alive. Spawns if not running.
   * Returns true if process is ready, false if spawn failed.
   */
  async ensureAlive(): Promise<boolean> {
    if (this.isAlive()) return true;
    if (this.status === "shutdown") return false;
    return this.spawnProcess();
  }

  /**
   * Send a user message and wait for the turn to complete.
   * Returns the turn result with response text, tokens, etc.
   *
   * The caller MUST hold the session lock before calling this.
   * Only one turn runs at a time per process.
   */
  async sendTurn(
    prompt: string,
    options?: {
      imageBase64?: string;
      imageMimeType?: string;
      onTextDelta?: (text: string) => void;
      onTyping?: () => void;
      onStatus?: (msg: string) => void;
      onCodeTaskCaptured?: (tasks: Array<{ cwd: string; prompt: string; timeoutMs?: number }>) => void;
    },
  ): Promise<TurnResult> {
    if (!this.isAlive()) {
      const spawned = await this.ensureAlive();
      if (!spawned) {
        return {
          text: "Persistent process failed to start. Falling back to one-shot.",
          sessionId: "",
          isError: true,
          errorInfo: "spawn_failed",
          inputTokens: 0,
          outputTokens: 0,
          toolCallCount: 0,
          durationMs: 0,
        };
      }
    }

    if (this.isBusy()) {
      // This shouldn't happen if the session lock is held correctly.
      warn("persistent", `[${this.agentId}] sendTurn called while busy. This is a bug.`);
      return {
        text: "I'm still working on the previous message. Please wait.",
        sessionId: "",
        isError: true,
        errorInfo: "busy",
        inputTokens: 0,
        outputTokens: 0,
        toolCallCount: 0,
        durationMs: 0,
      };
    }

    this.status = "turn_active";
    this.resetIdleTimer();

    return new Promise<TurnResult>((resolve) => {
      this.currentTurn = {
        resolve,
        resultText: "",
        sessionId: "",
        isError: false,
        errorInfo: "",
        inputTokens: 0,
        outputTokens: 0,
        toolCallCount: 0,
        gotResult: false,
        onTextDelta: options?.onTextDelta,
        onTyping: options?.onTyping,
        onStatus: options?.onStatus,
        onCodeTaskCaptured: options?.onCodeTaskCaptured,
        startTime: Date.now(),
      };

      // Write the user message as NDJSON to stdin
      this.writeMessage(prompt, options?.imageBase64, options?.imageMimeType);
    });
  }

  /** Gracefully shut down the process */
  async shutdown(): Promise<void> {
    this.status = "shutdown";
    this.clearIdleTimer();

    if (this.proc) {
      info("persistent", `[${this.agentId}] Shutting down persistent process (PID ${this.proc.pid})`);

      // If a turn is in progress, resolve it with an error
      if (this.currentTurn) {
        this.resolveTurn("Process shutting down.", true, "shutdown");
      }

      try {
        this.proc.kill("SIGTERM");
      } catch {}

      // Give it grace period, then SIGKILL
      const pid = this.proc.pid;
      setTimeout(() => {
        if (this.proc && this.proc.pid === pid) {
          try { this.proc.kill("SIGKILL"); } catch {}
        }
      }, PERSISTENT_SHUTDOWN_GRACE_MS);

      this.proc = null;
      this.reader = null;
      this.readLoopRunning = false;
    }
  }

  /** Set the session ID for --resume on next spawn/restart */
  setSessionId(sessionId: string | null): void {
    this.lastSessionId = sessionId;
  }

  /** Get the last known session ID (from completed turns) */
  getSessionId(): string | null {
    return this.lastSessionId;
  }

  /** Kill and restart (for when we need a fresh process, e.g. session change) */
  async restart(): Promise<boolean> {
    info("persistent", `[${this.agentId}] Explicit restart requested`);
    if (this.proc) {
      try { this.proc.kill("SIGTERM"); } catch {}
      this.proc = null;
      this.reader = null;
      this.readLoopRunning = false;
    }
    this.status = "idle";
    this.restartCount = 0; // explicit restart resets the counter
    return this.spawnProcess();
  }

  // ─── Private ────────────────────────────────────────────

  private async spawnProcess(): Promise<boolean> {
    if (this.restartCount >= PERSISTENT_MAX_RESTART_ATTEMPTS) {
      logError("persistent", `[${this.agentId}] Max restart attempts (${PERSISTENT_MAX_RESTART_ATTEMPTS}) reached. Giving up.`);
      this.status = "crashed";
      return false;
    }

    this.status = "spawning";

    // Backoff delay on restarts (not on first spawn)
    if (this.restartCount > 0) {
      const delay = Math.min(
        PERSISTENT_RESTART_DELAY_MS * Math.pow(2, this.restartCount - 1),
        PERSISTENT_MAX_RESTART_DELAY_MS,
      );
      info("persistent", `[${this.agentId}] Restart attempt ${this.restartCount}/${PERSISTENT_MAX_RESTART_ATTEMPTS}, waiting ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
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

      // Resume from last known session (enables prompt cache reuse on restart)
      if (this.lastSessionId) {
        args.push("--resume", this.lastSessionId);
        info("persistent", `[${this.agentId}] Resuming session ${this.lastSessionId}`);
      }

      validateSpawnArgs(args);

      this.proc = spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.config.cwd,
        env: this.config.env,
        windowsHide: true,
      });

      info("persistent", `[${this.agentId}] Spawned persistent process PID ${this.proc.pid}`);

      this.status = "alive";
      this.lastActivityAt = Date.now();
      // NOTE: restartCount is NOT reset here. It resets only on successful turn
      // completion (in resolveTurn). This prevents infinite crash loops where a
      // process spawns fine but crashes immediately on first input.
      this.resetIdleTimer();

      // Start the read loop
      this.startReadLoop();

      // Monitor stderr for unexpected output
      this.monitorStderr();

      // Monitor process exit
      this.monitorExit();

      return true;
    } catch (err) {
      logError("persistent", `[${this.agentId}] Failed to spawn: ${err}`);
      this.restartCount++;
      this.status = "crashed";
      return false;
    }
  }

  private writeMessage(prompt: string, imageBase64?: string, imageMimeType?: string): void {
    if (!this.proc) return;

    try {
      if (imageBase64 && imageMimeType) {
        // stream-json format with image content blocks
        const userMessage = {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: imageMimeType, data: imageBase64 },
              },
              { type: "text", text: prompt },
            ],
          },
          parent_tool_use_id: null,
        };
        this.proc.stdin.write(JSON.stringify(userMessage) + "\n");
      } else {
        // stream-json format with text-only content
        const userMessage = {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
          parent_tool_use_id: null,
        };
        this.proc.stdin.write(JSON.stringify(userMessage) + "\n");
      }
    } catch (err) {
      warn("persistent", `[${this.agentId}] Failed to write to stdin: ${err}`);
      if (this.currentTurn) {
        this.resolveTurn("Failed to send message to Claude process.", true, "write_error");
      }
    }
  }

  private startReadLoop(): void {
    if (this.readLoopRunning || !this.proc) return;
    this.readLoopRunning = true;

    const reader = this.proc.stdout.getReader();
    this.reader = reader;

    const parser = createStreamParser((event: StreamEvent) => {
      this.lastActivityAt = Date.now();

      if (!this.currentTurn) return; // no active turn, ignore stale events

      if (event.sessionId) {
        this.currentTurn.sessionId = event.sessionId;
      }

      switch (event.type) {
        case "assistant":
          this.currentTurn.toolCallCount++;
          // Forward tool call events for code task capture
          if (event.toolName === "TodoWrite" && event.toolInput?.todos && this.currentTurn.onCodeTaskCaptured) {
            // Delegate to the same TodoWrite interception logic as callClaude
            const todos = event.toolInput.todos as Array<{ content: string; status: string }>;
            const captured: Array<{ cwd: string; prompt: string; timeoutMs?: number }> = [];
            for (const todo of todos) {
              if (typeof todo.content === "string" && todo.content.startsWith("CODE_TASK:")) {
                const parsed = parseCodeTaskFromTodoContent(todo.content);
                if (parsed) captured.push(parsed);
              }
            }
            if (captured.length > 0) {
              this.currentTurn.onCodeTaskCaptured(captured);
            }
          }
          break;

        case "thinking":
          // Activity signal — keep alive
          break;

        case "text_delta":
          if (event.textDelta && this.currentTurn.onTextDelta) {
            this.currentTurn.onTextDelta(event.textDelta);
          }
          break;

        case "result":
          this.currentTurn.gotResult = true;
          this.currentTurn.resultText = event.resultText || "";
          this.currentTurn.inputTokens = event.inputTokens || 0;
          this.currentTurn.outputTokens = event.outputTokens || 0;
          if (event.isError) {
            this.currentTurn.isError = true;
            this.currentTurn.errorInfo = event.errorSubtype || "unknown";
          }
          // Turn is complete — resolve the promise
          this.resolveTurn(
            this.currentTurn.resultText,
            this.currentTurn.isError,
            this.currentTurn.errorInfo,
          );
          break;
      }
    });

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = this.decoder.decode(value, { stream: true });
          parser.feed(chunk);
        }
        parser.flush();
      } catch {
        // Stream closed — process exited or crashed
      }
      this.readLoopRunning = false;
    })();
  }

  private monitorStderr(): void {
    if (!this.proc) return;

    // Incremental stderr reader — logs chunks as they arrive instead of
    // waiting for process exit (which would block for the entire lifetime).
    const stderrReader = this.proc.stderr.getReader();
    const stderrDecoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          const text = stderrDecoder.decode(value, { stream: true }).trim();
          if (text) {
            warn("persistent", `[${this.agentId}] stderr: ${text.substring(0, 500)}`);
          }
        }
      } catch {
        // Stream closed — process exited
      }
    })();
  }

  private monitorExit(): void {
    if (!this.proc) return;

    this.proc.exited.then((code) => {
      if (this.status === "shutdown") return; // expected exit

      warn("persistent", `[${this.agentId}] Process exited unexpectedly (code ${code})`);

      // If a turn was in progress, resolve it with an error
      if (this.currentTurn) {
        this.resolveTurn(
          "Claude process crashed mid-response. Retrying...",
          true,
          "process_crash",
        );
      }

      this.proc = null;
      this.reader = null;
      this.readLoopRunning = false;
      this.status = "crashed";
      this.restartCount++;

      // Auto-restart with backoff
      if (this.restartCount < PERSISTENT_MAX_RESTART_ATTEMPTS) {
        this.status = "restarting";
        this.spawnProcess().catch((err) => {
          logError("persistent", `[${this.agentId}] Auto-restart failed: ${err}`);
        });
      }
    });
  }

  private resolveTurn(text: string, isError: boolean, errorInfo: string): void {
    if (!this.currentTurn) return;

    const turn = this.currentTurn;
    this.currentTurn = null;
    this.status = this.proc ? "alive" : "crashed";
    this.resetIdleTimer();

    // Track session ID for --resume on restart
    if (turn.sessionId) {
      this.lastSessionId = turn.sessionId;
    }

    // Reset restart counter on successful turn (NOT on spawn)
    if (!isError) {
      this.restartCount = 0;
    }

    turn.resolve({
      text,
      sessionId: turn.sessionId,
      isError,
      errorInfo,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      toolCallCount: turn.toolCallCount,
      durationMs: Date.now() - turn.startTime,
    });
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.isAlive() && !this.isBusy()) {
        info("persistent", `[${this.agentId}] Idle for ${PERSISTENT_IDLE_KILL_MS / 60000}min. Killing to save resources.`);
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
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/persistent-process.test.ts 2>&1 | tail -15`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/persistent-process.ts tests/persistent-process.test.ts
git commit -m "feat: add PersistentProcess class for long-lived Claude CLI subprocess"
```

---

## Task 3: ProcessPool

**Files:**
- Create: `src/persistent-pool.ts`
- Create: `tests/persistent-pool.test.ts`

The pool manages one `PersistentProcess` per agent key. Lazy initialization — processes are only spawned on first use.

- [ ] **Step 1: Write the test file**

```typescript
// tests/persistent-pool.test.ts
import { describe, test, expect, afterEach } from "bun:test";

describe("ProcessPool", () => {
  afterEach(async () => {
    // Ensure pool is shut down between tests
    const { processPool } = await import("../src/persistent-pool.ts");
    await processPool.shutdownAll();
  });

  test("exports processPool singleton", async () => {
    const mod = await import("../src/persistent-pool.ts");
    expect(mod.processPool).toBeDefined();
    expect(typeof mod.processPool.get).toBe("function");
    expect(typeof mod.processPool.shutdownAll).toBe("function");
  });

  test("get() returns a PersistentProcess for a given agent", async () => {
    const { processPool } = await import("../src/persistent-pool.ts");
    const proc = processPool.get("atlas");
    expect(proc).toBeDefined();
    expect(proc.agentId).toBe("atlas");
  });

  test("get() returns the same instance for the same agent", async () => {
    const { processPool } = await import("../src/persistent-pool.ts");
    const a = processPool.get("atlas");
    const b = processPool.get("atlas");
    expect(a).toBe(b);
  });

  test("get() returns different instances for different agents", async () => {
    const { processPool } = await import("../src/persistent-pool.ts");
    const atlas = processPool.get("atlas");
    const ishtar = processPool.get("ishtar");
    expect(atlas).not.toBe(ishtar);
    expect(atlas.agentId).toBe("atlas");
    expect(ishtar.agentId).toBe("ishtar");
  });

  test("getStatus() returns state for all processes", async () => {
    const { processPool } = await import("../src/persistent-pool.ts");
    processPool.get("atlas"); // force creation
    const status = processPool.getStatus();
    expect(status.atlas).toBeDefined();
    expect(status.atlas.status).toBe("idle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/persistent-pool.test.ts 2>&1 | tail -10`
Expected: FAIL — module not found.

- [ ] **Step 3: Create persistent-pool.ts**

```typescript
// src/persistent-pool.ts
/**
 * Atlas — Persistent Process Pool
 *
 * Manages one PersistentProcess per agent (Atlas, Ishtar).
 * Lazy initialization: processes spawn on first sendTurn(), not on pool creation.
 *
 * Usage:
 *   import { processPool } from "./persistent-pool.ts";
 *   const proc = processPool.get("atlas");
 *   await proc.ensureAlive();
 *   const result = await proc.sendTurn(prompt, { onTextDelta, ... });
 */

import { join, dirname } from "path";
import { PersistentProcess, type PersistentProcessConfig, type ProcessState } from "./persistent-process.ts";
import { sanitizedEnv } from "./claude.ts";
import { MODELS, DEFAULT_MODEL, type ModelTier } from "./constants.ts";
import { info } from "./logger.ts";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_ROOT = dirname(dirname(import.meta.path));
const PROJECT_DIR = process.env.PROJECT_DIR || PROJECT_ROOT;
const MCP_CONFIG_PATH = join(PROJECT_DIR, "mcp-servers", "mcp.json");

class ProcessPool {
  private processes = new Map<string, PersistentProcess>();

  /**
   * Get (or create) the PersistentProcess for an agent.
   * Does NOT spawn the process — call ensureAlive() or sendTurn() for that.
   */
  get(agentId: string, modelTier?: ModelTier): PersistentProcess {
    const key = agentId;
    if (this.processes.has(key)) return this.processes.get(key)!;

    const model = modelTier || DEFAULT_MODEL;
    const config: PersistentProcessConfig = {
      agentId,
      modelId: MODELS[model],
      claudePath: CLAUDE_PATH,
      cwd: PROJECT_DIR,
      env: sanitizedEnv() as Record<string, string | undefined>,
      mcpConfigPath: MCP_CONFIG_PATH,
    };

    const proc = new PersistentProcess(config);
    this.processes.set(key, proc);
    info("pool", `Created persistent process entry for ${agentId} (model: ${model})`);
    return proc;
  }

  /** Check if an agent has a live persistent process */
  hasAlive(agentId: string): boolean {
    const proc = this.processes.get(agentId);
    return !!proc && proc.isAlive();
  }

  /** Get status of all managed processes */
  getStatus(): Record<string, ProcessState> {
    const status: Record<string, ProcessState> = {};
    for (const [key, proc] of this.processes) {
      status[key] = proc.getState();
    }
    return status;
  }

  /** Shutdown all processes (called on PM2 restart / graceful shutdown) */
  async shutdownAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [key, proc] of this.processes) {
      info("pool", `Shutting down persistent process for ${key}`);
      promises.push(proc.shutdown());
    }
    await Promise.allSettled(promises);
    this.processes.clear();
  }

  /** Restart a specific agent's process (e.g., after model change or MCP config update) */
  async restartAgent(agentId: string): Promise<boolean> {
    const proc = this.processes.get(agentId);
    if (!proc) return false;
    return proc.restart();
  }
}

/** Singleton pool instance */
export const processPool = new ProcessPool();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/persistent-pool.test.ts 2>&1 | tail -15`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/persistent-pool.ts tests/persistent-pool.test.ts
git commit -m "feat: add ProcessPool for managing per-agent persistent processes"
```

---

## Task 4: Refactor callClaude() — Routing Logic

**Files:**
- Modify: `src/claude.ts`
- Create: `tests/claude-routing.test.ts`

The key refactor: `callClaude()` gains an internal routing decision. Interactive user messages go through the persistent process. Everything else uses the existing one-shot spawn.

- [ ] **Step 1: Write routing test**

```typescript
// tests/claude-routing.test.ts
import { describe, test, expect } from "bun:test";

/**
 * Test the routing decision logic.
 * We test the exported helper, not callClaude itself (which requires a running Claude CLI).
 */
describe("callClaude routing", () => {
  test("shouldUsePersistent returns true for interactive calls", async () => {
    const { shouldUsePersistent } = await import("../src/claude.ts");
    expect(shouldUsePersistent({ skipLock: true })).toBe(true);
    expect(shouldUsePersistent({ skipLock: true, model: "opus" })).toBe(true);
  });

  test("shouldUsePersistent returns false for isolated calls", async () => {
    const { shouldUsePersistent } = await import("../src/claude.ts");
    expect(shouldUsePersistent({ isolated: true })).toBe(false);
  });

  test("shouldUsePersistent returns false for fallback calls", async () => {
    const { shouldUsePersistent } = await import("../src/claude.ts");
    expect(shouldUsePersistent({ _isFallback: true } as any)).toBe(false);
  });

  test("shouldUsePersistent returns false when persistent: false is explicit", async () => {
    const { shouldUsePersistent } = await import("../src/claude.ts");
    expect(shouldUsePersistent({ persistent: false })).toBe(false);
  });

  test("shouldUsePersistent returns false for cron-style calls (no agentId or default lock behavior)", async () => {
    const { shouldUsePersistent } = await import("../src/claude.ts");
    // Cron calls typically use lockBehavior: "skip" and don't set skipLock
    expect(shouldUsePersistent({ lockBehavior: "skip" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/claude-routing.test.ts 2>&1 | tail -10`
Expected: FAIL — `shouldUsePersistent` not exported.

- [ ] **Step 3: Add the routing function and persistent option to callClaude**

In `src/claude.ts`, add the `persistent` option to the options interface (after `_isSpawnRetry`):

```typescript
    persistent?: boolean; // explicit override: true = force persistent, false = force one-shot
```

Add the routing function right before the `callClaude` function (after the `STATUS_INTERVAL_MS` constant):

```typescript
/**
 * Determine whether a callClaude invocation should use the persistent process.
 *
 * Rules:
 * - Explicit `persistent: false` → one-shot (cron jobs, background tasks)
 * - `isolated: true` → one-shot (cron/background, don't touch shared session)
 * - `_isFallback` or `_isEmptyRetry` or `_isSpawnRetry` → one-shot (recovery paths)
 * - `lockBehavior: "skip"` → one-shot (heartbeat/cron pattern)
 * - `skipLock: true` → persistent (relay.ts interactive pattern: caller holds lock)
 * - Default → one-shot (safe default)
 */
export function shouldUsePersistent(options?: {
  persistent?: boolean;
  isolated?: boolean;
  skipLock?: boolean;
  lockBehavior?: "wait" | "skip";
  _isFallback?: boolean;
  _isEmptyRetry?: boolean;
  _isSpawnRetry?: boolean;
}): boolean {
  if (!options) return false;
  if (options.persistent === false) return false;
  if (options.persistent === true) return true;
  if (options.isolated) return false;
  if ((options as any)._isFallback) return false;
  if ((options as any)._isEmptyRetry) return false;
  if ((options as any)._isSpawnRetry) return false;
  if (options.lockBehavior === "skip") return false;
  // Interactive relay pattern: caller holds lock, model is known, agent is specified
  if (options.skipLock) return true;
  return false;
}
```

- [ ] **Step 4: Run routing tests to verify they pass**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/claude-routing.test.ts 2>&1 | tail -15`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/claude.ts tests/claude-routing.test.ts
git commit -m "feat: add shouldUsePersistent routing logic to callClaude"
```

---

## Task 5: Wire Persistent Path Into callClaude()

**Files:**
- Modify: `src/claude.ts`

This is the integration step. At the top of `callClaude()`, after lock acquisition, we check `shouldUsePersistent()`. If true, we route through the persistent process and return early. The entire existing one-shot path stays untouched as the fallback.

- [ ] **Step 1: Add import for processPool at the top of claude.ts**

After the existing imports in `src/claude.ts`, add:

```typescript
import { processPool } from "./persistent-pool.ts";
```

- [ ] **Step 2: Add the persistent path inside callClaude()**

In `callClaude()`, immediately after the lock acquisition block (after `release = lock.release;` on ~line 654, inside the `try` block), add the persistent routing:

```typescript
    // ── Persistent process routing ──────────────────────────
    // Interactive user messages go through the persistent pipe.
    // Everything else (cron, background, fallback, retry) uses one-shot below.
    if (shouldUsePersistent(options)) {
      try {
        const session = await getSession(agentId, userId);
        const proc = processPool.get(agentId, modelTier);
        // Pass session ID so the persistent process can --resume on spawn/restart
        if (session.sessionId && !proc.isAlive()) {
          proc.setSessionId(session.sessionId);
        }
        const turnResult = await proc.sendTurn(prompt, {
          imageBase64: options?.imageBase64,
          imageMimeType: options?.imageMimeType,
          onTextDelta: options?.onTextDelta,
          onTyping: options?.onTyping,
          onStatus: options?.onStatus,
          onCodeTaskCaptured: options?.onCodeTaskCaptured,
        });

        // Track cost
        const costRates = TOKEN_COSTS[modelTier] || TOKEN_COSTS.sonnet;
        const callCostUsd = (turnResult.inputTokens * costRates.input + turnResult.outputTokens * costRates.output) / 1_000_000;
        trackClaudeCall(turnResult.durationMs, {
          model: modelTier,
          inputTokens: turnResult.inputTokens,
          outputTokens: turnResult.outputTokens,
          costUsd: callCostUsd,
        });

        info(
          "claude",
          `[${agentId}] PERSISTENT responded in ${Math.round(turnResult.durationMs / 1000)}s (${modelTier}) | ` +
          `${turnResult.inputTokens}in/${turnResult.outputTokens}out | $${callCostUsd.toFixed(4)} | ${turnResult.toolCallCount} tools`
        );

        // Update session state with the persistent session ID
        if (turnResult.sessionId && !options?.isolated) {
          const session = await getSession(agentId, userId);
          session.sessionId = turnResult.sessionId;
          session.lastActivity = new Date().toISOString();
          await saveSessionState(agentId, userId, session);
        }

        // On crash/error, fall back to one-shot for this turn
        if (turnResult.isError && turnResult.errorInfo === "process_crash") {
          warn("claude", `[${agentId}] Persistent process crashed mid-turn. Falling back to one-shot.`);
          // Fall through to one-shot path below by NOT returning
        } else if (turnResult.isError && turnResult.errorInfo === "spawn_failed") {
          warn("claude", `[${agentId}] Persistent process failed to start. Falling back to one-shot.`);
          // Fall through to one-shot path below
        } else {
          // Success or non-crash error — return the result
          return stripReasoningTags(turnResult.text) || "No response generated.";
        }
      } catch (err) {
        warn("claude", `[${agentId}] Persistent path failed: ${err}. Falling back to one-shot.`);
        // Fall through to one-shot path
      }
    }
    // ── End persistent process routing ──────────────────────
```

- [ ] **Step 3: Verify claude.ts compiles**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/claude.ts --no-bundle 2>&1 | head -10`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/claude.ts
git commit -m "feat: wire persistent process path into callClaude with one-shot fallback"
```

---

## Task 6: Graceful Shutdown on PM2 Restart

**Files:**
- Modify: `src/relay.ts` (find the existing graceful shutdown handler)

The persistent processes must be shut down cleanly when PM2 restarts Atlas. Otherwise the Claude CLI processes become orphans.

- [ ] **Step 1: Find existing shutdown handler in relay.ts**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && grep -n "gracefulShutdown\|SIGTERM\|SIGINT\|process.on" src/relay.ts | head -20`

- [ ] **Step 2: Add processPool.shutdownAll() to the existing shutdown handler**

At the top of relay.ts imports, add:

```typescript
import { processPool } from "./persistent-pool.ts";
```

In the existing `gracefulShutdown()` function (or the SIGTERM/SIGINT handler), add as the FIRST cleanup step:

```typescript
  // Shut down persistent processes first (they hold Claude CLI subprocesses)
  await processPool.shutdownAll();
```

- [ ] **Step 3: Verify relay.ts compiles**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/relay.ts --no-bundle 2>&1 | head -10`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/relay.ts
git commit -m "feat: shutdown persistent processes on PM2 restart"
```

---

## Task 7: Add /procstatus Command for Monitoring

**Files:**
- Modify: `src/relay.ts` (add slash command handler)

A quick diagnostic command so you can see the persistent process state from Telegram.

- [ ] **Step 1: Find where slash commands are registered in relay.ts**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && grep -n "bot.command\|hears.*/" src/relay.ts | head -30`

- [ ] **Step 2: Add the /procstatus command**

In the slash command section, add:

```typescript
bot.command("procstatus", async (ctx) => {
  const status = processPool.getStatus();
  if (Object.keys(status).length === 0) {
    await ctx.reply("No persistent processes initialized.");
    return;
  }

  const lines = Object.entries(status).map(([agentId, state]) => {
    const uptime = state.lastActivityAt > 0
      ? `${Math.round((Date.now() - state.lastActivityAt) / 1000)}s ago`
      : "never";
    return `**${agentId}**: ${state.status} | PID: ${state.pid || "none"} | restarts: ${state.restartCount} | last activity: ${uptime}`;
  });

  await ctx.reply(`**Persistent Processes**\n${lines.join("\n")}`);
});
```

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/relay.ts
git commit -m "feat: add /procstatus command for persistent process monitoring"
```

---

## Task 8: Integration Test — End-to-End Smoke Test

**Files:**
- Create: `tests/persistent-integration.test.ts`

This test verifies the full flow works with a real Claude CLI process (requires `claude` to be installed and authenticated).

- [ ] **Step 1: Write the integration test**

```typescript
// tests/persistent-integration.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { PersistentProcess } from "../src/persistent-process.ts";
import { sanitizedEnv } from "../src/claude.ts";
import { MODELS } from "../src/constants.ts";
import { dirname } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

// Skip this test in CI or when Claude CLI is not available
const canRunClaude = (() => {
  try {
    Bun.spawnSync([CLAUDE_PATH, "--version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!canRunClaude)("PersistentProcess Integration", () => {
  let proc: PersistentProcess;

  afterAll(async () => {
    if (proc) await proc.shutdown();
  });

  test("spawns, sends a turn, and receives a result", async () => {
    proc = new PersistentProcess({
      agentId: "test-integration",
      modelId: MODELS.haiku, // use cheapest model for testing
      claudePath: CLAUDE_PATH,
      cwd: PROJECT_ROOT,
      env: sanitizedEnv() as Record<string, string | undefined>,
    });

    await proc.ensureAlive();
    expect(proc.isAlive()).toBe(true);

    const result = await proc.sendTurn("Reply with exactly: PONG");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("PONG");
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.sessionId).toBeTruthy();
  }, 60_000); // 60s timeout for Claude to respond

  test("second turn reuses the same process", async () => {
    // proc should still be alive from the previous test
    expect(proc.isAlive()).toBe(true);

    const result = await proc.sendTurn("What was the first thing I said to you?");
    expect(result.isError).toBe(false);
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.durationMs).toBeGreaterThan(0);
  }, 60_000);
});
```

- [ ] **Step 2: Run the integration test**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/persistent-integration.test.ts 2>&1`
Expected: 2 tests pass (or skip if Claude CLI not available). The second test proves conversation context is maintained.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add tests/persistent-integration.test.ts
git commit -m "test: add persistent process integration test with real Claude CLI"
```

---

## Task 9: MCP Config — Dynamic Update Support

**Files:**
- Modify: `src/persistent-process.ts`

Currently the one-shot path builds MCP config per-call based on intent flags. The persistent process needs a way to start with the full MCP config (since we don't know intent at spawn time) or restart when the needed MCP set changes.

- [ ] **Step 1: Update PersistentProcess spawn to always use full MCP config**

In `persistent-process.ts`, the `spawnProcess()` method already passes `mcpConfigPath`. Verify it uses the full config path (not a filtered one). This is correct because:
- The persistent process stays alive across turns with varying intents
- MCP servers are lazy-loaded by Claude CLI (they don't all spin up at once)
- Cost of having all servers available is negligible vs. the cost of restarting

No code change needed here — just verify and document the decision.

- [ ] **Step 2: Add a note in the class docstring**

At the top of `persistent-process.ts`, update the module docstring to include:

```typescript
 * MCP: The persistent process always gets the full MCP config (all servers).
 * Claude CLI lazy-loads MCP servers, so unused ones have zero runtime cost.
 * This avoids needing to restart the process when intent changes between turns.
```

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/persistent-process.ts
git commit -m "docs: document MCP config strategy for persistent process"
```

---

## Task 10: Loop Detection for Persistent Process

**Files:**
- Modify: `src/persistent-process.ts`

The one-shot `callClaude()` has sophisticated loop detection (duplicate calls, ping-pong, fruitless search, global circuit breaker). The persistent process needs the same protection per-turn.

- [ ] **Step 1: Extract loop detection into a reusable function**

In `src/claude.ts`, the loop detection logic is inline in the stream parser callback (~lines 800-945). This is too entangled to extract cleanly in Phase 1. Instead, add per-turn tool call counting with a hard ceiling to the persistent process.

In `persistent-process.ts`, in the `TurnContext` interface, the `toolCallCount` field already exists. In the `startReadLoop` parser callback, add a check in the `assistant` case:

After `this.currentTurn.toolCallCount++;`, add:

```typescript
          // Hard ceiling loop detection (matches MAX_TOOL_CALLS_PER_REQUEST from one-shot path)
          // MAX_TOOL_CALLS_PER_REQUEST is imported at the top of the file via static import
          if (this.currentTurn.toolCallCount > MAX_TOOL_CALLS_PER_REQUEST) {
            warn("persistent", `[${this.agentId}] Tool call loop: ${this.currentTurn.toolCallCount} calls. Force-resolving turn.`);
            this.resolveTurn(
              `Hit the tool call limit (${this.currentTurn.toolCallCount} calls). Try breaking this into smaller steps.`,
              true,
              "tool_loop",
            );
            return;
          }
```

Note: Full loop detection (duplicate signatures, ping-pong, etc.) will be ported in a follow-up task. The hard ceiling is sufficient protection for Phase 1.

- [ ] **Step 2: Verify it compiles**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/persistent-process.ts --no-bundle 2>&1 | head -5`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/persistent-process.ts
git commit -m "feat: add tool call ceiling loop detection to persistent process"
```

---

## Task 11: Inactivity Watchdog for Persistent Turns

**Files:**
- Modify: `src/persistent-process.ts`

The one-shot path has an inactivity watchdog (kill if Claude goes silent). The persistent process needs the same, but scoped to the current turn — not the process lifetime.

- [ ] **Step 1: Add per-turn inactivity watchdog**

In `persistent-process.ts`, add to the `sendTurn()` method, after writing the message:

```typescript
      // Per-turn inactivity watchdog: if Claude goes silent for too long during this turn,
      // resolve with a timeout error. The process stays alive for next turns.
      const TURN_INACTIVITY_MS = parseInt(process.env.CLAUDE_INACTIVITY_MS || "180000", 10) *
        (this.config.modelId.includes("opus") ? 3.0 : this.config.modelId.includes("haiku") ? 1.0 : 2.0);
      const TURN_WALL_CLOCK_MS = parseInt(process.env.CLAUDE_MAX_WALL_MS || "900000", 10) *
        (this.config.modelId.includes("opus") ? 3.0 : this.config.modelId.includes("haiku") ? 1.0 : 2.0);

      const watchdogInterval = setInterval(() => {
        if (!this.currentTurn) {
          clearInterval(watchdogInterval);
          return;
        }
        const now = Date.now();
        const wallElapsed = now - this.currentTurn.startTime;
        const idleElapsed = now - this.lastActivityAt;

        if (wallElapsed > TURN_WALL_CLOCK_MS) {
          warn("persistent", `[${this.agentId}] Turn wall clock exceeded (${Math.round(wallElapsed / 1000)}s)`);
          clearInterval(watchdogInterval);
          this.resolveTurn(
            `Sorry, that took too long (wall clock: ${Math.round(wallElapsed / 1000)}s). Try again or simplify.`,
            true,
            "wall_timeout",
          );
        } else if (idleElapsed > TURN_INACTIVITY_MS) {
          warn("persistent", `[${this.agentId}] Turn inactivity timeout (${Math.round(idleElapsed / 1000)}s idle)`);
          clearInterval(watchdogInterval);
          this.resolveTurn(
            `Sorry, that took too long (inactive: ${Math.round(idleElapsed / 1000)}s). Try again or simplify.`,
            true,
            "inactivity_timeout",
          );
        }
      }, 5_000);

      // Clean up watchdog when turn resolves (patch resolveTurn to clear it)
      const origResolve = this.currentTurn.resolve;
      this.currentTurn.resolve = (result) => {
        clearInterval(watchdogInterval);
        origResolve(result);
      };
```

This needs to be placed inside the `new Promise` callback, after `this.writeMessage(...)`.

- [ ] **Step 2: Verify it compiles**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/persistent-process.ts --no-bundle 2>&1 | head -5`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/persistent-process.ts
git commit -m "feat: add per-turn inactivity watchdog to persistent process"
```

---

## Task 12: Feature Flag — Gradual Rollout

**Files:**
- Modify: `src/constants.ts`
- Modify: `src/claude.ts`

Add a kill switch so you can disable persistent mode instantly if issues arise, without redeploying.

- [ ] **Step 1: Add feature flag constant**

In `src/constants.ts`, add to the persistent process section:

```typescript
/** Feature flag: enable persistent process for interactive calls.
 *  Set PERSISTENT_PROCESS_ENABLED=false in .env to disable without code change. */
export const PERSISTENT_PROCESS_ENABLED = process.env.PERSISTENT_PROCESS_ENABLED !== "false";
```

- [ ] **Step 2: Gate shouldUsePersistent on the feature flag**

In `src/claude.ts`, at the top of `shouldUsePersistent()`, add:

```typescript
  if (!PERSISTENT_PROCESS_ENABLED) return false;
```

And add the import:

```typescript
import { PERSISTENT_PROCESS_ENABLED } from "./constants.ts";
```

Wait — `PERSISTENT_PROCESS_ENABLED` is already imported via the constants block. Add it to the existing destructured import from `"./constants.ts"`.

- [ ] **Step 3: Update routing tests to account for the feature flag**

In `tests/claude-routing.test.ts`, add a test and update the existing "returns false" tests to set the env var:

```typescript
  test("shouldUsePersistent returns false when PERSISTENT_PROCESS_ENABLED is false", async () => {
    // This test requires reloading the module with the env var set.
    // In practice, the flag is read at module load time from constants.ts.
    // For unit testing, we test the function with explicit persistent: false.
    const { shouldUsePersistent } = await import("../src/claude.ts");
    expect(shouldUsePersistent({ persistent: false })).toBe(false);
  });
```

- [ ] **Step 4: Run all tests**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/claude-routing.test.ts tests/persistent-process.test.ts tests/persistent-pool.test.ts 2>&1 | tail -20`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/constants.ts src/claude.ts
git commit -m "feat: add PERSISTENT_PROCESS_ENABLED feature flag for gradual rollout"
```

---

## Task 13: Update Capability Registry

**Files:**
- Modify: `src/capability-registry.ts`

Per the task delegation rules, any change to a core module must also update the capability registry.

- [ ] **Step 1: Find capability-registry.ts and add persistent process info**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && grep -n "claude\|subagent\|session" src/capability-registry.ts | head -20`

Add a note in the Subagents or Session Management section about the persistent process pool:

```typescript
  // Persistent Process Pool: interactive user messages route through a long-lived
  // Claude CLI subprocess per agent (Atlas, Ishtar). Eliminates cold starts and
  // enables prompt cache reuse. Managed by src/persistent-pool.ts.
  // Feature flag: PERSISTENT_PROCESS_ENABLED (env var, default true).
  // Monitor: /procstatus command shows process state.
  // Cron/background/isolated calls still use one-shot spawn.
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/capability-registry.ts
git commit -m "docs: update capability registry with persistent process info"
```

---

## Rollout Strategy

1. **First deploy**: Set `PERSISTENT_PROCESS_ENABLED=false` in `.env`. Deploy all code changes. Verify nothing breaks (one-shot path is unchanged).

2. **Enable for Atlas only**: Set `PERSISTENT_PROCESS_ENABLED=true`. Send a test message. Check `/procstatus`. Verify streaming works, response arrives, process stays alive.

3. **Soak test**: Leave enabled for 1-2 hours of normal usage. Watch for:
   - Orphaned processes (check `ps aux | grep claude` after PM2 restart)
   - Memory growth (process should stay stable)
   - Session continuity (does the 2nd message know about the 1st?)
   - Crash recovery (kill the process manually, verify it restarts)

4. **Monitor**: After 24h, compare:
   - Response latency (should drop from 15-30s to 2-5s for subsequent turns)
   - Token costs (prompt cache should hit after first turn)
   - Error rate (should be same or better)

---

## What's NOT Included (Deferred to Phase 2+)

- **Tiered context loading** (Phase 2) — buildPrompt() still injects everything. Prompt size reduction is independent.
- **Full loop detection port** — the persistent process uses a hard ceiling (300 tools). Sophisticated signature-based detection ports later.
- **Per-agent model switching** — if the model changes mid-session (e.g., `/model sonnet`), the persistent process doesn't auto-restart. Add a check or `/procstatus restart` command in a follow-up.
- **Multiple MCP config sets** — uses full config always. Could optimize later for faster startup.
- **Conversation summarization** (Phase 4) — the persistent process benefits from this but doesn't require it.
- **Prompt cache breakpoints** (Phase 5) — requires Claude CLI support for explicit cache breakpoints.
