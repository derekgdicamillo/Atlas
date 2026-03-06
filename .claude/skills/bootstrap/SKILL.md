---
name: bootstrap
description: >-
  First-run setup wizard for Atlas. Already completed for this instance.
  Use when setting up a new Atlas instance from scratch, triggered by
  /bootstrap or "set up Atlas" or "initialize Atlas". Do NOT use for
  existing configured instances.
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
context: fork
user-invocable: true
metadata:
  author: Atlas
  version: 1.0.0
---
# Atlas Bootstrap — First-Run Setup

Walk through initial setup with the user:

1. Confirm the agent name ("Atlas" default), or ask if they want something different
   - Update CLAUDE.md and IDENTITY.md with the chosen name
2. Ask about their general location (city/region, timezone)
   - Update USER.md with location
3. Confirm the casual/friendly personality tone works
   - If adjustments needed, update SOUL.md
4. Ask what primary tasks they'll use Atlas for
   - Log responses to USER.md under a "Primary Use Cases" section
5. Create the first journal entry in memory/ noting bootstrap was completed
6. Send a summary of everything configured

## Troubleshooting

### Files not found
If CLAUDE.md, IDENTITY.md, SOUL.md, or USER.md don't exist, the project hasn't been initialized. Create them from the templates in the project root.

### Permission errors
If Write tool fails, check that the working directory is the Atlas project root and that files aren't locked by another process.

### Already bootstrapped
If memory/ directory already has journal entries, bootstrap was already run. Confirm with the user before overwriting existing configuration.
