-- Atlas Prime Sprint 3: living-summary columns on memory table.
-- original_content is frozen; summary is rewritten lazily on retrieval.

ALTER TABLE memory ADD COLUMN IF NOT EXISTS original_content TEXT;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS summary_rewritten_at TIMESTAMPTZ;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS access_count_since_rewrite INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN memory.original_content IS 'Immutable frozen original. Set once on first rewrite or backfill.';
COMMENT ON COLUMN memory.summary IS 'Living summary. Rewritten when stale + frequently accessed.';
