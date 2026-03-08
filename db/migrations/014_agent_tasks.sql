-- Agent Tasks: Supabase-backed task persistence
-- Survives PM2 restarts by storing task state in the database.

CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'research' CHECK (type IN ('research', 'code', 'ingest')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'completed_with_errors', 'failed', 'timeout', 'stalled', 'abandoned')),
  model TEXT NOT NULL DEFAULT 'sonnet',
  prompt TEXT,
  output_file TEXT,
  output_preview TEXT,
  cost_usd FLOAT DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_updated_at ON agent_tasks(updated_at DESC);

-- RLS: allow all for service role (bot uses service key)
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON agent_tasks FOR ALL USING (true);
