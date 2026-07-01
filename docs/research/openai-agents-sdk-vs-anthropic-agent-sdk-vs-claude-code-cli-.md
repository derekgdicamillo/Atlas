# Three-Way SDK Re-Run for Atlas: OpenAI Agents SDK vs Anthropic Agent SDK vs Claude Code CLI

**Date:** May 28, 2026
**Model:** Opus 4.8 (independent re-evaluation)
**Audience:** Derek DiCamillo (Atlas owner/operator)
**Prior report:** `deep-research-openai-agents-sdk-vs-anthropic-agent-sdk-vs-cl.md` (read and re-verified)
**Atlas profile:** Bun/TypeScript multi-agent system on Windows 11, two personas (Atlas/Ishtar) over Telegram, persistent Claude CLI process pool, ~40 subsystems depending on `.claude/` skills/rules/hooks + MCP, Max-plan OAuth billing.

---

## TL;DR

**Stay on the Claude Code CLI — but the ground shifted under the prior report, and the shift is about money, not features.**

The single most important new fact since the last write-up: **Anthropic's June 15, 2026 billing split removes `claude -p` (the exact mechanism Atlas runs on) from the Max subscription pool and moves it to a separate, dollar-denominated "Agent SDK credit" — $200/mo on Max 20x, then standard API rates on overage** ([The New Stack, May 2026](https://thenewstack.io/anthropic-agent-sdk-credits/); [Claude Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). Atlas's previous "the Max plan covers everything for a flat $200" advantage is **largely gone** for its automated/headless workload. This is the thing to act on, and it is independent of which SDK you pick.

Ranked recommendation for Atlas:

