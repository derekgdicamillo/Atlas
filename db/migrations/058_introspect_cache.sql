-- Atlas Prime Sprint 6: /why introspection cache. 30-day TTL purged nightly.

CREATE TABLE IF NOT EXISTS introspect_cache (
  turn_id                  UUID PRIMARY KEY,
  reconstructed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  time_then                TEXT NOT NULL,
  time_now                 TEXT NOT NULL,
  delta_reasoning          TEXT NOT NULL,
  cited_memory_ids         UUID[] NOT NULL DEFAULT '{}',
  cited_ledger_shas        TEXT[] NOT NULL DEFAULT '{}',
  cited_dag_edges          UUID[] NOT NULL DEFAULT '{}',
  cited_council_review_ids UUID[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_introspect_cache_age
  ON introspect_cache(reconstructed_at DESC);
