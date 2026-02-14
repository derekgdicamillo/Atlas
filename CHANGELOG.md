# Changelog

All notable changes to Atlas are documented here. This project uses [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-02-14

### Added
- **Enterprise Search System** -- hybrid vector + full-text search with RRF fusion across all tables
- **Document ingestion** -- recursive chunking (~512 tokens), SHA-256 dedup, auto-embed pipeline
- **Conversation summarization** -- nightly cron compresses messages older than 48h into searchable summaries
- **Knowledge base** (`documents` table) with chunk indexing and content hashing
- **Summaries** table for compressed conversation history
- **HNSW indexes** on all embedding columns for fast approximate nearest neighbor search
- **GIN indexes** on tsvector columns for full-text search
- **`hybrid_search` RPC** -- unified search with Reciprocal Rank Fusion scoring
- **`match_documents` and `match_summaries` RPCs** for single-table vector search
- **`ingest` Edge Function** for document chunking and dedup
- **`/ingest` command** to manually add text to the knowledge base
- **Auto-ingest** of .txt/.md files sent via Telegram
- **Obsidian vault sync** script (`setup/ingest-obsidian.ts`)
- **Semantic `/memory search`** replaces old ilike-based search
- **Cost tracking** for embeddings and searches in `/status`
- **`src/search.ts`** -- central search module replacing scattered search calls
- **`src/summarize.ts`** -- conversation compression module
- **Conversation context system** (`src/conversation.ts`) with ring buffer and message accumulator
- Search feature flag in `agents.json`

### Changed
- **`search` Edge Function** -- added hybrid mode, multi-table support, cost logging
- **`embed` Edge Function** -- added cost tracking, support for documents/summaries tables
- **`src/memory.ts`** -- delegates to enterprise search when feature flag is on
- **`src/relay.ts`** -- unified message handler, late-binding context, search wiring
- **`src/cron.ts`** -- added nightly summarization job at 1:00 AM
- **`package.json`** -- bumped to 2.0.0

## [1.5.0] - 2026-02-14

### Added
- **Google integration** -- two-account OAuth2 for Gmail, Calendar, and Contacts
- Gmail read, draft, and send via action tags
- Calendar event creation and removal
- Contact lookup via People API
- `/inbox` and `/cal` commands
- `google` feature flag in agents.json

## [1.4.0] - 2026-02-13

### Added
- **Streaming inactivity detection** -- replaces fixed wall-clock timeout
- Model-specific timeout multipliers (opus 3x, sonnet 2x, haiku 1x)
- "Still working..." progress updates every 60s during long tasks
- `/timeout` command for runtime override
- Session auto-recovery on corrupted sessions

### Changed
- Timeout system rewritten from fixed to adaptive

## [1.3.0] - 2026-02-12

### Added
- **Resilience upgrades** -- session auto-recovery, cron safeTick, heartbeat backoff
- Delivery queue for message reliability
- Multi-agent architecture support
- Cron system with timezone-aware scheduling

## [1.2.0] - 2026-02-11

### Added
- **Delegation and sub-agent guidelines** in personality system

## [1.1.0] - 2026-02-10

### Added
- **Voice transcription** via Groq Whisper
- **Text-to-speech** via Edge TTS
- **Supabase memory** with semantic search (vector-only)
- Basic embedding pipeline with `embed` and `search` Edge Functions

## [1.0.0] - 2026-02-09

### Added
- Initial release
- Telegram bot relay with Grammy
- Claude CLI integration with session management
- Basic message handling (text, voice, photos, documents)
- PM2 process management
- Environment-based configuration
