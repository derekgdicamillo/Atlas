# S.A.G.E. Knowledge Engine - Design Spec

**Date:** 2026-03-20
**Author:** Derek + Claude
**Status:** Reviewed (v2, all issues resolved)
**Repos:** atlas (C:\Users\derek\Projects\atlas), maa-advisor (C:\Users\derek\Projects\maa-advisor)

## Problem Statement

S.A.G.E. (Strategic Aesthetics Guidance Engine) is the AI practice advisor for TMAA members. Its knowledge base is broken and narrow:

1. **The nightly scraper never runs.** The `maa-scrape` task type depends on the night-shift Haiku planner, which consistently ignores the instruction to include it. `maa-scraper-state.json` doesn't exist. The `maa_knowledge` table has sporadic data at best.
2. **Only 4 regulatory topics per state.** No coverage for treatments, OSHA, marketing compliance, hiring, standards of care, or business strategy.
3. **No feedback loop.** User conversations are stored in `maa_conversations` but never analyzed. S.A.G.E. has no mechanism to learn from what users actually ask or where answers are weak.
4. **RAG retrieval is state-only.** National knowledge (OSHA, treatment tech, marketing strategy) is invisible when a state is detected in the user's question.

## Goals

- Build the most comprehensive AI knowledge base in the aesthetics industry
- Reliable nightly knowledge acquisition across 15 topic categories and 50 states
- Self-learning system: user questions drive research priorities and knowledge improvements
- Quality-gated content with scoring and flagging before database insertion
- Weighted RAG retrieval that surfaces both state-specific and national knowledge

## Architecture: Approach B (Research Engine)

Hybrid knowledge architecture:
- **Static prompt modules** (base.ts, regulatory.ts, business.ts, etc.) serve as the knowledge "floor" - general principles that rarely change, updated monthly by sage-audit code agent
- **Dynamic RAG from `maa_knowledge`** serves as the "ceiling" - specific, current, state-level and national data across 15 categories
- Weekly conversation analysis identifies gaps and drives targeted research

## Topic Taxonomy (15 Categories)

### State-Specific (6) - researched per state

| Category | Label | Refresh Cadence |
|----------|-------|-----------------|
| `scope_of_practice` | Scope of Practice | 30 days |
| `medspa_compliance` | MedSpa Compliance & CPOM | 30 days |
| `delegation_supervision` | Delegation & Supervision | 30 days |
| `business_entity` | Business Entity & Formation | 45 days |
| `marketing_compliance` | Marketing Compliance (state-specific) | 30 days |
| `insurance_malpractice` | Insurance & Malpractice | 45 days |

### National (9) - researched once, updated on rotation

| Category | Label | Refresh Cadence |
|----------|-------|-----------------|
| `osha_safety` | OSHA & Workplace Safety | 30 days |
| `hipaa_compliance` | HIPAA Compliance | 30 days |
| `treatment_technology` | Treatment Technology & Devices | 14 days |
| `standards_of_care` | Standards of Care & Protocols | 21 days |
| `hiring_staffing` | Hiring & Staffing | 30 days |
| `business_strategy` | Business Strategy & Scaling | 21 days |
| `marketing_strategy` | Marketing Strategy & Patient Acquisition | 21 days |
| `revenue_optimization` | Revenue Optimization | 30 days |
| `patient_experience` | Patient Experience & Retention | 30 days |

## Database Schema Changes

### Expand `maa_knowledge`

The existing table has a `topic` column. We rename it to `category` to match the new taxonomy, migrate existing data, and allow multiple chunks per state+category (the old 1-per-state-per-topic constraint was too restrictive for deep knowledge).

```sql
-- Rename topic -> category (preserves existing data)
ALTER TABLE maa_knowledge RENAME COLUMN topic TO category;

-- Add new columns
ALTER TABLE maa_knowledge
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'state',
  ADD COLUMN quality_score REAL,
  ADD COLUMN refresh_cadence_days INTEGER DEFAULT 17,
  ADD COLUMN demand_score REAL DEFAULT 0,
  ADD COLUMN source_count INTEGER DEFAULT 0,
  ADD COLUMN flagged BOOLEAN DEFAULT FALSE;

-- Drop old unique constraint (was 1 chunk per state+topic)
DROP INDEX IF EXISTS idx_maa_knowledge_state_topic;

-- New constraint: allow multiple chunks per state+category, deduplicate by content hash
CREATE UNIQUE INDEX idx_maa_knowledge_chunk_dedup
  ON maa_knowledge (state_code, category, chunk_hash);

-- Refresh scheduling index
CREATE INDEX idx_maa_knowledge_refresh
  ON maa_knowledge (last_verified_at, refresh_cadence_days);

-- Category + scope index for retrieval filtering
CREATE INDEX idx_maa_knowledge_category_scope
  ON maa_knowledge (category, scope);
```

