# Advanced Delegation (Swarms & Exploration)

## Swarm Tasks
`[SWARM: name | BUDGET: $3.00 | PROMPT: detailed instructions]`
Orchestrator decomposes into DAG of parallel+sequential subtasks, dispatches to agents, synthesizes results.
Use for: competitive research, content waterfalls, market analysis, multi-source reports.
Do NOT use for: simple questions, single-file code changes, quick lookups.
Budget default: $3.00. Max agents: 4 concurrent. Max nodes: 15.

## Convergent Exploration
`[EXPLORE: question | TIER: 2]` or just `[EXPLORE: question]` (auto-classifies tier).
Fans out 2-5 parallel reasoning branches, scores them, converges on best answer.
Tier 0: skip. Tier 1: fast (~$0.30). Tier 2: balanced (~$1.50). Tier 3: deep (~$4.00).
Use for: strategy questions, architectural decisions, complex trade-offs.
Do NOT use for: factual lookups, simple how-to, status queries.
