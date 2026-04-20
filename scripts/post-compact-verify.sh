#!/usr/bin/env bash
# Atlas Prime Sprint 2 — SessionStart / PostCompact re-orient verifier.
# Emits instructions via stdout that are shown to Claude at session start.
# Exit 0 = non-blocking reminder.

SNAPSHOT="memory/compact-snapshot.md"
TODAY="memory/$(date +%Y-%m-%d).md"

echo "=== POST-COMPACT RE-ORIENT (Atlas Prime) ==="
if [ -f "$SNAPSHOT" ]; then
  echo "BEFORE YOUR FIRST RESPONSE, read the following files silently:"
  echo "  1. $SNAPSHOT"
  if [ -f "$TODAY" ]; then
    echo "  2. $TODAY  (today's journal)"
  fi
  echo "  3. memory/MEMORY.md  (index of long-term memory)"
  echo ""
  echo "Do NOT ask 'what were we working on?' — it is in the snapshot."
  echo "Behavioral-fixes.md has documented this re-orient failure three times."
  echo "If the snapshot has active tasks, resume supervision immediately."
fi
exit 0
