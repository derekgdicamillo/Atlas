-- ============================================================
-- Migration 021: Cognitive Memory Architecture (CMA)
-- Working memory, consolidated facts, context misses, knowledge gaps
-- ============================================================

-- Working memory state (one active per agent-user pair)
CREATE TABLE IF NOT EXISTS working_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT,
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_agent_user
  ON working_memory(agent_id, user_id);

-- Working memory history (archived on session end / stale detection)
CREATE TABLE IF NOT EXISTS working_memory_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT,
  state JSONB NOT NULL,
  total_turns INTEGER,
  session_duration_ms BIGINT,
  archived_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wmh_agent_time
  ON working_memory_history(agent_id, archived_at DESC);

-- Consolidated facts: typed, decay-aware, structured memory
CREATE TABLE IF NOT EXISTS consolidated_facts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  fact_type TEXT NOT NULL CHECK (fact_type IN (
    'decision', 'artifact', 'config', 'wip', 'blocker', 'insight', 'correction'
  )),
  content TEXT NOT NULL,
  reasoning TEXT,
  source_episode_id UUID,
  embedding vector(1536),
  confidence FLOAT DEFAULT 0.9,
  valence TEXT DEFAULT 'neutral' CHECK (valence IN ('positive', 'negative', 'neutral')),
  valence_intensity FLOAT DEFAULT 0.0,
  is_correction BOOLEAN DEFAULT false,
  decay_half_life_days INTEGER NOT NULL,
  last_accessed TIMESTAMPTZ DEFAULT NOW(),
  access_count INTEGER DEFAULT 0,
  valid_from TIMESTAMPTZ DEFAULT NOW(),
  valid_to TIMESTAMPTZ,
  historical BOOLEAN DEFAULT false,
  superseded_by UUID REFERENCES consolidated_facts(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_facts_agent_type
  ON consolidated_facts(agent_id, fact_type);

CREATE INDEX IF NOT EXISTS idx_facts_valid
  ON consolidated_facts(valid_to) WHERE valid_to IS NULL AND historical = false;

CREATE INDEX IF NOT EXISTS idx_facts_fts
  ON consolidated_facts USING gin (to_tsvector('english', content));

-- HNSW vector index (only if pgvector extension available)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_facts_embedding
      ON consolidated_facts USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)';
  END IF;
END $$;

-- Hybrid search RPC for consolidated facts
CREATE OR REPLACE FUNCTION search_consolidated_facts(
  query_embedding vector(1536),
  query_text TEXT,
  p_agent_id TEXT,
  p_fact_types TEXT[] DEFAULT NULL,
  match_limit INT DEFAULT 10,
  include_historical BOOLEAN DEFAULT false
) RETURNS TABLE (
  id UUID,
  fact_type TEXT,
  content TEXT,
  reasoning TEXT,
  confidence FLOAT,
  score FLOAT,
  created_at TIMESTAMPTZ
) AS $$
WITH semantic AS (
  SELECT cf.id, cf.fact_type, cf.content, cf.reasoning, cf.confidence,
         1 - (cf.embedding <=> query_embedding) AS similarity,
         ROW_NUMBER() OVER (ORDER BY cf.embedding <=> query_embedding) AS rank
  FROM consolidated_facts cf
  WHERE cf.agent_id = p_agent_id
    AND (NOT cf.historical OR include_historical)
    AND (p_fact_types IS NULL OR cf.fact_type = ANY(p_fact_types))
    AND cf.valid_to IS NULL
    AND cf.embedding IS NOT NULL
  ORDER BY cf.embedding <=> query_embedding
  LIMIT match_limit * 2
),
fulltext AS (
  SELECT cf.id, cf.fact_type, cf.content, cf.reasoning, cf.confidence,
         ts_rank(to_tsvector('english', cf.content), plainto_tsquery('english', query_text)) AS rank_score,
         ROW_NUMBER() OVER (
           ORDER BY ts_rank(to_tsvector('english', cf.content),
                           plainto_tsquery('english', query_text)) DESC
         ) AS rank
  FROM consolidated_facts cf
  WHERE cf.agent_id = p_agent_id
    AND (NOT cf.historical OR include_historical)
    AND (p_fact_types IS NULL OR cf.fact_type = ANY(p_fact_types))
    AND cf.valid_to IS NULL
    AND to_tsvector('english', cf.content) @@ plainto_tsquery('english', query_text)
  LIMIT match_limit * 2
)
SELECT
  COALESCE(s.id, f.id) AS id,
  COALESCE(s.fact_type, f.fact_type) AS fact_type,
  COALESCE(s.content, f.content) AS content,
  COALESCE(s.reasoning, f.reasoning) AS reasoning,
  COALESCE(s.confidence, f.confidence) AS confidence,
  (COALESCE(1.0 / (60 + s.rank), 0) + COALESCE(1.0 / (60 + f.rank), 0))::FLOAT AS score,
  NOW() AS created_at
FROM semantic s
FULL OUTER JOIN fulltext f ON s.id = f.id
ORDER BY score DESC
LIMIT match_limit;
$$ LANGUAGE sql;

-- Context miss tracking (feeds anticipatory loading model)
CREATE TABLE IF NOT EXISTS context_misses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  what_was_needed TEXT NOT NULL,
  what_was_loaded TEXT,
  turn_number INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_misses_recent
  ON context_misses(agent_id, created_at DESC);

-- Knowledge gaps (feeds learning queue)
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  context TEXT,
  severity TEXT DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  resolution TEXT DEFAULT 'research' CHECK (resolution IN ('research', 'ask_user', 'observe')),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gaps_unresolved
  ON knowledge_gaps(agent_id) WHERE resolved_at IS NULL;

-- Add temporal validity to existing memory table (if columns don't exist)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory' AND column_name = 'valid_from') THEN
    ALTER TABLE memory ADD COLUMN valid_from TIMESTAMPTZ DEFAULT NOW();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory' AND column_name = 'valid_to') THEN
    ALTER TABLE memory ADD COLUMN valid_to TIMESTAMPTZ;
  END IF;
END $$;

-- Add causal edge types to existing graph (if column doesn't exist)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_edges' AND column_name = 'edge_type') THEN
    ALTER TABLE memory_edges ADD COLUMN edge_type TEXT DEFAULT 'relates_to';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_edges' AND column_name = 'occurred_at') THEN
    ALTER TABLE memory_edges ADD COLUMN occurred_at TIMESTAMPTZ;
  END IF;
END $$;

-- RLS policies (service role full access)
ALTER TABLE working_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_memory_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE consolidated_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_misses ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_gaps ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'wm_service_all') THEN
    CREATE POLICY wm_service_all ON working_memory FOR ALL TO service_role USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'wmh_service_all') THEN
    CREATE POLICY wmh_service_all ON working_memory_history FOR ALL TO service_role USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cf_service_all') THEN
    CREATE POLICY cf_service_all ON consolidated_facts FOR ALL TO service_role USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cm_service_all') THEN
    CREATE POLICY cm_service_all ON context_misses FOR ALL TO service_role USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kg_service_all') THEN
    CREATE POLICY kg_service_all ON knowledge_gaps FOR ALL TO service_role USING (true);
  END IF;
END $$;
