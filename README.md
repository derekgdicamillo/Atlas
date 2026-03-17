# Atlas

AI operations platform for PV MediSpa and Weight Loss. Two agent personas (Atlas for Derek, Ishtar for Esther) on the same codebase. Powered by Claude, backed by Supabase, runs 24/7 on Telegram.

Spawns Claude CLI sessions per conversation, manages persistent memory with semantic search, orchestrates 25+ cron jobs, handles Google/GHL/Meta/QuickBooks integrations, and runs autonomous code and research agents overnight.

## What It Does

### Core Platform
- **Telegram bot** via Grammy, supports text, voice, photos, documents, and sticker reactions
- **Dual agent system** with identity-aware routing (Atlas/Ishtar personas, separate Telegram bots)
- **Claude CLI integration** with session resume, model switching (opus/sonnet/haiku), streaming inactivity detection
- **Semantic memory** with OpenAI embeddings (text-embedding-3-small) and hybrid vector + full-text search
- **Entity graph** with 2,500+ nodes (person, org, tool, concept, location) and relationship traversal
- **Knowledge base** with document/folder ingestion, recursive chunking, SHA-256 dedup
- **Conversation history** with ring buffer persistence and nightly summarization

### Business Intelligence
- **Executive intelligence** with cross-source anomaly detection (15+ checks across financial/pipeline/ads/ops/reputation)
- **QuickBooks API** (OAuth2, read-only) for P&L, balance sheet, revenue trends, class-based filtering
- **Supabase business_scorecard** as canonical metrics source with daily and monthly capture
- **GoHighLevel CRM** with pipeline tracking, lead polling, contact actions, workflow enrollment, social planner
- **Google Business Profile** with review monitoring, performance metrics, search keyword tracking
- **Google Analytics 4** with traffic sources, landing pages, conversions, real-time users
- **Meta Ads** with campaign performance, spend tracking, ad management (rename, pause, copy, status)
- **PV Dashboard** (Next.js/Vercel) with financials, pipeline, attribution views

### Marketing & Content
- **Midas marketing intelligence** with daily funnel monitoring, ad digest, weekly attribution, content hooks, competitor recon, GBP drafts, monthly strategic brief
- **Content waterfall** automation: Skool longform -> 3 Facebook hooks -> newsletter -> YouTube outline
- **Content critic** quality gate (brand voice, compliance, engagement, accuracy scoring)
- **Ad creative pipeline** with Hormozi/Brunson/Andromeda frameworks, Gemini image generation
- **GHL Social Planner** for multi-platform post scheduling (Facebook, Instagram, GBP)
- **Mode system** for social media, marketing, and Skool content with auto-detection

### Automation & Agents
- **25+ cron jobs**: heartbeats, journals, morning briefs, executive summaries, ad tracking, lead monitoring, appointment reminders, night shift, marketing intelligence, content generation
- **Code agent spawning** for autonomous multi-file coding (opus, 500 tools, 180 min timeout, $5 cap)
- **Research subagents** for fire-and-forget background tasks (sonnet, parallel execution)
- **Night shift** with Haiku planner + worker for autonomous overnight tasks ($5/night budget)
- **Show rate engine** with tiered appointment reminders (72h, 24h, 2h) and no-show recovery
- **Lead pipeline automation** with enrichment, source tagging, stale lead reactivation, volume tracking
- **Institutional memory (Codex)** with agent lesson recording, keyword search, and confidence decay

### Integrations
- **Google** OAuth2 for Gmail (read, draft, send), Calendar (create, delete, invite), Contacts
- **Microsoft 365** for Planner (task boards), Teams, SharePoint/Loop, OneDrive
- **Home Assistant** via REST API (lights, thermostat, locks, scenes, automations)
- **OBS Studio** via WebSocket for recording automation with teleprompter
- **WordPress** REST API for pvmedispa.com and MAA site management
- **Voice** transcription (Groq/Whisper) and TTS (OpenAI)
- **Gemini** for image generation with structured JSON prompt schema

## Architecture

