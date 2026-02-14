-- ============================================================
-- Atlas Enterprise Search Migration
-- Run in Supabase SQL Editor
-- Additive only: no breaking changes to existing tables
-- ============================================================

-- ============================================================
-- 1. DOCUMENTS TABLE (Knowledge Base with Chunking)
-- ============================================================

CREATE TABLE IF NOT EXISTS documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'manual',       -- obsidian, pdf, url, telegram, manual
  source_path TEXT,                             -- original file path or URL
  title TEXT,
  content TEXT NOT NULL,                        -- chunk content (not full doc)
  chunk_index INT DEFAULT 0,                    -- 0-based index within parent doc
  chunk_count INT DEFAULT 1,                    -- total chunks for this source
  content_hash TEXT,                            -- SHA-256 of full original doc (dedup)
  token_count INT,                              -- estimated token count for this chunk
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536),
  search_vector TSVECTOR
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);
CREATE INDEX IF NOT EXISTS idx_documents_source_path ON documents(source_path);
CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);

-- ============================================================
-- 2. SUMMARIES TABLE (Compressed Conversation History)
-- ============================================================

CREATE TABLE IF NOT EXISTS summaries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  message_count INT NOT NULL DEFAULT 0,
  content TEXT NOT NULL,                        -- the summary text
  source_message_ids UUID[] DEFAULT '{}',       -- which messages were summarized
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536),
  search_vector TSVECTOR
);

CREATE INDEX IF NOT EXISTS idx_summaries_period ON summaries(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_summaries_created_at ON summaries(created_at DESC);

-- ============================================================
-- 3. ADD TSVECTOR COLUMNS TO EXISTING TABLES
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

-- ============================================================
-- 4. HNSW INDEXES (fast approximate nearest neighbor)
-- ============================================================

-- Drop old sequential scan approach, add HNSW for all tables
CREATE INDEX IF NOT EXISTS idx_messages_embedding_hnsw ON messages
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_memory_embedding_hnsw ON memory
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_documents_embedding_hnsw ON documents
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_summaries_embedding_hnsw ON summaries
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ============================================================
-- 5. GIN INDEXES FOR FULL-TEXT SEARCH
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_messages_search_vector ON messages USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_memory_search_vector ON memory USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_documents_search_vector ON documents USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_summaries_search_vector ON summaries USING GIN (search_vector);

-- ============================================================
-- 6. AUTO-POPULATE TSVECTOR TRIGGERS
-- ============================================================

CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Messages
DROP TRIGGER IF EXISTS trg_messages_search_vector ON messages;
CREATE TRIGGER trg_messages_search_vector
  BEFORE INSERT OR UPDATE OF content ON messages
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- Memory
DROP TRIGGER IF EXISTS trg_memory_search_vector ON memory;
CREATE TRIGGER trg_memory_search_vector
  BEFORE INSERT OR UPDATE OF content ON memory
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- Documents
DROP TRIGGER IF EXISTS trg_documents_search_vector ON documents;
CREATE TRIGGER trg_documents_search_vector
  BEFORE INSERT OR UPDATE OF content ON documents
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- Summaries
DROP TRIGGER IF EXISTS trg_summaries_search_vector ON summaries;
CREATE TRIGGER trg_summaries_search_vector
  BEFORE INSERT OR UPDATE OF content ON summaries
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- ============================================================
-- 7. ROW LEVEL SECURITY FOR NEW TABLES
-- ============================================================

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON documents FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON summaries FOR ALL USING (true);

-- ============================================================
-- 8. SINGLE-TABLE VECTOR SEARCH RPCs (new tables)
-- ============================================================

CREATE OR REPLACE FUNCTION match_documents(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  source TEXT,
  source_path TEXT,
  title TEXT,
  chunk_index INT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.content,
    d.source,
    d.source_path,
    d.title,
    d.chunk_index,
    d.created_at,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  WHERE d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) > match_threshold
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION match_summaries(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  message_count INT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.content,
    s.period_start,
    s.period_end,
    s.message_count,
    s.created_at,
    1 - (s.embedding <=> query_embedding) AS similarity
  FROM summaries s
  WHERE s.embedding IS NOT NULL
    AND 1 - (s.embedding <=> query_embedding) > match_threshold
  ORDER BY s.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 9. HYBRID SEARCH WITH RRF (Reciprocal Rank Fusion)
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
-- Vector search across requested tables
vector_results AS (
  -- Messages
  SELECT 'messages'::TEXT AS src_table, m.id AS src_id, m.content,
    m.role, NULL::TEXT AS src_type, m.created_at,
    1 - (m.embedding <=> query_embedding) AS sim
  FROM messages m
  WHERE 'messages' = ANY(search_tables) AND m.embedding IS NOT NULL
  ORDER BY m.embedding <=> query_embedding LIMIT match_count * 3

  UNION ALL

  -- Memory
  SELECT 'memory', mem.id, mem.content,
    NULL, mem.type, mem.created_at,
    1 - (mem.embedding <=> query_embedding)
  FROM memory mem
  WHERE 'memory' = ANY(search_tables) AND mem.embedding IS NOT NULL
  ORDER BY mem.embedding <=> query_embedding LIMIT match_count * 3

  UNION ALL

  -- Documents
  SELECT 'documents', d.id, d.content,
    NULL, d.source, d.created_at,
    1 - (d.embedding <=> query_embedding)
  FROM documents d
  WHERE 'documents' = ANY(search_tables) AND d.embedding IS NOT NULL
  ORDER BY d.embedding <=> query_embedding LIMIT match_count * 3

  UNION ALL

  -- Summaries
  SELECT 'summaries', s.id, s.content,
    NULL, 'summary', s.created_at,
    1 - (s.embedding <=> query_embedding)
  FROM summaries s
  WHERE 'summaries' = ANY(search_tables) AND s.embedding IS NOT NULL
  ORDER BY s.embedding <=> query_embedding LIMIT match_count * 3
),
vector_ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY sim DESC) AS v_rank
  FROM vector_results
),

-- Full-text search across requested tables
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
),
fts_ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fts_score DESC) AS f_rank
  FROM fts_results
),

-- RRF Fusion: combine vector and FTS rankings
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
-- 10. BACKFILL TSVECTOR FOR EXISTING ROWS
-- ============================================================

UPDATE messages SET search_vector = to_tsvector('english', content)
WHERE search_vector IS NULL AND content IS NOT NULL;

UPDATE memory SET search_vector = to_tsvector('english', content)
WHERE search_vector IS NULL AND content IS NOT NULL;
