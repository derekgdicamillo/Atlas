/**
 * Atlas — Agent Configuration & Routing
 *
 * Loads agent definitions from config/agents.json.
 * Routes Telegram users to their assigned agent persona.
 * Each agent has its own model, personality, and feature flags.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { MODELS, DEFAULT_MODEL, type ModelTier } from "./constants.ts";

export interface AgentConfig {
  id: string;
  name: string;
  model: ModelTier;
  personalityFile: string;
  systemPrompt: string;
  allowedUserIds: string[];
  description: string;
  features: {
    memory: boolean;
    resume: boolean;
    todos: boolean;
    google?: boolean;
    search?: boolean;
  };
}

interface AgentsFile {
  defaultAgentId: string;
  agents: AgentConfig[];
}

export interface AgentRuntime {
  config: AgentConfig;
  personality: string;  // loaded content of personalityFile
  modelId: string;      // resolved full model ID string
}

const agentsByUser: Map<string, AgentRuntime> = new Map();
const agentsById: Map<string, AgentRuntime> = new Map();
let defaultAgent: AgentRuntime | null = null;
const allAllowedUserIds: Set<string> = new Set();

export function loadAgents(projectRoot: string): void {
  const configPath = join(projectRoot, "config", "agents.json");
  const raw: AgentsFile = JSON.parse(readFileSync(configPath, "utf-8"));

  for (const agent of raw.agents) {
    let personality = "";
    try {
      personality = readFileSync(join(projectRoot, agent.personalityFile), "utf-8");
    } catch {
      console.warn(`[agents] Could not load personality file for ${agent.id}: ${agent.personalityFile}`);
    }

    const runtime: AgentRuntime = {
      config: agent,
      personality,
      modelId: MODELS[agent.model] || MODELS[DEFAULT_MODEL],
    };

    agentsById.set(agent.id, runtime);

    for (const userId of agent.allowedUserIds) {
      agentsByUser.set(userId, runtime);
      allAllowedUserIds.add(userId);
    }
  }

  defaultAgent = agentsById.get(raw.defaultAgentId) || null;
  if (!defaultAgent) {
    throw new Error(`Default agent "${raw.defaultAgentId}" not found in agents.json`);
  }

  console.log(`[agents] Loaded ${raw.agents.length} agent(s): ${raw.agents.map((a) => a.id).join(", ")}`);
}

export function getAgentForUser(userId: string): AgentRuntime | null {
  return agentsByUser.get(userId) || defaultAgent;
}

export function isUserAllowed(userId: string): boolean {
  if (allAllowedUserIds.size === 0) return true;
  return allAllowedUserIds.has(userId);
}

export function getDefaultAgent(): AgentRuntime | null {
  return defaultAgent;
}

export function getAgentById(id: string): AgentRuntime | null {
  return agentsById.get(id) || null;
}
