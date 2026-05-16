-- Atlas Prime Sprint 7: weekly knowledge audit history.
-- Saturday cron audits fast/real_time domains and proposes half-life updates.
-- Derek-approval gate; decisions logged here for retrospective analysis.

CREATE TABLE IF NOT EXISTS knowledge_audit_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  domain                TEXT NOT NULL,
  samples_examined      INT NOT NULL,
  samples_still_correct INT NOT NULL,
  drift_score           REAL NOT NULL,
  current_half_life     INT NOT NULL,
  proposed_half_life    INT NOT NULL,
  rationale             TEXT NOT NULL,
  decision              TEXT NOT NULL CHECK (decision IN ('proposed','applied','rejected','overridden')),
  decided_by            TEXT,
  decided_at            TIMESTAMPTZ,
  override_value        INT
);

CREATE INDEX IF NOT EXISTS idx_audit_domain ON knowledge_audit_log(domain, audit_at DESC);
