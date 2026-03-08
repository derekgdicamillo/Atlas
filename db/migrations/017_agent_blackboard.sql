-- Migration: Blackboard table for swarm inter-agent communication
-- Atlas v2026.3.6
-- Agents in a swarm post findings here. Other agents read them.

CREATE TABLE IF NOT EXISTS agent_blackboard (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  swarm_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (swarm_id, key)
);

-- Fast lookup by swarm
CREATE INDEX IF NOT EXISTS idx_blackboard_swarm_id ON agent_blackboard(swarm_id);
