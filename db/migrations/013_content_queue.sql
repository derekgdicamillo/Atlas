-- Migration: content_queue table for approval system
-- Required by src/approval.ts
-- Atlas v2026.2.26

CREATE TABLE IF NOT EXISTS content_queue (
  id BIGSERIAL PRIMARY KEY,
  business TEXT NOT NULL DEFAULT 'pv_medispa',
  platform TEXT NOT NULL,           -- 'facebook', 'instagram', 'skool', 'email', etc.
  content_type TEXT NOT NULL,       -- 'post', 'story', 'email', 'listing', etc.
  title TEXT,
  body TEXT NOT NULL,
  image_url TEXT,
  image_data JSONB DEFAULT '{}',
  hashtags TEXT[] DEFAULT '{}',
  link_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending_approval',  -- pending_approval, approved, rejected, posted, failed
  scheduled_for TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  approval_note TEXT,
  external_id TEXT,                  -- ID on the target platform after posting
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the cron query: fetch ready items by status
CREATE INDEX IF NOT EXISTS idx_content_queue_status ON content_queue(status) WHERE status IN ('pending_approval', 'approved');
CREATE INDEX IF NOT EXISTS idx_content_queue_business ON content_queue(business);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_content_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_content_queue_updated_at ON content_queue;
CREATE TRIGGER trg_content_queue_updated_at
  BEFORE UPDATE ON content_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_content_queue_updated_at();
