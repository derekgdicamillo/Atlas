-- ============================================================
-- Migration 005: Evolution Pipeline - Multi-Resolution Summaries
-- ============================================================
-- Adds columns to the summaries table for topic-clustered,
-- multi-resolution summarization (src/evolution/summarize-v2.ts).
-- resolution: 'topic' | 'daily' | 'weekly' | 'monthly'
-- topic_label: cluster label or date identifier
-- entity_names: extracted entity names associated with the summary

ALTER TABLE summaries ADD COLUMN IF NOT EXISTS resolution TEXT DEFAULT 'daily';
ALTER TABLE summaries ADD COLUMN IF NOT EXISTS topic_label TEXT;
ALTER TABLE summaries ADD COLUMN IF NOT EXISTS entity_names TEXT[];

-- Index for querying by resolution (daily digests, weekly synthesis, etc.)
CREATE INDEX IF NOT EXISTS idx_summaries_resolution ON summaries(resolution);

-- Index for looking up topic summaries within a date range + resolution
CREATE INDEX IF NOT EXISTS idx_summaries_resolution_period ON summaries(resolution, period_start DESC);
