-- ============================================================
-- Atlas Episodic Memory Migration
-- Records complete task/conversation/decision episodes with
-- outcomes, lessons learned, and linkages to existing memory.
-- Run in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- 1. EPISODES TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS episodes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  trigger TEXT NOT NULL,
  episode_type TEXT NOT NULL DEFAULT 'task' CHECK (episode_type IN ('task', 'conversation', 'decision', 'incident', 'learning')),
  actions_taken JSONB NOT NULL DEFAULT '[]',
  outcome TEXT,
  outcome_valence TEXT DEFAULT 'neutral' CHECK (outcome_valence IN ('positive', 'negative', 'neutral', 'mixed')),
  lessons TEXT[],
  participant_entity_ids UUID[] DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_seconds INT,
  turn_count INT DEFAULT 0,
  first_message_id UUID,
  last_message_id UUID,
  thread_id UUID REFERENCES memory_threads(id) ON DELETE SET NULL,
  linked_memory_ids UUID[] DEFAULT '{}',
  linked_feedback_ids UUID[] DEFAULT '{}',
  salience FLOAT DEFAULT 0.5 CHECK (salience >= 0 AND salience <= 1),
  access_count INT DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  embedding VECTOR(1536),
  search_vector TSVECTOR,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- ============================================================
-- 2. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_episodes_type ON episodes(episode_type);
CREATE INDEX IF NOT EXISTS idx_episodes_outcome_valence ON episodes(outcome_valence);
CREATE INDEX IF NOT EXISTS idx_episodes_started_at ON episodes(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_salience ON episodes(salience DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_thread_id ON episodes(thread_id);

CREATE INDEX IF NOT EXISTS idx_episodes_embedding_hnsw ON episodes
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_episodes_search_vector ON episodes
  USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_episodes_participant_ids ON episodes
  USING GIN (participant_entity_ids);

-- ============================================================
-- 3. TSVECTOR TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION update_episode_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.trigger, '') || ' ' ||
    COALESCE(NEW.outcome, '') || ' ' ||
    COALESCE(array_to_string(NEW.lessons, ' '), '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_episodes_search_vector ON episodes;
CREATE TRIGGER trg_episodes_search_vector
  BEFORE INSERT OR UPDATE OF trigger, outcome, lessons ON episodes
  FOR EACH ROW EXECUTE FUNCTION update_episode_search_vector();

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON episodes FOR ALL USING (true);

-- ============================================================
-- 5. HYBRID SEARCH RPC
--    Vector 60% weight, FTS 40%
-- ============================================================

CREATE OR REPLACE FUNCTION search_episodes(
  query_embedding VECTOR(1536),
  query_text TEXT,
  match_count INT DEFAULT 5,
  type_filter TEXT DEFAULT NULL,
  min_salience FLOAT DEFAULT 0.0
)
RETURNS TABLE (
  id UUID,
  trigger TEXT,
  episode_type TEXT,
  outcome TEXT,
  outcome_valence TEXT,
  lessons TEXT[],
  turn_count INT,
  duration_seconds INT,
  salience FLOAT,
  similarity FLOAT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
) AS $$
WITH
vector_results AS (
  SELECT
    e.id, e.trigger, e.episode_type, e.outcome, e.outcome_valence,
    e.lessons, e.turn_count, e.duration_seconds, e.salience,
    1 - (e.embedding <=> query_embedding) AS sim,
    e.started_at, e.ended_at,
    ROW_NUMBER() OVER (ORDER BY e.embedding <=> query_embedding) AS v_rank
  FROM episodes e
  WHERE e.embedding IS NOT NULL
    AND e.salience >= min_salience
    AND (type_filter IS NULL OR e.episode_type = type_filter)
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count * 3
),
fts_results AS (
  SELECT
    e.id, e.trigger, e.episode_type, e.outcome, e.outcome_valence,
    e.lessons, e.turn_count, e.duration_seconds, e.salience,
    ts_rank(e.search_vector, plainto_tsquery('english', query_text)) AS fts_score,
    e.started_at, e.ended_at,
    ROW_NUMBER() OVER (
      ORDER BY ts_rank(e.search_vector, plainto_tsquery('english', query_text)) DESC
    ) AS f_rank
  FROM episodes e
  WHERE e.search_vector @@ plainto_tsquery('english', query_text)
    AND e.salience >= min_salience
    AND (type_filter IS NULL OR e.episode_type = type_filter)
),
combined AS (
  SELECT
    COALESCE(v.id, f.id) AS id,
    COALESCE(v.trigger, f.trigger) AS trigger,
    COALESCE(v.episode_type, f.episode_type) AS episode_type,
    COALESCE(v.outcome, f.outcome) AS outcome,
    COALESCE(v.outcome_valence, f.outcome_valence) AS outcome_valence,
    COALESCE(v.lessons, f.lessons) AS lessons,
    COALESCE(v.turn_count, f.turn_count) AS turn_count,
    COALESCE(v.duration_seconds, f.duration_seconds) AS duration_seconds,
    COALESCE(v.salience, f.salience) AS salience,
    COALESCE(v.sim, 0) AS similarity,
    COALESCE(v.started_at, f.started_at) AS started_at,
    COALESCE(v.ended_at, f.ended_at) AS ended_at,
    (
      COALESCE(0.6 / (60.0 + v.v_rank), 0) +
      COALESCE(0.4 / (60.0 + f.f_rank), 0)
    ) AS rrf_score
  FROM vector_results v
  FULL OUTER JOIN fts_results f ON v.id = f.id
)
SELECT c.id, c.trigger, c.episode_type, c.outcome, c.outcome_valence,
  c.lessons, c.turn_count, c.duration_seconds, c.salience,
  c.similarity, c.started_at, c.ended_at
FROM combined c
ORDER BY c.rrf_score DESC
LIMIT match_count;
$$ LANGUAGE SQL;

-- ============================================================
-- 6. RECORD EPISODE ACCESS (reconsolidation)
-- ============================================================

CREATE OR REPLACE FUNCTION record_episode_access(episode_ids UUID[])
RETURNS VOID AS $$
BEGIN
  UPDATE episodes
  SET access_count = access_count + 1,
      last_accessed = NOW()
  WHERE id = ANY(episode_ids);
END;
$$ LANGUAGE plpgsql;
