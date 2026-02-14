# Atlas

Personal AI assistant that lives in Telegram. Powered by Claude, backed by Supabase, and designed to actually remember what you tell it.

Atlas spawns a Claude CLI session per conversation, manages persistent memory with semantic search, handles Google Calendar/Gmail, and compresses old conversations into searchable summaries overnight.

## What It Does

- **Telegram bot** via Grammy, supports text, voice, photos, and documents
- **Claude CLI integration** with session resume, model switching (opus/sonnet/haiku), and streaming inactivity detection
- **Semantic memory** with OpenAI embeddings (text-embedding-3-small) and hybrid vector + full-text search
- **Knowledge base** with document ingestion, recursive chunking, and dedup
- **Google integration** for Gmail (read, draft, send), Calendar, and Contacts via OAuth2
- **Conversation history** with ring buffer persistence and nightly summarization
- **Cron system** for heartbeats, daily journals, morning briefs, content generation, backups, and more
- **Todo management** with priority levels and due dates
- **Voice** transcription (Groq/Whisper) and TTS (Edge TTS)

## Architecture

```
Telegram <-> Grammy Bot <-> Relay (session lock + queue)
                              |
                              +-> Claude CLI (spawned per message)
                              +-> Supabase (memory, messages, documents, summaries)
                              +-> Google APIs (Gmail, Calendar, Contacts)
                              +-> Cron Jobs (heartbeat, summarize, backups)
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `src/relay.ts` | Main message handler, command routing, Telegram glue |
| `src/claude.ts` | Claude CLI wrapper with streaming, timeout, model selection |
| `src/memory.ts` | Fact/goal storage, memory context building |
| `src/search.ts` | Unified hybrid search across all tables |
| `src/conversation.ts` | Ring buffer for recent conversation context |
| `src/summarize.ts` | Nightly conversation compression via haiku |
| `src/google.ts` | Gmail, Calendar, Contacts integration |
| `src/cron.ts` | Scheduled jobs (heartbeat, journal, briefs, backups) |
| `src/todo.ts` | Todo CRUD with priorities and due dates |
| `src/heartbeat.ts` | Proactive check-ins during active hours |
| `src/transcribe.ts` | Voice-to-text via Groq |
| `src/tts.ts` | Text-to-speech via Edge TTS |

### Edge Functions (Supabase)

| Function | Purpose |
|----------|---------|
| `embed` | Auto-generates OpenAI embeddings on INSERT (triggered by pg_net webhook) |
| `search` | Vector-only or hybrid search with RRF fusion across all tables |
| `ingest` | Document chunking (~512 tokens), SHA-256 dedup, knowledge base ingestion |

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
pm2 start bun --name atlas -- run src/relay.ts
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

Google OAuth credentials are configured separately via `bun run setup/google-auth.ts`.

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

## Process Management

Atlas runs under PM2 for auto-restart on crash:

```bash
pm2 start bun --name atlas -- run src/relay.ts
pm2 logs atlas          # View logs
pm2 restart atlas       # Restart
pm2 status              # Check status
```

## Versioning

This project uses [Semantic Versioning](https://semver.org/). See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

Private repository. Not licensed for redistribution.
