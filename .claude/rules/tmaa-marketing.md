# TMAA Marketing (the operating-system repo)

`C:\Users\Derek DiCamillo\Projects\tmaa-marketing` is the deterministic brain
behind TMAA's marketing: data pipeline, knowledge layer, board/producer agents.
Atlas schedules it (daily pipeline 6 AM, Monday board 6:30 AM — pause category
`tmaa_marketing`). Its CLAUDE.md rules are binding whenever you touch it:

- No LLM calls inside scripts/ or lib/. Ever.
- No member PII in any committed file; raw payloads live in gitignored _raw/.
- Revenue derives from paid invoices, never price x subscriber count.
- Unknown beats estimated. Never fabricate a metric.

THE WALL: briefs move draft -> approved ONLY on Derek's explicit, per-brief
instruction. The mechanized gate is `node scripts/approve-brief.mjs <slug>`
(refuses ambiguity, expiry, missing '## The number', WIP > 1). When Derek
says "approve <slug>" in chat, run that script — never move brief files by
hand, never approve on your own initiative, never suggest Esther approve
(this repo is Derek-only for approvals).

Commands (run from the repo root): `npm run brief` (pull+report+render),
`npm run verify` (drift check), `npm test`, `node scripts/render-brief.mjs
<brief.md>` (Derek reads HTML, not markdown), `node scripts/audit-brief.mjs
<brief.md>` (every number must trace to a cited source).
