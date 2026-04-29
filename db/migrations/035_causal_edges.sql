-- Atlas Prime Sprint 4: causal graph edges. Approval-gated.

CREATE TABLE IF NOT EXISTS causal_edges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_node     UUID NOT NULL REFERENCES causal_nodes(id) ON DELETE CASCADE,
  to_node       UUID NOT NULL REFERENCES causal_nodes(id) ON DELETE CASCADE,
  effect_size   REAL,
  effect_ci     JSONB,
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL CHECK (status IN ('hypothesized', 'observed', 'falsified')),
  proposed_by   TEXT NOT NULL CHECK (proposed_by IN ('pc-algo', 'llm', 'natural-experiment', 'manual')),
  approved      BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_causal_edges_from ON causal_edges(from_node);
CREATE INDEX IF NOT EXISTS idx_causal_edges_to ON causal_edges(to_node);
CREATE INDEX IF NOT EXISTS idx_causal_edges_pending
  ON causal_edges(status, approved) WHERE approved = FALSE;
