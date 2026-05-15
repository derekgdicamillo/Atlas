-- Atlas Prime: missing memory.class and memory.tags columns.
-- These were referenced throughout cortex.ts and dream-engine.ts since
-- Sprint 3, but the schema-add migration was never written. Without them
-- demotion, inversion, episodic clustering, and dream-engine consolidation
-- all fail at write time.
--
-- Class values used in code:
--   'episodic'        — default for raw event memories
--   'semantic'        — promoted via clustering or dream consolidation
--   'archived-source' — episodic source rows after their cluster was promoted
--   'demoted'         — contradicted, no longer authoritative
--
-- Tags are free-form labels (e.g. cluster topic, 'episodic-promoted',
-- 'inversion', 'from-dream', 'sws') used by clustering and inversion logic.

ALTER TABLE memory ADD COLUMN IF NOT EXISTS class TEXT NOT NULL DEFAULT 'episodic'
  CHECK (class IN ('episodic', 'semantic', 'archived-source', 'demoted'));

ALTER TABLE memory ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_memory_class       ON memory(class);
CREATE INDEX IF NOT EXISTS idx_memory_tags_gin    ON memory USING GIN(tags);
