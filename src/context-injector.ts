/**
 * Atlas — Code Agent Context Injector
 *
 * Builds rich context bundles for code agents so they perform closer
 * to interactive Claude Code sessions. Injects excerpts from CLAUDE.md,
 * SOUL.md, USER.md, and task-specific memory files.
 *
 * Design principle: Keep context under 4K tokens to avoid bloat while
 * providing essential identity, rules, and domain knowledge.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const MEMORY_DIR = join(PROJECT_DIR, "memory");

// Context file paths
const CLAUDE_MD = join(PROJECT_DIR, "CLAUDE.md");
const SOUL_MD = join(PROJECT_DIR, "SOUL.md");
const USER_MD = join(PROJECT_DIR, "USER.md");
const SHIELD_MD = join(PROJECT_DIR, "SHIELD.md");

// Memory files for task-specific context
const VOICE_GUIDE = join(MEMORY_DIR, "voice-guide.md");
const CONTENT_ENGINE = join(MEMORY_DIR, "content-engine.md");

// ============================================================
// TYPES
// ============================================================

export type TaskCategory = "content" | "integration" | "bugfix" | "feature" | "refactor" | "general";

export interface ContextBundle {
  /** Combined context string to prepend to agent prompt */
  context: string;
  /** Approximate token count (rough estimate: 4 chars = 1 token) */
  estimatedTokens: number;
  /** Which files were included */
  sources: string[];
}

export interface ContextOptions {
  /** Task category for domain-specific context */
  category?: TaskCategory;
  /** Original task prompt (for keyword detection) */
  prompt?: string;
  /** Working directory of the task */
  cwd?: string;
  /** Include full SHIELD.md security rules */
  includeShield?: boolean;
  /** Custom additional context to append */
  additionalContext?: string;
}

// ============================================================
// FILE READING HELPERS
// ============================================================

