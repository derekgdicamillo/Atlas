-- Atlas Prime Sprint 5: per-surface live/shadow status with promotion audit.
CREATE TABLE IF NOT EXISTS council_surfaces (
  surface       TEXT PRIMARY KEY,
  mode          TEXT NOT NULL CHECK (mode IN ('shadow','live')),
  promoted_by   TEXT,
  promoted_at   TIMESTAMPTZ
);
INSERT INTO council_surfaces (surface, mode) VALUES
  ('outbound_email','shadow'),
  ('brevo_campaign','shadow'),
  ('cal_invite_external','shadow'),
  ('ghl_patient_message','shadow'),
  ('gbp_post','shadow'),
  ('social_publish','shadow'),
  ('wp_post_publish','shadow'),
  ('newsletter_push','shadow')
ON CONFLICT (surface) DO NOTHING;
