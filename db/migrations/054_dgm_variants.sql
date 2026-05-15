-- Atlas Prime Sprint 6: DGM Fork variants — nightly proposed mutations to src/+rules.
-- Tiered scoring (build → test → 10-conv smoke → 50-conv full) → merge list to Derek.

CREATE TABLE IF NOT EXISTS dgm_variants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  target_file         TEXT NOT NULL,
  target_kind         TEXT NOT NULL CHECK (target_kind IN ('skill','role-prompt','behavioral-fix','heuristic','rule','system-prompt')),
  variant_branch      TEXT NOT NULL,
  diff_summary        TEXT NOT NULL,
  opus_rationale      TEXT NOT NULL,
  build_passed        BOOLEAN,
  tests_passed        BOOLEAN,
  smoke_aggregate     REAL,
  full_aggregate      REAL,
  main_aggregate      REAL,
  delta_aggregate     REAL,
  delta_groundedness  REAL,
  delta_tool          REAL,
  delta_refusal       REAL,
  status              TEXT NOT NULL CHECK (status IN ('proposed','built','tested','smoked','scored','queued','approved','rejected','merged','archived')),
  rejected_reason     TEXT,
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,
  merge_commit_sha    TEXT,
  ledger_entry_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_dgm_variants_status ON dgm_variants(status);
CREATE INDEX IF NOT EXISTS idx_dgm_variants_proposed ON dgm_variants(proposed_at DESC);

COMMENT ON TABLE dgm_variants IS
  'Atlas Prime Sprint 6: nightly DGM variants — one row per proposed mutation through the scoring pipeline.';