async function safeReadFile(path: string): Promise<string | null> {
  try {
    if (!existsSync(path)) return null;
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Extract a section from a markdown file by header.
 * Returns content between the header and the next same-level header.
 */
function extractSection(content: string, headerPattern: RegExp): string | null {
  const lines = content.split("\n");
  let capturing = false;
  let capturedLines: string[] = [];
  let headerLevel = 0;

  for (const line of lines) {
    if (headerPattern.test(line)) {
      capturing = true;
      headerLevel = (line.match(/^#+/) || [""])[0].length;
      continue;
    }

    if (capturing) {
      // Stop at next header of same or higher level
      const lineLevel = (line.match(/^#+/) || [""])[0].length;
      if (lineLevel > 0 && lineLevel <= headerLevel) {
        break;
      }
      capturedLines.push(line);
    }
  }

  const result = capturedLines.join("\n").trim();
  return result || null;
}

/**
 * Truncate content to approximate token limit.
 * Uses rough estimate of 4 chars per token.
 */
function truncateToTokens(content: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (content.length <= maxChars) return content;
  return content.substring(0, maxChars) + "\n[... truncated for context budget ...]";
}

// ============================================================
// CONTEXT EXTRACTION
// ============================================================

/**
 * Extract essential identity context from CLAUDE.md.
 * Focuses on: agent identity and operating context.
 * Tool usage rules are skipped -- those are main session Telegram rules,
 * not relevant to code agents (which have full tool access).
 */
async function extractClaudeContext(): Promise<string | null> {
  const content = await safeReadFile(CLAUDE_MD);
  if (!content) return null;

  const sections: string[] = [];

  // Agent identity (critical for correct persona)
  const identity = extractSection(content, /^## CRITICAL: Agent Identity/i);
  if (identity) sections.push("## Agent Identity\n" + identity);

  // Operating context (environment info)
  const operating = extractSection(content, /^## Operating Context/i);
  if (operating) sections.push("## Operating Context\n" + truncateToTokens(operating, 150));

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Extract core principles from SOUL.md.
 * Focuses on: initiative, resourcefulness, problem-solving mindset.
 */
async function extractSoulContext(): Promise<string | null> {
  const content = await safeReadFile(SOUL_MD);
  if (!content) return null;

  const sections: string[] = [];

  // Core truths (fundamental behavior)
  const coreTruths = extractSection(content, /^## Core Truths/i);
  if (coreTruths) sections.push("## Core Principles\n" + truncateToTokens(coreTruths, 200));

  // Initiative (critical for autonomous work)
  const initiative = extractSection(content, /^## Initiative & Resourcefulness/i);
  if (initiative) sections.push("## Initiative & Resourcefulness\n" + truncateToTokens(initiative, 250));

  // Problem-solving mindset
  const problemSolving = extractSection(content, /^## Problem-Solving Mindset/i);
  if (problemSolving) sections.push("## Problem-Solving Mindset\n" + truncateToTokens(problemSolving, 200));

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Extract user preferences from USER.md.
 * Focuses on: communication style, coding preferences, business context.
 */
async function extractUserContext(): Promise<string | null> {
  const content = await safeReadFile(USER_MD);
  if (!content) return null;

  const sections: string[] = [];

  // Derek's preferences (coding style, communication)
  const preferences = extractSection(content, /^## Preferences/i);
  if (preferences) sections.push("## User Preferences\n" + truncateToTokens(preferences, 200));

  // Professional context (business understanding)
  const professional = extractSection(content, /^## Professional Context/i);
  if (professional) sections.push("## Business Context\n" + truncateToTokens(professional, 150));

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Extract security rules from SHIELD.md.
 */
async function extractShieldContext(): Promise<string | null> {
  const content = await safeReadFile(SHIELD_MD);
  if (!content) return null;

  // Get absolute rules and blocked patterns
  const absoluteRules = extractSection(content, /^## Absolute Rules/i);
  const blockedPatterns = extractSection(content, /^## Blocked File Patterns/i);
  const blockedCommands = extractSection(content, /^## Blocked Commands/i);

  const sections: string[] = [];
  if (absoluteRules) sections.push("## Security Rules\n" + absoluteRules);
  if (blockedPatterns) sections.push("Blocked files: " + blockedPatterns);
  if (blockedCommands) sections.push("Blocked commands: " + blockedCommands);

  return sections.length > 0 ? sections.join("\n") : null;
}

/**
 * Extract voice guide for content tasks.
 */
async function extractVoiceGuide(): Promise<string | null> {
  const content = await safeReadFile(VOICE_GUIDE);
  if (!content) return null;

  // Extract key sections for content creation
  const sections: string[] = [];

  const tone = extractSection(content, /^## Tone/i);
  if (tone) sections.push("## Derek's Tone\n" + truncateToTokens(tone, 100));

  const teaching = extractSection(content, /^## Teaching Style/i);
  if (teaching) sections.push("## Teaching Style\n" + truncateToTokens(teaching, 150));

  const community = extractSection(content, /^## Community Post Style/i);
  if (community) sections.push("## Community Post Style\n" + truncateToTokens(community, 200));

  const patientLang = extractSection(content, /^## Patient-Facing Language Rules/i);
  if (patientLang) sections.push("## Patient-Facing Language\n" + truncateToTokens(patientLang, 150));

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Extract content engine schedule for content tasks.
 */
async function extractContentEngine(): Promise<string | null> {
  const content = await safeReadFile(CONTENT_ENGINE);
  if (!content) return null;

  // Just the first 500 tokens of relevant schedule info
  return truncateToTokens(content, 500);
}

// ============================================================
// TASK CATEGORY DETECTION
// ============================================================

/**
 * Detect task category from prompt keywords.
 */
export function detectTaskCategory(prompt: string): TaskCategory {
  const lower = prompt.toLowerCase();

  // Content tasks
  if (
    lower.includes("content") ||
    lower.includes("skool") ||
    lower.includes("facebook") ||
    lower.includes("newsletter") ||
    lower.includes("youtube") ||
    lower.includes("blog") ||
    lower.includes("post")
  ) {
    return "content";
  }

  // Integration tasks
  if (
    lower.includes("api") ||
    lower.includes("integration") ||
    lower.includes("webhook") ||
    lower.includes("ghl") ||
    lower.includes("google") ||
    lower.includes("meta") ||
    lower.includes("mcp")
  ) {
    return "integration";
  }

  // Bug fixes
  if (
    lower.includes("fix") ||
    lower.includes("bug") ||
    lower.includes("error") ||
    lower.includes("broken") ||
    lower.includes("crash") ||
    lower.includes("fail")
  ) {
    return "bugfix";
  }

  // Feature additions
  if (
    lower.includes("add") ||
    lower.includes("create") ||
    lower.includes("implement") ||
    lower.includes("new") ||
    lower.includes("build")
  ) {
    return "feature";
  }

  // Refactoring
  if (
    lower.includes("refactor") ||
    lower.includes("clean") ||
    lower.includes("reorganize") ||
    lower.includes("simplify") ||
    lower.includes("optimize")
  ) {
    return "refactor";
  }

  return "general";
}

// ============================================================
// MAIN CONTEXT BUILDER
// ============================================================

/**
 * Build a rich context bundle for a code agent.
 * Combines identity, principles, user preferences, and domain knowledge.
 *
 * @param options - Configuration for context building
 * @returns Context bundle with combined string and metadata
 */
export async function buildCodeAgentContext(options: ContextOptions = {}): Promise<ContextBundle> {
  const sources: string[] = [];
  const sections: string[] = [];

  // Detect category if not provided
  const category = options.category || (options.prompt ? detectTaskCategory(options.prompt) : "general");

  // Header
  sections.push("# Code Agent Context");
  sections.push("You are a code agent working on the Atlas project (PV MediSpa AI assistant system).");
  sections.push("");

  // 1. Core identity from CLAUDE.md
  const claudeContext = await extractClaudeContext();
  if (claudeContext) {
    sections.push(claudeContext);
    sources.push("CLAUDE.md");
  }

  // 2. Soul principles (initiative, resourcefulness)
  const soulContext = await extractSoulContext();
  if (soulContext) {
    sections.push(soulContext);
    sources.push("SOUL.md");
  }

  // 3. User preferences
  const userContext = await extractUserContext();
  if (userContext) {
    sections.push(userContext);
    sources.push("USER.md");
  }

  // 4. Security rules (always include condensed version)
  if (options.includeShield !== false) {
    const shieldContext = await extractShieldContext();
    if (shieldContext) {
      sections.push(shieldContext);
      sources.push("SHIELD.md");
    }
  }

  // 5. Task-specific domain knowledge
  if (category === "content") {
    const voiceGuide = await extractVoiceGuide();
    if (voiceGuide) {
      sections.push("# Content Creation Guidelines");
      sections.push(voiceGuide);
      sources.push("voice-guide.md");
    }

    const contentEngine = await extractContentEngine();
    if (contentEngine) {
      sections.push("# Content Schedule");
      sections.push(contentEngine);
      sources.push("content-engine.md");
    }
  }

  // 6. Additional custom context
  if (options.additionalContext) {
    sections.push("# Additional Context");
    sections.push(options.additionalContext);
  }

  // 7. Working directory info
  if (options.cwd) {
    sections.push(`\n# Working Directory\nYou are working in: ${options.cwd}`);
  }

  const context = sections.join("\n\n");
  const estimatedTokens = Math.ceil(context.length / 4);

  return {
    context,
    estimatedTokens,
    sources,
  };
}

/**
 * Build restart context with failure information.
 * Used when restarting a failed code agent with better guidance.
 */
export async function buildRestartContext(options: {
  originalPrompt: string;
  failureReason: string;
  attemptSummary: string;
  toolHistory?: string[];
  avoidPatterns?: string[];
  cwd?: string;
}): Promise<ContextBundle> {
  // Get base context
  const base = await buildCodeAgentContext({
    prompt: options.originalPrompt,
    cwd: options.cwd,
  });

  const restartSection = [
    "# RESTART CONTEXT",
    "This is a RETRY of a previous failed attempt. Learn from what went wrong.",
    "",
    "## What Went Wrong",
    options.failureReason,
    "",
    "## Previous Attempt Summary",
    options.attemptSummary,
  ];

  if (options.toolHistory && options.toolHistory.length > 0) {
    restartSection.push("");
    restartSection.push("## Tool History (last 10 calls)");
    restartSection.push(options.toolHistory.slice(-10).join("\n"));
  }

  if (options.avoidPatterns && options.avoidPatterns.length > 0) {
    restartSection.push("");
    restartSection.push("## Patterns to Avoid");
    for (const pattern of options.avoidPatterns) {
      restartSection.push(`- ${pattern}`);
    }
  }

  restartSection.push("");
  restartSection.push("## Instructions");
  restartSection.push("1. Do NOT repeat the same approach that failed");
  restartSection.push("2. Take a different strategy to accomplish the goal");
  restartSection.push("3. If stuck, explore alternative solutions");

  const context = base.context + "\n\n" + restartSection.join("\n");
  const estimatedTokens = Math.ceil(context.length / 4);

  return {
    context,
    estimatedTokens,
    sources: [...base.sources, "restart-context"],
  };
}

/**
 * Build minimal context for quick tasks (under 1K tokens).
 * Used for simple, well-defined tasks that don't need full context.
 */
export async function buildMinimalContext(prompt: string, cwd?: string): Promise<ContextBundle> {
  const sections = [
    "# Code Agent",
    "You are a code agent for the Atlas project.",
    "",
    "## Key Rules",
    "- Be direct and efficient",
    "- Don't over-engineer",
    "- Stay within the working directory",
    "- Never expose secrets or modify .env files",
  ];

  if (cwd) {
    sections.push(`\nWorking in: ${cwd}`);
  }

  const context = sections.join("\n");

  return {
    context,
    estimatedTokens: Math.ceil(context.length / 4),
    sources: ["minimal"],
  };
}
