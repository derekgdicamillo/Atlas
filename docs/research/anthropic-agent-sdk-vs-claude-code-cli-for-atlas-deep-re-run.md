# Agent SDK vs Claude Code CLI for Atlas — Deep Re-Run

**Date:** May 28, 2026
**Author:** Atlas background research agent (Opus 4.8)
**For:** Derek DiCamillo
**Status:** Independent re-evaluation of `deep-research-anthropic-agent-sdk-vs-cli-for-atlas-architect.md`. I read the prior report first, then re-verified every load-bearing claim against current Anthropic docs and GitHub issues (May 2026). Where I disagree with the prior report, I say so explicitly.

---

## TL;DR

Don't migrate Atlas's main loop to the Agent SDK. **Confidence: high (~85%).** The prior report reached the same conclusion, but its central reasoning is wrong in one important way and incomplete in two others, so the *right* version of "don't migrate" looks different from what it recommended. The single biggest correction: **the Agent SDK and `claude -p` are billed identically** — same monthly credit pool, same overage rates (confirmed in Anthropic's own support article). So the June 15, 2026 billing change is **architecture-neutral**; it is not a reason to evaluate, adopt, or avoid the SDK. The prior report elevated it to "the critical factor," which conflates a real cost problem with an unrelated transport-layer decision. Second correction: migrating would **not** cost Atlas its `.claude/` ecosystem — the current SDK loads CLAUDE.md, skills, rules, settings, and hooks by default (`settingSources` matches the CLI). Third correction: in-process MCP tools (the one genuinely SDK-exclusive feature) **now exist in TypeScript**, contradicting the prior report's "Python-only," but they ship with open `server.connect is not a function` / tool-not-discovered bugs and are flagged unstable. Net: the SDK offers Atlas a cleaner programmatic surface and zero new capabilities it doesn't already have, in exchange for trading a Windows-hardened persistent process pool for a less-mature `ClaudeSDKClient` that still has an open Windows-hang bug. The cost lever Derek actually cares about (the $200 credit cap) is pulled by moving tool-less jobs onto the raw Messages API + Batch — which requires **zero** SDK adoption. Treat the billing audit and the SDK question as two separate decisions.

---

## What I changed my mind about (vs. the prior report)

The prior report is solid on the big picture (same engine, Atlas built the hard parts, hybrid is sane). But four specific claims need correcting or sharpening, and they change the shape of the recommendation:

| # | Prior report said | Current evidence says | Why it matters |
|---|---|---|---|
| 1 | "The critical factor is the June 15 billing change" — framed as the reason to evaluate architecture | `claude -p` and Agent SDK draw from the **same** credit pool at **identical** rates (Anthropic support article, confirmed May 2026) | Billing is **neutral** between CLI and SDK. It cannot be a migration driver. It's a real cost problem, but decoupled from this decision. |
| 2 | Migrating loses "skills auto-loading, rules, hooks, plan mode, the whole `.claude/` ecosystem" | SDK default `settingSources` loads user/project/local settings, CLAUDE.md, skills, and custom commands — "matching the CLI" (migration guide) | The ecosystem **survives** a migration. The real loss is subtler: the SDK's *default system prompt* changed to minimal in v0.1.0, so you must opt back into `preset: "claude_code"`, then re-validate behavior. |
| 3 | In-process MCP tools are "Python-only (not yet available in TypeScript)" | `createSdkMcpServer` + `tool` are exported from `@anthropic-ai/claude-agent-sdk` for TypeScript today | The one SDK-exclusive advantage is real in TS — but it's **unstable** (open bugs: `server.connect is not a function`, tools not discovered). Not production-ready as of May 2026. |
| 4 | Implied CLI may get deprecated / "community drift" risk | Anthropic explicitly **split** the docs: Agent SDK under the API Guide, "Claude Code docs now focus on the CLI tool and automation features" | CLI is **not** being sunset. Both are first-class. The future-proofing argument for migrating is weaker than the prior report implied. |

Everything else in the prior report (12s cold start is real and still the SDK's top open perf issue; the harness is the value, not the loop; Atlas has already built the 2,200–4,500h of platform layers) I independently re-verified and agree with.

---

## 1. What the Agent SDK gives that the CLI doesn't — and whether Atlas needs it

The SDK is the renamed Claude Code SDK (`@anthropic-ai/claude-code` → `@anthropic-ai/claude-agent-sdk`, TS package now `^0.2.0`). It spawns the same Claude Code binary as a subprocess and talks JSON-lines over stdio — **architecturally identical to what `relay.ts` and `persistent-process.ts` already do by hand.** So the question isn't "what can the SDK do that the CLI can't" (almost nothing — same engine), it's "does the SDK's *programmatic surface* buy Atlas anything its tag-based relay doesn't already provide."

What the SDK genuinely adds over hand-spawning `claude -p`:

1. **`maxBudgetUsd` as a first-class query parameter.** Genuinely nice for the $5-capped code agents and night-shift workers. Atlas currently enforces budget caps in its own supervisor; this would move the cap into the engine. **Marginal win** — Atlas already has the cap.
2. **`canUseTool` dynamic permission callback (in-process).** Replace some shell-hook permission logic with TypeScript. But Atlas already has `tool-gate.ts` doing pre-dispatch invariant enforcement in-process. **Redundant with existing infra.**
3. **Typed async message iterator** instead of raw NDJSON parsing. Here's the crux: **Atlas's entire orchestration model reads the assistant's final *text* and regexes it for `[TAG:]` patterns.** A typed message stream doesn't help that — you still pull `message.content` text and run the same tag parser. The SDK's headline "type safety" advantage is **largely wasted on Atlas's design.**
4. **In-process MCP tools (`createSdkMcpServer`/`tool`).** The only real capability the raw CLI can't match — custom tools as in-process TS functions instead of a separate MCP server process. **But unstable in TS today** (open issues #12 / claude-code #7279). This is the one thing worth revisiting later.
5. **Programmatic `AgentDefinition` subagents** instead of `.claude/agents/*.md` or CLI flag strings. Cosmetic for Atlas — it already dispatches subagents via tags + CLI spawns.

**Verdict:** Atlas's tag-based relay already *is* its orchestration layer. The SDK's programmatic conveniences mostly duplicate machinery Atlas built (budget caps, tool gating, supervision) or address a parsing problem Atlas doesn't have (typed streams vs. its text-tag design). The only non-duplicative item — in-process tools — isn't production-ready in TS. **Atlas does not currently need anything the SDK uniquely offers.**

---

## 2. What Atlas would lose (the honest, corrected version)

The prior report over-claimed here. Let me be precise about what actually breaks vs. survives.

**Survives a migration (contrary to prior report):**
- **CLAUDE.md, SOUL.md, IDENTITY.md, etc.** — loaded via default `settingSources`.
- **Skills (`.claude/skills/`), rules (`.claude/rules/`), custom commands** — loaded via default `settingSources` ("matching the CLI").
- **Hooks (`.claude/settings.json`, including `pre-compact-snapshot.sh` / `post-compact-verify.sh`)** — file-based hooks still fire under default settings; the SDK *also* adds programmatic `HookMatcher` callbacks on top.
- **The `[TAG:]` relay-parsing pattern** — application layer, transport-agnostic.
- **Every tag-driven Atlas Prime subsystem** — ledger, tool-gate, council, marketplace, joint protocol, replay harness, trust budget, etc. These operate on relay's tag parsing and tool dispatch. They don't care whether the bytes came from a hand-spawned CLI or `ClaudeSDKClient`. **They do not break.**

**Actually at risk (the real losses):**
- **The default system prompt.** SDK v0.1.0 stopped using Claude Code's system prompt by default; you must pass `systemPrompt: { type: "preset", preset: "claude_code" }` to restore CLI-equivalent behavior (skill auto-invocation cadence, tool-use conventions, plan mode). This is a *behavioral* change that would require re-validating Atlas's skill-triggering and tag-emission reliability across every persona and subsystem. Not a code line — a re-validation project.
- **`persistent-process.ts` → `ClaudeSDKClient`.** This is the one component the SDK directly *replaces* rather than wraps. And `ClaudeSDKClient` has an **open Windows-hang-on-initialization bug** (Python issue #208; the TS persistent path is less battle-tested than Atlas's pool). Atlas runs on Windows 11. You'd be swapping a hardened, watchdog-backed, exponential-backoff, `--resume`-aware pool for a younger abstraction with a known platform-specific failure mode — for no capability gain.
- **Fine-grained CLI flag control** (`--append-system-prompt`, exact `--allowedTools` strings, persona injection) — mostly exposed in the SDK, but parity must be verified flag by flag, not assumed.

**Net:** Very little *breaks*. The prior report's "you'd lose the `.claude/` ecosystem" is wrong. The honest cost is a **behavioral re-validation tax** (system-prompt preset + skill/tag reliability across 40+ subsystems) plus **regression risk on the Windows persistent process** — paid for zero new capability.

---

## 3. Billing / cost — and why it's the wrong axis for this decision

This is where I most strongly diverge from the prior report.

**Verified facts (Anthropic support article + The New Stack, May 2026):**
- From **June 15, 2026**, `claude -p` and Agent SDK usage **stop counting against your Claude plan's interactive usage limits** and instead draw from a **separate monthly Agent SDK credit**.
- Credit by tier: Pro $20, **Max 5x $100, Max 20x $200**, Team Standard $20 / Premium $100, Enterprise $20 or $200.
- The credit covers **all** of: Agent SDK projects (Python *or* TypeScript), the `claude -p` command, GitHub Actions, and third-party apps on the SDK.
- **`claude -p` and the Agent SDK are billed identically** — both consume the credit first, both then flow to usage credits at standard API rates (only if usage credits are enabled; otherwise requests stop until the cycle refreshes). Credits don't roll over.
- API rates (verified, pricing page): Opus tier **$5 / $25** per MTok (in/out), Sonnet 4.6 **$3 / $15**, Haiku 4.5 **$1 / $5**. Prompt caching ~90% off cached input; Batch 50% off.

**The implication the prior report missed:** Atlas is on Max 20x → **$200/mo Agent SDK credit.** Whether Atlas runs on the CLI or the Agent SDK, **the bill is byte-for-byte the same** because they're the same metered engine drawing the same credit. Migrating to the SDK changes the monthly cost by **$0.00.**

So the billing change is a genuine and urgent problem — but it's a **consumption** problem, not an **architecture** problem. The prior report's own consumption estimate ($395–825/mo against a $200 credit) is the thing to act on, and the lever has nothing to do with the SDK:

- **Move tool-less jobs off the Claude Code engine entirely** onto the raw Messages API (`@anthropic-ai/sdk`): content critic, Haiku classifiers, staleness sentinel, model-router complexity estimates, shadow-Atlas scoring, replay-harness judging. These are prompt→response with no built-in tools; they pay the engine tax (and the credit) for nothing. Raw API calls bill against normal API credits, not the $200 Agent-SDK pool — **and you can do this from inside the current CLI architecture today.**
- **Batch the overnight pipelines** (night shift, DGM fork, dream engine, weekly memo) for 50% off — async-tolerant by design.
- **Lean on prompt caching** in the persistent pool: CLAUDE.md + SOUL.md + IDENTITY.md + rules is ~10K+ tokens that should cache across turns. This is *more* available on the persistent CLI pool than on stateless `query()`.
- **Audit before optimizing.** Add real per-model token tracking to every `claude` spawn so the $395–825 estimate becomes a measured number.

**Bottom line on cost:** Decouple it from the SDK question. The credit cap is real and June 15 is close, but you fix it by moving work *off* the agent engine, not by changing which wrapper calls the agent engine.

---

## 4. Migration cost, risk, and the Bezos Type 1/2 framing

**Code cost:** Genuinely small — the prior report's "3–5 days, a re-wiring not a rewrite" is right. It's `relay.ts` + `claude.ts` + `persistent-process.ts` swapping transport. The application layer (Supabase, cron, memory, metrics, all the tag handlers) is untouched.

**The real cost is not code — it's re-validation and regression risk:**
- Re-verifying skill auto-invocation and `[TAG:]` emission reliability across both personas and 40+ subsystems under the new minimal-default system prompt.
- Replacing a Windows-hardened persistent pool with `ClaudeSDKClient`, which has an open Windows init-hang bug.
- Absorbing pre-1.0 SDK churn (v0.1.0 already shipped breaking changes — system-prompt default, `settingSources` default flip-flop, `ClaudeCodeOptions`→`ClaudeAgentOptions`). The CLI flag surface is more stable.

**Type 1 or Type 2?** Mechanically **Type 2 (reversible)** — it's a transport swap behind a `git revert`. But operationally it has **Type-1 stickiness**: once you've re-validated 40 subsystems against SDK behaviors and torn out `persistent-process.ts`, rolling back is a second re-validation, not a checkout. The decision *deserves Type-1 caution even though it's technically Type-2.* The Bezos-correct move for a reversible-but-sticky decision with **zero upside** today is: **don't walk through the one-way-ish door for nothing.** Wait until there's a concrete capability you want on the other side.

---

## 5. The hybrid option — evaluated, and narrowed

The prior report's hybrid table is directionally right but **conflates two unrelated moves**: (a) cost optimization via raw API, and (b) Agent SDK adoption. Separate them, because (a) is pure win with no SDK involved, and (b) is the actual question.

**Move A — cost optimization (do this; no SDK):**
| Workload | Today | Move to | Why |
|---|---|---|---|
| Interactive Telegram | CLI persistent pool | **Keep** | Battle-tested, no cold start, prompt-cache reuse |
| Sub-agents / code agents | CLI spawns | **Keep** (add token tracking) | Works; same credit pool either way |
| Content critic, Haiku classifiers, staleness sentinel, shadow-Atlas scoring, replay judging | CLI spawns | **Raw Messages API** | No tools needed; off the credit pool; 1–3s not 12s; cheaper |
| Night shift / DGM / dreams / weekly memo | CLI spawns | **Raw API + Batch (50% off)** | Async-tolerant |

**Move B — Agent SDK adoption (defer; pilot only when a trigger fires):**
The *only* place the Agent SDK itself (not raw API) earns its keep for Atlas is **in-process MCP tools**, and those are unstable in TS today. So adopt the SDK for **zero subsystems now.** If/when you do pilot it, do it on **one bounded, non-critical dispatcher** — e.g., the code-agent runner — to get `maxBudgetUsd` + typed streams in a place where a regression doesn't touch the Telegram main loop. Never pilot it on `relay.ts`/`persistent-process.ts` first; that's the highest-stakes, Windows-fragile component.

This is a sharper hybrid than the prior report's: **the cost win is real and SDK-free; the SDK adoption is deferred to a specific capability trigger.**

---

## 6. Recommendation

**Don't migrate the main loop to the Agent SDK. Confidence: high (~85%).**

Concretely, in priority order:

1. **Treat billing and architecture as two separate decisions.** They are not coupled. (Highest-leverage correction to the prior analysis.)
2. **Before June 15:** instrument real per-model token tracking on every `claude` spawn; enable usage credits as a backstop so requests don't hard-fail at the cap.
3. **Cost (SDK-free):** move tool-less jobs to raw `@anthropic-ai/sdk`; Batch the overnight pipelines; verify prompt caching is actually hitting on the persistent pool.
4. **Keep the CLI** for the interactive loop and sub-agents. It is not deprecated; Anthropic split the docs but maintains both.
5. **Defer the Agent SDK.** Adopt it for zero subsystems today. Re-evaluate when **any one** of these triggers fires:
   - TS in-process MCP tools (`createSdkMcpServer`) go stable (issues #12 / claude-code #7279 closed), **and** Atlas has a high-traffic tool currently paying separate-MCP-process overhead.
   - The SDK ships **daemon/hot-process mode** (issue #34), killing the 12s cold start and matching the persistent pool's reliability on Windows.
   - The `ClaudeSDKClient` Windows init-hang (issue #208) is fixed and the persistent client reaches v1.0-grade stability.
   - Anthropic ships a programmatic-only capability (durable execution, native multi-agent teams) Atlas genuinely wants and the CLI doesn't get.
6. **If you ever do adopt it:** pilot on the code-agent dispatcher with `maxBudgetUsd`, not on the relay.

---

## 7. Strongest counter-argument to my own recommendation

*The honest case for migrating anyway:*

Atlas's stated identity is a self-evolving system that stays on the frontier — and the frontier of programmatic agent-building is unambiguously the SDK, not CLI flags. Anthropic split the docs precisely to position the Agent SDK as *the* way to build agents in code; the CLI docs now read as "a terminal tool + automation." Every forward-looking primitive — `maxBudgetUsd`, `canUseTool`, in-process tools, typed streams, and whatever durable-execution / daemon-mode / agent-teams features land next — will appear in the SDK **first**, and some will never be exposed as CLI flags at all. Atlas is a 40-subsystem agent *platform* whose permanent foundation is currently a hand-rolled string-flag CLI spawner with bespoke NDJSON parsing — arguably the *more* fragile long-term bet. Building a thin SDK adapter now (even while keeping the CLI as the live path) is cheap insurance: it forces the codebase to stop assuming CLI-flag semantics, surfaces the system-prompt-preset and `settingSources` gaps while they're small, and means that when a must-have SDK feature ships, the switch is a flag flip instead of a 40-subsystem re-validation done under time pressure. The Windows-hang and unstable-tool bugs are real today but are exactly the kind of pre-1.0 issue that gets fixed on Anthropic's timeline, not Atlas's — and waiting until they're fixed to *start* learning the SDK means Atlas is always one release behind its own toolchain. The counter-argument, in one line: **"no capability gain today" optimizes for this month; a self-improving platform should optimize for which interface it wants to be fluent in for the next two years — and that's the SDK.**

*Why I still land on "don't migrate":* This argument justifies **building a thin SDK adapter and piloting one subsystem**, which my recommendation already endorses on a capability trigger. It does **not** justify migrating the Windows-fragile main loop now for zero current benefit. The frontier argument is about *optionality*, and optionality is preserved by the deferred-pilot path without paying the re-validation-and-regression tax today. If Derek weights "stay fluent in Anthropic's primary interface" very highly, the right expression of that is: build the adapter this quarter, keep the CLI live, and run the code-agent dispatcher through the SDK as a learning pilot — not flip `relay.ts`.

---

## Sources (verified May 28, 2026)

- [Use the Claude Agent SDK with your Claude plan — Anthropic Support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) — credit tiers, June 15 2026 effective date, identical `claude -p` / SDK billing, overage behavior
- [Anthropic splits billing again: Agent SDK gets separate credit pools — The New Stack](https://thenewstack.io/anthropic-agent-sdk-credits/)
- [Migrate to Claude Agent SDK — Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/migration-guide) — rename, package `^0.2.0`, default system-prompt change, `settingSources` loads `.claude/` ecosystem, CLI not deprecated
- [Agent SDK reference (TypeScript) — Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/typescript) — `createSdkMcpServer` signature, in-process tools in TS
- [Give Claude custom tools — Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
- [Claude API Pricing — Claude API Docs](https://platform.claude.com/docs/en/about-claude/pricing) — Opus $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5; caching ~90%, Batch 50%
- [PERFORMANCE: query() ~12s overhead, no hot process reuse — TS SDK issue #34](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34) — confirmed still open, top production-viability issue
- [createSdkMcpServer() returns object without connect() — TS SDK issue #12](https://github.com/anthropics/claude-agent-sdk-typescript/issues/12) — in-process tools unstable in TS
- [In-process MCP servers bug in TypeScript SDK — claude-code issue #7279](https://github.com/anthropics/claude-code/issues/7279) — tools not discovered
- [ClaudeSDKClient hangs on Windows during initialization — Python SDK issue #208](https://github.com/anthropics/claude-agent-sdk-python/issues/208) — persistent-client Windows risk
- Prior report: `deep-research-anthropic-agent-sdk-vs-cli-for-atlas-architect.md` (repo root), read in full and re-evaluated above
