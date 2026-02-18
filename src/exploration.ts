/**
 * Atlas — Convergent Exploration
 *
 * Multi-perspective reasoning system that fans out parallel branches
 * with different strategy lenses, scores them, and converges on the
 * best answer. Layers on top of the existing DAG/swarm engine.
 *
 * Backed by research: Tree of Thoughts (4% -> 74% on Game of 24),
 * Self-Consistency (+17% GSM8K), Self-MoA (same model > mixed models).
 *
 * Three phases per exploration:
 *   1. Fan-out: 2-5 parallel research branches, each with a strategy lens
 *   2. Score: validator reads all branches, outputs structured scores
 *   3. Converge: synthesizer merges best insights into one answer
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { info, warn } from "./logger.ts";
import { callClaude } from "./claude.ts";
import { createDAG, startSwarm, type SwarmDAG } from "./dag.ts";
import { readScratchpad } from "./scratchpad.ts";
import {
  EXPLORATION_TIERS,
  EXPLORATION_LOG_MAX_ENTRIES,
  STRATEGY_LENSES,
  type StrategyLens,
  type ExplorationTierConfig,
  type ModelTier,
} from "./constants.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const LOG_FILE = join(PROJECT_DIR, "data", "exploration-log.json");

// ============================================================
// TYPES
// ============================================================

export interface ExplorationClassification {
  tier: 0 | 1 | 2 | 3;
  strategies: StrategyLens[];
  reasoning: string;
  directAnswer?: string;
}

export interface BranchScore {
  strategy: string;
  relevance: number;
  completeness: number;
  feasibility: number;
  novelty: number;
  composite: number;
  reasoning: string;
}

export interface ExplorationLogEntry {
  id: string;
  question: string;
  tier: number;
  strategies: StrategyLens[];
  scores: BranchScore[];
  selectedBranch: string;
  cost: number;
  latencyMs: number;
  timestamp: string;
  swarmId: string;
}

// ============================================================
// STRATEGY LENS INSTRUCTIONS
// ============================================================

const STRATEGY_INSTRUCTIONS: Record<StrategyLens, string> = {
  orthodox:
    "Apply conventional best-practice thinking. What would a seasoned expert recommend? " +
    "Ground your analysis in established frameworks, proven methods, and consensus views. " +
    "Cite specific methodologies or standards where relevant.",
  lateral:
    "Think creatively and find unexpected angles. What non-obvious connections exist? " +
    "Draw from analogies in unrelated fields. Challenge assumptions about what's possible. " +
    "The best ideas often come from adjacent domains.",
  contrarian:
    "Deliberately oppose the consensus view. What if everyone is wrong? " +
    "Find the strongest argument AGAINST the obvious answer. " +
    "Look for hidden risks, overlooked downsides, or perverse incentives. " +
    "Play devil's advocate with intellectual rigor.",
  minimalist:
    "Find the simplest possible answer. Strip away complexity. " +
    "What's the 20% effort that gets 80% of the value? " +
    "Identify what can be eliminated, simplified, or deferred. " +
    "Occam's razor: the simplest explanation is usually correct.",
  speculative:
    "Think about the future. What if current trends continue or accelerate? " +
    "What second-order effects might emerge? What would this look like in 2-5 years? " +
    "Consider emerging technologies, shifting paradigms, and tail risks.",
  empirical:
    "Focus on data, evidence, and measurable outcomes. " +
    "What do the numbers say? What research or case studies support each option? " +
    "Identify what can be tested and measured. Prefer quantitative over qualitative. " +
    "Flag claims that lack evidence.",
  historical:
    "Look at precedent and patterns. When has a similar situation arisen before? " +
    "What worked and what failed? What can history teach us? " +
    "Identify recurring patterns and common failure modes.",
};

// ============================================================
// CLASSIFIER
// ============================================================

const CLASSIFIER_PROMPT = `You are a question complexity classifier. Given a question, determine:
1. How many reasoning branches would help (0=simple direct answer, 2-4=multi-perspective exploration needed)
2. Which strategy lenses are most relevant

Tier 0: Simple factual question, greeting, or request that has one clear answer. No exploration needed.
Tier 1: Moderate question with 2-3 plausible approaches. Quick exploration helps.
Tier 2: Complex question with multiple valid perspectives, trade-offs, or unknowns. Full exploration.
Tier 3: Strategic/high-stakes question requiring exhaustive analysis from many angles.

Available lenses: orthodox (conventional), lateral (creative), contrarian (opposes consensus), minimalist (simplest), speculative (future-oriented), empirical (data-driven), historical (precedent-based)

Pick 2-5 lenses that are RELEVANT to this specific question. Don't pick lenses just to fill slots.

Output ONLY valid JSON (no markdown fences, no explanation):
{"tier": 0, "strategies": ["lens1", "lens2"], "reasoning": "one-line explanation", "directAnswer": "if tier 0, answer here; otherwise omit this field"}`;

export async function classifyComplexity(question: string): Promise<ExplorationClassification> {
  const prompt = `${CLASSIFIER_PROMPT}\n\nQuestion: ${question}`;

  const result = await callClaude(prompt, {
    model: "haiku",
    skipLock: true,
  });

  let json = result.trim();
  if (json.startsWith("```")) {
    json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    const parsed = JSON.parse(json);

    // Validate tier
    const tier = [0, 1, 2, 3].includes(parsed.tier) ? parsed.tier : 2;

    // Validate strategies
    const validLenses = new Set(STRATEGY_LENSES);
    const strategies = (parsed.strategies || [])
      .filter((s: string) => validLenses.has(s as StrategyLens)) as StrategyLens[];

    return {
      tier,
      strategies: strategies.length > 0 ? strategies : ["orthodox", "lateral", "empirical"],
      reasoning: parsed.reasoning || "classified",
      directAnswer: tier === 0 ? parsed.directAnswer : undefined,
    };
  } catch {
    warn("exploration", `Classification parse failed, defaulting to Tier 2. Raw: ${result.slice(0, 200)}`);
    return {
      tier: 2,
      strategies: ["orthodox", "lateral", "empirical"],
      reasoning: "Classification failed, using defaults",
    };
  }
}

// ============================================================
// PROMPT BUILDERS
// ============================================================

function buildBranchPrompt(question: string, strategy: StrategyLens): string {
  return [
    `You are analyzing a question through a specific reasoning lens: ${strategy.toUpperCase()}.`,
    "",
    STRATEGY_INSTRUCTIONS[strategy],
    "",
    "RULES:",
    "- Stay in character for your lens. Don't hedge with 'on the other hand' or try to be balanced.",
    "- Be thorough but concise. Aim for 500-1500 words.",
    "- Structure your response with clear headers.",
    "- End with a concrete recommendation or conclusion from your lens's perspective.",
    "- If your lens genuinely has nothing useful to add, say so briefly and explain why.",
    "",
    `QUESTION: ${question}`,
  ].join("\n");
}

function buildScorerPrompt(question: string, strategies: StrategyLens[]): string {
  const scoreTemplate = strategies
    .map(
      (s, i) =>
        `    {"strategy": "${s}", "relevance": 0.0, "completeness": 0.0, "feasibility": 0.0, "novelty": 0.0, "reasoning": "one-line"}${i < strategies.length - 1 ? "," : ""}`,
    )
    .join("\n");

  return [
    "You are a critical evaluator scoring multiple reasoning branches that explored the same question from different perspectives.",
    "",
    "Score each branch on four dimensions (0.0 to 1.0, one decimal place):",
    "- RELEVANCE: How directly does this address the actual question asked?",
    "- COMPLETENESS: How thorough is the analysis within its chosen lens?",
    "- FEASIBILITY: How practical and actionable are the recommendations?",
    "- NOVELTY: Does this bring unique insight not found in the other branches?",
    "",
    "RULES:",
    "- Score HONESTLY. Not every branch deserves high marks.",
    "- Novelty is relative: if two branches say similar things, dock both on novelty.",
    "- A branch that says 'this lens is not relevant' should score 0.1 on everything.",
    "- Composite = (relevance * 0.35) + (completeness * 0.25) + (feasibility * 0.25) + (novelty * 0.15)",
    "",
    `The branches explored these lenses: ${strategies.join(", ")}`,
    "",
    "Output ONLY valid JSON (no markdown fences, no explanation):",
    "{",
    '  "scores": [',
    scoreTemplate,
    "  ]",
    "}",
    "",
    `ORIGINAL QUESTION: ${question}`,
    "",
    "The branch outputs are provided as context below. Score them now.",
  ].join("\n");
}

function buildConvergencePrompt(question: string): string {
  return [
    "You are synthesizing the results of a multi-perspective exploration into a single, high-quality answer.",
    "",
    "You have access to:",
    "1. Multiple branch analyses, each from a different reasoning lens",
    "2. Scores for each branch (relevance, completeness, feasibility, novelty)",
    "",
    "YOUR JOB:",
    "- Start with the highest-scoring branch as your foundation",
    "- Supplement it with unique insights from other branches",
    "- Note any significant contradictions between branches",
    "- Produce a clear, actionable answer",
    "",
    "OUTPUT FORMAT:",
    "## Answer",
    "[Your synthesized recommendation. Be direct and specific.]",
    "",
    "## Key Insights",
    "[2-4 bullet points of the most valuable ideas from across branches]",
    "",
    "## Contradictions",
    "[Where branches significantly disagreed, and your assessment of who's right]",
    "",
    "## Confidence: [low/medium/high]",
    "[One sentence explaining your confidence level]",
    "",
    "RULES:",
    "- Lead with the answer, not the process.",
    "- Don't describe the branches or scoring. The user doesn't care about the machinery.",
    "- Keep it under 2000 characters for Telegram delivery.",
    "- Be opinionated. The user asked a question; they want an answer, not a menu.",
    "",
    `ORIGINAL QUESTION: ${question}`,
  ].join("\n");
}

// ============================================================
// DAG BUILDER
// ============================================================

function buildExplorationDAG(
  question: string,
  classification: ExplorationClassification,
  userId: string,
  tierOverride?: number,
): SwarmDAG {
  const tierNum = (tierOverride ?? classification.tier) as 0 | 1 | 2 | 3;
  const tierConfig = EXPLORATION_TIERS[tierNum];
  const strategies = classification.strategies.slice(0, tierConfig.branchCount);

  const shortQ = question.length > 60 ? question.substring(0, 57) + "..." : question;
  const builder = createDAG(`explore: ${shortQ}`);

  // Phase 1: parallel exploration branches
  const branchIds: string[] = [];
  for (const strategy of strategies) {
    const id = builder.addNode({
      label: `Explore (${strategy})`,
      type: "research",
      prompt: buildBranchPrompt(question, strategy),
      model: tierConfig.branchModel,
    });
    branchIds.push(id);
  }

  // Phase 2: scorer (validate type)
  const scorerId = builder.addNode({
    label: "Score branches",
    type: "validate",
    prompt: buildScorerPrompt(question, strategies),
    model: tierConfig.scorerModel,
  });

  // Phase 3: convergence (synthesize type)
  const synthId = builder.addNode({
    label: "Converge",
    type: "synthesize",
    prompt: buildConvergencePrompt(question),
    model: tierConfig.synthModel,
  });

  // Edges: all branches -> scorer + synthesizer, scorer -> synthesizer
  for (const branchId of branchIds) {
    builder.addEdge(branchId, scorerId);
    builder.addEdge(branchId, synthId);
  }
  builder.addEdge(scorerId, synthId);

  return builder.build({
    initiatedBy: userId,
    maxCostUsd: tierConfig.maxBudgetUsd,
    maxAgents: tierConfig.maxAgents,
    maxWallClockMs: tierConfig.maxWallClockMs,
  });
}

// ============================================================
// CORE ORCHESTRATION
// ============================================================

async function runExploration(
  question: string,
  userId: string,
  tierOverride?: number,
): Promise<string> {
  // 1. Classify
  let classification: ExplorationClassification;
  try {
    classification = await classifyComplexity(question);
  } catch (err) {
    warn("exploration", `Classification failed: ${err}. Defaulting to Tier 2.`);
    classification = {
      tier: 2,
      strategies: ["orthodox", "lateral", "empirical"],
      reasoning: "Classification failed, using defaults",
    };
  }

  const effectiveTier = tierOverride ?? classification.tier;

  // Tier 0: direct answer
  if (effectiveTier === 0 && classification.directAnswer) {
    info("exploration", `Tier 0: direct answer for "${question.substring(0, 60)}"`);
    return classification.directAnswer;
  }

  // Ensure we have a valid tier config (clamp to 1-3)
  const clampedTier = Math.max(1, Math.min(3, effectiveTier));
  const tierConfig = EXPLORATION_TIERS[clampedTier];

  // Pad strategies if classifier returned too few
  if (classification.strategies.length < tierConfig.branchCount) {
    const defaults: StrategyLens[] = ["orthodox", "lateral", "empirical", "contrarian", "minimalist"];
    for (const d of defaults) {
      if (classification.strategies.length >= tierConfig.branchCount) break;
      if (!classification.strategies.includes(d)) {
        classification.strategies.push(d);
      }
    }
  }

  // 2. Build DAG
  const dag = buildExplorationDAG(question, classification, userId, clampedTier);

  // 3. Start swarm
  await startSwarm(dag);

  // 4. Log initiation
  const logEntry: ExplorationLogEntry = {
    id: dag.id,
    question,
    tier: clampedTier,
    strategies: classification.strategies.slice(0, tierConfig.branchCount),
    scores: [],
    selectedBranch: "",
    cost: 0,
    latencyMs: 0,
    timestamp: new Date().toISOString(),
    swarmId: dag.id,
  };
  await appendToLog(logEntry);

  info("exploration", `Started exploration "${dag.id}" (Tier ${clampedTier}, ${tierConfig.branchCount} branches)`);

  const branchList = classification.strategies
    .slice(0, tierConfig.branchCount)
    .map((s) => `  ${s}`)
    .join("\n");

  return [
    `Exploration started (Tier ${clampedTier}).`,
    `${tierConfig.branchCount} branches, budget $${tierConfig.maxBudgetUsd.toFixed(2)}`,
    `Lenses:\n${branchList}`,
    `Reason: ${classification.reasoning}`,
  ].join("\n");
}

// ============================================================
// COMMAND HANDLER
// ============================================================

export async function handleExploreCommand(
  args: string[],
  userId: string,
): Promise<string> {
  if (args.length === 0) {
    return [
      "Usage:",
      "  /explore <question> - Run exploration (auto-classify tier)",
      "  /explore quick <question> - Force Tier 1 (fast, cheap)",
      "  /explore deep <question> - Force Tier 3 (thorough, expensive)",
      "  /explore log - Show recent exploration history",
      "  /explore stats - Strategy performance stats",
    ].join("\n");
  }

  const subcommand = args[0].toLowerCase();

  switch (subcommand) {
    case "log":
      return await formatExplorationLog();
    case "stats":
      return await formatExplorationStats();
    case "quick": {
      const question = args.slice(1).join(" ");
      if (!question) return "Usage: /explore quick <question>";
      return await runExploration(question, userId, 1);
    }
    case "deep": {
      const question = args.slice(1).join(" ");
      if (!question) return "Usage: /explore deep <question>";
      return await runExploration(question, userId, 3);
    }
    default: {
      const question = args.join(" ");
      return await runExploration(question, userId);
    }
  }
}

// ============================================================
// TAG PROCESSING
// ============================================================

const EXPLORE_TAG_REGEX = /\[EXPLORE:\s*([\s\S]+?)\](?!\()/g;

export async function processExploreIntents(
  response: string,
  userId: string,
): Promise<string> {
  let processed = response;
  let match;

  while ((match = EXPLORE_TAG_REGEX.exec(response)) !== null) {
    const raw = match[1];
    const fields = parseExploreFields(raw);

    try {
      const result = await runExploration(fields.question, userId, fields.tier);
      processed = processed.replace(match[0], result);
      info("exploration", `Exploration started from tag: "${fields.question.substring(0, 60)}"`);
    } catch (err) {
      processed = processed.replace(match[0], `Exploration failed: ${err}`);
      warn("exploration", `Explore intent failed: ${err}`);
    }
  }
  EXPLORE_TAG_REGEX.lastIndex = 0;

  return processed;
}

function parseExploreFields(raw: string): { question: string; tier?: number } {
  const parts = raw.split(/\s*\|\s*(?=TIER\s*:)/i);
  const question = parts[0].trim();
  let tier: number | undefined;

  for (let i = 1; i < parts.length; i++) {
    const tierMatch = parts[i].match(/^TIER\s*:\s*(\d)/i);
    if (tierMatch) tier = parseInt(tierMatch[1], 10);
  }

  return { question, tier };
}

// ============================================================
// AUTO-DETECT: regex pre-filter + haiku classifier
// ============================================================

/**
 * Regex pre-filter: catches messages that LOOK like complex questions
 * worth exploring. Cheap (no API call), runs on every message.
 * Returns true if the message should be sent to the haiku classifier.
 */
