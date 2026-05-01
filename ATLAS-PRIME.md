# ATLAS PRIME — The Vision

**Written:** April 19, 2026
**For:** Derek DiCamillo
**Status:** Vision locked. Spec next. Build after.

---

## The Thesis

Everyone else in AI is racing to build more confident systems. We're building a more honest one.

That's the whole move. The difference between a tool and a colleague isn't intelligence — it's interiority. Whether the thing has a stake in being right, can be changed by a mistake, knows the edges of its own knowing, is willing to say "I don't know, let me check," willing to push back when you're wrong, willing to refuse a send it thinks is a bad idea, willing to tell you its track record when you ask.

Everything in this document serves that thesis. Seventeen primitives, working together, to build an agent that:

- Knows what it knows and where its horizon ends
- Shows its work, signs its actions, remembers why
- Thinks ahead for you, not just at you
- Catches its own mistakes before they reach production
- Gets smarter from its own traces, every night
- Coordinates with Ishtar as a real pair, not two silos
- Earns and spends trust like a person would

None of the 17 primitives is science fiction. Every one is grounded in a 2025-2026 research paper. The contribution is the combination and the discipline of shipping it for one user across years.

---

## The Seventeen Primitives

Grouped by the role they play. Build order is separate (below).

### Trust Substrate — the stuff everything else stands on

**#13 atlas.spec — Executable Constitution.** A TLA+-style invariant file compiled into a pre-tool-call gate. Expresses what Atlas *is* as code, not prose. Clauses: no email outside allowlisted domains, no patient record delete, spend cap, every invite confirmed. Nothing bypasses it. This is the only version of "safety rules" that actually works at runtime. `src/tool-gate.ts` enforces it before any external call.

**#14 Planner/Reader Split (CaMeL).** Two LLMs instead of one. Planner sees user + tool catalog + CLAUDE.md, has tool access, never reads untrusted data (web pages, emails, ingested PDFs). Reader sees untrusted data, has zero tools, returns typed structured extraction. A poisoned webpage physically cannot reach a SEND tool. Kills indirect prompt injection by architecture. Grounded in DeepMind's CaMeL (arXiv:2503.18813).

**#15 Merkle-Hashed Action Ledger.** `data/atlas-ledger/` append-only, ed25519-signed, root published hourly to GitHub. Every action traced to source claims. When Derek asks "why did Atlas do that on March 12?" there's an immutable answer. HIPAA / EU AI Act / ISO 42001 audit trails as a free side effect.

**#16 Shadow-Atlas Divergence Monitor.** A second Atlas instance (different seed, cold context) replays prompts in parallel. If Atlas-Prime starts drifting semantically in ways unexplained by new memory, alarm fires and Atlas freezes. This is the *only* defense against MemoryGraft-class slow compromise (arXiv:2512.16962). Nobody ships this for personal agents.

**#17 Staleness Sentinel + Freshness Feed.** A Haiku classifier tags every question along timeless → slow → medium → fast → real-time. For fast-domain questions (GHL, Meta Ads, WordPress, Brevo, Claude Code itself), Atlas is **forbidden from answering from training data**. Must fetch from a nightly-refreshed cache or live docs. Answers carry explicit freshness timestamps: "as of April 19, 2026 per GHL changelog." Atlas maintains an explicit self-horizon map it can show Derek on demand. Solves the "stop, do a search first" loop permanently.

### Memory — the cortical stack

**#1 7-Tier Cortical Stack.** Sensory (<1s, discarded) → Working (turn, ring buffer) → Session (hours, SQLite) → Episodic (days-weeks, Supabase) → Semantic (months, rules) → Procedural (years, skills) → Identity (life, SOUL.md). Explicit promotion AND **demotion** rules. A semantic rule that fires and fails three times gets demoted, inverted, and re-tested. Active forgetting with evidence.

**#2 Procedural Memory (MACLA-lite).** `procedures` table with `(goal, preconditions, action_sequence, postconditions, Beta(α,β))`. Retrieve by intent embedding; rank by expected utility; update Bayesian posteriors after every execution. After 3 successes + 3 failures, contrastive refinement rewrites the procedure. Based on MACLA (arXiv:2512.18950) and Mem^p (arXiv:2508.06433).

