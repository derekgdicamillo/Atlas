/**
 * Atlas — Checkpoint System
 *
 * Phase-based task verification for complex code agent tasks.
 * Define expected phases (explore, implement, test, document) and
 * verify agent is making appropriate progress at each phase.
 *
 * Usage: Tag tasks with checkpoints in the prompt:
 * [CODE_TASK: cwd=/atlas | checkpoints=explore,implement,test | PROMPT: ...]
 */

import { info, warn } from "./logger.ts";

// ============================================================
// TYPES
// ============================================================

export type CheckpointPhase = "explore" | "implement" | "test" | "document" | "custom";

export interface PhaseConfig {
  name: CheckpointPhase | string;
  /** Tool types expected in this phase */
  expectedTools: string[];
  /** Tools that indicate phase transition */
  transitionTools: string[];
  /** Minimum tool calls before phase can transition */
  minToolCalls?: number;
  /** Maximum tool calls before warning */
  maxToolCalls?: number;
  /** Custom validation function */
  validate?: (toolHistory: ToolRecord[]) => boolean;
}

export interface ToolRecord {
  toolName: string;
  toolInput?: Record<string, any>;
  timestamp: number;
}

export interface CheckpointState {
  currentPhase: number;
  phases: PhaseConfig[];
  phaseStartIndex: number;
  toolHistory: ToolRecord[];
  warnings: string[];
  completed: boolean;
}

export interface CheckpointVerification {
  valid: boolean;
  currentPhaseName: string;
  progress: number; // 0-1
  warnings: string[];
  shouldAdvance: boolean;
}

// ============================================================
// PHASE CONFIGURATIONS
// ============================================================

/** Default phase configs for common checkpoint types */
const DEFAULT_PHASES: Record<string, PhaseConfig> = {
  explore: {
    name: "explore",
    expectedTools: ["Read", "Glob", "Grep", "Task"],
    transitionTools: ["Write", "Edit"],
    minToolCalls: 3,
    maxToolCalls: 30,
  },
  implement: {
    name: "implement",
    expectedTools: ["Write", "Edit", "Read", "Glob"],
    transitionTools: ["Bash"],
    minToolCalls: 2,
    maxToolCalls: 50,
  },
  test: {
    name: "test",
    expectedTools: ["Bash", "Read"],
    transitionTools: ["Write", "Edit"],
    minToolCalls: 1,
    maxToolCalls: 20,
  },
  document: {
    name: "document",
    expectedTools: ["Write", "Edit", "Read"],
    transitionTools: [],
    minToolCalls: 1,
    maxToolCalls: 10,
  },
};

// ============================================================
// CHECKPOINT TRACKER CLASS
// ============================================================

export class CheckpointTracker {
  private state: CheckpointState;
  private taskId: string;

  constructor(taskId: string, phases: (CheckpointPhase | PhaseConfig)[]) {
    this.taskId = taskId;

    // Convert phase names to configs
    const phaseConfigs = phases.map((p) => {
      if (typeof p === "string") {
        return DEFAULT_PHASES[p] || { name: p, expectedTools: [], transitionTools: [] };
      }
      return p;
    });

    this.state = {
      currentPhase: 0,
      phases: phaseConfigs,
      phaseStartIndex: 0,
      toolHistory: [],
      warnings: [],
      completed: false,
    };

    info("checkpoints", `[${taskId}] Initialized with phases: ${phaseConfigs.map((p) => p.name).join(" -> ")}`);
  }

  /**
   * Record a tool call and verify checkpoint progress.
   */
  recordTool(tool: ToolRecord): CheckpointVerification {
    this.state.toolHistory.push(tool);

    if (this.state.completed) {
      return this.buildVerification(true, false);
    }

    const currentConfig = this.state.phases[this.state.currentPhase];
    if (!currentConfig) {
      this.state.completed = true;
      return this.buildVerification(true, false);
    }

    const phaseToolCount = this.state.toolHistory.length - this.state.phaseStartIndex;
    const warnings: string[] = [];

    // Check if tool is expected for this phase
    if (!currentConfig.expectedTools.includes(tool.toolName)) {
      // Check if it's a transition tool
      if (currentConfig.transitionTools.includes(tool.toolName)) {
        // Check minimum calls before allowing transition
        if (currentConfig.minToolCalls && phaseToolCount < currentConfig.minToolCalls) {
          warnings.push(
            `Transitioning from ${currentConfig.name} early (${phaseToolCount} calls, expected ${currentConfig.minToolCalls}+)`
          );
        }
        return this.advancePhase(warnings);
      }

      // Unexpected tool for this phase (but not a transition)
      warnings.push(`Unexpected tool ${tool.toolName} during ${currentConfig.name} phase`);
    }

    // Check max tool calls
    if (currentConfig.maxToolCalls && phaseToolCount > currentConfig.maxToolCalls) {
      warnings.push(`${currentConfig.name} phase exceeded expected tool calls (${phaseToolCount}/${currentConfig.maxToolCalls})`);
    }

    // Store warnings
    this.state.warnings.push(...warnings);

    return this.buildVerification(false, false);
  }

