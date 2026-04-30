-- Atlas Prime Sprint 5: per-task-type live/shadow control + sample count.
CREATE TABLE IF NOT EXISTS marketplace_task_types (
  task_type     TEXT PRIMARY KEY,
  mode          TEXT NOT NULL CHECK (mode IN ('shadow','live')) DEFAULT 'shadow',
  promoted_by   TEXT,
  promoted_at   TIMESTAMPTZ,
  sample_count  INT NOT NULL DEFAULT 0
);
