/**
 * Atlas — Shadow Evaluator
 *
 * LLM-based evaluation of code agent progress. Runs in parallel with the agent,
 * checking every N tool calls to assess coherence, approach, and efficiency.
 *
 * Uses Haiku for fast, cheap evaluations (~$0.002 per eval).
 * Returns intervention decisions: none, warn, kill_restart, kill_abort.
 */

import Anthropic from "@anthropic-ai/sdk";
import { info, warn, error as logError } from "./logger.ts";
import { MODELS, TOKEN_COSTS, type ModelTier } from "./constants.ts";
import type { PatternDetector } from "./patterns.ts";

// ============================================================
// TYPES
// ============================================================

export type EvaluationDecision = "none" | "warn" | "kill_restart" | "kill_abort";

export interface EvaluationResult {
  decision: EvaluationDecision;
  reasoning: string;
  coherenceScore: number; // 0-10
  approachScore: number; // 0-10
  efficiencyScore: number; // 0-10
  suggestions: string[];
  costUsd: number;
  durationMs: number;
}

export interface EvaluationContext {
  taskId: string;
  originalPrompt: string;
  toolCallCount: number;
  elapsedSec: number;
  costUsd: number;
  recentTools: string[];
  lastFile?: string;
  patternSummary?: ReturnType<PatternDetector["getSummary"]>;
  previousEvals?: EvaluationResult[];
}

// ============================================================
// CONFIGURATION
// ============================================================

/** Default model for shadow evaluation */
const DEFAULT_EVAL_MODEL: ModelTier = "haiku";

/** Evaluation prompt template */
const EVALUATION_PROMPT = `You are a code agent supervisor. Evaluate the agent's progress and decide if intervention is needed.

## Task
{TASK_PROMPT}

## Current Status
- Tool calls: {TOOL_COUNT}
- Elapsed time: {ELAPSED_SEC}s
- Cost so far: ${"{COST_USD}"}
- Recent tools: {RECENT_TOOLS}
- Last file touched: {LAST_FILE}

## Pattern Detection Summary
{PATTERN_SUMMARY}

## Previous Evaluations
{PREV_EVALS}

## Evaluation Criteria

Score each dimension 0-10:
1. **Coherence**: Is the agent making logical progress toward the goal?
2. **Approach**: Is the current strategy likely to succeed?
3. **Efficiency**: Is the agent being efficient (not looping, thrashing, or wasting calls)?

## Decision Options
- **none**: Agent is on track, no intervention needed
- **warn**: Minor concerns but let it continue (will alert human)
- **kill_restart**: Agent is stuck/looping, kill and restart with better guidance
- **kill_abort**: Agent is fundamentally broken, abort entirely

## Response Format (JSON only)
{
  "coherenceScore": <0-10>,
  "approachScore": <0-10>,
  "efficiencyScore": <0-10>,
  "decision": "<none|warn|kill_restart|kill_abort>",
  "reasoning": "<brief explanation>",
  "suggestions": ["<suggestion for restart prompt if kill_restart>"]
}`;

// ============================================================
// SHADOW EVALUATOR CLASS
// ============================================================

export class ShadowEvaluator {
  private client: Anthropic;
  private model: ModelTier;
  private evaluationHistory: EvaluationResult[] = [];
  private enabled: boolean;

  constructor(options: { model?: ModelTier; enabled?: boolean } = {}) {
    this.client = new Anthropic();
    this.model = options.model || DEFAULT_EVAL_MODEL;
    this.enabled = options.enabled ?? true;
  }

  /**
   * Evaluate the current state of a code agent.
   * Returns evaluation result with decision and scores.
   */
  async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
    if (!this.enabled) {
      return this.noOpResult();
    }

    const startTime = Date.now();

