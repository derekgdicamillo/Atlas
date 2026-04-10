#!/usr/bin/env bash
# PreToolUse hook: blocks Write/Edit on .claude/ paths
# Exit 0 = allow, Exit 2 = block (stdout shown to model as reason)
#
# TOOL_INPUT is JSON like: {"file_path":"/c/Users/.../atlas/.claude/skills/foo/SKILL.md","content":"..."}

# Extract file_path value using basic tools (no PCRE needed)
FILE_PATH=$(echo "$TOOL_INPUT" | sed -n 's/.*"file_path" *: *"\([^"]*\)".*/\1/p' | head -1)

# Check if path contains .claude/ or .claude\ (Windows paths)
if echo "$FILE_PATH" | grep -qi '\.claude[/\\]'; then
  echo "BLOCKED: Write/Edit tools cannot write to .claude/ paths (hardcoded Claude Code protection)."
  echo "Use Bash with heredoc instead:"
  echo "  mkdir -p \$(dirname \"$FILE_PATH\") && cat > \"$FILE_PATH\" << 'SKILL_EOF'"
  echo "  content here"
  echo "  SKILL_EOF"
  exit 2
fi

exit 0
