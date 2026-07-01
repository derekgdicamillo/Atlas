# Comprehensive Survey of AI Agent Frameworks (May 2026)

## Context

Atlas is a 24/7 production Telegram bot running on Claude Code CLI on Windows 11. It's a TypeScript/Bun codebase with 30+ built-in tools, MCP server integrations, sub-agent delegation, cron jobs, overnight pipelines, Supabase-backed memory/state, semantic search, graph memory, signed ledger, shadow council, and more. It serves a medical weight loss clinic.

This survey evaluates what else exists in the agent framework landscape beyond the Anthropic Agent SDK and OpenAI Agents SDK already analyzed.

---

## Tier 1: Deep Dives

### 1. LangGraph / LangChain

**What it is:** A stateful graph execution framework for AI agents from LangChain. Models agent decision-making as a directed graph where nodes are functions (LLM calls, tool invocations, conditional logic) and edges are transitions between them, including conditional edges. The critical difference from linear chains: LangGraph supports cycles, allowing an agent to call a tool, evaluate the result, decide to call a different tool, and loop back until a stopping condition is met.

**Architecture:** State-machine-based. You define a `StateGraph` with typed state, add nodes (functions), connect them with edges (including conditional edges that route based on output). Built on concepts from Pregel and Apache Beam. Every state transition is checkpointed, making the entire execution auditable and resumable.

**Built-in tools vs BYO:** Bring-your-own. LangGraph itself is orchestration-only. Tools come from the LangChain ecosystem (hundreds available) or your own custom tools. The `langchain-mcp-adapters` package bridges MCP tool schemas into LangChain-compatible BaseTool objects.

**Multi-agent orchestration:** First-class support for single, multi-agent, and hierarchical architectures. Common pattern: supervisor agent routes tasks to specialist agents, each with their own tool sets. Supports handoffs, delegation, and nested sub-graphs.

**Memory and context:** Built-in persistent memory that survives across sessions. Checkpointing at every state transition. Conversation history management. Cross-session state via persistence backends (Redis, PostgreSQL, SQLite, custom).

**MCP support:** Yes, via `langchain-mcp-adapters` package. Converts MCP tool schemas into LangChain-compatible tools. Both Python and JS/TS versions available, though JS is notably behind Python.

**Model flexibility:** Fully model-agnostic. Works with any provider via LangChain's model abstraction layer. OpenAI, Anthropic, Google, Azure, Ollama, local models, etc.

**Production maturity:** LangGraph 1.0 released October 2025. 90 million monthly downloads. ~24K GitHub stars (LangGraph itself; LangChain parent has 100K+). Production deployments at Uber, JP Morgan, BlackRock, Cisco, LinkedIn, Klarna. Ranked #1 for production agent frameworks by Alice Labs.

**TypeScript support:** Yes, via `@langchain/langgraph` (LangGraph.js). However, the JS/TS SDK is genuinely second-class. Multiple sources confirm it's not at parity with Python. Feature lag, fewer examples, smaller community. The "beta" label understates the gap.

**Windows support:** Yes, Python and Node.js both run on Windows. No known Windows-specific issues.

**Cost model:** MIT-licensed, completely free. LangGraph Platform (managed deployment via LangSmith) is paid: cloud-hosted with observability, evaluation, and deployment tools.

**What Atlas would gain:**
- Battle-tested graph-based state machine with automatic checkpointing
- LangSmith observability platform (tracing, evaluation, debugging)
- Massive ecosystem of pre-built tools and integrations
- Proven at enterprise scale (JP Morgan, Uber)
- Deterministic, auditable execution paths

**What Atlas would lose:**
- Python-first reality. The TS SDK is second-class and would mean constant friction
- Atlas already has richer orchestration than LangGraph provides (shadow council, signed ledger, causal DAG, dream engine, etc.)
- Massive abstraction overhead for something Atlas already does with direct Claude CLI calls
- Would need to rebuild every custom system (procedures, trust budget, DGM fork, etc.)
- LangGraph adds orchestration but not the domain-specific intelligence Atlas has built

