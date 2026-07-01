-- Atlas Prime Sprint 3: bulk-increment access_count_since_rewrite for retrieval.

CREATE OR REPLACE FUNCTION memory_increment_access(p_ids UUID[]) RETURNS VOID AS $$
BEGIN
  UPDATE memory
     SET access_count_since_rewrite = access_count_since_rewrite + 1,
         updated_at = NOW()
   WHERE id = ANY(p_ids);
END;
$$ LANGUAGE plpgsql;