1. **Claude Code CLI (status quo) — keep as the runtime.** Nothing else gives Atlas local-machine filesystem/shell tools, the `.claude/` ecosystem, auto-compaction, and prompt caching in one package. The 40-subsystem dependency on skills/rules/hooks makes switching a multi-month rewrite for marginal gain.
2. **Anthropic Agent SDK (TypeScript) — the natural migration target if/when you outgrow the CLI.** Same engine, same tools, same `.claude/` ecosystem, native to your Bun/TS stack, no subprocess-of-a-binary indirection. Worth piloting now for *new* subsystems. Same billing exposure as the CLI after June 15.
3. **OpenAI Agents SDK (TypeScript) — do not switch; mine it for patterns.** Its April 2026 overhaul (sandboxes, subagents, code mode) narrowed the tooling gap, but the headline features are **Python-first**, its sandboxes are **cloud containers** (wrong shape for a bot that drives pm2/OneDrive/local files on Derek's Windows box), and adopting it means rebuilding the entire `.claude/` substrate. Its genuinely-better ideas — declarative handoffs, first-class guardrails, built-in tracing, provider flexibility — should be **stolen and implemented on top of Claude**, which is essentially what Atlas's tag relay already does in hand-rolled form.

**The honest answer to "does Atlas's tag relay already replicate these SDKs?"** Yes — about 70% of it. The relay + tool-gate + Shadow Council + ledger already implement tool dispatch, handoff-style routing, guardrails, and tracing. What it lacks vs. the SDKs is *declarative typing, provider abstraction, and standardized observability* — not capability. You built a bespoke version of the OpenAI SDK's control plane without realizing it.

---

## What changed since the prior report (the parts that actually matter)

The prior report (same date) was directionally correct but predated or under-weighted three current-state facts. Re-verified against current docs:

### 1. Anthropic billing split — June 15, 2026 (the headline)

Announced May 14, 2026; effective June 15, 2026. The Agent SDK, **`claude -p`**, Claude Code GitHub Actions, and all third-party agent apps are **removed from the subscription usage pool** and migrated to a separate, independently-billed **"Agent SDK credit pool"** denominated in dollars at standard API rates ([codersera](https://codersera.com/blog/anthropic-june-2026-billing-change-claude-code/); [eWeek](https://www.eweek.com/news/anthropic-claude-agent-sdk-monthly-credits/)).

| Plan | Agent SDK credit / mo |
|------|----------------------|
| Pro | $20 |
| Max 5x | $100 |
| **Max 20x** | **$200** |

Credits are **per-user, non-transferable, no rollover**, refresh on billing cycle ([The New Stack](https://thenewstack.io/anthropic-agent-sdk-credits/)).

**Why this is decisive for Atlas:** Atlas does NOT run as an interactive human-at-terminal CLI session. It runs a **persistent `claude -p` process pool** (headless, programmatic). That is precisely the usage class that moves to the metered credit pool. Interactive CLI use stays on the subscription; Atlas's automated use does not.

The prior report estimated Atlas's all-in workload at **~$660/mo at API rates**. A $200 Max-20x credit covers roughly a third of that; the rest bills at standard API rates (or stops when the credit is exhausted, depending on how you configure overage). **The "$200/mo Max plan, budget is not a concern" assumption no longer holds for Atlas's automated load.** This is the action item regardless of SDK choice.

> Note: This same billing exposure applies to the Anthropic Agent SDK too (it's the same `claude -p`-class usage). So billing is **not** a reason to prefer CLI over the Anthropic SDK — they're identical there. It *is* a reason to revisit whether some workloads (cron, overnight, Shadow-Atlas Haiku) should move to the **raw Anthropic API** (batch pricing) or a **cheaper provider** entirely.

### 2. OpenAI Agents SDK "next evolution" — April 15, 2026

The largest overhaul since launch ([OpenAI](https://openai.com/index/the-next-evolution-of-the-agents-sdk/); [TechCrunch](https://techcrunch.com/2026/04/15/openai-updates-its-agents-sdk-to-help-enterprises-build-safer-more-capable-agents/); [Help Net Security](https://www.helpnetsecurity.com/2026/04/16/openai-agents-sdk-harness-and-sandbox-update/)):

- **Native sandbox execution** with Codex-style filesystem tools + shell. Bring-your-own or built-in support for Blaxel, Cloudflare, Daytona, E2B, Modal, Runloop, Vercel.
- **Long-horizon harness** with configurable memory and sandbox-aware orchestration.
- **Subagents** and **code mode** primitives.
- First-class MCP.
- Runs **100+ non-OpenAI LLMs** via the Chat Completions API (Claude, Gemini, Llama, Mistral...).

**The critical caveat the marketing buries:** *"Subagents and code mode will launch first in Python, with TypeScript support planned for a later release."* Atlas is a **TypeScript** stack. The two headline features that would matter most to Atlas are **not in the TS SDK yet** as of May 2026.

**The second caveat:** the sandboxes are **cloud/container execution environments**, not access to the local Windows machine. Atlas's job is to drive *this box* — pm2 restarts, OneDrive file copies, local `.env`, Home Assistant on the LAN, OBS over WebSocket, local Supabase calls. A Cloudflare/E2B sandbox is the wrong topology for that. This *closes the "OpenAI has no filesystem tools" gap from the prior report* but doesn't make it fit Atlas's deployment.

### 3. Anthropic Agent SDK (TS) is current and tracking the CLI

`@anthropic-ai/claude-agent-sdk` is at **v0.3.154** (parity with Claude Code v2.1.x). Recent additions: `terminal_reason` on result messages, `agentProgressSummaries` for subagents, `reloadSkills` in SessionStart hooks, a `MessageDisplay` hook, settable session titles ([changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)). It is **feature-complete relative to the CLI** because it *is* the CLI engine exposed as a library. Confirmed: "the same tools, agent loop, and context management that power Claude Code, programmable in Python and TypeScript" ([Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/overview)).

### 4. Correction to prior report: OpenAI TS *can* run Claude — via the AI SDK adapter

The prior report described Claude-via-OpenAI-SDK using **LiteLLM** (a Python path). The current **TypeScript** path is the beta `@openai/agents-extensions/ai-sdk` adapter, which wraps a Vercel AI SDK model (`@ai-sdk/anthropic`) so an OpenAI `Agent` can run on Claude ([OpenAI Agents JS — AI SDK extension](https://openai.github.io/openai-agents-js/extensions/ai-sdk/)). It works, it's **beta**, and OpenAI itself says to prefer the native provider for OpenAI models. So the answer to "would switching to OpenAI's SDK mean giving up Claude?" is **no, you can keep Claude** — but through a beta adapter that loses Anthropic-native features (prompt caching, extended thinking, the hosted OpenAI tools).

---

## The three options, scored for Atlas's actual use case

### Option 1 — OpenAI Agents SDK (TypeScript)

**What's genuinely better here:**

- **Declarative handoffs.** `handoffs: [billing, scheduling]` is more testable and trace-visible than Atlas's implicit "Claude decides from CLAUDE.md + relay parses tags" routing.
- **First-class guardrails.** Typed `input_guardrail` / `output_guardrail` / `tool_guardrail` validators that can use a cheap model to vet a powerful model, halting on tripwire. Atlas's Shadow Council + tool-gate already do this — but as bespoke infrastructure, not a composable primitive.
- **Built-in tracing** with 26+ integrations (DataDog, W&B, Langfuse, Phoenix) and a free dashboard that works even with non-OpenAI models. Atlas's ledger + agent-events are close but don't speak a standard format.
- **Provider flexibility** — 100+ models, mix per-agent. Genuine insurance against single-vendor pricing/quality risk.
- **Voice/Realtime agents** — production-ready today. Claude has no equivalent. Relevant only if PV MediSpa wants an AI phone receptionist.
- **Human-in-the-loop with serializable run state** — pause, serialize to JSON, approve async, resume in a different process. A clean primitive for Telegram-gated approvals.

**Why it still loses for Atlas:**

- **Headline TS features are missing.** Subagents and code mode are Python-first. Atlas's whole delegation model (background `[CODE_TASK:]` / `[TASK:]` agents) maps to subagents — not yet in TS.
- **Sandboxes are cloud containers, not the local box.** Wrong shape for a bot that administers Derek's Windows machine, OneDrive, LAN devices, and local services.
- **No `.claude/` ecosystem.** 40 skills, the rules files, the PreToolUse/PreCompact hooks, CLAUDE.md auto-loading — none exist. You rebuild all of it.
- **Claude support is a beta adapter** that forfeits prompt caching and extended thinking — the two things that make Claude cheap and good for Atlas's reasoning-heavy clinical/business work.
- **Bun DX:** `@openai/agents` is Node/Zod-based and runs on Bun, but the new sandbox/harness layer pulls in cloud-provider SDKs you don't want on a single Windows host.

**Verdict:** Best control-plane design of the three; worst fit for Atlas's deployment. Switching = rebuild 80% of the substrate to gain orchestration sugar you've largely already hand-rolled.

### Option 2 — Anthropic Agent SDK (TypeScript)

**Current state:** v0.3.154, parity with Claude Code v2.1.x. Same agent loop, same 30+ built-in tools, same MCP, same `.claude/` skills/rules/hooks/subagents, same auto-compaction. It is the CLI engine as an `npm` library.

**Why it's the right *migration* target (not switch target) for Atlas:**

- **Native to Bun/TypeScript.** Atlas currently spawns the `claude` *binary* as a subprocess and pipes NDJSON. The SDK lets you `import { query } from '@anthropic-ai/claude-agent-sdk'` and drive the loop in-process — no binary subprocess indirection, typed message streams, programmatic `canUseTool`, hooks, and agent definitions as objects instead of files.
- **Zero feature loss.** Everything the CLI gives, the SDK gives. The `.claude/` ecosystem still loads.
- **Better delegation ergonomics.** `agents: { billing: {...}, scheduling: {...} }` defined in code, `agentProgressSummaries` for live subagent status, `terminal_reason` for clean loop-exit handling — all things Atlas currently reconstructs by parsing CLI output.
- **Same billing.** Subject to the June 15 Agent SDK credit pool exactly like `claude -p`. No billing penalty vs. CLI; no billing benefit either.

**Why not switch wholesale today:** Atlas's persistent-process pool, restart/backoff, `--resume` session handling, and `sanitizedEnv` OAuth stripping are all built and battle-tested against the CLI. Re-plumbing the process pool onto the SDK is real work with no user-visible payoff. Do it incrementally — write *new* subsystems against the SDK, leave the relay on the CLI until there's a reason.

**Verdict:** The strategically correct long-term home. Same engine, better TS DX, native to your stack. Migrate opportunistically.

### Option 3 — Claude Code CLI (status quo)

**What it uniquely provides for Atlas:**

- **The whole substrate in one binary:** 30+ local-machine tools, `.claude/` skills/rules/hooks/agents, CLAUDE.md auto-loading, auto-compaction with PreCompact snapshot hooks, prompt caching, `--resume`.
- **Battle-tested integration:** persistent process pool, exponential-backoff restart, idle shutdown, OAuth env stripping — all built around the CLI's exact behavior.
- **Local-host execution** — it runs *on Derek's machine* with full access to pm2, OneDrive, LAN, local services. No container, no remote sandbox.
- **Multi-surface:** the same engine is reachable from terminal, IDE, CI — useful for your own dev loop even though Atlas itself is headless.

**Its one liability:** the June 15 billing change. `claude -p` headless usage now meters against the $200 Agent SDK credit, then API rates. This is a **runtime-economics** problem, not a CLI-vs-SDK problem (the Anthropic SDK has it too).

**Verdict:** Keep it as the runtime. It's the only option that is local-host-native, fully-featured, and already wired into 40 subsystems.

---

## Direct answers to the five key angles

**(a) Does switching to OpenAI's SDK mean giving up Claude models?**
No. The TS SDK can run Claude via the beta `@openai/agents-extensions/ai-sdk` adapter (over `@ai-sdk/anthropic`). But it's beta, and going through the adapter forfeits **prompt caching** (the ~90% repeat-system-prompt discount) and **extended thinking** — both Anthropic-native. So you keep the model, lose the economics and the depth. Net: technically yes, practically a downgrade.

**(b) Billing implications.**
- **Old framing ("Max only works with the CLI") is now wrong-ish.** Max-plan subscription billing covers *interactive* CLI use. Atlas's *headless `claude -p`* use moves to the metered Agent SDK credit ($200 on Max 20x) on June 15, then standard API rates. The Anthropic Agent SDK is in the same bucket.
- **OpenAI SDK** = pure pay-as-you-go API tokens (no subscription cushion, no SDK fee). GPT-class token pricing for Atlas's load was estimated near OpenAI ~$495/mo vs Claude ~$660/mo at API rates — but that ignores prompt-caching savings Claude gets natively and OpenAI-via-adapter loses.
- **Real takeaway:** the cost lever isn't the SDK, it's *moving cron/overnight/Shadow-Atlas workloads to batch API or a cheaper model* and reserving the $200 credit for interactive turns.

**(c) Lock-in & portability.**
OpenAI SDK is MIT and provider-agnostic — lowest lock-in *to a vendor*, but highest lock-in *to its own orchestration abstractions*. Anthropic SDK/CLI lock you to Claude models, but the `.claude/` artifacts (skills, rules, prompts) are portable plain files. Atlas's deepest lock-in is **its own tag relay + 40 subsystems**, not any SDK. Portability hedge: keep business logic (GHL, metrics, Brevo, memory) in your own TS modules — which you already do — so the agent runtime stays swappable.

**(d) Best TS DX for a Bun stack.**
Anthropic Agent SDK wins for Atlas specifically: it gives you the engine you already depend on, in-process, typed, on Bun, with the `.claude/` ecosystem intact. OpenAI's SDK has excellent TS DX in the abstract (Zod schemas, clean primitives) but its newest power features are Python-first and its sandbox model fights a single-Windows-host deployment.

**(e) Honest take: does Atlas's tag relay already replicate these SDKs?**
**Largely yes.** Map it out:

| SDK primitive | Atlas's existing equivalent |
|---|---|
| Tools / function calling | Tag parser in `relay.ts` (`[SEND:]`, `[GHL_*:]`, `[CAL_ADD:]`, `[WP_POST:]`...) |
| Handoffs / agents-as-tools | `[TASK:]` / `[CODE_TASK:]` delegation + CLAUDE.md routing |
| Input/output/tool guardrails | `tool-gate.ts` + Shadow Council (3 trust-weighted critics) + PreToolUse hooks |
| Tracing | Signed ledger + `agent-events` JSONL + task-progress |
| Sessions/persistence | Supabase-backed memory + `--resume` |
| Human-in-the-loop | Telegram approval gates, Shadow Council veto |
| Model routing | `model-router.ts` (Haiku/Sonnet/Opus) |

What the relay **lacks** that the SDKs offer: *declarative typing* (tags are string-parsed, not schema-validated), *provider abstraction* (Claude-only), and *standardized observability* (bespoke, not OpenTelemetry). You effectively reinvented the OpenAI control plane in tag form. That's not a criticism — it's why switching SDKs buys so little. The upgrade path is to make your existing relay more *declarative and typed*, not to replace it.

---

## What to do (in priority order)

1. **Handle the June 15 billing change — this is the real deadline.** Claim the Max-20x $200 Agent SDK credit before June 15. Then audit which workloads must stay on the credit (interactive Atlas/Ishtar turns) vs. which can move to **raw Anthropic API + batch pricing** (cron: midas-*, daily-scorecard, overnight content, Shadow-Atlas Haiku, replay-nightly). Moving the predictable automated load off the credit pool is the biggest cost lever you have, and it's SDK-agnostic.
2. **Keep the CLI as the runtime.** No switch. The 40-subsystem dependency is decisive.
3. **Pilot the Anthropic Agent SDK on one new subsystem.** Next time you build something net-new, write it against `@anthropic-ai/claude-agent-sdk` in-process instead of spawning the binary. Measure DX. This is the low-risk path toward eventually retiring the subprocess indirection.
4. **Steal three OpenAI patterns, implement on Claude:**
   - *Declarative guardrails* — formalize Shadow Council + tool-gate into a typed, composable validator list per action surface.
   - *Explicit routing manifest* — make persona/subagent routing a config artifact (visible, auditable) instead of implicit prompt instructions.
   - *Standardized tracing* — emit the ledger/agent-events in an OpenTelemetry-compatible format so it can plug into Grafana/DataDog if you ever want it.
5. **Watch one trigger for OpenAI:** if PV MediSpa wants a **voice phone agent**, OpenAI Realtime Agents is the only production-ready option and can run as a *separate* service alongside Atlas — not a replacement.

---

## The one-liner

> The prior report's conclusion still holds — *stay on Claude, steal the good ideas* — but the urgent issue isn't which SDK, it's that June 15 puts a $200 meter on Atlas's automated `claude -p` load. Fix the billing exposure first; the SDK question is a slow-burn migration toward Anthropic's TS SDK, not a switch to OpenAI's.

---

## Sources (verified May 28, 2026)

- [The next evolution of the Agents SDK — OpenAI](https://openai.com/index/the-next-evolution-of-the-agents-sdk/) (Apr 15, 2026)
- [OpenAI updates its Agents SDK — TechCrunch](https://techcrunch.com/2026/04/15/openai-updates-its-agents-sdk-to-help-enterprises-build-safer-more-capable-agents/) (Apr 15, 2026)
- [OpenAI Agents SDK harness and sandbox update — Help Net Security](https://www.helpnetsecurity.com/2026/04/16/openai-agents-sdk-harness-and-sandbox-update/) (Apr 16, 2026)
- [OpenAI Agents SDK TypeScript docs](https://openai.github.io/openai-agents-js/)
- [OpenAI Agents JS — AI SDK (Anthropic) extension, beta](https://openai.github.io/openai-agents-js/extensions/ai-sdk/)
- [OpenAI Agents — Guardrails & human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
- [Anthropic Agent SDK billing split — The New Stack](https://thenewstack.io/anthropic-agent-sdk-credits/) (May 2026)
- [Anthropic June 2026 billing change — Codersera](https://codersera.com/blog/anthropic-june-2026-billing-change-claude-code/)
- [Claude Agent SDK monthly credits — eWeek](https://www.eweek.com/news/anthropic-claude-agent-sdk-monthly-credits/)
- [Use the Claude Agent SDK with your Claude plan — Claude Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [What Anthropic's billing means for Zed users — Zed blog](https://zed.dev/blog/anthropic-subscription-changes)
- [Agent SDK overview — Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/overview)
- [claude-agent-sdk-typescript CHANGELOG (v0.3.149–0.3.154)](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
- [Claude Code vs Claude Agent SDK — Augment Code](https://www.augmentcode.com/tools/claude-code-vs-claude-agent-sdk)
- Prior internal report: `deep-research-openai-agents-sdk-vs-anthropic-agent-sdk-vs-cl.md`