**Multiple chunks per category:** A state like Texas may have 3 chunks under `scope_of_practice`: one for NPs, one for PAs, one for estheticians. National categories like `treatment_technology` can have many chunks covering different treatments. Deduplication happens via `chunk_hash` (SHA-256 of content), not category uniqueness.

**Migration note:** This migration lives in `maa-advisor/db/004_sage_engine.sql` (after existing `003_request_id.sql`). The `maa_upsert_knowledge` RPC function must also be replaced:

```sql
CREATE OR REPLACE FUNCTION maa_upsert_knowledge(
  p_state_code TEXT,
  p_category TEXT,
  p_title TEXT,
  p_content TEXT,
  p_source_url TEXT DEFAULT NULL,
  p_source_name TEXT DEFAULT NULL,
  p_embedding VECTOR(1536) DEFAULT NULL,
  p_chunk_hash TEXT DEFAULT NULL,
  p_scope TEXT DEFAULT 'state',
  p_quality_score REAL DEFAULT NULL,
  p_demand_score REAL DEFAULT 0,
  p_source_count INTEGER DEFAULT 0,
  p_flagged BOOLEAN DEFAULT FALSE,
  p_refresh_cadence_days INTEGER DEFAULT 17
)
RETURNS UUID AS $$
DECLARE
  result_id UUID;
BEGIN
  INSERT INTO maa_knowledge (
    state_code, category, title, content, source_url, source_name,
    embedding, chunk_hash, scope, quality_score, demand_score,
    source_count, flagged, refresh_cadence_days,
    last_verified_at, updated_at
  ) VALUES (
    p_state_code, p_category, p_title, p_content, p_source_url, p_source_name,
    p_embedding, p_chunk_hash, p_scope, p_quality_score, p_demand_score,
    p_source_count, p_flagged, p_refresh_cadence_days,
    NOW(), NOW()
  )
  ON CONFLICT (state_code, category, chunk_hash)
  DO UPDATE SET
    title = EXCLUDED.title,
    content = EXCLUDED.content,
    source_url = EXCLUDED.source_url,
    source_name = EXCLUDED.source_name,
    embedding = EXCLUDED.embedding,
    scope = EXCLUDED.scope,
    quality_score = EXCLUDED.quality_score,
    demand_score = EXCLUDED.demand_score,
    source_count = EXCLUDED.source_count,
    flagged = EXCLUDED.flagged,
    refresh_cadence_days = EXCLUDED.refresh_cadence_days,
    last_verified_at = NOW(),
    updated_at = NOW()
  RETURNING id INTO result_id;
  RETURN result_id;
END;
$$ LANGUAGE plpgsql;
```

### New `sage_question_trends` table

```sql
CREATE TABLE sage_question_trends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL,
  category TEXT NOT NULL,
  state_code TEXT,
  question_count INTEGER DEFAULT 0,
  sample_questions TEXT[],
  avg_answer_quality REAL,
  knowledge_gap_detected BOOLEAN DEFAULT FALSE,
  gap_description TEXT,
  research_priority INTEGER,
  researched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sage_trends_week ON sage_question_trends (week_start, category);
CREATE INDEX idx_sage_trends_gaps ON sage_question_trends (knowledge_gap_detected, researched_at)
  WHERE knowledge_gap_detected = TRUE;
```

### Add category to `maa_conversations`

```sql
ALTER TABLE maa_conversations ADD COLUMN category TEXT;
```

Populated by weekly analyzer (not at write time). Maps to the 15-category taxonomy.

## New Modules

### 1. Topic Registry (`src/sage-topics.ts`)

Config-driven registry defining every knowledge category:

```typescript
export interface TopicConfig {
  category: string;
  label: string;
  scope: 'state' | 'national';
  refreshCadenceDays: number;
  researchPromptTemplate: string;   // with {{state_name}}, {{state_code}} placeholders
  qualityCriteria: string[];
  intentKeywords: string[];
}

export const TOPIC_REGISTRY: TopicConfig[] = [
  // 6 state-specific + 9 national = 15 total
];
```

