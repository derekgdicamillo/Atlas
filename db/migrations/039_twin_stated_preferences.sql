-- Atlas Prime Sprint 4: Derek Twin stated preferences.

CREATE TABLE IF NOT EXISTS twin_stated_preferences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL CHECK (user_id IN ('derek', 'esther')),
  preference   TEXT NOT NULL,
  domain       TEXT,
  source       TEXT NOT NULL,
  source_ref   TEXT,
  stated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_twin_stated_active
  ON twin_stated_preferences(user_id, active) WHERE active = TRUE;