  /**
   * Advance to the next phase.
   */
  private advancePhase(transitionWarnings: string[]): CheckpointVerification {
    const oldPhase = this.state.phases[this.state.currentPhase].name;
    this.state.currentPhase++;
    this.state.phaseStartIndex = this.state.toolHistory.length;

    if (this.state.currentPhase >= this.state.phases.length) {
      this.state.completed = true;
      info("checkpoints", `[${this.taskId}] All phases completed`);
    } else {
      const newPhase = this.state.phases[this.state.currentPhase].name;
      info("checkpoints", `[${this.taskId}] Phase transition: ${oldPhase} -> ${newPhase}`);
    }

    this.state.warnings.push(...transitionWarnings);

    return this.buildVerification(!this.state.completed, true);
  }

  /**
   * Build verification result.
   */
  private buildVerification(valid: boolean, shouldAdvance: boolean): CheckpointVerification {
    const currentConfig = this.state.phases[this.state.currentPhase];
    const progress = this.state.completed
      ? 1
      : (this.state.currentPhase + 0.5) / this.state.phases.length;

    return {
      valid,
      currentPhaseName: currentConfig?.name || "completed",
      progress,
      warnings: [...this.state.warnings],
      shouldAdvance,
    };
  }

  /**
   * Get current checkpoint state summary.
   */
  getSummary(): {
    currentPhase: string;
    phasesCompleted: number;
    totalPhases: number;
    toolsInCurrentPhase: number;
    totalTools: number;
    warnings: string[];
    completed: boolean;
  } {
    const currentConfig = this.state.phases[this.state.currentPhase];

    return {
      currentPhase: currentConfig?.name || "completed",
      phasesCompleted: this.state.currentPhase,
      totalPhases: this.state.phases.length,
      toolsInCurrentPhase: this.state.toolHistory.length - this.state.phaseStartIndex,
      totalTools: this.state.toolHistory.length,
      warnings: [...this.state.warnings],
      completed: this.state.completed,
    };
  }

  /**
   * Check if current phase should have completed by now.
   */
  isPhaseOverdue(): boolean {
    const currentConfig = this.state.phases[this.state.currentPhase];
    if (!currentConfig || !currentConfig.maxToolCalls) return false;

    const phaseToolCount = this.state.toolHistory.length - this.state.phaseStartIndex;
    return phaseToolCount > currentConfig.maxToolCalls * 1.5;
  }

  /**
   * Reset the tracker state.
   */
  reset(): void {
    this.state.currentPhase = 0;
    this.state.phaseStartIndex = 0;
    this.state.toolHistory = [];
    this.state.warnings = [];
    this.state.completed = false;
  }
}

// ============================================================
// PARSING
// ============================================================

/**
 * Parse checkpoint specification from task options.
 * Format: "explore,implement,test" or "explore|implement|test"
 */
export function parseCheckpoints(spec: string): (CheckpointPhase | PhaseConfig)[] {
  if (!spec) return [];

  const phases = spec.split(/[,|]/).map((s) => s.trim().toLowerCase());
  const result: (CheckpointPhase | PhaseConfig)[] = [];

  for (const phase of phases) {
    if (phase in DEFAULT_PHASES) {
      result.push(phase as CheckpointPhase);
    } else if (phase) {
      // Custom phase name
      result.push({
        name: phase,
        expectedTools: [],
        transitionTools: [],
      });
    }
  }

  return result;
}

/**
 * Create a checkpoint tracker for a task.
 * Returns null if no checkpoints specified.
 */
export function createCheckpointTracker(
  taskId: string,
  checkpointSpec?: string
): CheckpointTracker | null {
  if (!checkpointSpec) return null;

  const phases = parseCheckpoints(checkpointSpec);
  if (phases.length === 0) return null;

  return new CheckpointTracker(taskId, phases);
}

// ============================================================
// UTILITIES
// ============================================================

/**
 * Suggest checkpoints for a task based on prompt analysis.
 */
export function suggestCheckpoints(prompt: string): CheckpointPhase[] {
  const lower = prompt.toLowerCase();
  const suggestions: CheckpointPhase[] = [];

  // Always start with explore for non-trivial tasks
  if (prompt.length > 100) {
    suggestions.push("explore");
  }

  // Implementation is usually needed
  if (
    lower.includes("add") ||
    lower.includes("create") ||
    lower.includes("implement") ||
    lower.includes("fix") ||
    lower.includes("update") ||
    lower.includes("modify")
  ) {
    suggestions.push("implement");
  }

  // Testing if mentioned or implied
  if (
    lower.includes("test") ||
    lower.includes("verify") ||
    lower.includes("build") ||
    lower.includes("check")
  ) {
    suggestions.push("test");
  }

  // Documentation if mentioned
  if (
    lower.includes("document") ||
    lower.includes("readme") ||
    lower.includes("docs") ||
    lower.includes("comment")
  ) {
    suggestions.push("document");
  }

  // Default to explore -> implement if nothing detected
  if (suggestions.length === 0) {
    return ["explore", "implement"];
  }

  return suggestions;
}

/**
 * Get a human-readable description of checkpoint progress.
 */
export function describeCheckpointProgress(tracker: CheckpointTracker): string {
  const summary = tracker.getSummary();

  if (summary.completed) {
    return `All ${summary.totalPhases} phases completed`;
  }

  const pct = Math.round((summary.phasesCompleted / summary.totalPhases) * 100);
  return `Phase: ${summary.currentPhase} (${pct}% complete, ${summary.toolsInCurrentPhase} tools in phase)`;
}
