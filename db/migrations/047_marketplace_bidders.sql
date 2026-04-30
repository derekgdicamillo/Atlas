-- Atlas Prime Sprint 5: marketplace bidder registry.
CREATE TABLE IF NOT EXISTS marketplace_bidders (
  bidder_id       TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('skill','subagent')),
  vow_card_json   JSONB NOT NULL,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
