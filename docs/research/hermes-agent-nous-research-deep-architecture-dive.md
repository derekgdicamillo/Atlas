# Hermes Agent by Nous Research — Deep Architecture Dive

**Date:** 2026-05-21
**Context:** Research for Atlas comparison — understanding what Hermes does differently or better for self-evolving agent systems.

---

## 1. Architecture Overview

### Core Identity

Hermes Agent is an open-source (MIT), self-improving AI agent released by Nous Research on February 25, 2026. Written in Python (~9,200 lines primary module), it's designed as a personal learning agent — not a team ops platform, not an IDE pair-programmer. The tagline is "the agent that grows with you."

As of May 2026: 140,000+ GitHub stars, ~1,000 contributors, most-used agent on OpenRouter. Releases every 6-9 days (currently v0.14.0). Backed by Paradigm + a16z.

### Core Loop

The `AIAgent` class in `run_agent.py` orchestrates a synchronous conversation engine:

```
User input → prompt assembly → provider resolution → API call → tool dispatch loop → response display → DB save
```

Two entry points:
1. **CLI/TUI**: `HermesCLI.process_input()` → `AIAgent.run_conversation()`
2. **Gateway**: Platform event → adapter.on_message() → `MessageEvent` → `GatewayRunner._handle_message()` → user auth → session resolution → AIAgent instantiation → response delivery

### State Management

SQLite-based persistence via `hermes_state.py` with FTS5 full-text search. Sessions track lineage (parent/child relationships across compressions), maintain per-platform isolation, use atomic writes with contention handling.

### Provider Abstraction

Shared runtime resolver maps `(provider, model)` tuples to `(api_mode, api_key, base_url)`. Handles 20+ providers, OAuth flows, credential pools, and alias resolution. Three API modes: `chat_completions`, `codex_responses`, `anthropic`. Switch with `hermes model` — no code changes.

### Tool Dispatch

`tools/registry.py` maintains 70+ tools across ~28 toolsets. Each tool self-registers at import time. `model_tools.py` handles schema collection and dispatch. Toolsets are grouped (web, terminal, file, browser, vision, image_gen, code_execution, delegation) and can be enabled/disabled per platform.

### Context Compression

`context_compressor.py` summarizes middle turns when token thresholds are exceeded. Prompt caching via Anthropic breakpoints in `prompt_caching.py`. Context files (`.hermes.md`, `AGENTS.md`, `CLAUDE.md`, `SOUL.md`) auto-discovered.

---

## 2. Self-Improvement Mechanism (GEPA)

### What Is GEPA?

GEPA = **Genetic-Pareto Prompt Evolution**. It's a reflective prompt optimizer that evolves text (skills, prompts, tool descriptions, code) using LLM-guided mutation + Pareto selection. Published as an ICLR 2026 Oral paper (arxiv:2507.19457). Available both as `dspy.GEPA` and standalone `pip install gepa`.

**Key insight**: Instead of collapsing feedback into a scalar reward (like RL), GEPA reads full execution traces — error messages, profiling data, reasoning chains — and proposes targeted prompt improvements. This is the text-optimization analogue of a gradient.

### How GEPA Works (Step by Step)

1. **Selection**: Pick a candidate from the Pareto frontier (solutions excelling on different task subsets)
2. **Execution**: Run on a minibatch, capturing full execution traces
3. **Reflection**: An LLM (typically GPT-5 at temperature=1.0) analyzes traces to diagnose *why* failures happened
4. **Mutation**: Generate improved candidates informed by accumulated lessons from the evolutionary history
5. **Accept**: Add to pool if improved; update Pareto front
6. **Merge** (optional): System-aware merge combining strengths of two Pareto-optimal candidates that excel on different tasks

### The Pareto Frontier

Rather than converging on a single "best" prompt, GEPA maintains a Pareto frontier — the set of candidates that achieve the highest score on at least one evaluation instance. This preserves diversity. Candidates are sampled probabilistically from the frontier, balancing exploration vs. exploitation.

### Fitness Functions

LLM-as-judge with skill-specific rubrics scoring:
- Procedure adherence (0-1)
- Output correctness/usefulness (0-1)
- Conciseness within token budget (0-1)
- **Length penalty** preventing evolutionary drift toward verbosity

Metric functions return `{score: float, feedback: str}` pairs — the feedback text is the "actionable side information" (ASI) that makes GEPA's mutations targeted rather than random.

