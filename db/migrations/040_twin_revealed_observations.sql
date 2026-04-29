-- Atlas Prime Sprint 4: revealed-preference observations.

CREATE TABLE IF NOT EXISTS twin_revealed_observations (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  preference_id   UUID REFERENCES twin_stated_preferences(id) ON DELETE SET NULL,
  preference_text TEXT NOT NULL,
  domain          TEXT,
  signal          TEXT NOT NULL CHECK (signal IN ('accept', 'rewrite_align', 'rewrite_diverge', 'reject')),
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_twin_revealed_pref
  ON twin_revealed_observations(preference_id, observed_at DESC);
