-- 012_tox_tray.sql
-- Autonomous business operator: content queue, trust gradient, Etsy cache, social analytics

-- ============================================================
-- CONTENT QUEUE
-- ============================================================
-- Generated content awaiting approval/posting across platforms.
-- Extensible to multiple businesses (tox_tray now, others later).

CREATE TABLE IF NOT EXISTS content_queue (
  id SERIAL PRIMARY KEY,
  business TEXT NOT NULL DEFAULT 'tox_tray',
  platform TEXT NOT NULL,                    -- pinterest, instagram, facebook, tiktok, etsy
  content_type TEXT NOT NULL,                -- pin, post, reel, story, listing_update
  title TEXT,
  body TEXT NOT NULL,
  image_url TEXT,                             -- Canva export URL or local path
  image_data JSONB DEFAULT '{}',             -- dimensions, alt text, format
  hashtags TEXT[] DEFAULT '{}',
  link_url TEXT,                              -- product link
  status TEXT NOT NULL DEFAULT 'draft',       -- draft, pending_approval, approved, rejected, posted, failed
  scheduled_for TIMESTAMPTZ,                  -- when to post (null = ASAP after approval)
  posted_at TIMESTAMPTZ,
  external_id TEXT,                           -- platform post ID after posting
  approval_note TEXT,                         -- rejection reason or edit note
  metadata JSONB DEFAULT '{}',               -- platform-specific extras
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_queue_status ON content_queue (status);
CREATE INDEX IF NOT EXISTS idx_content_queue_business ON content_queue (business);
CREATE INDEX IF NOT EXISTS idx_content_queue_platform ON content_queue (platform);
CREATE INDEX IF NOT EXISTS idx_content_queue_scheduled ON content_queue (scheduled_for)
  WHERE status = 'approved' AND scheduled_for IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_content_queue_created ON content_queue (created_at DESC);

-- ============================================================
-- TRUST GRADIENT CONFIG
-- ============================================================
-- Per-action permission levels: draft (human approves), auto_notify (auto + tell human), full_auto (silent)

CREATE TABLE IF NOT EXISTS trust_config (
  id SERIAL PRIMARY KEY,
  business TEXT NOT NULL DEFAULT 'tox_tray',
  action_type TEXT NOT NULL,                  -- social_post, listing_update, customer_reply, price_change, analytics_report, content_generate
  permission_level TEXT NOT NULL DEFAULT 'draft',  -- draft, auto_notify, full_auto
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(business, action_type)
);

-- Seed default trust levels (conservative: everything needs approval except reports and content gen)
INSERT INTO trust_config (business, action_type, permission_level) VALUES
  ('tox_tray', 'social_post', 'draft'),
  ('tox_tray', 'listing_update', 'draft'),
  ('tox_tray', 'customer_reply', 'draft'),
  ('tox_tray', 'price_change', 'draft'),
  ('tox_tray', 'analytics_report', 'full_auto'),
  ('tox_tray', 'content_generate', 'full_auto')
ON CONFLICT (business, action_type) DO NOTHING;

-- ============================================================
-- ETSY LISTING CACHE
-- ============================================================
-- Local cache of Etsy listings for context injection and analytics.
-- Populated by sync cron when API keys are available.

CREATE TABLE IF NOT EXISTS etsy_listings (
  id SERIAL PRIMARY KEY,
  listing_id TEXT UNIQUE NOT NULL,
  title TEXT,
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  price_cents INTEGER,
  quantity INTEGER,
  views INTEGER DEFAULT 0,
  favorites INTEGER DEFAULT 0,
  status TEXT,                                -- active, draft, inactive
  images JSONB DEFAULT '[]',                  -- array of image URLs
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_etsy_listings_status ON etsy_listings (status);

-- ============================================================
-- SOCIAL ANALYTICS
-- ============================================================
-- Daily snapshots of post performance across platforms.

CREATE TABLE IF NOT EXISTS social_analytics (
  id SERIAL PRIMARY KEY,
  business TEXT NOT NULL DEFAULT 'tox_tray',
  platform TEXT NOT NULL,
  post_external_id TEXT,
  content_queue_id INTEGER REFERENCES content_queue(id),
  impressions INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  engagement INTEGER DEFAULT 0,               -- likes + comments + shares
  clicks INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_analytics_platform ON social_analytics (platform);
CREATE INDEX IF NOT EXISTS idx_social_analytics_snapshot ON social_analytics (snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_analytics_queue ON social_analytics (content_queue_id)
  WHERE content_queue_id IS NOT NULL;

-- ============================================================
-- RLS POLICIES
-- ============================================================

ALTER TABLE content_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY content_queue_full_access ON content_queue FOR ALL
  USING (true) WITH CHECK (true);

ALTER TABLE trust_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY trust_config_full_access ON trust_config FOR ALL
  USING (true) WITH CHECK (true);

ALTER TABLE etsy_listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY etsy_listings_full_access ON etsy_listings FOR ALL
  USING (true) WITH CHECK (true);

ALTER TABLE social_analytics ENABLE ROW LEVEL SECURITY;
CREATE POLICY social_analytics_full_access ON social_analytics FOR ALL
  USING (true) WITH CHECK (true);

-- ============================================================
-- CLEANUP
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_old_content_queue()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Keep posted/failed items for 90 days, rejected for 30 days
  DELETE FROM content_queue
  WHERE (status IN ('posted', 'failed') AND created_at < now() - interval '90 days')
     OR (status = 'rejected' AND created_at < now() - interval '30 days');
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
