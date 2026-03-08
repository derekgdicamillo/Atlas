/**
 * Atlas — Supervisor Mutex Lock
 *
 * File-based advisory lock to prevent concurrent mutations to tasks.json
 * by checkTasks() and runSupervisorWorker() cron jobs.
 * Uses synchronous fs for atomicity. Auto-expires after 30s (deadlock prevention).
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { info } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const LOCK_FILE = join(PROJECT_DIR, "data", "supervisor.lock");
const LOCK_TTL_MS = 30_000;

interface LockData {
  pid: number;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

/** Try to acquire the advisory lock. Returns true if acquired. */
export function acquireLock(holder: string): boolean {
  if (existsSync(LOCK_FILE)) {
    try {
      const existing: LockData = JSON.parse(readFileSync(LOCK_FILE, "utf-8"));
      if (Date.now() < new Date(existing.expiresAt).getTime()) return false;
      info("supervisor-lock", `Expired lock from ${existing.holder}, reclaiming`);
      unlinkSync(LOCK_FILE);
    } catch {
      try { unlinkSync(LOCK_FILE); } catch { /* corrupt, ignore */ }
    }
  }
  const now = new Date();
  const data: LockData = {
    pid: process.pid,
    holder,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LOCK_TTL_MS).toISOString(),
  };
  try {
    writeFileSync(LOCK_FILE, JSON.stringify(data), { flag: "wx" });
    info("supervisor-lock", `Acquired by ${holder}`);
    return true;
  } catch {
    return false; // another holder beat us
  }
}

/** Release the lock, but only if the current holder matches. */
export function releaseLock(holder: string): void {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const data: LockData = JSON.parse(readFileSync(LOCK_FILE, "utf-8"));
    if (data.holder === holder) {
      unlinkSync(LOCK_FILE);
      info("supervisor-lock", `Released by ${holder}`);
    }
  } catch { /* gone or corrupt, nothing to release */ }
}

/** Acquire lock, run fn, release in finally. Returns null if lock unavailable. */
export async function withLock<T>(holder: string, fn: () => Promise<T>): Promise<T | null> {
  if (!acquireLock(holder)) {
    info("supervisor-lock", `Skipped ${holder} (lock held)`);
    return null;
  }
  try {
    return await fn();
  } finally {
    releaseLock(holder);
  }
}
