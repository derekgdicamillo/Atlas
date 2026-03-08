-- Migration: Add shared column to memory table for cross-agent visibility
-- Atlas v2026.3.6
-- When shared=true, both Atlas and Ishtar can see the memory entry.

ALTER TABLE memory ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;

-- Index for fast shared memory queries
CREATE INDEX IF NOT EXISTS idx_memory_shared ON memory(shared) WHERE shared = true;
