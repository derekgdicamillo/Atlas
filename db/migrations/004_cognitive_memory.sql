-- ============================================================
-- Atlas Cognitive Memory Migration
-- Human-like memory: temporal decay, salience, contradiction
-- resolution, narrative threading, prospective memory
-- Run in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- 1. ADD COGNITIVE COLUMNS TO MEMORY TABLE
-- ============================================================

-- Access tracking for reconsolidation
ALTER TABLE memory ADD COLUMN IF NOT EXISTS access_count INT DEFAULT 0;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ;

-- Salience scoring (0.0 to 1.0)
ALTER TABLE memory ADD COLUMN IF NOT EXISTS salience FLOAT DEFAULT 0.5
  CHECK (salience >= 0 AND salience <= 1);

-- Historical flag for superseded facts (contradiction resolution)
ALTER TABLE memory ADD COLUMN IF NOT EXISTS historical BOOLEAN DEFAULT FALSE;

-- Source tracking for confidence scoring
ALTER TABLE memory ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'direct_statement';
-- source values: direct_statement, inference, document, third_party, system_generated

-- Confidence score (0.0 to 1.0)
ALTER TABLE memory ADD COLUMN IF NOT EXISTS confidence FLOAT DEFAULT 0.8
  CHECK (confidence >= 0 AND confidence <= 1);

-- Narrative thread linkage
ALTER TABLE memory ADD COLUMN IF NOT EXISTS thread_id UUID;

CREATE INDEX IF NOT EXISTS idx_memory_historical ON memory(historical);
CREATE INDEX IF NOT EXISTS idx_memory_salience ON memory(salience DESC);
CREATE INDEX IF NOT EXISTS idx_memory_last_accessed ON memory(last_accessed DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_memory_thread_id ON memory(thread_id);

-- ============================================================
-- 2. ADD COGNITIVE COLUMNS TO MESSAGES TABLE
-- ============================================================

-- Salience scoring for message-level importance
ALTER TABLE messages ADD COLUMN IF NOT EXISTS salience FLOAT DEFAULT 0.5
  CHECK (salience >= 0 AND salience <= 1);

CREATE INDEX IF NOT EXISTS idx_messages_salience ON messages(salience DESC);

-- ============================================================
-- 3. ADD ACCESS TRACKING TO ENTITIES
-- ============================================================

ALTER TABLE memory_entities ADD COLUMN IF NOT EXISTS access_count INT DEFAULT 0;
ALTER TABLE memory_entities ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ;

-- ============================================================
-- 4. NARRATIVE THREADS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS memory_threads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  salience FLOAT DEFAULT 0.5 CHECK (salience >= 0 AND salience <= 1),
  entry_count INT DEFAULT 0,
  first_activity TIMESTAMPTZ DEFAULT NOW(),
  last_activity TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'dormant')),
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536),
  search_vector TSVECTOR,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_threads_status ON memory_threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_last_activity ON memory_threads(last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_threads_salience ON memory_threads(salience DESC);

CREATE INDEX IF NOT EXISTS idx_threads_embedding_hnsw ON memory_threads
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_threads_search_vector ON memory_threads
  USING GIN (search_vector);

-- Tsvector trigger for threads
CREATE OR REPLACE FUNCTION update_thread_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.summary, '')
  );
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_threads_search_vector ON memory_threads;
CREATE TRIGGER trg_threads_search_vector
  BEFORE INSERT OR UPDATE OF title, summary ON memory_threads
  FOR EACH ROW EXECUTE FUNCTION update_thread_search_vector();

ALTER TABLE memory_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON memory_threads FOR ALL USING (true);

-- Add foreign key from memory to threads
ALTER TABLE memory ADD CONSTRAINT fk_memory_thread
  FOREIGN KEY (thread_id) REFERENCES memory_threads(id) ON DELETE SET NULL;

-- ============================================================
-- 5. PROSPECTIVE MEMORY TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS prospective_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('time', 'event', 'context')),
  -- time: fire at specific time
  -- event: fire when condition matches incoming message
  -- context: fire when topic is discussed
  trigger_condition JSONB NOT NULL,
  -- time: { "fire_at": "2026-02-25T09:00:00Z" }
  -- event: { "pattern": "regex_pattern", "entity": "entity_name" }
  -- context: { "topic": "topic description", "entities": ["entity1"] }
  action TEXT NOT NULL,
  -- what to surface/do when triggered
  priority FLOAT DEFAULT 0.5 CHECK (priority >= 0 AND priority <= 1),
  recurring BOOLEAN DEFAULT FALSE,
  fired BOOLEAN DEFAULT FALSE,
  fired_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_prospective_trigger_type ON prospective_memory(trigger_type);
CREATE INDEX IF NOT EXISTS idx_prospective_fired ON prospective_memory(fired);
CREATE INDEX IF NOT EXISTS idx_prospective_expires ON prospective_memory(expires_at);

ALTER TABLE prospective_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON prospective_memory FOR ALL USING (true);

-- ============================================================
-- 6. UPDATED GET_FACTS RPC (excludes historical, orders by salience)
-- ============================================================

CREATE OR REPLACE FUNCTION get_facts()
RETURNS TABLE (
  id UUID,
  content TEXT,
  created_at TIMESTAMPTZ,
  salience FLOAT,
  access_count INT,
  confidence FLOAT,
  source TEXT,
  thread_id UUID
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.created_at, m.salience,
    m.access_count, m.confidence, m.source, m.thread_id
  FROM memory m
  WHERE m.type = 'fact'
    AND m.historical = FALSE
  ORDER BY m.salience DESC, m.created_at DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 7. TEMPORAL DECAY HYBRID SEARCH (v2)
--    Adds recency_score and access_score to RRF fusion
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
-- Vector search across requested tables (subquery wrappers needed for ORDER BY+LIMIT in UNION)
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
),
vector_ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY sim DESC) AS v_rank
  FROM vector_results
),

