/**
 * Atlas — Learned Patterns System
 *
 * Captures and queries patterns from completed code agent tasks.
 * Three pattern types:
 * - Success patterns: Tool sequences that worked well
 * - Failure patterns: Symptoms and root causes of failures
 * - Antipatterns: Things to explicitly avoid
 *
 * Patterns are stored in data/learned-patterns.json and queried
 * when building restart prompts or enriching new task context.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { info, warn, error as logError } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const PATTERNS_FILE = join(DATA_DIR, "learned-patterns.json");

// ============================================================
// TYPES
// ============================================================

export type PatternCategory = "success" | "failure" | "antipattern";

export interface LearnedPattern {
  id: string;
  category: PatternCategory;
  /** Short description of the pattern */
  name: string;
  /** Detailed description of what happened */
  description: string;
  /** Keywords for matching similar tasks */
  keywords: string[];
  /** What to do (for success) or avoid (for failure/antipattern) */
  guidance: string;
  /** How many times this pattern has been observed */
  occurrences: number;
  /** When this pattern was first observed */
  firstSeenAt: string;
  /** When this pattern was last observed */
  lastSeenAt: string;
  /** Task IDs that contributed to this pattern */
  taskIds: string[];
  /** Tool sequence signature (for matching) */
  toolSequence?: string[];
  /** Whether this pattern has been manually verified */
  verified: boolean;
  /** Confidence score 0-1 */
  confidence: number;
}

export interface PatternStore {
  patterns: LearnedPattern[];
  version: number;
  lastUpdatedAt: string;
}

export interface SimilarPatterns {
  successes: LearnedPattern[];
  failures: LearnedPattern[];
  antipatterns: LearnedPattern[];
}

// ============================================================
// STATE
// ============================================================

let store: PatternStore | null = null;

// ============================================================
// PERSISTENCE
// ============================================================

