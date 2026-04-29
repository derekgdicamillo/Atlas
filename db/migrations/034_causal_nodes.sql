-- Atlas Prime Sprint 4: causal graph nodes (metrics, actions, exogenous events).

CREATE TABLE IF NOT EXISTS causal_nodes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL CHECK (kind IN ('metric', 'action', 'event')),
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  unit         TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_causal_nodes_kind ON causal_nodes(kind);