-- Full-text search
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
),
fts_ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fts_score DESC) AS f_rank
  FROM fts_results
),

-- RRF Fusion with temporal decay and salience
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

-- ============================================================
-- 8. RECORD ACCESS RPC (for reconsolidation)
-- ============================================================

CREATE OR REPLACE FUNCTION record_memory_access(memory_ids UUID[])
RETURNS VOID AS $$
BEGIN
  UPDATE memory
  SET access_count = access_count + 1,
      last_accessed = NOW()
  WHERE id = ANY(memory_ids);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_entity_access(entity_ids UUID[])
RETURNS VOID AS $$
BEGIN
  UPDATE memory_entities
  SET access_count = access_count + 1,
      last_accessed = NOW()
  WHERE id = ANY(entity_ids);
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 9. SPREADING ACTIVATION RPC (2-hop with decay)
-- ============================================================

CREATE OR REPLACE FUNCTION get_entity_neighborhood(
  start_entity_ids UUID[],
  max_depth INT DEFAULT 2,
  activation_decay FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  entity_id UUID,
  entity_name TEXT,
  entity_type TEXT,
  entity_description TEXT,
  activation_level FLOAT,
  depth INT,
  path_relationship TEXT
) AS $$
WITH RECURSIVE spread AS (
  -- Seeds: direct matches at full activation
  SELECT
    e.id AS eid,
    e.name AS ename,
    e.entity_type AS etype,
    e.description AS edesc,
    1.0::FLOAT AS activation,
    0 AS d,
    ''::TEXT AS path_rel
  FROM memory_entities e
  WHERE e.id = ANY(start_entity_ids)

  UNION ALL

  -- Spread activation through edges with decay
  SELECT
    neighbor.id,
    neighbor.name,
    neighbor.entity_type,
    neighbor.description,
    s.activation * activation_decay * COALESCE(edge.weight, 1.0),
    s.d + 1,
    edge.relationship
  FROM spread s
  JOIN memory_edges edge ON (
    edge.source_entity_id = s.eid OR edge.target_entity_id = s.eid
  )
  JOIN memory_entities neighbor ON (
    neighbor.id = CASE
      WHEN edge.source_entity_id = s.eid THEN edge.target_entity_id
      ELSE edge.source_entity_id
    END
  )
  WHERE s.d < max_depth
    AND neighbor.id != ALL(start_entity_ids)
    AND s.activation * activation_decay > 0.1
)
SELECT DISTINCT ON (s.eid)
  s.eid AS entity_id,
  s.ename AS entity_name,
  s.etype AS entity_type,
  s.edesc AS entity_description,
  s.activation AS activation_level,
  s.d AS depth,
  s.path_rel AS path_relationship
FROM spread s
WHERE s.d > 0
ORDER BY s.eid, s.activation DESC;
$$ LANGUAGE SQL;

-- ============================================================
-- 10. PROSPECTIVE MEMORY: GET DUE TRIGGERS
-- ============================================================

CREATE OR REPLACE FUNCTION get_due_triggers(check_type TEXT DEFAULT 'time')
RETURNS TABLE (
  id UUID,
  trigger_type TEXT,
  trigger_condition JSONB,
  action TEXT,
  priority FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    pm.id, pm.trigger_type, pm.trigger_condition, pm.action, pm.priority
  FROM prospective_memory pm
  WHERE pm.fired = FALSE
    AND pm.trigger_type = check_type
    AND (pm.expires_at IS NULL OR pm.expires_at > NOW())
    AND (
      check_type != 'time'
      OR (pm.trigger_condition->>'fire_at')::TIMESTAMPTZ <= NOW()
    )
  ORDER BY pm.priority DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 11. MEMORY DECAY: PRUNE LOW-VALUE MEMORIES
--     Called during consolidation to archive stale facts
-- ============================================================

CREATE OR REPLACE FUNCTION get_decayed_memories(
  min_age_hours FLOAT DEFAULT 168,
  salience_threshold FLOAT DEFAULT 0.2,
  max_results INT DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  salience FLOAT,
  access_count INT,
  hours_age FLOAT,
  decay_score FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.salience, m.access_count,
    EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 3600.0 AS hours_age,
    -- Decay score: lower = more decayed (candidate for pruning)
    m.salience * POWER(0.995, EXTRACT(EPOCH FROM (NOW() - COALESCE(m.last_accessed, m.created_at)) / 3600.0))
      * (1 + LN(GREATEST(m.access_count, 1))) AS decay_score
  FROM memory m
  WHERE m.type = 'fact'
    AND m.historical = FALSE
    AND EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 3600.0 > min_age_hours
  ORDER BY decay_score ASC
  LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 12. BACKFILL DEFAULTS FOR EXISTING ROWS
-- ============================================================

UPDATE memory SET access_count = 0 WHERE access_count IS NULL;
UPDATE memory SET salience = 0.5 WHERE salience IS NULL;
UPDATE memory SET historical = FALSE WHERE historical IS NULL;
UPDATE memory SET confidence = 0.8 WHERE confidence IS NULL;
UPDATE memory SET source = 'direct_statement' WHERE source IS NULL;

UPDATE messages SET salience = 0.5 WHERE salience IS NULL;

UPDATE memory_entities SET access_count = 0 WHERE access_count IS NULL;
