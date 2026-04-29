-- Atlas Prime Sprint 4: Derek Twin morning predictions + evening match scores.

CREATE TABLE IF NOT EXISTS twin_predictions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  predicted_for   DATE NOT NULL,
  prediction      TEXT NOT NULL,
  confidence      REAL NOT NULL,
  basis           TEXT NOT NULL,
  basis_refs      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_turn_id UUID,
  match_score     REAL,
  matched_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_twin_predictions_user_date
  ON twin_predictions(user_id, predicted_for);
