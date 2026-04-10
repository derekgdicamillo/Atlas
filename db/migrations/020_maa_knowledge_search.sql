-- ============================================================
-- Wire maa_knowledge into Atlas hybrid search
-- Adds search_vector for FTS, updates hybrid_search and hybrid_search_v2,
-- and creates match_maa_knowledge RPC for vector-only fallback.
-- Run in Supabase SQL Editor.
-- ============================================================

-- ============================================================
-- 1. ADD search_vector COLUMN FOR FTS
-- ============================================================

ALTER TABLE maa_knowledge ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_maa_knowledge_fts
  ON maa_knowledge USING gin (search_vector);

-- Backfill: combine title + content for full-text search
UPDATE maa_knowledge
SET search_vector = to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, ''))
WHERE search_vector IS NULL AND content IS NOT NULL;

-- Auto-update search_vector on insert/update
CREATE OR REPLACE FUNCTION maa_knowledge_search_vector_trigger()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS maa_knowledge_search_vector_update ON maa_knowledge;
CREATE TRIGGER maa_knowledge_search_vector_update
  BEFORE INSERT OR UPDATE OF title, content ON maa_knowledge
  FOR EACH ROW EXECUTE FUNCTION maa_knowledge_search_vector_trigger();

-- ============================================================
-- 2. match_maa_knowledge RPC (vector-only, for rpcMap)
-- ============================================================

CREATE OR REPLACE FUNCTION match_maa_knowledge(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  source_type TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    k.id,
    k.content,
    ('maa/' || COALESCE(k.state_code, 'national') || '/' || k.topic)::TEXT AS source_type,
    k.created_at,
    (1 - (k.embedding <=> query_embedding))::FLOAT AS similarity
  FROM maa_knowledge k
  WHERE k.embedding IS NOT NULL
    AND (1 - (k.embedding <=> query_embedding)) > match_threshold
  ORDER BY k.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 3. UPDATE hybrid_search TO INCLUDE maa_knowledge
-- ============================================================

CREATE OR REPLACE FUNCTION hybrid_search(
  query_embedding VECTOR(1536),
  query_text TEXT,
  search_tables TEXT[] DEFAULT ARRAY['messages'],
  match_count INT DEFAULT 10,
  fts_weight FLOAT DEFAULT 1.0,
  semantic_weight FLOAT DEFAULT 1.0
)
RETURNS TABLE (
  source_table TEXT,
  source_id UUID,
  content TEXT,
  role TEXT,
  source_type TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT,
  combined_score FLOAT
) AS $$
WITH
vector_results AS (
  SELECT * FROM (
    SELECT 'messages'::TEXT AS src_table, m.id AS src_id, m.content,
      m.role, NULL::TEXT AS src_type, m.created_at,
      1 - (m.embedding <=> query_embedding) AS sim
    FROM messages m
    WHERE 'messages' = ANY(search_tables) AND m.embedding IS NOT NULL
    ORDER BY m.embedding <=> query_embedding LIMIT match_count * 3
  ) msg_v

  UNION ALL

  SELECT * FROM (
    SELECT 'memory'::TEXT, mem.id, mem.content,
      NULL::TEXT, mem.type, mem.created_at,
      1 - (mem.embedding <=> query_embedding)
    FROM memory mem
    WHERE 'memory' = ANY(search_tables) AND mem.embedding IS NOT NULL
    ORDER BY mem.embedding <=> query_embedding LIMIT match_count * 3
  ) mem_v

  UNION ALL

  SELECT * FROM (
    SELECT 'documents'::TEXT, d.id, d.content,
      NULL::TEXT, d.source, d.created_at,
      1 - (d.embedding <=> query_embedding)
    FROM documents d
    WHERE 'documents' = ANY(search_tables) AND d.embedding IS NOT NULL
    ORDER BY d.embedding <=> query_embedding LIMIT match_count * 3
  ) doc_v

  UNION ALL

  SELECT * FROM (
    SELECT 'summaries'::TEXT, s.id, s.content,
      NULL::TEXT, 'summary'::TEXT, s.created_at,
      1 - (s.embedding <=> query_embedding)
    FROM summaries s
    WHERE 'summaries' = ANY(search_tables) AND s.embedding IS NOT NULL
    ORDER BY s.embedding <=> query_embedding LIMIT match_count * 3
  ) sum_v

  UNION ALL

  SELECT * FROM (
    SELECT 'maa_knowledge'::TEXT, k.id, k.content,
      NULL::TEXT, ('maa/' || COALESCE(k.state_code, 'national') || '/' || k.topic)::TEXT, k.created_at,
      1 - (k.embedding <=> query_embedding)
    FROM maa_knowledge k
    WHERE 'maa_knowledge' = ANY(search_tables) AND k.embedding IS NOT NULL
    ORDER BY k.embedding <=> query_embedding LIMIT match_count * 3
  ) maa_v
),
vector_ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY sim DESC) AS v_rank
  FROM vector_results
),

