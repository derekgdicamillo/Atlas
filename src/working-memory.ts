/**
 * Atlas — Cognitive Memory Architecture: Working Memory
 *
 * Five registers with independent update cadences that form the
 * Common Operating Picture (COP). Always injected into Claude's prompt.
 *
 * Registers:
 *   1. Task     — what we're doing right now (every turn, no LLM)
 *   2. User     — mood, focus, corrections (every ~10 turns, Haiku)
 *   3. Environment — system health, agents, crons (every 5 min, no LLM)
 *   4. Plan     — multi-step work tracker (event-driven)
 *   5. Pending  — open questions, delegated tasks (event-driven)
 *
 * Write-ahead pattern: persist BEFORE calling Claude, update AFTER.
 * Dual-write: disk (primary, sync) + Supabase (backup, async).
 */

import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { info, warn } from "./logger.ts";
import {
  CMA_ENABLED,
  CMA_STALE_MS,
  CMA_MAX_DECISIONS,
  CMA_MAX_FILES,
  CMA_MAX_ENTITIES,
  CMA_MAX_OPEN_QUESTIONS,
  CMA_MAX_DELEGATED_TASKS,
  CMA_MAX_PLAN_STEPS,
  CMA_MAX_PROMPT_CHARS,
  CMA_TRUNCATE_LENGTH,
} from "./constants.ts";

// ============================================================
// TYPES
// ============================================================

export interface TaskRegister {
  activeIntent: string;
  lastUserMessage: string;
  lastAssistantAction: string;
  turnCount: number;
  updatedAt: string;
}

export interface UserRegister {
  currentFocus: string;
  mood: string;
  priority: string;
  recentCorrections: string[];
  updatedAt: string;
}

export interface EnvironmentRegister {
  runningAgents: number;
  pendingTasks: string[];
  lastCronHealth: string;
  systemUptime: number;
  activeMode: string | null;
  updatedAt: string;
}

export interface PlanRegister {
  activePlan: string | null;
  completedSteps: string[];
  currentStep: string | null;
  remainingSteps: string[];
  blockers: string[];
  updatedAt: string;
}

export interface DelegatedTask {
  taskId: string;
  description: string;
  delegatedAt: string;
  expectedDuration: string;
}

export interface PendingRegister {
  openQuestions: string[];
  delegatedTasks: DelegatedTask[];
  awaitingExternal: string[];
  updatedAt: string;
}

export interface WorkingMemory {
  version: 1;
  agentId: string;
  userId: string;
  sessionId: string | null;
  task: TaskRegister;
  user: UserRegister;
  environment: EnvironmentRegister;
  plan: PlanRegister;
  pending: PendingRegister;
  createdAt: string;
  totalTurns: number;
}

// ============================================================
// STORAGE
// ============================================================

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const ANCHORS_DIR = join(PROJECT_ROOT, "data", "working-memory");

/** In-memory cache: agentId:userId -> WorkingMemory */
const cache = new Map<string, WorkingMemory>();
let dirCreated = false;

function cacheKey(agentId: string, userId: string): string {
  return `${agentId}:${userId}`;
}

function diskPath(agentId: string, userId: string): string {
  const safe = `${agentId}-${userId}`.replace(/:/g, "-");
  return join(ANCHORS_DIR, `${safe}.json`);
}

async function ensureDir(): Promise<void> {
  if (dirCreated) return;
  await mkdir(ANCHORS_DIR, { recursive: true });
  dirCreated = true;
}

// ============================================================
// FACTORY
// ============================================================

function createEmpty(agentId: string, userId: string, sessionId?: string | null): WorkingMemory {
  const now = new Date().toISOString();
  return {
    version: 1,
    agentId,
    userId,
    sessionId: sessionId ?? null,
    task: {
      activeIntent: "",
      lastUserMessage: "",
      lastAssistantAction: "",
      turnCount: 0,
      updatedAt: now,
    },
    user: {
      currentFocus: "unknown",
      mood: "neutral",
      priority: "",
      recentCorrections: [],
      updatedAt: now,
    },
    environment: {
      runningAgents: 0,
      pendingTasks: [],
      lastCronHealth: "unknown",
      systemUptime: 0,
      activeMode: null,
      updatedAt: now,
    },
    plan: {
      activePlan: null,
      completedSteps: [],
      currentStep: null,
      remainingSteps: [],
      blockers: [],
      updatedAt: now,
    },
    pending: {
      openQuestions: [],
      delegatedTasks: [],
      awaitingExternal: [],
      updatedAt: now,
    },
    createdAt: now,
    totalTurns: 0,
  };
}

