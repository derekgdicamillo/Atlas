-- Atlas Prime Sprint 6: ivfflat index for soft-DPO semantic match.

CREATE INDEX IF NOT EXISTS idx_dpo_pairs_embedding
  ON dpo_pairs USING ivfflat (embedding vector_cosine_ops) WITH (lists = 30);
