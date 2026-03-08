/**
 * Atlas — Night Shift
 *
 * Autonomous overnight work system. A cheap model (Haiku) reviews the day's
 * activity and generates a prioritized task queue. A worker then processes
 * tasks using appropriate models, with budget caps and diminishing returns
 * detection.
 *
 * Schedule:
 *   10:00 PM — Planner generates queue (Haiku, ~$0.03)
 *   10:15 PM — Worker processes queue (model varies, budget-capped)
 *   6:00 AM  — Morning brief includes Night Shift report
 *
 * Cost controls:
 *   - Max $5/night total
 *   - Max $2/task
 *   - Max 5 tasks/night
 *   - Stop after 2 consecutive low-value outputs
 */

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { runPrompt } from "./prompt-runner.ts";
import { MODELS, type ModelTier } from "./constants.ts";
import { info, warn, error as logError } from "./logger.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const MEMORY_DIR = join(PROJECT_DIR, "memory");
const QUEUE_FILE = join(DATA_DIR, "night-shift-queue.json");
const HISTORY_FILE = join(DATA_DIR, "night-shift-history.json");
const LEARNING_QUEUE_FILE = join(DATA_DIR, "learning-queue.json");
const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";

// Budget controls
const MAX_NIGHTLY_SPEND = parseFloat(process.env.NIGHT_SHIFT_MAX_SPEND || "5.00");
const MAX_TASK_SPEND = parseFloat(process.env.NIGHT_SHIFT_MAX_TASK_SPEND || "2.00");
const MAX_TASKS_PER_NIGHT = parseInt(process.env.NIGHT_SHIFT_MAX_TASKS || "5", 10);
const DIMINISHING_RETURNS_THRESHOLD = 2; // stop after N consecutive low-value outputs

// ============================================================
// TYPES
// ============================================================

export type NightShiftTaskType = "research" | "analysis" | "content" | "learning" | "self-improvement";

export interface NightShiftTask {
  id: string;
  priority: 1 | 2 | 3;
  type: NightShiftTaskType;
  title: string;
  prompt: string;
  model: ModelTier;
  estimatedCost: number;
  estimatedValue: "high" | "medium" | "low";
  source: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  output?: string;
  actualCost?: number;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

interface NightShiftQueue {
  date: string;
  plannedAt: string;
  tasks: NightShiftTask[];
  totalSpent: number;
  workerStartedAt?: string;
  workerCompletedAt?: string;
}

interface NightShiftHistoryEntry {
  date: string;
  tasksPlanned: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksSkipped: number;
  totalSpent: number;
  highlights: string[];
}

// ============================================================
// PERSISTENCE
// ============================================================

async function ensureDataDir(): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}