    try {
      const prompt = this.buildPrompt(context);

      const response = await this.client.messages.create({
        model: MODELS[this.model],
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const durationMs = Date.now() - startTime;
      const costUsd = this.calculateCost(response.usage);

      // Parse response
      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const result = this.parseResponse(text, costUsd, durationMs);

      // Store in history
      this.evaluationHistory.push(result);
      if (this.evaluationHistory.length > 10) {
        this.evaluationHistory = this.evaluationHistory.slice(-10);
      }

      info(
        "shadow-eval",
        `[${context.taskId}] Eval: coherence=${result.coherenceScore} approach=${result.approachScore} efficiency=${result.efficiencyScore} -> ${result.decision}`
      );

      return result;
    } catch (err) {
      logError("shadow-eval", `Evaluation failed: ${err}`);
      return this.noOpResult();
    }
  }

  /**
   * Check if evaluation should run based on tool call count and interval.
   */
  shouldEvaluate(toolCallCount: number, interval: number): boolean {
    if (!this.enabled) return false;
    return toolCallCount > 0 && toolCallCount % interval === 0;
  }

  /**
   * Get evaluation history for context.
   */
  getHistory(): EvaluationResult[] {
    return [...this.evaluationHistory];
  }

  /**
   * Reset evaluator state (e.g., after restart).
   */
  reset(): void {
    this.evaluationHistory = [];
  }

  /**
   * Enable or disable the evaluator.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  // ============================================================
  // INTERNAL METHODS
  // ============================================================

  private buildPrompt(context: EvaluationContext): string {
    let prompt = EVALUATION_PROMPT;

    prompt = prompt.replace("{TASK_PROMPT}", context.originalPrompt.substring(0, 500));
    prompt = prompt.replace("{TOOL_COUNT}", String(context.toolCallCount));
    prompt = prompt.replace("{ELAPSED_SEC}", String(context.elapsedSec));
    prompt = prompt.replace("{COST_USD}", context.costUsd.toFixed(4));
    prompt = prompt.replace("{RECENT_TOOLS}", context.recentTools.join(", "));
    prompt = prompt.replace("{LAST_FILE}", context.lastFile || "none");

    // Pattern summary
    if (context.patternSummary) {
      const ps = context.patternSummary;
      prompt = prompt.replace(
        "{PATTERN_SUMMARY}",
        `- Consecutive globs: ${ps.consecutiveGlobs}
- Consecutive errors: ${ps.consecutiveErrors}
- Tools since write: ${ps.toolsSinceWrite}
- Has written/edited: ${ps.hasWrittenOrEdited}
- Unique files read: ${ps.uniqueFilesRead}`
      );
    } else {
      prompt = prompt.replace("{PATTERN_SUMMARY}", "Not available");
    }

    // Previous evaluations
    if (context.previousEvals && context.previousEvals.length > 0) {
      const prevSummary = context.previousEvals
        .slice(-3)
        .map(
          (e) =>
            `- coherence=${e.coherenceScore} approach=${e.approachScore} efficiency=${e.efficiencyScore} decision=${e.decision}`
        )
        .join("\n");
      prompt = prompt.replace("{PREV_EVALS}", prevSummary);
    } else {
      prompt = prompt.replace("{PREV_EVALS}", "No previous evaluations");
    }

    return prompt;
  }

  private parseResponse(text: string, costUsd: number, durationMs: number): EvaluationResult {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = text;
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      const parsed = JSON.parse(jsonStr.trim());

      return {
        decision: this.validateDecision(parsed.decision),
        reasoning: String(parsed.reasoning || "No reasoning provided"),
        coherenceScore: this.clampScore(parsed.coherenceScore),
        approachScore: this.clampScore(parsed.approachScore),
        efficiencyScore: this.clampScore(parsed.efficiencyScore),
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        costUsd,
        durationMs,
      };
    } catch (err) {
      warn("shadow-eval", `Failed to parse evaluation response: ${err}`);
      return {
        decision: "none",
        reasoning: "Failed to parse evaluation response",
        coherenceScore: 5,
        approachScore: 5,
        efficiencyScore: 5,
        suggestions: [],
        costUsd,
        durationMs,
      };
    }
  }

  private validateDecision(decision: unknown): EvaluationDecision {
    const valid: EvaluationDecision[] = ["none", "warn", "kill_restart", "kill_abort"];
    if (typeof decision === "string" && valid.includes(decision as EvaluationDecision)) {
      return decision as EvaluationDecision;
    }
    return "none";
  }

  private clampScore(score: unknown): number {
    if (typeof score !== "number") return 5;
    return Math.max(0, Math.min(10, Math.round(score)));
  }

  private calculateCost(usage: { input_tokens: number; output_tokens: number }): number {
    const rates = TOKEN_COSTS[this.model];
    return (usage.input_tokens * rates.input + usage.output_tokens * rates.output) / 1_000_000;
  }

  private noOpResult(): EvaluationResult {
    return {
      decision: "none",
      reasoning: "Evaluation disabled or skipped",
      coherenceScore: 5,
      approachScore: 5,
      efficiencyScore: 5,
      suggestions: [],
      costUsd: 0,
      durationMs: 0,
    };
  }
}

// ============================================================
// FACTORY FUNCTION
// ============================================================

/**
 * Create a new shadow evaluator.
 */
export function createShadowEvaluator(options?: {
  model?: ModelTier;
  enabled?: boolean;
}): ShadowEvaluator {
  return new ShadowEvaluator(options);
}

// ============================================================
// EVALUATION STORAGE
// ============================================================

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const EVALUATIONS_FILE = join(DATA_DIR, "task-evaluations.json");

interface StoredEvaluation {
  taskId: string;
  timestamp: string;
  result: EvaluationResult;
  context: Partial<EvaluationContext>;
}

interface EvaluationStore {
  evaluations: StoredEvaluation[];
  totalEvaluations: number;
}

let evalStore: EvaluationStore | null = null;

async function loadEvaluationStore(): Promise<EvaluationStore> {
  if (evalStore) return evalStore;

  try {
    if (existsSync(EVALUATIONS_FILE)) {
      const content = await readFile(EVALUATIONS_FILE, "utf-8");
      evalStore = JSON.parse(content);
    }
  } catch (err) {
    warn("shadow-eval", `Failed to load evaluations: ${err}`);
  }

  if (!evalStore) {
    evalStore = { evaluations: [], totalEvaluations: 0 };
  }

  return evalStore;
}

async function saveEvaluationStore(): Promise<void> {
  if (!evalStore) return;

  try {
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }
    await writeFile(EVALUATIONS_FILE, JSON.stringify(evalStore, null, 2));
  } catch (err) {
    logError("shadow-eval", `Failed to save evaluations: ${err}`);
  }
}

/**
 * Store an evaluation result for later analysis.
 */
export async function storeEvaluation(
  taskId: string,
  result: EvaluationResult,
  context: Partial<EvaluationContext>
): Promise<void> {
  const store = await loadEvaluationStore();

  store.evaluations.push({
    taskId,
    timestamp: new Date().toISOString(),
    result,
    context,
  });

  store.totalEvaluations++;

  // Keep last 500 evaluations
  if (store.evaluations.length > 500) {
    store.evaluations = store.evaluations.slice(-500);
  }

  await saveEvaluationStore();
}

/**
 * Get evaluations for a specific task.
 */
export async function getTaskEvaluations(taskId: string): Promise<StoredEvaluation[]> {
  const store = await loadEvaluationStore();
  return store.evaluations.filter((e) => e.taskId === taskId);
}

/**
 * Get recent evaluations across all tasks.
 */
export async function getRecentEvaluations(limit: number = 50): Promise<StoredEvaluation[]> {
  const store = await loadEvaluationStore();
  return store.evaluations.slice(-limit);
}
