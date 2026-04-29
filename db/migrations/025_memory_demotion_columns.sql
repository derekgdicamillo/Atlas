-- Atlas Prime Sprint 3: demotion pressure columns on memory table.

ALTER TABLE memory ADD COLUMN IF NOT EXISTS demotion_pressure REAL NOT NULL DEFAULT 0;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS demotion_events JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS inverted_from UUID REFERENCES memory(id);
ALTER TABLE memory ADD COLUMN IF NOT EXISTS inversion_depth INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_memory_demotion_pressure ON memory(demotion_pressure) WHERE demotion_pressure > 0;
CREATE INDEX IF NOT EXISTS idx_memory_inverted_from ON memory(inverted_from);
