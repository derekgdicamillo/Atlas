-- Atlas Prime Sprint 5: every bid recorded for audit + shadow-mode comparison.
CREATE TABLE IF NOT EXISTS marketplace_bids (
  bid_id           TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  bidder_id        TEXT NOT NULL,
  want             BOOLEAN NOT NULL,
  confidence_now   REAL,
  cost_now         REAL,
  reason           TEXT,
  won              BOOLEAN NOT NULL DEFAULT FALSE,
  mode             TEXT NOT NULL CHECK (mode IN ('shadow','live')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_bids_task ON marketplace_bids(task_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_bids_bidder ON marketplace_bids(bidder_id);