Adding a new topic = adding one object to this array. No other code changes required.

Each topic has:
- A purpose-built research prompt template (not generic)
- Quality criteria the gate checks for (e.g., `statute_citation` for regulatory, `clinical_evidence` for treatments)
- Intent keywords for cheap classification of user questions
- `hedgingExemptions`: optional list of phrases that should NOT be penalized for regulatory categories (e.g., "varies by state", "check with your board" are correct answers, not hedging)

### 2. Research Engine (`src/sage-research.ts`)

Orchestrates all knowledge acquisition through three tracks:

**Track 1: State Regulatory Sweep (Daily 10:30 PM)**
- Selects 2-3 states per night
- Researches all 6 state-specific topics per state
- State selection priority:
  1. States with knowledge gaps flagged by analyzer
  2. Priority states (TX, CA, FL, NY, AZ) if not verified in 14 days
  3. Round-robin remaining states, weighted by demand_score
  4. Skip states verified within their refresh_cadence_days
- Budget: ~$2/night

**Track 2: National Topic Rotation (Daily 10:45 PM)**
- Cycles through 9 national topics, 2-3 per night
- Full cycle every ~4 days
- Topics needing refresh (past their cadence) go first
- Budget: ~$1.50/night

**Track 3: Demand-Driven Research (Sunday 11 PM)**
- Reads gap report from weekly analyzer
- Researches Priority 1 gaps first, then Priority 2
- Deep-dives: longer prompts, more thorough research
- Budget: ~$3/run

**Research pipeline per chunk:**

1. Build prompt from `TopicConfig.researchPromptTemplate`
2. Call Claude Sonnet with web search tools enabled
3. Parse structured JSON output (title, content, sources)
4. Quality gate: Haiku scores chunk against qualityCriteria
   - Score >= 0.7: upsert to maa_knowledge
   - Score 0.4-0.69: upsert + set flagged=true
   - Score < 0.4: reject, keep existing chunk, log error
5. Generate embedding via `embed` Edge Function
6. Upsert with scope, category, quality_score, demand_score

**State file:** `data/sage-research-state.json` tracks last-verified timestamps per state+category, round-robin indices, and cumulative stats. The state file is scope-aware: state sweep and national sweep track their own indices independently within the same file.

**Concurrency:** Track 1 (state sweep) and Track 2 (national sweep) can run concurrently. They target different scopes (state vs. national) and write to different rows in `maa_knowledge`. The state file uses scope-keyed sections (`stateRoundRobinIndex`, `nationalRoundRobinIndex`) so both tracks can read/write without conflicts.

**Status reporting:** `sage-research.ts` exports a `getResearchStatus()` function (replacing the old `getScraperStatus()` from `maa-scraper.ts`) for use in the morning brief. Returns: states verified count, national topics coverage, last run timestamps, flagged chunk count, and weekly gap summary.

**Web search implementation:** The current `runPrompt()` in `src/prompt-runner.ts` spawns Claude CLI via `bun spawn` without web search tools. The research engine requires web search for factual, sourced content. The solution is a new `runResearchPrompt()` function that calls the Anthropic Messages API directly (not via CLI) with the web search tool enabled:

```typescript
// In sage-research.ts or a shared utility
async function runResearchPrompt(prompt: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  // Extract text content from tool_use + text blocks
}
```

This bypasses the CLI entirely for research calls. Direct API call is more reliable for structured tool use and avoids the overhead of spawning a subprocess per research prompt. The `ANTHROPIC_API_KEY` is already in Atlas's `.env`.

### 3. Conversation Analyzer (`src/sage-analyzer.ts`)

Weekly batch job (Sunday 8 PM) that mines user conversations for intelligence.

**Pipeline:**

