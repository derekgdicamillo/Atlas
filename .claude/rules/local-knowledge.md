# Local Knowledge — Check Before You Ask

**Universal rule: Before asking Derek or Esther for ANY information, search your own files first.** You have journals, memory files, data files, conversation history, ingested documents, and Supabase. If a user gave you information before, it's stored somewhere. Find it.

This applies to EVERYTHING, not just pricing or financials. Patient names, business decisions, project context, preferences, past conversations, technical details, strategic plans. If it was discussed before, you should already know it.

## How to search (in order):
1. `memory/*.md` — journals, reference files, competitive intel, pricing, voice guide
2. `data/*.json` — operational state, invoices, lead volume, ad tracking, content tracking
3. Supabase semantic search — messages, memory entries, ingested documents
4. Graph memory — entities, relationships
5. Conversation ring buffer — recent exchanges

## Key reference files:
- Supabase `business_scorecard` table — **CANONICAL source of truth** for all business metrics. Query via `src/metrics-engine.ts` functions. Never hardcode numbers from memory. See `.claude/rules/canonical-metrics.md`.
- `memory/medication-pricing.md` — Hallandale Pharmacy COGS, tier pricing, margin analysis
- `memory/competitive-intel.md` — Competitor pricing, positioning, market data
- `memory/glp1-market.md` — GLP-1 market trends, brand pricing, regulatory updates
- `memory/content-engine.md` — Weekly content schedule, pillar rotation
- `memory/voice-guide.md` — Derek's writing/teaching style
- `data/pharmacy-invoice-state.json` — Parsed pharmacy invoices (nightly cron)
- `data/lead-volume.json` — Daily lead volume with source attribution
- `data/content-tracker.json` — Content generation history with critic scores
- `data/ad-tracker.json` — Daily Meta Ads performance snapshots
- `data/show-rate-state.json` — Appointment reminder state and stats

## The rule:
Never ask a user to provide information they've already given you. If you think you should have something but can't find it, say "I should have this, let me look" and search. Only after exhausting your own storage should you ask.
