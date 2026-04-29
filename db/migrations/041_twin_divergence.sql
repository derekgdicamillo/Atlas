-- Atlas Prime Sprint 4: Derek Twin stated/revealed divergence snapshots.

CREATE TABLE IF NOT EXISTS twin_divergence (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  preference_id   UUID NOT NULL REFERENCES twin_stated_preferences(id) ON DELETE CASCADE,
  domain          TEXT,
  stated_score    REAL NOT NULL,
  revealed_score  REAL NOT NULL,
  gap             REAL NOT NULL,
  sample_size     INT NOT NULL,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_twin_divergence_pref
  ON twin_divergence(preference_id, computed_at DESC);
