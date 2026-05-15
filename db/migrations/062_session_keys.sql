-- Atlas Prime Sprint 7: per-session ed25519 keypairs for memory signing.
-- Public half stored here; private half kept in-process only.
-- Anchored to global ledger via ledger_entry_id.

CREATE TABLE IF NOT EXISTS session_keys (
  session_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  public_key_pem      TEXT NOT NULL,
  agent               TEXT NOT NULL CHECK (agent IN ('atlas','ishtar')),
  process_pid         INT,
  process_hostname    TEXT,
  ledger_entry_id     TEXT NOT NULL,
  synced_to_shadow_at TIMESTAMPTZ,
  retired_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_session_keys_agent ON session_keys(agent, created_at DESC);

COMMENT ON TABLE session_keys IS
  'Atlas Prime Sprint 7: per-process ed25519 keypair. Private key never leaves the process.';