**Verdict for Atlas:** The TypeScript gap is a dealbreaker. LangGraph is the strongest production agent framework for Python teams, but Atlas is TypeScript/Bun. Switching would mean either rewriting Atlas in Python or living with a second-class SDK. Neither makes sense. Atlas's custom orchestration (supervisor, persistent process pool, shadow council) already exceeds what LangGraph provides out of the box.

---

### 2. CrewAI

**What it is:** A multi-agent framework that models collaboration as role-based teamwork. Instead of defining graph edges, you define agents with roles, goals, and backstories, then assemble them into a "crew" with tasks. Emphasizes the human team metaphor.

**Architecture:** Role-based orchestration. Each agent has a role, goal, backstory, and tool set. Tasks are assigned to agents. Crews execute tasks sequentially or in parallel. Supports delegation between agents. ~10 minutes from install to first multi-agent flow (vs ~45 minutes for LangGraph).

**Built-in tools vs BYO:** Mix of built-in tools (web search, file operations, etc.) plus BYO via custom tool definitions. Tool Router handles discovery and serving.

**Multi-agent orchestration:** Core strength. Agents collaborate, delegate to each other, produce structured outputs. Crews can be hierarchical or flat. Process types: sequential, hierarchical, and consensual.

**Memory and context:** Short-term (conversation), long-term (persistent), and entity memory. Checkpointing via `CheckpointConfig` saves crew state at task boundaries for resumption. Memory classes recently refactored to be serializable.

**MCP support:** Yes, native MCP and A2A support as of 2026. Tool Router handles MCP tool discovery.

**Model flexibility:** Model-agnostic. Supports OpenAI, Anthropic, Google, Ollama, Azure, any LiteLLM-compatible provider.

**Production maturity:** 45.9K GitHub stars (highest of any agent framework). Version 1.10.1. Ranked #3 by Alice Labs for production. Large community. However, star count doesn't equal production maturity -- many stars are from rapid prototyping use cases.

**TypeScript support:** Python-only officially. There's a community TypeScript port (`crewai-ts`) but it's unofficial, incomplete, and not production-ready.

**Windows support:** Works on Windows, but has known issues. `uvloop` doesn't support Windows (causes installation errors). `chroma-hnswlib` build requires Visual Studio Build Tools. These are solvable but add friction.

**Cost model:** Open source (MIT). CrewAI Enterprise (managed platform) is paid.

**What Atlas would gain:**
- Clean role-based agent delegation pattern
- Fast prototyping for new multi-agent workflows
- Large community and ecosystem

**What Atlas would lose:**
- Everything. No TypeScript support. Full stop.
- Python-only means rewriting Atlas from scratch
- Windows installation friction (uvloop issues)
- Less production-proven than LangGraph for complex stateful workflows
- Role-based metaphor is less flexible than Atlas's graph-based orchestration

**Verdict for Atlas:** Non-starter. Python-only with no official TypeScript SDK. The community TS port is a hobby project. CrewAI's role-based metaphor is interesting for delegation patterns but Atlas already implements delegation via its existing sub-agent system. Not worth the rewrite.

---

### 3. AutoGen / Microsoft Agent Framework (MAF)

**What it is:** AutoGen was Microsoft's multi-agent conversation framework. As of March 2026, it has split three ways:
1. **Microsoft Agent Framework (MAF)** -- the official, production-grade successor (GA April 2026)
2. **AutoGen v0.7.x** -- maintenance mode, no new features, community-managed
3. **AG2** -- community fork maintaining backward compatibility with the legacy v0.2 GroupChat style

MAF merges AutoGen and Semantic Kernel into a single unified SDK.

**Architecture:** Graph-based workflows replacing the old implicit "GroupChat" management. Explicit edges, conditional routing, parallel processing, dynamic execution paths. Middleware pipeline for injecting logic (content safety, logging, compliance) without modifying core prompts. Executors and edges model for workflow composition.

**Built-in tools vs BYO:** BYO primarily. Integrates with Azure AI services, OpenAI, GitHub Copilot SDK. Custom tool registration.

**Multi-agent orchestration:** Strong. Supports sequential, concurrent, handoff, group chat, and Magentic-One patterns. All support streaming, checkpointing, human-in-the-loop, and pause/resume.

