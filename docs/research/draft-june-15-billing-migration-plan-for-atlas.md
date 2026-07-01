# June 15 Billing Migration Plan for Atlas

**Date:** 2026-05-28
**Author:** Atlas background research agent (Opus 4.8)
**For:** Derek
**Deadline:** June 15, 2026 — Anthropic moves headless `claude -p` / Agent SDK usage off the Max subscription pool and onto a metered **$200/mo Agent SDK credit** (Max 20x), then standard API rates on overage.

> This is the working draft. The canonical copy lives at `data/task-output/june15-billing-migration-plan.md` (identical content).

---

## 0. The decision in one paragraph

The two deep-research reports agree on the load-bearing fact: **the billing change is a consumption problem, not an architecture problem.** Migrating to the Agent SDK saves $0.00 because the SDK and `claude -p` draw from the *same* $200 credit pool at *identical* rates. The only real lever is to **move work off the agent engine**: tool-less prompt→text jobs go to the raw Anthropic Messages API (`@anthropic-ai/sdk`), which bills against a *separate* pay-as-you-go API account — not the $200 credit. Async-tolerant overnight jobs go through the **Batch API for 50% off**. Interactive turns and anything that genuinely needs tools (code agents, skills, web) stay on the CLI/credit pool. None of this requires adopting the Agent SDK.

This plan does **not** touch `relay.ts` / `persistent-process.ts` / `claude.ts` transport. It adds one new module (`src/anthropic-api.ts`), reroutes ~12 tool-less callers to it, and adds token instrumentation so the $400–825 estimate becomes a measured number.

---

## 1. Inventory table

Legend — **Target:** `KEEP` = stays on CLI/credit pool · `API` = move to raw Messages API (off the $200 pool) · `BATCH` = raw API + Batch (50% off, async ≤24h) · `CUT?` = candidate to disable/throttle. **Tools?** = does the job actually need built-in tools (Read/Web/Bash/MCP) or is it pure prompt→text?

### A. Interactive + continuous (not cron, but the dominant load)

| Workload | File | Model | Tools? | Est. monthly cost | Target |
|---|---|---|---|---|---|
| Atlas/Ishtar interactive turns | `persistent-process.ts` / `claude.ts` | Opus | Yes (full) | **$200–450** (bulk of spend) | **KEEP** (verify cache) |
| Shadow-Atlas (fires on *every* primary turn) | `shadow-atlas.ts` | Sonnet | No | $40–120 | **API** or **CUT?** |
| Shadow scoring / divergence judge (per turn) | `shadow-driver.ts` + Haiku | Haiku | No | $5–20 | **API** |
| Staleness sentinel (per user msg) | `haiku-client.ts` consumers | Haiku | No | $5–15 | **API** |
| Reader / CaMeL extractor (per untrusted doc) | `reader.ts` → `haiku-client.ts` | Haiku | No | $5–20 | **API** |
| Model-router complexity estimate | `model-router.ts` | Haiku | No | $2–8 | **API** |
| Heartbeat (every 30 min, active hrs) | `heartbeat.ts` | Sonnet (in-session) | Yes (session) | $5–15 | **KEEP** |
| Supervisor task-done summary (on completion) | `cron.ts:1826` `callClaude` | Haiku | No | $1–5 | **API** |

### B. Cron jobs — LLM-bearing, ACTIVE

