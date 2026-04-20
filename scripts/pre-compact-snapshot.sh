#!/usr/bin/env bash
# Atlas Prime — PreCompact snapshot writer.
# Writes memory/compact-snapshot.md with current re-orientation context.

SNAPSHOT="memory/compact-snapshot.md"
mkdir -p memory

{
  echo "# Compact Snapshot — $(date -Iseconds)"
  echo ""
  echo "## Re-orient instructions"
  echo ""
  echo "Read these files silently before your first response:"
  echo "- memory/$(date +%Y-%m-%d).md (today's journal, if present)"
  echo "- memory/MEMORY.md (long-term memory index)"
  echo ""
  echo "## Git status snapshot"
  echo ""
  echo '```'
  git status --short 2>/dev/null | head -30
  echo '```'
  echo ""
  echo "## Recent commits"
  echo ""
  echo '```'
  git log --oneline -10 2>/dev/null
  echo '```'
} > "$SNAPSHOT"

exit 0
