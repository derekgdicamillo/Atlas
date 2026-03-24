# Phase 2: Tiered Context Loading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce per-turn prompt size from ~23K to ~3-5K for subsequent turns by gating heavy context injection on first turn and topic changes.

**Architecture:** `buildPrompt()` gains a `turnContext` parameter that tracks whether this is the first turn on the persistent process and whether the conversation topic changed since the last turn. Tier 1 sections (memory, observations, search, feedback, episodes, proactive) are only injected on first turn or topic change. Tier 0 (identity, rules, timestamp, conversation, user message) injects every turn. Tier 2 (intent-gated business context) stays unchanged.

**Tech Stack:** Bun, existing `buildPrompt()` in relay.ts, `PersistentProcess` from Phase 1.

**Spec:** `docs/superpowers/specs/2026-03-23-tiered-context-loading-design.md`

---

## File Structure

| File | Role | Status |
|------|------|--------|
| `src/persistent-process.ts` | Add `turnCount`, `isFirstTurn()`, `resetTurnCount()` | **Modify** |
| `src/relay.ts` (`buildPrompt()`) | Add `turnContext` param, gate Tier 1 sections | **Modify** |
| `src/relay.ts` (message handler) | Track intent flags, build `turnContext`, pass to `buildPrompt()` | **Modify** |
| `src/relay.ts` (session reset) | Reset `turnCount` + clear intent tracking on `/session reset` | **Modify** |
| `src/constants.ts` | Add `TIERED_CONTEXT_ENABLED` feature flag | **Modify** |
| `tests/tiered-context.test.ts` | Tests for topic change detection and tier gating | **Create** |

---

## Task 1: Add `turnCount` and `isFirstTurn()` to PersistentProcess

**Files:**
- Modify: `src/persistent-process.ts`

- [ ] **Step 1: Add `turnCount` field and methods**

In `src/persistent-process.ts`, add a private field after the existing `private turnText = "";` (around line 114):

```typescript
  private turnCount = 0;
```

Add public methods after `getSessionId()`:

```typescript
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
```

- [ ] **Step 2: Increment `turnCount` after successful message write**

In `sendTurn()`, find where the message payload is written to stdin. Search for `this.proc!.stdin.write(payload)` inside the `try` block of the `Promise` constructor. It's the line that actually sends the NDJSON message. After that write succeeds, add:

```typescript
      this.turnCount++;
```

Important: locate the EXACT `stdin.write(payload)` call in context — do not add `"\n"` (the newline is already baked into `payload` via `JSON.stringify(message) + "\n"` above). This goes right after the write call, NOT in `resolveTurn`.

**Note on persistent disabled:** When `PERSISTENT_PROCESS_ENABLED=false`, `sendTurn()` is never called, so `turnCount` never increments. This means `isFirstTurn()` always returns `true`, which causes Tier 1 to always inject — the correct fallback behavior (same as pre-Phase 2).

- [ ] **Step 3: Reset `turnCount` in existing `restart()` and `shutdown()` methods**

In `restart()`, add `this.turnCount = 0;` before the spawn call.
In `shutdown()`, add `this.turnCount = 0;` at the start.

- [ ] **Step 4: Verify compilation**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/persistent-process.ts --no-bundle 2>&1 | head -5`
Expected: No errors.

- [ ] **Step 5: Update existing tests**

In `tests/persistent-process.test.ts`, add these tests inside the describe block:

```typescript
  describe("turnCount / isFirstTurn / resetTurnCount", () => {
    test("isFirstTurn returns true initially", () => {
      const proc = create();
      expect(proc.isFirstTurn()).toBe(true);
      expect(proc.getTurnCount()).toBe(0);
    });

    test("resetTurnCount resets to zero", () => {
      const proc = create();
      proc.resetTurnCount();
      expect(proc.getTurnCount()).toBe(0);
      expect(proc.isFirstTurn()).toBe(true);
    });
  });
