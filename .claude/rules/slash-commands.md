# Slash Command Reference

These are handled directly by the bot (not Claude skills). Know what each does without searching code.

## System
`/restart` `/status` `/costs` `/ping` `/model [name]` `/timeout [ms]` `/session [reset|info]` `/help`

## Business Intelligence
`/finance [deep]` `/pipeline` `/scorecard` `/pulse` `/leads [days]` `/stl` `/ops`

## CRM (GoHighLevel)
`/messages <name>` `/sms <name>` `/appointments [days]` `/appts` `/workflows` `/graph [type|search <term>]`

## Meta Ads
`/ads [range]` `/adspend [range]` `/topcreative [range] [limit]`
Ranges: today, 7d, 30d, mtd, last_month

## Google
`/inbox` `/cal` `/calendar`

## Analytics & Reviews
`/reviews` `/visibility [days]` `/traffic [days]` `/conversions [days]`

## Executive
`/executive [week|month]` `/exec` `/alerts` `/channels` `/weekly`

## Clinical
`/careplan <patient data>` `/careplan demo`

## Modes
`/social` `/marketing` `/skool` `/coach` `/fitness` `/mode [list]`

## Memory
`/memory [type] [search]` `/ingest` `/ingest folder <path>` `/ingest status`

## Microsoft 365
`/m365` `/m365 sites` `/m365 files <site>` `/m365 search <query>` `/m365 create <name>` `/m365 users`
`/teams` `/teams <team>` `/teams messages <team> <channel>`
`/planner` `/planner <plan-name>` `/planner add <plan> | <bucket> | <task>` `/planner move <task> | <bucket>` `/planner done <task>`

## Code
`/code <project_dir> <instructions>`

## Meetings (Otter.ai)
`/meetings` - list recent transcripts
`/meetings <id>` - process transcript, extract action items
`/meetings search <query>` - search across all transcripts

## Evolution
`/evolve` `/nightly` — Manually trigger the nightly evolution pipeline (source scanning + opus code agent). Runs in background, reports results to Telegram when done.
