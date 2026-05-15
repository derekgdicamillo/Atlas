-- Atlas Prime Sprint 6: Skill shadow-routing judge verdicts.
-- Rolling 10-invocation window per skill determines 7/10 auto-promotion.

CREATE TABLE IF NOT EXISTS skill_shadow_scores (
  id                BIGSERIAL PRIMARY KEY,
  task_id           UUID NOT NULL,
  skill_id          TEXT NOT NULL,
  baseline_skill_id TEXT NOT NULL,
  task_kind         TEXT NOT NULL,
  domain            TEXT NOT NULL,
  judge_verdict     TEXT NOT NULL CHECK (judge_verdict IN ('shadow_wins','baseline_wins','tie')),
  judge_reason      TEXT,
  derek_veto        BOOLEAN NOT NULL DEFAULT FALSE,
  derek_veto_at     TIMESTAMPTZ,
  scored_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shadow_scores_skill ON skill_shadow_scores(skill_id, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_scores_active ON skill_shadow_scores(skill_id, scored_at DESC)
  WHERE derek_veto = FALSE;
