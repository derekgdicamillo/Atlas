# Phase 2: Tiered Context Loading — Design Spec

## Goal

Reduce per-turn prompt size from ~23K to ~3-5K for subsequent turns by leveraging the persistent process's conversation memory. Heavy context (memory, observations, search) is injected only on the first turn and on topic changes. Subsequent turns in the same conversation thread get only the minimal context needed.

## Background

Phase 1 introduced persistent Claude CLI subprocesses that maintain conversation context across turns. This means Claude already "knows" the facts, observations, and search results from earlier in the conversation — we don't need to re-inject them every turn.

### Current prompt sizes (baseline from 16 samples)

| Section | Size | Frequency | Changes when? |
|---------|------|-----------|---------------|
| `memory` | 6,324 chars | 100% of prompts | On [REMEMBER:]/[GOAL:] tags (cached 5 min) |
| `observations` | 5,935 chars | ~88% of prompts | Nightly evolution pipeline |
| `search` | 4,338-5,198 chars | Most non-casual | Per-message (semantic search) |
| `behavioral_rules` | 1,193 chars | 100% of prompts | Static (hardcoded) |
| `conversation` | 406-5,298 chars | Variable | Per-turn |
| `mode` | 3,986-7,925 chars | When mode active | Per-mode activation |

Casual "hey" prompts: 10-15K. Business prompts: 22-27K.

## Design

### Turn Context

`buildPrompt()` receives a new `turnContext` parameter:

```typescript
interface TurnContext {
  /** True on first message after process spawn/restart */
  isFirstTurn: boolean;
  /** Intent flags from the previous turn (null on first turn) */
  previousIntentFlags: Record<string, boolean> | null;
}
```

### Tier Definitions

**Tier 0 — Every turn (~3K):**
Always injected regardless of turn position or topic.

- `agent_identity` — systemPrompt from agent config
- `behavioral_rules` — confirmation rule, capability gap rule, HIPAA rule, auto-persist rule, image observation rule
- `system` — current timestamp
- `user_message` — the user's message(s) from the accumulator
- `conversation` — ring buffer context (trimmed to 8K max)
- `tasks_active` — supervised task status (if any active)
- `capabilities_hint` — brief note about available data (casual intent only)
- `automation_pause` — automation control tags (low cost, ~276 chars)

**Tier 1 — First turn + topic change (~12-17K):**
Injected on:
1. `isFirstTurn === true` (process just spawned or restarted)
2. Topic change detected (intent flags differ from previous turn)

Sections:
- `memory` — facts and goals from Supabase (6.3K, cached 5 min)
- `observations` — compressed context from past interactions (5.9K)
- `search` — semantic search results matching current message (4-5K)
- `feedback` — lessons learned from past corrections (~2K)
- `episodes` — relevant past multi-turn interactions (~2K)
- `proactive` — proactive insights (~1.5K)

**Tier 2 — Intent-gated (unchanged):**
Injected based on intent classification, same as today. No changes needed.

- `dashboard` — business metrics (intent: financial/pipeline/marketing)
- `ghl` — GHL pipeline data (intent: pipeline/financial)
- `ghl_tags` — GHL action syntax (intent: pipeline/todos/marketing)
- `financials` — financial context (intent: financial)
- `gbp` — Google Business Profile (intent: reputation/marketing)
- `ga4` — website analytics (intent: analytics/marketing)
- `m365` — Microsoft 365 (intent: m365)
- `website` — pvmedispa.com context (intent: marketing/coding)
- `mode` — active mode prompt (intent: marketing/social/skool)
- `graph` / `entities` — entity graph (ambient, lowest priority)
- Tag syntax sections (website, browser, gemini, ingest, delegation)

### Topic Change Detection

Compare current intent flags to `previousIntentFlags` from the previous turn:

```typescript
function isTopicChange(
  current: Record<string, boolean>,
  previous: Record<string, boolean> | null,
): boolean {
  if (!previous) return true; // first turn
  // Check if any intent flag changed (new flag appeared or old one disappeared)
  const currentKeys = Object.keys(current).filter(k => current[k]);
  const previousKeys = Object.keys(previous).filter(k => previous[k]);
  if (currentKeys.length !== previousKeys.length) return true;
  return currentKeys.some(k => !previous[k]);
}
```

This is a simple set comparison. If the user was talking about `pipeline` and now asks about `marketing`, that's a topic change — inject fresh search results. If they're still on `pipeline`, skip the search.

### Restart and Session Reset Recovery

When the persistent process restarts (crash recovery, idle timeout, PM2 restart), the next turn automatically gets `isFirstTurn: true` because `PersistentProcess.turnCount` resets to 0. This means full context injection — one "slow" turn, then back to fast subsequent turns.

**Session reset (`/session reset`):** When the user explicitly resets their session, `relay.ts` must also reset the persistent process's `turnCount` to 0 AND clear the stored `previousIntentFlags`. This ensures the next message gets full context injection, matching the expectation that a session reset means a clean slate. The `PersistentProcess` exposes a `resetTurnCount()` method for this (does NOT restart the process — just resets the counter).

### State Management

