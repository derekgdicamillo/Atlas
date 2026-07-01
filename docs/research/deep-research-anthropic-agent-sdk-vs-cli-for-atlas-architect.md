# Anthropic Agent SDK vs Claude Code CLI: Comprehensive Technical Report for Atlas

**Date**: May 28, 2026  
**Audience**: Derek DiCamillo (Atlas owner/operator)  
**Purpose**: Evaluate whether migrating Atlas from CLI-based architecture to the Anthropic Agent SDK is worthwhile

---

## Executive Summary

The Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`) is **the same engine as Claude Code CLI**, packaged as a library. It spawns a Claude Code binary as a subprocess and communicates via JSON-lines over stdin/stdout — the exact architecture Atlas already implements manually with `claude -p`. Migrating would gain programmatic convenience (TypeScript-native subagent definitions, in-process MCP tools, hook callbacks) but would **not unlock any new capabilities** Atlas doesn't already have. The SDK adds a 12-second cold-start overhead per `query()` call that Atlas's persistent process pool already avoids.

**The critical factor is the June 15, 2026 billing change**: `claude -p` and Agent SDK usage will draw from a separate $200/month credit pool at full API rates, regardless of Max plan. Atlas's current consumption needs to be audited against this cap. If Atlas exceeds $200/month in API-equivalent token usage (likely given Opus cron jobs, overnight pipelines, and sub-agent spawning), the financial model changes significantly.

**Bottom line**: Don't migrate. Atlas has already built the hard parts (persistent process pool, durable state, memory, cost tracking, circuit breakers, evaluation pipeline). The SDK would add a dependency layer without capability gains. Instead, audit token usage against the June 15 credit cap, and consider a hybrid approach: keep CLI for the main agent loop, use raw Messages API (`@anthropic-ai/sdk`) for high-volume cron jobs where built-in tools aren't needed.

---

## Table of Contents

1. [What Is the Agent SDK?](#1-what-is-the-agent-sdk)
2. [What Does Claude Code CLI Actually Provide?](#2-what-does-claude-code-cli-actually-provide)
3. [Head-to-Head Comparison](#3-head-to-head-comparison)
4. [Cost Analysis](#4-cost-analysis)
5. [Atlas-Specific Migration Assessment](#5-atlas-specific-migration-assessment)
6. [Code Examples: Key Patterns in Each Approach](#6-code-examples-key-patterns-in-each-approach)
7. [Community & Expert Opinions](#7-community--expert-opinions)
8. [Risks and Gotchas](#8-risks-and-gotchas)
9. [Recommendation](#9-recommendation)

---

## 1. What Is the Agent SDK?

### Identity

The Agent SDK is a **separate package** from the regular Anthropic API SDK (`@anthropic-ai/sdk`). Originally called the "Claude Code SDK," it was renamed in March 2026 when teams started using it for non-coding agents (legal assistants, SRE bots, research agents).

| | Regular SDK (`@anthropic-ai/sdk`) | Agent SDK (`@anthropic-ai/claude-agent-sdk`) |
|---|---|---|
| **What it does** | Direct Messages API access | Full agent loop with built-in tool execution |
| **Tool execution** | You implement it | Built-in (Read, Write, Bash, etc.) |
| **Agent loop** | You implement it | Built-in (prompt → tools → verify → repeat) |
| **Context management** | You implement it | Built-in (compaction, session persistence) |
| **MCP support** | None | Full native support |
| **Underlying mechanism** | HTTP calls to API | Spawns Claude Code binary as subprocess |

**Package info:**
- TypeScript: `@anthropic-ai/claude-agent-sdk` (v0.3.153 as of May 2026)
- Python: `claude-agent-sdk` (v0.2.87)
- GitHub: `anthropics/claude-agent-sdk-typescript` (1.5k stars), `anthropics/claude-agent-sdk-python` (7.1k stars)

### Architecture

The SDK spawns the Claude Code CLI as a child process and communicates via JSON-lines over stdin/stdout. This is architecturally identical to what Atlas does with `claude -p`, but wrapped in a cleaner programmatic interface.

Two operational modes:
1. **`query()` function** — one-shot interactions, spawns a new CLI process per call
2. **`ClaudeSDKClient` class** — persistent sessions maintaining a single subprocess across multiple queries

The agent loop follows: Gather Context → Take Action → Verify Work → Repeat. Claude autonomously decides when to call tools, processes results, and continues until a goal is reached or a termination condition hits.

Termination conditions:
- `"success"` — Claude produces final answer
- `"error_max_turns"` — `max_turns` limit reached
- `"error_max_budget_usd"` — `max_budget_usd` limit reached

### Built-in Tools

The SDK ships with the **same tools as the CLI** — they're the same runtime:

| Tool | Description |
|------|-------------|
| Read | Read files with line numbers; images, PDFs, Jupyter notebooks |
| Write | Create new files or overwrite |
| Edit | Precise string replacement (read-before-edit required) |
| MultiEdit | Multiple edits in one call |
| Bash | Shell commands; persistent cwd; 2-min default timeout |
| PowerShell | Native PS on Windows (auto-enabled without Git Bash) |
| Glob | File pattern matching (ripgrep-backed) |
| Grep | Content search with regex (ripgrep-backed) |
| WebSearch | Web search via Anthropic backend |
| WebFetch | Fetch URL, convert to markdown |
| Agent | Spawn subagents with isolated context |
| Monitor | Watch background scripts |
| LSP | Language server code intelligence |
| TaskCreate/Get/List/Update | Task management |
| CronCreate/Delete/List | Session-scoped scheduled tasks |
| NotebookEdit | Jupyter cell editing |
| Skill | Execute skills from .claude/skills/ |
| ToolSearch | Load deferred MCP tool schemas |

### Sub-Agent Support

The SDK supports subagents natively with programmatic agent definitions:

- Each subagent gets its own **isolated context window**
- Subagents **cannot spawn their own subagents** (single depth)
- Claude automatically decides when to run subagents concurrently
- Results return to the parent without context contamination
- Different models per subagent (Haiku for cheap tasks, Opus for complex)
- Subagent dispatch multiplies per-run costs by **1.6-2.4x** through parent-context inflation

### MCP Support

Deep native support for MCP, with two patterns:

**External MCP servers** (subprocess, same as CLI):
```typescript
const options = {
  mcpServers: {
    playwright: { command: "npx", args: ["@playwright/mcp@latest"] }
  }
};
```

**In-process SDK MCP servers** (custom tools, SDK-exclusive feature):
```python
from claude_agent_sdk import tool, create_sdk_mcp_server

