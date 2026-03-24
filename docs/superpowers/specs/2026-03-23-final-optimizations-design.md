# Phase 3 (Final): Compaction + Streaming + Cache Structure — Design Spec

## Goal

Three independent optimizations that stack on Phases 1 (persistent process) and 2 (tiered context): smarter conversation compaction, faster streaming delivery, and cache-friendly prompt structure.

## A. Smart Conversation Compaction

### Current State

- `compressOldEntries()` in `conversation.ts` fires as fire-and-forget after each assistant response
- `compactIfNeeded()` runs inline during prompt building at 30% budget threshold (`COMPACTION_BUDGET_THRESHOLD = 0.30`)
- Ring buffer: `MAX_ENTRIES = 20`, `RAW_TAIL_COUNT = 6` (last 6 entries stay raw)
- Compression uses Haiku via `summarizeFn` callback
- Compressed summaries persist to disk (`data/conversations/{key}-summary.json`)
- `loadBuffer()` loads persisted summaries on first access

### Changes

1. **Proactive compaction before prompt building.** Move the `compactIfNeeded()` call from inside `buildPrompt()` (where it adds latency to the response path) to before the `buildPrompt()` call in `handleUserMessage()`. The prompt builder always receives a pre-compacted conversation context.

2. **Lower compaction threshold.** Change `COMPACTION_BUDGET_THRESHOLD` from `0.30` to `0.20`. This triggers compaction when conversation exceeds 20% of prompt budget (~5K of 25K), keeping conversation context leaner. The current 30% threshold lets conversations grow to ~7.5K before compacting.

3. **Verify summary persistence.** `loadBuffer()` already loads persisted summaries alongside ring buffer data. Verify this works correctly across PM2 restarts — the summary file should survive and be loaded on next access.

### What stays unchanged

- `MAX_ENTRIES = 20` — production-proven
- `RAW_TAIL_COUNT = 6` — keeps last 3 turns verbatim for coherence
- `COMPRESS_THRESHOLD = 10` — only compress when buffer is substantial
- Haiku as the compression model — cheap and fast enough
- Fire-and-forget `compressOldEntries()` after responses — this is the background refresh
- The `compactIfNeeded()` logic itself — just moving when it's called

## B. Streaming Polish

### Current State

- `STREAMING_EDIT_INTERVAL_MS = 1200` (fixed, from constants.ts)
- `STREAMING_CHUNK_THRESHOLD = 3800` (split before 4096 Telegram limit)
- First delta waits for the full interval before the user sees text
- `scheduleEdit()` uses `setTimeout` with delay calculated from `lastEditAt`

### Changes

1. **Immediate first edit.** In `createStreamingSession()`, when the first `onDelta` arrives and `currentMessageId` is null, send the placeholder message immediately and schedule the first edit with 0 delay (bypass the interval). This makes first-word latency feel instant instead of waiting 1.2s.

2. **Adaptive edit interval.** After the first edit:
   - First 500 chars of `currentMessageText`: use 800ms interval (short messages feel snappier)
   - After 500 chars: use standard 1200ms interval (reduces Telegram API pressure on long responses)
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

2. **Separate image observation rule.** Move the conditional `IMAGE OBSERVATION RULE` from `behavioral_rules` to its own section (`image_rules`), injected only when `imageObservationOnly` is true. This makes the base `behavioral_rules` string fully deterministic — same bytes every turn.

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
| `src/relay.ts` (handleUserMessage) | Move `compactIfNeeded()` call to before `buildPrompt()` | A |
| `src/relay.ts` (buildPrompt) | Move timestamp to user message, separate image observation rule | C |
| `src/streaming.ts` | Immediate first edit, adaptive interval | B |

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