1. **Pull conversations:** All `maa_conversations` from past 7 days, grouped by session. Queries via `SUPABASE_SERVICE_ROLE_KEY` (already in Atlas `.env`) since `maa_conversations` is owned by the maa-advisor worker but Atlas needs read access for analysis.
2. **Classify by category:** Keyword match against `TopicConfig.intentKeywords` (free). Ambiguous messages batched to Haiku (~$0.01-0.05)
3. **Score answer quality:** Heuristic-based, no Claude call:
   - Hedging language ("I'm not sure", "I don't have specific"): -0.3
   - Follow-up clarification by user: -0.2
   - Source citation in response: +0.2
   - Specific numbers/dates: +0.1
   - Short response (<100 words) on substantive question: -0.1
   - Baseline: 0.5, clamped to 0-1
   - **Domain-aware exemptions:** For regulatory categories (`scope_of_practice`, `delegation_supervision`, `medspa_compliance`, `marketing_compliance`), phrases like "varies by state", "check with your board", "consult a healthcare attorney" are NOT penalized. These are correct, responsible answers for regulatory questions. Exemption phrases defined per topic via `TopicConfig.hedgingExemptions`.
4. **Aggregate:** Group by (category, state_code) per week. Count questions, collect samples, average quality.
5. **Detect gaps:**
   - avg_answer_quality < 0.5 AND question_count >= 3 (consistently weak)
   - question_count >= 5 AND no matching maa_knowledge chunk exists
   - Category has zero chunks but users are asking
   - Questions outside all 15 categories (signals new category needed)
6. **Prioritize gaps:**
   - Priority 1 (critical): volume 10+ AND quality < 0.4
   - Priority 2 (moderate): volume 5-9 AND low quality, OR high volume AND no chunk
   - Priority 3 (low): volume 3-4 AND quality concerns
7. **Write to `sage_question_trends`** table
8. **Update `demand_score`** on matching maa_knowledge chunks
9. **Output `data/sage-gap-report.json`** for demand research track
10. **Telegram digest** to Derek with gap summary

**Cost:** ~$0.10/week (mostly free keyword matching, small Haiku batch for ambiguous messages)

## RAG Retrieval Upgrade

### Updated Edge Function `maa-search`

**New input:**
```json
{
  "query": "...",
  "state_code": "TX",
  "categories": ["osha_safety", "medspa_compliance"],
  "match_count": 8,
  "match_threshold": 0.45
}
```

**Weighted scoring query:**
```sql
WITH scored AS (
  SELECT *,
    (1 - (embedding <=> query_embedding)) AS vector_sim,
    CASE
      WHEN state_code = $state_code THEN 0.15
      WHEN state_code IS NULL THEN 0.05
      ELSE -0.3
    END AS scope_boost,
    CASE WHEN category = ANY($categories) THEN 0.10 ELSE 0 END AS category_boost,
    COALESCE(quality_score, 0.5) * 0.05 AS quality_boost,
    LEAST(demand_score * 0.02, 0.10) AS demand_boost
  FROM maa_knowledge
  WHERE NOT flagged
)
SELECT *, (vector_sim + scope_boost + category_boost + quality_boost + demand_boost) AS final_score
FROM scored
WHERE vector_sim >= $match_threshold
ORDER BY final_score DESC
LIMIT $match_count
```

**Key changes:**
- Match count increased from 5 to 8 (accommodate mixed state/national results)
- National chunks (NULL state_code) get small boost instead of being filtered out
- Category matching from intent classification improves relevance
- Quality and demand scores influence ranking
- Flagged chunks excluded from retrieval

**RPC function update:** The current `maa_search_knowledge` RPC function (defined in `maa-advisor/db/002_knowledge.sql`) references the old `topic` column and does simple vector distance without boosts. Replace with `maa_search_knowledge_v2` implementing the weighted query above. The Edge Function `maa-search` switches from calling the old RPC to calling `maa_search_knowledge_v2`. The old RPC can be dropped after deployment.

**Embedding input truncation:** The `embed` Edge Function truncates input to 2000 characters. Research chunks target 300-500 words (~1500-2500 chars). To ensure the title is always embedded, the embedding input format is `title + "\n" + content.substring(0, 1800)` rather than raw concatenation.

### Worker changes (maa-advisor)

`worker/src/rag.ts`: Update `searchKnowledge()` to pass categories array derived from intent classification. Lightweight mapping from intent names to category names. Also update the `KnowledgeChunk` interface: rename `topic: string` to `category: string` to match the renamed database column.

## Cron Schedule

| Job | Cron | Model | Budget | Dependency |
|-----|------|-------|--------|------------|
| `sage-state-sweep` | `30 22 * * *` (daily 10:30 PM) | Sonnet | $2/night | None |
| `sage-national-sweep` | `45 22 * * *` (daily 10:45 PM) | Sonnet | $1.50/night | None |
| `sage-analyzer` | `0 20 * * 0` (Sunday 8 PM) | Haiku | $0.10/run | None |
| `sage-demand-research` | `0 23 * * 0` (Sunday 11 PM) | Sonnet | $3/run | Analyzer output |
| `sage-audit` | `30 10 1 * *` (1st 10:30 AM) | Sonnet agent | $5/run | Existing, no change |
| `maa-blog` | `0 9 * * 2,5` (Tue/Fri 9 AM) | Sonnet | $0.15/post | Existing, no change |