**Per-session intent tracking** (`relay.ts`):
- After each turn completes, store the intent flags for that turn
- On next turn, pass them as `previousIntentFlags`
- Storage: in-memory Map keyed by session key (same as existing session state)
- Cleared on session reset / process restart / explicit `clearBuffer()` call

**Turn count on PersistentProcess** (`persistent-process.ts`):
- Increment `turnCount` in `sendTurn()` after successful write (not before — avoids counting failed turns)
- Reset to 0 on `restart()`, `shutdown()`, and new `resetTurnCount()` method
- Expose `isFirstTurn(): boolean` — returns `turnCount <= 1`

### Uncategorized Sections

Sections not in Tier 0/1/2 that exist in `buildPrompt()` today:
- `tox_tray` — Tox Tray business context. Currently always injected when context exists. **Tier 0** (low cost, ~1.5K, always relevant when present).
- `todos` — active todos. Gated on `hasTodos` feature flag. **Tier 0** (low cost when present).
- `google` — Google context. Intent-gated on `intent.google`. **Tier 2** (already gated).
- `graph` / `entities` — entity graph. Budget-gated (not intent-gated). **Tier 0** (ambient, lowest priority, budget-protected).
- `ingest_routing` — document analysis routing. Intent-gated on `intent.ingest`. **Tier 2**.
- `task_delegation` — delegation directive. Intent-gated on `intent.taskDelegation`. **Tier 2**.
- `capabilities_hint` — available data note. Intent-gated on `intent.casual`. **Tier 2** (conditional).

### Behavior Change Notice

Moving these sections from always-injected to Tier 1 (first turn + topic change only) is a **deliberate behavior change**:
- `observations` — currently injected ~88% of prompts. After: first turn + topic change only.
- `feedback` — lessons learned. After: first turn + topic change only.
- `episodes` — past interactions. After: first turn + topic change only.
- `proactive` — proactive insights. After: first turn + topic change only.

This is acceptable because the persistent process maintains conversation context — Claude already "knows" this information from earlier turns. On topic change, fresh context is re-injected.

## Files Changed

| File | Change |
|------|--------|
| `src/relay.ts` (`buildPrompt()` ~line 4240) | Add `turnContext` parameter. Gate Tier 1 sections on `isFirstTurn \|\| isTopicChange()`. |
| `src/relay.ts` (message handler `handleUserMessage()` ~line 2900) | Import `processPool`. Read `isFirstTurn()` from process. Track previous intent flags per session in a `Map<string, Record<string, boolean>>`. Build `turnContext` and pass to `buildPrompt()`. Clear intent map on session reset. |
| `src/relay.ts` (session reset handler) | Call `processPool.get(agentId).resetTurnCount()` on `/session reset`. |
| `src/persistent-process.ts` | Add `turnCount` field, increment after successful write in `sendTurn()`, reset on restart/shutdown. Add `isFirstTurn()` and `resetTurnCount()` methods. |
| `src/constants.ts` | Add `TIERED_CONTEXT_ENABLED` env var flag (default `false`). Required for safe rollout. |

**Note:** `src/claude.ts` does NOT need changes. The `isFirstTurn` information flows through `relay.ts` which builds the prompt before calling `callClaude()`. `callClaude()` receives the already-built prompt string.

## Expected Impact

| Scenario | Current | After | Reduction |
|----------|---------|-------|-----------|
| Casual first turn | 15K | 15K | 0% |
| Casual subsequent turn | 15K | ~3-5K* | **67-80%** |
| Business first turn | 25K | 25K | 0% |
| Business subsequent turn | 25K | ~5-8K | **68-80%** |
| After restart/session reset | N/A | 15-25K (one turn) | N/A |
| Topic change mid-convo | N/A | ~15-20K (one turn) | N/A |

*Subsequent turn floor depends on ring buffer size (grows as conversation progresses). First follow-up is ~3K; by turn 5+ it's ~5K with accumulated conversation history.

Token cost reduction: ~70% on subsequent turns in multi-turn sessions (3+ messages). Short sessions (1-2 messages) see minimal savings since most turns are first turns. Based on typical Atlas usage patterns (avg 4-6 turns per session), net savings across all messages are estimated at ~50-60%.

## Rollout

1. Add `TIERED_CONTEXT_ENABLED=false` env var flag in constants.ts (runtime, not compile-time — allows hot-toggle via .env without restart)
2. Deploy with flag off — zero behavior change. `turnCount` and intent tracking run harmlessly in background.
3. Flip flag on (`TIERED_CONTEXT_ENABLED=true` in .env, restart), send test messages, verify with `/status` that prompt sizes drop
4. Monitor for 24h: check that topic changes correctly re-inject context, and that Claude doesn't "forget" things it should know from earlier turns
5. If issues: flip flag off instantly (restart required since env vars are read at startup)

## What's NOT included

- **Prompt cache breakpoints** (Phase 5) — requires Claude CLI support for explicit cache control
- **Conversation summarization** (Phase 4) — independent optimization, compresses the ring buffer
- **Streaming improvements** (Phase 3) — already mostly done via Phase 1's persistent process
- Moving context to `.claude/rules/` files — rejected in favor of this approach
