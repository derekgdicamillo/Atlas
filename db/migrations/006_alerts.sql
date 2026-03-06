-- 006_alerts.sql
-- Alert pipeline: central alert table with dedup, delivery tracking, and cleanup

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,           -- e.g., 'anomaly', 'ghl', 'task', 'system'
  severity TEXT NOT NULL DEFAULT 'info',  -- 'info', 'warning', 'critical'
  category TEXT NOT NULL DEFAULT 'general', -- grouping key: 'financial', 'pipeline', 'ads', 'ops', 'system'
  message TEXT NOT NULL,
  dedup_key TEXT,                 -- hash for deduplication
  delivered BOOLEAN NOT NULL DEFAULT false,
  suppressed BOOLEAN NOT NULL DEFAULT false,  -- true if suppressed by quiet hours
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts (severity);
CREATE INDEX IF NOT EXISTS idx_alerts_source ON alerts (source);
CREATE INDEX IF NOT EXISTS idx_alerts_dedup_key ON alerts (dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_undelivered ON alerts (delivered, created_at) WHERE delivered = false;

-- RLS: open access (internal system table, not user-facing)
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY alerts_full_access ON alerts FOR ALL
  USING (true) WITH CHECK (true);

-- Cleanup function: delete alerts older than 30 days
CREATE OR REPLACE FUNCTION cleanup_old_alerts()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM alerts WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
