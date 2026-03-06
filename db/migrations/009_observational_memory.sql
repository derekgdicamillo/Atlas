-- ============================================================
-- Atlas Observational Memory Migration
-- Fine-grained observations extracted from conversations.
-- Observation blocks for prompt-ready context assembly.
-- Run in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- 1. OBSERVATIONS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS observations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  observation_text TEXT NOT NULL,
  observation_type TEXT NOT NULL DEFAULT 'fact' CHECK (observation_type IN ('fact', 'preference', 'decision', 'context', 'insight', 'pattern')),
  source_turn_ids UUID[] DEFAULT '{}',
  source_turn_count INT DEFAULT 1,
  salience FLOAT DEFAULT 0.5 CHECK (salience >= 0 AND salience <= 1),
  stability INT DEFAULT 1,
  last_reinforced_at TIMESTAMPTZ DEFAULT NOW(),
  session_key TEXT,
  superseded BOOLEAN DEFAULT FALSE,
  superseded_by UUID,
  embedding VECTOR(1536),
  search_vector TSVECTOR,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- ============================================================
-- 2. OBSERVATION_BLOCKS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS observation_blocks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  block_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  observation_ids UUID[] NOT NULL DEFAULT '{}',
  block_priority INT NOT NULL DEFAULT 0,
  estimated_tokens INT DEFAULT 0,
  consecutive_stable_builds INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. INDEXES (observations)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(observation_type);
CREATE INDEX IF NOT EXISTS idx_observations_salience ON observations(salience DESC);
CREATE INDEX IF NOT EXISTS idx_observations_stability ON observations(stability DESC);
CREATE INDEX IF NOT EXISTS idx_observations_superseded ON observations(superseded);
CREATE INDEX IF NOT EXISTS idx_observations_created_at ON observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_session_key ON observations(session_key);

CREATE INDEX IF NOT EXISTS idx_observations_embedding_hnsw ON observations
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_observations_search_vector ON observations
  USING GIN (search_vector);

-- ============================================================
-- 4. INDEXES (observation_blocks)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_obs_blocks_priority ON observation_blocks(block_priority DESC);
CREATE INDEX IF NOT EXISTS idx_obs_blocks_content_hash ON observation_blocks(content_hash);

-- ============================================================
-- 5. TSVECTOR TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION update_observation_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.observation_text, '') || ' ' ||
    COALESCE(NEW.observation_type, '')
  );
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_observations_search_vector ON observations;
CREATE TRIGGER trg_observations_search_vector
  BEFORE INSERT OR UPDATE OF observation_text, observation_type ON observations
  FOR EACH ROW EXECUTE FUNCTION update_observation_search_vector();

-- updated_at trigger for observation_blocks
CREATE OR REPLACE FUNCTION update_obs_blocks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_obs_blocks_updated_at ON observation_blocks;
CREATE TRIGGER trg_obs_blocks_updated_at
  BEFORE UPDATE ON observation_blocks
  FOR EACH ROW EXECUTE FUNCTION update_obs_blocks_updated_at();

-- ============================================================
-- 6. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON observations FOR ALL USING (true);

ALTER TABLE observation_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON observation_blocks FOR ALL USING (true);

-- ============================================================
-- 7. GET ACTIVE OBSERVATIONS RPC
--    Sorted by salience * log-scaled stability
-- ============================================================

CREATE OR REPLACE FUNCTION get_active_observations(
  max_count INT DEFAULT 50,
  type_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  observation_text TEXT,
  observation_type TEXT,
  salience FLOAT,
  stability INT,
  last_reinforced_at TIMESTAMPTZ,
  source_turn_count INT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id, o.observation_text, o.observation_type,
    o.salience, o.stability, o.last_reinforced_at,
    o.source_turn_count, o.created_at
  FROM observations o
  WHERE o.superseded = FALSE
    AND (type_filter IS NULL OR o.observation_type = type_filter)
  ORDER BY o.salience * LN(GREATEST(o.stability, 1) + 1) DESC
  LIMIT max_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 8. FIND SIMILAR OBSERVATION RPC
--    Vector similarity search on non-superseded observations
-- ============================================================

CREATE OR REPLACE FUNCTION find_similar_observation(
  query_embedding VECTOR(1536),
  similarity_threshold FLOAT DEFAULT 0.85
)
RETURNS TABLE (
  id UUID,
  observation_text TEXT,
  observation_type TEXT,
  salience FLOAT,
  stability INT,
  similarity FLOAT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.id, o.observation_text, o.observation_type,
    o.salience, o.stability,
    1 - (o.embedding <=> query_embedding) AS similarity,
    o.created_at
  FROM observations o
  WHERE o.superseded = FALSE
    AND o.embedding IS NOT NULL
    AND 1 - (o.embedding <=> query_embedding) > similarity_threshold
  ORDER BY o.embedding <=> query_embedding
  LIMIT 3;
END;
$$ LANGUAGE plpgsql;
