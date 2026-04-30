-- Atlas Prime Sprint 5: published role pubkeys (so verification works without filesystem).
CREATE TABLE IF NOT EXISTS role_pubkeys (
  role_id                       TEXT PRIMARY KEY,
  pubkey                        BYTEA NOT NULL,
  ledger_publication_entry_id   TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
