/**
 * Atlas — Code Agent Pattern Detector
 *
 * Signature-based problem detection for code agents. Detects common failure
 * patterns WITHOUT requiring LLM calls. Fast, cheap, runs on every tool call.
 *
 * Patterns detected:
 * - Read loop: Same file read 3+ times
 * - Edit thrashing: Edit/undo cycles on same file
 * - Glob flooding: 5+ consecutive Glob calls
 * - Error spiral: Repeated failed Bash commands
 * - Stuck exploration: 20+ tool calls with no Write/Edit
 * - Search loop: Same search pattern repeated
 * - Heartbeat timeout: No tool call for >120s (warn) or >300s (kill)
 * - Output stagnation: Output hasn't grown by >100 chars in 60s
 *
 * Also exports computeStuckScore() for probabilistic stuck detection (0-1).
 */

import { info, warn } from "./logger.ts";

// ============================================================
// TYPES
// ============================================================

export type PatternType =
  | "read_loop"
  | "edit_thrash"
  | "glob_flood"
  | "error_spiral"
  | "stuck_exploration"
  | "search_loop"
  | "duplicate_call"
  | "heartbeat_timeout"
  | "output_stagnation";

export type InterventionAction = "none" | "warn" | "kill_restart" | "kill_abort";

export interface DetectedPattern {
  type: PatternType;
  description: string;
  severity: "low" | "medium" | "high";
  action: InterventionAction;
  details: {
    file?: string;
    count?: number;
    lastTools?: string[];
  };
}

export interface ToolCall {
  toolName: string;
  toolInput?: Record<string, any>;
  timestamp: number;
  isError?: boolean;
  errorMessage?: string;
}

// ============================================================
// CONFIGURATION
// ============================================================

// ---- Default thresholds ----
const READ_LOOP_THRESHOLD = 5;
const EDIT_THRASH_THRESHOLD = 3;
const GLOB_FLOOD_THRESHOLD = 5;
const ERROR_SPIRAL_THRESHOLD = 3;
const STUCK_EXPLORATION_THRESHOLD = 40;
const SEARCH_LOOP_THRESHOLD = 3;
const DUPLICATE_CALL_THRESHOLD = 4;
const PATTERN_WINDOW = 30;

// ---- Heartbeat thresholds (seconds since last tool call) ----
const HEARTBEAT_WARN_SEC = 120;
const HEARTBEAT_KILL_SEC = 300;

// ---- Output stagnation thresholds ----
const OUTPUT_STAGNATION_MIN_CHARS = 100;
const OUTPUT_STAGNATION_WINDOW_SEC = 60;

// ---- Relaxed thresholds for read-only tasks (audits, plan mode, reviews) ----
const RO_READ_LOOP_THRESHOLD = 10;
const RO_STUCK_EXPLORATION_THRESHOLD = 60;
const RO_GLOB_FLOOD_THRESHOLD = 10;
const RO_SEARCH_LOOP_THRESHOLD = 6;
const RO_DUPLICATE_CALL_THRESHOLD = 8;

// ============================================================
// PATTERN DETECTOR CLASS
// ============================================================

export interface PatternDetectorOptions {
  /** Task is read-only (audit, plan mode, review). Relaxes exploration thresholds. */
  readOnly?: boolean;
}

export class PatternDetector {
  private toolHistory: ToolCall[] = [];
  private fileReadCounts: Map<string, number> = new Map();
  private fileEditHistory: Map<string, string[]> = new Map(); // file -> sequence of edit actions
  private searchPatterns: Map<string, number> = new Map();
  private consecutiveGlobs = 0;
  private consecutiveErrors = 0;
  private toolsSinceWrite = 0;
  private hasWrittenOrEdited = false;
  private lastPatternLog = new Map<string, number>();

  // Heartbeat tracking: time of last tool call
  private lastToolCallTime: number = Date.now();

  // Output stagnation tracking
  private lastOutputSize: number = 0;
  private lastOutputCheckTime: number = Date.now();

  // Unique files touched (for stuck score complexity factor)
  private uniqueFilesTouched: Set<string> = new Set();

  // Effective thresholds (adjusted for read-only tasks)
  private readonly readLoopThreshold: number;
  private readonly stuckExplorationThreshold: number;
  private readonly globFloodThreshold: number;
  private readonly searchLoopThreshold: number;
  private readonly duplicateCallThreshold: number;
  readonly isReadOnly: boolean;