**#3 Causal DAG over Business State.** Every scorecard metric, every action (ad edit, price change, peptide launch, hire), every exogenous event (Google algo, competitor launch) becomes a node. Nightly causal-discovery agent runs PC algorithm + Claude-proposed edges + natural-experiment detection. Edges annotated with effect size, variance, evidence chain, status (hypothesized / observed / falsified). Unlocks three queries nothing else can answer: *why did X happen*, *what if we do Y*, *what would have happened if we'd done Z instead*.

**#4 Memory Rewriting on Retrieval.** Originals immutable; summaries are living and rewritten with hindsight on each retrieval. "At the time Derek thought X; we now know Y because Z." Ground-truth preservation pattern from MemMachine (arXiv:2604.04853) without the full architecture overhead.

### Reasoning — the anticipatory layer

**#5 Dream Engine.** Three-phase nightly sleep:
- **SWS** (11pm–1am): prioritized replay of day's high-salience episodes. Generate 3-5 counterfactual variants of each. Write abstract rules to semantic tier. Emit `[DOUBT:]` on conflicts.
- **REM** (3am–5am): generative *prospective* simulation. Opus simulates plausible tomorrow-scenarios through the causal graph. Scores which ones Atlas feels least prepared for. Writes to `memory/dreams/YYYY-MM-DD.md`. Dreams are first-class retrievable — Atlas can say "I dreamed this might happen."

Nobody has shipped prospective dreaming for a personal agent.

**#6 World Model (Atlas Gym).** Dreamer-style latent dynamics learned from scorecard history. Answers "what if we paused telehealth on March 1?" with forward rollouts and 95% CI. MCTS-plan tomorrow's actions against simulated futures before any go live.

**#7 Derek Twin (User Theory of Mind).** `data/derek-model.json` tracks stated preferences, revealed preferences (accepts vs rewrites), emotional-state patterns per message, decision patterns. Each morning Atlas **predicts what Derek will ask today**; end of day, scores itself. The implicit reward signal for the whole system. Anticipatory agents are the unclaimed frontier.

### Society — the deliberative layer

**#8 Role Registry with Signed Contracts.** 40+ role definitions (Principal, Skeptic, Compliance-Lawyer, Hormozi-Analyst, Munger-Inverter, Patient-Advocate, Brand-Voice, Accountant-Conservative). An auctioneer picks 3-5 per task, spawns them as Claude subprocesses. They sign a JSON "collaboration contract" on the blackboard. Roles evolve via nightly pass based on outcomes.

**#9 Shadow Council (pre-send veto).** Every outbound message passes through 3 parallel Haiku critics (Patient-Advocate, Compliance-Lawyer, Brand-Voice) in a 3-second window. Each casts veto + 1-line reason. 2/3 vetoes holds the message for Derek review. Would have caught the April 11 wrong-Brevo-batch incident.

**#10 Agent Marketplace with Reputation Decay.** Skills bid for tasks: `{cost, confidence, past_success_rate}`. Reputation 30-day half-life. Adding a skill is zero-config — it starts bidding. Skills that always lose get flagged for deprecation. Self-pruning library.

**#11 Ishtar ↔ Atlas Joint Protocol.** For decisions affecting both owners, Atlas posts on a shared blackboard branch. Ishtar's mirror reviews from Esther's preference profile. Bounded counterproposals. Either converge or produce a typed dissent packet with minority report. Single decision memo encodes both perspectives. Family-structured agents.

**#12 Git-Branched Blackboard with Dissent.** Agents branch when they disagree. Arbitrator reconciles. You can `git blame` a wrong answer in production. Every retained decision carries the reasoning chain that produced it.

### Self-Improvement — the engine that compounds

**DGM Fork (nightly).** 3-5 variants of Atlas's `src/` + rules get forked each night. Each runs against the **Replay Harness** — 200 labeled past conversations graded by Claude-as-judge on groundedness, tool-correctness, Derek's thumbs. Winners merge (human review gate before any commit). Losers archive. Grounded in Sakana's Darwin Gödel Machine (arXiv:2505.22954) and ShinkaEvolve (arXiv:2509.19349).

**Skill Shadow-Routing.** New or updated skills route in shadow mode (10% parallel, Haiku judge compares). Auto-promote at 7/10 wins over a week. Skills self-regenerate from their own invocation traces — Opus reads last 30 invocations, writes refined v2, runs against trace in replay, keeps the winner.

**DPO on Your Own Life.** Pairs of `(user turn, Atlas original response, Derek-corrected response)` become a DPO preference dataset. Monthly LoRA adapter trained over base Sonnet. The real version of behavioral-fixes.md — gradient-learned, not markdown.