**Memory and context:** Pluggable memory architecture. Conversational history, persistent key-value state, vector-based retrieval. Backends: Memory in Foundry Agent Service, Mem0, Redis, Neo4j, or custom stores.

**MCP support:** Not prominently featured in current docs. Likely available via Azure AI Foundry integrations.

**Model flexibility:** Azure OpenAI, OpenAI, GitHub Copilot SDK. Broader provider support via Azure AI Foundry. Less open than LangGraph's provider story.

**Production maturity:** MAF 1.0 GA released April 3, 2026. Backed by Microsoft. Integration with Azure AI Foundry for enterprise deployment. Browser-based local debugger for real-time visualization.

**TypeScript support:** No. Python and C#/.NET only. This is explicitly stated in the documentation. TypeScript teams are directed to other options.

**Windows support:** Excellent (it's Microsoft). .NET-native. First-class Windows citizen.

**Cost model:** Open source. Azure AI Foundry deployment is paid (Azure pricing).

**What Atlas would gain:**
- Microsoft enterprise backing and Azure integration
- Mature middleware pipeline for compliance/safety
- Strong checkpointing and pause/resume
- Excellent Windows support

**What Atlas would lose:**
- No TypeScript. Would need to rewrite in Python or C#
- Azure-centric deployment model
- Less model flexibility than LangGraph or Mastra
- Heavier enterprise overhead for a single-clinic bot

**Verdict for Atlas:** No TypeScript support kills it. MAF is the strongest enterprise agent framework for .NET/Python shops, especially those already on Azure. But Atlas is TypeScript/Bun with no Azure dependency. The migration cost would be enormous for marginal benefit.

---

### 4. Google ADK (Agent Development Kit)

**What it is:** Google's open-source agent development framework. Code-first toolkit for building, evaluating, and deploying AI agents. Multi-language: Python, TypeScript, Go, Java, Kotlin. Emphasizes "build production agents, not prototypes."

**Architecture:** Graph-based execution engine (Workflow Runtime) for composing deterministic flows with AI reasoning. Supports routing, fan-out/fan-in, loops, retry, state management, dynamic nodes, human-in-the-loop, and nested workflows. Task API for structured agent-to-agent delegation.

**Built-in tools vs BYO:** Rich built-in ecosystem: Google Search, Code Execution, OpenAPI tools, MCP tools. Plus custom function tools with authentication. Can also integrate LangChain and LlamaIndex tools.

**Multi-agent orchestration:** Native support. Workflow agents for predictable pipelines, agent-coordinated dynamic routing for adaptive behavior. Task API enables multi-turn task mode, single-turn controlled output, mixed delegation patterns.

**Memory and context:** Intelligent context management. Automatic filtering of irrelevant events, summarization of older turns, lazy-loading artifacts, token usage tracking. "Treats context like source code."

**MCP support:** Yes, first-class. MCP tools are a core tool type alongside built-in and custom tools.

**Model flexibility:** Gemini (primary), Claude (Anthropic), Gemma, Ollama, vLLM, LiteLLM. Multi-provider but Gemini-optimized.

**Production maturity:** ADK 2.0 announced at Google Next '26. Relatively new (April 2025 initial release). Python SDK more mature; TypeScript SDK (`@google/adk` via `google/adk-js`) launched later. GitHub stars not prominently reported but growing fast.

**TypeScript support:** Yes, official. `@google/adk` npm package from `google/adk-js` repo. Also community ports. TS is officially supported alongside Python, Go, Java, Kotlin. However, Python SDK is more mature and better documented.

**Windows support:** Runs anywhere Node.js/Python runs. No known Windows issues.

**Cost model:** Open source (Apache 2.0). Vertex AI Agent Engine deployment is paid (Google Cloud pricing). Can also deploy to Cloud Run, GKE, or any container environment.

**What Atlas would gain:**
- Official TypeScript SDK (rare among top frameworks)
- First-class MCP support
- Google Search and Code Execution built-in
- Multi-language flexibility if needed
- Graph-based workflows with human-in-the-loop
- One-command deployment to Google Cloud

**What Atlas would lose:**
- Gemini-optimized (Atlas uses Claude exclusively)
- Newer, less battle-tested than LangGraph
- Google Cloud deployment bias (Atlas is on Windows/local)
- Would still need to rebuild all of Atlas's custom systems
- Less community ecosystem than LangGraph
- TypeScript SDK is newer and less mature than Python

**Verdict for Atlas:** The most interesting Tier 1 option because it has official TypeScript support and first-class MCP. But the Gemini optimization is a concern for a Claude-native system. The TypeScript SDK is newer and less documented than Python. And fundamentally, Atlas's custom orchestration layer already exceeds what ADK provides. Worth watching but not worth migrating to.

---

### 5. Mastra

**What it is:** TypeScript-first agent framework from the team behind Gatsby.js. Built specifically for the TS ecosystem. Covers agents, memory, tools, workflows, evals, and observability in a single framework. Launched October 2024, hit 1.0 in January 2026.

**Architecture:** Agent primitives (tool use, memory, multi-step reasoning) composed into workflows with precise control: sequential steps, parallel branches, conditionals, loops. Supervisor agents coordinate specialized agents. `.suspend()` / `.resume()` for human-in-the-loop at any workflow step.

**Built-in tools vs BYO:** BYO tools with strong typing. Tool inputs, state, and stream events are all strongly typed. Share tools across agents via MCP.

**Multi-agent orchestration:** Supervisor agents coordinate specialized agents. Complex multi-step processes combine agents and tools within single type-safe workflows. Agent-as-tool pattern supported.

**Memory and context:** Four-tier memory system:
1. Basic message persistence
2. Observational Memory (OM) that compresses conversation history 5-40x into dense observation logs
3. Higher-level reflections from accumulated observations
4. Cross-session context tracking

**MCP support:** First-class, both directions. Load tools from remote MCP servers into agents AND expose agents/tools as MCP servers. Per-server operational controls and diagnostics. MCP tool calls traced with dedicated span types. Studio renders MCP spans with timeline styling.

**Model flexibility:** Access to 3,300+ models from 94 providers via unified model router. Fully model-agnostic.

**Production maturity:** 22K+ GitHub stars. 300K+ weekly npm downloads. Version 1.0 (January 2026). Created by the Gatsby.js team (proven open-source track record). Active development with frequent changelogs through March 2026.

**TypeScript support:** This IS the TypeScript framework. TS-first, not TS-also. Full type safety throughout. `npm create mastra` to start. Works with Node.js, Bun, Next.js.

**Windows support:** Runs anywhere Node.js/Bun runs. No known Windows issues.

**Cost model:** Open source (Apache 2.0). Mastra Cloud for managed deployment. Enterprise features (RBAC, SSO, ACL) require commercial license.

**What Atlas would gain:**
- Native TypeScript framework (no Python tax, no second-class SDK)
- Four-tier memory system with observational memory (could complement Atlas's existing memory)
- First-class MCP support in both directions
- `.suspend()` / `.resume()` workflow primitives
- Mastra Studio visual IDE for debugging
- Type-safe tool definitions and workflow state
- 94-provider model router
- Time-travel debugging for workflows

**What Atlas would lose:**
- Atlas's entire custom architecture (procedures, trust budget, causal DAG, dream engine, shadow council, signed ledger, etc.)
- Claude Code CLI integration (Mastra doesn't wrap Claude Code)
- All existing cron jobs, pipelines, and state management
- The migration would be Atlas-from-scratch with a different foundation
- Mastra is younger and less battle-tested than LangGraph at enterprise scale
- Less community ecosystem than LangChain

**Verdict for Atlas:** The most architecturally compatible option. Same language (TypeScript), same runtime compatibility (Bun), first-class MCP, strong memory system. But the key insight: Atlas doesn't need a new agent framework. It IS an agent framework -- custom-built for its exact use case. Mastra would be interesting if starting from scratch, but migrating Atlas's 30+ custom systems to Mastra would be a rewrite, not a migration. Individual Mastra concepts (observational memory, type-safe tools) could be adopted without adopting the whole framework.

---

## Tier 2: Brief Assessments

### 6. Smolagents (HuggingFace)
- **What:** Minimalist agent library (~1,000 lines of code). Code-first: agents write Python actions instead of JSON tool calls.
- **Stars:** ~26K GitHub stars
- **Language:** Python only
- **MCP:** Yes, can use tools from any MCP server
- **Key strength:** 30% fewer LLM steps via code actions, 44.2% on GAIA benchmark. Sandboxed execution (E2B, Docker, Pyodide).
- **For Atlas:** No. Python-only. Interesting architecture (code-as-action) but not compatible with Atlas's stack. Good learning artifact.

### 7. PydanticAI
- **What:** Type-safe Python agent framework from the Pydantic team. "The FastAPI of agents."
- **Stars:** ~16K GitHub stars
- **Language:** Python only
- **MCP:** Yes, built-in
- **Key strength:** Compile-time type checking on agent inputs/outputs/tools. Durable execution. Composable capabilities.
- **For Atlas:** No. Python-only. The type-safety philosophy is great but Atlas gets similar benefits from TypeScript's native type system.

### 8. Agno (formerly Phidata)
- **What:** Full-stack agent platform. Agent creation in ~2 microseconds, 3.75 KiB per agent. AgentOS REST API runtime with session storage and traces.
- **Stars:** ~39K GitHub stars (carried from Phidata era)
- **Language:** Python only
- **MCP:** Yes, first-class client support. Can also expose itself as MCP server.
- **Key strength:** Extremely fast agent instantiation. Teams with defined roles. AgentOS control plane for production deployment.
- **For Atlas:** No. Python-only. The performance metrics are impressive but irrelevant for a Telegram bot where latency is dominated by LLM inference, not agent instantiation.

### 9. DSPy
- **What:** Stanford research framework for "programming, not prompting" LLMs. Compiles declarative signatures into optimized prompts.
- **Stars:** ~20K+ GitHub stars
- **Language:** Python only
- **MCP:** No
- **Key strength:** 10-40% quality improvement over manual prompting via automatic optimization. Best for structured tasks with clear metrics.
- **For Atlas:** No. Different category entirely. DSPy optimizes prompt quality, not agent orchestration. Could theoretically be used to optimize Atlas's prompts, but the integration overhead isn't worth it for a system that already works well.

### 10. Semantic Kernel (Microsoft)
- **What:** Now merged into Microsoft Agent Framework (MAF). See Tier 1 #3 above.
- **Stars:** ~27K GitHub stars
- **Language:** C#/.NET and Python
- **Status:** In maintenance mode. Microsoft recommends migrating to MAF. Support guaranteed for 1 year post-MAF GA.
- **For Atlas:** No. Being deprecated into MAF. No TypeScript support.

### 11. LlamaIndex Workflows
- **What:** Async-first, event-driven workflow system for data-grounded AI agents. Focused on RAG and document processing.
- **Stars:** ~40K+ GitHub stars (LlamaIndex overall)
- **Language:** Python and TypeScript
- **MCP:** Limited
- **Key strength:** Best-in-class for RAG pipelines and document processing. Pre-built document agent templates. llama-deploy for production runtime.
- **For Atlas:** Partially relevant. Has TypeScript support and is strong for document/RAG workflows. But Atlas already has semantic search, chunked ingestion, and Supabase-backed document storage. Would only add value for specific document processing upgrades, not as a replacement framework.

### 12. BeeAI Framework (IBM)
- **What:** IBM's open-source agent framework, hosted by Linux Foundation. Both Python and TypeScript with feature parity.
- **Stars:** Growing but smaller community
- **Language:** Python AND TypeScript (full parity)
- **MCP:** Not prominently featured
- **Key strength:** Enterprise governance, audit trails, data compliance. Phoenix observability integration. Cross-implementation agent collaboration.
- **For Atlas:** Interesting. TypeScript support with feature parity is rare. Enterprise governance focus aligns with Atlas's trust/audit concerns. But smaller community, IBM-centric ecosystem, and less model flexibility.

### 13. Atomic Agents
- **What:** Minimalist, modular framework based on "atomicity" principle. Each component has single responsibility.
- **Stars:** Small (niche project)
- **Language:** Python only
- **MCP:** No
- **Key strength:** LEGO-block composability. Clean separation of concerns. Good for learning/prototyping.
- **For Atlas:** No. Python-only, small community, no production track record at scale.

---

## Comparison Matrix

| Framework | Language | Orchestration Pattern | Built-in Tools | MCP Support | Memory/Persistence | Provider Flexibility | Production Maturity | GitHub Stars | Best Use Case |
|---|---|---|---|---|---|---|---|---|---|
| **LangGraph** | Python (TS second-class) | State machine graph | Via LangChain ecosystem | Yes (adapter) | Checkpointing, cross-session | Any provider | Highest (JP Morgan, Uber) | ~24K | Complex stateful workflows |
| **CrewAI** | Python only | Role-based crews | Built-in + BYO | Yes (native) | Short/long/entity memory | Any (LiteLLM) | High (stars, not depth) | ~46K | Fast multi-agent prototypes |
| **MAF (AutoGen+SK)** | Python, C#/.NET | Graph workflows | Azure integrations | Limited | Pluggable (Redis, Neo4j) | Azure-centric | High (Microsoft backed) | ~27K (SK) | Enterprise .NET/Azure |
| **Google ADK** | Python, TS, Go, Java | Graph + dynamic routing | Google Search, Code Exec | Yes (first-class) | Auto context management | Multi (Gemini primary) | Medium (newer) | Growing | Google Cloud agents |
| **Mastra** | TypeScript (native) | Workflows + supervisor | BYO (typed) | Yes (first-class, bidirectional) | 4-tier observational | 94 providers, 3300+ models | Medium-High | ~22K | TypeScript agent apps |
| **Smolagents** | Python only | Code-as-action | HF Hub tools | Yes | Basic | Any (LiteLLM) | Medium | ~26K | Minimal code agents |
| **PydanticAI** | Python only | Agent + graph | Built-in capabilities | Yes | Durable execution | Multi-provider | Medium | ~16K | Type-safe Python agents |
| **Agno** | Python only | Teams + workflows | Built-in | Yes (first-class) | AgentOS session store | Multi-provider | Medium | ~39K | High-throughput swarms |
| **DSPy** | Python only | Pipeline compilation | None | No | None | Multi-provider | Research-grade | ~20K | Prompt optimization |
| **LlamaIndex** | Python, TypeScript | Event-driven workflows | Document tools | Limited | Workflow state | Multi-provider | High | ~40K | RAG/document agents |
| **BeeAI (IBM)** | Python, TypeScript | Multi-agent collab | 10+ provider tools | Limited | 4 memory strategies | 10+ providers | Medium | Growing | Enterprise governance |
| **Atomic Agents** | Python only | Modular composition | None | No | None | Multi-provider | Low | Small | Learning/prototyping |
| **OpenAI Agents SDK** | Python, TypeScript | Handoffs + tools | Web search, code exec | Yes (via tools) | Thread-based | OpenAI only | High (OpenAI backed) | ~19K | OpenAI-native apps |
| **Anthropic Agent SDK** | Python, TypeScript | Tool use loop | Computer use, MCP | Yes (native) | BYO | Anthropic only | High (Anthropic backed) | ~5K | Claude-native agents |
| **Claude Code CLI** | N/A (runtime) | Full agent runtime | 30+ built-in | Yes (native) | Full persistence | Anthropic (Claude) | Production (Atlas proof) | N/A | What Atlas runs on |

---

## The Key Question: What's Genuinely Worth Considering?

### Atlas's Specific Requirements:
1. **24/7 Telegram bot** -- needs persistent process, not request/response
2. **Windows 11** -- must run natively, not just "technically works"
3. **TypeScript/Bun** -- full stack is TS, no Python rewrite acceptable
4. **30+ custom tools** -- filesystem, shell, web, MCP, CRM, analytics, clinical
5. **MCP servers** -- integrated with multiple MCP server providers
6. **Persistent processes** -- not serverless, not request/response
7. **Supabase backend** -- deep integration with memory, tasks, metrics, ledger
8. **Med-spa domain** -- HIPAA-adjacent, clinical protocols, patient data
9. **Custom orchestration** -- shadow council, signed ledger, trust budget, causal DAG, dream engine, procedures, DGM fork, etc.

### Ranking by Relevance to Atlas:

**1. Stay on Claude Code CLI (Current Architecture) -- RECOMMENDED**
Atlas's architecture is already more sophisticated than any off-the-shelf framework. The custom systems (shadow council, signed ledger, causal DAG, dream engine, DGM fork, trust budget, procedural memory, semantic entropy probe, etc.) represent months of domain-specific engineering that no framework provides. Claude Code CLI gives direct access to Claude's full capabilities with zero abstraction overhead. The "framework" IS Atlas itself.

**2. Mastra -- Worth Borrowing From**
The only TypeScript-first framework with production credentials. Not worth migrating to (Atlas would lose everything), but worth studying for specific patterns:
- Observational Memory (4-tier system) could inspire improvements to Atlas's memory rewriting
- `.suspend()` / `.resume()` workflow primitives are elegant
- MCP bidirectional support patterns
- Mastra Studio's visual debugging approach
- Type-safe tool definitions

**3. Google ADK -- Worth Watching**
Official TypeScript SDK, first-class MCP, multi-language. Still young. The Gemini optimization is a concern but it works with Claude too. Could become relevant if Atlas ever needs to scale beyond a single Windows machine or wants structured multi-language agent collaboration.

**4. LangGraph -- Relevant for Concepts Only**
The state machine architecture and checkpointing patterns are well-designed. The LangSmith observability platform is genuinely useful. But the TypeScript SDK is second-class, and Atlas already implements richer orchestration. Study the concepts, don't adopt the framework.

**5. Everything Else -- Irrelevant**
CrewAI, MAF, Smolagents, PydanticAI, Agno, DSPy, Semantic Kernel, Atomic Agents are all Python-only or Python-first. They're irrelevant for Atlas's TypeScript stack regardless of their other merits.

**6. BeeAI -- Edge Case**
Has genuine TypeScript parity and enterprise governance focus. Smaller community and IBM-centric. Worth a glance if Atlas ever needs Linux Foundation governance compliance, but not a practical migration target.

---

## Final Recommendation

**Don't switch frameworks. Atlas IS the framework.**

The agent framework landscape in 2026 is dominated by Python-first solutions. The TypeScript options (Mastra, Google ADK, LangGraph.js, Anthropic Agent SDK, OpenAI Agents SDK) are either too young, too opinionated toward a different provider, or provide less than what Atlas already has.

Atlas's competitive advantage is its custom-built orchestration layer that's been tuned for a specific domain over months of production use. No off-the-shelf framework provides:
- Signed ledger with ed25519 chain verification
- Shadow council with trust-weighted critics
- Causal DAG with PC-algorithm discovery
- Dream engine (SWS + REM) for overnight reflection
- World model with Chronos-Bolt forecasting
- DGM fork for autonomous self-improvement
- Procedural memory with Bayesian Thompson sampling
- Semantic entropy probe for ambiguity detection
- Derek Twin preference model

These are Atlas's moat. Switching to any framework would mean rebuilding all of it, and no framework provides any of it.

**What to adopt instead:**
1. **Concepts from Mastra:** Observational memory compression, type-safe tool schemas, bidirectional MCP patterns
2. **Concepts from LangGraph:** Formal state machine checkpointing (Atlas's checkpoint story could be stronger), LangSmith-style observability
3. **Concepts from Google ADK:** Context management (auto-filtering, summarization, lazy-loading), Task API patterns
4. **Keep watching:** Mastra and Google ADK for TypeScript ecosystem maturity. If either hits LangGraph-level production maturity in TS, they could supplement (not replace) Atlas's architecture.

The right move is to continue building Atlas as a custom agent platform while cherry-picking the best ideas from the framework ecosystem. The frameworks are converging on patterns Atlas already implements. That's validation, not a reason to switch.
