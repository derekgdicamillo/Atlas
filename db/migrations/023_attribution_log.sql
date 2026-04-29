-- Atlas Prime Sprint 3: attribution log
-- Records which memory entries contributed to each retrieval.
-- Used by demotion pressure tracking to attribute failures.

CREATE TABLE IF NOT EXISTS attribution_log (
  id           BIGSERIAL PRIMARY KEY,
  turn_id      UUID NOT NULL,
  user_id      TEXT NOT NULL,
  agent        TEXT NOT NULL CHECK (agent IN ('atlas', 'ishtar')),
  memory_id    UUID NOT NULL,
  rank         INT NOT NULL,
  rerank_score REAL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attribution_log_turn_id ON attribution_log(turn_id);
CREATE INDEX IF NOT EXISTS idx_attribution_log_memory_created ON attribution_log(memory_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attribution_log_created_at ON attribution_log(created_at);

COMMENT ON TABLE attribution_log IS
  'Atlas Prime Sprint 3: maps (turn_id, memory_id) for retrieval attribution. 90-day retention.';
