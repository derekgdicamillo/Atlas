-- Atlas Prime Sprint 3: procedural memory (MACLA-lite).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS procedures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal            TEXT NOT NULL,
  goal_embedding  VECTOR(1536),
  preconditions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_sequence JSONB NOT NULL,
  postconditions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  alpha           INT NOT NULL DEFAULT 1,
  beta            INT NOT NULL DEFAULT 1,
  use_count       INT NOT NULL DEFAULT 0,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source          TEXT NOT NULL DEFAULT 'hand-curated',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  external_id     TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_procedures_embedding
  ON procedures USING ivfflat (goal_embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX IF NOT EXISTS idx_procedures_tags ON procedures USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_procedures_external_id ON procedures(external_id);

COMMENT ON TABLE procedures IS
  'Atlas Prime Sprint 3: hand-curated procedures with Beta(α,β) Bayesian posteriors.';
