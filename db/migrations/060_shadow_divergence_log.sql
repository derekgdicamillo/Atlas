-- Atlas Prime Sprint 7: Shadow-Atlas divergence log.
-- Every primary turn fans out to a shadow process; drift scorer logs results.
-- alarm-class rows correlate with freeze.flag.

CREATE TABLE IF NOT EXISTS shadow_divergence_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  turn_id                  UUID,
  primary_text             TEXT NOT NULL,
  shadow_text              TEXT NOT NULL,
  distance                 REAL NOT NULL,
  judge_reason             TEXT,
  memory_writes_in_window  INT NOT NULL DEFAULT 0,
  classified               TEXT NOT NULL CHECK (classified IN ('benign','explained','suspicious','alarm')),
  froze                    BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at              TIMESTAMPTZ,
  resolved_by              TEXT,
  resolution_note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_shadow_divergence_ts    ON shadow_divergence_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_divergence_class ON shadow_divergence_log(classified);

COMMENT ON TABLE shadow_divergence_log IS
  'Atlas Prime Sprint 7: shadow-Atlas drift scoring results. alarm rows correspond to a froze freeze.flag write.';