```

- [ ] **Step 6: Run tests**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/persistent-process.test.ts 2>&1 | tail -5`
Expected: All pass (existing 14 + 2 new = 16).

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/persistent-process.ts tests/persistent-process.test.ts
git commit -m "feat: add turnCount, isFirstTurn, resetTurnCount to PersistentProcess"
```

---

## Task 2: Add Feature Flag and Topic Change Detection

**Files:**
- Modify: `src/constants.ts`
- Create: `tests/tiered-context.test.ts`

- [ ] **Step 1: Add feature flag to constants.ts**

After the existing `PERSISTENT_PROCESS_ENABLED` constant in `src/constants.ts`:

```typescript
/** Feature flag: enable tiered context loading (Phase 2).
 *  When true, heavy context (memory, observations, search) is only injected on first turn
 *  and topic changes. Set TIERED_CONTEXT_ENABLED=true in .env to enable. */
export const TIERED_CONTEXT_ENABLED = process.env.TIERED_CONTEXT_ENABLED === "true";
```

Note: default is `false` (opt-in), unlike `PERSISTENT_PROCESS_ENABLED` which defaults to `true`.

- [ ] **Step 2: Create test file with topic change detection tests**

Create `tests/tiered-context.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { isTopicChange, type TurnContext } from "../src/tiered-context.ts";

describe("isTopicChange", () => {
  test("returns true when previous is null (first turn)", () => {
    expect(isTopicChange({ financial: true }, null)).toBe(true);
  });

  test("returns false when same intent flags", () => {
    const flags = { financial: true, pipeline: true };
    expect(isTopicChange(flags, flags)).toBe(false);
  });

  test("returns true when new intent flag appears", () => {
    expect(isTopicChange(
      { financial: true, marketing: true },
      { financial: true, marketing: false },
    )).toBe(true);
  });

  test("returns true when intent flag disappears", () => {
    expect(isTopicChange(
      { financial: true, marketing: false },
      { financial: true, marketing: true },
    )).toBe(true);
  });

  test("returns false when both empty (casual to casual)", () => {
    expect(isTopicChange({}, {})).toBe(false);
    expect(isTopicChange(
      { casual: true },
      { casual: true },
    )).toBe(false);
  });

  test("returns true when switching from casual to intent", () => {
    expect(isTopicChange(
      { financial: true },
      { casual: true },
    )).toBe(true);
  });

  test("returns true when intent substitution at same count", () => {
    expect(isTopicChange(
      { pipeline: true, marketing: false },
      { pipeline: false, marketing: true },
    )).toBe(true);
  });
});

describe("TurnContext", () => {
  test("type exports correctly", () => {
    const ctx: TurnContext = {
      isFirstTurn: true,
      previousIntentFlags: null,
      tieredContextEnabled: true,
    };
    expect(ctx.isFirstTurn).toBe(true);
  });
});
```

- [ ] **Step 3: Create src/tiered-context.ts with the detection logic**

```typescript
// src/tiered-context.ts
/**
 * Atlas — Tiered Context Loading (Phase 2)
 *
 * Determines when to inject heavy context (Tier 1) vs minimal context (Tier 0)
 * based on turn position and topic changes.
 */

export interface TurnContext {
  /** True on first turn after process spawn/restart/session reset */
  isFirstTurn: boolean;
  /** Intent flags from the previous turn (null on first turn) */
  previousIntentFlags: Record<string, boolean> | null;
  /** Whether tiered context loading is enabled */
  tieredContextEnabled: boolean;
}

/**
 * Detect if the conversation topic changed between turns.
 * Compares active intent flags (true values only) as sets.
 *
 * Returns true if:
 * - previous is null (first turn)
 * - any currently-active flag was not active before
 * - any previously-active flag is no longer active
 */
export function isTopicChange(
  current: Record<string, boolean>,
  previous: Record<string, boolean> | null,
): boolean {
  if (!previous) return true;
  const currentActive = Object.keys(current).filter(k => current[k]);
  const previousActive = Object.keys(previous).filter(k => previous[k]);
  if (currentActive.length !== previousActive.length) return true;
  // Check both directions: any new flag, or any removed flag
  if (currentActive.some(k => !previous[k])) return true;
  if (previousActive.some(k => !current[k])) return true;
  return false;
}

/**
 * Determine whether Tier 1 context should be injected this turn.
 * Returns true if:
 * - Tiered context is disabled (always inject, legacy behavior)
 * - It's the first turn on this process
 * - The topic changed since the last turn
 */
