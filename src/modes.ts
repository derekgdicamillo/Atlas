/**
 * Atlas — Mode System
 *
 * Provides specialized context injection for social media, marketing,
 * and Skool content creation. Modes can be activated explicitly via
 * slash commands or automatically via intent detection from message content.
 *
 * Each mode loads a specialized prompt file that gets injected into
 * the Claude prompt alongside the base personality.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { info } from "./logger.ts";

export type ModeId = "social" | "marketing" | "skool";

export interface ModeConfig {
  id: ModeId;
  name: string;
  description: string;
  promptFile: string;
  /** Keywords/patterns that trigger auto-detection */
  triggers: RegExp[];
  /** Default model tier for this mode (can be overridden) */
  defaultModel?: string;
}

interface ModeRuntime {
  config: ModeConfig;
  prompt: string; // loaded content of promptFile
}

// ============================================================
// MODE DEFINITIONS
// ============================================================

const MODE_CONFIGS: ModeConfig[] = [
  {
    id: "social",
    name: "Social Media",
    description: "Content creation, posting calendars, engagement strategy",
    promptFile: "config/modes/social.md",
    triggers: [
      /\b(facebook|fb|instagram|ig|social media|social post|post about)\b/i,
      /\b(content calendar|posting calendar|posting schedule)\b/i,
      /\b(caption|hashtag|reel|story|stories)\b/i,
      /\b(create a post|write a post|draft a post|make a post)\b/i,
      /\b(engagement|followers|reach|impressions)\b/i,
      /\b(hooks? for|scroll.?stop|write hooks|hook formula)\b/i,
      /\b(youtube title|youtube video|thumbnail)\b/i,
      /\b(content waterfall|repurpose|content strategy)\b/i,
    ],
  },
  {
    id: "marketing",
    name: "Marketing",
    description: "Ads, funnels, campaigns, strategy, analytics",
    promptFile: "config/modes/marketing.md",
    triggers: [
      /\b(facebook ad|fb ad|meta ad|run ads|ad copy|ad creative)\b/i,
      /\b(campaign|cpl|cpc|ctr|roas|conversion rate)\b/i,
      /\b(funnel|landing page|opt.?in|lead magnet|squeeze page)\b/i,
      /\b(ad spend|budget|cost per lead|cost per click)\b/i,
      /\b(target audience|targeting|lookalike|retarget)\b/i,
      /\b(hormozi|brunson|value ladder|dream 100)\b/i,
      /\b(ads performing|ad results|ad analytics|ad report)\b/i,
      /\b(scaling ads|scaling campaign|10x|growth strategy)\b/i,
      /\b(offer stack|grand slam offer|irresistible offer)\b/i,
      /\b(email sequence|soap opera|nurture sequence)\b/i,
    ],
  },
  {
    id: "skool",
    name: "Skool (Vitality Unchained)",
    description: "Community content, course materials, member engagement",
    promptFile: "config/modes/skool.md",
    triggers: [
      /\b(skool|school group|community post|tribe)\b/i,
      /\b(vitality unchained|vu tribe|vu community)\b/i,
      /\b(5 pillars|five pillars|pillar\s?\d)\b/i,
      /\b(fuel code|protein paradox|calm core|cooling fuel|movement hierarchy)\b/i,
      /\b(course content|course module|skool module|lesson plan|worksheet)\b/i,
      /\b(member engagement|community engagement|welcome post)\b/i,
      /\b(weekly check.?in|challenge post|ama|ask me anything)\b/i,
      /\b(vitality tracker|body comp scale)\b/i,
      /\b(slow.?&.?shield|slow and shield)\b/i,
    ],
  },
];

// ============================================================
// RUNTIME STATE
// ============================================================

const modeRuntimes: Map<ModeId, ModeRuntime> = new Map();
const activeModes: Map<string, ModeId> = new Map(); // sessionKey -> active mode