| # | Job (cron line) | Schedule | Model | Tools? | Est. $/mo | Target |
|---|---|---|---|---|---|---|
| 1 | `reflect` (483) `runSkill` | 2 AM daily | Sonnet | Yes (reads journals) | $3–8 | KEEP |
| 2 | `morning-brief` (499) `runSkill` | 6 AM daily | Sonnet | Yes (data/web) | $5–12 | KEEP |
| 3 | `content-engine` (560) waterfall + critic | 7 AM daily | Sonnet + Haiku | Partial | $8–20 | KEEP (critic→API) |
| 4 | `overnight-content` (652) waterfall + critic | 11:30 PM daily | Sonnet + Haiku | Partial | $8–20 | **BATCH** (critic→API) |
| 5 | `todo-review` (917) `runPrompt` | Sun 7 PM | Haiku | No | <$1 | **API** |
| 6 | `weekly-exec` (952) `buildWeeklySummary` | Sun 6 PM | Minimal/none (data assembly) | n/a | ~$0 | KEEP |
| 7 | `evolution` (979) Opus code-agent pipeline | 11 PM daily | Opus | Yes (heavy) | $30–90 | KEEP |
| 8 | `summarize` + `consolidate` (1780) `runPrompt` | 1 AM daily | Haiku | No | $2–8 | **BATCH** |
| 9 | `sunday-content-batch` (1086) social-pulse + gen | Sun 8 PM | Sonnet | Partial (pulse=web) | $2–6 | split: pulse KEEP, gen API |
| 10 | `meeting-check` (1213) `meetings.ts` | 6 PM daily | Claude (transcript) | No | $2–10 | **API** |
| 11 | `replay-nightly` (1266) `replay-judge` | 3:30 AM daily | Haiku | No | $2–10 | **BATCH** |
| 12 | `night-shift-plan` (2867) `runPrompt` | 10 PM daily | Haiku | No | <$2 | **API** (not batch — see §3) |
| 13 | `night-shift-work` (2888) `runPrompt` | 10:15 PM daily | Sonnet/Opus | Partial (research=web) | $20–90 ($5/night cap) | KEEP (cap) |
| 14 | `strategic-memo` (2911) | Sat 9 PM | Sonnet | No | $1–4 | **BATCH** |
| 15 | `maa-blog` (2972) `runPrompt` | Tue/Fri 9 AM | Sonnet | No (gen only) | $1–4 | **BATCH** (pre-gen night before) |
| 16 | `maa-newsletter-draft` (3004) `runPrompt` ×1–2 | Wed 8 AM | Sonnet | No | $1–3 | **BATCH** |
| 17 | `observation-reflector` (2843) `runReflector` | **every 30 min, biz hrs** | Haiku | No | $8–25 (high freq) | **API** |
| 18 | `memory-rewrite-nightly` (1313) | 1 AM daily | Haiku | No | $1–5 | **BATCH** |
| 19 | `episodic-cluster-nightly` (1326) | 2:30 AM daily | Haiku | No | $1–4 | **BATCH** |
| 20 | `cortex-demote-nightly` (1300) | 0:30 AM daily | Haiku | No | <$1 | **BATCH** |
| 21 | `causal-llm-propose` (1385) | Sun 2 AM | Opus | No | $1–5 | **BATCH** |
| 22 | `dream-sws-nightly` (1398) `dream-engine.ts` | 11 PM daily | Opus | No | $10–30 | **BATCH** |
| 23 | `dream-rem-nightly` (1414) `dream-engine.ts` | 3 AM daily | Opus | No | $10–30 | **BATCH** |
| 24 | `twin-predict-morning` (1455) `callOpus` | 5:30 AM daily | Opus | No | $5–15 | **API** (morning brief needs it) |
| 25 | `twin-score-evening` (1470) | 9 PM daily | Haiku | No | $1–4 | **BATCH** |
| 26 | `twin-update-nightly` (1430) | 10:30 PM daily | Haiku | No | $1–4 | **BATCH** |
| 27 | `council-shadow-review` (1501) | 8 AM daily | LLM summary | No | $1–4 | **BATCH** |
| 28 | `dgm-fork-nightly` (3262) `callClaude` Opus | 10 PM daily | Opus | Yes (worktrees/git) | $30–90 (~$3/night cap) | KEEP |
| 29 | `knowledge-audit-weekly` (3393) `callHaiku`+fetch | Sat 9 AM | Haiku | Fetch only | $1–3 | **API** |
| 30 | `dpo-digest-nightly` (3363) `soft-dpo.ts` | 11:30 PM daily | Haiku + embeddings | No | $1–4 | **BATCH** |

**Disabled / not counted** (code preserved, crons gated off): all Midas jobs (`midas-*`), `appointment-reminders`, GHL lead polling, `stale-leads`, `lead-volume`, Tox Tray. If any are re-enabled before June 15, route them through the same API/batch rules.

**Rough total:** the named $400–825/mo band is consistent. The bulk is **interactive Opus turns + the four Opus overnight heavies (evolution, dgm-fork, dreams, night-shift)**. The tool-less Haiku/Sonnet jobs are individually cheap but collectively ~$80–200/mo — and they are the easy wins because they can leave the credit pool entirely.