### Evaluation Pipeline (Tiered Gates)

```
pytest (100% hard gate) → TBLite fast subset (gate 2) → task-specific eval → full TBLite (gate 3) → YC-Bench (gate 4) → PR
```

Three benchmarks serve as GATES, not fitness functions:
- **TBLite**: 100 tasks, ~1-2 hours, ~$20-50. Primary regression gate.
- **TerminalBench2**: 89 tasks, Docker sandboxes, ~2-4 hours, ~$50-200.
- **YC-Bench**: 100-500 turn sessions, ~3-6 hours, ~$50-200. Multi-turn coherence check.

### Four Optimization Tiers

| Tier | Target | Risk | Status |
|------|--------|------|--------|
| 1 | Skill files (SKILL.md) | Low | ✅ Shipped |
| 2 | Tool descriptions | Low | 🔲 Planned |
| 3 | System prompt components | Higher | 🔲 Planned |
| 4 | Code implementation | Highest | 🔲 Planned |

### Performance Numbers

- +13% over MIPROv2, +20% over GRPO, with **35x fewer rollouts**
- Works with as few as 10 examples and 20-100 evaluations
- $2-10 per optimization run (no GPU needed — API calls only)
- ARC-AGI: 32% → 89% via architecture discovery
- Coding agents: 55% → 82% on Jinja tasks

### Current Limitations (Issue #38)

Phase 1 has a real architectural bug: `SkillModule` passes skill content as a runtime input, not as an optimizable component. GEPA only evolves the wrapper prompt (the `TaskWithSkill` docstring), not the actual skill procedures. The team is aware and fixing it — but it means the "skill evolution" claim is partially aspirational as of mid-May 2026.

---

## 3. DSPy Integration

GEPA is deeply integrated with DSPy (the Stanford NLP framework for programming with LLMs):

- Skills are wrapped as DSPy modules (`SkillModule`)
- Tool descriptions are DSPy Signatures
- System prompt sections are parameterized as DSPy Signatures
- GEPA ships as `dspy.GEPA` optimizer

**What DSPy provides**: The module/signature/optimizer abstraction lets GEPA treat any text component as an optimizable parameter. You define what success looks like (metric function), DSPy handles the plumbing.

**Optimization metrics** (per tier):
- **Skills**: Task completion quality, procedure adherence, output correctness, conciseness
- **Tools**: Selection accuracy (did the agent pick the right tool?), parameter accuracy
- **Prompts**: Behavioral test scenarios (60-80 per section), TBLite regression
- **Code**: pytest (100% hard gate) + bug reproduction + benchmark scores