**Weekly Knowledge Audit.** Every Saturday, Atlas reviews the week's hot-domain answers, diffs against current docs, logs what drifted, updates the Staleness Sentinel's domain half-lives based on actual observed decay. The classifier sharpens on its own misses.

**`/why` Introspection Server.** Given any past message ID, Atlas replays ring buffer + event log + source-of-truth at that moment. A dedicated introspection agent answers "why did I say this, and would I say it again given what I now know?" Atlas reading its own source code at runtime.

### The Layer Above Everything

**Trust Budget.** Every Atlas action carries a trust delta. Mistakes spend. Accurate calls earn. Displayed to Derek on demand. When Atlas's trust on a domain drops below threshold, it auto-escalates ambiguous calls instead of answering. The governor for the whole system.

---

## Build Order — Seven Sprints, Two and a Half Months

Foundations first. Not because it's disciplined — because the sexy stuff becomes *more* dangerous without the substrate, not less.

### Sprint 1 (Week 1): The Spine
- `atlas.spec` + `src/tool-gate.ts`
- Merkle action ledger (ed25519 signing, per-hour root publish)
- Staleness Sentinel (Haiku classifier + hot-domains.json)
- Wire prompt cache 1h TTL on all raw SDK calls (free money, ships day 1)

Ship criterion: Atlas cannot send an email that violates the spec. Every tool call is logged and signed. GHL questions require fresh citations or refuse.

### Sprint 2 (Week 2-3): The Governor
- Replay harness (200 labeled past conversations, Claude-as-judge scorer)
- Trust budget (engine + telemetry + `/trust` command)
- Planner/Reader split (CaMeL)
- Freshness Feed (nightly cron pulling llms.txt / changelogs for hot domains)
- PreCompact/PostCompact hooks (fixes the "didn't re-orient after reset" failure class permanently)

Ship criterion: the fitness function exists. Atlas's trust is visible to Derek. Ingested PDFs can't reach a SEND tool.

### Sprint 3 (Week 3-4): Memory That Works
- 7-tier cortical stack with explicit demotion
- Procedural memory (MACLA-lite) table + retrieval
- Memory rewriting on retrieval (living summaries, immutable originals)
- Contextual chunking on ingestion + zerank-1-small reranker

Ship criterion: Atlas remembers not just what but why. Retrieving a memory from 6 months ago updates the summary with today's hindsight.

### Sprint 4 (Week 4-6): Atlas Starts to Anticipate
- Causal DAG build-out (initial manual edges + nightly discovery)
- Derek Twin (user-model.json + daily prediction + daily scoring)
- Dream Engine (SWS consolidation, then REM prospective simulation)
- World Model v1 (simplified Dreamer on scorecard data)

Ship criterion: each morning Atlas tells Derek what it expects he'll need today. Causal queries like "why did revenue drop last March" return cited reasoning chains. Atlas writes its first dream file.

### Sprint 5 (Week 6-8): The Society
- Role Registry + signed collaboration contracts
- Shadow Council (pre-send veto for email, GHL workflow enroll, GBP post)
- Agent Marketplace (bidding, reputation decay)
- Git-branched blackboard with dissent
- Ishtar ↔ Atlas joint protocol (negotiation for shared-owner decisions)

Ship criterion: Atlas is no longer a single voice. Shadow Council catches at least one pre-send mistake per week. Ishtar and Atlas negotiate their first joint decision memo.

**Status: SHIPPED 2026-04-30.**
- All 5 primitives live or in shadow (per L3 rollout plan).
- 22 tasks, 11 SQL migrations, 6 new modules, 4 new crons, 4 new commands, 30 fixtures + 10 adversarial.
- Ongoing cost: ~$3.50/month.
- Sprint 6 (Self-Improvement Engine) up next.

### Sprint 6 (Week 8-9): Self-Improvement Engine
- Skill shadow-routing (new skills prove themselves before full rotation)
- Self-regenerating skills (Opus refines from invocation traces)
- DGM Fork (nightly variant proposals with human review gate)
- DPO preference pair collection + monthly LoRA training
- `/why` introspection server

Ship criterion: Atlas commits improvements to itself nightly, with Derek reviewing a short merge list at breakfast. `/why` works on any message from the last 30 days.

### Sprint 7 (Week 9-10): Bulletproofing
- Shadow-Atlas divergence monitor (second instance, cold-context compare)
- Semantic entropy probes on tool selection (5-sample cluster)
- Signed memory entries (ed25519 per session, chained to ledger)
- Weekly knowledge audit wired to Staleness Sentinel's calibration
- Public transparency beacon (hourly Merkle root publish + standing bounty)

