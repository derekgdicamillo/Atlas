# Atlas SDK Engine Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inside an isolated git worktree created via superpowers:using-git-worktrees — the live bot runs from `master` via PM2 and must not be disturbed.

**Goal:** Let Atlas talk to Claude through the Claude Agent SDK instead of spawning the `claude` CLI as a subprocess — swapped behind the existing `callClaude()` function so no caller changes, gated by an env flag so the live system is never at risk.

**Architecture:** `callClaude()` (in `src/claude.ts`) is the single chokepoint every caller (relay, cron, heartbeat, orchestrator, exploration, etc.) already funnels through — prompt in, string out, plus optional streaming callbacks. We introduce a tiny **engine router** that, per call, picks `"cli"` (default, unchanged) or `"sdk"`. The SDK path is a self-contained branch that runs `query()` from `@anthropic-ai/claude-agent-sdk`, maps the SDK's typed messages onto Atlas's existing `StreamEvent` shape so all downstream wiring (streaming callbacks, cost tracking, session persistence) is reused, and returns the same assistant-text string. The CLI path is left **byte-for-byte untouched**. Cutover and rollback are a single env var (`ATLAS_ENGINE`). This same router is the future provider-router seam (break-glass to a proxy later) — but multi-provider is explicitly out of scope here.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk` (new dep; verified to run on Bun and authenticate via the existing Claude subscription OAuth — no API key), `bun test` for unit tests, existing `StreamEvent`/`createStreamParser` types in `src/claude.ts`.

---

## Scope

**In scope (this plan, one working/testable subsystem):** the engine swap behind `callClaude()` for the one-shot path, the router, the SDK→StreamEvent adapter, MCP/permission/model/resume/timeout mapping for the SDK path, a live smoke test, and the env-flag cutover + rollback protocol.

**Explicitly OUT of scope (follow-on plans):**
- The persistent-process pool (`persistent-process.ts`) — Phase 0 SDK path forces the one-shot route; the pool stays CLI-only for now.
- Replacing relay's `[SEND:]`/`[GHL_*:]`/`[CODE_TASK:]` tag-parsing with structured tool calls (the big payoff — but it is its own plan; here we preserve tag behavior exactly).
- RBAC / per-world identity / audit logging / Supabase RLS tenancy.
- Multi-provider routing to non-Claude models.

**Why this slice first:** it is the foundational, independently shippable unit. It de-risks everything after it, and because it preserves behavior and is flag-gated, it can ride alongside the live CLI system until proven.

---

## File Structure

- **Create `src/engine/router.ts`** — `selectEngine(options)` pure function. Single responsibility: decide cli vs sdk from env + per-call override. The seam.
- **Create `src/engine/sdk-adapter.ts`** — `mapSdkMessageToEvents(msg): StreamEvent[]` pure function. Single responsibility: translate one SDK message into zero-or-more existing `StreamEvent`s. No I/O, fully unit-testable.
- **Create `src/engine/mcp-config.ts`** — `loadMcpServersForSdk(intentFlags?)`: reuse the intent→server filtering and return the SDK's `mcpServers` object shape (the SDK takes an object, the CLI took a `--mcp-config` path).
- **Create `src/engine/sdk-engine.ts`** — `runViaSdk(prompt, opts, onEvent): Promise<EngineResult>`: the integration. Calls `query()`, iterates messages, emits mapped events to `onEvent`, enforces inactivity/wall-clock via `AbortController`, returns `{ text, sessionId, inputTokens, outputTokens, isError, toolCallCount }`.
- **Create `src/engine/types.ts`** — `EngineResult` interface shared by the SDK path (and, later, any provider).
- **Modify `src/claude.ts`** — import the router + `runViaSdk`; insert one early-return SDK branch inside `callClaude()` after the session is loaded and before the CLI args are built. Nothing else in the CLI path changes.
- **Create `scripts/smoke-sdk.ts`** — live manual smoke test (real prompt → prints text, tokens, session id). Mirrors the throwaway test already proven this session.
- **Create tests:** `src/engine/router.test.ts`, `src/engine/sdk-adapter.test.ts`, `src/engine/mcp-config.test.ts`.

---

## Task 1: Setup — dependency, test runner, types, SDK shape check

**Files:**
- Modify: `package.json` (add dependency + test script)
- Create: `src/engine/types.ts`

- [ ] **Step 1: Install the Agent SDK**

Run: `cd <worktree> && bun add @anthropic-ai/claude-agent-sdk`
Expected: adds `@anthropic-ai/claude-agent-sdk` to `dependencies`, lockfile updates, exit 0.

- [ ] **Step 2: Add a test script to package.json**

In `package.json` `"scripts"`, add:
```json
"test": "bun test src/engine"
```

- [ ] **Step 3: Confirm the installed SDK's message/option types (ground the adapter in reality, not memory)**

Run: `bun -e "import('@anthropic-ai/claude-agent-sdk').then(m=>console.log(Object.keys(m)))"`
Expected: prints exported names including `query`. Then open `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (or the package's `.d.ts`) and confirm the exact field names used in later tasks: the init system message (`type: "system"`, `subtype: "init"`, `session_id`), assistant message (`type: "assistant"`, `message.content[]` with `type: "text" | "tool_use" | "thinking"`), and the result message (`type: "result"`, `result`, `is_error`/`subtype`, `usage.input_tokens`/`usage.output_tokens`, `total_cost_usd`). **If any field name differs from what Tasks 3 & 5 assume, update those tasks' code to match the real types before writing them.**

- [ ] **Step 4: Create the shared result type**

Create `src/engine/types.ts`:
```ts
/** Normalized result every engine (CLI today, SDK now, any provider later) produces. */
export interface EngineResult {
  text: string;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  isError: boolean;
  toolCallCount: number;
}
```

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/engine/types.ts
git commit -m "chore(engine): add Agent SDK dep, test script, EngineResult type"
```

---

## Task 2: Engine router (TDD)

**Files:**
- Create: `src/engine/router.ts`
- Test: `src/engine/router.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/engine/router.test.ts`:
```ts
import { test, expect, afterEach } from "bun:test";
import { selectEngine } from "./router.ts";

const orig = process.env.ATLAS_ENGINE;
afterEach(() => { if (orig === undefined) delete process.env.ATLAS_ENGINE; else process.env.ATLAS_ENGINE = orig; });

test("defaults to cli when unset", () => {
  delete process.env.ATLAS_ENGINE;
  expect(selectEngine()).toBe("cli");
});

test("env ATLAS_ENGINE=sdk selects sdk", () => {
  process.env.ATLAS_ENGINE = "sdk";
  expect(selectEngine()).toBe("sdk");
});

test("per-call override beats env", () => {
  process.env.ATLAS_ENGINE = "sdk";
  expect(selectEngine({ engine: "cli" })).toBe("cli");
});

test("unknown env value falls back to cli (fail safe)", () => {
  process.env.ATLAS_ENGINE = "banana";
  expect(selectEngine()).toBe("cli");
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test src/engine/router.test.ts`
Expected: FAIL — `Cannot find module './router.ts'`.

- [ ] **Step 3: Minimal implementation**

Create `src/engine/router.ts`:
```ts
export type EngineName = "cli" | "sdk";

/** Decide which inference engine to use. Default cli; fail safe to cli on bad input. */
export function selectEngine(options?: { engine?: EngineName }): EngineName {
  if (options?.engine === "cli" || options?.engine === "sdk") return options.engine;
  return process.env.ATLAS_ENGINE === "sdk" ? "sdk" : "cli";
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun test src/engine/router.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/router.ts src/engine/router.test.ts
git commit -m "feat(engine): add cli/sdk router with fail-safe default"
```

---

## Task 3: SDK→StreamEvent adapter (TDD)

**Files:**
- Create: `src/engine/sdk-adapter.ts`
- Test: `src/engine/sdk-adapter.test.ts`

The adapter maps one SDK message to the existing `StreamEvent` shape (defined in `src/claude.ts` lines 474-485). Mirrors what `createStreamParser` produces from CLI JSON, so downstream handling is identical.

- [ ] **Step 1: Write the failing test**

Create `src/engine/sdk-adapter.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mapSdkMessageToEvents } from "./sdk-adapter.ts";

test("init system message yields a system event with session id", () => {
  const evs = mapSdkMessageToEvents({ type: "system", subtype: "init", session_id: "sess_123" });
  expect(evs).toEqual([{ type: "system", sessionId: "sess_123" }]);
});

test("assistant text block yields a text_delta event", () => {
  const evs = mapSdkMessageToEvents({
    type: "assistant", session_id: "s", message: { content: [{ type: "text", text: "hello" }] },
  });
  expect(evs).toContainEqual({ type: "text_delta", sessionId: "s", textDelta: "hello" });
});

test("assistant tool_use block yields an assistant tool event", () => {
  const evs = mapSdkMessageToEvents({
    type: "assistant", session_id: "s",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  });
  expect(evs).toContainEqual({ type: "assistant", sessionId: "s", toolName: "Bash", toolInput: { command: "ls" } });
});

test("thinking block yields a thinking event (keeps inactivity timer alive)", () => {
  const evs = mapSdkMessageToEvents({
    type: "assistant", session_id: "s", message: { content: [{ type: "thinking", thinking: "..." }] },
  });
  expect(evs).toContainEqual({ type: "thinking", sessionId: "s" });
});

test("result message yields a result event with text, error flag, and tokens", () => {
  const evs = mapSdkMessageToEvents({
    type: "result", session_id: "s", subtype: "success", result: "final answer",
    is_error: false, usage: { input_tokens: 100, output_tokens: 50 },
  });
  expect(evs).toEqual([{
    type: "result", sessionId: "s", resultText: "final answer",
    isError: false, errorSubtype: "success", inputTokens: 100, outputTokens: 50,
  }]);
});

test("unknown message type yields no events", () => {
  expect(mapSdkMessageToEvents({ type: "stream_event" } as any)).toEqual([]);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test src/engine/sdk-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Minimal implementation**

Create `src/engine/sdk-adapter.ts`:
```ts
import type { StreamEvent } from "../claude.ts";

/**
 * Translate ONE Claude Agent SDK message into zero-or-more Atlas StreamEvents.
 * Pure function — mirrors createStreamParser()'s CLI-JSON handling so the rest
 * of callClaude() (callbacks, cost, session) works identically for either engine.
 * Field names confirmed against the installed SDK types in Task 1.
 */
export function mapSdkMessageToEvents(msg: any): StreamEvent[] {
  const sessionId = msg?.session_id || undefined;
  switch (msg?.type) {
    case "system":
      return [{ type: "system", sessionId }];
    case "assistant": {
      const out: StreamEvent[] = [];
      for (const block of msg?.message?.content ?? []) {
        if (block.type === "tool_use") {
          out.push({ type: "assistant", sessionId, toolName: block.name || "unknown", toolInput: block.input });
        } else if (block.type === "text" && block.text) {
          out.push({ type: "text_delta", sessionId, textDelta: block.text });
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          out.push({ type: "thinking", sessionId });
        }
      }
      return out;
    }
    case "result":
      return [{
        type: "result",
        sessionId,
        resultText: msg.result || "",
        isError: !!msg.is_error,
        errorSubtype: msg.subtype,
        inputTokens: msg.usage?.input_tokens || 0,
        outputTokens: msg.usage?.output_tokens || 0,
      }];
    default:
      return [];
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun test src/engine/sdk-adapter.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/sdk-adapter.ts src/engine/sdk-adapter.test.ts
git commit -m "feat(engine): add SDK-message to StreamEvent adapter"
```

---

## Task 4: MCP config translation (TDD)

**Files:**
- Create: `src/engine/mcp-config.ts`
- Test: `src/engine/mcp-config.test.ts`

The CLI passes `--mcp-config <path>`; the SDK takes an `mcpServers` object. Reuse the existing intent→server filtering concept from `buildMcpConfigArgs` (`src/claude.ts:65`) but return the object the SDK wants. Read the same `mcp-servers/mcp.json`.

- [ ] **Step 1: Write the failing test**

Create `src/engine/mcp-config.test.ts`:
```ts
import { test, expect } from "bun:test";
import { filterMcpServers } from "./mcp-config.ts";

const ALL = {
  atlas: { command: "bun", args: ["x"] },
  "google-suite": { command: "bun", args: ["g"] },
  "ghl-crm": { command: "bun", args: ["c"] },
  playwright: { command: "npx", args: ["p"] },
};

test("no intent flags → atlas core only", () => {
  expect(Object.keys(filterMcpServers(ALL))).toEqual(["atlas"]);
});

test("google intent adds google-suite", () => {
  const r = filterMcpServers(ALL, { google: true });
  expect(Object.keys(r).sort()).toEqual(["atlas", "google-suite"]);
});

test("browser intent adds playwright", () => {
  const r = filterMcpServers(ALL, { browser: true });
  expect(r.playwright).toBeDefined();
});

test("unknown server names in intent map are ignored safely", () => {
  const r = filterMcpServers(ALL, { pipeline: true }); // pipeline → ghl-crm
  expect(Object.keys(r).sort()).toEqual(["atlas", "ghl-crm"]);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/engine/mcp-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Minimal implementation**

Create `src/engine/mcp-config.ts`:
```ts
import { readFileSync } from "fs";
import { join, dirname } from "path";

/** Same intent→server map used by the CLI path (keep in sync with claude.ts INTENT_TO_MCP_SERVERS). */
const INTENT_TO_MCP_SERVERS: Record<string, string[]> = {
  google: ["google-suite"],
  pipeline: ["ghl-crm"],
  financial: ["pv-dashboard"],
  marketing: ["pv-dashboard", "ga4-analytics"],
  reputation: ["gbp"],
  analytics: ["ga4-analytics"],
  coding: [],
  browser: ["playwright"],
  todos: [],
};

/** Pure: given the full server map + intent flags, return the subset (atlas core always included). */
export function filterMcpServers(
  all: Record<string, any>,
  intentFlags?: Record<string, boolean>,
): Record<string, any> {
  const needed = new Set<string>(["atlas"]);
  if (intentFlags) {
    for (const [intent, servers] of Object.entries(INTENT_TO_MCP_SERVERS)) {
      if (intentFlags[intent]) for (const s of servers) needed.add(s);
    }
  }
  const out: Record<string, any> = {};
  for (const name of needed) if (all[name]) out[name] = all[name];
  return out;
}

/** Load mcp-servers/mcp.json and return the SDK-shaped mcpServers object, filtered by intent. */
export function loadMcpServersForSdk(intentFlags?: Record<string, boolean>): Record<string, any> {
  const path = join(process.env.PROJECT_DIR || process.cwd(), "mcp-servers", "mcp.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const all = parsed.mcpServers || parsed; // mcp.json wraps under mcpServers
    return filterMcpServers(all, intentFlags);
  } catch {
    return {};
  }
}
```
**Before writing:** open `mcp-servers/mcp.json` and confirm the top-level key (`mcpServers` vs flat) and that each server entry is SDK-compatible (`command`/`args`/`env` or `url`/`type` for http). Adjust the `parsed.mcpServers || parsed` line and the test fixture to match the real file.

- [ ] **Step 4: Run, verify pass**

Run: `bun test src/engine/mcp-config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/mcp-config.ts src/engine/mcp-config.test.ts
git commit -m "feat(engine): translate intent-filtered MCP config to SDK mcpServers shape"
```

---

## Task 5: SDK engine integration (`runViaSdk`)

**Files:**
- Create: `src/engine/sdk-engine.ts`

No pure unit test here (it calls the live SDK); it is exercised by the smoke test in Task 7. Keep the file focused: run `query()`, map messages via the adapter, drive the same callbacks, enforce timeouts via `AbortController`, return `EngineResult`.

- [ ] **Step 1: Write the implementation**

Create `src/engine/sdk-engine.ts`:
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { StreamEvent } from "../claude.ts";
import type { EngineResult } from "./types.ts";
import { mapSdkMessageToEvents } from "./sdk-adapter.ts";
import { loadMcpServersForSdk } from "./mcp-config.ts";

export interface RunViaSdkOptions {
  modelId: string;                 // resolved model string (MODELS[tier])
  resumeSessionId?: string | null; // prior SDK session id, if resuming
  workspaceDir?: string;
  mcpIntentFlags?: Record<string, boolean>;
  inactivityMs: number;
  wallClockMs: number;
}

/**
 * Run one turn through the Claude Agent SDK. Emits the SAME StreamEvents the CLI
 * parser emits (via onEvent) so callClaude's existing wiring is reused verbatim.
 * Auth: inherits the Claude subscription OAuth (no API key), confirmed on Bun.
 */
export async function runViaSdk(
  prompt: string,
  opts: RunViaSdkOptions,
  onEvent: (e: StreamEvent) => void,
): Promise<EngineResult> {
  const controller = new AbortController();
  let lastActivity = Date.now();
  const startedAt = Date.now();

  let text = "";
  let sessionId: string | null = opts.resumeSessionId ?? null;
  let inputTokens = 0, outputTokens = 0, toolCallCount = 0, isError = false;

  // Watchdog: abort on inactivity or wall-clock, same semantics as the CLI path's kill().
  const watchdog = setInterval(() => {
    const idle = Date.now() - lastActivity;
    const wall = Date.now() - startedAt;
    if (idle > opts.inactivityMs || wall > opts.wallClockMs) controller.abort();
  }, 1000);

  try {
    const iterator = query({
      prompt,
      options: {
        model: opts.modelId,
        resume: opts.resumeSessionId || undefined,
        permissionMode: "bypassPermissions",       // mirrors --dangerously-skip-permissions
        mcpServers: loadMcpServersForSdk(opts.mcpIntentFlags),
        cwd: opts.workspaceDir || process.env.PROJECT_DIR || process.cwd(),
        abortController: controller,
      },
    });

    for await (const msg of iterator) {
      lastActivity = Date.now();
      for (const ev of mapSdkMessageToEvents(msg)) {
        if (ev.type === "assistant" && ev.toolName) toolCallCount++;
        if (ev.type === "text_delta" && ev.textDelta) text += ev.textDelta;
        if (ev.type === "result") {
          if (ev.resultText) text = ev.resultText || text; // prefer final result text
          isError = !!ev.isError;
          inputTokens = ev.inputTokens || inputTokens;
          outputTokens = ev.outputTokens || outputTokens;
        }
        if (ev.sessionId) sessionId = ev.sessionId;
        onEvent(ev);
      }
    }
  } catch (err: any) {
    if (controller.signal.aborted) {
      isError = true;
      onEvent({ type: "result", sessionId: sessionId ?? undefined, resultText: "", isError: true, errorSubtype: "timeout" });
    } else {
      throw err;
    }
  } finally {
    clearInterval(watchdog);
  }

  return { text, sessionId, inputTokens, outputTokens, isError, toolCallCount };
}
```
**Before writing:** reconcile the `options` field names (`permissionMode`, `mcpServers`, `resume`, `abortController`, `cwd`, `model`) against the SDK `.d.ts` from Task 1, Step 3. If the abort mechanism differs (e.g. an `AbortSignal` passed differently), adapt.

- [ ] **Step 2: Type-check compiles**

Run: `bun build src/engine/sdk-engine.ts --target=bun --outfile=/dev/null` (or `bunx tsc --noEmit` if configured)
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/engine/sdk-engine.ts
git commit -m "feat(engine): add runViaSdk one-turn engine with abort-based watchdog"
```

---

## Task 6: Wire the SDK branch into `callClaude()`

**Files:**
- Modify: `src/claude.ts` (imports near top; insert SDK branch in `callClaude` immediately after `const session = await getSession(agentId, userId);` at ~line 791, before `const args = [CLAUDE_PATH, "-p"];` at ~line 793)

The branch must: respect `skipLock`/lock (already acquired above), reuse the SAME event handler logic the CLI path uses for callbacks, track cost identically, persist the session id (unless `isolated`), and return the text. The CLI block below stays unchanged.

- [ ] **Step 1: Add imports near the other `./` imports at the top of `src/claude.ts`**

```ts
import { selectEngine } from "./engine/router.ts";
import { runViaSdk } from "./engine/sdk-engine.ts";
```

- [ ] **Step 2: Insert the SDK branch**

Immediately after `const session = await getSession(agentId, userId);` (~line 791) and before `const args = [CLAUDE_PATH, "-p"];`, insert:
```ts
    // ── SDK engine path (flag-gated; CLI path below is unchanged) ──
    if (selectEngine({ engine: (options as any)?.engine }) === "sdk") {
      const modelMultiplier = MODEL_TIMEOUT_MULTIPLIERS[modelTier] ?? 1.0;
      const onEvent = (ev: StreamEvent) => {
        // Drive the same user-facing callbacks the CLI path uses.
        if (ev.type === "thinking" || ev.type === "assistant") options?.onTyping?.();
        if (ev.type === "text_delta" && ev.textDelta) options?.onTextDelta?.(ev.textDelta);
      };
      const result = await runViaSdk(
        prompt,
        {
          modelId,
          resumeSessionId: options?.resume ? session.sessionId : null,
          workspaceDir: options?.workspaceDir,
          mcpIntentFlags: options?.mcpIntentFlags,
          inactivityMs: Math.round(INACTIVITY_TIMEOUT_MS * modelMultiplier),
          wallClockMs: Math.round(MAX_WALL_CLOCK_MS * modelMultiplier),
        },
        onEvent,
      );

      // Cost tracking — identical math to the CLI path.
      const costRates = TOKEN_COSTS[modelTier] || TOKEN_COSTS.sonnet;
      const callCostUsd = (result.inputTokens * costRates.input + result.outputTokens * costRates.output) / 1_000_000;
      trackClaudeCall(Date.now() - startTimeSdk, {
        model: modelTier, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: callCostUsd,
      });
      info("claude", `[${agentId}] SDK responded (${modelTier}) | ${result.inputTokens}in/${result.outputTokens}out | $${callCostUsd.toFixed(4)} | ${result.toolCallCount} tools`);

      // Persist session id unless isolated.
      if (result.sessionId && !options?.isolated) {
        session.sessionId = result.sessionId;
        session.lastActivity = new Date().toISOString();
        await saveSessionState(agentId, userId, session);
      }

      const sdkText = stripReasoningTags(result.text);
      // [CODE_TASK:] capture preserved: reuse the existing detector on the final text.
      if (options?.onCodeTaskCaptured) {
        const tasks = parseCodeTaskFromTodoContent(sdkText);
        if (tasks?.length) options.onCodeTaskCaptured(tasks);
      }
      return sdkText;
    }
    // ── End SDK engine path ──
```
Add `const startTimeSdk = Date.now();` immediately before this block (the CLI path defines its own `startTime` later, so use a distinct name to avoid shadowing).

**Verify against the real file before editing:** confirm `parseCodeTaskFromTodoContent` is the correct existing helper for `[CODE_TASK:]` capture (imported at `src/claude.ts:25`) and that its signature matches `(text) => tasks[]`. If the CLI path captures code tasks differently (e.g., from streamed events rather than final text), replicate that exact mechanism instead so behavior is identical.

- [ ] **Step 3: Type-check + existing-path smoke (CLI still default)**

Run: `bun build src/claude.ts --target=bun --outfile=/dev/null`
Expected: no type errors. Because `ATLAS_ENGINE` is unset, `selectEngine()` returns `"cli"` and the branch is skipped — the live behavior is unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/claude.ts
git commit -m "feat(claude): route callClaude through SDK engine when ATLAS_ENGINE=sdk"
```

---

## Task 7: Live smoke test + side-by-side validation

**Files:**
- Create: `scripts/smoke-sdk.ts`

- [ ] **Step 1: Write the smoke script**

Create `scripts/smoke-sdk.ts`:
```ts
import { callClaude } from "../src/claude.ts";

// Force the SDK engine for this run only.
process.env.ATLAS_ENGINE = "sdk";

const prompt = process.argv[2] || "Reply with exactly: PONG";
const text = await callClaude(prompt, { model: "haiku", isolated: true, agentId: "smoke", userId: "smoke" });
console.log("─".repeat(40));
console.log("RESULT:", JSON.stringify(text));
console.log("OK:", text.trim().length > 0);
```

- [ ] **Step 2: Run the SDK path live (uses your existing Claude subscription OAuth, no API key)**

Run: `bun run scripts/smoke-sdk.ts "What is 2+2? Reply with just the number."`
Expected: prints `RESULT: "4"` (or similar), `OK: true`. Confirms query() runs end-to-end through `callClaude` under the SDK engine on Bun.

- [ ] **Step 3: Tool + streaming smoke**

Run: `bun run scripts/smoke-sdk.ts "Use Bash to print the current directory, then tell me what it is."`
Expected: a coherent answer; logs show `... | N tools` with N≥1, proving MCP/tools + cost tracking work via the SDK path.

- [ ] **Step 4: Side-by-side parity check (manual)**

Run the same 3-5 representative prompts twice — once with `ATLAS_ENGINE` unset (CLI) and once with `ATLAS_ENGINE=sdk` — against an **isolated** agent id. Compare: answer quality is equivalent, streaming deltas arrive, token/cost logs populate, and a session id is captured + resumable. Record results in the PR description. Do **not** proceed to cutover if any representative prompt regresses.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-sdk.ts
git commit -m "test(engine): add live SDK smoke script + record parity results"
```

---

## Task 8: Cutover & rollback protocol (documentation + controlled enable)

**Files:**
- Modify: `.env.example` (document the flag) — confirm this file exists; if the project uses a different env doc, update that instead.

- [ ] **Step 1: Document the flag**

Add to `.env.example`:
```
# Inference engine for callClaude(): "cli" (default, spawns the claude binary) or "sdk" (Claude Agent SDK).
# Leave unset/cli for production until SDK parity is validated. Rollback = unset this var + PM2 restart.
ATLAS_ENGINE=cli
```

- [ ] **Step 2: Commit the branch and open a PR (do not merge to master yet)**

```bash
git add .env.example
git commit -m "docs(engine): document ATLAS_ENGINE flag + rollback"
git push -u origin <branch>
gh pr create --title "Atlas SDK engine behind callClaude (flag-gated)" --body "<paste Task 7 parity results>"
```

- [ ] **Step 3: Controlled production enable (only after PR review + parity sign-off)**

After merge: set `ATLAS_ENGINE=sdk` in the live env and restart **via PM2** (per project rule: never raw `bun`): `pm2 restart atlas --update-env`. Watch `logs/out.log` and `logs/error.log` for one representative session. **Rollback if anything regresses:** remove `ATLAS_ENGINE` (or set `=cli`) and `pm2 restart atlas --update-env` — instant revert to the untouched CLI path.

- [ ] **Step 4: Monitor the SDK-credit consumption**

Because the June 15 2026 change meters automated SDK/CLI usage from the monthly Agent SDK credit, watch the first few days of `trackClaudeCall` cost logs against the plan cap. (No code change — this is the operational watch item flagged in the strategy brief.)

---

## Self-Review

**1. Spec coverage:**
- Engine swap behind `callClaude` → Tasks 5, 6. ✓
- Router seam (cli/sdk; future provider hook) → Task 2. ✓
- No caller changes → guaranteed by preserving the `callClaude` signature; verified by Task 6 Step 3 (CLI default unchanged). ✓
- MCP/permissions/model/resume/timeout mapping → Tasks 4, 5. ✓
- Behavior preservation (tags, callbacks, cost, session) → Task 6 reuses callbacks + `parseCodeTaskFromTodoContent`; Task 7 parity check. ✓
- Safe cutover + rollback → Task 8 (flag + PM2). ✓
- Out-of-scope items (persistent pool, tag→tool, RBAC, multi-provider) → explicitly deferred in Scope. ✓

**2. Placeholder scan:** No TBDs. Each code step has full code. The two "before writing, confirm against real types/file" notes (Tasks 1/3/4/5) are verification instructions, not placeholders — the code is written assuming the documented shapes and is adjusted only if reality differs.

**3. Type consistency:** `StreamEvent` reused from `src/claude.ts` (read at lines 474-485) — fields match (`type`, `sessionId`, `toolName`, `toolInput`, `textDelta`, `resultText`, `isError`, `errorSubtype`, `inputTokens`, `outputTokens`). `EngineResult` (Task 1) used consistently by `runViaSdk` (Task 5) and consumed in Task 6. `selectEngine` signature (`{engine?}`) consistent between Task 2 and its call in Task 6. `filterMcpServers`/`loadMcpServersForSdk` (Task 4) consumed in Task 5.

**Known risk to validate during execution:** exact SDK option/message field names (`permissionMode`, `abortController`, `usage`, `subtype:"init"`). Task 1 Step 3 grounds these in the installed `.d.ts` before any dependent code is written. The CLI path is never modified, so worst case the SDK path is disabled by the flag with zero impact on the live system.