  constructor(private taskId: string = "unknown", opts?: PatternDetectorOptions) {
    this.isReadOnly = opts?.readOnly ?? false;
    if (this.isReadOnly) {
      this.readLoopThreshold = RO_READ_LOOP_THRESHOLD;
      this.stuckExplorationThreshold = RO_STUCK_EXPLORATION_THRESHOLD;
      this.globFloodThreshold = RO_GLOB_FLOOD_THRESHOLD;
      this.searchLoopThreshold = RO_SEARCH_LOOP_THRESHOLD;
      this.duplicateCallThreshold = RO_DUPLICATE_CALL_THRESHOLD;
    } else {
      this.readLoopThreshold = READ_LOOP_THRESHOLD;
      this.stuckExplorationThreshold = STUCK_EXPLORATION_THRESHOLD;
      this.globFloodThreshold = GLOB_FLOOD_THRESHOLD;
      this.searchLoopThreshold = SEARCH_LOOP_THRESHOLD;
      this.duplicateCallThreshold = DUPLICATE_CALL_THRESHOLD;
    }
  }

  /**
   * Record a tool call and check for problematic patterns.
   * Returns detected pattern if intervention is needed, null otherwise.
   */
  check(call: ToolCall): DetectedPattern | null {
    this.toolHistory.push(call);

    // Update heartbeat on every tool call
    this.lastToolCallTime = Date.now();

    // Keep history bounded
    if (this.toolHistory.length > PATTERN_WINDOW * 2) {
      this.toolHistory = this.toolHistory.slice(-PATTERN_WINDOW);
    }

    // Update counters based on tool type
    this.updateCounters(call);

    // Check each pattern type
    const patterns: (DetectedPattern | null)[] = [
      this.checkReadLoop(call),
      this.checkEditThrash(call),
      this.checkGlobFlood(call),
      this.checkErrorSpiral(call),
      this.checkStuckExploration(call),
      this.checkSearchLoop(call),
      this.checkDuplicateCall(call),
    ];

    // Return the most severe pattern found
    const detected = patterns.filter((p): p is DetectedPattern => p !== null);
    if (detected.length === 0) return null;

    // Sort by severity (high > medium > low)
    detected.sort((a, b) => {
      const order = { high: 3, medium: 2, low: 1 };
      return order[b.severity] - order[a.severity];
    });

    const pattern = detected[0];
    this.logPattern(pattern);
    return pattern;
  }

  /**
   * Get a summary of the current detection state.
   * Useful for shadow evaluator context.
   */
  getSummary(): {
    totalCalls: number;
    uniqueFilesRead: number;
    consecutiveGlobs: number;
    consecutiveErrors: number;
    toolsSinceWrite: number;
    hasWrittenOrEdited: boolean;
    recentTools: string[];
    lastToolCallTime: number;
    uniqueFilesTouched: number;
    detectedPatternCount: number;
  } {
    return {
      totalCalls: this.toolHistory.length,
      uniqueFilesRead: this.fileReadCounts.size,
      consecutiveGlobs: this.consecutiveGlobs,
      consecutiveErrors: this.consecutiveErrors,
      toolsSinceWrite: this.toolsSinceWrite,
      hasWrittenOrEdited: this.hasWrittenOrEdited,
      recentTools: this.toolHistory.slice(-10).map((t) => t.toolName),
      lastToolCallTime: this.lastToolCallTime,
      uniqueFilesTouched: this.uniqueFilesTouched.size,
      detectedPatternCount: this.lastPatternLog.size,
    };
  }

  /**
   * Get recent tool history for restart context.
   */
  getToolHistory(): string[] {
    return this.toolHistory.slice(-20).map((t) => {
      const input = t.toolInput ? JSON.stringify(t.toolInput).substring(0, 100) : "";
      return `${t.toolName}${input ? `: ${input}` : ""}${t.isError ? " (ERROR)" : ""}`;
    });
  }

  /**
   * Reset the detector state (e.g., after restart).
   */
  reset(): void {
    this.toolHistory = [];
    this.fileReadCounts.clear();
    this.fileEditHistory.clear();
    this.searchPatterns.clear();
    this.consecutiveGlobs = 0;
    this.consecutiveErrors = 0;
    this.toolsSinceWrite = 0;
    this.hasWrittenOrEdited = false;
    this.lastToolCallTime = Date.now();
    this.lastOutputSize = 0;
    this.lastOutputCheckTime = Date.now();
    this.uniqueFilesTouched.clear();
  }

  // ============================================================
  // INTERNAL METHODS
  // ============================================================