fts_results AS (
  SELECT 'messages'::TEXT AS src_table, m.id AS src_id, m.content,
    m.role, NULL::TEXT AS src_type, m.created_at,
    ts_rank(m.search_vector, plainto_tsquery('english', query_text)) AS fts_score
  FROM messages m
  WHERE 'messages' = ANY(search_tables)
    AND m.search_vector @@ plainto_tsquery('english', query_text)

  UNION ALL

  SELECT 'memory', mem.id, mem.content,
    NULL, mem.type, mem.created_at,
    ts_rank(mem.search_vector, plainto_tsquery('english', query_text))
  FROM memory mem
  WHERE 'memory' = ANY(search_tables)
    AND mem.search_vector @@ plainto_tsquery('english', query_text)

  UNION ALL

  SELECT 'documents', d.id, d.content,
    NULL, d.source, d.created_at,
    ts_rank(d.search_vector, plainto_tsquery('english', query_text))
  FROM documents d
  WHERE 'documents' = ANY(search_tables)
    AND d.search_vector @@ plainto_tsquery('english', query_text)

  UNION ALL

  SELECT 'summaries', s.id, s.content,
    NULL, 'summary', s.created_at,
    ts_rank(s.search_vector, plainto_tsquery('english', query_text))
  FROM summaries s
  WHERE 'summaries' = ANY(search_tables)
    AND s.search_vector @@ plainto_tsquery('english', query_text)

  UNION ALL

  SELECT 'maa_knowledge', k.id, k.content,
    NULL, ('maa/' || COALESCE(k.state_code, 'national') || '/' || k.topic), k.created_at,
    ts_rank(k.search_vector, plainto_tsquery('english', query_text))
  FROM maa_knowledge k
  WHERE 'maa_knowledge' = ANY(search_tables)
    AND k.search_vector @@ plainto_tsquery('english', query_text)
),
fts_ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fts_score DESC) AS f_rank
  FROM fts_results
),

combined AS (
  SELECT
    COALESCE(v.src_table, f.src_table) AS source_table,
    COALESCE(v.src_id, f.src_id) AS source_id,
    COALESCE(v.content, f.content) AS content,
    COALESCE(v.role, f.role) AS role,
    COALESCE(v.src_type, f.src_type) AS source_type,
    COALESCE(v.created_at, f.created_at) AS created_at,
    COALESCE(v.sim, 0) AS similarity,
    (
      COALESCE(semantic_weight / (60.0 + v.v_rank), 0) +
      COALESCE(fts_weight / (60.0 + f.f_rank), 0)
    ) AS combined_score
  FROM vector_ranked v
  FULL OUTER JOIN fts_ranked f
    ON v.src_table = f.src_table AND v.src_id = f.src_id
)
SELECT source_table, source_id, content, role, source_type,
  created_at, similarity, combined_score
FROM combined
ORDER BY combined_score DESC
LIMIT match_count;
$$ LANGUAGE SQL;

-- ============================================================
-- 4. UPDATE hybrid_search_v2 TO INCLUDE maa_knowledge
-- ============================================================

CREATE OR REPLACE FUNCTION hybrid_search_v2(
  query_embedding VECTOR(1536),
  query_text TEXT,
  search_tables TEXT[] DEFAULT ARRAY['messages'],
  match_count INT DEFAULT 10,
  fts_weight FLOAT DEFAULT 1.0,
  semantic_weight FLOAT DEFAULT 1.0,
  recency_weight FLOAT DEFAULT 0.3,
  decay_rate FLOAT DEFAULT 0.995
)
RETURNS TABLE (
  source_table TEXT,
  source_id UUID,
  content TEXT,
  role TEXT,
  source_type TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT,
  combined_score FLOAT,
  recency_score FLOAT,
  hours_age FLOAT
) AS $$
WITH
vector_results AS (
  SELECT * FROM (
    SELECT 'messages'::TEXT AS src_table, m.id AS src_id, m.content,
      m.role, NULL::TEXT AS src_type, m.created_at,
      1 - (m.embedding <=> query_embedding) AS sim,
      COALESCE(m.salience, 0.5) AS sal
    FROM messages m
    WHERE 'messages' = ANY(search_tables) AND m.embedding IS NOT NULL
    ORDER BY m.embedding <=> query_embedding LIMIT match_count * 3
  ) msg_v

  UNION ALL

  SELECT * FROM (
    SELECT 'memory'::TEXT, mem.id, mem.content,
      NULL::TEXT, mem.type, mem.created_at,
      1 - (mem.embedding <=> query_embedding),
      COALESCE(mem.salience, 0.5)
    FROM memory mem
    WHERE 'memory' = ANY(search_tables) AND mem.embedding IS NOT NULL
      AND mem.historical = FALSE
    ORDER BY mem.embedding <=> query_embedding LIMIT match_count * 3
  ) mem_v

  UNION ALL

  SELECT * FROM (
    SELECT 'documents'::TEXT, d.id, d.content,
      NULL::TEXT, d.source, d.created_at,
      1 - (d.embedding <=> query_embedding),
      0.5::FLOAT
    FROM documents d
    WHERE 'documents' = ANY(search_tables) AND d.embedding IS NOT NULL
    ORDER BY d.embedding <=> query_embedding LIMIT match_count * 3
  ) doc_v

  UNION ALL

  SELECT * FROM (
    SELECT 'summaries'::TEXT, s.id, s.content,
      NULL::TEXT, 'summary'::TEXT, s.created_at,
      1 - (s.embedding <=> query_embedding),
      0.5::FLOAT
    FROM summaries s
    WHERE 'summaries' = ANY(search_tables) AND s.embedding IS NOT NULL
    ORDER BY s.embedding <=> query_embedding LIMIT match_count * 3
  ) sum_v

  UNION ALL

  SELECT * FROM (
    SELECT 'maa_knowledge'::TEXT, k.id, k.content,
      NULL::TEXT, ('maa/' || COALESCE(k.state_code, 'national') || '/' || k.topic)::TEXT, k.created_at,
      1 - (k.embedding <=> query_embedding),
      0.7::FLOAT  -- higher salience: curated regulatory/clinical knowledge
    FROM maa_knowledge k
    WHERE 'maa_knowledge' = ANY(search_tables) AND k.embedding IS NOT NULL
    ORDER BY k.embedding <=> query_embedding LIMIT match_count * 3
  ) maa_v
),
vector_ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY sim DESC) AS v_rank
  FROM vector_results
),

