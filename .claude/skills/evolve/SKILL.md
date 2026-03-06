---
name: evolve
description: >-
  Run Atlas's evolution pipeline manually (normally runs nightly at 11 PM).
  Triggered by /evolve.
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
context: fork
disable-model-invocation: true
user-invocable: true
---
# Atlas Evolution

Manually trigger the nightly evolution pipeline. This gathers intelligence from multiple sources, analyzes errors and journals, then spawns an opus code agent to implement improvements.

## What It Does

1. **Scan Sources** (parallel):
   - OpenClaw GitHub: new commits and releases
   - Anthropic docs changelog: API changes, new features, deprecations (last 7 days)
   - Claude Code CLI releases: new CLI features or flags (last 7 days)
   - Codebase self-audit: TODO/FIXME markers, stale files

2. **Scan Errors** (last 48 hours):
   - Cron run failures from run-log
   - Recent error.log lines
   - Categorize: recurring vs transient vs new

3. **Scan Journals** (last 3 days):
   - Extract friction points: errors, bugs, crashes, timeouts
   - Extract ideas: wishes, improvements, enhancements

4. **Conversation Review** (yesterday's journals):
   - Analyzes Atlas's behavioral quality, not just errors/friction
   - Detects: dropped tasks, repeated questions from user, misunderstandings, going silent/cut off, premature "I can't" responses, context losses between messages
   - Diagnoses root cause for each issue (timeout, watchdog kill, context overflow, missing memory, bad assumption)
   - Generates concrete remediation: SOUL.md/CLAUDE.md prompt fixes, code changes, memory entries
   - Findings included in the code agent prompt and Telegram summary

5. **Build Evolution Plan** with priority ordering:
   - Critical errors > Behavioral issues > Security patches > New features > FIXMEs > Journal friction > TODOs

6. **Spawn Code Agent** (opus, 60 min, $5 budget):
   - Implements improvements autonomously
   - Reports results to Telegram when done
   - On failure/timeout: saves an action plan to `data/task-output/nightly-evolution-plan.md`

## Steps

1. Import and call `runEvolution({ manual: true })` from `src/evolve.ts`
2. Report the result to the user:
   - If `ran: true`: tell Derek the code agent was spawned with what it's analyzing
   - If `ran: false` and message says "All quiet": tell Derek there's nothing to evolve
   - If `ran: false` with error: tell Derek what went wrong and where the action plan is

## Example Output

If there's work to do:
```
Evolution started. Analyzing: 3 OpenClaw commit(s), 2 error(s) to investigate, 1 Anthropic changelog entry. Code agent spawned (task_xxx_yyy).
```

If nothing to do:
```
All quiet. No new activity, errors, or improvements found.
```