@tool("greet", "Greet a user", {"name": str})
async def greet_user(args):
    return {"content": [{"type": "text", "text": f"Hello, {args['name']}!"}]}

server = create_sdk_mcp_server(name="my-tools", version="1.0.0", tools=[greet_user])
```

In-process tools avoid subprocess overhead — when the CLI needs the tool, it sends a control request back to the SDK, which directly invokes your function. **This is the one genuinely new capability the SDK adds over raw CLI spawning.**

### Context & Memory Management

- **Session persistence**: JSONL on filesystem (same as CLI)
- **Session resume**: Capture `session_id`, resume with `resume: sessionId`
- **Session fork**: Explore alternative approaches without losing prior context
- **Auto-compaction**: Distills history into summaries when token usage exceeds threshold
- **Memory tool**: Store/retrieve information across conversations via memory file directory
- **`.claude/` config loading**: CLAUDE.md, skills, hooks, rules — all loaded by default

**Key gap**: No documented compaction lifecycle hooks, no graceful degradation at context limits, no state persistence across compaction events in the SDK itself. You must build this. (Atlas already has.)

---

## 2. What Does Claude Code CLI Actually Provide?

### Beyond Raw API Access

Claude Code is not a thin wrapper. An academic analysis by VILA-Lab found that **98.4% of its codebase is deterministic infrastructure, only 1.6% is AI decision logic**. The agent loop itself is a simple ReAct while-loop. The real value is in:

1. **30+ built-in tools** for filesystem, shell, web, code intelligence, task management
2. **Agent loop** with automatic tool execution and result processing
3. **Context management** with compaction and session continuity
4. **Permission system** (allow/deny/ask) with hook-based enforcement
5. **Extensible plugin/skill/hook/rule system** via `.claude/` directory
6. **MCP protocol support** for connecting to external tools
7. **Sub-agent spawning** for parallel work
8. **Structured streaming output** (NDJSON) for programmatic consumption

### The `.claude/` Ecosystem

This is CLI-exclusive infrastructure that the Agent SDK loads but doesn't help you create:

- **CLAUDE.md**: Project instructions loaded at session start (first 200 lines or 25KB)
- **Rules** (`.claude/rules/*.md`): Auto-loaded, can be path-scoped
- **Skills** (`.claude/skills/<name>/SKILL.md`): Probabilistic capabilities Claude uses when relevant
- **Agents** (`.claude/agents/<name>.md`): Custom subagent definitions with tool restrictions
- **Settings** (`.claude/settings.json`): Permissions, hooks, env vars, shell config
- **Hooks**: Deterministic lifecycle callbacks (PreToolUse, PostToolUse, Stop, etc.)

The Agent SDK **loads this ecosystem** when spawning the CLI binary. Both approaches get the same config. The difference is where your orchestration code lives.

### Headless Mode (`claude -p`)

This is what Atlas uses today. Key capabilities:

- **Output formats**: text, json, stream-json (NDJSON)
- **Bidirectional streaming**: `--input-format stream-json --output-format stream-json`
- **Session continuity**: `--continue` (most recent), `--resume <session-id>` (specific)
- **Permission modes**: `acceptEdits`, `dontAsk`, `auto`, `bypassPermissions`
- **Tool restriction**: `--allowedTools "Read,Edit,Bash"`
- **System prompt override**: `--append-system-prompt`, `--system-prompt`
- **Structured output**: `--json-schema '...'` for schema-conforming responses
- **Agent definitions**: `--agents` for inline subagent config

### What Atlas Has Already Built on Top

Atlas has constructed significant infrastructure beyond what either CLI or SDK provides:

| Infrastructure Layer | Atlas Implementation | SDK Provides? |
|---|---|---|
| Persistent process pool | `persistent-process.ts` with watchdog, auto-restart, backoff | No (query() spawns fresh) |
| Durable state | Supabase (tasks, memory, metrics, ledger) | No |
| Memory system | Semantic search + graph memory + signed entries | No |
| Cost tracking | `trackClaudeCall()` with per-model pricing | No (basic cost in response) |
| Circuit breakers | Per-service breakers (GHL, Google, Meta) | No |
| Evaluation pipeline | Replay harness, DPO collection, trust budget | No |
| Model routing | Haiku/Sonnet/Opus tier selection | No |
| Sub-agent orchestration | Supervisor, task persistence, code agent delegation | Subagent API only |
| Crash recovery | `--resume` + session archival + ring buffer | Session resume only |
| Multi-agent coordination | Shadow council, marketplace, blackboard | Experimental agent teams |
| Process management | pm2 with `ecosystem.config.cjs` | Not applicable |

This is the Augment Code estimate of **2,200-4,500 engineer-hours** to make the SDK production-ready — and Atlas has already done most of it.

---

## 3. Head-to-Head Comparison

### Capability Matrix

| Dimension | Claude Code CLI (`claude -p`) | Agent SDK | Raw Messages API |
|---|---|---|---|
| **Agent loop** | Built-in | Built-in (same engine) | You build it |
| **Built-in tools** | 30+ (Bash, Read, Write, etc.) | Same 30+ | None |
| **Tool execution** | Automatic | Automatic | Manual |
| **MCP support** | Full (stdio, http, sse) | Full (same + in-process) | None |
| **Subagent spawning** | Built-in Agent tool | Programmatic AgentDefinition | You build it |
| **Context management** | Auto-compaction, session resume | Same | You build it |
| **.claude/ ecosystem** | Full (rules, skills, hooks) | Loads same config | N/A |
| **Streaming** | NDJSON via `--output-format stream-json` | Async iterator over messages | SSE stream |
| **Session persistence** | JSONL files + `--resume` | Same (JSONL + session_id) | None |
| **Custom tools** | MCP servers only | MCP + in-process `@tool` | `tools` parameter |
| **Cold start** | 12s per spawn; 0 with persistent process | 12s per `query()` | 1-3s per API call |
| **Process model** | External subprocess (you manage) | Internal subprocess (SDK manages) | HTTP client |
| **Hooks** | File-based (.claude/settings.json) | Programmatic (HookMatcher) | N/A |
| **Permissions** | allow/deny/ask in settings | permissionMode + canUseTool | N/A |
| **Windows support** | Functional with known friction | Same binary, same issues | Full |
| **Vendor lock-in** | Claude-only | Claude-only | Claude-only (but swappable) |

### What SDK Adds Over Raw CLI

1. **Programmatic subagent definitions** — Define agents in code instead of `.claude/agents/*.md` files
2. **In-process MCP tools** — `@tool` decorator for custom tools without MCP server overhead
3. **Hook callbacks in code** — PreToolUse/PostToolUse as functions, not shell commands
4. **Type-safe message streaming** — Typed async iterators instead of raw NDJSON parsing
5. **Budget controls** — `max_budget_usd` as a first-class parameter
6. **Permission callbacks** — `canUseTool` function for dynamic permission decisions
7. **Cleaner API surface** — `query()` vs raw process spawning with flag management

### What CLI Has That SDK Doesn't Improve

1. **Persistent process model** — The SDK's `query()` spawns fresh processes. `ClaudeSDKClient` maintains one process but is less battle-tested. Atlas's persistent-process.ts is more mature.
2. **Process supervision** — pm2, watchdog, crash recovery are Atlas's responsibility either way
3. **Durable state** — Neither provides it. Atlas has Supabase.
4. **Multi-agent coordination** — Both support basic subagents. Atlas has built marketplace, shadow council, blackboard, etc.
5. **The entire application layer** — Telegram relay, cron scheduling, memory system, metrics engine — none of this changes.

### The 12-Second Latency Problem

The Agent SDK has a **confirmed 12-second overhead per `query()` call** (GitHub issue #34 on the TS repo). Breakdown:
- Process spawn: 4-5s
- CLI initialization: 3-4s
- Model loading: 2-3s

Atlas's persistent process pool eliminates this entirely by keeping processes alive. Migrating to the SDK's `query()` pattern would **reintroduce** this latency unless using `ClaudeSDKClient` (which approximates what Atlas already does).

---

## 4. Cost Analysis

### Current State (Pre-June 15)

Atlas runs on the **Max 20x plan ($200/month)**. Currently, `claude -p` usage draws from the same unlimited usage pool as interactive Claude Code. This is effectively unlimited within rate limits.

### June 15, 2026 Billing Change (CRITICAL)

Starting June 15, Agent SDK and `claude -p` usage gets a **separate $200/month credit pool** metered at full API rates:

| Model | Input (per MTok) | Output (per MTok) | Cache Hit (per MTok) |
|---|---|---|---|
| Opus 4.7 | $5.00 | $25.00 | $0.50 |
| Opus 4.6 | $5.00 | $25.00 | $0.50 |
| Sonnet 4.6 | $3.00 | $15.00 | $0.30 |
| Haiku 4.5 | $1.00 | $5.00 | $0.10 |

**What $200/month buys (approximate, assuming 50K tokens per run, 50/50 input/output split):**

| Model | Cost per Run | Runs per Month |
|---|---|---|
| Opus | ~$0.75 | ~265 |
| Sonnet | ~$0.45 | ~440 |
| Haiku | ~$0.15 | ~1,333 |

**Atlas's estimated monthly consumption (needs audit):**

| Usage Category | Estimated Runs/Month | Model | Est. Monthly Cost |
|---|---|---|---|
| Interactive conversations (Telegram) | 300-500 | Opus | $225-375 |
| Sub-agents (code, research) | 100-200 | Opus/Sonnet | $45-150 |
| Cron jobs (daily/weekly) | 150-300 | Sonnet/Haiku | $22-90 |
| Overnight pipelines (night shift, DGM, dreams) | 60-120 | Opus/Sonnet | $45-90 |
| Content generation (waterfall, hooks, recon) | 30-60 | Sonnet/Opus | $13-45 |
| Shadow Atlas | 300-500 | Haiku | $45-75 |
| **Total estimate** | | | **$395-825** |

**This suggests Atlas may exceed the $200 credit cap by 2-4x.** When credits exhaust, usage flows to "usage credits" at the same API rates (if enabled), or requests fail. This is the single biggest reason to evaluate architecture changes.

### Cost Optimization Strategies

1. **Prompt caching**: Up to 90% reduction on cached input tokens. Atlas's CLAUDE.md/SOUL.md/etc. (~10K+ tokens) would cache well across turns in a persistent process.
2. **Model routing**: Already implemented via `routeModel()`. Ensure cron jobs and overnight work use Haiku/Sonnet where possible, reserving Opus for interactive and complex tasks.
3. **Raw API for simple crons**: Jobs that don't need built-in tools (content critic, model routing, Haiku classification) could use `@anthropic-ai/sdk` directly, bypassing the CLI entirely.
4. **Batch API**: 50% off all models for async workloads. Overnight pipelines could batch.
5. **Token budget caps**: Already have `max_budget_usd` support. Tighten per-task caps.

### Break-Even Analysis

If Atlas moves cron/overnight work to raw API (Batch where possible):
- Interactive + sub-agents on CLI: ~$270-525/month → fits in $200 credit with optimization
- Cron + overnight on raw API with Batch: ~$40-100/month → separate API billing
- Total: ~$310-625/month vs current $200/month flat

**The "unlimited" era is ending.** Cost optimization becomes a real engineering concern.

---

## 5. Atlas-Specific Migration Assessment

### What Would Need to Change

If migrating to Agent SDK (`@anthropic-ai/claude-agent-sdk`):

| Component | Change Required | Effort |
|---|---|---|
| `relay.ts` (Telegram relay) | Replace raw CLI spawning with SDK `query()` or `ClaudeSDKClient` | Medium |
| `claude.ts` (session management) | Replace with SDK session API | Medium |
| `persistent-process.ts` | Replace with `ClaudeSDKClient` or remove (SDK manages subprocess) | Medium |
| MCP configuration | Move from `.mcp.json` to SDK options (or keep `.mcp.json`, SDK loads it) | Low |
| Hooks | Move from shell commands to programmatic callbacks | Medium |
| Sub-agent spawning | Replace `callClaude()` CLI invocations with SDK `AgentDefinition` | Medium |
| NDJSON streaming | Replace with SDK async iterator | Low |
| `.claude/` ecosystem | Keep as-is (SDK loads it) | None |
| Supabase integration | Keep as-is (application layer) | None |
| Cron system | Keep as-is (application layer) | None |
| pm2 process management | Keep as-is (still need external supervisor) | None |
| Cost tracking | Update to use SDK cost reporting | Low |

**Estimated effort**: 3-5 days of focused work. Not a rewrite — a re-wiring.

### What Would Be Gained

1. **Type-safe message streaming** — Instead of parsing raw NDJSON, use typed async iterators with proper message discrimination
2. **In-process MCP tools** — Define custom tools as TypeScript functions instead of external MCP server processes. This could simplify some of Atlas's tool implementations.
3. **Programmatic hooks** — `canUseTool` function instead of shell script hooks. Faster, more flexible.
4. **Budget controls** — `max_budget_usd` as a first-class parameter on every query
5. **Cleaner sub-agent API** — `AgentDefinition` objects instead of CLI flag strings
6. **Future-proofing** — As Anthropic evolves the agent platform, SDK will likely get features before CLI flags

### What Would Be Lost

1. **Persistent process efficiency** — Unless `ClaudeSDKClient` matches Atlas's persistent-process.ts reliability, you'd regress on cold starts
2. **Battle-tested stability** — Atlas's current architecture has months of production hardening (watchdog, backoff, session archival, crash recovery)
3. **Direct CLI control** — Fine-grained flag management (`--bare`, custom `--system-prompt`, etc.) may not all be exposed in SDK
4. **Simplicity** — The current architecture is understood. Migration introduces new failure modes.
5. **Max plan interactive usage** — Currently, CLI and interactive share the same pool. After June 15, they separate regardless.

### Hybrid Approach (Recommended)

Instead of a full migration, consider a targeted hybrid:

| Workload | Approach | Why |
|---|---|---|
| Interactive Telegram conversations | Keep `claude -p` persistent process | Battle-tested, no cold start, prompt cache reuse |
| Sub-agent spawning | Keep CLI (`callClaude()`) | Works, familiar, same billing pool |
| Haiku classification jobs | Raw API (`@anthropic-ai/sdk`) | No tools needed, 1-3s latency, cheaper |
| Content critic | Raw API | No tools needed, simple prompt→response |
| Overnight batch pipelines | Raw API with Batch mode | 50% cost reduction, no latency requirement |
| Shadow Atlas | Raw API | Just needs prompt→response, no tools |
| New MCP-heavy integrations | Agent SDK (selectively) | In-process `@tool` is genuinely useful here |

This approach:
- Keeps what works (persistent process for main loop)
- Reduces costs (Batch API for overnight, raw API for simple jobs)
- Adds SDK selectively (where in-process tools genuinely help)
- Prepares for the June 15 billing change

---

## 6. Code Examples: Key Patterns in Each Approach

### Pattern 1: Basic Agent Invocation

**CLI approach (current Atlas):**
```typescript
// claude.ts - simplified
const proc = Bun.spawn([
  'claude', '-p',
  '--output-format', 'stream-json',
  '--allowedTools', 'Read,Edit,Bash,WebSearch,WebFetch',
  '--append-system-prompt', systemPrompt,
  '--resume', sessionId,
], {
  stdin: 'pipe',
  stdout: 'pipe',
  env: sanitizedEnv,
});

// Write prompt to stdin
proc.stdin.write(userMessage);
proc.stdin.end();

// Parse NDJSON stream
for await (const line of readLines(proc.stdout)) {
  const event = JSON.parse(line);
  if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
    yield event.event.delta.text;
  }
}
```

**Agent SDK approach:**
```typescript
import { query, ClaudeAgentOptions } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: userMessage,
  options: {
    allowedTools: ['Read', 'Edit', 'Bash', 'WebSearch', 'WebFetch'],
    appendSystemPrompt: systemPrompt,
    resume: sessionId,
    maxBudgetUsd: 2.0,
  }
})) {
  if (message.type === 'text') {
    yield message.content;
  }
}
```

**Raw API approach:**
```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const response = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  system: systemPrompt,
  messages: [{ role: 'user', content: userMessage }],
  // No built-in tools — you define and execute them yourself
  tools: [
    { name: 'search_contacts', description: '...', input_schema: { ... } }
  ],
});

// You implement the tool loop
while (response.stop_reason === 'tool_use') {
  const toolUse = response.content.find(b => b.type === 'tool_use');
  const result = await executeToolLocally(toolUse);
  // Send result back, get next response...
}
```

### Pattern 2: Sub-Agent Spawning

**CLI approach (current Atlas):**
```typescript
// From claude.ts / task delegation
const agentProc = Bun.spawn([
  'claude', '-p',
  '--model', 'sonnet',
  '--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch',
  '--output-format', 'json',
], {
  stdin: 'pipe',
  stdout: 'pipe',
  env: sanitizedEnv,
});

agentProc.stdin.write(researchPrompt);
agentProc.stdin.end();

const result = await new Response(agentProc.stdout).json();
```

**Agent SDK approach:**
```typescript
import { query, AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: 'Research competitor pricing in the GLP-1 market',
  options: {
    allowedTools: ['Agent'],
    agents: {
      'researcher': new AgentDefinition({
        description: 'Market research specialist',
        prompt: 'You are a medical weight loss market researcher...',
        tools: ['WebSearch', 'WebFetch', 'Read'],
        model: 'sonnet',
      }),
    },
    maxBudgetUsd: 3.0,
  }
})) {
  // Subagent results come back as part of the message stream
  if (message.type === 'text') {
    console.log(message.content);
  }
}
```

### Pattern 3: Custom Tools (In-Process MCP — SDK Exclusive)

**Agent SDK approach (Python — not yet available in TypeScript):**
```python
from claude_agent_sdk import tool, create_sdk_mcp_server, query

@tool("search_patients", "Search PV MediSpa patient records", {
    "name": str,
    "phone": str | None,
})
async def search_patients(args):
    # Direct function call — no subprocess, no MCP server process
    results = await ghl_search_contacts(args["name"], args.get("phone"))
    return {"content": [{"type": "text", "text": json.dumps(results)}]}

server = create_sdk_mcp_server(
    name="atlas-tools",
    version="1.0.0",
    tools=[search_patients],
)

async for msg in query(
    prompt=user_message,
    options={"mcp_servers": {"tools": server}},
):
    ...
```

**CLI approach (external MCP server):**
```json
// .mcp.json
{
  "mcpServers": {
    "atlas-tools": {
      "command": "bun",
      "args": ["run", "src/mcp-server.ts"],
      "env": { "GHL_API_KEY": "${GHL_API_KEY}" }
    }
  }
}
```

### Pattern 4: Persistent Session

**CLI approach (current Atlas — persistent-process.ts):**
```typescript
class PersistentProcess {
  private proc: Subprocess | null = null;
  private sessionId: string | null = null;

  async ensureRunning() {
    if (this.proc && !this.proc.killed) return;
    
    const args = ['claude', '--input-format', 'stream-json',
                  '--output-format', 'stream-json', '--verbose'];
    if (this.sessionId) args.push('--resume', this.sessionId);

    this.proc = Bun.spawn(args, { stdin: 'pipe', stdout: 'pipe' });
    
    // Capture session ID from init event
    for await (const line of readLines(this.proc.stdout)) {
      const event = JSON.parse(line);
      if (event.type === 'system' && event.subtype === 'init') {
        this.sessionId = event.session_id;
        break;
      }
    }
  }

  async sendMessage(text: string) {
    await this.ensureRunning();
    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text }
    });
    this.proc!.stdin.write(msg + '\n');
    // Read response events...
  }
}
```

**Agent SDK approach:**
```typescript
import { ClaudeSDKClient, ClaudeAgentOptions } from '@anthropic-ai/claude-agent-sdk';

const options: ClaudeAgentOptions = {
  allowedTools: ['Read', 'Edit', 'Bash', 'WebSearch'],
  permissionMode: 'acceptEdits',
};

// Persistent client
const client = new ClaudeSDKClient(options);
await client.connect();

// Send messages without cold start
await client.query('Process this Telegram message...');
for await (const msg of client.receiveResponse()) {
  // Handle response
}

// Later...
await client.query('Another message...');
for await (const msg of client.receiveResponse()) {
  // Handle response — same session, no cold start
}

// Cleanup
await client.disconnect();
```

---

## 7. Community & Expert Opinions

### Anthropic's Official Guidance

From their "Building Effective Agents" blog post (the canonical guidance):

> "Start with straightforward LLM calls and only introduce complexity when performance measurements justify it."

They recommend starting with raw API calls and only adding framework complexity when measurements justify it. Their most successful customer implementations used simple, composable patterns, not complex frameworks.

### VILA-Lab Academic Analysis ("Dive into Claude Code")

Key findings:
- 98.4% of Claude Code is deterministic infrastructure, only 1.6% is AI decision logic
- Agent capability emerges from the harness, not model sophistication
- Subagent isolation is critical — only summaries return to parent
- **"Invest in the harness, not just the loop."** The agent loop is easily copied; hooks, classifiers, compaction, and isolation are not.

### Augment Code Analysis ("What Ships vs What You Build")

Their production analysis estimates **2,200-4,500 engineer-hours** across six platform layers to make the SDK production-ready:
1. Context/memory (400-800h)
2. Multi-agent orchestration (500-1000h)
3. Security (300-500h)
4. Observability (200-400h)
5. Evaluation pipeline (400-800h)
6. State persistence (400-1000h)

**Atlas has already built most of this.** This is the strongest argument against migration: you'd be adopting a less-mature platform abstraction over infrastructure you've already hardened.

### Community Consensus (Reddit, HN, GitHub)

- **"Same engine, different interface"** — Claude Code CLI and Agent SDK run the identical binary. The SDK is a convenience wrapper, not a capability upgrade.
- **12-second cold start is the top complaint** — GitHub issue #34 on the TS SDK repo. No workaround except persistent processes (which Atlas already does).
- **June 15 billing change is the real story** — Multiple blog posts and community threads about the credit split. Power users who extracted $200+ of API value from $20 plans are scrambling.
- **Windows issues are real** — Agent loading failures due to missing rg.exe, named pipe IPC failures (~20% rate after idle), stale socket cleanup lacking Windows parity, Python SDK `ClaudeSDKClient` hanging on initialization.
- **Production builders keep it simple** — The most successful production agents use raw API with custom tool loops, not the full SDK/CLI stack.

### The Counter-Argument for SDK

Some developers prefer the SDK because:
- **Faster prototyping** — `query()` is simpler than managing CLI subprocesses
- **Type safety** — Typed message streams vs raw NDJSON
- **In-process tools** — `@tool` decorator eliminates MCP server processes
- **Future investment** — As Anthropic builds more agent infrastructure, SDK will likely be the primary interface

---

## 8. Risks and Gotchas

### Migration Risks

1. **Regression on cold start** — If `ClaudeSDKClient` isn't as robust as Atlas's persistent-process.ts, you'd trade proven stability for SDK convenience
2. **Windows-specific SDK bugs** — `ClaudeSDKClient` hanging on initialization (Python issue #208), named pipe failures, agent team spawning truncation at ~255 bytes
3. **SDK version churn** — v0.3.153 is pre-1.0. Breaking changes are likely. CLI flags are more stable.
4. **Lost operational knowledge** — Atlas's current architecture is deeply understood. Migration introduces new failure modes that need re-learning.
5. **No rollback path** — Once you refactor the relay/process management layer, rolling back is another refactor.

### Staying on CLI Risks

1. **June 15 billing change** — `claude -p` usage moves to credit pool. Cost may increase 2-4x.
2. **CLI deprecation** — If Anthropic positions SDK as the primary programmatic interface, CLI flags may get less attention.
3. **Missing SDK features** — In-process MCP tools, programmatic hooks, budget controls — CLI won't get these.
4. **Community drift** — New examples, tutorials, and tooling will target SDK. CLI patterns become undocumented tribal knowledge.

### Known Windows Issues (Both Approaches)

| Issue | Impact | Source |
|---|---|---|
| Missing rg.exe breaks agent loading | `.claude/agents/` not found | GitHub #4627 |
| Agent team spawning truncates at ~255 bytes | Multi-agent patterns fail | GitHub #42391 |
| Named pipe IPC hangs after idle (~20% rate) | Shadow Atlas reliability | GitHub #48520 |
| Stale socket cleanup missing on Windows | Process races, silent crashes | GitHub #58559 |
| PowerShell `$_` variable expansion conflicts | Commands fail through Git Bash | GitHub #15471 |
| `ClaudeSDKClient` hangs on Windows (Python) | SDK persistent sessions broken | Python #208 |

---

## 9. Recommendation

### TL;DR

**Don't migrate to the Agent SDK.** Atlas has already built the hard parts that the SDK doesn't provide. The SDK wraps the same engine Atlas already uses, adding convenience but no new capabilities (except in-process MCP tools, which are marginal value). Instead:

1. **Audit token usage immediately** for the June 15 billing change
2. **Implement a hybrid cost strategy** — keep CLI for interactive, use raw API for simple jobs
3. **Monitor SDK maturity** — revisit when it reaches v1.0 and ships daemon mode

### Detailed Recommendations

#### Immediate (Before June 15)

1. **Add token usage tracking** to Atlas's cost monitoring. Track per-model token consumption across all `claude -p` invocations. You need hard numbers, not estimates.

2. **Identify raw-API candidates**: Jobs that don't use built-in tools (content critic, Haiku classification, staleness sentinel, model routing) should move to direct `@anthropic-ai/sdk` calls. These are simple prompt→response patterns that don't need the CLI's tool infrastructure.

3. **Enable usage credits** on the Anthropic account so requests don't fail when the $200 credit pool depletes.

#### Medium-Term (Q3 2026)

4. **Batch API for overnight pipelines**: Night shift, DGM fork, dream engine, weekly memo — these are async workloads that could use Batch API (50% cost reduction, results within 24h).

5. **Evaluate in-process MCP tools** for the highest-traffic custom tools. If Atlas is spawning separate MCP server processes for tools it calls hundreds of times daily, in-process `@tool` could reduce overhead. But this is a Python-only feature currently.

6. **Monitor SDK daemon mode** (GitHub issue #33). When/if Anthropic ships this, the 12-second cold start goes away and the SDK becomes a genuine improvement over raw process management.

#### Long-Term (2027+)

7. **Consider Managed Agents** for long-running autonomous tasks (overnight pipelines, research agents). At $0.08/session-hour + tokens, this could be cheaper than running Atlas 24/7 on a Max plan if usage is bursty.

8. **Reassess if SDK reaches v1.0** with production-grade features: daemon mode, built-in retry logic, durable execution, multi-tenant support, observability.

### Architecture Decision Record

| Decision | Rationale |
|---|---|
| **Keep CLI for interactive loop** | Persistent process eliminates 12s cold start. Battle-tested. Prompt cache reuse. |
| **Keep CLI for sub-agents** | Same billing pool. `callClaude()` works. No migration cost. |
| **Move simple jobs to raw API** | Content critic, Haiku classification don't need tools. 1-3s vs 12s. Separate billing. |
| **Move overnight to Batch API** | 50% cost reduction. Async-compatible workloads. |
| **Don't adopt Agent SDK now** | Same engine, less mature. 12s cold start. Pre-v1.0. No capability gain for Atlas. |
| **Revisit when SDK ships daemon mode** | That's the feature that would make migration genuinely valuable. |

---

## Appendix A: Atlas Architecture Diagram (Current)

```
Telegram
  ↓ webhook
relay.ts (Bun)
  ↓ routes message
persistent-process.ts
  ↓ writes to stdin (stream-json)
claude -p --resume <session> --output-format stream-json
  ↓ NDJSON events
  ↓ reads from stdout
relay.ts
  ↓ parses tags ([CAL_ADD:], [GHL_NOTE:], etc.)
  ↓ executes actions
  ↓ sends response
Telegram
```

Sub-agent spawning:
```
claude -p (main session)
  ↓ Claude decides to delegate
  ↓ [CODE_TASK:] or [TASK:] tag emitted
relay.ts parses tag
  ↓ spawns new claude -p subprocess
  ↓ monitors progress
  ↓ collects output
relay.ts feeds result back to main session
```

## Appendix B: Hypothetical SDK Architecture

```
Telegram
  ↓ webhook
relay.ts (Bun)
  ↓ routes message
ClaudeSDKClient (persistent)
  ↓ client.query(message)
  ↓ async iterator over messages
relay.ts
  ↓ parses message types
  ↓ handles control messages (permission requests)
  ↓ executes actions from tags
  ↓ sends response
Telegram
```

Sub-agent spawning:
```
ClaudeSDKClient (main session)
  ↓ Claude spawns AgentDefinition subagent
  ↓ SDK manages subprocess internally
  ↓ Result returns to main session
relay.ts receives result in message stream
```

## Appendix C: Hybrid Architecture (Recommended)

```
Telegram
  ↓ webhook
relay.ts (Bun)
  ├── Interactive messages → persistent-process.ts → claude -p (as today)
  ├── Simple classification → @anthropic-ai/sdk → Messages API (direct)
  ├── Content critic → @anthropic-ai/sdk → Messages API (direct)
  ├── Overnight batch → @anthropic-ai/sdk → Batch API (50% off)
  └── Sub-agents → claude -p (as today)
```

## Appendix D: Sources

1. [Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview)
2. [Claude Code Headless Mode](https://code.claude.com/docs/en/headless)
3. [Agent SDK TypeScript GitHub](https://github.com/anthropics/claude-agent-sdk-typescript)
4. [Agent SDK Python GitHub](https://github.com/anthropics/claude-agent-sdk-python)
5. [Agent SDK Demos](https://github.com/anthropics/claude-agent-sdk-demos)
6. [Agent SDK Credits](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
7. [Building Effective Agents (Anthropic)](https://www.anthropic.com/research/building-effective-agents)
8. [Claude Code vs Agent SDK (Augment Code)](https://www.augmentcode.com/tools/claude-code-vs-claude-agent-sdk)
9. [What Ships vs What You Build (Augment Code)](https://www.augmentcode.com/guides/anthropic-agent-sdk-what-ships-vs-what-you-build)
10. [Dive into Claude Code (VILA-Lab)](https://github.com/VILA-Lab/Dive-into-Claude-Code)
11. [12-Second Latency Issue (GitHub #34)](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34)
12. [$200 Credit Impact Analysis](https://dev.to/vainamoinen/what-anthropics-200-agent-sdk-credit-means-if-you-run-claude-p-in-production-ce2)
13. [Managed Agents Overview](https://platform.claude.com/docs/en/managed-agents/overview)
14. [Claude Code Tools Reference](https://code.claude.com/docs/en/tools-reference)
15. [Claude Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
16. [Max Plan Pricing](https://claude.com/pricing/max)
17. [MCP Configuration](https://code.claude.com/docs/en/mcp)
18. [Context Window Management](https://code.claude.com/docs/en/context-window)
19. [Custom Subagents](https://code.claude.com/docs/en/sub-agents)
20. [Hooks Reference](https://code.claude.com/docs/en/hooks)
