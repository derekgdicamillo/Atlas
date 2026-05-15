-- Atlas Prime Sprint 7: signature columns on memory + verification failure log.
-- Legacy pre-Sprint-7 rows have NULL signature and pass with 'legacy_pre_sprint7' note.

ALTER TABLE memory ADD COLUMN IF NOT EXISTS session_id       UUID REFERENCES session_keys(session_id);
ALTER TABLE memory ADD COLUMN IF NOT EXISTS signature        TEXT;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS sig_payload_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_session ON memory(session_id);

CREATE TABLE IF NOT EXISTS memory_verification_failures (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  memory_id     UUID NOT NULL,
  session_id    UUID,
  reason        TEXT NOT NULL,
  payload_hash  TEXT,
  expected_sig  TEXT,
  observed_sig  TEXT
);

CREATE INDEX IF NOT EXISTS idx_mvf_ts ON memory_verification_failures(ts DESC);

COMMENT ON TABLE memory_verification_failures IS
  'Atlas Prime Sprint 7: ed25519 verification mismatches on memory load. Excluded from search results.';