  private updateCounters(call: ToolCall): void {
    const { toolName, toolInput, isError } = call;

    // Track consecutive Globs
    if (toolName === "Glob") {
      this.consecutiveGlobs++;
    } else {
      this.consecutiveGlobs = 0;
    }

    // Track consecutive errors
    if (isError) {
      this.consecutiveErrors++;
    } else {
      this.consecutiveErrors = 0;
    }

    // Track tools since write
    if (toolName === "Write" || toolName === "Edit") {
      this.toolsSinceWrite = 0;
      this.hasWrittenOrEdited = true;
    } else {
      this.toolsSinceWrite++;
    }

    // Track file reads
    if (toolName === "Read" && toolInput?.file_path) {
      const path = this.normalizePath(toolInput.file_path);
      this.fileReadCounts.set(path, (this.fileReadCounts.get(path) || 0) + 1);
      this.uniqueFilesTouched.add(path);
    }

    // Track file edits
    if ((toolName === "Edit" || toolName === "Write") && toolInput?.file_path) {
      const path = this.normalizePath(toolInput.file_path);
      const history = this.fileEditHistory.get(path) || [];
      history.push(toolName);
      this.fileEditHistory.set(path, history);
      this.uniqueFilesTouched.add(path);
    }

    // Track search patterns
    if ((toolName === "Grep" || toolName === "Glob") && toolInput?.pattern) {
      const pattern = toolInput.pattern;
      this.searchPatterns.set(pattern, (this.searchPatterns.get(pattern) || 0) + 1);
    }
  }

  private normalizePath(path: string): string {
    // Normalize path separators for comparison
    return path.replace(/\\/g, "/").toLowerCase();
  }

  private checkReadLoop(call: ToolCall): DetectedPattern | null {
    if (call.toolName !== "Read" || !call.toolInput?.file_path) return null;

    const path = this.normalizePath(call.toolInput.file_path);
    const count = this.fileReadCounts.get(path) || 0;
    const threshold = this.readLoopThreshold;

    // File diversity check: if agent is reading many different files,
    // re-reads are likely cross-referencing, not a loop.
    const uniqueFiles = this.fileReadCounts.size;
    const diversityBonus = uniqueFiles >= 8 ? 3 : uniqueFiles >= 5 ? 2 : 0;
    const effectiveThreshold = threshold + diversityBonus;

    if (count >= effectiveThreshold) {
      return {
        type: "read_loop",
        description: `Reading ${path.split("/").pop()} ${count} times`,
        severity: count >= effectiveThreshold + 2 ? "high" : "medium",
        action: count >= effectiveThreshold + 2 ? "kill_restart" : "warn",
        details: { file: path, count },
      };
    }

    return null;
  }

  private checkEditThrash(call: ToolCall): DetectedPattern | null {
    if (call.toolName !== "Edit" && call.toolName !== "Write") return null;
    if (!call.toolInput?.file_path) return null;

    const path = this.normalizePath(call.toolInput.file_path);
    const history = this.fileEditHistory.get(path) || [];

    // Look for edit/write/edit patterns (thrashing)
    if (history.length >= EDIT_THRASH_THRESHOLD) {
      // Count recent edits to same file
      const recentEdits = history.slice(-EDIT_THRASH_THRESHOLD);
      const editCount = recentEdits.filter((t) => t === "Edit").length;

      if (editCount >= EDIT_THRASH_THRESHOLD - 1) {
        return {
          type: "edit_thrash",
          description: `Thrashing on ${path.split("/").pop()} (${history.length} edits)`,
          severity: history.length >= EDIT_THRASH_THRESHOLD + 2 ? "high" : "medium",
          action: history.length >= EDIT_THRASH_THRESHOLD + 2 ? "kill_restart" : "warn",
          details: { file: path, count: history.length },
        };
      }
    }

    return null;
  }

  private checkGlobFlood(call: ToolCall): DetectedPattern | null {
    const threshold = this.globFloodThreshold;
    if (this.consecutiveGlobs < threshold) return null;

    return {
      type: "glob_flood",
      description: `${this.consecutiveGlobs} consecutive Glob calls`,
      severity: this.consecutiveGlobs >= threshold + 3 ? "high" : "medium",
      action: this.consecutiveGlobs >= threshold + 3 ? "kill_restart" : "warn",
      details: { count: this.consecutiveGlobs },
    };
  }

  private checkErrorSpiral(call: ToolCall): DetectedPattern | null {
    if (this.consecutiveErrors < ERROR_SPIRAL_THRESHOLD) return null;

    return {
      type: "error_spiral",
      description: `${this.consecutiveErrors} consecutive errors`,
      severity: this.consecutiveErrors >= ERROR_SPIRAL_THRESHOLD + 2 ? "high" : "medium",
      action: this.consecutiveErrors >= ERROR_SPIRAL_THRESHOLD + 2 ? "kill_restart" : "warn",
      details: { count: this.consecutiveErrors },
    };
  }