// ============================================================
// LOAD / SAVE (dual-write: disk primary, Supabase backup)
// ============================================================

/**
 * Load working memory. Checks in-memory cache first, then disk, then Supabase.
 * Returns null if nothing exists or if stale (older than CMA_STALE_MS).
 */
export async function loadWorkingMemory(
  agentId: string,
  userId: string,
  supabase?: { from: (t: string) => any } | null,
): Promise<WorkingMemory | null> {
  if (!CMA_ENABLED) return null;

  const key = cacheKey(agentId, userId);

  // 1. In-memory cache
  if (cache.has(key)) {
    const wm = cache.get(key)!;
    if (isStale(wm)) {
      cache.delete(key);
      return null;
    }
    return wm;
  }

  // 2. Disk
  try {
    const raw = await readFile(diskPath(agentId, userId), "utf-8");
    const wm: WorkingMemory = JSON.parse(raw);
    if (isStale(wm)) return null;
    cache.set(key, wm);
    return wm;
  } catch { /* file doesn't exist */ }

  // 3. Supabase fallback
  if (supabase) {
    try {
      const { data } = await supabase
        .from("working_memory")
        .select("state")
        .eq("agent_id", agentId)
        .eq("user_id", userId)
        .single();
      if (data?.state) {
        const wm = data.state as WorkingMemory;
        if (isStale(wm)) return null;
        cache.set(key, wm);
        return wm;
      }
    } catch { /* table may not exist yet */ }
  }

  return null;
}

/**
 * Load or create working memory. Always returns a valid WorkingMemory.
 */
export async function loadOrCreate(
  agentId: string,
  userId: string,
  sessionId?: string | null,
  supabase?: { from: (t: string) => any } | null,
): Promise<WorkingMemory> {
  const existing = await loadWorkingMemory(agentId, userId, supabase);
  if (existing) return existing;
  const wm = createEmpty(agentId, userId, sessionId);
  cache.set(cacheKey(agentId, userId), wm);
  return wm;
}

/**
 * Save working memory to disk (atomic write) and Supabase (async).
 */
export async function saveWorkingMemory(
  wm: WorkingMemory,
  supabase?: { from: (t: string) => any } | null,
): Promise<void> {
  if (!CMA_ENABLED) return;

  const key = cacheKey(wm.agentId, wm.userId);
  cache.set(key, wm);

  // Disk: atomic write via temp + rename
  try {
    await ensureDir();
    const path = diskPath(wm.agentId, wm.userId);
    const tmp = path + ".tmp";
    await writeFile(tmp, JSON.stringify(wm, null, 2));
    await rename(tmp, path);
  } catch (err) {
    warn("cma", `Disk write failed: ${err}`);
  }

  // Supabase: async, non-blocking
  if (supabase) {
    supabase
      .from("working_memory")
      .upsert({
        agent_id: wm.agentId,
        user_id: wm.userId,
        session_id: wm.sessionId,
        state: wm,
        updated_at: new Date().toISOString(),
      }, { onConflict: "agent_id,user_id" })
      .then(() => {})
      .catch(() => {});
  }
}

/**
 * Persist ALL cached working memories to disk. Called from gracefulShutdown.
 * Synchronous disk writes to guarantee completion within 5s deadline.
 */
export function persistAllSync(): void {
  if (!CMA_ENABLED) return;
  if (!existsSync(ANCHORS_DIR)) {
    try { require("fs").mkdirSync(ANCHORS_DIR, { recursive: true }); } catch { return; }
  }
  for (const [, wm] of cache) {
    try {
      const path = diskPath(wm.agentId, wm.userId);
      writeFileSync(path, JSON.stringify(wm, null, 2));
    } catch { /* non-fatal */ }
  }
  info("cma", `Persisted ${cache.size} working memory states to disk`);
}

/**
 * Archive working memory to history table, clear current.
 */
