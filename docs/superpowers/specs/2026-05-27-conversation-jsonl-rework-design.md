# Conversation Buffer JSONL Rework — Design Spec

**Date:** 2026-05-27
**Status:** Draft — pending Derek's review
**Owner:** Atlas core / conversation persistence

## Goal

Stop losing work that Atlas already did in the same session. Rework the conversation buffer from a rewritten JSON array of length-capped strings into an append-only JSONL log of Anthropic-native events (user / assistant / tool / system / session_meta), with no per-event content truncation and first-class tool-call/tool-result capture. Companion change: the CMA Task register tracks completed work so stale `activeIntent` can't mislead the next turn.

## Background — what actually happened on 2026-05-27

Between 16:00 and 16:11 Phoenix, Atlas transcribed a 23-second video, generated 5 ad copy variants, then 3 minutes later did not remember either piece of work and started over. Forensics from the live `data/conversations/atlas-8436579045.json` plus `data/working-memory/atlas-8436579045.json` and the `[prompt-budget]` log line at 16:02:50 show:

1. **Per-entry hard truncation at storage time.** [conversation.ts:31](../../src/conversation.ts) caps `MAX_CONTENT_LENGTH = 2000`. The 16:00 assistant entry was stored at exactly 2003 chars: the verbatim Whisper transcript, then the first 30 chars of ad variant #1, then `...`. Variants #1–#5 — the entire value delivered to the user — were sliced off and dropped at write time. The 16:03 and 16:11 entries are also exactly 2003 chars.

2. **CMA task register stale.** Working memory at 16:11 still reads `activeIntent: "Locate video file on OneDrive…so Atlas can transcribe"` and `currentStep: "Waiting for user to provide exact filename"`. The file had been found, transcribed, and turned into copy 11 minutes earlier. `PlanRegister.completedSteps` is `[]`. Nothing in `updateTaskFromTurn` records completed work; the Haiku-driven `deepUpdate` runs every 5 turns and only updates `activeIntent`/`user`/`plan` fields, not `completedSteps`.

3. **Tool work is not in the buffer at all.** The Whisper transcript existed only inside the Claude CLI session's `--resume` blob and as a substring of the (then-truncated) assistant message. Atlas's ring buffer never sees `ls`, `ffmpeg`, or Whisper as their own events. When the assistant string was truncated, the transcript text mostly survived (it was early in the response) but the variants did not.

4. **Atlas diagnosed itself.** Entry [46] at 16:11: *"The copy got lost to context compaction and was never saved to a file. … To regenerate: I need the video content. Let me find that video file and check if I transcribed it earlier."*

5. **Prior fix (2026-05-26) addressed an adjacent bug, not this one.** Raising `MAX_ENTRIES` 20→60 prevented full-entry eviction. It did not change per-entry truncation. The 16:02:50 `[prompt-budget]` line shows `conversation=7579` — budget was not starved. The entries it carried were just empty of the work product.

## Reference architecture — Hermes (same machine, `.hermes/profiles/derek/sessions/`)

Hermes stores each session as **append-only JSONL** in Anthropic-native shape. A real example from `20260526_160853_0b85a298.jsonl`, 18 events:

| line | type | size | note |
|------|------|------|------|
| 0 | `session_meta` | 48,477 | full tool catalog + model + platform |
| 1 | `user` | 79 | |
| 2 | `assistant` | 177 | text |
| 5–7 | `assistant` | 366–859 | with `tool_calls` |
| 8 | `tool` | 259 | `{role:"tool", name:"skills_list", content:"…", tool_call_id:"toolu_…"}` |
| 11 | `tool` | **107,256** | a 107KB tool result, kept verbatim |
| 13–17 | mixed | | |

No per-event truncation. Tool events are first-class. The whole file replays as an Anthropic `messages: []` array.

## Goals

- A single fidelity floor — given the JSONL, Atlas can always reconstruct what it did and what tools produced, regardless of CLI session state.
- Zero behavior change to the LLM prompt assembly when conversation is small. Same `[prompt-budget]` numbers, same Tier 1 gating.
- No data migration risk — existing JSON-array buffers are replayed into JSONL once, with the original kept as `.legacy`.
- CMA `activeIntent`/`currentStep` no longer go stale after completed work in the same session.