const EXPLORE_SIGNALS = [
  /should (?:I|we) .+ or /i,                    // "should I X or Y"
  /what(?:'s| is) the best (?:approach|way|strategy|option)/i,
  /compare .+ (?:vs|versus|or|against)/i,        // comparison requests
  /(?:pros? and cons?|trade.?offs?|advantages? (?:and|vs) disadvantages?)/i,
  /what (?:would|should) .+ look like/i,
  /how should (?:I|we) (?:approach|handle|think about|decide)/i,
  /(?:evaluate|analyze|assess) .+ options?/i,
  /is it (?:better|worth|smarter) to/i,
  /what(?:'s| is) the (?:right|best|optimal) (?:move|play|call|decision)/i,
  /(?:strategic|architecture|architectural|business) (?:decision|question|choice)/i,
  /weigh .+ (?:against|vs)/i,
];

// Skip auto-detect for short messages, follow-ups, commands
const EXPLORE_SKIP = [
  /^\//, // commands
  /^(?:yes|no|ok|sure|thanks|yep|nah|nope|good|great|fine|cool|got it|sounds good)\b/i,
  /^(?:do it|go ahead|proceed|send it|let's go|ship it)/i,
];

const MIN_EXPLORE_LENGTH = 30; // short messages aren't complex questions

export function shouldAutoExplore(message: string): boolean {
  if (message.length < MIN_EXPLORE_LENGTH) return false;
  if (EXPLORE_SKIP.some((re) => re.test(message))) return false;
  return EXPLORE_SIGNALS.some((re) => re.test(message));
}

/**
 * Full auto-detect pipeline: regex pre-filter -> haiku classifier -> launch if Tier 2+.
 * Returns the exploration launch message if triggered, or null if skipped.
 *
 * Called from relay.ts BEFORE the main Claude call. If this returns non-null,
 * relay sends the exploration launch message AND still sends the message to
 * Claude for a quick initial response.
 */
export async function autoExplore(
  message: string,
  userId: string,
): Promise<string | null> {
  // 1. Regex pre-filter
  if (!shouldAutoExplore(message)) return null;

  // 2. Haiku classifier
  let classification: ExplorationClassification;
  try {
    classification = await classifyComplexity(message);
  } catch (err) {
    warn("exploration", `Auto-detect classification failed: ${err}`);
    return null;
  }

  // 3. Only auto-launch for Tier 2+ (complex questions)
  // Tier 0-1 questions get normal Atlas treatment
  if (classification.tier < 2) {
    info("exploration", `Auto-detect: classified as Tier ${classification.tier}, skipping (need Tier 2+)`);
    return null;
  }

  // 4. Launch exploration
  info("exploration", `Auto-detect triggered: Tier ${classification.tier} for "${message.substring(0, 60)}"`);
  return await runExploration(message, userId, classification.tier);
}

// ============================================================
// EXPLORATION LOG: completion hook
// ============================================================

/**
 * Called by orchestrator when an exploration swarm completes.
 * Parses scores from the scorer node and finalizes the log entry.
 */
export async function finalizeExplorationLog(swarmId: string, dag: SwarmDAG): Promise<void> {
  const log = await loadLog();
  const entry = log.find((e) => e.swarmId === swarmId);
  if (!entry) return;

  entry.cost = dag.budget.spentUsd;
  entry.latencyMs = dag.budget.startedAt
    ? Date.now() - new Date(dag.budget.startedAt).getTime()
    : 0;

  // Parse scores from the scorer node output
  const scorerNode = dag.nodes.find((n) => n.label === "Score branches");
  if (scorerNode) {
    const scorerOutput = await readScratchpad(dag.id, scorerNode.id);
    if (scorerOutput) {
      try {
        const cleaned = scorerOutput.replace(/```json?\n?|```/g, "").trim();
        // Try parsing the whole thing, or extract first {...} block
        let parsed: { scores: BranchScore[] };
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { scores: [] };
        }

        if (parsed.scores && Array.isArray(parsed.scores)) {
          entry.scores = parsed.scores.map((s) => ({
            ...s,
            composite:
              (s.relevance || 0) * 0.35 +
              (s.completeness || 0) * 0.25 +
              (s.feasibility || 0) * 0.25 +
              (s.novelty || 0) * 0.15,
          }));

          // Find best branch
          const best = entry.scores.reduce((a, b) => (b.composite > a.composite ? b : a), entry.scores[0]);
          entry.selectedBranch = best?.strategy || "unknown";
        }
      } catch (err) {
        warn("exploration", `Score parsing failed for ${swarmId}: ${err}`);
      }
    }
  }

  await saveLog(log);
  info("exploration", `Log finalized for ${swarmId}: cost=$${entry.cost.toFixed(2)}, best=${entry.selectedBranch}`);
}

// ============================================================
// EXPLORATION LOG: persistence
// ============================================================

async function loadLog(): Promise<ExplorationLogEntry[]> {
  try {
    if (!existsSync(LOG_FILE)) return [];
    const content = await readFile(LOG_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function saveLog(log: ExplorationLogEntry[]): Promise<void> {
  await mkdir(join(PROJECT_DIR, "data"), { recursive: true });
  const trimmed = log.slice(-EXPLORATION_LOG_MAX_ENTRIES);
  await writeFile(LOG_FILE, JSON.stringify(trimmed, null, 2));
}

async function appendToLog(entry: ExplorationLogEntry): Promise<void> {
  const log = await loadLog();
  log.push(entry);
  await saveLog(log);
}

// ============================================================
// EXPLORATION LOG: display
// ============================================================

async function formatExplorationLog(): Promise<string> {
  const log = await loadLog();
  if (log.length === 0) return "No exploration history yet.";

  const recent = log.slice(-10).reverse();
  const lines = recent.map((e) => {
    const q = e.question.length > 50 ? e.question.substring(0, 47) + "..." : e.question;
    const cost = e.cost > 0 ? `$${e.cost.toFixed(2)}` : "running";
    const best = e.selectedBranch || "pending";
    const date = new Date(e.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${date} | T${e.tier} | ${cost} | ${best} | ${q}`;
  });

  return ["Recent explorations:", "", ...lines].join("\n");
}

async function formatExplorationStats(): Promise<string> {
  const log = await loadLog();
  const completed = log.filter((e) => e.scores.length > 0);

  if (completed.length === 0) return "No completed explorations with scores yet.";

  // Strategy win rates
  const wins: Record<string, number> = {};
  const appearances: Record<string, number> = {};
  const avgScores: Record<string, number[]> = {};

  for (const entry of completed) {
    for (const score of entry.scores) {
      const s = score.strategy;
      appearances[s] = (appearances[s] || 0) + 1;
      if (!avgScores[s]) avgScores[s] = [];
      avgScores[s].push(score.composite);
    }
    if (entry.selectedBranch) {
      wins[entry.selectedBranch] = (wins[entry.selectedBranch] || 0) + 1;
    }
  }

  // Cost stats
  const costs = completed.map((e) => e.cost).filter((c) => c > 0);
  const avgCost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
  const totalCost = costs.reduce((a, b) => a + b, 0);

  const strategyLines = Object.keys(appearances)
    .sort((a, b) => (wins[b] || 0) - (wins[a] || 0))
    .map((s) => {
      const w = wins[s] || 0;
      const a = appearances[s] || 0;
      const winRate = a > 0 ? ((w / a) * 100).toFixed(0) : "0";
      const avg = avgScores[s]
        ? (avgScores[s].reduce((x, y) => x + y, 0) / avgScores[s].length).toFixed(2)
        : "N/A";
      return `  ${s}: ${w}/${a} wins (${winRate}%), avg score ${avg}`;
    });

  return [
    `Exploration stats (${completed.length} completed):`,
    "",
    "Strategy performance:",
    ...strategyLines,
    "",
    `Avg cost: $${avgCost.toFixed(2)} | Total: $${totalCost.toFixed(2)}`,
  ].join("\n");
}

// ============================================================
// CONTEXT (for injection into prompts)
// ============================================================

export async function getExplorationContext(): Promise<string> {
  const log = await loadLog();
  const recent = log.slice(-3);
  if (recent.length === 0) return "";

  const lines = recent.map((e) => {
    const q = e.question.length > 80 ? e.question.substring(0, 77) + "..." : e.question;
    const status = e.cost > 0 ? `done ($${e.cost.toFixed(2)})` : "running";
    return `- T${e.tier} ${status}: ${q}`;
  });

  return `Recent explorations:\n${lines.join("\n")}`;
}
