-- ============================================================
-- Atlas Graph Memory Migration
-- Run in Supabase SQL Editor
-- Additive only: no breaking changes to existing tables
-- ============================================================

-- ============================================================
-- 1. MEMORY_ENTITIES TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS memory_entities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'concept',
  aliases TEXT[] DEFAULT '{}',
  description TEXT,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536),
  search_vector TSVECTOR,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Case-insensitive canonical name uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_lower
  ON memory_entities (LOWER(name));

CREATE INDEX IF NOT EXISTS idx_entities_type
  ON memory_entities(entity_type);

CREATE INDEX IF NOT EXISTS idx_entities_created_at
  ON memory_entities(created_at DESC);

-- HNSW for vector search
CREATE INDEX IF NOT EXISTS idx_entities_embedding_hnsw ON memory_entities
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- GIN for full-text search
CREATE INDEX IF NOT EXISTS idx_entities_search_vector
  ON memory_entities USING GIN (search_vector);

-- ============================================================
-- 2. MEMORY_EDGES TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS memory_edges (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_entity_id UUID NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,
  weight FLOAT DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Prevent duplicate edges (same source, target, relationship)
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
  ON memory_edges (source_entity_id, target_entity_id, relationship);

-- Fast neighbor lookups in both directions
CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_entity_id);

-- ============================================================
-- 3. TSVECTOR TRIGGER (name + description + aliases)
-- ============================================================

CREATE OR REPLACE FUNCTION update_entity_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.name, '') || ' ' ||
    COALESCE(NEW.description, '') || ' ' ||
    COALESCE(array_to_string(NEW.aliases, ' '), '')
  );
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entities_search_vector ON memory_entities;
CREATE TRIGGER trg_entities_search_vector
  BEFORE INSERT OR UPDATE OF name, description, aliases ON memory_entities
  FOR EACH ROW EXECUTE FUNCTION update_entity_search_vector();

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE memory_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON memory_entities FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON memory_edges FOR ALL USING (true);

-- ============================================================
-- 5. VECTOR SEARCH RPC (entities)
-- ============================================================

CREATE OR REPLACE FUNCTION search_entities(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.6,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  entity_type TEXT,
  description TEXT,
  aliases TEXT[],
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id, e.name, e.entity_type, e.description, e.aliases, e.created_at,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM memory_entities e
  WHERE e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 6. N-HOP NEIGHBOR TRAVERSAL RPC
-- ============================================================

CREATE OR REPLACE FUNCTION get_entity_neighbors(
  start_entity_id UUID,
  max_depth INT DEFAULT 1
)
RETURNS TABLE (
  entity_id UUID,
  entity_name TEXT,
  entity_type TEXT,
  entity_description TEXT,
  relationship TEXT,
  related_entity_id UUID,
  related_entity_name TEXT,
  related_entity_type TEXT,
  direction TEXT,
  depth INT
) AS $$
  -- Unified bidirectional edge view, then recurse on that
  WITH RECURSIVE biedges AS (
    -- Normalize all edges into a uniform (node, rel, neighbor, dir) shape
    SELECT
      e.source_entity_id AS node_id,
      e.relationship AS rel,
      e.target_entity_id AS neighbor_id,
      'outgoing'::TEXT AS dir
    FROM memory_edges e
    UNION ALL
    SELECT
      e.target_entity_id,
      e.relationship,
      e.source_entity_id,
      'incoming'::TEXT
    FROM memory_edges e
  ),
  traversal AS (
    -- Base: direct neighbors of start entity
    SELECT
      b.node_id AS eid,
      n1.name AS ename,
      n1.entity_type AS etype,
      n1.description AS edesc,
      b.rel,
      b.neighbor_id AS related_eid,
      n2.name AS related_ename,
      n2.entity_type AS related_etype,
      b.dir,
      1 AS d
    FROM biedges b
    JOIN memory_entities n1 ON n1.id = b.node_id
    JOIN memory_entities n2 ON n2.id = b.neighbor_id
    WHERE b.node_id = start_entity_id

    UNION ALL

    -- Recursive: expand from neighbors found in previous level
    SELECT
      b.node_id,
      n1.name, n1.entity_type, n1.description,
      b.rel,
      b.neighbor_id,
      n2.name, n2.entity_type,
      b.dir,
      t.d + 1
    FROM traversal t
    JOIN biedges b ON b.node_id = t.related_eid
    JOIN memory_entities n1 ON n1.id = b.node_id
    JOIN memory_entities n2 ON n2.id = b.neighbor_id
    WHERE t.d < max_depth
      AND b.neighbor_id != start_entity_id
  )
  SELECT DISTINCT ON (t.eid, t.rel, t.related_eid)
    t.eid AS entity_id,
    t.ename AS entity_name,
    t.etype AS entity_type,
    t.edesc AS entity_description,
    t.rel AS relationship,
    t.related_eid AS related_entity_id,
    t.related_ename AS related_entity_name,
    t.related_etype AS related_entity_type,
    t.dir AS direction,
    t.d AS depth
  FROM traversal t
  ORDER BY t.eid, t.rel, t.related_eid, t.d;
$$ LANGUAGE SQL;