**Fallback optimizer**: MIPROv2 (DSPy's few-shot + instruction optimizer) used when GEPA isn't the best fit for a target.

**Third engine**: Darwinian Evolver (AGPL v3, external CLI only) for code evolution — evolves Python implementations through genetic programming with test suite gating.

---

## 4. Multi-Platform Support

### Gateway Architecture

Single background process that connects to all configured platforms simultaneously. Each platform gets a dedicated adapter following a standardized pattern:

```
Platform event → adapter.on_message() → MessageEvent → GatewayRunner._handle_message() → user auth → session resolution → AIAgent → response delivery
```

### Supported Platforms (22 as of v0.14.0)

Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Home Assistant, Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, Weixin, BlueBubbles (iMessage), QQ, Yuanbao, Microsoft Teams, LINE, Google Chat, IRC, Webhook.

### How It Compares to Atlas's Relay Pattern

**Similar concept, broader execution.** Atlas uses a Telegram-specific relay (`relay.ts`) with a single persistent Claude CLI process per agent. Hermes generalizes this to N platforms via adapter pattern, but the core idea is the same: message in → agent process → response out.

Key differences:
- **Atlas**: 1 platform (Telegram), 2 personas (Atlas/Ishtar), per-agent persistent process
- **Hermes**: 22 platforms, single gateway process, per-chat session isolation
- **Atlas**: Bun/TypeScript runtime
- **Hermes**: Python runtime with `asyncio` event loop

### Session Management

- Daily reset at 4:00 AM (configurable)
- Idle timeout at 1440 minutes (configurable)
- Per-platform overrides via `gateway.json`
- Session lineage tracking across compressions
- Auto-resume after gateway restarts for interrupted sessions

### Security Model

Default-deny: all users blocked unless in allowlist or DM-paired. Environment variables per platform (`TELEGRAM_ALLOWED_USERS`, etc.) or one-time pairing codes for unknown users. Admin vs. regular user tiers with command restrictions.

### Voice & Media

Voice memo transcription and TTS replies across compatible platforms. Ten TTS providers (Edge TTS, ElevenLabs, OpenAI, MiniMax, etc.). `[[audio_as_voice]]` directive promotes audio to voice messages on Telegram/WhatsApp.

---

## 5. Deployment Model

### Seven Terminal Backends

| Backend | Use Case | Key Feature |
|---------|----------|-------------|
| **Local** | Development (default) | Direct machine execution |
| **Docker** | Security, reproducibility | Single persistent container per session, rootless |
| **SSH** | Sandboxing | Agent can't modify its own code |
| **Singularity/Apptainer** | HPC/cluster | Rootless containerization for shared systems |
| **Modal** | Serverless cloud | Scale-on-demand, hibernates when idle |
| **Daytona** | Persistent remote dev | Persistent workspace, hibernates |
| **Vercel Sandbox** | Cloud microVM | Snapshot-backed filesystem persistence |

### Local Model Support

NVIDIA partnership: runs on RTX PCs, RTX PRO workstations, DGX Spark (128GB unified memory). Ships with support for llama.cpp, LM Studio, Ollama. Recommended: Qwen 3.6 35B (~20GB memory) or 27B.

### Service Management

- **Linux**: systemd user services (`hermes gateway install`)
- **macOS**: launchd (`~/Library/LaunchAgents/`)
- **Docker**: Community-maintained compose stacks
- **Nix**: Reproducible flake-based deployments
- **Windows**: Portable bundle with 100 tools + ComfyUI

### Atlas Comparison

Atlas runs as a pm2-managed Bun process on a Windows 11 machine. Single deployment target. Hermes offers dramatically more deployment flexibility, but Atlas's single-machine simplicity is a feature for its use case (one clinic, two users).

---

## 6. Memory System

### Four-Layer Architecture

**Layer 1: Bounded System Prompt (Always Loaded)**
- `MEMORY.md`: 2,200 chars (~800 tokens) — environmental facts, conventions, learned lessons
- `USER.md`: 1,375 chars (~500 tokens) — user preferences, communication style, identity
- Frozen snapshot injection — captured once at session start, never changes mid-session (preserves prefix caching)

**Layer 2: Session Storage (SQLite + FTS5)**
- Full conversation history in `~/.hermes/state.db`
- FTS5 full-text search across all past interactions
- Session lineage tracking (parent/child across compressions)
- Cross-session recall via `session_search` tool

**Layer 3: Autonomous Skill Memory (Procedural)**
- Agent autonomously creates, patches, and deletes skills via `skill_manage` tool
- Triggered after: complex tasks (5+ tool calls), error recovery, non-trivial workflow discovery, user correction
- This IS the procedural memory — skills are the learned procedures

**Layer 4: External Memory Providers (Pluggable)**
- 8 providers: Honcho, Mem0, Hindsight, Supermemory, RetainDB, ByteRover, OpenViking, Holographic
- Each adds different capabilities (user modeling, semantic search, temporal graphs)

### Honcho: Dialectic User Modeling

The most interesting memory integration. Honcho (by Plastic Labs) adds dialectic reasoning about users:

**How it works:**
1. After each conversation turn (gated by `dialecticCadence`, default every 2 turns), Honcho analyzes the exchange
2. Multi-pass reasoning (up to 3 passes):
   - Pass 0: Initial assessment (cold-start "who is this?" or warm "what matters now?")
   - Pass 1: Self-audit identifying gaps, synthesizing evidence from recent sessions
   - Pass 2: Reconciliation checking for contradictions, producing final synthesis
3. Derived insights stored as searchable conclusions
4. Two-layer context injection into every turn:
   - **Base context**: "who is this user" — session summary, user representation
   - **Dialectic supplement**: "what matters right now" — LLM-synthesized reasoning about current state

**Three control knobs:**
- `contextCadence` (default 1): turns between base layer refreshes
- `dialecticCadence` (default 2): turns between dialectic LLM calls
- `dialecticDepth` (default 1-3): multi-pass depth per invocation

### Memory Consolidation (The Bounded Bet)

Hermes forces memory into hard character limits (2,200 + 1,375 chars). When full, the agent must consolidate or replace entries. This is a deliberate architectural choice — forced consolidation produces more coherent user models than unbounded accumulation.

User reports: 40% speedup on repeated research tasks after 2-3 weeks. The agent develops a "working theory" of the user through forced consolidation.

---

## 7. Comparison to Atlas

### What Hermes Does That Atlas Doesn't

| Feature | Hermes | Atlas |
|---------|--------|-------|
| **Multi-platform gateway** | 22 platforms from one process | Telegram only |
| **GEPA prompt evolution** | Reflective trace analysis + Pareto selection | DGM Fork: Opus mutation + replay-harness scoring |
| **DSPy integration** | Full optimizer framework integration | None (custom mutation pipeline) |
| **Open skill ecosystem** | agentskills.io standard, 647+ community skills, Skills Hub | Custom skills, not portable |
| **Pluggable memory providers** | 8 external providers (Honcho, Mem0, etc.) | Supabase-only (custom) |
| **Terminal sandboxing** | 7 backends (Docker, SSH, Modal, etc.) | Local execution only |
| **Provider rotation** | 20+ providers, credential pools, failover | Claude-only (Anthropic API) |
| **Local model support** | llama.cpp, Ollama, LM Studio | None |
| **Skill security scanning** | Automated scanner for hub-installed skills | None |
| **Batch processing** | Hundreds/thousands of prompts | Single-task or small parallel |
| **Autonomous Curator** | Skill library maintenance (v0.12+) | Manual |
| **Checkpoints** | Automatic directory snapshots with rollback | Git-based only |
| **Multi-agent Kanban** | Durable task management board (v0.13+) | TodoWrite + text tags |
| **RL training data** | Trajectory generation for model training | None |

### What Atlas Does That Hermes Doesn't

| Feature | Atlas | Hermes |
|---------|-------|--------|
| **Causal DAG** | Explainable causal graph with 3 discovery paths (PC algo, LLM-proposed, natural-experiment), Derek-approval gate, falsification audit | Nothing comparable |
| **World Model forecasting** | Chronos-Bolt foundation forecaster + counterfactual DAG-conditioned forecasts | No forecasting |
| **Dream Engine** | SWS replays high-salience episodes with counterfactual variants + REM tomorrow scenarios validated by World Model | No dream/simulation system |
| **Derek Twin** | Stated/revealed preference model tracking gap between what users say and do, morning predictions + evening self-score | Honcho does user modeling but no stated/revealed gap tracking |
| **Shadow Council** | 3 trust-weighted critics on every patient-facing send, per-surface shadow/live mode | No multi-critic review |
| **Signed memory entries** | Per-session ed25519 keypair, every memory row signed, tampered rows excluded | No cryptographic memory integrity |
| **Trust Budget** | Per-domain trust score with 30-day half-life decay, auto-escalation | No trust scoring |
| **Ledger** | Tamper-evident ed25519-signed action log, SHA-256 chained, hourly Merkle root | No audit chain |
| **Transparency Beacon** | Public repo publishing Merkle roots with standing bounty | No public verifiability |
| **Shadow-Atlas divergence monitor** | Second process replays every prompt, Haiku scores divergence, freeze flag on alarm | No shadow monitoring |
| **Semantic-Entropy Probe** | Detects ambiguous multi-tag responses, samples k=5, computes entropy, clarifies high-entropy turns | No ambiguity detection |
| **Procedural memory with Bayesian posteriors** | Beta(α,β) posteriors per procedure, Thompson sampling for retrieval | Skills have no statistical confidence model |
| **Memory rewriting** | Stale+frequent memories get Haiku rewrite with hindsight | Memory is manually consolidated |
| **Cortex 7-tier stack** | Tiered memory with demotion pressure, multi-signal weighted, inversion at depth ≤2 | Flat 4-layer memory |
| **Soft-DPO** | Collects (original, corrected) pairs for future fine-tuning | No preference pair collection |
| **Causal natural experiments** | Detects intervention pre/post deltas, creates DAG edges | No causal inference |
| **Business-specific integrations** | GHL CRM, Meta Ads API (read+write), GBP, GA4, QuickBooks, Brevo, Microsoft Planner, care plan generator | Generic integrations only |
| **Content quality gate** | Haiku critic scores brandVoice, compliance, engagement, accuracy | No content quality scoring |
| **Show rate engine** | Tiered appointment reminders + no-show recovery | No appointment management |
| **Joint Protocol** | Atlas+Ishtar negotiation on shared-owner decisions | No multi-agent negotiation |

### Architectural Overlaps

| Concept | Atlas | Hermes |
|---------|-------|--------|
| **Self-improving skills** | DGM Fork (nightly Opus mutation + replay-harness scoring) | GEPA (reflective evolution + Pareto selection) |
| **Procedural memory** | Supabase procedures table with Beta posteriors | Skills as procedural memory (skill_manage tool) |
| **Skill creation from experience** | Skill Shadow-Routing + Self-Regenerating Skills | Autonomous skill creation after 5+ tool call tasks |
| **Nightly optimization** | Darwin Loop, DGM Fork, Dream Engine, episodic clustering | Continuous Self-Improvement Loop (Phase 5, planned) |
| **User modeling** | Derek Twin + USER.md + twin_stated_preferences | Honcho dialectic + USER.md (bounded) |
| **Memory search** | Supabase hybrid search (vector + FTS RRF) + reranker | SQLite FTS5 + LLM summarization |
| **Context files** | CLAUDE.md, SOUL.md, IDENTITY.md, USER.md | SOUL.md, MEMORY.md, USER.md, AGENTS.md, .hermes.md |
| **Sub-agent delegation** | Claude CLI subprocesses (max 8 concurrent) | Isolated child instances (3 concurrent default) |
| **Content generation** | Content Waterfall + Content Critic | No built-in content pipeline |
| **Cron scheduling** | pm2 cron jobs | Built-in cron scheduler (60s tick) |

---

## 8. Ideas to Steal

### High-Value, Low-Effort

1. **Bounded memory forcing consolidation.** Atlas's memory is unbounded (Supabase rows accumulate). Hermes's 2,200+1,375 char hard limits force the agent to distill what matters. User reports show 40% speedup on repeated tasks. Atlas could add a "distilled context" layer — a forced-small summary updated nightly.

2. **Skill progressive disclosure (3-tier loading).** Hermes loads skills in three tiers: metadata only (~3k tokens) → full content → reference files. Atlas loads all skill content when matched. Adopting progressive disclosure would reduce prompt bloat.

3. **Pluggable memory providers.** Honcho's dialectic user modeling is genuinely better than Atlas's Derek Twin for understanding *why* users behave the way they do. The multi-pass reasoning (assessment → self-audit → reconciliation) is more rigorous than Twin's stated/revealed gap tracking. Consider integrating Honcho alongside the existing Supabase memory.

4. **Skill security scanner.** Hermes scans hub-installed skills for data exfiltration, prompt injection, destructive commands. Atlas has tool-gate.ts for action invariants but no skill-level scanning.

5. **Session lineage tracking.** Hermes tracks parent/child relationships across compressions. Atlas loses this context — the compact-snapshot.md is a manual workaround for what Hermes handles structurally.

### Medium-Value, Medium-Effort

6. **GEPA for skill evolution.** Replace or augment DGM Fork's Opus mutation with GEPA's reflective trace analysis. GEPA's key advantage: it reads *why* things fail, not just *that* they failed. The Pareto frontier preserves specialists rather than converging on one "best" variant. Cost: $2-10 per run vs. DGM's ~$3/night cap — comparable.

7. **Autonomous Curator.** Hermes v0.12 added automatic skill library maintenance — deduplication, pruning, consistency checking. Atlas's skill library grows organically without cleanup. A nightly curator pass would help.

8. **agentskills.io compatibility.** Making Atlas skills compatible with the agentskills.io standard would let you pull from the 647+ community skill ecosystem. The format is close to what Atlas already uses (SKILL.md + frontmatter).

9. **Multi-agent Kanban board.** Hermes v0.13 added durable task management with board visualization. Atlas uses TodoWrite + text tags which is fragile. A proper task persistence + board view would improve multi-agent coordination.

### High-Value, High-Effort

10. **DSPy integration for prompt optimization.** DSPy provides the module/signature/optimizer abstraction that makes GEPA, MIPROv2, and other optimizers plug-and-play. Atlas's custom mutation pipeline (DGM Fork) works but lacks the framework-level composability. DSPy would require a Python dependency but opens up the full optimizer ecosystem.

11. **Terminal sandboxing.** Atlas runs everything locally with full machine access. Docker or SSH backends for code agents would provide security isolation for untrusted tasks.

12. **Provider rotation with failover.** Atlas is Claude-only. Adding OpenRouter or a provider abstraction layer would enable model diversity, cost optimization, and graceful failover on API issues.

---

## 9. Community & Ecosystem

### Who's Behind It

**Nous Research** — the collective behind the Hermes model family (fine-tuned LLMs) and the Psyche decentralized training stack. Key figure: Teknium (co-founder, 179 PRs in v0.8 alone). Backed by Paradigm + a16z (announced April 2026).

### Growth Trajectory

| Date | Stars | Contributors |
|------|-------|-------------|
| Feb 25, 2026 | Launch | — |
| Mar 11 | 22,000 | 242 |
| Apr 11 | 57,200 | 274+ |
| May 16 | 140,000+ | ~1,000 |

Release cadence: every 6-9 days. Each release: hundreds of PRs, dozens of issues closed. v0.14.0 alone: 808 commits, 633 merged PRs, 545 issues closed.

### Ecosystem Scale

- 80+ community projects tracked on hermesatlas.com
- 647+ community skills
- 8 memory providers
- 22 messaging platforms
- 134K+ stars across ecosystem
- Notable community projects: Mission-Control (3.7K stars, multi-agent fleet orchestration), camofox-browser (4K stars, stealth headless browser), Hindsight (8.4K stars, long-term memory)

### Skill Ecosystem Partners

- Vercel Labs: official `agent-skills` library
- Black Forest Labs: FLUX image generation skills
- Anthropic: 754-skill cybersecurity collection (MITRE ATT&CK, NIST CSF 2.0, D3FEND mapped)
- wondelai: 380+ cross-platform agent skills

### Contribution Model

MIT licensed. Open PRs on GitHub. Community Discord for coordination. Maturity tags (production/beta/experimental) on ecosystem projects. `awesome-hermes-agent` curated list maintained by community.

### Competitive Positioning

The ecosystem report (April 2026) positions three tools as complementary:
- **Claude Code**: IDE pair-programming (proprietary)
- **OpenClaw**: Team operations platform (22+ channels, 5,700+ skills marketplace)
- **Hermes Agent**: Personal learning agent (22 channels, autonomous skill generation, bounded memory)

---

## 10. Bottom Line

### Where Hermes Is Ahead

**Ecosystem and extensibility.** 22 platforms, 7 backends, 8 memory providers, 20+ model providers, 647 community skills, agentskills.io standard. Hermes is a platform; Atlas is a bespoke system.

**GEPA is more principled than DGM Fork.** Reflective trace analysis + Pareto frontier is a more rigorous optimization approach than Opus-generate-and-score. The ICLR Oral acceptance validates the method. The 35x fewer rollouts claim is significant.

**Bounded memory is an underrated design choice.** Forced consolidation produces better user models than unbounded accumulation.

### Where Atlas Is Ahead

**Trust and safety infrastructure.** Signed memory, ledger, Merkle roots, transparency beacon, shadow monitoring, semantic entropy, trust budget — Atlas has a security/verification stack that Hermes doesn't attempt. For a medical practice handling patient data, this matters.

**Causal reasoning.** The Causal DAG + World Model + Dream Engine stack gives Atlas genuine reasoning about *why* business metrics change and *what would happen if*. Hermes has no equivalent.

**Preference modeling.** Derek Twin tracks the gap between stated and revealed preferences with morning predictions and evening self-scoring. This is a more rigorous feedback loop than Honcho's dialectic modeling (which is good at understanding users but doesn't track preference drift).

**Domain specialization.** Atlas is built for one business with deep integrations (GHL, Meta Ads, QuickBooks, GBP, care plans). Hermes is general-purpose by design.

### The Honest Assessment

Hermes is broader; Atlas is deeper. Hermes wins on reach, ecosystem, and principled prompt optimization (GEPA). Atlas wins on trust infrastructure, causal reasoning, and domain-specific intelligence. The overlap is in the self-improvement loop — both systems learn from experience and refine their skills/prompts, but through different mechanisms.

The most actionable takeaway: integrate GEPA (or at least its Pareto frontier concept) into Atlas's DGM Fork pipeline, adopt bounded memory consolidation, and make skills agentskills.io-compatible to tap the community ecosystem.
