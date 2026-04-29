-- Atlas Prime Sprint 3: contextual chunking columns on documents table.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS context_preamble TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunked_strategy TEXT NOT NULL DEFAULT 'raw'
  CHECK (chunked_strategy IN ('raw', 'contextual-v1'));

CREATE INDEX IF NOT EXISTS idx_documents_chunked_strategy
  ON documents(chunked_strategy) WHERE chunked_strategy = 'raw';

COMMENT ON COLUMN documents.chunked_strategy IS
  'raw = legacy non-contextual chunks; contextual-v1 = preamble-prepended embeddings.';