## Non-goals

- Content-addressed artifact files (`data/artifacts/<hash>.txt`). The Hermes pattern proves an untruncated assistant event is enough; we add artifact addressing only if a future use case actually needs it.
- SQLite for conversations. Hermes uses SQLite for `state.db`/`kanban.db` (task and plan state). Conversations on flat JSONL stay fine.
- Reworking working-memory.ts registers shape. We add one field (`completedThisSession`) to `TaskRegister`; everything else stays.
- Changes to Tier 1 gating, intent classification, Telegram chunking, heartbeat, or `--resume` policy.

## Design

### 1. Storage format

**File:** `data/conversations/<agent>-<userId>.jsonl` (colons in `userId` → dashes, same sanitisation as today).

**Event schema (Anthropic-native):**

```ts
// every event has these
type BaseEvent = {
  timestamp: string;       // ISO 8601 UTC, same as today's entries
  role: "user" | "assistant" | "tool" | "system" | "session_meta";
};

type UserEvent = BaseEvent & {
  role: "user";
  content: string;
  type?: "text" | "voice" | "photo" | "document";
};

type AssistantEvent = BaseEvent & {
  role: "assistant";
  content: string;                       // unbounded
  finish_reason?: "stop" | "tool_calls" | "length" | "error";
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
};

type ToolEvent = BaseEvent & {
  role: "tool";
  name: string;                          // e.g. "Bash", "Read", "WebFetch"
  content: string;                       // tool result, unbounded
  tool_call_id: string;                  // matches AssistantEvent.tool_calls[].id
};

type SystemEvent = BaseEvent & {
  role: "system";
  content: string;
  source?: "session_reset" | "evolution" | "code_agent" | "migration" | "other";
};

type SessionMetaEvent = BaseEvent & {
  role: "session_meta";
  model: string;
  agentId: string;
  userId: string;
  sessionId: string | null;             // Claude CLI session id at start
  schema_version: 1;
  migrated_from_array?: boolean;
};
```

**Writes are append-only.** No file rewrites, no shifts, no per-event truncation.

### 2. Eviction and compression

Eviction stops being a function of entry count. It becomes a function of *projected prompt size* at read time. The JSONL file grows; `formatForPrompt` chooses a slice.

