# Phase 3 (Final): Compaction + Streaming + Cache Structure — Design Spec

## Goal

Three independent optimizations that stack on Phases 1 (persistent process) and 2 (tiered context): smarter conversation compaction, faster streaming delivery, and cache-friendly prompt structure.

## A. Smart Conversation Compaction

### Current State

- `compressOldEntries()` in `conversation.ts` fires as fire-and-forget after each assistant response
- `compactIfNeeded()` is called in `handleUserMessage()` at relay.ts ~line 3045, already BEFORE the `buildPrompt()` call at ~line 3071. It runs inline with a 30% budget threshold (`COMPACTION_BUDGET_THRESHOLD = 0.30`)
- Ring buffer: `MAX_ENTRIES = 20`, `RAW_TAIL_COUNT = 6` (last 6 entries stay raw)
- Compression uses Haiku via `summarizeFn` callback
- Compressed summaries persist to disk (`data/conversations/{key}-summary.json`)
- `loadBuffer()` loads persisted summaries on first access

### Changes

1. **Lower compaction threshold.** Change `COMPACTION_BUDGET_THRESHOLD` from `0.30` to `0.20`. This triggers compaction when conversation exceeds 20% of prompt budget (~5K of 25K), keeping conversation context leaner. The current 30% threshold lets conversations grow to ~7.5K before compacting. This is a one-line change in `constants.ts`.

2. **Verify summary persistence.** `loadBuffer()` already loads persisted summaries alongside ring buffer data. Verify this works correctly across PM2 restarts — the summary file should survive and be loaded on next access.

Note: The `compactIfNeeded()` call is already in the correct location (before `buildPrompt()`). No move needed.

### What stays unchanged

- `MAX_ENTRIES = 20` — production-proven
- `RAW_TAIL_COUNT = 6` — keeps last 3 turns verbatim for coherence
- `COMPRESS_THRESHOLD = 10` — only compress when buffer is substantial
- Haiku as the compression model — cheap and fast enough
- Fire-and-forget `compressOldEntries()` after responses — this is the background refresh
- The `compactIfNeeded()` logic and its call site — already correctly positioned
- `compactIfNeeded()` call location in relay.ts — already pre-buildPrompt

## B. Streaming Polish

### Current State

- `STREAMING_EDIT_INTERVAL_MS = 1200` (fixed, from constants.ts)
- `STREAMING_CHUNK_THRESHOLD = 3800` (split before 4096 Telegram limit)
- First delta waits for the full interval before the user sees text
- `scheduleEdit()` uses `setTimeout` with delay calculated from `lastEditAt`

### Changes

1. **Immediate first edit.** In `createStreamingSession()`, when the first `onDelta` arrives and `currentMessageId === null`:
   - Call `await startNewMessage()` to send the placeholder ("...") and populate `currentMessageId`
   - Then immediately call `sendEdit()` (no delay) to replace the placeholder with the first chunk of real text
   - Set `lastEditAt = Date.now()` so subsequent deltas use the normal interval
   - This sequence ensures `currentMessageId` is populated before any edit is attempted. The `onDelta` handler should detect `currentMessageId === null` and trigger this initialization path synchronously (fire-and-forget the startNewMessage promise, then fall through to the normal scheduleEdit path once the message ID is available).

2. **Adaptive edit interval.** After the first edit:
   - First 500 chars of `currentMessageText`: use `STREAMING_FAST_EDIT_INTERVAL_MS` (800ms) — short messages feel snappier
   - After 500 chars: use standard `STREAMING_EDIT_INTERVAL_MS` (1200ms) — reduces Telegram API pressure on long responses
   - `scheduleEdit()` reads `currentMessageText.length` from closure to pick the interval
   - Note: when `startNewMessage()` splits to a new Telegram message, `currentMessageText` resets to `""`. This means the fast interval re-triggers for the start of each new message, which is the desired behavior (each new message gets a fast start)
   - Implementation: `scheduleEdit()` checks `currentMessageText.length` and uses the appropriate interval

3. **New constant.** Add `STREAMING_FAST_EDIT_INTERVAL_MS = 800` to constants.ts. The existing `STREAMING_EDIT_INTERVAL_MS = 1200` stays as the standard rate.

### What stays unchanged

- Multi-message splitting logic and `STREAMING_CHUNK_THRESHOLD`
- Code block detection (`isInsideCodeBlock`)
- Sentinel stripping (`stripSentinelsFromStream`)
- The `StreamingSession` interface (no API changes)

## C. Prompt Cache Structuring

### Current State

- `buildPrompt()` injects `Current time: ${timeStr}` as the `system` section early in the prompt
- This timestamp changes every minute, busting the cache prefix on every turn
- `behavioral_rules` has a conditional `IMAGE OBSERVATION RULE` appended based on whether the user sent a photo
- These two together mean the first ~2K chars of the prompt are never fully cacheable

### Changes

1. **Move timestamp to user message section.** The `system` section currently contains only the timestamp. Remove it and append the timestamp to the user message section instead (which is already last in the prompt and changes every turn). This makes the prompt prefix (identity + behavioral rules) fully static per session.

2. **Separate image observation rule.** Move the conditional `IMAGE OBSERVATION RULE` from the `behavioral_rules` string to its own section (`image_rules`), injected only when `imageObservationOnly` is true. Insert the `image_rules` section immediately AFTER the `behavioral_rules` push in the `parts[]` array (so it appears right after the base rules in the prompt). This makes the base `behavioral_rules` string fully deterministic — same bytes every turn. The image rule still appears in the same logical position in the prompt, just as a separate `parts[]` entry.

3. **Result: deterministic prefix.** After these changes, the prompt prefix is:
   - `agent_identity` (static per agent)
   - `behavioral_rules` (static always — same string every turn)
   - Then Tier 1/2 sections (vary by turn)
   - Then `user_message` with timestamp (varies every turn)

   The persistent process's `--resume` already gives Claude CLI conversation context. The deterministic prefix maximizes the cacheable window that Claude CLI can reuse.

### What stays unchanged

- The content of behavioral rules (confirmation, capability gap, HIPAA, auto-persist)
- The order of sections in the prompt (identity first, user message last)
- `MAX_PROMPT_CHARS = 25000`

## Files Changed

| File | Change | Part |
|------|--------|------|
| `src/constants.ts` | Lower `COMPACTION_BUDGET_THRESHOLD` to 0.20, add `STREAMING_FAST_EDIT_INTERVAL_MS` | A, B |
| `src/relay.ts` (buildPrompt) | Move timestamp to user message section, separate image observation rule into own section | C |
| `src/streaming.ts` | Immediate first edit on first delta, adaptive edit interval | B |

## Expected Impact

| Metric | Current | After |
|--------|---------|-------|
| Conversation section in prompt (long convos) | 5-8K | 2-4K (compaction triggers earlier) |
| First-word latency (streaming) | ~1.5-2s | <1s (immediate first edit) |
| Cache prefix stability | Changes every minute (timestamp) | Static per session (deterministic) |

## Rollout

No feature flag needed — these are all safe, incremental improvements:
- A (compaction): Only changes when compaction triggers, not what it does
- B (streaming): Faster edits are strictly better UX, no risk
- C (cache structure): Same prompt content, different ordering. Zero behavioral change.

Deploy, restart, observe.