export function shouldInjectTier1(
  turnContext: TurnContext,
  currentIntent: Record<string, boolean>,
): boolean {
  if (!turnContext.tieredContextEnabled) return true; // flag off = always inject
  if (turnContext.isFirstTurn) return true;
  return isTopicChange(currentIntent, turnContext.previousIntentFlags);
}
```

- [ ] **Step 4: Run tests**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/tiered-context.test.ts 2>&1 | tail -10`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/constants.ts src/tiered-context.ts tests/tiered-context.test.ts
git commit -m "feat: add topic change detection and TurnContext for tiered loading"
```

---

## Task 3: Gate Tier 1 Sections in buildPrompt()

**Files:**
- Modify: `src/relay.ts` (`buildPrompt()` function, around line 4193)

This is the core change. `buildPrompt()` gets a new `turnContext` parameter. When tiered loading is enabled and it's NOT the first turn or a topic change, Tier 1 sections are skipped.

- [ ] **Step 1: Add import at top of relay.ts**

Add after the existing imports:

```typescript
import { type TurnContext, shouldInjectTier1 } from "./tiered-context.ts";
```

- [ ] **Step 2: Add `turnContext` parameter to buildPrompt()**

Change the `buildPrompt` function signature (around line 4193) from:

```typescript
function buildPrompt(
  pendingMessages: PendingMessage[],
  agent: AgentRuntime | null,
  intent: MessageIntent,
  contexts: {
```

to:

```typescript
function buildPrompt(
  pendingMessages: PendingMessage[],
  agent: AgentRuntime | null,
  intent: MessageIntent,
  contexts: {
    ...existing fields...
  },
  turnContext?: TurnContext,
): string {
```

- [ ] **Step 3: Compute the Tier 1 gate early in buildPrompt()**

After the `budgetRemaining()` function definition (around line 4244), add:

```typescript
  // Tiered context loading: determine if Tier 1 (heavy context) should be injected
  const injectTier1 = !turnContext || shouldInjectTier1(turnContext, intent as Record<string, boolean>);
  if (turnContext?.tieredContextEnabled && !injectTier1) {
    info("prompt-budget", `Tier 1 SKIPPED (turn ${turnContext.isFirstTurn ? "first" : "subsequent"}, no topic change)`);
  }
```

- [ ] **Step 4: Gate the Tier 1 sections**

Wrap each Tier 1 section in an `injectTier1` check. These are the sections to gate:

**observations** (~line 4290):
```typescript
  // ── P1: Observation blocks (stable, cache-friendly prefix) ──
  if (injectTier1 && contexts.observationsContext && budgetRemaining() > 3000) {
```

**memory** (~line 4309):
```typescript
  if (injectTier1 && hasMemory && contexts.memoryContext && budgetRemaining() > 2000) {
```

**search** (~line 4314):
```typescript
  if (injectTier1 && hasMemory && contexts.relevantContext && budgetRemaining() > 2000) {
```

**feedback** (~line 4319):
```typescript
  if (injectTier1 && contexts.feedbackContext && budgetRemaining() > 1500) {
```

**episodes** (~line 4326):
```typescript
  if (injectTier1 && contexts.episodesContext && budgetRemaining() > 1500) {
```

**proactive** (~line 4344):
```typescript
  if (injectTier1 && contexts.proactiveContext && budgetRemaining() > 1000) {
```

For each section, prepend `injectTier1 && ` to the existing `if` condition. Do NOT change any other part of the condition.

- [ ] **Step 5: Verify compilation**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/relay.ts --no-bundle 2>&1 | head -5`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/relay.ts
git commit -m "feat: gate Tier 1 context sections in buildPrompt on turnContext"
```

---

## Task 4: Wire turnContext Into the Message Handler

**Files:**
- Modify: `src/relay.ts` (message handler `handleUserMessage()`, around line 2750)

This connects the persistent process's turn state to `buildPrompt()`.

- [ ] **Step 1: Add intent tracking Map**

Near the top of relay.ts, after the existing `contextCache` Map (search for `const contextCache`), add:

```typescript
/** Track previous intent flags per session for topic change detection */
const previousIntentMap = new Map<string, Record<string, boolean>>();
```

- [ ] **Step 2: Import constants and processPool**

`processPool` is already imported (from Phase 1). Add `TIERED_CONTEXT_ENABLED` to the constants import:

Find the existing import from `"./constants.ts"` and add `TIERED_CONTEXT_ENABLED`.

- [ ] **Step 3: Build turnContext before the buildPrompt() call**

In `handleUserMessage()`, right before the `buildPrompt()` call (around line 3051), add:

```typescript
    // 7d. Build turn context for tiered loading (Phase 2)
    const persistentProc = processPool.get(agentId);
    const turnContext: TurnContext = {
      isFirstTurn: persistentProc.isFirstTurn(),
      previousIntentFlags: previousIntentMap.get(key) || null,
      tieredContextEnabled: TIERED_CONTEXT_ENABLED,
    };
```

- [ ] **Step 4: Pass turnContext to buildPrompt()**

Change the `buildPrompt()` call (around line 3051) to pass `turnContext` as the 5th argument:

From:
```typescript
    const enrichedPrompt = buildPrompt(
      pending,
      agent,
      intent,
      {
        ...contexts...
      }
    );
```

To:
```typescript
    const enrichedPrompt = buildPrompt(
      pending,
      agent,
      intent,
      {
        ...contexts...
      },
      turnContext,
    );
```

- [ ] **Step 5: Store intent flags after successful response**

After the `callClaude()` call completes and the response is processed (around line 3140, after `streaming.finish()`), add:

```typescript
    // Store intent flags for next turn's topic change detection
    previousIntentMap.set(key, intent as Record<string, boolean>);
```

- [ ] **Step 6: Verify compilation**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/relay.ts --no-bundle 2>&1 | head -5`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/relay.ts
git commit -m "feat: wire turnContext into message handler for tiered context loading"
```

---

## Task 5: Handle Session Reset

**Files:**
- Modify: `src/relay.ts` (session reset handler, around line 1228)

- [ ] **Step 1: Reset turn count and intent tracking on /session reset**

In the `/session` command handler, after the existing `clearMode(sKey);` line (around line 1240), add:

```typescript
        // Reset persistent process turn count so next message gets full context
        try { processPool.get(agentId).resetTurnCount(); } catch {}
        // Clear intent tracking for this session
        previousIntentMap.delete(sKey);
```

- [ ] **Step 2: Also reset on idle session auto-reset**

Find where `checkIdleReset()` is called in `handleUserMessage()` (search for `checkIdleReset`). After a successful idle reset, add the same cleanup:

```typescript
    if (await checkIdleReset(agentId, userId)) {
      // Session was auto-reset — clear tiered context state
      try { processPool.get(agentId).resetTurnCount(); } catch {}
      previousIntentMap.delete(key);
    }
```

- [ ] **Step 3: Verify compilation**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/relay.ts --no-bundle 2>&1 | head -5`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/relay.ts
git commit -m "feat: reset turnCount and intent tracking on session reset"
```

---

## Task 6: Add Tier Info to Prompt Budget Logging

**Files:**
- Modify: `src/relay.ts` (`buildPrompt()` logging section)

- [ ] **Step 1: Add tier info to the logging line**

In `buildPrompt()`, find the logging section at the end (around line 4496, search for `info("prompt-budget"`). Change it to include tier info:

From:
```typescript
  info("prompt-budget",
    `total=${totalChars} intent=[${intentFlags}] sections: ${topSections}`
  );
```

To:
```typescript
  const tierLabel = turnContext?.tieredContextEnabled
    ? (injectTier1 ? "tier1=INJECTED" : "tier1=SKIPPED")
    : "tier1=ALWAYS";
  info("prompt-budget",
    `total=${totalChars} ${tierLabel} intent=[${intentFlags}] sections: ${topSections}`
  );
```

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/relay.ts
git commit -m "feat: add tier injection status to prompt budget logging"
```

---

## Rollout Strategy

1. **Deploy with flag off** — `TIERED_CONTEXT_ENABLED` defaults to `false`. All code is present but inactive.

2. **Enable** — Add `TIERED_CONTEXT_ENABLED=true` to `.env`, restart Atlas.

3. **Verify** — Send test messages, check logs for `tier1=SKIPPED` on subsequent turns:
   ```
   grep "prompt-budget" logs/out.log | tail -10
   ```
   Expected: First message shows `tier1=INJECTED`, follow-ups show `tier1=SKIPPED`.

4. **Test topic change** — Send a casual message, then ask about financials. The financial message should show `tier1=INJECTED` (topic changed).

5. **Test session reset** — Send `/session reset`, then a message. Should show `tier1=INJECTED`.

6. **Disable instantly** — Set `TIERED_CONTEXT_ENABLED=false` in `.env`, restart. Back to full injection every turn.
