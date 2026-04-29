-- Atlas Prime Sprint 3: backfill helper for original_content + summary columns.

CREATE OR REPLACE FUNCTION memory_backfill_summaries() RETURNS INT AS $$
DECLARE
  updated_count INT;
BEGIN
  UPDATE memory
     SET original_content      = content,
         summary               = content,
         summary_rewritten_at  = created_at
   WHERE original_content IS NULL;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;