- `formatForPrompt(key, excludeLastN, maxEntries?)` reads the JSONL tail (default last 60 events for parity with today's `MAX_ENTRIES`).
- If the projected slice exceeds the conversation budget (8K chars, unchanged), call `compactIfNeeded` exactly like today. The compactor input is the real content now, not a truncated stub, so its Haiku summary will actually summarize the ad copy and the transcript.
- The cached compression summary (`<key>-summary.json` and the `summaries` Supabase row) keeps the same schema. `coveredCount` becomes "events covered."
- A separate one-shot rotation tool can move events older than N days to `<key>.YYYY-MM.jsonl` archives later. **Not in this change.**

### 3. Tool-result capture from Claude CLI stream-json

[claude.ts](../../src/claude.ts) already parses the CLI's `--output-format stream-json` for typing indicators, streaming deltas, and tool-call interception. We tap that same parser:

- When the stream emits `{type:"content_block_start", content_block:{type:"tool_use", id, name, …}}`, accumulate the tool name + id + arguments.
- When the stream emits `{type:"content_block_stop"}` for a tool_use, append an `AssistantEvent` with `tool_calls: [{id, function:{name, arguments}}]` and `content: ""` if no text preceded it.
- When the stream emits a `user` message containing `tool_result` blocks (the CLI feeds tool results back as user messages), append a `ToolEvent` with `name`, `content`, and `tool_call_id`. Match the id to the prior `tool_calls[].id`.
- Final assistant text (after all tool calls finish) appends as a normal `AssistantEvent` with `content` + `finish_reason: "stop"`.

**All tool calls + all results are captured** (per Derek's choice). The Whisper transcript becomes its own `ToolEvent` line — durable, queryable, never re-run.

### 4. Migration

On first `loadBuffer(key)` after deploy, if `<key>.json` exists but `<key>.jsonl` does not:

1. Read the JSON array.
2. Write a `SessionMetaEvent` with `migrated_from_array: true`, `schema_version: 1`, and the current `sessionId`.
3. For each entry, append a single event preserving its existing `role` (`user` | `assistant` | `system`), `content`, and `timestamp`. **The content stays exactly as on disk**, including any `...` truncation from the old format — we don't try to un-truncate. The legacy buffer has no tool events to migrate; tool capture starts only for new events written after migration.
4. Rename `<key>.json` → `<key>.json.legacy`.
5. Log `info("conversation", "migrated key=<key> entries=<n> bytes=<m>")`.

`<key>-summary.json` is untouched; it still describes the same window of past entries.

Rollback: restore `<key>.json` from `<key>.json.legacy`, delete `<key>.jsonl`. The legacy file is the rollback artifact.

### 5. CMA companion change — completed-work tracking

Add to [working-memory.ts](../../src/working-memory.ts) `TaskRegister`:

```ts
interface TaskRegister {
  activeIntent: string;
  lastUserMessage: string;
  lastAssistantAction: string;
  turnCount: number;
  completedThisSession: string[];   // NEW — capped at 20, FIFO
  updatedAt: string;
}
```

Populated inside `updateTaskFromTurn` (runs every turn, pure function, no LLM) by parsing the assistant response for:

- `[REMEMBER: …]` tags — `completedThisSession.push("Noted: <first 80 chars>")`
- `Created|Wrote|Saved|Generated` followed by a path or named artifact → `completedThisSession.push("<verb> <target>")`
- Any assistant content block ≥ 500 chars containing a numbered list of 3+ items, or 3+ fenced code blocks → `completedThisSession.push("Produced: <first non-empty line, 80 chars>")`

Cap at 20 entries, drop oldest. Cleared on session reset (`cleanupSession` already archives working memory; this rides along).

**Strengthen the `AUTO-PERSIST RULE`** in [relay.ts:5674](../../src/relay.ts) to explicitly cover generated content: *"When you produce substantive content for the user — ad copy variants, draft posts, plan outlines, code blocks, transcripts — emit a `[REMEMBER:]` tag summarizing what you produced and where it can be referenced (e.g. `[REMEMBER: Generated 5 ad copy variants for VID_20260527_143043.mp4, saved inline in conversation 16:00 PM]`)."*

### 6. Prompt assembly changes

`formatForPrompt` becomes a projection over the JSONL:

- Read last N events (default 60).
- Map each event to a single line: `[time] <Role>[<type>]: <content>`.
  - `assistant` with `tool_calls` and empty `content` → `[time] Atlas: (called <tool_name>(<truncated_args>))`.
  - `tool` event → `[time] System[tool:<name>]: <content>` (truncated to 1000 chars in the rendered string; full content remains in the JSONL).
  - other events: unchanged rendering.
- Apply the same `CONTEXT_PRUNE_AGE_ENTRIES` / `CONTEXT_PRUNE_MAX_CHARS` aging logic at *render time*, not write time.
- Hand to `compactIfNeeded` as today.

`MAX_PROMPT_CHARS=25000`, `conversation budget = 8000`, Tier 1 gating: all unchanged.

### 7. Behavior on session reset

`cleanupSession` in [claude.ts:1456](../../src/claude.ts) keeps adding its system note. The JSONL is the durable backstop instead of a truncated 4-entry slice on retry (`claude.ts:1304`, `:1380`) — the retry path picks the same `formatForPrompt` projection, which now contains actual content.

The corruption-retry path (`claude.ts:1283-1311`) and empty-result-retry path (`:1356-1389`) need no logic change; they only see a richer `formatForPrompt` output.

## Files touched

| File | Change |
|---|---|
| [src/conversation.ts](../../src/conversation.ts) | core rewrite: JSONL append, schema types, projection-style `formatForPrompt`, migration helper. `MAX_CONTENT_LENGTH` removed. `addEntry` becomes `appendEvent` with overloads for the new event types. |
| [src/claude.ts](../../src/claude.ts) | stream-json parser taps for tool_use / tool_result → `appendEvent({role:"tool", …})`. Existing tool-call interception (`onCodeTaskCaptured`) stays. |
| [src/working-memory.ts](../../src/working-memory.ts) | add `completedThisSession` field to `TaskRegister`; `updateTaskFromTurn` populates it; `formatWMForPrompt` renders it; `createEmpty` initializes to `[]`. |
| [src/relay.ts](../../src/relay.ts) | strengthen `AUTO-PERSIST RULE` in `behavioralRules` (line 5674). No assembly logic change. |
| [src/constants.ts](../../src/constants.ts) | retire `MAX_CONTENT_LENGTH` references; keep `MAX_ENTRIES=60` as the read-tail default. |
| `data/conversations/*.json` | one-shot migration to `*.jsonl` + `*.json.legacy`. |

No changes to: heartbeat.ts, tiered-context.ts, search.ts, memory.ts, supabase summaries schema, Telegram delivery, Tier 1 gating.

## Testing

Unit tests (Bun's built-in test runner, the pattern used in [tests/](../../tests)):

1. **Append-only writes** — `appendEvent` × 5 of mixed types produces 5 lines, each parseable, ordered by timestamp.
2. **No truncation** — append a 50KB assistant content, read back, byte-exact match.
3. **Tool round-trip** — append `AssistantEvent` with `tool_calls`, then matching `ToolEvent` with `tool_call_id`. `formatForPrompt` projection renders both with the right ordering.
4. **Migration idempotency** — running migration on a directory with both `<key>.json` and `<key>.jsonl` is a no-op (jsonl exists → skip).
5. **Migration content preservation** — every entry in the legacy JSON array shows up as a JSONL event with the same `content` (including its `...` truncation).
6. **`formatForPrompt` budget respect** — given 200 events at 5KB each, projection trims to ≤ 8000 chars and triggers compaction.
7. **`completedThisSession` parsing** — assistant message containing a `[REMEMBER:]` tag and a numbered 5-item list produces two entries; cap-at-20 FIFO honored.
8. **CMA stale-intent fix** — given the actual 16:00→16:11 sequence as fixture data, after `updateTaskFromTurn` on entry [42], `completedThisSession` contains a "Generated 5 ad copy variants" entry; `activeIntent` still says "transcribe" but the next-turn prompt now shows the completed item.

Manual verification:

- Replay today's 16:00–16:11 buffer through the new code path (load `atlas-8436579045.json.legacy`, run migration, then run the projection). Confirm the rendered conversation context surfaces "Generated 5 ad copy variants" and the transcript text. Spot-check tokens via a Haiku compaction call.
- Send Atlas a fresh "transcribe this and write ad copy" task, ask for market research a minute later, confirm Atlas references the prior transcript instead of re-running ffmpeg/whisper.

## Risk and rollback

| Risk | Mitigation |
|---|---|
| Migration corrupts a buffer | We rename rather than delete the original. Roll back by `mv *.json.legacy *.json` and `rm *.jsonl`. |
| stream-json parser misclassifies an event | Unknown events fall back to a `SystemEvent` with `source: "other"` and the raw payload as content. No silent drops. |
| JSONL files grow unbounded | A future rotation tool moves events older than N days to `<key>.YYYY-MM.jsonl`. For now, even the 16:00–16:11 incident's worst-case turn was 107KB at Hermes (a Bash output dump) — at 5 such turns/day, ~1MB/day. Acceptable. |
| `formatForPrompt` projection is slower than reading the in-memory array | Cache the parsed JSONL tail in the existing `buffers: Map` (it's already in-memory). Re-parse only on append. |
| Compactor Haiku call gets a much bigger input | Compactor input is the same byte budget (we're feeding it the projection, not the whole JSONL). It just contains real content now. |
| Behavioral-rules change increases prompt size | The new sentence adds ~250 chars to `behavioral_rules` (currently 1193). Bumps total by 1%. |

## Out of scope (explicit follow-ups)

- Content-addressed artifact files + a `read_artifact` tool. Add only if (a) JSONL projection routinely exceeds budget for substantive outputs or (b) we want artifacts referenceable across sessions.
- SQLite for conversation storage. Add if JSONL append throughput becomes a contention point (it won't for a single-user Telegram bot).
- Replay-from-JSONL on session reset. Today's retry path injects the projection, which is good enough. Full replay against the Claude CLI is a bigger lift and a separate spec.
- Migration of `.claude/worktrees/*/data/conversations/*.json` files. Worktrees are throwaway. Skip.