fts_results AS (
  SELECT 'messages'::TEXT AS src_table, m.id AS src_id, m.content,
    m.role, NULL::TEXT AS src_type, m.created_at,
    ts_rank(m.search_vector, plainto_tsquery('english', query_text)) AS fts_score,
    COALESCE(m.salience, 0.5) AS sal
  FROM messages m
  WHERE 'messages' = ANY(search_tables)
    AND m.search_vector @@ plainto_tsquery('english', query_text)

  UNION ALL

  SELECT 'memory', mem.id, mem.content,
    NULL, mem.type, mem.created_at,
    ts_rank(mem.search_vector, plainto_tsquery('english', query_text)),
    COALESCE(mem.salience, 0.5)
  FROM memory mem
  WHERE 'memory' = ANY(search_tables)
    AND mem.search_vector @@ plainto_tsquery('english', query_text)
    AND mem.historical = FALSE

  UNION ALL

  SELECT 'documents', d.id, d.content,
    NULL, d.source, d.created_at,
    ts_rank(d.search_vector, plainto_tsquery('english', query_text)),
    0.5
  FROM documents d
  WHERE 'documents' = ANY(search_tables)
    AND d.search_vector @@ plainto_tsquery('english', query_text)

  UNION ALL

  SELECT 'summaries', s.id, s.content,
    NULL, 'summary', s.created_at,
    ts_rank(s.search_vector, plainto_tsquery('english', query_text)),
    0.5
  FROM summaries s
  WHERE 'summaries' = ANY(search_tables)
    AND s.search_vector @@ plainto_tsquery('english', query_text)

  UNION ALL

  SELECT 'maa_knowledge', k.id, k.content,
    NULL, ('maa/' || COALESCE(k.state_code, 'national') || '/' || k.topic), k.created_at,
    ts_rank(k.search_vector, plainto_tsquery('english', query_text)),
    0.7
  FROM maa_knowledge k
  WHERE 'maa_knowledge' = ANY(search_tables)
    AND k.search_vector @@ plainto_tsquery('english', query_text)
),
fts_ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fts_score DESC) AS f_rank
  FROM fts_results
),

combined AS (
  SELECT
    COALESCE(v.src_table, f.src_table) AS source_table,
    COALESCE(v.src_id, f.src_id) AS source_id,
    COALESCE(v.content, f.content) AS content,
    COALESCE(v.role, f.role) AS role,
    COALESCE(v.src_type, f.src_type) AS source_type,
    COALESCE(v.created_at, f.created_at) AS created_at,
    COALESCE(v.sim, 0) AS similarity,
    EXTRACT(EPOCH FROM (NOW() - COALESCE(v.created_at, f.created_at))) / 3600.0 AS hrs_age,
    POWER(decay_rate, EXTRACT(EPOCH FROM (NOW() - COALESCE(v.created_at, f.created_at))) / 3600.0) AS rec_score,
    COALESCE(v.sal, f.sal, 0.5) AS sal_score,
    (
      COALESCE(semantic_weight / (60.0 + v.v_rank), 0) +
      COALESCE(fts_weight / (60.0 + f.f_rank), 0) +
      recency_weight * POWER(decay_rate, EXTRACT(EPOCH FROM (NOW() - COALESCE(v.created_at, f.created_at))) / 3600.0) *
        COALESCE(v.sal, f.sal, 0.5)
    ) AS combined_score
  FROM vector_ranked v
  FULL OUTER JOIN fts_ranked f
    ON v.src_table = f.src_table AND v.src_id = f.src_id
)
SELECT source_table, source_id, content, role, source_type,
  created_at, similarity, combined_score, rec_score AS recency_score,
  hrs_age AS hours_age
FROM combined
ORDER BY combined_score DESC
LIMIT match_count;
$$ LANGUAGE SQL;
