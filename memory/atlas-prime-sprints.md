# Atlas Prime Sprint Log

- 2026-04-19 — **Sprint 1 (The Spine)** shipped. atlas.spec + tool-gate + ed25519 Merkle ledger + Staleness Sentinel + Freshness Feed + 1h prompt cache.
- 2026-04-19 — **Sprint 2 (The Governor)** shipped. Replay harness (dataset + judge + runner + [LABEL_GOOD/BAD] tags + nightly cron) + Trust Budget (+ /trust command + trust-daily cron) + Planner/Reader split (CaMeL — gated ingested-document path) + PreCompact/SessionStart hooks. All 4 ship criteria verified: fitness function exists, trust visible to Derek, ingested PDFs can't reach SEND, post-compact re-orient reflex. Full suite 125/125 green.
