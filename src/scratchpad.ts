/**
 * Atlas — Swarm Scratchpad
 *
 * File-based shared results store for swarm agents. Each DAG node writes
 * its output to a unique file under data/swarms/{swarmId}/{nodeId}.md.
 * The DAG engine reads upstream outputs and injects them into downstream prompts.
 *
 * Deliberately simple: no Supabase, no locking, no shared mutable state.
 * Each node owns its own file. Only the DAG engine reads across files.
 */

import { readFile, writeFile, mkdir, readdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { info, warn } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const SWARM_DIR = join(PROJECT_DIR, "data", "swarms");

// ============================================================
// WRITE
// ============================================================

/**
 * Write a node's output to the scratchpad.
 * Creates the swarm directory if it doesn't exist.
 */
export async function writeScratchpad(
  swarmId: string,
  nodeId: string,
  content: string,
): Promise<string> {
  const dir = join(SWARM_DIR, swarmId);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const filePath = join(dir, `${nodeId}.md`);
  await writeFile(filePath, content, "utf-8");
  info("scratchpad", `Wrote ${content.length} chars to ${swarmId}/${nodeId}.md`);
  return filePath;
}

// ============================================================
// READ
// ============================================================

/**
 * Read a node's output from the scratchpad.
 * Returns null if the file doesn't exist.
 */
export async function readScratchpad(
  swarmId: string,
  nodeId: string,
): Promise<string | null> {
  const filePath = join(SWARM_DIR, swarmId, `${nodeId}.md`);
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Check if a node has written output to the scratchpad.
 */
export function hasScratchpadOutput(swarmId: string, nodeId: string): boolean {
  return existsSync(join(SWARM_DIR, swarmId, `${nodeId}.md`));
}

/**
 * List all node outputs for a swarm.
 */
export async function listScratchpad(swarmId: string): Promise<string[]> {
  const dir = join(SWARM_DIR, swarmId);
  try {
    const files = await readdir(dir);
    return files.filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""));
  } catch {
    return [];
  }
}

// ============================================================
// CLEANUP
// ============================================================

/**
 * Remove all scratchpad files for a swarm.
 */
export async function cleanScratchpad(swarmId: string): Promise<void> {
  const dir = join(SWARM_DIR, swarmId);
  try {
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
      info("scratchpad", `Cleaned scratchpad for swarm ${swarmId}`);
    }
  } catch (err) {
    warn("scratchpad", `Failed to clean scratchpad for ${swarmId}: ${err}`);
  }
}

/**
 * Clean scratchpads older than maxAge (default 24h).
 */
export async function cleanOldScratchpads(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  let cleaned = 0;
  try {
    if (!existsSync(SWARM_DIR)) return 0;
    const dirs = await readdir(SWARM_DIR);
    const now = Date.now();

    for (const dir of dirs) {
      const dagFile = join(SWARM_DIR, dir, "dag.json");
      try {
        const content = await readFile(dagFile, "utf-8");
        const dag = JSON.parse(content);
        if (dag.status === "completed" || dag.status === "cancelled" || dag.status === "failed") {
          const completedAt = dag.completedAt || dag.createdAt;
          if (now - new Date(completedAt).getTime() > maxAgeMs) {
            await rm(join(SWARM_DIR, dir), { recursive: true, force: true });
            cleaned++;
          }
        }
      } catch {
        // No dag.json or parse error, skip
      }
    }
  } catch (err) {
    warn("scratchpad", `Failed to clean old scratchpads: ${err}`);
  }
  return cleaned;
}