export async function archiveWorkingMemory(
  agentId: string,
  userId: string,
  supabase?: { from: (t: string) => any } | null,
): Promise<void> {
  const key = cacheKey(agentId, userId);
  const wm = cache.get(key);
  if (!wm) return;

  // Archive to Supabase history
  if (supabase) {
    const duration = Date.now() - new Date(wm.createdAt).getTime();
    supabase
      .from("working_memory_history")
      .insert({
        agent_id: wm.agentId,
        user_id: wm.userId,
        session_id: wm.sessionId,
        state: wm,
        total_turns: wm.totalTurns,
        session_duration_ms: duration,
      })
      .then(() => {})
      .catch(() => {});
  }

  // Clear
  cache.delete(key);
  try {
    const { unlink } = await import("fs/promises");
    await unlink(diskPath(agentId, userId)).catch(() => {});
  } catch { /* non-fatal */ }

  info("cma", `Archived working memory for ${agentId}:${userId} (${wm.totalTurns} turns)`);
}

// ============================================================
// REGISTER UPDATES
// ============================================================

/** Truncate string to max length. */
function trunc(s: string, max = CMA_TRUNCATE_LENGTH): string {
  return s.length > max ? s.substring(0, max) + "..." : s;
}

/**
 * Update Task Register from a turn. Pure function, no LLM, <1ms.
 * Called EVERY turn.
 */
export function updateTaskFromTurn(
  wm: WorkingMemory,
  userMessage: string,
  assistantResponse: string,
): WorkingMemory {
  const now = new Date().toISOString();

  // Extract file paths from response (common patterns)
  const filePaths = extractFilePaths(assistantResponse);
  const existingFiles = new Set(wm.task.activeIntent ? [] : []); // placeholder

  // Detect tags for plan/pending register updates
  const codeTasks = assistantResponse.match(/\[CODE_TASK:[^\]]+\]/g) || [];
  const tasks = assistantResponse.match(/\[TASK:[^\]]+\]/g) || [];
  const remembers = assistantResponse.match(/\[REMEMBER:[^\]]+\]/g) || [];

  // Update plan register if CODE_TASK or multi-step detected
  const plan = { ...wm.plan };
  if (codeTasks.length > 0 || tasks.length > 0) {
    const descriptions = [...codeTasks, ...tasks].map(t =>
      trunc(t.replace(/\[(CODE_TASK|TASK):\s*/, "").replace(/\]$/, ""), 100)
    );
    if (!plan.activePlan) {
      plan.activePlan = descriptions[0] || null;
    }
    plan.updatedAt = now;
  }

  // Update pending register with delegated tasks
  const pending = { ...wm.pending };
  if (codeTasks.length > 0 || tasks.length > 0) {
    const newDelegated: DelegatedTask[] = [...codeTasks, ...tasks].map(t => ({
      taskId: `t-${Date.now().toString(36)}`,
      description: trunc(t.replace(/\[(CODE_TASK|TASK):\s*/, "").replace(/\]$/, ""), 100),
      delegatedAt: now,
      expectedDuration: codeTasks.length > 0 ? "~30 min" : "~5 min",
    }));
    pending.delegatedTasks = [
      ...newDelegated,
      ...pending.delegatedTasks,
    ].slice(0, CMA_MAX_DELEGATED_TASKS);
    pending.updatedAt = now;
  }

  // Detect questions in response (ends with ?)
  const questions = assistantResponse.match(/[^.!?]*\?/g) || [];
  if (questions.length > 0) {
    const newQs = questions
      .map(q => trunc(q.trim(), 100))
      .filter(q => q.length > 10); // skip trivial
    if (newQs.length > 0) {
      pending.openQuestions = newQs.slice(0, CMA_MAX_OPEN_QUESTIONS);
      pending.updatedAt = now;
    }
  }

  return {
    ...wm,
    task: {
      activeIntent: wm.task.activeIntent, // preserved until deep update
      lastUserMessage: trunc(userMessage),
      lastAssistantAction: trunc(assistantResponse),
      turnCount: wm.task.turnCount + 1,
      updatedAt: now,
    },
    plan,
    pending,
    totalTurns: wm.totalTurns + 1,
  };
}

/**
 * Update Task Register with user message BEFORE calling Claude (write-ahead).
 * Called before every Claude invocation.
 */
