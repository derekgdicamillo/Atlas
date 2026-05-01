-- Atlas Prime Sprint 5: per-role per-domain Beta posterior reputation.
CREATE TABLE IF NOT EXISTS role_reputation (
  role_id          TEXT NOT NULL,
  domain           TEXT NOT NULL,
  alpha            REAL NOT NULL DEFAULT 2.0,
  beta             REAL NOT NULL DEFAULT 2.0,
  last_decay_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_outcome_at  TIMESTAMPTZ,
  prior_alpha      REAL NOT NULL DEFAULT 2.0,
  prior_beta       REAL NOT NULL DEFAULT 2.0,
  half_life_days   INT NOT NULL DEFAULT 60,
  PRIMARY KEY (role_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_role_reputation_role ON role_reputation(role_id);