  private checkStuckExploration(call: ToolCall): DetectedPattern | null {
    const threshold = this.stuckExplorationThreshold;
    if (this.toolsSinceWrite < threshold) return null;
    if (this.hasWrittenOrEdited) return null; // Already made progress earlier

    // Read-only tasks are SUPPOSED to only explore. Skip this check entirely.
    if (this.isReadOnly) return null;

    // Only flag if primarily doing exploration tools
    const recentTools = this.toolHistory.slice(-STUCK_EXPLORATION_THRESHOLD).map((t) => t.toolName);
    const explorationTools = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    const explorationCount = recentTools.filter((t) => explorationTools.has(t)).length;

    if (explorationCount / recentTools.length >= 0.7) {
      return {
        type: "stuck_exploration",
        description: `${this.toolsSinceWrite} tools without Write/Edit`,
        severity: this.toolsSinceWrite >= threshold + 10 ? "high" : "medium",
        action: this.toolsSinceWrite >= threshold + 10 ? "kill_restart" : "warn",
        details: { count: this.toolsSinceWrite, lastTools: recentTools.slice(-5) },
      };
    }

    return null;
  }

  private checkSearchLoop(call: ToolCall): DetectedPattern | null {
    if (call.toolName !== "Grep" && call.toolName !== "Glob") return null;
    if (!call.toolInput?.pattern) return null;

    const pattern = call.toolInput.pattern;
    const count = this.searchPatterns.get(pattern) || 0;
    const threshold = this.searchLoopThreshold;

    if (count >= threshold) {
      return {
        type: "search_loop",
        description: `Search pattern "${pattern.substring(0, 30)}" used ${count} times`,
        severity: count >= threshold + 2 ? "high" : "medium",
        action: count >= threshold + 2 ? "kill_restart" : "warn",
        details: { count },
      };
    }

    return null;
  }

  // Tools that legitimately repeat with similar inputs. Excluded from duplicate detection.
  // Read: targeted file retrieval is progress. TodoWrite: state tracking, called every task transition.
  // Bash: build/check commands repeat legitimately.
  private static readonly DUPE_EXEMPT_TOOLS = new Set(["Read", "TodoWrite", "Bash"]);

  private checkDuplicateCall(call: ToolCall): DetectedPattern | null {
    // Skip exempt tools entirely - they repeat legitimately
    if (PatternDetector.DUPE_EXEMPT_TOOLS.has(call.toolName)) return null;

    // Create a signature from tool name + key inputs
    const sig = this.createSignature(call);

    // Count occurrences in recent history
    const recentSigs = this.toolHistory
      .slice(-PATTERN_WINDOW)
      .map((t) => this.createSignature(t));

    const count = recentSigs.filter((s) => s === sig).length;

    const threshold = this.duplicateCallThreshold;
    if (count >= threshold) {
      return {
        type: "duplicate_call",
        description: `${call.toolName} called ${count} times with same input`,
        severity: count >= threshold + 2 ? "high" : "medium",
        action: count >= threshold + 2 ? "kill_restart" : "warn",
        details: { count, lastTools: this.toolHistory.slice(-5).map((t) => t.toolName) },
      };
    }

    return null;
  }

  /**
   * Check heartbeat: called periodically (not on every tool call) to detect
   * agents that have gone silent (no tool calls for extended periods).
   * Returns a detected pattern if the agent appears unresponsive.
   */
  checkHeartbeat(): DetectedPattern | null {
    const now = Date.now();
    const silentSec = (now - this.lastToolCallTime) / 1000;

    if (silentSec >= HEARTBEAT_KILL_SEC) {
      const pattern: DetectedPattern = {
        type: "heartbeat_timeout",
        description: `No tool call for ${Math.round(silentSec)}s (kill threshold: ${HEARTBEAT_KILL_SEC}s)`,
        severity: "high",
        action: "kill_restart",
        details: { count: Math.round(silentSec) },
      };
      this.logPattern(pattern);
      return pattern;
    }

    if (silentSec >= HEARTBEAT_WARN_SEC) {
      const pattern: DetectedPattern = {
        type: "heartbeat_timeout",
        description: `No tool call for ${Math.round(silentSec)}s (warn threshold: ${HEARTBEAT_WARN_SEC}s)`,
        severity: "high",
        action: "warn",
        details: { count: Math.round(silentSec) },
      };
      this.logPattern(pattern);
      return pattern;
    }

    return null;
  }