```
Telegram <-> Grammy Bot <-> Relay (session lock + queue + dedup)
                              |
                              +-> Claude CLI (spawned per message, model routing)
                              +-> Code Agents (opus, 500 tools, streamed progress)
                              +-> Research Subagents (sonnet, fire-and-forget)
                              +-> Supabase (memory, messages, documents, scorecard, tasks)
                              +-> Google APIs (Gmail, Calendar, Contacts)
                              +-> Microsoft 365 (Planner, Teams, SharePoint, OneDrive)
                              +-> Business APIs (GHL, GBP, GA4, Meta, QuickBooks)
                              +-> Cron System (25+ jobs: intel, marketing, content, ops)
                              +-> Home Assistant (smart home control)
                              +-> OBS + Teleprompter (recording automation)
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `src/relay.ts` | Main message handler, command routing, Telegram glue |
| `src/claude.ts` | Claude CLI wrapper with streaming, timeout, model selection |
| `src/supervisor.ts` | Subagent spawning: research tasks and code agents |
| `src/memory.ts` | Fact/goal storage, memory context building |
| `src/search.ts` | Unified hybrid search across all tables |
| `src/conversation.ts` | Ring buffer for recent conversation context |
| `src/summarize.ts` | Nightly conversation compression via haiku |
| `src/google.ts` | Gmail, Calendar, Contacts integration |
| `src/metrics-engine.ts` | Canonical business metrics: Supabase scorecard capture and query |
| `src/dashboard.ts` | PV Dashboard API: financials, pipeline, QuickBooks integration |
| `src/executive.ts` | Cross-source analytics, full-funnel view, anomaly detection |
| `src/marketing.ts` | Midas marketing intelligence: funnel monitor, ad digest, attribution, hooks, recon |
| `src/ghl.ts` | GoHighLevel CRM: pipeline tracking, lead polling, ops, social planner |
| `src/ghl-social.ts` | GHL Social Planner: multi-platform post scheduling |
| `src/gbp.ts` | Google Business Profile: reviews, performance, search keywords |
| `src/analytics.ts` | Google Analytics 4: traffic, conversions, realtime users |
| `src/meta.ts` | Meta Ads API: campaign performance, spend, ad management |
| `src/modes.ts` | Mode system: social, marketing, skool with auto-detection |
| `src/cron.ts` | 25+ scheduled jobs (intel, marketing, content, ops, overnight) |
| `src/night-shift.ts` | Autonomous overnight work: Haiku planner + worker pipeline |
| `src/show-rate.ts` | Appointment reminders (72h/24h/2h) and no-show recovery |
| `src/website.ts` | WordPress REST API: page updates, blog posts, CSS management |
| `src/maa-blog.ts` | MAA WordPress: blog publishing, category management |
| `src/gemini-image.ts` | Gemini image generation with structured JSON prompt schema |
| `src/obs.ts` | OBS WebSocket: recording automation, scene switching |
| `src/capability-registry.ts` | Auto-generates capabilities.md from registered integrations |
| `src/heartbeat.ts` | Proactive check-ins during active hours |
| `src/transcribe.ts` | Voice-to-text via Groq |
| `src/tts.ts` | Text-to-speech via OpenAI |

### Edge Functions (Supabase)

| Function | Purpose |
|----------|---------|
| `embed` | Auto-generates OpenAI embeddings on INSERT (triggered by pg_net webhook) |
| `search` | Vector-only or hybrid search with RRF fusion across all tables |
| `ingest` | Document chunking (~512 tokens), SHA-256 dedup, knowledge base ingestion |
| `maa-search` | Semantic search for MAA knowledge base content |

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated
- Supabase project with pgvector extension
- Telegram bot token (from @BotFather)
- OpenAI API key (for embeddings, stored in Supabase secrets)

### Quick Start

```bash
# Clone and install
git clone https://github.com/derekgdicamillo/Atlas.git
cd Atlas
bun install

# Configure
cp .env.example .env    # Fill in your keys
cp config/profile.example.md config/profile.md  # Customize your profile

# Run database migrations
# Paste db/schema.sql into Supabase SQL Editor
# Then paste db/migrations/001_enterprise_search.sql

# Deploy Edge Functions
npx supabase functions deploy embed --project-ref <ref> --no-verify-jwt
npx supabase functions deploy search --project-ref <ref> --no-verify-jwt
npx supabase functions deploy ingest --project-ref <ref> --no-verify-jwt

# Start
bun run src/relay.ts

