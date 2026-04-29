-- Atlas Prime Sprint 4: time-series observations of causal nodes.

CREATE TABLE IF NOT EXISTS causal_observations (
  id          BIGSERIAL PRIMARY KEY,
  node_id     UUID NOT NULL REFERENCES causal_nodes(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL,
  value       REAL,
  source      TEXT NOT NULL,
  source_ref  TEXT
);
CREATE INDEX IF NOT EXISTS idx_causal_observations_node_time
  ON causal_observations(node_id, observed_at);
