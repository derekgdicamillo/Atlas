# Phase 3 (Final): Compaction + Streaming + Cache Structure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three independent optimizations: earlier conversation compaction, faster streaming delivery, and cache-friendly prompt structure.

**Architecture:** Each change is self-contained. Task 1 (constants) is a one-liner. Task 2 (streaming) modifies only `streaming.ts`. Task 3 (cache structure) modifies only `buildPrompt()` in `relay.ts`. No new files, no new modules, no cross-dependencies.

**Tech Stack:** Bun, existing streaming.ts, relay.ts buildPrompt(), constants.ts.

**Spec:** `docs/superpowers/specs/2026-03-23-final-optimizations-design.md`

---

## File Structure

| File | Role | Status |
|------|------|--------|
| `src/constants.ts` | Lower compaction threshold, add fast streaming interval | **Modify** |
| `src/streaming.ts` | Immediate first edit, adaptive interval | **Modify** |
| `src/relay.ts` (`buildPrompt()`) | Move timestamp to user message, separate image rule | **Modify** |
| `tests/streaming.test.ts` | Unit tests for streaming behavior | **Create** |

---

## Task 1: Update Constants

**Files:**
- Modify: `src/constants.ts:499-505`

- [ ] **Step 1: Lower compaction threshold and add fast streaming constant**

In `src/constants.ts`, find:

```typescript
export const COMPACTION_BUDGET_THRESHOLD = 0.30; // compact if conversation > 30% of prompt budget
export const COMPACTION_MIN_ENTRIES = 10;         // don't compact tiny buffers

// Telegram streaming: progressive response delivery
export const STREAMING_ENABLED = process.env.STREAMING_ENABLED !== "false";
export const STREAMING_EDIT_INTERVAL_MS = 1_200;   // min ms between editMessageText calls
export const STREAMING_CHUNK_THRESHOLD = 3_800;     // start new message before hitting 4096 limit
```

Change to:

```typescript
export const COMPACTION_BUDGET_THRESHOLD = 0.20; // compact if conversation > 20% of prompt budget (was 0.30)
export const COMPACTION_MIN_ENTRIES = 10;         // don't compact tiny buffers

// Telegram streaming: progressive response delivery
export const STREAMING_ENABLED = process.env.STREAMING_ENABLED !== "false";
export const STREAMING_EDIT_INTERVAL_MS = 1_200;   // min ms between editMessageText calls (standard rate)
export const STREAMING_FAST_EDIT_INTERVAL_MS = 800; // faster edits for first 500 chars of a message
export const STREAMING_CHUNK_THRESHOLD = 3_800;     // start new message before hitting 4096 limit
```

- [ ] **Step 2: Verify compilation**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/constants.ts --no-bundle 2>&1 | head -5`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/constants.ts
git commit -m "feat: lower compaction threshold to 20%, add fast streaming interval"
```

---

## Task 2: Streaming Polish — Immediate First Edit + Adaptive Interval

**Files:**
- Modify: `src/streaming.ts`
- Create: `tests/streaming.test.ts`

- [ ] **Step 1: Write unit tests**

Create `tests/streaming.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";

// We can't easily test Telegram API calls, but we can test the streaming
// module exports and basic structure.
describe("streaming module", () => {
  test("exports createStreamingSession", async () => {
    const mod = await import("../src/streaming.ts");
    expect(mod.createStreamingSession).toBeDefined();
    expect(typeof mod.createStreamingSession).toBe("function");
  });

  test("StreamingSession interface has required fields", async () => {
    const mod = await import("../src/streaming.ts");

    // Create a session with a mock API
    let sentMessages: string[] = [];
    let editedMessages: Array<{ id: number; text: string }> = [];
    const session = mod.createStreamingSession({
      api: {
        sendMessage: async (chatId, text) => {
          sentMessages.push(text);
          return { message_id: sentMessages.length };
        },
        editMessageText: async (chatId, msgId, text) => {
          editedMessages.push({ id: msgId, text });
        },
      },
      chatId: 12345,
    });

    expect(session.onDelta).toBeDefined();
    expect(session.finish).toBeDefined();
    expect(session.messageIds).toEqual([]);
    expect(session.hasContent).toBe(false);
  });

  test("onDelta sets hasContent to true", async () => {
    const mod = await import("../src/streaming.ts");
    const session = mod.createStreamingSession({
      api: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => {},
      },
      chatId: 12345,
    });

    session.onDelta("hello");
    expect(session.hasContent).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass with current code**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/streaming.test.ts 2>&1 | tail -5`
Expected: 3 pass.

- [ ] **Step 3: Add the STREAMING_FAST_EDIT_INTERVAL_MS import to streaming.ts**

In `src/streaming.ts` line 11, change:

```typescript
import { STREAMING_EDIT_INTERVAL_MS, STREAMING_CHUNK_THRESHOLD, SENTINEL_TAG_PATTERNS } from "./constants.ts";
```

to:

```typescript
import { STREAMING_EDIT_INTERVAL_MS, STREAMING_FAST_EDIT_INTERVAL_MS, STREAMING_CHUNK_THRESHOLD, SENTINEL_TAG_PATTERNS } from "./constants.ts";
```

