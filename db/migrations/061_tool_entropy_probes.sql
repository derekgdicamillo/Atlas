-- Atlas Prime Sprint 7: Tool-selection entropy probes.
-- Fires only on ambiguous turns (>= 2 candidate tools).
-- High entropy substitutes a clarifying question for dispatch.

CREATE TABLE IF NOT EXISTS tool_entropy_probes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  turn_id       UUID,
  user_prompt   TEXT NOT NULL,
  samples       JSONB NOT NULL,
  clusters      JSONB NOT NULL,
  entropy       REAL NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('dispatched','clarified','manual_review')),
  selected_tool TEXT,
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_entropy_ts     ON tool_entropy_probes(ts DESC);
CREATE INDEX IF NOT EXISTS idx_entropy_action ON tool_entropy_probes(action);