// ============================================================
// INITIALIZATION
// ============================================================

export function loadModes(projectRoot: string): void {
  for (const config of MODE_CONFIGS) {
    try {
      const prompt = readFileSync(join(projectRoot, config.promptFile), "utf-8");
      modeRuntimes.set(config.id, { config, prompt });
      info("modes", `Loaded mode: ${config.name}`);
    } catch (err) {
      console.warn(`[modes] Could not load mode ${config.id}: ${err}`);
    }
  }
}

// ============================================================
// MODE DETECTION & ACTIVATION
// ============================================================

/**
 * Detect which mode (if any) a message should activate.
 * Returns the mode ID or null if no mode matches.
 *
 * Priority:
 * 1. Explicit slash command (handled separately in relay.ts)
 * 2. Keyword/pattern matching against message text
 * 3. Current active mode persists if no new mode detected
 */
export function detectMode(text: string): ModeId | null {
  // Score each mode by how many trigger patterns match
  let bestMode: ModeId | null = null;
  let bestScore = 0;

  for (const config of MODE_CONFIGS) {
    let score = 0;
    for (const trigger of config.triggers) {
      if (trigger.test(text)) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMode = config.id;
    }
  }

  // Require at least 2 trigger matches to auto-switch.
  // Single keyword matches are too trigger-happy and cause false positives
  // (e.g., "module" in a coding context triggering Skool mode).
  return bestScore >= 2 ? bestMode : null;
}

/**
 * Get or detect the active mode for a session.
 * If the message triggers a new mode, switch to it.
 * If no mode is detected and one is already active, keep it.
 * Returns the mode prompt to inject, or empty string if no mode active.
 */
export function resolveMode(sessionKey: string, messageText: string): {
  modeId: ModeId | null;
  modePrompt: string;
  modeName: string;
  switched: boolean;
} {
  const detected = detectMode(messageText);
  const current = activeModes.get(sessionKey) || null;

  // New mode detected
  if (detected && detected !== current) {
    activeModes.set(sessionKey, detected);
    const runtime = modeRuntimes.get(detected);
    info("modes", `[${sessionKey}] Mode switched: ${current || "none"} -> ${detected}`);
    return {
      modeId: detected,
      modePrompt: runtime?.prompt || "",
      modeName: runtime?.config.name || detected,
      switched: true,
    };
  }

  // Keep current mode
  if (current) {
    const runtime = modeRuntimes.get(current);
    return {
      modeId: current,
      modePrompt: runtime?.prompt || "",
      modeName: runtime?.config.name || current,
      switched: false,
    };
  }

  // No mode active
  return { modeId: null, modePrompt: "", modeName: "", switched: false };
}

/**
 * Explicitly set a mode for a session (from slash commands).
 */
export function setMode(sessionKey: string, modeId: ModeId): {
  modeName: string;
  modePrompt: string;
} {
  activeModes.set(sessionKey, modeId);
  const runtime = modeRuntimes.get(modeId);
  info("modes", `[${sessionKey}] Mode set explicitly: ${modeId}`);
  return {
    modeName: runtime?.config.name || modeId,
    modePrompt: runtime?.prompt || "",
  };
}

/**
 * Clear the active mode for a session.
 */
export function clearMode(sessionKey: string): void {
  activeModes.delete(sessionKey);
  info("modes", `[${sessionKey}] Mode cleared`);
}

/**
 * Get the currently active mode for a session.
 */
export function getActiveMode(sessionKey: string): ModeId | null {
  return activeModes.get(sessionKey) || null;
}

/**
 * Get all available modes (for /mode list).
 */
export function listModes(): { id: ModeId; name: string; description: string }[] {
  return MODE_CONFIGS.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
  }));
}

/**
 * Check if a mode ID is valid.
 */
export function isValidMode(id: string): id is ModeId {
  return MODE_CONFIGS.some((c) => c.id === id);
}
