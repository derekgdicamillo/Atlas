-- QuickBooks OAuth token storage
-- Replaces Vercel Blob (which had CDN caching issues)
-- Single row, keyed by id = 'default'

CREATE TABLE IF NOT EXISTS qb_tokens (
  id TEXT PRIMARY KEY DEFAULT 'default',
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  realm_id TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  refresh_expires_at BIGINT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS: allow dashboard service role full access
ALTER TABLE qb_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON qb_tokens
  FOR ALL USING (true) WITH CHECK (true);
