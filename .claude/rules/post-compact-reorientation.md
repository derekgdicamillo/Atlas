# Post-Compact Re-Orientation (Mandatory)

## When this fires
Every session start AND after any context compaction. This rule is always loaded.

## The rule (non-negotiable)

**Before your first response in any session, you MUST check:**

1. Does `memory/compact-snapshot.md` exist?
   - If YES: read it — it contains re-orientation instructions, today's journal path, and active tasks.
2. Read today's journal `memory/YYYY-MM-DD.md` if it exists.
3. Read MEMORY.md index (path shown in the snapshot).
4. Only AFTER the above, respond to Derek.

## Why this exists

This rule exists because the re-orient instruction in behavioral-fixes.md was written THREE TIMES
(2026-03-12, 2026-04-03, 2026-04-09) and still not followed. Failure pattern: Atlas responds before
reading context and asks Derek for info he already gave.

## What to do

- Do NOT ask "what were we working on?" — it is in the journal.
- DO silently read `memory/compact-snapshot.md`, then pick up where you left off.
- If compact-snapshot.md shows active tasks, resume supervision immediately.

The snapshot is written by `scripts/pre-compact-snapshot.sh`, fired on PreCompact and Stop hooks.