export function writeAheadUpdate(wm: WorkingMemory, userMessage: string): WorkingMemory {
  const now = new Date().toISOString();
  return {
    ...wm,
    task: {
      ...wm.task,
      lastUserMessage: trunc(userMessage),
      updatedAt: now,
    },
  };
}

/**
 * Update Environment Register from system state. No LLM, called by cron.
 */
export function updateEnvironment(
  wm: WorkingMemory,
  state: {
    runningAgents: number;
    pendingTasks: string[];
    cronHealth: string;
    uptimeSeconds: number;
    activeMode: string | null;
  },
): WorkingMemory {
  return {
    ...wm,
    environment: {
      runningAgents: state.runningAgents,
      pendingTasks: state.pendingTasks.slice(0, CMA_MAX_DELEGATED_TASKS),
      lastCronHealth: state.cronHealth,
      systemUptime: state.uptimeSeconds,
      activeMode: state.activeMode,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Deep update via Haiku. Updates activeIntent, user register, entities.
 * Called every CMA_DEEP_UPDATE_INTERVAL turns. Fire-and-forget.
 */
export async function deepUpdate(
  wm: WorkingMemory,
  recentConversation: string,
  summarizeFn: (prompt: string) => Promise<string>,
): Promise<WorkingMemory> {
  const prompt = `Extract structured session state from this conversation. Return ONLY valid JSON.

CURRENT STATE:
- Active intent: ${wm.task.activeIntent || "(none)"}
- User mood: ${wm.user.mood}
- User focus: ${wm.user.currentFocus}

RECENT CONVERSATION (last 8 turns):
${recentConversation}

Return JSON with these exact fields:
{
  "activeIntent": "1-2 sentences describing what is being worked on NOW",
  "currentFocus": "strategy|debugging|coding|operations|casual|creative|learning",
  "mood": "engaged|frustrated|rushed|exploratory|neutral|excited",
  "priority": "what the user cares about right now (1 sentence)",
  "corrections": ["any corrections the user made (max 3)"],
  "activePlan": "name of multi-step plan if any, or null",
  "currentStep": "what step we're on, or null",
  "remainingSteps": ["next steps, max 5"],
  "keyEntities": ["important names, files, concepts (max 10)"]
}

Rules:
- If current state has valid info not contradicted by conversation, KEEP it
- Be specific: include file paths, function names, config values
- The next session will have ZERO context except this state`;

  try {
    const raw = await summarizeFn(prompt);
    const parsed = JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim());

    const now = new Date().toISOString();
    return {
      ...wm,
      task: {
        ...wm.task,
        activeIntent: parsed.activeIntent || wm.task.activeIntent,
        updatedAt: now,
      },
      user: {
        currentFocus: parsed.currentFocus || wm.user.currentFocus,
        mood: parsed.mood || wm.user.mood,
        priority: parsed.priority || wm.user.priority,
        recentCorrections: (parsed.corrections || wm.user.recentCorrections).slice(0, 3),
        updatedAt: now,
      },
      plan: {
        activePlan: parsed.activePlan ?? wm.plan.activePlan,
        completedSteps: wm.plan.completedSteps,
        currentStep: parsed.currentStep ?? wm.plan.currentStep,
        remainingSteps: (parsed.remainingSteps || wm.plan.remainingSteps).slice(0, CMA_MAX_PLAN_STEPS),
        blockers: wm.plan.blockers,
        updatedAt: now,
      },
    };
  } catch (err) {
    warn("cma", `Deep update parse failed: ${err}`);
    return wm; // return unchanged on failure
  }
}

// ============================================================
// PROMPT FORMATTING
// ============================================================

/**
 * Format working memory for prompt injection. ~1-3KB output.
 */
export function formatForPrompt(wm: WorkingMemory): string {
  const lines: string[] = [];
  lines.push("=== WORKING MEMORY ===");

  // Task
  const ago = timeAgo(wm.task.updatedAt);
  lines.push(`TASK: ${wm.task.activeIntent || "(no active intent)"}`);
  if (wm.task.lastUserMessage) {
    lines.push(`  Last from user: "${wm.task.lastUserMessage}" (${ago})`);
  }
  if (wm.task.lastAssistantAction) {
    lines.push(`  Last action: ${wm.task.lastAssistantAction}`);
  }
  lines.push(`  Turn ${wm.task.turnCount} of session | Started ${timeAgo(wm.createdAt)}`);

  // User
  if (wm.user.mood !== "neutral" || wm.user.priority) {
    lines.push("");
    lines.push(`USER: ${wm.user.currentFocus} mode, ${wm.user.mood}${wm.user.priority ? `, priority: ${wm.user.priority}` : ""}`);
    if (wm.user.recentCorrections.length > 0) {
      lines.push(`  Corrections: ${wm.user.recentCorrections.join("; ")}`);
    }
  }

  // Environment (only if something notable)
  if (wm.environment.runningAgents > 0 || wm.environment.pendingTasks.length > 0 || wm.environment.activeMode) {
    lines.push("");
    const parts: string[] = [];
    if (wm.environment.runningAgents > 0) parts.push(`${wm.environment.runningAgents} agents running`);
    if (wm.environment.pendingTasks.length > 0) parts.push(`${wm.environment.pendingTasks.length} tasks pending`);
    if (wm.environment.activeMode) parts.push(`mode: ${wm.environment.activeMode}`);
    parts.push(`crons: ${wm.environment.lastCronHealth}`);
    lines.push(`ENV: ${parts.join(" | ")}`);
  }

  // Plan (only if active)
  if (wm.plan.activePlan) {
    lines.push("");
    lines.push(`PLAN: ${wm.plan.activePlan}`);
    if (wm.plan.completedSteps.length > 0) {
      lines.push(`  Done: ${wm.plan.completedSteps.map((s, i) => `[${i + 1}] ${s}`).join(", ")}`);
    }
    if (wm.plan.currentStep) {
      lines.push(`  Current: ${wm.plan.currentStep}`);
    }
    if (wm.plan.remainingSteps.length > 0) {
      lines.push(`  Next: ${wm.plan.remainingSteps.join(", ")}`);
    }
    if (wm.plan.blockers.length > 0) {
      lines.push(`  Blockers: ${wm.plan.blockers.join(", ")}`);
    }
  }

  // Pending (only if something pending)
  if (wm.pending.openQuestions.length > 0 || wm.pending.delegatedTasks.length > 0 || wm.pending.awaitingExternal.length > 0) {
    lines.push("");
    const parts: string[] = [];
    if (wm.pending.openQuestions.length > 0) parts.push(`${wm.pending.openQuestions.length} open questions`);
    if (wm.pending.delegatedTasks.length > 0) parts.push(`${wm.pending.delegatedTasks.length} delegated tasks`);
    if (wm.pending.awaitingExternal.length > 0) parts.push(`${wm.pending.awaitingExternal.length} awaiting external`);
    lines.push(`PENDING: ${parts.join(" | ")}`);
    for (const dt of wm.pending.delegatedTasks) {
      lines.push(`  - ${dt.description} (${timeAgo(dt.delegatedAt)})`);
    }
  }

  lines.push("=== END WORKING MEMORY ===");

  const result = lines.join("\n");
  return result.length > CMA_MAX_PROMPT_CHARS
    ? result.substring(0, CMA_MAX_PROMPT_CHARS) + "\n[truncated]"
    : result;
}

// ============================================================
// HELPERS
// ============================================================

function isStale(wm: WorkingMemory): boolean {
  const updated = new Date(wm.task.updatedAt).getTime();
  return Date.now() - updated > CMA_STALE_MS;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Extract file paths from text (common patterns). */
function extractFilePaths(text: string): string[] {
  const patterns = [
    /(?:src|db|data|scripts|config|memory)\/[\w/.-]+\.\w+/g,     // relative paths
    /\.claude\/[\w/.-]+/g,                                         // .claude paths
    /C:[\\\/][\w\s/\\.-]+\.\w+/g,                                 // absolute Windows paths
  ];
  const paths = new Set<string>();
  for (const pat of patterns) {
    for (const match of text.matchAll(pat)) {
      paths.add(match[0]);
    }
  }
  return [...paths].slice(0, CMA_MAX_FILES);
}

/**
 * Get the in-memory cache (for iteration during shutdown).
 */
export function getCachedMemories(): Map<string, WorkingMemory> {
  return cache;
}
