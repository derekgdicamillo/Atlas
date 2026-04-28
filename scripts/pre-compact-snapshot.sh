#!/usr/bin/env bash
# PreCompact snapshot: captures key state before context compaction.
# Output goes to stdout — Claude Code includes it in the compact summary.
# Also writes to memory/compact-snapshot.md for post-restart pickup.
#
# Wired to: hooks.PreCompact + hooks.Stop in .claude/settings.json

ATLAS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TODAY=$(date +%Y-%m-%d)

# Journal lives in project memory/
MEMORY_DIR="$ATLAS_DIR/memory"
JOURNAL="$MEMORY_DIR/$TODAY.md"

# Auto-memory MEMORY.md index (Claude Code project memory)
CLAUDE_MEMORY="$HOME/.claude/projects/C--Users-Derek-DiCamillo-Projects-atlas/memory/MEMORY.md"

TASKS_JSON="$ATLAS_DIR/data/tasks.json"
SNAPSHOT_OUT="$MEMORY_DIR/compact-snapshot.md"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Find most recent journal if today's doesn't exist yet
if [ ! -f "$JOURNAL" ]; then
  LATEST_JOURNAL=$(ls "$MEMORY_DIR"/2026-*.md 2>/dev/null | sort | tail -1)
else
  LATEST_JOURNAL="$JOURNAL"
fi

{
  echo "# Atlas Compact Snapshot"
  echo "**Generated:** $NOW"
  echo ""

  echo "## Re-orientation Checkpoint"
  echo "After any context compaction or session reset, do this FIRST:"
  echo "1. Read \`memory/$TODAY.md\` (today's journal)"
  echo "2. Read MEMORY.md index at \`~/.claude/projects/C--Users-Derek-DiCamillo-Projects-atlas/memory/MEMORY.md\`"
  echo "3. Do NOT ask Derek for context already in the journal"
  echo ""

  echo "## Today"
  echo "- Date: $TODAY"
  echo "- Today's journal: \`memory/$TODAY.md\`"
  if [ -f "$JOURNAL" ]; then
    LINES=$(wc -l < "$JOURNAL")
    echo "- Journal: exists ($LINES lines)"
    echo "- Recent entries:"
    grep -v "^#\|^$\|^---" "$JOURNAL" 2>/dev/null | tail -5 | sed 's/^/  /'
  else
    echo "- Journal: not yet created today"
    if [ -n "$LATEST_JOURNAL" ]; then
      LATEST_DATE=$(basename "$LATEST_JOURNAL" .md)
      echo "- Most recent journal: \`memory/$LATEST_DATE.md\`"
    fi
  fi
  echo ""

  echo "## Memory Index"
  if [ -f "$CLAUDE_MEMORY" ]; then
    head -25 "$CLAUDE_MEMORY" | sed 's/^/  /'
  else
    echo "  MEMORY.md not found at expected path"
  fi
  echo ""

  echo "## Active Tasks"
  if [ -f "$TASKS_JSON" ]; then
    python3 -c "
import json
try:
    with open('$TASKS_JSON') as f:
        data = json.load(f)
    tasks = data.get('tasks', [])
    active = [t for t in tasks if t.get('status') in ('running', 'queued', 'in_progress')]
    if active:
        for t in active:
            print(f\"- [{t['id']}] {t['status']}: {t['description'][:80]}\")
    else:
        print('- No active tasks')
except Exception as e:
    print(f'- Error: {e}')
" 2>/dev/null
  else
    echo "- tasks.json not found"
  fi

} > "$SNAPSHOT_OUT"

cat "$SNAPSHOT_OUT"
