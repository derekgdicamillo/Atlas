-- Atlas Prime Sprint 3: per-execution outcome log for procedures.

CREATE TABLE IF NOT EXISTS procedure_outcomes (
  id              BIGSERIAL PRIMARY KEY,
  procedure_id    UUID NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
  success         BOOLEAN NOT NULL,
  ledger_entry_id TEXT,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procedure_outcomes_procedure ON procedure_outcomes(procedure_id, observed_at);
