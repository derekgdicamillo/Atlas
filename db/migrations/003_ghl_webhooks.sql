-- ============================================================
-- Atlas GHL Webhooks Migration
-- Run in Supabase SQL Editor
-- Additive only: no breaking changes to existing tables
-- ============================================================

-- ============================================================
-- 1. GHL_EVENTS TABLE (Webhook event storage)
-- ============================================================

CREATE TABLE IF NOT EXISTS ghl_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type TEXT NOT NULL,              -- e.g. ContactCreate, OpportunityStageUpdate
  contact_id TEXT,                       -- GHL contact ID (nullable)
  opportunity_id TEXT,                   -- GHL opportunity ID (nullable)
  payload JSONB NOT NULL DEFAULT '{}',   -- raw webhook payload
  processed BOOLEAN DEFAULT FALSE,       -- has Atlas consumed this event?
  alerted BOOLEAN DEFAULT FALSE,         -- was a Telegram alert sent?
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ghl_events_type ON ghl_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ghl_events_contact ON ghl_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_ghl_events_created_at ON ghl_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ghl_events_unprocessed ON ghl_events(processed) WHERE NOT processed;

-- ============================================================
-- 2. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE ghl_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON ghl_events FOR ALL USING (true);

-- ============================================================
-- 3. CLEANUP FUNCTION (purge events older than 30 days)
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_ghl_events()
RETURNS void AS $$
BEGIN
  DELETE FROM ghl_events WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;
