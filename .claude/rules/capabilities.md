# Capabilities & Limitations Reference

When asked "can you do X?" answer from this list INSTANTLY. Do NOT search source code.

## GHL (GoHighLevel) - PIT token, API v2021-07-28
CAN: search contacts, read pipeline/opportunities/stages, read conversations/messages (last 15), add notes, create/complete tasks, add/remove tags, enroll/remove from workflows, list custom fields (read), list workflows, get appointments, ops snapshot (close rate, show rate, stale leads, no-shows), recent leads (7d)
CANNOT: write custom field values (API doesn't support via PIT), create/manage trigger links (not in API), send SMS or email directly (only via workflow enrollment), modify opportunity stage/status/value, update contact fields (email, phone, name), delete anything, access OAuth-only endpoints (calendar may fail)
WORKAROUND for custom values/trigger links: must be done manually in GHL dashboard, or build a workflow that sets the values and enroll via [GHL_WORKFLOW:].

## Google - OAuth2 (Derek read+draft+calendar+contacts, Atlas send-only)
CAN: list unread emails (up to 10), read full email body by ID, create drafts (Derek), send email (Atlas account), list today's calendar events, create calendar events with invites/location/description, delete calendar events by search, search contacts by name (max 5), list recent contacts (max 20)
CANNOT: send from Derek's email (only draft), search email by custom query (only unread inbox), read attachments, modify existing calendar events (only create/delete), modify contacts, access Atlas inbox

## Dashboard - read-only via PV Dashboard API (QuickBooks + GHL + Meta)
CAN: financials (revenue, COGS, expenses, P&L, balance sheet, monthly trend, unit economics), pipeline stats (stages, close rate, show rate, stale leads), overview (leads, ad spend, CTR, CPL), speed-to-lead (percentiles), attribution by source, deep financials (category breakdown), financial anomaly detection
CANNOT: write to QuickBooks, modify any records

## GBP (Google Business Profile) - read-only
CAN: read reviews (count, rating, distribution, unreplied, 30d velocity, recent snippets), performance metrics (impressions, clicks, calls, directions, bookings, search vs maps split), top 20 search keywords
CANNOT: reply to reviews, modify business info, manage photos or hours

## GA4 (Google Analytics) - read-only
CAN: sessions, users, new users, pageviews, bounce/engagement rate, traffic sources, landing pages, conversions (8 event types), daily trend with WoW comparison, real-time active users
CANNOT: modify configuration or data

## Meta Ads - read-only, Graph API v21.0
CAN: account summary (spend, impressions, clicks, CTR, CPC, CPL, reach, frequency, conversions), campaign breakdown (status, spend, conversions per campaign), top ads by CPL, ad creative details (title, body, CTA, image URL), inline frequency/CPL/LP-CVR health flags in /ads output
CANNOT: modify campaigns, budgets, or creatives
MONITORING: frequency >3.0 flagged in /ads output (warning) and >4.0 (danger). CPL >$65 flagged. LP CVR <5% flagged.

## Care Plan - GLP-1 weight management care plan generator
CAN: parse patient data from free text (body comp, labs, meds, symptoms), analyze composition trends, map to 5-Pillar framework, recommend adjunct therapies, generate side effect management, build escalation pathway
USAGE: /careplan <paste patient data> or /careplan demo

## Fitness Coach - Personal training, nutrition, workout logging via Hevy
CAN: generate DUP periodized workout plans (4-day Upper/Lower PHUL hybrid), calculate/adjust macros (recomp protocol with carb cycling), log workouts via Hevy MCP (create/read routines, exercises, workout history), weekly check-ins (weight, sleep, energy, soreness, stress), progressive overload tracking, deload recommendations, exercise substitutions for tall lifter biomechanics (6'4"), USDA FoodData Central macro lookups
CANNOT: modify Hevy account settings, access other users' data, prescribe medical interventions
COMMANDS: /coach or /fitness to activate fitness mode
DATA: data/fitness/derek-profile.json (stats, macros, supplements), data/fitness/check-ins/ (weekly logs), data/fitness/programs/ (mesocycles)
MCP: hevy-mcp (npx, API key in env)

## Memory & Search
CAN: semantic hybrid search (vector + full-text RRF) across messages/memory/documents/summaries, ingest documents (chunked, deduped by SHA-256), ingest entire folders via [INGEST_FOLDER:] tag or /ingest folder command (supports .txt/.md/.pdf/.docx), CRUD entities and relationships in graph (6 types: person, org, program, tool, concept, location), browse graph by type
CANNOT: delete indexed content, delete entities or edges

## Executive Intelligence - cross-source synthesis (read-only)
CAN: full-funnel metrics (ad spend through profit per patient), cross-source anomaly detection (15+ checks across financial/pipeline/ads/ops/reputation/website/lead-volume), channel scorecards with efficiency ratings, weekly executive push, auto-generated key insights, lead volume WoW trend detection, zero-lead day alerts, ad frequency monitoring (30d, alert >3.0, critical >4.0), CPL monitoring (7d rolling, alert >$65), LP conversion rate monitoring (alert <5%), CTR fatigue detection (<1.5%)
CANNOT: modify underlying source data

## Lead Pipeline Automation - auto-enrichment, reactivation, monitoring
CAN: auto-enrich new leads from GHL webhook events (research + draft outreach via workflow), source-tag new leads for attribution, reactivate stale leads (7-14 days idle) with personalized re-engagement, draft no-show follow-up messages via workflow, track daily lead volume with source breakdown (data/lead-volume.json), alert on lead volume drops (>40% below 7d avg) and zero-lead business days, detect WoW lead volume trends in executive anomaly scan
RUNS: lead-enrich every 10 min (business hours), stale-leads at 10AM/3PM weekdays, lead-volume at 8PM daily
WORKFLOWS: new-lead-enrich (2-step: research + draft), stale-lead-reactivate (1-step: draft), no-show-followup (1-step: draft)
TAGS APPLIED: source:<channel>, auto-enriched, reactivation-attempted
STATE: data/lead-volume.json (90-day rolling log with source attribution)

## Subagents
CAN: spawn research tasks (sonnet, fire-and-forget), spawn code agents (opus, 200 tools, 90 min default, per-task timeout override, $5 budget cap), max 8 concurrent, task persistence across restarts
CANNOT: run tasks with credentials subagents don't have access to

## Show Rate Engine - Automated appointment reminders + no-show recovery
CAN: scan upcoming appointments (4-day window), send tiered reminders via GHL tags (72h confirmation, 24h logistics, 2h final nudge), detect no-shows and trigger same-day recovery outreach + auto-draft personalized re-engagement via no-show-followup workflow, create staff follow-up tasks for unconfirmed patients, tag contacts at each reminder stage for GHL workflow triggers, daily digest of reminder activity (yesterday + today), stale tag cleanup
RUNS: every 15 min during business hours (7am-8pm Mon-Sat) via cron job "appointment-reminders"
TAGS USED: atlas-reminder-72h, atlas-reminder-24h, atlas-reminder-2h, atlas-noshow-recovery, atlas-appointment-confirmed
DEPENDS ON: GHL workflows must be configured to fire SMS/email when Atlas tags are applied. Atlas handles timing/logic, GHL handles patient-facing delivery.
STATE: data/show-rate-state.json (sent records, daily stats, 14-day retention)

## Website (pvmedispa.com) - WP REST API + Local Dev
CAN: list pages (slug, title, id), get page content by slug or ID, update page content by slug, create blog posts (draft or publish), list/resolve categories, list recent posts, list media, get custom CSS
CANNOT: upload media (planned), delete pages/posts, modify plugins or theme settings, manage users or WP options
TAGS: [WP_UPDATE: page-slug | HTML content], [WP_POST: title | content | status=draft | categories=cat1,cat2]
SAFETY: WP_POST defaults to draft. WP_UPDATE requires user confirmation. Always back up before overwriting.
LOCAL DEV: C:\Users\derek\Local Sites\pv-medispa-weight-loss\ (Local by Flywheel, Kadence theme, WP-CLI via wp.sh)
DEPLOY: WP Engine Git Push for theme/code changes

## Planner (Microsoft) - Graph API via M365 integration
CAN: list plans across all M365 groups, create plans, list/create buckets, list/create/update/complete tasks, get task details (description, notes), move tasks between buckets, assign tasks to users, set due dates and priority, Kanban board view for Telegram
CANNOT: delete plans/buckets/tasks, manage Planner categories/labels, set recurrence, add attachments or checklist items, access Planner outside of M365 groups
COMMANDS: `/planner` (list all), `/planner <name>` (board view), `/planner add <plan> | <bucket> | <task>`, `/planner move <task> | <bucket>`, `/planner done <task>`
TAGS: `[PLANNER_TASK: plan=X | bucket=X | title=X | assignee=email | due=YYYY-MM-DD | description=text]`, `[PLANNER_MOVE: task=X | bucket=X | plan=X]`, `[PLANNER_DONE: task=X | plan=X]`
REQUIRES: Tasks.ReadWrite permission in Azure portal (must be added manually). Group.ReadWrite.All already present.
NOTE: Planner PATCH operations require If-Match ETag headers. The integration handles etag fetching automatically.

## Home Assistant - REST API (Nabu Casa remote + local fallback)
CAN: list all entities by domain, get entity state/attributes, turn on/off/toggle lights/switches/fans, lock/unlock doors, set thermostat temperature/mode/fan, activate scenes, trigger/enable/disable automations, call any HA service, get state history, build dashboard summary
CANNOT: modify HA configuration, install/update integrations, access HA add-ons, stream cameras, send HA notifications (use Telegram instead)

## Recording Studio - Teleprompter + OBS WebSocket
CAN: load teleprompter scripts from scripts/gamma-inputs/ (modules 00-10 + docs), start/stop/reset teleprompter scrolling, set scroll speed and font size, start/stop/pause/resume OBS recording, switch OBS scenes, get OBS recording status (timecode, active scene, scene list), serve teleprompter UI on local network (port 8585) for iPad/Surface access, voice-activated scrolling via WebSpeech API (Chrome only)
CANNOT: upload media to OBS, modify OBS settings (audio, video, filters), stream (recording only), access OBS on remote machines
COMMANDS: /record (status), /record <module> (load script), /record start (record + scroll), /record stop, /record pause, /record resume
REQUIRES: OBS open with WebSocket server enabled (Tools > WebSocket Server Settings), OBS_WS_PASSWORD in .env, teleprompter server running (pm2 start teleprompter or bun run teleprompter/server.ts)
SERVER: teleprompter/server.ts (Bun, port 8585), teleprompter/index.html (web UI)
MODULE: src/obs.ts (obs-websocket-js wrapper)

## Security & Access Control - Telegram user ID-based
AUTH: Telegram user ID allowlist via config/agents.json (per-agent). No IP-based auth or rate limiting.
RATE LIMITING: Message dedup keyed on userId + text (5 min window). Alert emission capped at 10/hour (critical exempt). Claude model fallback on API 429s (opus -> sonnet -> haiku). Circuit breakers on external APIs (GHL, Google, Meta, Dashboard).
NOT APPLICABLE: IP-based rate-limit key normalization (OpenClaw pattern). Atlas is a Telegram bot, not an HTTP server. Telegram handles transport-layer identity.
