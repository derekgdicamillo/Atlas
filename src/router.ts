/**
 * Atlas — Model Router + Cost Control
 *
 * Picks the right model per task type. Enforces budget across the swarm.
 * Tracks cost in real time and downgrades models under budget pressure.
 */

import { info } from "./logger.ts";
import {
  TOKEN_COSTS,
  RESEARCH_DEFAULT_MODEL,
  CODE_DEFAULT_MODEL,
  SYNTHESIZE_DEFAULT_MODEL,
  VALIDATE_DEFAULT_MODEL,
  BUDGET_PRESSURE_THRESHOLD,
  type ModelTier,
} from "./constants.ts";
import type { NodeType, SwarmBudget } from "./dag.ts";

// ============================================================
// CAPABILITY REGISTRY
// ============================================================

export interface ModelCapability {
  model: ModelTier;
  strengths: NodeType[];
  costPer1kInput: number;
  costPer1kOutput: number;
  avgLatencyMs: number;
  contextWindow: number;
}

export const MODEL_REGISTRY: ModelCapability[] = [
  {
    model: "opus",
    strengths: ["code", "synthesize"],
    costPer1kInput: TOKEN_COSTS.opus.input / 1000,
    costPer1kOutput: TOKEN_COSTS.opus.output / 1000,
    avgLatencyMs: 45000,
    contextWindow: 200000,
  },
  {
    model: "sonnet",
    strengths: ["research", "synthesize", "validate"],
    costPer1kInput: TOKEN_COSTS.sonnet.input / 1000,
    costPer1kOutput: TOKEN_COSTS.sonnet.output / 1000,
    avgLatencyMs: 15000,
    contextWindow: 200000,
  },
  {
    model: "haiku",
    strengths: ["research", "validate"],
    costPer1kInput: TOKEN_COSTS.haiku.input / 1000,
    costPer1kOutput: TOKEN_COSTS.haiku.output / 1000,
    avgLatencyMs: 5000,
    contextWindow: 200000,
  },
];

// ============================================================
// MODEL SELECTION
// ============================================================

/**
 * Cost estimates per node type per model (USD, rough averages).
 */
const COST_ESTIMATES: Record<string, number> = {
  "research:haiku": 0.02,
  "research:sonnet": 0.10,
  "research:opus": 0.50,
  "code:haiku": 0.05,
  "code:sonnet": 0.25,
  "code:opus": 1.00,
  "synthesize:haiku": 0.01,
  "synthesize:sonnet": 0.15,
  "synthesize:opus": 0.40,
  "validate:haiku": 0.01,
  "validate:sonnet": 0.05,
  "validate:opus": 0.20,
};

/**
 * Select the best model for a node given budget constraints.
 */
export function selectModel(
  nodeType: NodeType,
  budget: SwarmBudget,
  explicitModel?: ModelTier | null,
): ModelTier {
  // Explicit override always wins
  if (explicitModel) return explicitModel;

  // Calculate budget pressure
  const remaining = budget.maxCostUsd - budget.spentUsd;
  const nodesLeft = budget.maxNodes; // rough, could track actual remaining
  const avgBudgetPerNode = remaining / Math.max(nodesLeft, 1);

  // Under heavy budget pressure, force haiku
  if (avgBudgetPerNode < BUDGET_PRESSURE_THRESHOLD) {
    info("router", `Budget pressure: $${avgBudgetPerNode.toFixed(2)}/node, using haiku for ${nodeType}`);
    return "haiku";
  }

  // Default routing by task type
  switch (nodeType) {
    case "code": return CODE_DEFAULT_MODEL;
    case "synthesize": return SYNTHESIZE_DEFAULT_MODEL;
    case "validate": return VALIDATE_DEFAULT_MODEL;
    case "research": return RESEARCH_DEFAULT_MODEL;
    default: return RESEARCH_DEFAULT_MODEL;
  }
}

/**
 * Estimate the cost of running a node with a given model.
 */
export function estimateNodeCost(nodeType: NodeType, model: ModelTier): number {
  return COST_ESTIMATES[`${nodeType}:${model}`] || 0.20;
}

// ============================================================
// BUDGET CHECKS
// ============================================================

export interface BudgetCheck {
  allowed: boolean;
  reason?: string;
  suggestedModel?: ModelTier;
}

/**
 * Check if budget allows dispatching a new node.
 */
export function checkBudget(
  nodeType: NodeType,
  model: ModelTier,
  budget: SwarmBudget,
): BudgetCheck {
  const remaining = budget.maxCostUsd - budget.spentUsd;

  // Hard stop
  if (remaining < 0.05) {
    return { allowed: false, reason: "Budget exhausted" };
  }

  const estimatedCost = estimateNodeCost(nodeType, model);

  // Can afford this node?
  if (estimatedCost > remaining) {
    // Try cheaper model
    const cheaperModel = model === "opus" ? "sonnet" : model === "sonnet" ? "haiku" : null;
    if (cheaperModel) {
      const cheaperCost = estimateNodeCost(nodeType, cheaperModel);
      if (cheaperCost <= remaining) {
        return {
          allowed: true,
          suggestedModel: cheaperModel,
          reason: `Budget tight ($${remaining.toFixed(2)} remaining), downgrading to ${cheaperModel}`,
        };
      }
    }
    return { allowed: false, reason: `Estimated cost $${estimatedCost.toFixed(2)} exceeds remaining budget $${remaining.toFixed(2)}` };
  }

  return { allowed: true };
}
