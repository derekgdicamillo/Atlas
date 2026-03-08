/**
 * Atlas — Model Router
 *
 * Planner-worker model routing. Haiku triages, Sonnet plans, Opus executes complex code.
 * Formalizes the tiered model routing pattern used across cron jobs, subagents, and skills.
 */


import { MODELS, type ModelTier } from "./constants.ts";

// ============================================================
// TYPES
// ============================================================

export type TaskComplexity = "trivial" | "simple" | "moderate" | "complex";

export interface RouteResult {
  model: ModelTier;
  modelId: string;
  reason: string;
}

// ============================================================
// TASK TYPE CATEGORIES
// ============================================================

const MONITORING_TASKS = new Set([
  "health-check", "heartbeat", "alert-deliver", "scheduled-msgs",
  "supervisor-worker", "metric-cleanup", "progress-cleanup",
  "event-cleanup", "lead-volume", "anomaly-scan",
]);

const CONTENT_TASKS = new Set([
  "content-engine", "overnight-content", "content-waterfall",
  "ad-creative", "social-post", "newsletter", "blog-post",
]);

const RESEARCH_TASKS = new Set([
  "research", "competitive-intel", "market-analysis",
  "seo-analysis", "deep-research", "learning-queue",
]);

const CODE_TASKS = new Set([
  "code-agent", "code-review", "refactor", "bug-fix",
  "feature", "architecture", "evolution",
]);

// ============================================================
// MODEL ROUTING
// ============================================================

/**
 * Route a task to the appropriate model tier based on task type and complexity.
 *
 * Haiku: trivial tasks, monitoring, validation.
 * Sonnet: content, research, moderate complexity.
 * Opus: complex code, architectural decisions.
 */
export function routeModel(taskType: string, complexity: TaskComplexity): RouteResult {
  // Trivial: always Haiku (cheapest, fastest)
  if (complexity === "trivial") {
    return {
      model: "haiku",
      modelId: MODELS.haiku,
      reason: `Trivial complexity, Haiku sufficient for ${taskType}`,
    };
  }

  // Simple: Haiku for monitoring, Sonnet for content/research
  if (complexity === "simple") {
    if (MONITORING_TASKS.has(taskType)) {
      return {
        model: "haiku",
        modelId: MODELS.haiku,
        reason: `Simple monitoring task: ${taskType}`,
      };
    }
    return {
      model: "sonnet",
      modelId: MODELS.sonnet,
      reason: `Simple ${taskType}, Sonnet for quality`,
    };
  }

  // Moderate: Sonnet for everything
  if (complexity === "moderate") {
    return {
      model: "sonnet",
      modelId: MODELS.sonnet,
      reason: `Moderate complexity ${taskType}, Sonnet balanced`,
    };
  }

  // Complex: Opus for code, Sonnet for everything else
  if (CODE_TASKS.has(taskType)) {
    return {
      model: "opus",
      modelId: MODELS.opus,
      reason: `Complex code task: ${taskType}, Opus for precision`,
    };
  }

  return {
    model: "sonnet",
    modelId: MODELS.sonnet,
    reason: `Complex non-code task: ${taskType}, Sonnet sufficient`,
  };
}

// ============================================================
// COMPLEXITY ESTIMATION
// ============================================================

/**
 * Estimate task complexity from a description using a quick Haiku call (~$0.01).
 * Falls back to "moderate" if the classification call fails.
 */
export async function estimateComplexity(description: string): Promise<TaskComplexity> {
  try {
    const { runPrompt } = await import("./prompt-runner.ts");
    const prompt = `Classify the complexity of this task as exactly one word: trivial, simple, moderate, or complex.\n\nTask: ${description}\n\nRespond with ONLY the complexity level, nothing else.`;

    const text = (await runPrompt(prompt, MODELS.haiku) || "moderate").trim().toLowerCase();

    const valid: TaskComplexity[] = ["trivial", "simple", "moderate", "complex"];
    if (valid.includes(text as TaskComplexity)) {
      return text as TaskComplexity;
    }

    // Try to extract from a longer response
    for (const level of valid) {
      if (text.includes(level)) return level;
    }

    return "moderate";
  } catch {
    // On any failure, default to moderate (safe middle ground)
    return "moderate";
  }
}

// ============================================================
// CONVENIENCE
// ============================================================

/**
 * One-shot: estimate complexity and route in a single call.
 * Useful when you have a description but no pre-classified complexity.
 */
export async function autoRoute(taskType: string, description: string): Promise<RouteResult> {
  const complexity = await estimateComplexity(description);
  return routeModel(taskType, complexity);
}
