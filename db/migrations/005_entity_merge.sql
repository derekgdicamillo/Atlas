-- 005_entity_merge.sql
-- Entity merge support: pg_trgm for fuzzy name matching + find_similar_entities RPC

-- Enable trigram similarity extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- RPC: Find entity pairs with similar names (for auto-merge during consolidation)
-- Returns pairs sorted by similarity descending.
-- Filters out exact ID matches and only returns pairs where entity1_id < entity2_id
-- to avoid duplicate pairs.
CREATE OR REPLACE FUNCTION find_similar_entities(
  similarity_threshold FLOAT DEFAULT 0.8
)
RETURNS TABLE (
  entity1_id UUID,
  entity1_name TEXT,
  entity2_id UUID,
  entity2_name TEXT,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    e1.id AS entity1_id,
    e1.name AS entity1_name,
    e2.id AS entity2_id,
    e2.name AS entity2_name,
    similarity(LOWER(e1.name), LOWER(e2.name))::FLOAT AS similarity
  FROM memory_entities e1
  JOIN memory_entities e2
    ON e1.id < e2.id
    AND similarity(LOWER(e1.name), LOWER(e2.name)) > similarity_threshold
  ORDER BY similarity DESC
  LIMIT 50;
$$;

-- Add aliases column to memory_entities if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_entities' AND column_name = 'aliases'
  ) THEN
    ALTER TABLE memory_entities ADD COLUMN aliases TEXT[] DEFAULT '{}';
  END IF;
END $$;

-- Index for trigram similarity searches on entity names
CREATE INDEX IF NOT EXISTS idx_memory_entities_name_trgm
  ON memory_entities USING gin (name gin_trgm_ops);