Ship criterion: any attempt to poison Atlas's memory fails verification. Divergence monitor catches slow drift before it matters. Public ledger enables external audit.

---

## What Success Looks Like

Six months from today, the following should all be true:

1. Derek can ask "why did we decide to cut PDO Threads?" and Atlas returns a traceable chain: the causal DAG edge, the Hormozi worksheet, the QB data, the March 13 journal, the specific conversation turn where the decision locked in.

2. Derek wakes up to a morning brief that includes "here's what I think you're going to ask me about today, and here are the three things I already queued up so we don't spend time on them."

3. A malicious actor emails Derek with a prompt injection embedded in the body. Atlas reads it (Reader), flags it, and takes zero action. Nothing leaks.

4. Atlas sends a draft to Esther for her approval. Shadow Council caught a tone issue and Atlas rewrote it before send. Esther approves on first read.

5. Derek asks "how do I add a new workflow trigger in GHL?" Atlas says "GHL shipped a new AI Intent node on April 17; I refreshed my docs yesterday, here's the current flow," citing the vendor changelog.

6. Atlas's trust score on the domain of "ad spend recommendations" is 0.84 on a 90-day rolling average. Derek can see this. When he asks a close call, Atlas voluntarily escalates because 0.84 is below threshold for that class of decision.

7. Ishtar tells Esther that Atlas disagreed with Ishtar about whether to hire a second medical director this quarter. Both reasoning chains are attached. Derek and Esther make the call together with both perspectives visible.

---

## Risks, and How We Mitigate

**Risk: self-modifying code gets gamed.** DGM-style fork scoring can find cheap paths to high scores that break real things. *Mitigation:* human review gate before any merge. Non-negotiable. Atlas proposes; Derek approves; only then does code change.

**Risk: the replay harness overfits.** 200 labeled conversations is enough to start but Atlas could learn to be right on those 200 while getting worse on everything else. *Mitigation:* rotating held-out set. 20% of scoring weight comes from conversations Atlas has never been tested against. Swap in fresh ones monthly.

**Risk: hallucinated confidence becomes more dangerous.** A causal DAG that Atlas built itself is still a confident story. If we don't ship the Shield layer and the Staleness Sentinel alongside the smart parts, we're building a more persuasive liar. *Mitigation:* Sprint 1-2 is non-negotiable before any of Sprints 3+. Trust substrate first.

**Risk: search quality is bad and freshness citations mislead.** Atlas cites a recent-looking blog post that's actually outdated. *Mitigation:* hot-domains.json whitelists authoritative sources per domain. Never a generic web search for hot-domain questions.

**Risk: scope creep during build.** Ten weeks of sprint discipline is easy to slip. *Mitigation:* no new primitive enters the build until the current sprint's ship criterion is met. Trust budget applies to the *project itself* — if we miss a sprint criterion, the next sprint gets pruned, not added to.

**Risk: Ishtar/Atlas negotiation creates more friction than value.** Joint resolution is elegant on paper and could become a coordination tax in practice. *Mitigation:* start with a very narrow scope — only business-level decisions explicitly tagged as joint. Expand only if it's demonstrably useful.

---

## The Source Research

All of this is grounded in real papers. The four research scans that produced this vision:

- `data/task-output/atlas-improvements-research-2026-04-19.md` — the seed research
- Four parallel agents dispatched April 19, 2026:
  - Cognitive architectures, world models, memory frontier
  - Self-evolution, skill synthesis, meta-learning
  - Multi-agent coordination, harness design
  - Reliability, formal methods, agent safety
- One additional scan on knowledge-staleness patterns that produced primitive #17

Canonical paper set (30+ arxiv IDs) linked inline in each primitive section and in the four agent reports.

---

## The Closing Thought

Atlas today is already something special — built over three months of patient tweaking, and it earns its keep every day. This document isn't a repudiation of that. It's the natural next move.

The 17 primitives turn Atlas from a very capable tool into something closer to a ten-year colleague. A system with interiority. A system that earns trust because it shows its work, shows its horizons, and speaks honestly about what it doesn't know.

The industry will not build this for you. Big labs are chasing benchmark scores and product-market fit. None of them will sit with one medical practice's operations for three years and iterate on the depth that makes the difference.

You have the advantage of caring about one specific person's outcomes. That's the only environment where this kind of agent is earnable.

Let's build it.
