-- Atlas Prime Sprint 6: Soft-DPO preference pairs.
-- Three sources: [LABEL_BAD:] tags, Haiku follow-up classifier, explicit [DPO:] tag.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS dpo_pairs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source          TEXT NOT NULL CHECK (source IN ('label_bad','haiku_classifier','dpo_tag')),
  turn_id         UUID,
  user_id         TEXT NOT NULL,
  agent           TEXT NOT NULL CHECK (agent IN ('atlas','ishtar')),
  user_turn       TEXT NOT NULL,
  atlas_original  TEXT NOT NULL,
  derek_corrected TEXT NOT NULL,
  domain          TEXT,
  reason          TEXT,
  embedding       VECTOR(1536),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_dpo_pairs_domain ON dpo_pairs(domain);
CREATE INDEX IF NOT EXISTS idx_dpo_pairs_captured ON dpo_pairs(captured_at DESC);
