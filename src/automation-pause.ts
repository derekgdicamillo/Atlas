/**
 * Atlas -- Automation Pause System
 *
 * Persisted, tag-driven mechanism to pause/resume automation categories.
 * Two control paths:
 *   1. Claude emits [PAUSE_AUTOMATIONS:category] / [RESUME_AUTOMATIONS:category] tags
 *   2. Derek uses /automations pause|resume <category> command
 *
 * When paused:
 *   - Cron jobs for that category return early (no new tasks spawned)
 *   - In-flight tasks still complete and write to data/task-output/
 *   - Announcement is silently markAnnounced() without sending to Telegram
 *
 * State persisted to data/automation-pause.json (survives pm2 restarts).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { info, warn } from "./logger.ts";
import {
  AUTOMATION_CATEGORIES,
  AUTOMATION_CATEGORY_CHILDREN,
  AUTOMATION_WORKFLOW_MAP,
  type AutomationCategory,
} from "./constants.ts";
import type { SupervisedTask } from "./supervisor.ts";

const PROJECT_ROOT = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_ROOT, "data");
const STATE_FILE = join(DATA_DIR, "automation-pause.json");
const MAX_SUPPRESSED_IDS = 100;

// ============================================================
// STATE
// ============================================================

interface PauseRecord {
  category: AutomationCategory;
  pausedAt: string;
  pausedBy: string; // "session" (tag) or "command" (/automations)
  reason?: string;
}

interface AutomationPauseState {
  paused: Partial<Record<AutomationCategory, PauseRecord>>;
  suppressedTaskIds: string[];
}

function loadState(): AutomationPauseState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    warn("automation-pause", "Failed to load state, starting fresh");
  }
  return { paused: {}, suppressedTaskIds: [] };
}

function saveState(state: AutomationPauseState): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    warn("automation-pause", `Failed to save state: ${err}`);
  }
}

// ============================================================
// CORE API
// ============================================================

export function pauseAutomation(category: AutomationCategory, by: string, reason?: string): void {
  const state = loadState();
  state.paused[category] = {
    category,
    pausedAt: new Date().toISOString(),
    pausedBy: by,
    reason,
  };
  saveState(state);
  info("automation-pause", `Paused ${category} (by ${by}${reason ? `, reason: ${reason}` : ""})`);
}

export function resumeAutomation(category: AutomationCategory): void {
  const state = loadState();
  delete state.paused[category];
  // If resuming a parent, also resume all children
  const children = AUTOMATION_CATEGORY_CHILDREN[category];
  if (children) {
    for (const child of children) {
      delete state.paused[child];
    }
  }
  saveState(state);
  info("automation-pause", `Resumed ${category}`);
}

/** Check if a category is directly paused. */
function isPaused(category: AutomationCategory): boolean {
  const state = loadState();
  return category in state.paused;
}

/** Check if a category or any of its parents is paused. */
export function isEffectivelyPaused(category: AutomationCategory): boolean {
  if (isPaused(category)) return true;
  // Walk parents: check if any parent category that contains this child is paused
  for (const [parent, children] of Object.entries(AUTOMATION_CATEGORY_CHILDREN)) {
    if (children.includes(category) && isPaused(parent as AutomationCategory)) {
      return true;
    }
  }
  return false;
}

// ============================================================
// TASK SUPPRESSION
// ============================================================

/** Description patterns that identify patient-engagement tasks */
const PATIENT_ENGAGEMENT_PATTERNS = /reactivat|stale.*lead|re-?engag|no.?show.*recover/i;

/**
 * Determine if a completed task's announcement should be suppressed.
 * Matches tasks to paused categories via workflow template + description heuristics.
 */
export function shouldSuppressAnnouncement(task: SupervisedTask): boolean {
  // Check workflow-based matching
  for (const [category, templates] of Object.entries(AUTOMATION_WORKFLOW_MAP)) {
    if (!templates || !isEffectivelyPaused(category as AutomationCategory)) continue;
    // Match by workflowId prefix (workflow IDs are "wf-<timestamp>", template name in description)
    if (task.workflowId && task.requestedBy === "workflow") {
      // The description is interpolated from the template, check if any template's keywords match
      for (const tpl of templates) {
        if (task.description.toLowerCase().includes(tpl.replace(/-/g, " ").replace("stale lead reactivate", "reactivat"))) {
          return true;
        }
      }
    }
  }

  // Description heuristic fallback: catch workflow and [TASK:] spawned tasks
  if (isEffectivelyPaused("patient_engagement") || isEffectivelyPaused("stale_leads")) {
    if (PATIENT_ENGAGEMENT_PATTERNS.test(task.description)) {
      return true;
    }
  }

  return false;
}

export function recordSuppressedTask(taskId: string): void {
  const state = loadState();
  state.suppressedTaskIds.push(taskId);
  // Cap to prevent unbounded growth
  if (state.suppressedTaskIds.length > MAX_SUPPRESSED_IDS) {
    state.suppressedTaskIds = state.suppressedTaskIds.slice(-MAX_SUPPRESSED_IDS);
  }
  saveState(state);
}

// ============================================================
// STATUS DISPLAY
// ============================================================

export function getPauseStatus(): string {
  const state = loadState();
  const entries = Object.values(state.paused);
  if (entries.length === 0) {
    return "All automations active. No categories paused.\n\nUsage: /automations pause <category>\nCategories: " + AUTOMATION_CATEGORIES.join(", ");
  }
  const lines = entries.map((r) => {
    const ago = Math.round((Date.now() - new Date(r.pausedAt).getTime()) / 60000);
    return `  ${r.category} -- paused ${ago}m ago by ${r.pausedBy}${r.reason ? ` (${r.reason})` : ""}`;
  });
  const suppressed = state.suppressedTaskIds.length;
  return `Paused automations:\n${lines.join("\n")}${suppressed > 0 ? `\n\n${suppressed} task announcement(s) suppressed.` : ""}\n\nResume: /automations resume <category>`;
}

// ============================================================
// TAG PROCESSING
// ============================================================

const PAUSE_REGEX = /\[PAUSE_AUTOMATIONS:\s*([^\]|]+?)(?:\s*\|\s*(.+?))?\s*\]/gi;
const RESUME_REGEX = /\[RESUME_AUTOMATIONS:\s*([^\]]+?)\s*\]/gi;

function isValidCategory(cat: string): cat is AutomationCategory {
  return (AUTOMATION_CATEGORIES as readonly string[]).includes(cat.trim());
}

/**
 * Parse [PAUSE_AUTOMATIONS:cat] and [RESUME_AUTOMATIONS:cat] tags from Claude's response.
 * Replaces matched tags with confirmation text.
 */
export function processAutomationPauseTags(response: string): string {
  let result = response;

  result = result.replace(PAUSE_REGEX, (_match, cat: string, reason?: string) => {
    const category = cat.trim();
    if (!isValidCategory(category)) {
      warn("automation-pause", `Unknown category in tag: ${category}`);
      return `(Unknown automation category: ${category})`;
    }
    pauseAutomation(category, "session", reason?.trim());
    return `(Paused ${category} automations${reason ? `: ${reason.trim()}` : ""})`;
  });

  result = result.replace(RESUME_REGEX, (_match, cat: string) => {
    const category = cat.trim();
    if (!isValidCategory(category)) {
      warn("automation-pause", `Unknown category in tag: ${category}`);
      return `(Unknown automation category: ${category})`;
    }
    resumeAutomation(category);
    return `(Resumed ${category} automations)`;
  });

  return result;
}
