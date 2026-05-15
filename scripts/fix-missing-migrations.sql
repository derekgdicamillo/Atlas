-- ============================================================
-- Fix missing Atlas migrations (023 + 031)
-- Paste into Supabase SQL Editor and run.
-- Idempotent: safe to re-run.
-- ============================================================

-- Migration 023: attribution_log table
CREATE TABLE IF NOT EXISTS attribution_log (
  id           BIGSERIAL PRIMARY KEY,
  turn_id      UUID NOT NULL,
  user_id      TEXT NOT NULL,
  agent        TEXT NOT NULL CHECK (agent IN ('atlas', 'ishtar')),
  memory_id    UUID NOT NULL,
  rank         INT NOT NULL,
  rerank_score REAL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attribution_log_turn_id          ON attribution_log(turn_id);
CREATE INDEX IF NOT EXISTS idx_attribution_log_memory_created   ON attribution_log(memory_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attribution_log_created_at       ON attribution_log(created_at);

COMMENT ON TABLE attribution_log IS
  'Atlas Prime Sprint 3: maps (turn_id, memory_id) for retrieval attribution. 90-day retention.';


-- Migration 031: memory_increment_access function
CREATE OR REPLACE FUNCTION memory_increment_access(p_ids UUID[]) RETURNS VOID AS $$
BEGIN
  UPDATE memory
     SET access_count_since_rewrite = access_count_since_rewrite + 1
   WHERE id = ANY(p_ids);
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- Audit (read-only): see which other Sprint 3/4 migrations are
-- missing. Returns one row per object — 'missing' or 'ok'.
-- ============================================================
WITH expected AS (
  SELECT * FROM (VALUES
    ('023', 'table',    'attribution_log',              NULL),
    ('024', 'column',   'needs_rewrite',                'memory'),
    ('025', 'column',   'demotion_pressure',            'memory'),
    ('026', 'table',    'procedures',                   NULL),
    ('027', 'table',    'procedure_outcomes',           NULL),
    ('028', 'column',   'contextual_summary',           'documents'),
    ('029', 'function', 'record_memory_failure',        NULL),
    ('030', 'function', 'memory_backfill_rewrite_status', NULL),
    ('031', 'function', 'memory_increment_access',      NULL),
    ('032', 'function', 'procedures_search',            NULL),
    ('033', 'function', 'episodic_clusters_for_user',   NULL),
    ('034', 'table',    'causal_nodes',                 NULL),
    ('035', 'table',    'causal_edges',                 NULL),
    ('036', 'table',    'causal_observations',          NULL),
    ('037', 'table',    'world_model_forecasts',        NULL),
    ('038', 'table',    'dreams',                       NULL),
    ('039', 'table',    'twin_stated_preferences',      NULL),
    ('040', 'table',    'twin_revealed_observations',   NULL),
    ('041', 'table',    'twin_divergence',              NULL),
    ('042', 'table',    'twin_predictions',             NULL)
  ) AS t(migration, kind, name, parent_table)
)
SELECT
  e.migration,
  e.kind,
  COALESCE(e.parent_table || '.', '') || e.name AS object,
  CASE
    WHEN e.kind = 'table'    AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=e.name) THEN 'ok'
    WHEN e.kind = 'function' AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=e.name) THEN 'ok'
    WHEN e.kind = 'column'   AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=e.parent_table AND column_name=e.name) THEN 'ok'
    ELSE 'MISSING'
  END AS status
FROM expected e
ORDER BY e.migration;
