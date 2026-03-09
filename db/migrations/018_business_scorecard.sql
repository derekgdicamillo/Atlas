-- ============================================================
-- Atlas Business Scorecard Migration
-- Single source of truth for all PV MediSpa business metrics.
-- Daily rows are auto-populated by Atlas crons.
-- Monthly rows are validated by Derek (AR export + QB close).
-- Dashboard and all Atlas modules read from this table only.
-- Run in Supabase SQL Editor.
-- ============================================================

-- ============================================================
-- 1. BUSINESS_SCORECARD TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS business_scorecard (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  period_type TEXT NOT NULL CHECK (period_type IN ('daily', 'monthly')),

  -- THE MONEY (monthly from QB, daily shows MTD estimate)
  revenue NUMERIC,                -- monthly total or MTD
  cogs NUMERIC,                   -- cost of goods sold
  gross_margin NUMERIC,           -- percentage: (revenue - cogs) / revenue * 100
  net_income NUMERIC,             -- revenue - cogs - opex
  net_margin NUMERIC,             -- percentage: net_income / revenue * 100
  cash_on_hand NUMERIC,           -- QB balance sheet

  -- THE BUCKET (monthly from AR export)
  active_patients INTEGER,        -- unique names with "active" status in AR
  mrr NUMERIC,                    -- sum of all active membership fees
  new_patients INTEGER,           -- true new patients (not tier switches)
  cancellations INTEGER,          -- true exits in period
  churn_rate NUMERIC,             -- monthly %: true_exits / avg_active_base / months
  annual_churn NUMERIC,           -- 1 - (1 - monthly_churn)^12
  avg_tenure_months NUMERIC,      -- 1 / monthly_churn_rate
  median_tenure_months NUMERIC,   -- measured from patient start dates
  ltv NUMERIC,                    -- GP/patient/mo * avg_tenure

  -- THE FUNNEL (daily from Meta + GHL APIs)
  leads INTEGER,                  -- new leads created (Meta standard Lead event)
  ad_spend NUMERIC,               -- Meta Ads total spend
  cpl NUMERIC,                    -- ad_spend / leads
  impressions INTEGER,            -- Meta Ads impressions
  clicks INTEGER,                 -- Meta Ads link clicks
  ctr NUMERIC,                    -- percentage: clicks / impressions * 100
  lp_views INTEGER,               -- landing page views
  show_rate NUMERIC,              -- percentage: showed / (showed + no_show) * 100
  close_rate NUMERIC,             -- percentage: won / total_decided * 100
  cac NUMERIC,                    -- ad_spend_in_period / patients_won
  ltv_cac_ratio NUMERIC,          -- ltv / cac

  -- PIPELINE SNAPSHOT (daily from GHL)
  pipeline_total INTEGER,
  pipeline_open INTEGER,
  pipeline_won INTEGER,
  pipeline_lost INTEGER,
  pipeline_noshow INTEGER,

  -- PROVENANCE
  source TEXT NOT NULL DEFAULT 'atlas',   -- who wrote: atlas, midas, derek, dashboard
  validated BOOLEAN NOT NULL DEFAULT FALSE, -- Derek confirmed this row
  notes TEXT,                             -- human notes on corrections, anomalies
  metadata JSONB NOT NULL DEFAULT '{}',   -- overflow: tier_breakdown, expense_categories, med_costs, etc.

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(date, period_type)
);

-- ============================================================
-- 2. INDEXES
-- ============================================================

-- Dashboard queries: "latest monthly + last 90 daily"
CREATE INDEX IF NOT EXISTS idx_scorecard_period_date
  ON business_scorecard(period_type, date DESC);

-- Date range queries
CREATE INDEX IF NOT EXISTS idx_scorecard_date
  ON business_scorecard(date DESC);

-- ============================================================
-- 3. AUTO-UPDATE updated_at TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION update_scorecard_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scorecard_updated_at ON business_scorecard;
CREATE TRIGGER trg_scorecard_updated_at
  BEFORE UPDATE ON business_scorecard
  FOR EACH ROW EXECUTE FUNCTION update_scorecard_updated_at();

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE business_scorecard ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON business_scorecard FOR ALL USING (true);

-- ============================================================
-- 5. HELPER RPCs
-- ============================================================

-- Get the latest monthly validated row
CREATE OR REPLACE FUNCTION get_latest_monthly_scorecard()
RETURNS SETOF business_scorecard AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM business_scorecard
  WHERE period_type = 'monthly'
  ORDER BY date DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Get daily history for sparklines (default 90 days)
CREATE OR REPLACE FUNCTION get_daily_scorecard(p_days INT DEFAULT 90)
RETURNS SETOF business_scorecard AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM business_scorecard
  WHERE period_type = 'daily'
    AND date >= CURRENT_DATE - p_days
  ORDER BY date ASC;
END;
$$ LANGUAGE plpgsql;

-- Get full scorecard (latest monthly + daily history)
-- Returns all rows, caller separates by period_type
CREATE OR REPLACE FUNCTION get_scorecard(p_daily_days INT DEFAULT 90)
RETURNS SETOF business_scorecard AS $$
BEGIN
  RETURN QUERY
  (
    SELECT *
    FROM business_scorecard
    WHERE period_type = 'monthly'
    ORDER BY date DESC
    LIMIT 1
  )
  UNION ALL
  (
    SELECT *
    FROM business_scorecard
    WHERE period_type = 'daily'
      AND date >= CURRENT_DATE - p_daily_days
    ORDER BY date ASC
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 6. CLEANUP (retain 1 year daily, monthly forever)
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_old_scorecard()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM business_scorecard
  WHERE period_type = 'daily'
    AND date < CURRENT_DATE - INTERVAL '365 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
