-- ============================================================
-- Atlas Proactive Monitoring Migration
-- Time-series metric snapshots for baseline detection,
-- configurable monitor thresholds, and alert escalation.
-- Run in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- 1. METRIC_SNAPSHOTS TABLE (time-series)
-- ============================================================

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  metadata JSONB DEFAULT '{}',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_key_time
  ON metric_snapshots(metric_key, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_captured_at
  ON metric_snapshots(captured_at);

-- ============================================================
-- 2. MONITOR_CONFIG TABLE (per-check thresholds)
-- ============================================================

CREATE TABLE IF NOT EXISTS monitor_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_key TEXT UNIQUE NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  interval_minutes INT NOT NULL DEFAULT 15,
  thresholds JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_monitor_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_monitor_config_updated_at ON monitor_config;
CREATE TRIGGER trg_monitor_config_updated_at
  BEFORE UPDATE ON monitor_config
  FOR EACH ROW EXECUTE FUNCTION update_monitor_config_updated_at();

-- ============================================================
-- 3. ALTER ALERTS TABLE: ESCALATION COLUMNS
-- ============================================================

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS escalated_from TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS escalation_count INT DEFAULT 0;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN DEFAULT FALSE;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE metric_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON metric_snapshots FOR ALL USING (true);

ALTER TABLE monitor_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON monitor_config FOR ALL USING (true);

-- ============================================================
-- 5. GET METRIC BASELINE RPC
--    Computes avg, min, max, stddev over a sliding window
-- ============================================================

CREATE OR REPLACE FUNCTION get_metric_baseline(
  p_metric_key TEXT,
  p_window_hours INT DEFAULT 168
)
RETURNS TABLE (
  avg_value DOUBLE PRECISION,
  min_value DOUBLE PRECISION,
  max_value DOUBLE PRECISION,
  stddev_value DOUBLE PRECISION,
  sample_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    AVG(ms.value) AS avg_value,
    MIN(ms.value) AS min_value,
    MAX(ms.value) AS max_value,
    STDDEV(ms.value) AS stddev_value,
    COUNT(*)::BIGINT AS sample_count
  FROM metric_snapshots ms
  WHERE ms.metric_key = p_metric_key
    AND ms.captured_at > NOW() - (p_window_hours || ' hours')::INTERVAL;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 6. GET LATEST METRIC RPC
-- ============================================================

CREATE OR REPLACE FUNCTION get_latest_metric(p_metric_key TEXT)
RETURNS TABLE (
  value DOUBLE PRECISION,
  captured_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT ms.value, ms.captured_at
  FROM metric_snapshots ms
  WHERE ms.metric_key = p_metric_key
  ORDER BY ms.captured_at DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 7. CLEANUP OLD METRIC SNAPSHOTS (>90 days)
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_old_metric_snapshots()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM metric_snapshots WHERE captured_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- ============================================================
-- 8. SEED DEFAULT MONITOR CONFIGS
-- ============================================================

INSERT INTO monitor_config (check_key, enabled, interval_minutes, thresholds) VALUES
  ('pipeline.new_leads',       TRUE,    5, '{"notify": true}'),
  ('pipeline.stale_leads',     TRUE,   60, '{"warn": 5, "crit": 10}'),
  ('pipeline.speed_to_lead',   TRUE,   15, '{"warn_minutes": 30, "crit_minutes": 60}'),
  ('pipeline.show_rate',       TRUE,   60, '{"warn_below": 0.5, "crit_below": 0.35}'),
  ('ads.cpl_7d',               TRUE,   15, '{"warn": 65, "crit": 100}'),
  ('ads.frequency_30d',        TRUE,   60, '{"warn": 3, "crit": 4}'),
  ('ads.ctr_7d',               TRUE,   15, '{"warn_below": 1.5, "crit_below": 0.5}'),
  ('financial.revenue_mtd',    TRUE,   60, '{"baseline": true}'),
  ('financial.cash_runway',    TRUE,   60, '{"warn_months": 3, "crit_months": 2}'),
  ('reviews.new_review',       TRUE,    5, '{"notify": true}'),
  ('reviews.unreplied',        TRUE,   60, '{"warn": 3, "crit": 5}'),
  ('website.sessions_wow',     TRUE,   60, '{"warn_drop": 0.3, "crit_drop": 0.5}'),
  ('website.conversion_rate',  TRUE,   60, '{"warn_below": 0.05, "crit_below": 0.03}'),
  ('email.urgent',             TRUE,    5, '{"keywords": ["urgent", "asap", "emergency"], "senders": []}'),
  ('calendar.today',           TRUE, 1440, '{"morning_brief": true}')
ON CONFLICT (check_key) DO NOTHING;
