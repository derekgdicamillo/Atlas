-- Atlas Prime Sprint 5: joint Atlas+Ishtar deliberations.
CREATE TABLE IF NOT EXISTS joint_deliberations (
  id              TEXT PRIMARY KEY,
  branch          TEXT NOT NULL,
  opened_by       TEXT NOT NULL CHECK (opened_by IN ('atlas','ishtar','derek','esther')),
  trigger_reason  TEXT NOT NULL,
  urgency         TEXT NOT NULL CHECK (urgency IN ('urgent','routine')),
  status          TEXT NOT NULL CHECK (status IN ('pending','converging','closed','expired')),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deadline_at     TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  final_commit    TEXT,
  agreed          BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_joint_deliberations_status_deadline
  ON joint_deliberations(status, deadline_at) WHERE status = 'pending';