async function loadQueue(): Promise<NightShiftQueue | null> {
  try {
    if (!existsSync(QUEUE_FILE)) return null;
    const raw = await readFile(QUEUE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveQueue(queue: NightShiftQueue): Promise<void> {
  await ensureDataDir();
  await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

async function appendHistory(entry: NightShiftHistoryEntry): Promise<void> {
  let history: NightShiftHistoryEntry[] = [];
  try {
    if (existsSync(HISTORY_FILE)) {
      history = JSON.parse(await readFile(HISTORY_FILE, "utf-8"));
    }
  } catch {}
  history.push(entry);
  // Keep last 90 days
  if (history.length > 90) history = history.slice(-90);
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ============================================================
// CONTEXT GATHERING (for the Planner)
// ============================================================

function getTodayDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

/** Get today's journal content (what happened today) */
function getJournalContext(): string {
  const date = getTodayDate();
  const journalPath = join(MEMORY_DIR, `${date}.md`);
  try {
    if (existsSync(journalPath)) {
      const content = readFileSync(journalPath, "utf-8");
      // Last 2000 chars to keep prompt size reasonable
      return content.length > 2000 ? "..." + content.slice(-2000) : content;
    }
  } catch {}
  return "(no journal entries today)";
}

/** Get pending items from learning queue */
function getLearningQueueContext(): string {
  try {
    if (!existsSync(LEARNING_QUEUE_FILE)) return "(empty)";
    const items = JSON.parse(readFileSync(LEARNING_QUEUE_FILE, "utf-8"));
    const pending = items.filter((i: any) => i.status === "pending");
    if (pending.length === 0) return "(empty)";
    return pending
      .slice(0, 10)
      .map((i: any) => `- [${i.priority}] ${i.topic} (source: ${i.source})`)
      .join("\n");
  } catch {
    return "(empty)";
  }
}

/** Get recent task output filenames to avoid duplicate work */
function getRecentOutputs(): string {
  const outputDir = join(DATA_DIR, "task-output");
  try {
    if (!existsSync(outputDir)) return "(none)";
    const files = readdirSync(outputDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .slice(-20);
    return files.join(", ") || "(none)";
  } catch {
    return "(none)";
  }
}

/** Get goals from memory */
function getGoalsContext(): string {
  const goalsPath = join(MEMORY_DIR, "goals.md");
  try {
    if (existsSync(goalsPath)) {
      const content = readFileSync(goalsPath, "utf-8");
      return content.length > 1000 ? content.slice(0, 1000) + "..." : content;
    }
  } catch {}
  return "(no goals file)";
}

/** Get night shift history for pattern awareness */
async function getHistoryContext(): Promise<string> {
  try {
    if (!existsSync(HISTORY_FILE)) return "(first night)";
    const history: NightShiftHistoryEntry[] = JSON.parse(await readFile(HISTORY_FILE, "utf-8"));
    const recent = history.slice(-7);
    if (recent.length === 0) return "(no recent history)";
    return recent
      .map((h) => `${h.date}: ${h.tasksCompleted}/${h.tasksPlanned} done, $${h.totalSpent.toFixed(2)} spent. ${h.highlights.join("; ")}`)
      .join("\n");
  } catch {
    return "(no history)";
  }
}

// ============================================================
// PLANNER (Haiku, ~$0.03)
// ============================================================

export async function runNightShiftPlanner(): Promise<NightShiftQueue> {
  const date = getTodayDate();
  info("night-shift", `Planner starting for ${date}`);

  const journal = getJournalContext();
  const learningQueue = getLearningQueueContext();
  const recentOutputs = getRecentOutputs();
  const goals = getGoalsContext();
  const history = await getHistoryContext();

  const prompt = `You are the Night Shift Planner for Atlas, a business AI assistant for PV MediSpa & Weight Loss clinic.

Your job: Review today's activity and generate a prioritized list of overnight tasks that will make Derek's morning more productive.

## Context
**Date**: ${date}
**Today's Journal**:
${journal}

**Learning Queue** (knowledge gaps detected during conversations):
${learningQueue}

**Active Goals**:
${goals}

**Recent Research Outputs** (avoid duplicating):
${recentOutputs}

**Last 7 Nights**:
${history}

## Task Types Available
- **research**: Deep research on a topic (Sonnet, $0.50-1.50)
- **analysis**: Analyze business data, metrics, trends (Sonnet, $0.30-0.80)
- **content**: Draft content pieces for review (Sonnet, $0.30-0.50)
- **learning**: Research a knowledge gap from the learning queue (Sonnet, $0.50-1.00)
- **self-improvement**: Atlas system improvements, documentation, skill creation (Sonnet, $0.30-0.80)

## Rules
- Generate 1-5 tasks, ordered by priority (1=highest)
- Only generate tasks that produce ACTIONABLE output Derek can use
- Avoid duplicating recent research outputs
- Each task needs a clear, detailed prompt (the worker will use it verbatim)
- Prefer learning queue items (Derek explicitly wanted these researched)
- If nothing meaningful needs doing tonight, return an empty list. Don't waste tokens.
- Tasks should be completable in under 10 minutes each
- Business context: med spa, GLP-1 weight loss, functional medicine, Prescott Valley AZ

## Output Format
Return ONLY valid JSON (no markdown fences):
{"tasks":[{"priority":1,"type":"research","title":"Short title","prompt":"Detailed instructions for the worker agent","model":"sonnet","estimatedCost":0.75,"estimatedValue":"high","source":"journal|learning-queue|goal|metric|industry"}]}

If nothing needs doing: {"tasks":[]}`;

  const result = await runPrompt(prompt, MODELS.haiku);

  let tasks: NightShiftTask[] = [];
  try {
    const parsed = JSON.parse(result.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
    tasks = (parsed.tasks || []).slice(0, MAX_TASKS_PER_NIGHT).map((t: any, i: number) => ({
      id: `ns-${date}-${i}`,
      priority: t.priority || (i + 1),
      type: t.type || "research",
      title: t.title || "Untitled task",
      prompt: t.prompt || "",
      model: (t.model as ModelTier) || "sonnet",
      estimatedCost: t.estimatedCost || 0.50,
      estimatedValue: t.estimatedValue || "medium",
      source: t.source || "planner",
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    }));
  } catch (err) {
    warn("night-shift", `Planner output parse failed: ${err}`);
  }

  // Filter out tasks that exceed per-task budget
  tasks = tasks.filter((t) => t.estimatedCost <= MAX_TASK_SPEND);

  const queue: NightShiftQueue = {
    date,
    plannedAt: new Date().toISOString(),
    tasks,
    totalSpent: 0,
  };

  await saveQueue(queue);
  info("night-shift", `Planner generated ${tasks.length} tasks for tonight`);
  return queue;
}

// ============================================================
// WORKER (processes queue, budget-capped)
// ============================================================

export async function runNightShiftWorker(): Promise<{
  completed: number;
  failed: number;
  skipped: number;
  totalSpent: number;
  highlights: string[];
}> {
  const queue = await loadQueue();
  if (!queue || queue.tasks.length === 0) {
    info("night-shift", "Worker: no tasks in queue");
    return { completed: 0, failed: 0, skipped: 0, totalSpent: 0, highlights: [] };
  }

  // Skip if already ran tonight
  if (queue.workerCompletedAt) {
    info("night-shift", "Worker: already completed tonight");
    return { completed: 0, failed: 0, skipped: 0, totalSpent: 0, highlights: [] };
  }

  queue.workerStartedAt = new Date().toISOString();
  info("night-shift", `Worker starting: ${queue.tasks.length} tasks, budget $${MAX_NIGHTLY_SPEND}`);

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let consecutiveLowValue = 0;
  const highlights: string[] = [];

  // Sort by priority
  const sorted = [...queue.tasks].sort((a, b) => a.priority - b.priority);

  for (const task of sorted) {
    // Budget check
    if (queue.totalSpent >= MAX_NIGHTLY_SPEND) {
      task.status = "skipped";
      task.error = "Nightly budget exceeded";
      skipped++;
      continue;
    }

    // Diminishing returns check
    if (consecutiveLowValue >= DIMINISHING_RETURNS_THRESHOLD) {
      task.status = "skipped";
      task.error = "Diminishing returns threshold reached";
      skipped++;
      continue;
    }

    // Skip low-value tasks if budget is getting tight
    const remaining = MAX_NIGHTLY_SPEND - queue.totalSpent;
    if (task.estimatedValue === "low" && remaining < MAX_NIGHTLY_SPEND * 0.3) {
      task.status = "skipped";
      task.error = "Low-value task skipped (budget tight)";
      skipped++;
      consecutiveLowValue++;
      continue;
    }

    // Execute the task
    task.status = "running";
    await saveQueue(queue);

    try {
      info("night-shift", `Executing: [${task.type}] ${task.title} (${task.model}, ~$${task.estimatedCost})`);

      const outputFilename = `ns-${queue.date}-${task.type}-${task.id.split("-").pop()}.md`;
      const outputPath = join(DATA_DIR, "task-output", outputFilename);

      const workerPrompt = `You are a Night Shift worker for Atlas (PV MediSpa AI assistant). Complete this task and write a thorough, actionable output.

## Task: ${task.title}
## Type: ${task.type}

${task.prompt}

## Output Rules
- Be thorough but concise. Derek will review this in the morning.
- Include actionable recommendations, not just information.
- If research: cite sources, include dates, note what's uncertain.
- If analysis: include specific numbers, comparisons, and recommendations.
- If content: write draft-ready content that can be reviewed and posted.
- End with a "## Key Takeaways" section (3-5 bullets).`;

      const result = await runPrompt(workerPrompt, MODELS[task.model]);

      if (result && result.length > 50) {
        // Save output
        const outputDir = join(DATA_DIR, "task-output");
        if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });
        const header = `# Night Shift: ${task.title}\n*Generated: ${new Date().toISOString()}*\n*Type: ${task.type} | Model: ${task.model}*\n\n---\n\n`;
        await writeFile(outputPath, header + result);

        task.status = "completed";
        task.output = outputPath;
        task.completedAt = new Date().toISOString();
        // Rough cost estimate based on model
        task.actualCost = task.model === "opus" ? 2.00 : task.model === "sonnet" ? 0.75 : 0.10;
        queue.totalSpent += task.actualCost;
        completed++;
        consecutiveLowValue = 0;
        highlights.push(task.title);

        info("night-shift", `Completed: ${task.title} -> ${outputFilename} (~$${task.actualCost.toFixed(2)})`);
      } else {
        task.status = "failed";
        task.error = "Empty or too-short response";
        task.completedAt = new Date().toISOString();
        task.actualCost = 0.10; // still costs something
        queue.totalSpent += task.actualCost;
        failed++;
        consecutiveLowValue++;
        warn("night-shift", `Failed (empty output): ${task.title}`);
      }
    } catch (err) {
      task.status = "failed";
      task.error = String(err).substring(0, 200);
      task.completedAt = new Date().toISOString();
      task.actualCost = 0.05;
      queue.totalSpent += task.actualCost;
      failed++;
      consecutiveLowValue++;
      logError("night-shift", `Task error: ${task.title}: ${err}`);
    }

    await saveQueue(queue);
  }

  queue.workerCompletedAt = new Date().toISOString();
  await saveQueue(queue);

  // Record history
  await appendHistory({
    date: queue.date,
    tasksPlanned: queue.tasks.length,
    tasksCompleted: completed,
    tasksFailed: failed,
    tasksSkipped: skipped,
    totalSpent: queue.totalSpent,
    highlights,
  });

  info("night-shift", `Worker done: ${completed} completed, ${failed} failed, ${skipped} skipped. $${queue.totalSpent.toFixed(2)} spent.`);

  return { completed, failed, skipped, totalSpent: queue.totalSpent, highlights };
}

// ============================================================
// MORNING REPORT (included in morning brief)
// ============================================================

export async function getNightShiftReport(): Promise<string | null> {
  const queue = await loadQueue();
  if (!queue || !queue.workerCompletedAt) return null;

  // Only report for last night (not stale data)
  const today = getTodayDate();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString("en-CA", { timeZone: TIMEZONE });

  if (queue.date !== today && queue.date !== yesterdayStr) return null;

  const completed = queue.tasks.filter((t) => t.status === "completed");
  const failed = queue.tasks.filter((t) => t.status === "failed");

  if (completed.length === 0 && failed.length === 0) return null;

  const lines = [`**Night Shift Report** (${queue.date})`];

  if (completed.length > 0) {
    lines.push(`${completed.length} task${completed.length > 1 ? "s" : ""} completed ($${queue.totalSpent.toFixed(2)}):`);
    for (const t of completed) {
      const filename = t.output ? t.output.split(/[/\\]/).pop() : "unknown";
      lines.push(`  - ${t.title} -> \`${filename}\``);
    }
  }

  if (failed.length > 0) {
    lines.push(`${failed.length} failed: ${failed.map((t) => t.title).join(", ")}`);
  }

  return lines.join("\n");
}

// ============================================================
// LEARNING QUEUE MANAGEMENT
// ============================================================

export interface LearningQueueItem {
  id: string;
  topic: string;
  source: string;
  priority: 1 | 2 | 3;
  depth: "quick" | "moderate" | "deep";
  output?: string;
  status: "pending" | "completed" | "skipped";
  addedAt: string;
  completedAt?: string;
}

export async function addToLearningQueue(
  topic: string,
  source: string,
  priority: 1 | 2 | 3 = 2,
  depth: "quick" | "moderate" | "deep" = "moderate"
): Promise<void> {
  await ensureDataDir();
  let items: LearningQueueItem[] = [];
  try {
    if (existsSync(LEARNING_QUEUE_FILE)) {
      items = JSON.parse(await readFile(LEARNING_QUEUE_FILE, "utf-8"));
    }
  } catch {}

  // Dedup: skip if similar topic already pending
  const lowerTopic = topic.toLowerCase();
  const duplicate = items.find(
    (i) => i.status === "pending" && i.topic.toLowerCase().includes(lowerTopic.substring(0, 30))
  );
  if (duplicate) {
    info("night-shift", `Learning queue dedup: "${topic}" already pending`);
    return;
  }

  items.push({
    id: `lq-${Date.now()}`,
    topic,
    source,
    priority,
    depth,
    status: "pending",
    addedAt: new Date().toISOString(),
  });

  // Keep max 50 pending items
  const pending = items.filter((i) => i.status === "pending");
  if (pending.length > 50) {
    // Remove oldest low-priority items
    const toRemove = pending
      .sort((a, b) => b.priority - a.priority || new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime())
      .slice(50);
    const removeIds = new Set(toRemove.map((i) => i.id));
    items = items.filter((i) => !removeIds.has(i.id));
  }

  await writeFile(LEARNING_QUEUE_FILE, JSON.stringify(items, null, 2));
  info("night-shift", `Added to learning queue: "${topic}" (priority=${priority}, depth=${depth})`);
}

export async function markLearningItemCompleted(id: string, output?: string): Promise<void> {
  try {
    if (!existsSync(LEARNING_QUEUE_FILE)) return;
    const items: LearningQueueItem[] = JSON.parse(await readFile(LEARNING_QUEUE_FILE, "utf-8"));
    const item = items.find((i) => i.id === id);
    if (item) {
      item.status = "completed";
      item.completedAt = new Date().toISOString();
      if (output) item.output = output;
      await writeFile(LEARNING_QUEUE_FILE, JSON.stringify(items, null, 2));
    }
  } catch {}
}

export async function getLearningQueueStats(): Promise<{ pending: number; completed: number; topics: string[] }> {
  try {
    if (!existsSync(LEARNING_QUEUE_FILE)) return { pending: 0, completed: 0, topics: [] };
    const items: LearningQueueItem[] = JSON.parse(await readFile(LEARNING_QUEUE_FILE, "utf-8"));
    const pending = items.filter((i) => i.status === "pending");
    const completed = items.filter((i) => i.status === "completed");
    return {
      pending: pending.length,
      completed: completed.length,
      topics: pending.slice(0, 5).map((i) => i.topic),
    };
  } catch {
    return { pending: 0, completed: 0, topics: [] };
  }
}