> ⚠️ **Cost-model discrepancy to resolve first.** `src/constants.ts:18` sets `opus: {input: 15.00, output: 75.00}`. Both deep-research reports verified the current Opus tier at **$5 / $25** per MTok against the pricing page (May 2026). If the reports are right, Atlas's internal cost tracking **overestimates Opus by 3x** and every dollar figure above is high for Opus rows. Verify against platform.claude.com/pricing and fix `TOKEN_COSTS` before trusting any projection.

---

## 2. Per-job migration steps

### Prerequisite (do this first — blocks everything else)
**P1. Provision a pay-as-you-go Anthropic API key.** The $200 credit pool is on the Max-plan OAuth side. Raw Messages API billing is a *separate* Console account with its own card. Without an `ANTHROPIC_API_KEY`, none of the "API/BATCH" moves are possible.
- Action: create/confirm an Anthropic Console org, generate an API key, add a payment method, set a usage alert at e.g. $150/mo.
- Add `ANTHROPIC_API_KEY=sk-ant-...` to `.env`. **Do not** add it to the persistent-pool env path — `sanitizedEnv()` in `claude.ts:274` deliberately strips it so the CLI stays on OAuth. The new raw-API module reads it directly from `process.env`, bypassing `sanitizedEnv`.
- Effort: **S** (~1 hr, mostly account setup).

**P2. Enable usage-credit overage backstop on the Max plan** so headless requests don't hard-fail when the $200 credit is exhausted mid-month. Per the support article, without this the requests *stop* until the cycle refreshes. Decide the cap consciously.
- Effort: **S** (account toggle).

