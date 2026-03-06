-- ============================================================
-- Atlas Feedback Loop Migration
-- Captures positive/negative/correction feedback for learning.
-- Hybrid search for retrieving relevant past corrections.
-- Pattern detection for recurring feedback themes.
-- Run in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- 1. FEEDBACK TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  task_type TEXT NOT NULL DEFAULT 'general',
  category TEXT NOT NULL DEFAULT 'general',
  outcome TEXT NOT NULL CHECK (outcome IN ('positive', 'negative', 'correction')),
  correction_text TEXT,
  original_output TEXT,
  feedback_message TEXT,
  context_summary TEXT,
  detection_confidence FLOAT DEFAULT 0.8 CHECK (detection_confidence >= 0 AND detection_confidence <= 1),
  consolidated BOOLEAN DEFAULT FALSE,
  consolidated_into UUID,
  embedding VECTOR(1536),
  search_vector TSVECTOR,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- ============================================================
-- 2. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category);
CREATE INDEX IF NOT EXISTS idx_feedback_outcome ON feedback(outcome);
CREATE INDEX IF NOT EXISTS idx_feedback_task_type ON feedback(task_type);
CREATE INDEX IF NOT EXISTS idx_feedback_consolidated ON feedback(consolidated);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_embedding_hnsw ON feedback
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_feedback_search_vector ON feedback
  USING GIN (search_vector);

-- ============================================================
-- 3. TSVECTOR TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION update_feedback_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.correction_text, '') || ' ' ||
    COALESCE(NEW.context_summary, '') || ' ' ||
    COALESCE(NEW.task_type, '') || ' ' ||
    COALESCE(NEW.category, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_feedback_search_vector ON feedback;
CREATE TRIGGER trg_feedback_search_vector
  BEFORE INSERT OR UPDATE OF correction_text, context_summary, task_type, category ON feedback
  FOR EACH ROW EXECUTE FUNCTION update_feedback_search_vector();

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON feedback FOR ALL USING (true);

-- ============================================================
-- 5. HYBRID SEARCH RPC
--    Vector 70% weight, FTS 30%
-- ============================================================

CREATE OR REPLACE FUNCTION search_feedback(
  query_embedding VECTOR(1536),
  query_text TEXT,
  match_count INT DEFAULT 5,
  category_filter TEXT DEFAULT NULL,
  min_confidence FLOAT DEFAULT 0.5
)
RETURNS TABLE (
  id UUID,
  task_type TEXT,
  category TEXT,
  outcome TEXT,
  correction_text TEXT,
  original_output TEXT,
  context_summary TEXT,
  detection_confidence FLOAT,
  similarity FLOAT,
  created_at TIMESTAMPTZ
) AS $$
WITH
vector_results AS (
  SELECT
    f.id, f.task_type, f.category, f.outcome,
    f.correction_text, f.original_output, f.context_summary,
    f.detection_confidence,
    1 - (f.embedding <=> query_embedding) AS sim,
    f.created_at,
    ROW_NUMBER() OVER (ORDER BY f.embedding <=> query_embedding) AS v_rank
  FROM feedback f
  WHERE f.embedding IS NOT NULL
    AND f.detection_confidence >= min_confidence
    AND (category_filter IS NULL OR f.category = category_filter)
  ORDER BY f.embedding <=> query_embedding
  LIMIT match_count * 3
),
fts_results AS (
  SELECT
    f.id, f.task_type, f.category, f.outcome,
    f.correction_text, f.original_output, f.context_summary,
    f.detection_confidence,
    ts_rank(f.search_vector, plainto_tsquery('english', query_text)) AS fts_score,
    f.created_at,
    ROW_NUMBER() OVER (
      ORDER BY ts_rank(f.search_vector, plainto_tsquery('english', query_text)) DESC
    ) AS f_rank
  FROM feedback f
  WHERE f.search_vector @@ plainto_tsquery('english', query_text)
    AND f.detection_confidence >= min_confidence
    AND (category_filter IS NULL OR f.category = category_filter)
),
combined AS (
  SELECT
    COALESCE(v.id, f.id) AS id,
    COALESCE(v.task_type, f.task_type) AS task_type,
    COALESCE(v.category, f.category) AS category,
    COALESCE(v.outcome, f.outcome) AS outcome,
    COALESCE(v.correction_text, f.correction_text) AS correction_text,
    COALESCE(v.original_output, f.original_output) AS original_output,
    COALESCE(v.context_summary, f.context_summary) AS context_summary,
    COALESCE(v.detection_confidence, f.detection_confidence) AS detection_confidence,
    COALESCE(v.sim, 0) AS similarity,
    COALESCE(v.created_at, f.created_at) AS created_at,
    (
      COALESCE(0.7 / (60.0 + v.v_rank), 0) +
      COALESCE(0.3 / (60.0 + f.f_rank), 0)
    ) AS rrf_score
  FROM vector_results v
  FULL OUTER JOIN fts_results f ON v.id = f.id
)
SELECT c.id, c.task_type, c.category, c.outcome,
  c.correction_text, c.original_output, c.context_summary,
  c.detection_confidence, c.similarity, c.created_at
FROM combined c
ORDER BY c.rrf_score DESC
LIMIT match_count;
$$ LANGUAGE SQL;

-- ============================================================
-- 6. PATTERN DETECTION RPC
--    Groups unconsolidated feedback by (category, task_type, outcome)
-- ============================================================

CREATE OR REPLACE FUNCTION get_feedback_patterns(
  min_occurrences INT DEFAULT 3,
  max_age_days INT DEFAULT 90
)
RETURNS TABLE (
  category TEXT,
  task_type TEXT,
  outcome TEXT,
  occurrence_count BIGINT,
  sample_corrections TEXT[],
  earliest TIMESTAMPTZ,
  latest TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    f.category,
    f.task_type,
    f.outcome,
    COUNT(*)::BIGINT AS occurrence_count,
    ARRAY_AGG(f.correction_text ORDER BY f.created_at DESC) FILTER (WHERE f.correction_text IS NOT NULL) AS sample_corrections,
    MIN(f.created_at) AS earliest,
    MAX(f.created_at) AS latest
  FROM feedback f
  WHERE f.consolidated = FALSE
    AND f.created_at > NOW() - (max_age_days || ' days')::INTERVAL
  GROUP BY f.category, f.task_type, f.outcome
  HAVING COUNT(*) >= min_occurrences
  ORDER BY COUNT(*) DESC;
END;
$$ LANGUAGE plpgsql;
