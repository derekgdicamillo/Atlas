/**
 * Atlas -- Agent Configuration & Routing
 *
 * Loads agent definitions from config/agents.json.
 * Routes Telegram users to their assigned agent persona.
 * Each agent has its own model, personality, and feature flags.
 *
 * Multi-agent routing: agents can be specialized by capability.
 * Cron jobs and tasks specify an agentId to route to the right
 * model and session namespace.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { MODELS, DEFAULT_MODEL, type ModelTier } from "./constants.ts";

export type AgentType = "primary" | "worker" | "specialist";

export interface AgentConfig {
  id: string;
  name: string;
  model: ModelTier;
  personalityFile: string;
  systemPrompt: string;
  allowedUserIds: string[];
  description: string;
  /** Agent type: primary (user-facing), worker (background), specialist (domain-specific) */
  type?: AgentType;
  /** Capability tags for routing (e.g. "search", "analysis", "content", "marketing") */
  capabilities?: string[];
  /** Env var name that resolves to a Telegram chat/group ID. Routes messages from this chat to this agent. */
  groupChatEnv?: string;
  /** Default mode to auto-activate for this agent (e.g. "tox-tray"). Skips mode detection. */
  defaultMode?: string;
  /** Optional workspace directory (relative to project root). Gives the agent its own CLAUDE.md and .claude/ settings. */
  workspaceDir?: string;
  features: {
    memory: boolean;
    resume: boolean;
    todos: boolean;
    google?: boolean;
    search?: boolean;
    dashboard?: boolean;
    ghl?: boolean;
    graph?: boolean;
    careplan?: boolean;
    m365?: boolean;
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
  resolvedWorkspaceDir: string | null; // absolute path if workspaceDir is set
}

const agentsByUser: Map<string, AgentRuntime> = new Map();
const agentsById: Map<string, AgentRuntime> = new Map();
const agentsByChat: Map<string, AgentRuntime> = new Map();
/** Maps bot ID (e.g. "atlas", "ishtar", "coach") to the agent that owns that bot */
const agentsByBotId: Map<string, AgentRuntime> = new Map();
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
      resolvedWorkspaceDir: agent.workspaceDir ? join(projectRoot, agent.workspaceDir) : null,
    };

    agentsById.set(agent.id, runtime);

    for (const userId of agent.allowedUserIds) {
      agentsByUser.set(userId, runtime);
      allAllowedUserIds.add(userId);
    }

    // Resolve group chat routing from env var
    if (agent.groupChatEnv) {
      const chatId = process.env[agent.groupChatEnv];
      if (chatId) {
        agentsByChat.set(chatId, runtime);
        console.log(`[agents] Chat ${agent.groupChatEnv}=${chatId} -> ${agent.id}`);
      }
    }
  }

  // Register primary agents by their bot ID (agent ID = bot ID for primary bots)
  for (const agent of raw.agents) {
    if (agent.type === "primary" || !agent.type) {
      const runtime = agentsById.get(agent.id);
      if (runtime) agentsByBotId.set(agent.id, runtime);
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

/**
 * Route by bot ID (e.g. "atlas", "ishtar", "coach").
 * Each primary bot maps directly to its agent. This takes priority over
 * user-based routing when a dedicated bot exists for an agent.
 */
export function getAgentForBot(botId: string): AgentRuntime | null {
  return agentsByBotId.get(botId) || null;
}

/**
 * Route by Telegram chat/group ID. Returns the dedicated agent for this chat,
 * or null if no agent is mapped (caller should fall back to user-based routing).
 */
export function getAgentForChat(chatId: string): AgentRuntime | null {
  return agentsByChat.get(chatId) || null;
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

/**
 * Find the best agent for a given capability.
 * Returns the first agent with the matching capability,
 * or the default agent if no specialist is found.
 */
export function getAgentForCapability(capability: string): AgentRuntime | null {
  for (const agent of agentsById.values()) {
    if (agent.config.capabilities?.includes(capability)) {
      return agent;
    }
  }
  return defaultAgent;
}

/**
 * List all registered agents (for /agents command).
 */
export function listAgentSummaries(): { id: string; name: string; model: ModelTier; type: AgentType; capabilities: string[]; description: string }[] {
  const result: { id: string; name: string; model: ModelTier; type: AgentType; capabilities: string[]; description: string }[] = [];
  for (const agent of agentsById.values()) {
    result.push({
      id: agent.config.id,
      name: agent.config.name,
      model: agent.config.model,
      type: agent.config.type || "primary",
      capabilities: agent.config.capabilities || [],
      description: agent.config.description,
    });
  }
  return result;
}

/**
 * Format agent list for Telegram display.
 */
export function formatAgentsList(): string {
  const agents = listAgentSummaries();
  if (agents.length === 0) return "No agents configured.";

  const lines: string[] = ["Registered Agents:\n"];
  for (const a of agents) {
    const caps = a.capabilities.length > 0 ? ` [${a.capabilities.join(", ")}]` : "";
    lines.push(`  ${a.id} (${a.model}, ${a.type})${caps}`);
    lines.push(`    ${a.description}`);
  }
  return lines.join("\n");
}