### Core change
**C1. New module `src/anthropic-api.ts`** — thin wrapper over `@anthropic-ai/sdk` with:
- `callMessages({system, user, model, maxTokens})` → returns `{text, usage}` including `cache_creation_input_tokens` / `cache_read_input_tokens`.
- `cache_control: {type: "ephemeral"}` on the system block (so repeated system prompts cache server-side just like the CLI's `ENABLE_PROMPT_CACHING_1H`).
- `submitBatch(requests[])` / `pollBatch(id)` using the Message Batches API for the BATCH-target jobs.
- Same return shape as `haiku-client.ts`'s `HaikuResult` so it's a drop-in.
- Effort: **M** (~3–4 hrs incl. tests).

**C2. Re-point `src/haiku-client.ts` to `anthropic-api.ts`.** This is the single highest-leverage change. `callHaiku`/`callOpus` currently spawn the CLI (3–4s startup, on the credit pool). After June 15 the CLI path costs credit-pool dollars *and* is slower. Switching the internals to raw API moves **every** consumer (reader, staleness sentinel, model-router, twin, knowledge-audit, shadow scoring) off the pool at once, with no caller changes.
- Keep the function signatures identical; swap the `spawn(...)` body for `callMessages(...)`.
- Effort: **M** (~2–3 hrs; many downstream consumers, so test broadly).

**C3. Add a `viaApi` path to `src/prompt-runner.ts`.** `runPrompt(prompt, model)` is the workhorse for cron content/summarize/memo jobs. Add an optional 3rd arg `{viaApi?: boolean, batch?: boolean}`:
- When `viaApi`, route to `anthropic-api.callMessages` instead of spawning the CLI.
- When `batch`, enqueue to a batch collector (see C4) instead of returning synchronously.
- Default stays CLI so skill-based jobs (`runSkill`) are untouched.
- Effort: **M** (~2 hrs).

**C4. Overnight batch collector `src/overnight-batch.ts`.** A small queue that the BATCH-target nightly jobs append to, submitted once at e.g. 12:30 AM and polled, with results written to the same output files the jobs already use. Alternatively (simpler first cut): have each BATCH job submit its own single-request batch and poll — 50% off without a shared queue. Start simple.
- Effort: **M–L** (~4–6 hrs for shared queue; **S–M** for per-job batches).

### Per-job edits (after C1–C3)
| Job | File:line | Edit | Effort |
|---|---|---|---|
| content-critic | `content-critic.ts:129` | `runPrompt(prompt, MODELS.haiku)` → `callMessages` (it's already tool-less) | S |
| replay-judge | `replay-judge.ts` (via `scoreEntry`) | route scoring to API/batch | S |
| todo-review | `cron.ts:937` | `runPrompt(..., haiku)` → `runPrompt(..., haiku, {viaApi:true})` | XS |
| summarize/consolidate | `cron.ts:1784,1793` | `{viaApi:true, batch:true}` | S |
| observation-reflector | `cron.ts:2847` | `{viaApi:true}` (high-freq, keep sync) | XS |
| night-shift-planner | `night-shift.ts:262` | `{viaApi:true}` | XS |
| strategic-memo | `strategic-memo.ts` (`runStrategicMemo`) | `{viaApi:true, batch:true}` | S |
| maa-blog | `cron.ts:2977` + `maa-blog.ts` | pre-gen via batch night before, publish AM | M |
| maa-newsletter | `cron.ts:3011,3025` | `{viaApi:true, batch:true}` | S |
| dreams SWS/REM | `dream-engine.ts` (`runSWS`/`runREM`) | route Opus calls to API/batch | M |
| twin predict/score/update | `derek-twin.ts` | already on `callOpus`/Haiku → inherits C2 automatically | XS (free via C2) |
| causal-llm-propose | `causal-discovery.ts` (`proposeLLMEdges`) | route Opus to batch | S |
| council-shadow-review | `shadow-council.ts` (`dailyShadowReview`) | route to batch | S |
| memory-rewrite / episodic / cortex / dpo | respective modules | inherit C2 if they use `haiku-client`; else `{viaApi:true,batch:true}` | S each |
| meeting-check | `meetings.ts` | route transcript summarize to API | S |
| shadow-atlas | `shadow-atlas.ts:60` | swap CLI spawn for `callMessages` (Sonnet, no tools) — or gate behind a flag and **CUT?** if low value | M |

---

## 3. Batch-eligible overnight jobs (50% off)

**Batch = async, results not guaranteed for up to 24h.** Eligible only if nothing needs the output within minutes. Confirmed eligible:

- `dream-sws-nightly` (11 PM) and `dream-rem-nightly` (3 AM) — narrative, read next morning. **Biggest Opus batch win.**
- `summarize` + `consolidate` (1 AM) — nightly maintenance.
- `replay-nightly` (3:30 AM) — scoring rollup.
- `strategic-memo` (Sat 9 PM) — read whenever.
- `maa-newsletter-draft` (Wed 8 AM) and `maa-blog` (Tue/Fri 9 AM) — *if* generated the night before, batched, then published in the morning.
- `overnight-content` (11:30 PM) — explicitly a draft for morning review.
- `causal-llm-propose` (Sun 2 AM), `council-shadow-review` (8 AM, summarizes *yesterday*), `twin-update`/`twin-score`, `memory-rewrite`, `episodic-cluster`, `cortex-demote`, `dpo-digest`.

**NOT batch-eligible (must be sync API or stay CLI):**
- `night-shift-planner` (10 PM) → worker fires at 10:15 PM; 24h batch latency breaks the chain. Sync API.
- `night-shift-worker` — research tasks use web tools. Stays CLI.
- `observation-reflector` — every 30 min during business hours; sync API (non-batch) so insights are fresh.
- `twin-predict-morning` (5:30 AM) → feeds the 6 AM morning brief. Sync API.
- `content-critic` — runs inline before content delivery. Sync API unless the whole content gen → critic flow moves to one overnight batch.
- Interactive, evolution, dgm-fork — KEEP on CLI.

**Estimated batch savings:** the Opus dream jobs alone (~$20–60/mo) drop to ~$10–30. Across all batch-eligible jobs, expect ~$30–80/mo of the moved load cut in half.

---

## 4. Prompt-cache audit — is `--resume` / the persistent pool actually getting cache hits?

**Finding: we cannot currently answer this, because cache tokens are never logged.** That is the first thing to fix.

What the code actually does:
1. **The persistent pool does NOT use `--resume`** (`persistent-process.ts:511–515`, by design). It keeps context via the long-lived stdin `stream-json` pipe. Each turn the CLI re-sends the conversation; Anthropic caches the stable prefix (system prompt + early turns) **only if `cache_control` is applied** — which the CLI does when `ENABLE_PROMPT_CACHING_1H=1` (`claude.ts:268`).
2. **`sanitizedEnv()` sets `ENABLE_PROMPT_CACHING_1H=1`** — but verify the **persistent pool's** `this.config.env` (`persistent-process.ts:533`) is actually built from `sanitizedEnv()`. If the relay constructs that env by a different path, caching may silently be off for the main interactive loop — the most expensive workload. **Check this explicitly.**
3. **The stream parser drops cache fields.** `claude.ts:581–582` and `:605–606` read `raw.usage.input_tokens` / `output_tokens` but ignore `cache_read_input_tokens` / `cache_creation_input_tokens`. So even when caching works, we have zero visibility into the hit rate.
4. **`haiku-client.ts` already captures cache tokens** (`extractFinalUsage`, lines 192–195) — but every caller throws the `usage` object away. The plumbing exists; nothing consumes it.
5. **One-shot/cron spawns are each a fresh process.** Server-side cache keys on identical prefix content within the 1h TTL. So jobs >1h apart (content-waterfall 7 AM vs 11:30 PM) get **no** cache benefit; high-frequency identical-prompt jobs (observation-reflector every 30 min, `haiku-client` with a fixed `--system-prompt`) **do** hit cache.

**Audit procedure:**
1. Land the instrumentation in §5 (capture cache_read/cache_creation everywhere).
2. Run 3–5 days normally.
3. Compute `cache_read_input_tokens / (cache_read_input_tokens + input_tokens)` per agent/job. For the persistent interactive loop this should be **high (>0.7)** if caching works; if it's ~0, caching is broken on that path and fixing it is the single biggest pre-June-15 cost win (cached input is ~10% of full price).
4. Report the ratio in the morning-brief system digest (`cron.ts:buildSystemDigest`) so it's visible daily.

---

## 5. Token instrumentation — what to add and where

The biggest blind spot: **`runPrompt` (prompt-runner.ts) and `runSkill` (cron.ts) do not record token usage at all.** Every cron content/summary job is invisible to cost tracking. Only the interactive `callClaude` path calls `trackClaudeCall` (`claude.ts:1291`), and even that omits cache tokens.

Concrete additions:

1. **Extend the cost record to carry cache tokens.**
   - `logger.ts:289` `trackClaudeCall` cost object + `logger.ts:308` `todayCosts.push` + `logger.ts:319` `getTodayClaudeCosts` return: add `cacheReadTokens` and `cacheCreationTokens` fields.
   - `claude.ts:1291` call site: pass the cache fields (after capturing them in the stream parser, next item).

2. **Capture cache tokens in the persistent stream parser.**
   - `claude.ts:581–582` and `:605–606`: also read `raw.usage.cache_read_input_tokens` and `cache_creation_input_tokens`, thread them to `trackClaudeCall`.

3. **Instrument `runPrompt`.**
   - `prompt-runner.ts:44–49`: after `extractFirstAssistantText`, also parse the final `result` event's `usage` (reuse `haiku-client.ts:extractFinalUsage` — export it), compute cost from `TOKEN_COSTS`, and call `trackClaudeCall`. Tag each call with the cron job name (add an optional `caller` arg) so per-job spend is attributable.

4. **Instrument `runSkill`.**
   - `cron.ts:383`: it already parses JSON output (`parsed.result`); also pull `parsed.usage` (the CLI's `--output-format json` includes a `usage` block) and call `trackClaudeCall` with the skill name as caller.

5. **Make `haiku-client` consumers record usage.** They already get `usage` back; have `callModel` call `trackClaudeCall` directly so reader/sentinel/router/twin spend shows up automatically.

6. **Per-caller / per-job rollup.** Add a `caller` (or `job`) tag to `todayCosts` entries and a `byCaller` breakdown in `getTodayClaudeCosts`. Surface daily in `buildSystemDigest` (`cron.ts:1644`) and persist to `data/health.json` (already written every 15 min, `cron.ts:835`). Within a week this replaces the $400–825 estimate with measured per-job dollars and a cache-hit ratio.

Effort for all of §5: **M** (~3–4 hrs), and it should land **first** — you cannot prioritize cuts without measurement.

---

## 6. Priority order & 1–2 week timeline

**Week 1 — measure, then move the cheap wins.**

- **Day 1 (P1, P2, §5):** Provision API key + overage backstop. Land token + cache instrumentation (`logger.ts`, `claude.ts` parser, `prompt-runner.ts`, `runSkill`, `haiku-client`). Fix the `constants.ts` Opus price discrepancy. *Goal: by end of day, every Claude call is attributable and cache hits are visible.*
- **Day 2–3:** Build `src/anthropic-api.ts` (C1) with cache_control + batch support. Re-point `haiku-client.ts` (C2) — this alone moves reader/sentinel/router/twin/shadow-scoring off the pool. Run instrumentation 48h.
- **Day 4:** Read the numbers. Confirm the interactive cache-hit ratio (§4). If it's low, fix the persistent-pool env path — likely the biggest single win. Reprioritize the rest against measured per-job spend.
- **Day 5:** Add `viaApi` to `prompt-runner.ts` (C3). Flip the always-sync tool-less jobs to API: `observation-reflector`, `todo-review`, `night-shift-planner`, `meeting-check`, `content-critic`.

**Week 2 — batch the overnight load, then evaluate the heavies.**

- **Day 6–7:** Batch collector (C4, start with per-job batches). Move the nightly BATCH set: dreams (SWS/REM), summarize/consolidate, replay, strategic-memo, twin-update/score, memory-rewrite, episodic, cortex, dpo, council-shadow-review, causal-llm-propose.
- **Day 8:** Move content jobs to overnight batch where possible: `overnight-content`, `maa-newsletter-draft`, `maa-blog` (pre-gen night before).
- **Day 9:** Evaluate **shadow-atlas** — it fires Sonnet on *every* interactive turn. Either move it to raw API (C2-style) or, given it's a monitor with debatable ROI vs. cost, gate it off (`SHADOW_ATLAS_ENABLED=false`, already supported at `shadow-atlas.ts:160`) and measure the delta. Same question for `dream-*` if measured Opus cost is high relative to value.
- **Day 10:** Re-measure total. The keep-on-pool set (interactive Opus, evolution, dgm-fork, night-shift-worker, skill-based briefs) should now fit much closer to $200; everything tool-less is on pay-as-you-go API (cheaper, off the cap) with the async half at 50% off batch. Decide whether the remaining pool spend needs the overage backstop or a model downgrade (e.g. interactive default Opus→Sonnet for one persona — see `constants.ts:12 DEFAULT_MODEL`).

**Stop-and-decide gates:**
- If Day-4 numbers show interactive caching is already working and the pool fits $200 once tool-less jobs leave → skip the aggressive shadow/dream cuts.
- Do **not** touch `relay.ts`/`persistent-process.ts`/`claude.ts` transport or adopt the Agent SDK — zero savings, real regression risk on the Windows-hardened pool (both reports, high confidence).

---

## Appendix — key file references

- `src/cron.ts` — all cron definitions; `runSkill` (383), `safeTick` (256), system digest (1620).
- `src/prompt-runner.ts` — `runPrompt` (20), `extractFirstAssistantText` (64); **no token tracking today.**
- `src/haiku-client.ts` — `callHaiku`/`callOpus` (CLI-backed), `extractFinalUsage` captures cache tokens (179) but callers ignore.
- `src/content-critic.ts` — `critiqueContent` → `runPrompt(haiku)` (129); tool-less.
- `src/replay-harness.ts` — `runHarness` → `scoreEntry` (Haiku judge); tool-less.
- `src/shadow-atlas.ts` — separate Bun process, Sonnet, `--allowedTools ""` (67); fires every turn.
- `src/night-shift.ts` — planner Haiku (262), worker per-task model (419); $5/night cap (39).
- `src/claude.ts` — persistent SDK/CLI path, cache env (268), no `--resume` on pool (parser 581/605 drops cache), cost calc (1289), `trackClaudeCall` call (1291).
- `src/persistent-process.ts` — spawn args (497), `--resume` deliberately omitted (511).
- `src/constants.ts` — `MODELS` (5), `TOKEN_COSTS` (17; **Opus 15/75 likely stale vs verified 5/25**), `PERSISTENT_PROCESS_ENABLED` (487).
- `src/logger.ts` — `trackClaudeCall` (289), `getTodayClaudeCosts` (319); add cache + per-caller fields.
