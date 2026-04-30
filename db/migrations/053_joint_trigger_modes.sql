-- Atlas Prime Sprint 5: per-trigger live/shadow status. Explicit tag ships live; rest shadow.
CREATE TABLE IF NOT EXISTS joint_trigger_modes (
  trigger_name   TEXT PRIMARY KEY,
  mode           TEXT NOT NULL CHECK (mode IN ('shadow','live')),
  promoted_by    TEXT,
  promoted_at    TIMESTAMPTZ
);
INSERT INTO joint_trigger_modes (trigger_name, mode) VALUES
  ('hire-fire','shadow'),
  ('capex-over-5k','shadow'),
  ('calendar-conflict','shadow'),
  ('brand-tone-change','shadow'),
  ('spec-tagged-joint','live')
ON CONFLICT (trigger_name) DO NOTHING;
