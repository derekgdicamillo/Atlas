-- Atlas Prime Sprint 4: Dream Engine (SWS counterfactual replay + REM tomorrow scenarios).

CREATE TABLE IF NOT EXISTS dreams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phase         TEXT NOT NULL CHECK (phase IN ('SWS', 'REM')),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger       TEXT NOT NULL,
  source_refs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  content       TEXT NOT NULL,
  rules_emitted UUID[] NOT NULL DEFAULT '{}',
  doubts        TEXT[] NOT NULL DEFAULT '{}',
  unprep_score  REAL,
  embedding     VECTOR(1536),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_dreams_embedding
  ON dreams USING ivfflat (embedding vector_cosine_ops) WITH (lists = 30);
CREATE INDEX IF NOT EXISTS idx_dreams_occurred ON dreams(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_dreams_phase ON dreams(phase, occurred_at DESC);
