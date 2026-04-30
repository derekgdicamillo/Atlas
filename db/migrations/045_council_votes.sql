-- Atlas Prime Sprint 5: every Council vote, signed and ledger-chained.
CREATE TABLE IF NOT EXISTS council_votes (
  vote_id            TEXT PRIMARY KEY,
  action_id          TEXT NOT NULL,
  role_id            TEXT NOT NULL,
  vote               TEXT NOT NULL CHECK (vote IN ('approve','veto','abstain')),
  reason             TEXT,
  confidence         REAL,
  signature          BYTEA,
  blackboard_commit  TEXT,
  mode               TEXT NOT NULL CHECK (mode IN ('shadow','live')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_council_votes_action ON council_votes(action_id);
CREATE INDEX IF NOT EXISTS idx_council_votes_role_mode_time
  ON council_votes(role_id, mode, created_at DESC);
