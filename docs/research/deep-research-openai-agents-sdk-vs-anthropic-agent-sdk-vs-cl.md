# OpenAI Agents SDK vs Anthropic Agent SDK vs Claude Code CLI: Triple Comparison

**Date**: May 28, 2026  
**Audience**: Derek DiCamillo (Atlas owner/operator)  
**Purpose**: Evaluate OpenAI's Agents SDK against the Anthropic ecosystem Atlas already runs on  
**Companion Report**: `deep-research-anthropic-agent-sdk-vs-cli-for-atlas-architect.md` (Anthropic-specific deep dive)

---

## Executive Summary

OpenAI's Agents SDK is a **lightweight, provider-agnostic orchestration framework** (MIT licensed, 26,700+ GitHub stars) that takes a fundamentally different architectural approach than Anthropic's CLI/SDK ecosystem. Where Anthropic ships a **full-stack runtime** (30+ built-in tools, filesystem access, shell execution, MCP, session management), OpenAI ships a **composable control plane** (agent loop, handoffs, guardrails, tracing) and expects you to bring your own tools.

**The verdict for Atlas**: OpenAI's SDK is elegant but solves a different problem. It excels at multi-agent orchestration patterns (handoffs, guardrails, voice) but lacks the infrastructure layer Atlas depends on (filesystem tools, shell access, .claude/ ecosystem, session persistence with compaction). Switching would require rebuilding 80% of what Claude Code CLI provides for free. However, OpenAI's **handoff pattern, guardrails architecture, and provider-agnostic design** are worth studying as architectural inspiration even while staying on Claude.

---

## Table of Contents