**Total estimated cost:** ~$90-130/month (variance depends on web search round-trips per research call)

All jobs are dedicated `CronJob.from()` entries in `cron.ts`, wrapped in `safeTick()`. Not dependent on night-shift planner.

## Files Touched

| File | Repo | Action |
|------|------|--------|
| `src/sage-research.ts` | atlas | **New** - Research engine (3 tracks, direct API calls with web search) |
| `src/sage-analyzer.ts` | atlas | **New** - Weekly conversation analyzer + gap detection |
| `src/sage-topics.ts` | atlas | **New** - Topic registry (15 categories with configs) |
| `src/cron.ts` | atlas | **Edit** - Add 4 new crons, remove maa-scrape night-shift instruction |
| `src/night-shift.ts` | atlas | **Edit** - Remove maa-scrape type and handler |
| `src/maa-scraper.ts` | atlas | **Delete** - Replaced by sage-research.ts |
| `src/maa-blog.ts` | atlas | **No change** |
| Any morning-brief code referencing `getScraperStatus()` | atlas | **Edit** - Replace with `getResearchStatus()` |
| `worker/src/rag.ts` | maa-advisor | **Edit** - Pass categories, update searchKnowledge |
| `worker/src/conversation.ts` | maa-advisor | **No change** |
| `db/004_sage_engine.sql` | maa-advisor | **New** - Schema migration (maa_knowledge columns, sage_question_trends, RPC v2) |
| Edge Function `maa-search` | Supabase | **Edit** - Switch to `maa_search_knowledge_v2` RPC, pass categories |

## Self-Learning Loop Summary

```
Users ask questions
  → Stored in maa_conversations
  → Weekly analyzer classifies and scores
  → Gaps detected, priorities assigned
  → Demand research fills gaps
  → Quality gate validates new content
  → maa_knowledge updated with better chunks
  → demand_score boosts popular topics in retrieval
  → Next time user asks, S.A.G.E. has better knowledge
```

Meanwhile, nightly sweeps keep the full 15-category x 50-state matrix fresh on a rolling basis regardless of user demand. The analyzer accelerates what matters most, but nothing goes stale.

## What Gets Removed

- `maa-scrape` task type from night-shift planner and worker
- `src/maa-scraper.ts` (replaced by `src/sage-research.ts`)
- Night-shift planner instruction to include maa-scrape tasks

## What Stays Unchanged

- `maa-blog` cron (Tue/Fri, working fine)
- `sage-audit` monthly code agent (still updates static prompt modules)
- Night-shift planner (still runs for non-SAGE tasks)
- S.A.G.E. worker authentication, intent classification, streaming (no changes)
- `maa_conversations` write path (no changes at write time)

## Risk Considerations

- **Web search resolved:** Research engine uses direct Anthropic API calls with `web_search_20250305` tool, bypassing the CLI and `runPrompt()`. No blocker.
- **sage-audit auto-deploy:** Existing risk. The monthly code agent runs `npx wrangler deploy` autonomously. Out of scope for this spec but flagged for future improvement (branch + review instead).
- **Edge Function `embed` dependency:** If the embedding Edge Function is down, new chunks can't be inserted. Research engine retries once, then skips the chunk and logs. Existing chunk stays in the database.
- **Migration on live table:** The `topic` to `category` rename and new columns use `ALTER TABLE RENAME COLUMN` and `ADD COLUMN ... DEFAULT` which are safe on live Postgres. Default values ensure backward compatibility. Existing data preserved.
- **Multiple chunks per category:** The relaxed constraint (dedup by chunk_hash instead of category uniqueness) means research prompts must be structured to produce distinct sub-chunks per topic. The prompt templates should specify how to break down a category into sub-topics (e.g., "produce one chunk per provider type: NP, PA, esthetician").
- **Cross-repo dependency:** Schema migration in `maa-advisor/db/`, Edge Function in Supabase, cron code in Atlas. Deploy order matters: migration first, then Edge Function, then Atlas code.