- [ ] **Step 4: Add immediate first edit to onDelta**

In `src/streaming.ts`, first add a `messageStarting` guard variable. Find `let hasContent = false;` (line 63) and add after it:

```typescript
  let messageStarting = false; // Guard: prevents duplicate startNewMessage during rapid deltas
```

Then find the `onDelta` handler (line 121). Change it from:

```typescript
    onDelta(text: string): void {
      accumulated += text;
      currentMessageText += text;
      hasContent = true;

      // Multi-message: if current message exceeds threshold and we're not mid-code-block
      if (currentMessageText.length > STREAMING_CHUNK_THRESHOLD && !isInsideCodeBlock(currentMessageText)) {
        // Fire-and-forget: start new message asynchronously
        const textToFinalize = currentMessageText;
        const msgId = currentMessageId;
        startNewMessage().catch(() => {});
        return;
      }

      // Defer edits while inside unclosed code blocks (prevents broken formatting)
      if (isInsideCodeBlock(currentMessageText)) {
        pendingEdit = true;
        return;
      }

      // Schedule a rate-limited edit
      pendingEdit = true;
      scheduleEdit();
    },
```

to:

```typescript
    onDelta(text: string): void {
      accumulated += text;
      currentMessageText += text;
      hasContent = true;

      // First delta: send placeholder + immediate first edit (no waiting for interval)
      // Guard with messageStarting flag to prevent duplicate placeholder messages
      // when multiple deltas arrive before startNewMessage() resolves.
      if (!currentMessageId && !messageStarting) {
        messageStarting = true;
        startNewMessage().then(() => {
          messageStarting = false;
          pendingEdit = true;
          sendEdit(); // immediate first edit — user sees text in <1s
        }).catch(() => { messageStarting = false; });
        return;
      }

      // If message is still being created, just accumulate (edit will fire after init)
      if (messageStarting) {
        pendingEdit = true;
        return;
      }

      // Multi-message: if current message exceeds threshold and we're not mid-code-block
      if (currentMessageText.length > STREAMING_CHUNK_THRESHOLD && !isInsideCodeBlock(currentMessageText)) {
        // Fire-and-forget: start new message asynchronously
        const textToFinalize = currentMessageText;
        const msgId = currentMessageId;
        startNewMessage().catch(() => {});
        return;
      }

      // Defer edits while inside unclosed code blocks (prevents broken formatting)
      if (isInsideCodeBlock(currentMessageText)) {
        pendingEdit = true;
        return;
      }

      // Schedule a rate-limited edit
      pendingEdit = true;
      scheduleEdit();
    },
```

- [ ] **Step 5: Make scheduleEdit() use adaptive interval**

In `src/streaming.ts`, find the `scheduleEdit` function (line 85). Change:

```typescript
  function scheduleEdit(): void {
    if (editTimer) return; // already scheduled

    const elapsed = Date.now() - lastEditAt;
    const delay = Math.max(0, STREAMING_EDIT_INTERVAL_MS - elapsed);

    editTimer = setTimeout(async () => {
```

to:

```typescript
  function scheduleEdit(): void {
    if (editTimer) return; // already scheduled

    // Adaptive interval: faster edits for short messages, standard for long ones
    const interval = currentMessageText.length < 500
      ? STREAMING_FAST_EDIT_INTERVAL_MS
      : STREAMING_EDIT_INTERVAL_MS;
    const elapsed = Date.now() - lastEditAt;
    const delay = Math.max(0, interval - elapsed);

    editTimer = setTimeout(async () => {
```

- [ ] **Step 6: Run tests**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/streaming.test.ts 2>&1 | tail -5`
Expected: 3 pass.

- [ ] **Step 7: Verify compilation**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/streaming.ts --no-bundle 2>&1 | head -5`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/streaming.ts tests/streaming.test.ts
git commit -m "feat: immediate first edit + adaptive streaming interval"
```

---

## Task 3: Cache-Friendly Prompt Structure

**Files:**
- Modify: `src/relay.ts` (`buildPrompt()` function, around line 4296)

- [ ] **Step 1: Separate image observation rule from behavioral_rules**

In `src/relay.ts`, find the behavioral rules block (around line 4299-4310). Change from:

```typescript
  let behavioralRules =
    "CONFIRMATION RULE: When a user says Yes/No/OK/Sure/Go ahead after a multi-option proposal, briefly restate your interpretation in the first sentence before executing.\n" +
    "CAPABILITY GAP RULE: When you identify something Atlas cannot do (e.g. receive Telegram file attachments, write GHL custom fields), immediately spawn a [CODE_TASK:] in the same response to implement the fix, unless the user explicitly says not to.\n" +
    "HIPAA/COMPLIANCE RULE: When explaining why something can't be shared (PHI, HIPAA, etc.), keep it to 2-3 lines max. No CFR subsections or regulatory footnotes in Telegram. Derek and Esther are clinicians, they know the basics. State the constraint and offer the workaround.\n" +
    "AUTO-PERSIST RULE: When you complete a significant action (set up tracking, create/rename/delete ads, configure an integration, change a workflow, update a landing page, or any operational change), emit a [REMEMBER:] tag summarizing what was done. This prevents you from forgetting work you just did as the conversation grows. Keep it factual and brief, e.g. [REMEMBER: GTM tracking (GTM-5SHBBKD) installed on telehealth landing page 2026-03-07. Meta Pixel + GA4 + Google Ads conversion all fire via GTM.]";

  if (imageObservationOnly) {
    behavioralRules +=
      "\nIMAGE OBSERVATION RULE: The user sent a screenshot/image. Analyze and describe what you see. Do NOT spawn [CODE_TASK:] agents, [TASK:] research agents, or emit any action tags. If you think code changes are needed, describe them in plain text and let the user decide whether to proceed. The CAPABILITY GAP RULE does NOT apply to images.";
  }

  parts.push(addSection("behavioral_rules", behavioralRules));

  parts.push(addSection("system", `Current time: ${timeStr}`));

  // User message(s) are P0 - always included, measured early for budget
  const userSection = formatAccumulated(pendingMessages);
  const userSectionText = `\n${userSection}`;
  addSection("user_message", userSectionText);
  // (appended to parts[] at the very end so it's last in the prompt)