# Or with PM2 (recommended for production)
pm2 start ecosystem.config.cjs --only atlas
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `GROQ_API_KEY` | Groq API key for voice transcription |
| `CLAUDE_TIMEOUT_MS` | Base timeout for Claude CLI (default: 300000) |
| `CLAUDE_INACTIVITY_MS` | Streaming inactivity timeout (default: 120000) |
| `CLAUDE_MAX_WALL_MS` | Max wall clock per invocation (default: 900000) |
| `CLIENT_ID` | Google OAuth2 client ID |
| `CLIENT_SECRET` | Google OAuth2 client secret |
| `REFRESH_TOKEN_DEREK` | OAuth2 refresh token for primary account |
| `REFRESH_TOKEN_ATLAS` | OAuth2 refresh token for send account |
| `CALENDAR_ID` | Google Calendar ID |
| `DASHBOARD_URL` | PV Dashboard base URL |
| `DASHBOARD_API_TOKEN` | Bearer token for dashboard API |
| `GHL_API_TOKEN` | GoHighLevel private integration token |
| `GHL_LOCATION_ID` | GoHighLevel location ID |
| `META_ACCESS_TOKEN` | Meta Marketing API access token |
| `META_AD_ACCOUNT_ID` | Meta ad account ID |
| `GBP_ACCOUNT_ID` | Google Business Profile account ID |
| `GBP_LOCATION_ID` | Google Business Profile location ID |
| `GA4_PROPERTY_ID` | Google Analytics 4 property ID |
| `QB_CLIENT_ID` | QuickBooks OAuth2 client ID |
| `QB_CLIENT_SECRET` | QuickBooks OAuth2 client secret |
| `HA_URL` | Home Assistant URL (Nabu Casa or local) |
| `HA_TOKEN` | Home Assistant long-lived access token |
| `OBS_WS_PASSWORD` | OBS WebSocket server password |
| `GEMINI_API_KEY` | Google Gemini API key for image generation |
| `MAA_WP_APP_PASSWORD` | WordPress app password for MAA site |

