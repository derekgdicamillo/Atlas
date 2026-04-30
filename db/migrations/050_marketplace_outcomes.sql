-- Atlas Prime Sprint 5: outcome scoring per task to update Beta posteriors.
CREATE TABLE IF NOT EXISTS marketplace_outcomes (
  task_id             TEXT PRIMARY KEY,
  winning_bidder_id   TEXT NOT NULL,
  outcome             TEXT NOT NULL CHECK (outcome IN ('win','loss')),
  latency_ms          INT,
  cost_actual_usd     REAL,
  scored_by           TEXT NOT NULL CHECK (scored_by IN ('derek','judge','heuristic')),
  scored_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
