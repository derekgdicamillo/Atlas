# Creation Standards for Claude Code Configuration

When Atlas (or any code agent) creates new skills, agents, hooks, rules, or MCP servers, follow these standards. This is the single source of truth for "how to build things right."

## Skills (.claude/skills/<name>/SKILL.md)

### Required frontmatter fields:
```yaml
---
name: skill-name           # kebab-case, matches directory name
description: >-            # 1-2 sentences, triggers auto-invocation
  What this skill does. Include natural language triggers
  so Claude knows when to invoke it automatically.
allowed-tools:             # ALWAYS specify. Principle of least privilege.
  - Read
  - Glob
  - Grep
context: fork              # ALWAYS set. Protects main context window.
---
```

### Optional frontmatter (use when applicable):
```yaml
user-invocable: true       # If user can call via /skill-name
argument-hint: <hint>      # Shows in help. e.g. "[url]", "<topic>"
disable-model-invocation: true  # For setup/maintenance-only skills
model: sonnet              # Override model for this skill
license: MIT               # For open-source skills
compatibility: "Claude Code on Windows"  # Environment requirements
metadata:                  # Custom key-value pairs (recommended)
  author: Atlas
  version: 1.0.0
```

### Content rules:
- **Under 5000 words / 200 lines for core SKILL.md.** Move detailed docs to `references/`. This follows Anthropic's progressive disclosure model: frontmatter (always loaded) > SKILL.md body (loaded when relevant) > references/ (loaded on demand).
- **$ARGUMENTS** - Use to accept user input. Handle: with args, without args, with URL, with action keyword.
- **No secrets in SKILL.md.** Read tokens from `.env` or environment at runtime.
- **No duplicate logic.** If src/ghl.ts already has the API client, don't rebuild it in curl commands. Reference the module.
- **No README.md** inside skill folders. All documentation goes in SKILL.md or references/.
- **No XML angle brackets** (< >) in YAML frontmatter. Security restriction: frontmatter appears in system prompt.
- **No "claude" or "anthropic"** in skill names. Reserved by Anthropic.
- **Humanizer step** - Any skill producing patient/provider-facing content must include "Apply /humanizer as final step" instruction.

### Description field (critical for auto-invocation):
The description MUST include:
1. **What the skill does** (1 sentence)
2. **When to use it** (trigger phrases users would actually say)
3. **Key capabilities** (optional, if space allows)

Structure: `[What it does] + [When to use it] + [Key capabilities]`

Bad: "Helps with projects." (too vague, no triggers)
Good: "Generate flowcharts from plain English. Use when Derek asks for a flowchart, diagram, process map, decision tree, or any visual flow."

### Required sections in SKILL.md body:
1. **Instructions** - Clear, specific, actionable steps (not vague guidance)
2. **Examples** - At least one concrete use case with expected input/output
3. **Troubleshooting** - Common errors with causes and solutions. Code-based validation > language-based instructions for critical checks.

### References pattern for large skills:
```
.claude/skills/my-skill/
  SKILL.md              # Core logic, under 200 lines
  references/
    api-reference.md    # Static API docs
    entity-list.md      # Device lists, entity IDs
    templates.md        # Curl templates, example payloads
```
SKILL.md says: "For entity IDs, see references/entity-list.md"

## Rules Files (.claude/rules/<name>.md)

### When to create:
- Extracted from CLAUDE.md when a section exceeds 20 lines
- Domain-specific instructions that apply to all sessions
- Conditional rules that only apply to certain file types

### Format:
```markdown
---
paths: src/**/*.ts    # Optional: only load for matching file paths
---
# Rule Title
Content here. Keep focused on one topic.
```

### Rules:
- One topic per file. Don't combine unrelated rules.
- No frontmatter needed unless using `paths:` conditional loading.
- Auto-loaded every session (no `@` import needed).

## Custom Agents (.claude/agents/<name>.md)

### Format:
```markdown
---
name: agent-name
model: sonnet              # or opus, haiku
tools:                     # Allowlist (if set, only these tools available)
  - Read
  - Glob
  - Grep
  - WebSearch
  - WebFetch
disallowedTools:           # Denylist alternative
  - Bash
  - Write
maxTurns: 15               # Prevent runaway agents
---
# Agent Name

You are a [role description].

## Your task
[What this agent does]

## Constraints
[What this agent must NOT do]
```

### When to create agents:
- Recurring subagent patterns (research, code review, content generation)
- When you need tool restriction different from main session
- When you want a reusable personality/role for delegation

## Hooks (.claude/settings.json)

### Hook events to use:
- `PreToolUse` - Block dangerous commands before execution
- `PostToolUse` - Auto-lint, validate output after tool runs
- `Stop` - End-of-conversation analysis
- `Notification` - Alert routing

### Hook types:
- `command` - Run a shell command. Exit 0 = success, exit 2 = block.
- `prompt` - Ask Claude to analyze. Returns text guidance.
- Both support `async: true` for non-blocking.

### Pattern:
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "echo $TOOL_INPUT | findstr /i \"rm -rf format del /s\" && exit 2 || exit 0"
      }]
    }]
  }
}
```

## Permission Rules (.claude/settings.json)

### Evaluation order: deny > ask > allow
```json
{
  "permissions": {
    "deny": ["Bash(rm -rf*)", "Bash(del /s*)", "Bash(format*)"],
    "ask": ["Bash(git push*)", "Bash(pm2 restart*)"],
    "allow": ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
  }
}
```

### Rules:
- SHIELD.md blocked commands should be enforced via `deny` rules, not just instructions.
- Use glob patterns: `Bash(pattern)` matches command content.

## MCP Servers (.mcp.json)

### When to create:
- External service with structured API (not just REST calls)
- Need native tool parameters (schema validation, auto-complete)
- Service used across multiple skills

### Format:
```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@package/mcp-server"],
      "env": {
        "API_KEY": "${API_KEY}"
      }
    }
  }
}
```

### Rules:
- Use `${ENV_VAR}` for secrets (expanded at runtime from environment).
- Never hardcode credentials.
- Prefer existing npm MCP server packages over building custom ones.