1. [OpenAI Agents SDK Deep Dive](#1-openai-agents-sdk-deep-dive)
2. [Head-to-Head Comparison Table](#2-head-to-head-comparison-table)
3. [Same Pattern, Three Frameworks (Code Examples)](#3-same-pattern-three-frameworks)
4. [What OpenAI's SDK Does Better](#4-what-openais-sdk-does-better)
5. [What OpenAI's SDK Lacks That Atlas Needs](#5-what-openais-sdk-lacks-that-atlas-needs)
6. [Could Atlas Use OpenAI's SDK with Claude Models?](#6-could-atlas-use-openais-sdk-with-claude-models)
7. [The Real Question for Derek](#7-the-real-question-for-derek)
8. [Recommendation](#8-recommendation)

---

## 1. OpenAI Agents SDK Deep Dive

### What Is It?

The OpenAI Agents SDK is an open-source (MIT) Python and TypeScript framework for building multi-agent AI applications. It evolved from OpenAI's experimental "Swarm" project (late 2024) into a production-grade framework launched March 2025.

| | Details |
|---|---|
| **Current version** | v0.17.4 (May 2026) |
| **GitHub stars** | 26,700+ |
| **License** | MIT (truly open source) |
| **Languages** | Python (`openai-agents`) + TypeScript (`@openai/agents`) |
| **Philosophy** | "Lightweight, powerful framework for multi-agent workflows" |
| **Key evolution** | April 2026: sandbox execution, harness/compute separation |

### Architecture: The Agent Loop

The SDK implements an autonomous execution loop via the `Runner` class:

```
1. Call LLM with agent's instructions + tools + input
2. Evaluate response:
   - final_output (no tool calls) → loop ends
   - handoff → update active agent, restart loop  
   - tool calls → execute tools, append results, restart loop
3. Exceeds max_turns (default 25) → MaxTurnsExceeded error
```

Three execution modes:
```python
# Async (primary)
result = await Runner.run(agent, "Write a haiku about recursion.")

# Sync wrapper
result = Runner.run_sync(agent, "Write a haiku about recursion.")

# Streaming
result = Runner.run_streamed(agent, "Write a haiku about recursion.")
async for event in result.stream_events():
    print(event.type)
```

### Four Core Primitives

The entire framework is built on just four concepts:

1. **Agents** — LLMs configured with instructions, tools, handoffs, guardrails, output types
2. **Tools** — Functions the agent can call (5 categories: function tools, hosted tools, agents-as-tools, MCP tools, deferred tools)
3. **Handoffs** — Agent-to-agent delegation (transfer control entirely)
4. **Guardrails** — Input/output validators that can halt execution

### Agent Definition

```python
from agents import Agent, function_tool

@function_tool
def get_weather(city: str) -> str:
    """Returns weather info for the specified city."""
    return f"The weather in {city} is sunny"

agent = Agent(
    name="Weather Agent",
    instructions="Help users check weather. Be concise.",
    model="gpt-5-nano",
    tools=[get_weather],
    model_settings=ModelSettings(temperature=0.7),
)
```

Key parameters:
- `name` — identifier (required)
- `instructions` — system prompt (string or dynamic callback)
- `tools` — callable functions, hosted tools, MCP servers
- `handoffs` — agents to delegate to
- `model` — which LLM
- `input_guardrails` / `output_guardrails` — validators
- `output_type` — structured output (Pydantic model)
- `hooks` — lifecycle callbacks

### Tool Definition (function_tool decorator)

The decorator auto-generates JSON schemas from Python type annotations and docstrings:

```python
from agents import function_tool, RunContextWrapper

@function_tool
async def search_contacts(ctx: RunContextWrapper[AppContext], name: str, phone: str | None = None) -> str:
    """Search CRM contacts by name.
    
    Args:
        name: Contact name to search for.
        phone: Optional phone number filter.
    """
    results = await ctx.context.crm.search(name, phone)
    return json.dumps(results)
```

Features:
- Auto-schema from type hints (Pydantic, TypedDict, dataclass, Union, Optional)
- Docstring parsing (Google, Sphinx, NumPy styles)
- `RunContextWrapper` for dependency injection (auto-excluded from schema)
- Timeouts: `@function_tool(timeout=2.0, timeout_behavior="raise_exception")`
- Rich output: images, files, structured data
- Conditional enabling: `is_enabled=lambda ctx, agent: ctx.context.feature_flag`

### Multi-Agent Orchestration: Handoffs

**Pattern 1: Handoffs (transfer control)**
```python
billing_agent = Agent(name="Billing", instructions="Handle billing questions.")
refund_agent = Agent(name="Refund", instructions="Process refund requests.")

triage_agent = Agent(
    name="Triage",
    instructions="Route billing questions to Billing, refund requests to Refund.",
    handoffs=[billing_agent, refund_agent],
)
```

Handoffs appear to the LLM as tools (e.g., `transfer_to_billing`). When invoked, the active agent changes entirely. The new agent takes over the conversation.

**Pattern 2: Agents-as-Tools (maintain control)**
```python
researcher = Agent(name="Researcher", instructions="Research topics thoroughly.")
writer = Agent(name="Writer", instructions="Write polished content.")

orchestrator = Agent(
    name="Content Manager",
    tools=[
        researcher.as_tool(tool_name="research", tool_description="Deep research on a topic"),
        writer.as_tool(tool_name="write", tool_description="Polish content for publication"),
    ],
)
```

The orchestrator stays in control. Sub-agents execute and return results.

### Guardrails System

Three layers of validation:

**Input Guardrails** (run on user input, can be parallel with agent):
```python
from agents import input_guardrail, GuardrailFunctionOutput

@input_guardrail
async def block_pii(ctx, agent, input) -> GuardrailFunctionOutput:
    result = await Runner.run(pii_detector_agent, input, context=ctx.context)
    return GuardrailFunctionOutput(
        output_info=result.final_output,
        tripwire_triggered=result.final_output.has_pii,
    )
```

**Output Guardrails** (run after agent produces final output):
```python
@output_guardrail  
async def verify_no_hallucination(ctx, agent, output) -> GuardrailFunctionOutput:
    # Validate agent's output before delivering to user
    ...
```

**Tool Guardrails** (run before/after each tool call):
```python
@tool_input_guardrail
def block_secrets(data):
    args = json.loads(data.context.tool_arguments or "{}")
    if "sk-" in json.dumps(args):
        return ToolGuardrailFunctionOutput.reject_content("Remove secrets first.")
    return ToolGuardrailFunctionOutput.allow()
```

When a tripwire triggers, execution **immediately halts** with an exception.

### Tracing and Observability

Built-in tracing captures everything: LLM calls, tool invocations, handoffs, guardrails, custom spans.

```python
from agents import trace

with trace("Customer Support Workflow"):
    result = await Runner.run(triage_agent, user_message)
```

- **26+ ecosystem integrations**: Weights & Biases, Arize-Phoenix, MLflow, LangSmith, Langfuse, DataDog, PostHog
- **Free dashboard**: OpenAI trace dashboard works even with non-OpenAI models
- Custom trace processors for routing to your own backend
- Sensitive data controls (opt-in/out per field)

### MCP Support

Full Model Context Protocol integration with 5 transport types:

```python
from agents import MCPServerStdio, MCPServerStreamableHttp, HostedMCPTool

# Local subprocess (same as Claude's MCP)
async with MCPServerStdio(
    name="Filesystem",
    params={"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]},
) as server:
    agent = Agent(mcp_servers=[server])

# HTTP transport
async with MCPServerStreamableHttp(
    name="API Server",
    params={"url": "http://localhost:8000/mcp"},
) as server:
    agent = Agent(mcp_servers=[server])

# Hosted (OpenAI server-side, zero config)
tool = HostedMCPTool(tool_config={"type": "mcp", "server_url": "https://mcp.deepwiki.com/mcp"})
```

Features: tool caching, dynamic filtering, approval policies, manager for multi-server setups.

### Model Flexibility (Provider-Agnostic)

The SDK can use **any LLM provider**:

```python
# OpenAI-compatible endpoints (Groq, Together, Ollama, vLLM, etc.)
from agents import AsyncOpenAI, OpenAIChatCompletionsModel
client = AsyncOpenAI(base_url="https://api.together.xyz/v1", api_key="...")
model = OpenAIChatCompletionsModel(model="meta-llama/Llama-3-70b", openai_client=client)

# LiteLLM (100+ providers including Anthropic)
from agents.extensions.models.litellm_model import LitellmModel
agent = Agent(model=LitellmModel(model="anthropic/claude-sonnet-4-6", api_key="..."))

# Mix models in one workflow
triage = Agent(model="gpt-5.5")         # OpenAI for routing
researcher = Agent(model=LitellmModel(model="anthropic/claude-opus-4-6"))  # Claude for research
```

**Caveat**: Non-OpenAI models must support structured output AND tool calling. Hosted tools (WebSearch, FileSearch, CodeInterpreter) require OpenAI's API specifically.

### Voice/Realtime Agent Support

Full voice pipeline:

```python
from agents import RealtimeAgent, RealtimeRunner

agent = RealtimeAgent(
    name="Voice Assistant",
    instructions="You are a helpful voice assistant.",
)

runner = RealtimeRunner(starting_agent=agent, config={
    "model_settings": {
        "model_name": "gpt-realtime-2",
        "audio": {
            "input": {"format": "pcm16", "turn_detection": {"type": "semantic_vad"}},
            "output": {"format": "pcm16", "voice": "ash"},
        },
    }
})
```

Supported: semantic VAD, automatic interruption, noise reduction, handoffs between voice agents, tool calling during voice sessions.

### Context Management

Four persistence strategies:

| Strategy | Mechanism | Use Case |
|----------|-----------|----------|
| `result.to_input_list()` | Manual, in-memory | Ephemeral conversations |
| Sessions (SQLite/Redis/Postgres/Mongo) | Auto-persist | Durable, resumable |
| `conversation_id` | OpenAI server-managed | Named conversations |
| `previous_response_id` | Lightweight chain | Simple continuations |

**8 session backends** (built-in): SQLite, Redis, SQLAlchemy (Postgres/MySQL), MongoDB, Dapr, OpenAI Conversations, Encrypted wrapper.

```python
from agents import SQLiteSession
session = SQLiteSession("user_123_conversation")
result = await Runner.run(agent, "Hello", session=session)
# Conversation automatically persisted and restored
```

### Human-in-the-Loop

Runs can pause, serialize state, and resume (even cross-process):

```python
result = await Runner.run(agent, "Delete all temp files.")
if result.interruptions:
    state = result.to_state()
    # Serialize to JSON, store in DB, send to approval queue...
    
    # Later (maybe different process):
    state = await RunState.from_json(agent, stored_json)
    state.approve(result.interruptions[0])
    result = await Runner.run(agent, state)
```

### TypeScript SDK

Full feature parity in `@openai/agents` (npm):
- Agents, handoffs, guardrails, tracing, sandbox agents
- Uses Zod v4 for schema validation (instead of Pydantic)
- Same provider-agnostic model support

---

## 2. Head-to-Head Comparison Table

### Architecture & Philosophy

| Dimension | OpenAI Agents SDK | Anthropic Agent SDK | Claude Code CLI |
|-----------|------------------|--------------------|-----------------| 
| **Philosophy** | Lightweight composable orchestration | Full-stack agent runtime (library wrapping CLI) | Full-stack agent runtime (standalone binary) |
| **Core metaphor** | "Bring your own tools, we handle the flow" | "We ship the whole workshop" | "We ship the whole workshop" |
| **Primitives** | 4 (agents, tools, handoffs, guardrails) | ~20+ (same as CLI tools + SDK wrappers) | 30+ built-in tools |
| **Open source?** | Yes (MIT) | Partially (SDK wraps proprietary binary) | No (proprietary binary) |
| **Provider lock-in** | None (any LLM via adapters) | Claude-only | Claude-only |
| **Language** | Python + TypeScript | TypeScript + Python | Binary (any language can spawn) |

### Built-in Tools

| Capability | OpenAI Agents SDK | Anthropic (CLI/SDK) |
|-----------|------------------|---------------------|
| **Filesystem (Read/Write/Edit)** | None (bring your own) | Built-in (30+ tools) |
| **Shell execution (Bash/PowerShell)** | None | Built-in |
| **Web search** | Hosted tool (OpenAI API only) | Built-in (WebSearch) |
| **Web fetch** | None | Built-in (WebFetch) |
| **Code interpreter** | Hosted tool (OpenAI API only) | Built-in (Bash + any runtime) |
| **File search / RAG** | Hosted tool (vector store) | None built-in (you build) |
| **Image generation** | Hosted tool (DALL-E) | None |
| **Pattern matching (Glob/Grep)** | None | Built-in (ripgrep-backed) |
| **Sub-agent spawning** | Via handoffs + agents-as-tools | Built-in Agent tool |
| **Task management** | None | Built-in (TaskCreate/Get/List) |
| **MCP tools** | Full support (5 transports) | Full support (stdio/http/sse) |

### Agent Orchestration

| Pattern | OpenAI | Anthropic |
|---------|--------|-----------|
| **Single agent** | `Runner.run(agent, input)` | `query(prompt, options)` or `claude -p` |
| **Agent delegation (keep control)** | `agent.as_tool()` | Agent tool (subagent) |
| **Agent delegation (transfer control)** | Handoffs | Not supported (subagents always return) |
| **Multi-agent routing** | Triage agent with handoff list | Claude decides from agent definitions |
| **Parallel agents** | Manual (asyncio.gather) | Built-in concurrent subagents |
| **Max concurrent** | Unlimited (you manage) | Single depth (no nested subagents) |
| **Dynamic agent selection** | Conditional handoffs with filters | Model-driven selection |

### Guardrails & Safety

| Feature | OpenAI | Anthropic |
|---------|--------|-----------|
| **Input validation** | `@input_guardrail` (LLM-powered) | None built-in (you build in hooks) |
| **Output validation** | `@output_guardrail` (LLM-powered) | None built-in |
| **Tool-level guards** | `@tool_input_guardrail` | `PreToolUse` hooks (shell commands) |
| **Permission system** | Approval flows (human-in-the-loop) | allow/deny/ask + `canUseTool` callback |
| **Tripwire (halt execution)** | Yes, immediate exception | Yes, hook exit code 2 blocks |
| **Safety model** | Guardrails as first-class primitives | Hooks + permission rules in config |

### Tracing & Observability

| Feature | OpenAI | Anthropic |
|---------|--------|-----------|
| **Built-in tracing** | Yes (comprehensive) | Minimal (session JSONL) |
| **Dashboard** | Free OpenAI trace dashboard | None built-in |
| **Ecosystem integrations** | 26+ (W&B, DataDog, etc.) | None (DIY) |
| **Custom processors** | Plugin architecture | None |
| **Sensitive data controls** | Per-field opt-in/out | None |

### Memory & Context

| Feature | OpenAI | Anthropic |
|---------|--------|-----------|
| **Session persistence** | 8 backends (SQLite, Redis, Postgres, MongoDB, Dapr, encrypted) | JSONL files + session resume |
| **Auto-compaction** | None (manual history management) | Built-in (auto-distills at token limit) |
| **Cross-process resume** | Yes (serializable RunState) | Yes (`--resume session_id`) |
| **Long-term memory** | None built-in (use tools/MCP) | Memory tool + .claude/ files |
| **Context window management** | Manual (`limit`, callbacks) | Automatic compaction |

### Production Concerns

| Factor | OpenAI | Anthropic |
|--------|--------|-----------|
| **Cold start** | 0 (it's a library, not a subprocess) | 12s per spawn (0 with persistent process) |
| **Windows support** | Full (Python/Node library) | Functional with known friction |
| **Maturity** | v0.17.4 (March 2025 launch) | v0.3.153 (pre-1.0) |
| **Community** | 26,700 stars, very active | 8,600 stars combined |
| **Cost model** | API tokens only (no SDK fee) | API tokens (separate $200/mo credit pool after June 15) |
| **Streaming** | Async iterators over events | NDJSON or typed SDK iterators |
| **Error handling** | `MaxTurnsExceeded`, model refusal handlers | `error_max_turns`, `error_max_budget_usd` |
| **Retry logic** | Built-in (exponential backoff, jitter, per-status) | None (you build) |

---

## 3. Same Pattern, Three Frameworks

### Pattern: Customer Support Triage with Tools

**OpenAI Agents SDK:**
```python
from agents import Agent, Runner, function_tool, handoff, input_guardrail, GuardrailFunctionOutput

@function_tool
async def lookup_patient(name: str) -> str:
    """Search patient records by name."""
    return json.dumps(await ghl.search_contacts(name))

@input_guardrail
async def block_phi_leak(ctx, agent, input) -> GuardrailFunctionOutput:
    result = await Runner.run(phi_checker, input)
    return GuardrailFunctionOutput(
        tripwire_triggered=result.final_output.contains_phi
    )

billing_agent = Agent(name="Billing", instructions="Handle insurance and billing questions.")
scheduling_agent = Agent(name="Scheduling", instructions="Book, cancel, or reschedule appointments.")

triage = Agent(
    name="PV MediSpa Support",
    instructions="Route patients to the right specialist.",
    tools=[lookup_patient],
    handoffs=[billing_agent, scheduling_agent],
    input_guardrails=[block_phi_leak],
    model="gpt-5.5",
)

result = await Runner.run(triage, "I need to reschedule my Botox appointment")
# → Agent hands off to scheduling_agent automatically
```

**Anthropic Agent SDK:**
```typescript
import { query, AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: "I need to reschedule my Botox appointment",
  options: {
    allowedTools: ['Read', 'Bash', 'Agent'],
    appendSystemPrompt: `You are PV MediSpa support. Route:
      - Billing/insurance → billing subagent
      - Scheduling → scheduling subagent
      Search GHL for patient context first.`,
    agents: {
      billing: new AgentDefinition({
        description: 'Handle insurance and billing questions',
        tools: ['Read', 'Bash'],
        model: 'sonnet',
      }),
      scheduling: new AgentDefinition({
        description: 'Book, cancel, or reschedule appointments',
        tools: ['Read', 'Bash'],
        model: 'sonnet',
      }),
    },
    maxBudgetUsd: 1.0,
  }
})) {
  if (message.type === 'text') yield message.content;
}
```

**Claude Code CLI (current Atlas):**
```typescript
// Atlas just uses the main agent with instructions
const proc = Bun.spawn(['claude', '-p',
  '--output-format', 'stream-json',
  '--allowedTools', 'Read,Edit,Bash,WebSearch,WebFetch',
  '--append-system-prompt', systemPrompt, // includes routing logic
  '--resume', sessionId,
], { stdin: 'pipe', stdout: 'pipe', env: sanitizedEnv });

proc.stdin.write("I need to reschedule my Botox appointment");
proc.stdin.end();
// Claude handles routing internally via CLAUDE.md instructions
```

### Pattern: Guardrail Before External Action

**OpenAI:**
```python
@output_guardrail
async def verify_email_content(ctx, agent, output) -> GuardrailFunctionOutput:
    """Ensure no PHI leaks in outbound email."""
    result = await Runner.run(compliance_agent, f"Check for PHI: {output.email_body}")
    return GuardrailFunctionOutput(
        tripwire_triggered=result.final_output.has_phi,
        output_info={"flagged_terms": result.final_output.terms}
    )

email_agent = Agent(
    name="Email Drafter",
    output_guardrails=[verify_email_content],
    output_type=EmailDraft,
)
```

**Anthropic (hooks-based, current Atlas):**
```json
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "scripts/guard-external-actions.sh"
      }]
    }]
  }
}
```

```bash
# scripts/guard-external-actions.sh
# Exit 2 = block the tool call
echo "$TOOL_INPUT" | grep -i "SEND\|CAL_ADD\|GHL_WORKFLOW" && exit 2
exit 0
```

### Pattern: Multi-Model Routing

**OpenAI (native):**
```python
# Different models per agent — zero configuration
cheap_triage = Agent(name="Triage", model="gpt-5-nano", instructions="Route queries.")
research = Agent(name="Research", model="gpt-5.5", instructions="Deep analysis.")
creative = Agent(name="Writer", model="gpt-5.5", instructions="Write content.")

triage = Agent(
    name="Router",
    model="gpt-5-nano",  # Cheap model for routing
    handoffs=[research, creative],
)
```

**Anthropic / Atlas:**
```typescript
// Atlas's model router (custom-built)
import { routeModel } from './model-router';

const model = await routeModel('research', 'complex'); // → 'opus'
const proc = Bun.spawn(['claude', '-p', '--model', model, ...]);
```

---

## 4. What OpenAI's SDK Does Better

### 1. Handoff Pattern (Genuine Win)

OpenAI's handoff is a **first-class primitive** that elegantly solves multi-agent routing:

```python
triage = Agent(
    name="Triage",
    handoffs=[billing, scheduling, escalation],  # That's it. The LLM figures out routing.
)
```

Atlas currently handles routing via **instructions in CLAUDE.md** and **tag parsing in relay.ts**. OpenAI's approach is more declarative, more testable, and the routing decision is visible in the trace. Atlas's approach works but is implicit (Claude "decides" based on prompt context, not explicit handoff declarations).

**What Atlas could adopt**: Formalize routing as explicit declarations rather than implicit prompt instructions. Even without switching SDKs, Atlas could define a routing manifest that makes agent-to-agent delegation more visible and auditable.

### 2. Guardrails as First-Class Primitives (Genuine Win)

OpenAI treats guardrails as **composable, LLM-powered validators** that are part of the agent definition:

```python
agent = Agent(
    input_guardrails=[block_pii, verify_intent, rate_limit],
    output_guardrails=[check_compliance, verify_accuracy],
)
```

Atlas's current approach: Shell script hooks (`PreToolUse` exit 2), Shadow Council (3 critics), and tool-gate.ts. These work but are **infrastructure-heavy** compared to OpenAI's decorator pattern. OpenAI's guardrails can use **the LLM itself** to validate (a cheap model checking a powerful model's output), which is elegant.

**What Atlas could adopt**: The Shadow Council is already close to this pattern, but guardrail logic could be made more declarative and composable.

### 3. Provider-Agnostic Design (Genuine Win)

OpenAI's SDK can call **any LLM** via adapters:

```python
# Anthropic via LiteLLM
agent = Agent(model=LitellmModel(model="anthropic/claude-sonnet-4-6"))

# Local model via OpenAI-compatible API
agent = Agent(model=OpenAIChatCompletionsModel(model="llama-3", openai_client=local_client))

# Mix in one workflow
triage = Agent(model="gpt-5-nano")  # Cheap OpenAI routing
worker = Agent(model=LitellmModel(model="anthropic/claude-opus-4-6"))  # Powerful Claude work
```

Atlas is **locked to Claude**. If Anthropic's pricing becomes unfavorable, or another model excels at a specific task, Atlas can't easily swap. OpenAI's approach gives genuine flexibility.

**What Atlas could adopt**: The existing `model-router.ts` could be extended to route to non-Claude models for specific tasks (e.g., use GPT for image understanding, Claude for reasoning). This would require moving some workloads to the raw API pattern recommended in the Anthropic report.

### 4. Built-in Tracing (Genuine Win)

OpenAI ships a **free trace dashboard** with 26+ ecosystem integrations:

```python
with trace("Patient Intake Workflow"):
    result = await Runner.run(intake_agent, patient_data)
    # Every LLM call, tool invocation, handoff, guardrail check is logged
    # Viewable in OpenAI dashboard OR exported to DataDog/W&B/etc.
```

Atlas has built custom telemetry (agent-events, task-progress, ledger), but it's bespoke. OpenAI's tracing is production-grade observability out of the box.

**What Atlas could adopt**: Standardize Atlas's telemetry into a trace format that could plug into observability platforms. The ledger + agent-events are close but don't integrate with standard tooling.

### 5. Voice Agent Support (Genuine Win for Future)

OpenAI has native voice pipeline integration:

```python
agent = RealtimeAgent(name="PV Front Desk", instructions="...")
runner = RealtimeRunner(starting_agent=agent)
```

If PV MediSpa ever wants a phone-based AI receptionist or voice-activated patient intake, OpenAI's realtime agent framework is production-ready today. Claude has no equivalent.

### 6. Session Persistence Backends (Genuine Win)

8 production-ready backends (SQLite, Redis, Postgres, MongoDB, Dapr, encrypted) vs. Anthropic's JSONL files:

```python
from agents import RedisSession
session = RedisSession("patient_12345", redis_url="redis://cache:6379")
```

Atlas built its own persistence (Supabase), which is more powerful, but OpenAI's approach is **zero-config** for common patterns.

### 7. Human-in-the-Loop with Serializable State (Genuine Win)

Runs can pause, serialize to JSON, be approved async, and resume in a different process:

```python
result = await Runner.run(agent, "Send marketing email to all patients")
if result.interruptions:
    # Serialize, send to Telegram for Derek's approval
    state = result.to_state().to_string()
    # ... Derek approves via Telegram ...
    state = await RunState.from_json(agent, approved_state)
    result = await Runner.run(agent, state)
```

Atlas has approval patterns (Shadow Council, relay tag confirmation) but they're custom-built. OpenAI's is a framework primitive.

### 8. Zero Cold Start (Architecture Win)

OpenAI's SDK is a **library** (import and call), not a subprocess. There's no 12-second spawn time. Anthropic's CLI/SDK spawns a binary subprocess every time.

---

## 5. What OpenAI's SDK Lacks That Atlas Needs

### Critical Missing: Filesystem Tools

Atlas's Claude Code CLI provides **30+ built-in tools** for filesystem manipulation:

| Tool | What Atlas Uses It For |
|------|----------------------|
| Read | Reading config, journals, patient data, code |
| Write | Creating files, journals, reports |
| Edit | Modifying code, updating configs |
| Bash/PowerShell | Running commands, git, pm2, package management |
| Glob | Finding files by pattern |
| Grep | Searching code/content |
| WebSearch | Real-time information lookup |
| WebFetch | Scraping pages, API calls |

**OpenAI has NONE of these.** You'd need to implement every one as a custom tool:

```python
# You'd need to build all of this yourself
@function_tool
def read_file(path: str) -> str:
    return Path(path).read_text()

@function_tool  
def write_file(path: str, content: str) -> str:
    Path(path).write_text(content)
    return "OK"

@function_tool
def run_command(command: str) -> str:
    result = subprocess.run(command, shell=True, capture_output=True)
    return result.stdout.decode()

@function_tool
def glob_search(pattern: str) -> str:
    return json.dumps([str(p) for p in Path(".").glob(pattern)])

# ... and 25+ more
```

This is **months of work** to reach parity with what Claude Code CLI provides for free. And it would lack the hardening (security checks, permission system, error handling) that the CLI has built over years.

### Critical Missing: .claude/ Ecosystem

Atlas's entire skill/rule/hook system:
- **CLAUDE.md** — 25KB of project instructions loaded every session
- **Skills** (`.claude/skills/`) — 40+ reusable capabilities
- **Rules** (`.claude/rules/`) — behavioral constraints, auto-loaded
- **Hooks** — PreToolUse guards, PostToolUse validation, Stop handlers
- **Agents** (`.claude/agents/`) — custom subagent definitions
- **Settings** — permissions, env vars, shell config

None of this exists in OpenAI's world. You'd build a custom config system from scratch.

### Critical Missing: Context Compaction

Claude Code CLI automatically compacts conversation history when approaching token limits, distilling into summaries. OpenAI's SDK has **no equivalent** — you manually manage history:

```python
# OpenAI: manual history pruning
run_config = RunConfig(session_settings=SessionSettings(limit=50))

# vs Claude: automatic, with snapshot hooks and graceful degradation
# (Atlas's pre-compact-snapshot.sh fires automatically)
```

For a 24/7 bot like Atlas that runs for weeks, automatic compaction is essential. Without it, you'd need to build your own summarization pipeline.

### Critical Missing: Session Persistence Across Compaction

Atlas's persistent process maintains conversation state across compaction events. The pre-compact hook writes a snapshot, the post-compact hook re-orients. OpenAI's sessions persist messages but have no concept of progressive summarization or context-aware recovery.

### Missing: Sub-Agent Spawning with Tool Isolation

Claude Code's Agent tool spawns subagents with:
- Isolated context windows
- Restricted tool sets per subagent
- Different models per subagent
- Automatic cleanup

OpenAI's agents-as-tools pattern is similar but requires more manual wiring.

### Missing: The Infrastructure Atlas Already Built

| Atlas Infrastructure | Equivalent in OpenAI SDK |
|---------------------|-------------------------|
| Persistent process pool | Not applicable (library, no subprocess) |
| Supabase-backed memory | Build yourself (or use sessions) |
| Semantic search + graph memory | Build yourself |
| Cost tracking per model | Build yourself (tracing helps) |
| Circuit breakers | Build yourself |
| Replay harness / evaluation | Build yourself |
| Model routing (Haiku/Sonnet/Opus) | Native (per-agent model) |
| Shadow council | Could build with agents-as-tools |
| Marketplace / reputation | Build yourself |
| Dream engine / night shift | Build yourself |
| Signed ledger | Build yourself |
| Trust budget | Build yourself |

**Bottom line**: Switching to OpenAI's SDK would mean rebuilding 80% of Atlas's infrastructure while gaining a nicer orchestration layer.

---

## 6. Could Atlas Use OpenAI's SDK with Claude Models?

### Yes, Technically

The OpenAI Agents SDK is provider-agnostic. Using Claude models is supported:

**Via LiteLLM adapter:**
```python
pip install 'openai-agents[litellm]'

from agents import Agent
from agents.extensions.models.litellm_model import LitellmModel

agent = Agent(
    name="Atlas",
    model=LitellmModel(model="anthropic/claude-opus-4-6", api_key="sk-ant-..."),
    instructions="You are Atlas, Derek's AI assistant...",
    tools=[...],  # Your custom tools
)
```

**Via OpenAI-compatible proxy (e.g., LiteLLM proxy, OpenRouter):**
```python
from agents import AsyncOpenAI, OpenAIChatCompletionsModel

client = AsyncOpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key="or-...",
)
model = OpenAIChatCompletionsModel(model="anthropic/claude-opus-4-6", openai_client=client)
agent = Agent(name="Atlas", model=model)
```

### Caveats and Limitations

1. **"Best effort, beta"** — OpenAI explicitly labels non-OpenAI model support as beta
2. **No hosted tools** — WebSearchTool, FileSearchTool, CodeInterpreterTool require OpenAI's API. You'd lose these.
3. **Structured output compatibility** — Claude handles structured output differently than OpenAI. May produce schema validation errors.
4. **Tool calling format** — Claude and OpenAI have slightly different tool call formats. LiteLLM translates, but edge cases exist.
5. **No prompt caching** — Anthropic's prompt caching (90% discount on repeated system prompts) only works through Anthropic's native API. Going through LiteLLM loses this optimization.
6. **No extended thinking** — Claude's thinking mode requires native API access.
7. **Double latency** — LiteLLM proxy adds a network hop. OpenRouter adds a hop + queue.

### Practical Assessment

Running Claude through OpenAI's SDK via LiteLLM is **technically possible but architecturally backwards** for Atlas's use case. You'd be:

1. Losing built-in filesystem tools (must rebuild)
2. Losing prompt caching (significant cost increase)
3. Losing extended thinking
4. Adding an adapter layer that introduces failure modes
5. Gaining... a nicer orchestration abstraction?

The orchestration patterns (handoffs, guardrails) are the appealing part, but those can be implemented **on top of the existing Claude CLI architecture** without switching SDKs.

---

## 7. The Real Question for Derek

### What Would OpenAI's SDK Need to Offer to Justify a Switch?

Given Atlas's deep integration with Claude Code CLI and months of production infrastructure:

1. **A capability Claude fundamentally can't do** — Voice agents are the only candidate today. If PV MediSpa needs an AI phone receptionist, OpenAI wins here.

2. **Dramatically better cost economics** — If the June 15 billing change makes Claude 3-4x more expensive AND OpenAI offers comparable quality at lower prices, the math might change. But Claude's reasoning quality for Atlas's med-spa domain is proven.

3. **Provider-agnostic requirement** — If Derek needs to hedge against Anthropic risk (pricing changes, API instability, model quality regression), having a provider-agnostic layer makes sense as insurance. But this is a hedge, not a feature.

4. **Collaborative multi-agent workflows** — If Atlas evolves toward multiple specialized agents that need formal handoff protocols (not just subagent spawning), OpenAI's handoff primitive is more elegant than Atlas's current tag-based delegation.

### What Atlas Should Adopt as Patterns (Without Switching)

Even staying on Claude, these OpenAI patterns are worth implementing:

#### 1. Declarative Guardrails

Instead of shell script hooks, define guardrails as typed validators:

```typescript
// atlas-style guardrails (inspired by OpenAI)
const emailGuardrail: OutputGuardrail = {
  name: 'phi-check',
  validator: async (output) => {
    const result = await callHaiku(`Check for PHI in: ${output}`);
    return { pass: !result.hasPhi, reason: result.flaggedTerms };
  },
  action: 'block', // or 'warn', 'log'
};

// Applied to specific action surfaces
const sendEmailAction = withGuardrails([emailGuardrail], async (params) => {
  // ... send email
});
```

#### 2. Explicit Routing Manifests

Instead of implicit routing via CLAUDE.md instructions:

```yaml
# config/routing-manifest.yaml
routes:
  billing:
    agent: billing-specialist
    model: sonnet
    triggers: ["insurance", "invoice", "payment", "copay"]
  scheduling:
    agent: scheduling-specialist  
    model: haiku
    triggers: ["reschedule", "cancel appointment", "book"]
  clinical:
    agent: clinical-advisor
    model: opus
    triggers: ["labs", "medication", "dosage", "protocol"]
```

#### 3. Standardized Tracing

Adopt OpenTelemetry-compatible trace format for Atlas's existing telemetry:

```typescript
// Current Atlas: bespoke agent-events JSONL
// Proposed: structured traces compatible with DataDog/Grafana

const span = tracer.startSpan('atlas.tool_call', {
  attributes: { tool: 'GHL_NOTE', contact: 'Jane Doe' }
});
```

#### 4. Human-in-the-Loop State Serialization

Make Atlas's approval flows (Shadow Council, [GHL_WORKFLOW:] confirmation) follow a serializable state pattern so they work across restarts:

```typescript
interface PendingApproval {
  id: string;
  action: string;
  context: SerializedState; // Can survive restarts
  expiresAt: Date;
  approvedBy?: string;
}
```

---

## 8. Recommendation

### For Atlas Today: Stay on Claude Code CLI

The math is clear:
- **OpenAI SDK gains**: Nicer orchestration patterns, provider flexibility, voice support, tracing
- **OpenAI SDK costs**: Rebuild 30+ tools, lose .claude/ ecosystem, lose compaction, lose prompt caching, rebuild months of infrastructure
- **Net**: Massive regression for marginal orchestration gains

### For Future Consideration

| Trigger | Action |
|---------|--------|
| PV MediSpa needs AI phone receptionist | Evaluate OpenAI Realtime Agents for voice-specific workload |
| June 15 billing makes Claude 3x+ too expensive | Build provider-agnostic adapter layer, evaluate GPT-5 for some workloads |
| Atlas needs formal multi-agent collaboration (not just subagents) | Implement handoff-style routing inspired by OpenAI's pattern |
| Anthropic deprecates CLI in favor of SDK-only | Migrate to Anthropic Agent SDK (same engine, different wrapper) |
| Need to run agents on non-Windows infrastructure | OpenAI SDK's library approach (no subprocess) is cleaner for serverless |

### Patterns to Adopt Now (On Claude)

1. **Declarative guardrails** — Formalize Shadow Council + tool-gate into a composable guardrail system
2. **Explicit routing manifest** — Make agent delegation visible and auditable
3. **Trace standardization** — Make Atlas's telemetry compatible with observability platforms
4. **Approval state serialization** — Human-in-the-loop flows that survive restarts

### The One-Liner

> OpenAI's Agents SDK is what you'd build if starting from scratch with no existing infrastructure. Atlas isn't starting from scratch. Stay on Claude, steal the good ideas.

---

## Appendix A: Feature Matrix Summary

```
                        OpenAI SDK    Anthropic SDK    Claude CLI (Atlas)
                        ----------    -------------    ------------------
Filesystem tools        ✗ (DIY)       ✓ (30+)          ✓ (30+)
Agent loop              ✓             ✓                 ✓
Handoffs                ✓ (first-class) ✗              ✗ (tag-based)
Guardrails              ✓ (first-class) ✗ (hooks)      ✗ (hooks)
MCP support             ✓ (5 types)   ✓ (3 types)      ✓ (3 types)
Provider-agnostic       ✓             ✗                 ✗
Voice agents            ✓             ✗                 ✗
Tracing                 ✓ (26+ integs) ✗               ✗ (DIY)
Session backends        ✓ (8 built-in) ✓ (JSONL)       ✓ (JSONL)
Auto-compaction         ✗             ✓                 ✓
.claude/ ecosystem      ✗             ✓                 ✓
Cold start              0s (library)  12s (subprocess)  0s (persistent proc)
Structured output       ✓ (Pydantic)  ✓ (JSON schema)  ✓ (JSON schema)
Human-in-the-loop       ✓ (framework) ✗ (DIY)          ✗ (DIY)
Cost per SDK            $0 (MIT)      $0               $0
Windows support         Full          Known issues      Known issues
TypeScript              ✓             ✓                 N/A (binary)
Python                  ✓             ✓                 N/A (binary)
Maturity (stars)        26,700        8,600             N/A
Open source             Yes (MIT)     Partial           No
```

## Appendix B: Cost Comparison for Atlas's Workload

Assuming Atlas's workload (~500 interactive turns/month, 200 sub-agents, 300 cron jobs, 120 overnight tasks):

| Scenario | Claude (post-June 15) | OpenAI GPT-5 equivalent | Hybrid (Claude + cheaper for cron) |
|----------|----------------------|------------------------|-----------------------------------|
| Interactive (Opus) | ~$375/mo | ~$300/mo (GPT-5.5) | $375/mo (Claude) |
| Sub-agents (Opus/Sonnet) | ~$100/mo | ~$80/mo | $100/mo (Claude) |
| Cron (Sonnet/Haiku) | ~$55/mo | ~$40/mo | ~$25/mo (raw API + batch) |
| Overnight (Opus/Sonnet) | ~$70/mo | ~$55/mo | ~$35/mo (batch API) |
| Shadow Atlas (Haiku) | ~$60/mo | ~$20/mo (GPT-5-nano) | ~$30/mo (raw Haiku) |
| **Total** | **~$660/mo** | **~$495/mo** | **~$565/mo** |

Note: OpenAI costs assume GPT-5 family pricing (not yet confirmed). The hybrid approach (staying on Claude for interactive/sub-agents, using raw API + batch for cron/overnight) is the best cost optimization regardless of framework choice.

## Appendix C: Decision Framework

```
Do you need voice agents?
  YES → Evaluate OpenAI for that specific workload (can coexist with Atlas)
  NO ↓

Is Claude's reasoning quality essential for your domain?
  YES → Stay on Claude (med-spa clinical reasoning is proven)
  NO ↓

Are you starting a new project from scratch?
  YES → Consider OpenAI SDK (cleaner starting point, no legacy to port)
  NO ↓

Do you have months of production infrastructure on Claude?
  YES → Stay on Claude, adopt OpenAI patterns as inspiration
  NO → Evaluate both on a pilot project
```

For Atlas: **Stay on Claude, steal the good ideas, monitor OpenAI for voice use case.**

---

## Appendix D: Sources

1. [OpenAI Agents SDK GitHub](https://github.com/openai/openai-agents-python) (26,700+ stars)
2. [OpenAI Agents SDK Documentation](https://openai.github.io/openai-agents-python/)
3. [OpenAI Agents SDK TypeScript](https://github.com/openai/openai-agents-js)
4. [OpenAI Realtime Agents](https://platform.openai.com/docs/guides/realtime-agents)
5. [LiteLLM Integration](https://docs.litellm.ai/docs/providers/openai_agents_sdk)
6. [Anthropic Agent SDK Report](deep-research-anthropic-agent-sdk-vs-cli-for-atlas-architect.md) (companion)
7. [Anthropic Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
8. [MCP Protocol Specification](https://modelcontextprotocol.io/)
9. [OpenAI Agents SDK Sessions](https://openai.github.io/openai-agents-python/sessions/)
10. [OpenAI Agents SDK Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
11. [OpenAI Agents SDK Tracing](https://openai.github.io/openai-agents-python/tracing/)
12. [OpenAI Agents SDK MCP](https://openai.github.io/openai-agents-python/mcp/)
13. [OpenAI Agents SDK Voice](https://openai.github.io/openai-agents-python/voice/)
14. [OpenAI Agents SDK Multi-Model](https://openai.github.io/openai-agents-python/models/)