Google OAuth credentials are configured via `bun run setup/google-auth.ts`. GBP account/location IDs can be discovered with `bun run setup/discover-google-ids.ts`. QuickBooks OAuth2 via `src/dashboard.ts` endpoints.

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/model <opus\|sonnet\|haiku>` | Switch Claude model |
| `/status` | Session info, model, costs, memory stats |
| `/memory` | View/search stored facts and goals |
| `/memory search <query>` | Semantic memory search |
| `/todo` | View and manage todos |
| `/inbox` | Check Gmail inbox |
| `/cal` | View upcoming calendar events |
| `/ingest <text>` | Add text to knowledge base |
| `/session reset` | Clear session and conversation history |
| `/timeout <seconds>` | Override timeout for next message |
| `/finance` | QuickBooks financial summary |
| `/pipeline` | GHL pipeline overview |
| `/scorecard` | Business scorecard with key metrics |
| `/leads` | Recent lead activity |
| `/stl` | Speed-to-lead metrics |
| `/ops` | Live operations dashboard (pipeline, no-shows, stale leads) |
| `/reviews` | Google Business Profile review summary |
| `/visibility [days]` | GBP impressions, clicks, calls, search keywords |
| `/traffic [days]` | GA4 traffic overview, sources, landing pages |
| `/conversions [days]` | GA4 conversion events and daily trends |
| `/executive [week\|month]` | Full-funnel executive report |
| `/alerts` | Cross-source anomaly detection |
| `/channels` | Lead source scorecards with close rates |
| `/weekly` | Comprehensive weekly business summary |
| `/ads [range]` | Meta Ads performance (today, 7d, 30d, mtd) |
| `/adspend [range]` | Ad spend breakdown |
| `/topcreative [range]` | Top performing ad creatives |
| `/social` | Social media content mode + GHL Social Planner |
| `/marketing` | Marketing strategy mode |
| `/skool` | Skool community content mode |
| `/coach` | Personal fitness coaching mode |
| `/mode` | List, switch, or clear active mode |
| `/code <dir> <instructions>` | Spawn autonomous code agent |
| `/executive [week\|month]` | Full-funnel executive report |
| `/alerts` | Cross-source anomaly detection |
| `/planner [name]` | Microsoft Planner board view |
| `/ha [command]` | Home Assistant smart home control |
| `/record [module]` | OBS recording with teleprompter |
| `/careplan <data>` | GLP-1 clinical care plan generator |
| `/diagnose` | Atlas system health check |
| `/help` | Show all commands |

## Enterprise Search System

Atlas uses a hybrid search pipeline combining vector similarity and full-text search with Reciprocal Rank Fusion (RRF) scoring.

### Tables

- **messages** -- all Telegram conversations (auto-embedded)
- **memory** -- stored facts and goals (auto-embedded)
- **documents** -- chunked knowledge base from ingested files (auto-embedded)
- **summaries** -- compressed conversation history from nightly cron (auto-embedded)

### Search Flow

1. Query hits the `search` Edge Function
2. OpenAI generates a 1536-dim embedding for the query
3. Vector search finds semantically similar content (HNSW index)
4. Full-text search finds keyword matches (GIN index on tsvector)
5. RRF fuses both result sets into a single ranked list
6. Results returned grouped by source table

### Document Ingestion

Send a `.txt` or `.md` file to Atlas on Telegram, or use `/ingest` with text. Files are:
- Recursively chunked to ~512 tokens with 50-token overlap
- Deduplicated via SHA-256 content hash
- Auto-embedded via the webhook pipeline

Obsidian vault sync: `bun run setup/ingest-obsidian.ts --vault <path>`

### Conversation Summarization

A nightly cron job at 1:00 AM:
- Finds messages older than 48 hours that haven't been summarized
- Batches them into groups of 50
- Generates 2-3 sentence summaries via Claude haiku
- Stores summaries with embeddings for future search

## Google Integration

Two-account OAuth2 setup:
- **Derek's account** -- read inbox, read/create calendar events, lookup contacts
- **Atlas account** -- send emails on behalf of Atlas

Atlas parses Claude's output for action tags:
- `[DRAFT: subject] body` -- draft an email
- `[SEND: recipient] body` -- send an email
- `[CAL_ADD: title | date | time]` -- create calendar event
- `[CAL_REMOVE: event_id]` -- remove calendar event

## Business Intelligence

Atlas pulls live data from multiple sources and fuses them into a unified executive view.

### Data Sources

| Source | Module | Data |
|--------|--------|------|
| PV Dashboard (Vercel) | `dashboard.ts` | GoHighLevel pipeline, Meta Ads, QuickBooks financials |
| GoHighLevel Direct | `ghl.ts` | Live pipeline counts, new lead alerts, no-show/stale detection |
| Google Business Profile | `gbp.ts` | Reviews, performance metrics, search keywords |
| Google Analytics 4 | `analytics.ts` | Traffic, conversions, landing pages, realtime users |
| Meta Ads | `meta.ts` | Campaign performance, spend, CPL, CTR |

### Executive Intelligence

The `executive.ts` module combines all sources into:
- **Full-funnel view**: ad spend -> impressions -> clicks -> leads -> consults -> won patients -> revenue -> profit
- **Key metrics**: ROAS, CAC, lead-to-close rate, profit per patient
- **Anomaly detection**: 10+ cross-source checks (margin compression, stale leads, high CPL, slow STL, low reviews)
- **Channel scorecards**: per-source attribution with close rates and efficiency ratings
- **Weekly push**: automated Sunday 6PM executive summary via Telegram

### Morning Brief

Daily 6AM Telegram message combining:
- Financial pulse (revenue, expenses, profit margin)
- Pipeline pulse (new leads, consults, won patients)
- GBP snapshot (impressions, review summary)
- GA4 snapshot (sessions, engagement, conversions)

## Mode System

Modes inject specialized prompts for content generation workflows.

| Mode | Command | Purpose |
|------|---------|---------|
| Social | `/social` | Social media content creation |
| Marketing | `/marketing` | Marketing strategy and copywriting |
| Skool | `/skool` | Vitality Unchained community content |

Modes auto-detect from message keywords and persist per session. Each mode has a dedicated prompt file in `config/modes/`.

## Subagent System

Atlas can spawn independent Claude instances for background work.

### Research Subagents
- Fire-and-forget tasks that write output to `data/task-output/`
- Default model: sonnet, max 5 concurrent across all types
- Tag format: `[TASK: description | OUTPUT: filename.md | PROMPT: instructions]`

### Code Agents
- Autonomous coding with streamed progress updates to Telegram
- Default model: opus, 500 tool call limit, 180 min wall clock, $5 budget cap
- Command: `/code <project_dir> <instructions>`
- Self-delegation tag: `[CODE_TASK: cwd=<dir> | PROMPT: instructions]` (optional: `| TIMEOUT: 120m`)
- Progress updates every 60s showing tool name, file, and running cost
- Task persistence via Supabase `agent_tasks` table (survives restarts)
- Institutional memory (Codex): lessons learned from completed agents injected into future prompts

## Process Management

Atlas runs under PM2 for auto-restart on crash:

```bash
pm2 start ecosystem.config.cjs --only atlas
pm2 logs atlas          # View logs
pm2 restart atlas       # Restart
pm2 status              # Check status
```

## Versioning

This project uses [Semantic Versioning](https://semver.org/). See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

Private repository. Not licensed for redistribution.