```

to:

```typescript
  // Behavioral rules are a static string (deterministic for cache-friendly prefix)
  const behavioralRules =
    "CONFIRMATION RULE: When a user says Yes/No/OK/Sure/Go ahead after a multi-option proposal, briefly restate your interpretation in the first sentence before executing.\n" +
    "CAPABILITY GAP RULE: When you identify something Atlas cannot do (e.g. receive Telegram file attachments, write GHL custom fields), immediately spawn a [CODE_TASK:] in the same response to implement the fix, unless the user explicitly says not to.\n" +
    "HIPAA/COMPLIANCE RULE: When explaining why something can't be shared (PHI, HIPAA, etc.), keep it to 2-3 lines max. No CFR subsections or regulatory footnotes in Telegram. Derek and Esther are clinicians, they know the basics. State the constraint and offer the workaround.\n" +
    "AUTO-PERSIST RULE: When you complete a significant action (set up tracking, create/rename/delete ads, configure an integration, change a workflow, update a landing page, or any operational change), emit a [REMEMBER:] tag summarizing what was done. This prevents you from forgetting work you just did as the conversation grows. Keep it factual and brief, e.g. [REMEMBER: GTM tracking (GTM-5SHBBKD) installed on telehealth landing page 2026-03-07. Meta Pixel + GA4 + Google Ads conversion all fire via GTM.]";

  parts.push(addSection("behavioral_rules", behavioralRules));

  // Image observation rule: separate section so base behavioral_rules stays deterministic
  if (imageObservationOnly) {
    parts.push(addSection("image_rules",
      "IMAGE OBSERVATION RULE: The user sent a screenshot/image. Analyze and describe what you see. Do NOT spawn [CODE_TASK:] agents, [TASK:] research agents, or emit any action tags. If you think code changes are needed, describe them in plain text and let the user decide whether to proceed. The CAPABILITY GAP RULE does NOT apply to images."));
  }

  // User message(s) are P0 - always included, measured early for budget
  // Timestamp moved here (was in a separate "system" section) for cache-friendly prefix
  const userSection = formatAccumulated(pendingMessages);
  const userSectionText = `\nCurrent time: ${timeStr}\n\n${userSection}`;
  addSection("user_message", userSectionText);
  // (appended to parts[] at the very end so it's last in the prompt)
```

Key changes:
1. `let` → `const` for `behavioralRules` (no more mutation)
2. Image rule moved to its own `addSection("image_rules", ...)` call
3. Removed `parts.push(addSection("system", ...))` — timestamp moved into `userSectionText`
4. `userSectionText` now includes `Current time: ${timeStr}` as prefix

- [ ] **Step 2: Verify compilation**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun build src/relay.ts --no-bundle 2>&1 | head -5`
Expected: No errors.

- [ ] **Step 3: Run all tests**

Run: `cd "C:/Users/Derek DiCamillo/atlas" && bun test tests/persistent-process.test.ts tests/persistent-pool.test.ts tests/claude-routing.test.ts tests/tiered-context.test.ts tests/streaming.test.ts 2>&1 | tail -5`
Expected: All pass (46 existing + 3 new = 49).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Derek DiCamillo/atlas"
git add src/relay.ts
git commit -m "feat: cache-friendly prompt structure — move timestamp to user message, separate image rule"
```

---

## Rollout

No feature flags. These are safe, incremental improvements:

1. Deploy (merge + `pm2 restart atlas`)
2. Send a few messages, check logs: `grep "prompt-budget" logs/out.log`
   - Conversation section should be smaller on long conversations (compaction triggers earlier)
   - `behavioral_rules` size should be constant (no image rule bloating it)
   - No `system` section in the log (timestamp is now part of `user_message`)
3. Test streaming: send a message and observe first-word latency — should be noticeably faster
4. Test long conversation: after 10+ turns, check that compaction triggers and conversation section stays under ~4K
