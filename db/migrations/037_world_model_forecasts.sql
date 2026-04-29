-- Atlas Prime Sprint 4: world model forecast cache (audit chain).

CREATE TABLE IF NOT EXISTS world_model_forecasts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metric          TEXT NOT NULL,
  horizon_days    INT NOT NULL,
  counterfactual  JSONB,
  baseline_p50    REAL[] NOT NULL,
  baseline_p05    REAL[] NOT NULL,
  baseline_p95    REAL[] NOT NULL,
  conditional_p50 REAL[],
  conditional_p05 REAL[],
  conditional_p95 REAL[],
  dag_edges_used  UUID[] NOT NULL DEFAULT '{}',
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_world_model_forecasts_asked
  ON world_model_forecasts(asked_at DESC);
CREATE INDEX IF NOT EXISTS idx_world_model_forecasts_metric
  ON world_model_forecasts(metric, asked_at DESC);
