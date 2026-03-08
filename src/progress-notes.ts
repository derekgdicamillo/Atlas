/**
 * Atlas -- Structured Agent Progress Notes
 *
 * Persists incremental progress notes for code agents so that if Atlas
 * restarts (pm2, overnight), a replacement agent can pick up where
 * the dead one left off.
 *
 * Each task gets a JSON file: data/task-progress/{taskId}.json
 * containing an array of ProgressNote entries appended over time.
 */

import { readFile, writeFile, mkdir, rename, readdir, unlink, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { info, warn } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const PROGRESS_DIR = join(PROJECT_DIR, "data", "task-progress");

// TYPES

export type ProgressPhase = "explore" | "implement" | "test" | "complete";

export interface ProgressNote {
  timestamp: string;
  taskId: string;
  phase: ProgressPhase;
  stepsCompleted: number;
  currentStep: string;
  keyFindings: string[];
  filesModified: string[];
  costUsd: number;
}

// HELPERS

async function ensureDir(): Promise<void> {
  if (!existsSync(PROGRESS_DIR)) {
    await mkdir(PROGRESS_DIR, { recursive: true });
  }
}

function notePath(taskId: string): string {
  return join(PROGRESS_DIR, `${taskId}.json`);
}

// WRITE

/** Append a structured progress entry. Uses atomic write (tmp + rename). */
export async function writeProgressNote(taskId: string, note: Omit<ProgressNote, "timestamp" | "taskId">): Promise<void> {
  try {
    await ensureDir();
    const filePath = notePath(taskId);
    let notes: ProgressNote[] = [];

    if (existsSync(filePath)) {
      try {
        const raw = await readFile(filePath, "utf-8");
        notes = JSON.parse(raw);
      } catch {
        warn("progress-notes", `Corrupted notes file for ${taskId}, starting fresh`);
      }
    }

    notes.push({ timestamp: new Date().toISOString(), taskId, ...note });

    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(notes, null, 2));
    await rename(tmpPath, filePath);
  } catch (err) {
    warn("progress-notes", `Failed to write note for ${taskId}: ${err}`);
  }
}

// READ

/** Read all progress notes for a task. Returns empty array if none exist. */
export async function readProgressNotes(taskId: string): Promise<ProgressNote[]> {
  const filePath = notePath(taskId);
  if (!existsSync(filePath)) return [];

  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    warn("progress-notes", `Failed to read notes for ${taskId}: ${err}`);
    return [];
  }
}

// RESUME CONTEXT

/**
 * Build a prompt section from progress notes that can be injected into a
 * restart agent so it knows what the previous agent accomplished.
 */
export async function buildResumeContext(taskId: string): Promise<string | null> {
  const notes = await readProgressNotes(taskId);
  if (notes.length === 0) return null;

  const last = notes[notes.length - 1];

  const allFiles = new Set<string>();
  const allFindings = new Set<string>();
  for (const n of notes) {
    for (const f of n.filesModified) allFiles.add(f);
    for (const f of n.keyFindings) allFindings.add(f);
  }

  const lines: string[] = [
    "# PREVIOUS AGENT PROGRESS",
    "The previous agent worked on this task and made progress before it was terminated.",
    "Resume from where it left off. Do NOT redo completed work.",
    "",
    "## Status at Termination",
    `- Phase: ${last.phase}`,
    `- Steps completed: ${last.stepsCompleted}`,
    `- Last step: ${last.currentStep}`,
    `- Total cost so far: $${last.costUsd.toFixed(4)}`,
    `- Progress entries: ${notes.length}`,
  ];

  if (allFindings.size > 0) {
    lines.push("", "## Key Findings");
    for (const finding of allFindings) lines.push(`- ${finding}`);
  }

  if (allFiles.size > 0) {
    lines.push("", "## Files Already Modified");
    for (const file of allFiles) lines.push(`- ${file}`);
    lines.push("", "Review these files to understand what was already done before making changes.");
  }

  lines.push("", "## Progress Timeline");
  for (const n of notes) {
    const time = new Date(n.timestamp).toLocaleTimeString("en-US", { hour12: false });
    lines.push(`- [${time}] Phase: ${n.phase} | Step ${n.stepsCompleted}: ${n.currentStep}`);
  }

  return lines.join("\n");
}

// CLEANUP

/** Delete progress files older than maxAgeDays. Returns count of files removed. */
export async function cleanupOldNotes(maxAgeDays: number = 7): Promise<number> {
  if (!existsSync(PROGRESS_DIR)) return 0;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    const files = await readdir(PROGRESS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(PROGRESS_DIR, file);
      try {
        const stats = await stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await unlink(filePath);
          cleaned++;
        }
      } catch { /* skip files we can't stat */ }
    }
    if (cleaned > 0) info("progress-notes", `Cleaned up ${cleaned} old progress note files`);
  } catch (err) {
    warn("progress-notes", `Cleanup error: ${err}`);
  }

  return cleaned;
}