async function loadStore(): Promise<PatternStore> {
  if (store) return store;

  try {
    if (existsSync(PATTERNS_FILE)) {
      const content = await readFile(PATTERNS_FILE, "utf-8");
      store = JSON.parse(content);
      info("learned-patterns", `Loaded ${store!.patterns.length} patterns`);
    }
  } catch (err) {
    warn("learned-patterns", `Failed to load patterns: ${err}`);
  }

  if (!store) {
    store = {
      patterns: [],
      version: 1,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  return store;
}

async function saveStore(): Promise<void> {
  if (!store) return;

  try {
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }
    store.lastUpdatedAt = new Date().toISOString();
    await writeFile(PATTERNS_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    logError("learned-patterns", `Failed to save patterns: ${err}`);
  }
}

// ============================================================
// PATTERN OPERATIONS
// ============================================================

function generateId(): string {
  return `pat_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
}

/**
 * Extract keywords from a task prompt for matching.
 */
function extractKeywords(prompt: string): string[] {
  const lower = prompt.toLowerCase();

  // Common task-related keywords
  const keywordPatterns = [
    /\b(fix|bug|error|crash|broken)\b/g,
    /\b(add|create|implement|build|new)\b/g,
    /\b(refactor|clean|optimize|improve)\b/g,
    /\b(test|verify|check|validate)\b/g,
    /\b(api|webhook|integration|endpoint)\b/g,
    /\b(content|blog|post|newsletter)\b/g,
    /\b(ghl|google|meta|telegram)\b/g,
    /\b(typescript|javascript|python|sql)\b/g,
    /\b(database|supabase|postgres|sqlite)\b/g,
    /\b(ui|component|style|css)\b/g,
  ];

  const keywords: Set<string> = new Set();

  for (const pattern of keywordPatterns) {
    const matches = lower.match(pattern);
    if (matches) {
      matches.forEach((m) => keywords.add(m));
    }
  }

  return Array.from(keywords);
}

/**
 * Calculate similarity between two sets of keywords.
 * Returns a score from 0-1.
 */
function keywordSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a.map((k) => k.toLowerCase()));
  const setB = new Set(b.map((k) => k.toLowerCase()));

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Add or update a learned pattern.
 * If a similar pattern exists, it will be merged instead of creating a duplicate.
 */
export async function addPattern(pattern: Omit<LearnedPattern, "id" | "occurrences" | "firstSeenAt" | "lastSeenAt" | "taskIds" | "verified" | "confidence"> & {
  taskId: string;
  confidence?: number;
}): Promise<LearnedPattern> {
  const s = await loadStore();

  // Check for existing similar pattern
  const existing = s.patterns.find(
    (p) =>
      p.category === pattern.category &&
      p.name === pattern.name &&
      keywordSimilarity(p.keywords, pattern.keywords) > 0.7
  );

  if (existing) {
    // Merge with existing pattern
    existing.occurrences++;
    existing.lastSeenAt = new Date().toISOString();
    if (!existing.taskIds.includes(pattern.taskId)) {
      existing.taskIds.push(pattern.taskId);
      // Keep last 20 task IDs
      if (existing.taskIds.length > 20) {
        existing.taskIds = existing.taskIds.slice(-20);
      }
    }
    // Update confidence based on occurrences
    existing.confidence = Math.min(1, existing.confidence + 0.1);
    await saveStore();
    info("learned-patterns", `Updated pattern: ${existing.name} (${existing.occurrences} occurrences)`);
    return existing;
  }

  // Create new pattern
  const newPattern: LearnedPattern = {
    id: generateId(),
    category: pattern.category,
    name: pattern.name,
    description: pattern.description,
    keywords: pattern.keywords,
    guidance: pattern.guidance,
    occurrences: 1,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    taskIds: [pattern.taskId],
    toolSequence: pattern.toolSequence,
    verified: false,
    confidence: pattern.confidence ?? 0.5,
  };

  s.patterns.push(newPattern);
  await saveStore();
  info("learned-patterns", `Added new pattern: ${newPattern.name} (${newPattern.category})`);
  return newPattern;
}

/**
 * Find patterns similar to a given task prompt.
 * Returns patterns grouped by category.
 */
export async function findSimilarPatterns(
  prompt: string,
  options?: { minConfidence?: number; maxResults?: number }
): Promise<SimilarPatterns> {
  const s = await loadStore();
  const minConfidence = options?.minConfidence ?? 0.3;
  const maxResults = options?.maxResults ?? 5;

  const taskKeywords = extractKeywords(prompt);

  const scoredPatterns = s.patterns
    .filter((p) => p.confidence >= minConfidence)
    .map((p) => ({
      pattern: p,
      score: keywordSimilarity(taskKeywords, p.keywords),
    }))
    .filter((sp) => sp.score > 0.2)
    .sort((a, b) => b.score - a.score);

  const result: SimilarPatterns = {
    successes: [],
    failures: [],
    antipatterns: [],
  };

  for (const { pattern } of scoredPatterns) {
    if (pattern.category === "success" && result.successes.length < maxResults) {
      result.successes.push(pattern);
    } else if (pattern.category === "failure" && result.failures.length < maxResults) {
      result.failures.push(pattern);
    } else if (pattern.category === "antipattern" && result.antipatterns.length < maxResults) {
      result.antipatterns.push(pattern);
    }
  }

  return result;
}

/**
 * Mark a pattern as verified (manually confirmed by human).
 */
export async function verifyPattern(patternId: string): Promise<boolean> {
  const s = await loadStore();
  const pattern = s.patterns.find((p) => p.id === patternId);

  if (!pattern) return false;

  pattern.verified = true;
  pattern.confidence = Math.max(pattern.confidence, 0.9);
  await saveStore();
  info("learned-patterns", `Verified pattern: ${pattern.name}`);
  return true;
}

/**
 * Delete a pattern.
 */
export async function deletePattern(patternId: string): Promise<boolean> {
  const s = await loadStore();
  const index = s.patterns.findIndex((p) => p.id === patternId);

  if (index === -1) return false;

  const removed = s.patterns.splice(index, 1)[0];
  await saveStore();
  info("learned-patterns", `Deleted pattern: ${removed.name}`);
  return true;
}

/**
 * Get all patterns, optionally filtered by category.
 */
export async function getAllPatterns(category?: PatternCategory): Promise<LearnedPattern[]> {
  const s = await loadStore();

  if (category) {
    return s.patterns.filter((p) => p.category === category);
  }

  return [...s.patterns];
}

/**
 * Get pattern statistics.
 */
export async function getPatternStats(): Promise<{
  total: number;
  successes: number;
  failures: number;
  antipatterns: number;
  verified: number;
  avgConfidence: number;
}> {
  const s = await loadStore();

  const successes = s.patterns.filter((p) => p.category === "success").length;
  const failures = s.patterns.filter((p) => p.category === "failure").length;
  const antipatterns = s.patterns.filter((p) => p.category === "antipattern").length;
  const verified = s.patterns.filter((p) => p.verified).length;
  const avgConfidence =
    s.patterns.length > 0
      ? s.patterns.reduce((sum, p) => sum + p.confidence, 0) / s.patterns.length
      : 0;

  return {
    total: s.patterns.length,
    successes,
    failures,
    antipatterns,
    verified,
    avgConfidence,
  };
}

// ============================================================
// PATTERN EXTRACTION FROM TASK RESULTS
// ============================================================

export interface TaskAnalysis {
  taskId: string;
  prompt: string;
  success: boolean;
  exitReason: string;
  toolCallCount: number;
  costUsd: number;
  durationMs: number;
  toolHistory?: string[];
  detectedPatterns?: string[];
}

/**
 * Extract patterns from a completed task.
 * Called by the learning system after task completion.
 */
export async function extractPatternsFromTask(analysis: TaskAnalysis): Promise<LearnedPattern[]> {
  const extracted: LearnedPattern[] = [];
  const keywords = extractKeywords(analysis.prompt);

  if (analysis.success) {
    // Success pattern: efficient completion
    if (analysis.toolCallCount < 30 && analysis.costUsd < 1.0) {
      extracted.push(
        await addPattern({
          taskId: analysis.taskId,
          category: "success",
          name: `Efficient ${keywords[0] || "task"} completion`,
          description: `Task completed in ${analysis.toolCallCount} tool calls, $${analysis.costUsd.toFixed(2)}`,
          keywords,
          guidance: `Similar tasks can be completed efficiently with direct approach`,
          toolSequence: analysis.toolHistory?.slice(0, 10),
          confidence: 0.6,
        })
      );
    }
  } else {
    // Failure patterns based on exit reason
    if (analysis.exitReason === "tool_limit") {
      extracted.push(
        await addPattern({
          taskId: analysis.taskId,
          category: "failure",
          name: `Tool limit hit on ${keywords[0] || "task"}`,
          description: `Task hit tool call limit (${analysis.toolCallCount} calls)`,
          keywords,
          guidance: `Avoid excessive exploration. Focus on direct approach.`,
          toolSequence: analysis.toolHistory?.slice(-10),
          confidence: 0.7,
        })
      );
    }

    if (analysis.exitReason === "inactivity") {
      extracted.push(
        await addPattern({
          taskId: analysis.taskId,
          category: "failure",
          name: `Stalled on ${keywords[0] || "task"}`,
          description: `Task stalled due to inactivity`,
          keywords,
          guidance: `Agent may have gotten confused. Try clearer instructions.`,
          confidence: 0.5,
        })
      );
    }

    if (analysis.exitReason === "budget") {
      extracted.push(
        await addPattern({
          taskId: analysis.taskId,
          category: "failure",
          name: `Budget exceeded on ${keywords[0] || "task"}`,
          description: `Task exceeded budget ($${analysis.costUsd.toFixed(2)})`,
          keywords,
          guidance: `Task may be too complex. Consider breaking into subtasks.`,
          confidence: 0.6,
        })
      );
    }

    // Check for detected patterns from pattern detector
    if (analysis.detectedPatterns) {
      for (const patternType of analysis.detectedPatterns) {
        extracted.push(
          await addPattern({
            taskId: analysis.taskId,
            category: "antipattern",
            name: `${patternType} on ${keywords[0] || "task"}`,
            description: `Detected ${patternType} during execution`,
            keywords,
            guidance: `Avoid ${patternType}. Use a different approach.`,
            confidence: 0.8,
          })
        );
      }
    }
  }

  return extracted;
}

/**
 * Build guidance string from similar patterns for restart prompts.
 */
export function buildPatternGuidance(similar: SimilarPatterns): string {
  const sections: string[] = [];

  if (similar.failures.length > 0) {
    sections.push("## Known Issues with Similar Tasks");
    for (const p of similar.failures.slice(0, 3)) {
      sections.push(`- ${p.name}: ${p.guidance}`);
    }
  }

  if (similar.antipatterns.length > 0) {
    sections.push("\n## Patterns to Avoid");
    for (const p of similar.antipatterns.slice(0, 3)) {
      sections.push(`- ${p.guidance}`);
    }
  }

  if (similar.successes.length > 0) {
    sections.push("\n## What Has Worked Before");
    for (const p of similar.successes.slice(0, 2)) {
      sections.push(`- ${p.guidance}`);
    }
  }

  return sections.join("\n");
}