  /**
   * Update cumulative output size and check for stagnation.
   * Called periodically by the supervisor worker with the current total output size.
   * Returns a detected pattern if output hasn't grown meaningfully.
   */
  checkOutputStagnation(currentOutputSize: number): DetectedPattern | null {
    const now = Date.now();
    const elapsedSec = (now - this.lastOutputCheckTime) / 1000;

    // Only check once per stagnation window
    if (elapsedSec < OUTPUT_STAGNATION_WINDOW_SEC) return null;

    const growth = currentOutputSize - this.lastOutputSize;
    this.lastOutputSize = currentOutputSize;
    this.lastOutputCheckTime = now;

    // If output hasn't grown by more than threshold, agent may be stuck in a thinking loop
    if (growth <= OUTPUT_STAGNATION_MIN_CHARS && this.toolHistory.length > 5) {
      const pattern: DetectedPattern = {
        type: "output_stagnation",
        description: `Output grew only ${growth} chars in ${Math.round(elapsedSec)}s`,
        severity: "medium",
        action: "warn",
        details: { count: growth },
      };
      this.logPattern(pattern);
      return pattern;
    }

    return null;
  }

  private createSignature(call: ToolCall): string {
    // Use 500 chars (was 200) to reduce false collisions on tools where
    // differentiating content appears later in the JSON (e.g., status changes in TodoWrite)
    const inputStr = call.toolInput ? JSON.stringify(call.toolInput).substring(0, 500) : "";
    return `${call.toolName}:${inputStr}`;
  }

  private logPattern(pattern: DetectedPattern): void {
    // Rate limit: same pattern type at most once per 5 minutes per task
    const key = `${this.taskId}:${pattern.type}`;
    const lastLog = this.lastPatternLog.get(key) || 0;
    if (Date.now() - lastLog < 300_000) return;
    this.lastPatternLog.set(key, Date.now());

    const logFn = pattern.severity === "high" ? warn : info;
    logFn(
      "patterns",
      `[${this.taskId}] Detected ${pattern.type}: ${pattern.description} (action: ${pattern.action})`
    );
  }
}

// ============================================================
// FACTORY FUNCTION
// ============================================================

/**
 * Create a new pattern detector for a task.
 */
export function createPatternDetector(taskId: string, opts?: PatternDetectorOptions): PatternDetector {
  return new PatternDetector(taskId, opts);
}

/**
 * Detect if a task prompt describes a read-only operation (audit, review, plan, analysis).
 * Used by supervisor-worker to relax pattern thresholds for tasks that are expected
 * to read many files without writing anything.
 */
export function isReadOnlyTask(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  const readOnlyKeywords = [
    "audit", "review", "analyze", "analysis", "report", "plan mode",
    "plan-only", "planning mode", "read through", "map current",
    "investigate", "examine", "assess", "evaluate", "survey",
    "document current", "understand", "explore", "research",
    "architecture audit", "code review", "security audit",
  ];
  return readOnlyKeywords.some(kw => lower.includes(kw));
}

// ============================================================
// STUCK SCORE (PROBABILISTIC)
// ============================================================

/**
 * Compute a 0-1 probability that a code agent is stuck.
 *
 * Formula: sigmoid(w_r * repetition + w_l * latency_ratio + w_c * complexity - bias)
 * Where:
 *   repetition = detected repetition patterns / total tool calls
 *   latency_ratio = avg time between recent tool calls / expected avg (15s)
 *   complexity = number of unique files touched (higher = harder task, more lenient)
 *   bias = 2.0 (default threshold)
 *   weights: w_r=3.0, w_l=2.0, w_c=-0.5
 */
export function computeStuckScore(detector: PatternDetector): number {
  const summary = detector.getSummary();
  const totalCalls = summary.totalCalls;

  // Avoid division by zero on fresh detectors
  if (totalCalls < 3) return 0;

  // repetition = number of detected patterns / total tool calls
  const repetition = summary.detectedPatternCount / totalCalls;

  // latency_ratio = avg time between recent tool calls / expected avg (15s)
  const now = Date.now();
  const silentMs = now - summary.lastToolCallTime;
  const expectedAvgMs = 15_000;
  const latencyRatio = silentMs / expectedAvgMs;

  // complexity = number of unique files touched
  const complexity = summary.uniqueFilesTouched;

  // Weights and bias
  const w_r = 3.0;
  const w_l = 2.0;
  const w_c = -0.5;
  const bias = 2.0;

  const x = w_r * repetition + w_l * latencyRatio + w_c * complexity - bias;

  // sigmoid
  return 1 / (1 + Math.exp(-x));
}
