-- ============================================================
-- Atlas TMAA Partners Migration
-- Partner directory for newsletter rotation and SAGE training
-- Run in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- 1. TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS tmaa_partners (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  description TEXT NOT NULL,
  discount_code TEXT,
  discount_description TEXT,
  url TEXT,
  category TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_tmaa_partners_active ON tmaa_partners (active);
CREATE INDEX IF NOT EXISTS idx_tmaa_partners_category ON tmaa_partners (category);

-- ============================================================
-- 3. UPDATED_AT TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION update_tmaa_partners_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tmaa_partners_updated_at ON tmaa_partners;
CREATE TRIGGER trg_tmaa_partners_updated_at
  BEFORE UPDATE ON tmaa_partners
  FOR EACH ROW EXECUTE FUNCTION update_tmaa_partners_updated_at();

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE tmaa_partners ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON tmaa_partners FOR ALL USING (true);

-- ============================================================
-- 5. SEED DATA
-- ============================================================

INSERT INTO tmaa_partners (name, contact_name, description, discount_code, discount_description, url, category) VALUES
  ('HRT University', 'Nico Misleh, NP', 'Comprehensive hormone replacement therapy certification for nurse practitioners and physician assistants. Covers bioidentical hormones, pellet therapy, and practice integration. Ideal for practitioners expanding into HRT services.', 'DEREKMC5', '$200 off certification course', 'https://hrtuniversity.com', 'training'),
  ('Peptide Prescribing', 'Ashlee Hess, APRN', 'Advanced peptide therapy training and prescribing protocols for aesthetic and functional medicine practitioners. Covers BPC-157, CJC-1295/Ipamorelin, thymosin alpha-1, and clinical applications.', 'PS5', '~5% off', 'https://peptideprescribing.com', 'clinical'),
  ('The Protected Practice', 'Courtney', 'Legal compliance, practice protection, and risk management services for medical aesthetics practices. Covers HIPAA, informed consent, scope of practice, and malpractice prevention.', 'DEREK', '5% off', 'https://theprotectedpractice.com', 'legal'),
  ('Scripts', NULL, 'Pharmacy network offering competitive pricing on GLP-1 medications, compounded peptides, and aesthetic injectables. Preferred pricing for TMAA members on all compounded formulations.', 'ANEpharm', 'Preferred pricing', NULL, 'pharmacy');
