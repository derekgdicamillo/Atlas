/**
 * Log Manager - Rotation, archival, and retrieval for Atlas logs.
 *
 * On startup: rotates current error.log and out.log into logs/archive/
 * with timestamped filenames. Auto-cleans archives older than 7 days.
 * Provides /logs command for Telegram-based log browsing.
 */

import { readFile, writeFile, mkdir, readdir, unlink, rename, stat, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { info, warn } from "./logger.ts";

const LOGS_DIR = join(import.meta.dir, "..", "logs");
const ARCHIVE_DIR = join(LOGS_DIR, "archive");
const RETENTION_DAYS = 7;

/** Timestamp string for archive filenames: YYYY-MM-DD_HHmmss */
function archiveTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Rotate current logs into archive. Called once at startup BEFORE pm2 starts writing.
 *
 * Since pm2 owns the log files and appends to them, we can't just rename them
 * (pm2 would recreate them immediately). Instead we:
 * 1. Copy current logs to archive
 * 2. Truncate the originals via pm2 flush
 *
 * Actually, since this runs inside the pm2-managed process itself, we just
 * copy the files and let pm2 continue appending. The archive captures everything
 * up to this restart. Next restart captures the next window.
 */
export async function rotateLogs(): Promise<void> {
  try {
    await mkdir(ARCHIVE_DIR, { recursive: true });

    const ts = archiveTimestamp();
    const files = ["error.log", "out.log"];

    for (const file of files) {
      const src = join(LOGS_DIR, file);
      if (!existsSync(src)) continue;

      const stats = await stat(src);
      if (stats.size === 0) continue; // skip empty logs

      const base = file.replace(".log", "");
      const dest = join(ARCHIVE_DIR, `${base}-${ts}.log`);
      await copyFile(src, dest);

      // Truncate the original so the current session starts clean.
      // pm2 still has the file handle open and will continue appending.
      await writeFile(src, "");

      info("log-manager", `Archived ${file} (${(stats.size / 1024).toFixed(1)} KB) -> archive/${base}-${ts}.log`);
    }
  } catch (err) {
    warn("log-manager", `Log rotation failed (non-fatal): ${err}`);
  }
}

/** Delete archives older than RETENTION_DAYS. */
export async function cleanupOldArchives(): Promise<void> {
  try {
    if (!existsSync(ARCHIVE_DIR)) return;

    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const files = await readdir(ARCHIVE_DIR);
    let deleted = 0;

    for (const file of files) {
      const fullPath = join(ARCHIVE_DIR, file);
      const stats = await stat(fullPath);
      if (stats.mtimeMs < cutoff) {
        await unlink(fullPath);
        deleted++;
      }
    }

    if (deleted > 0) {
      info("log-manager", `Cleaned up ${deleted} archived log(s) older than ${RETENTION_DAYS} days`);
    }
  } catch (err) {
    warn("log-manager", `Archive cleanup failed (non-fatal): ${err}`);
  }
}

/** List available archive files with size and date. */
async function listArchives(): Promise<{ name: string; size: number; date: Date }[]> {
  if (!existsSync(ARCHIVE_DIR)) return [];
  const files = await readdir(ARCHIVE_DIR);
  const results: { name: string; size: number; date: Date }[] = [];

  for (const file of files) {
    if (!file.endsWith(".log")) continue;
    const fullPath = join(ARCHIVE_DIR, file);
    const stats = await stat(fullPath);
    results.push({ name: file, size: stats.size, date: stats.mtime });
  }

  return results.sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Read last N lines from a log file. */
async function tailLog(filePath: string, lines: number = 30): Promise<string> {
  if (!existsSync(filePath)) return "(file not found)";
  const content = await readFile(filePath, "utf-8");
  const allLines = content.trim().split("\n");
  const tail = allLines.slice(-lines);
  return tail.join("\n") || "(empty)";
}

/**
 * Handle /logs command from Telegram.
 *
 * /logs           - Show current error log (last 30 lines) + archive list
 * /logs errors    - Last 50 lines of current error log
 * /logs output    - Last 50 lines of current output log
 * /logs <index>   - Show last 50 lines from an archived file (1-indexed from list)
 * /logs clear     - Truncate current logs (manual mid-session reset)
 */
export async function handleLogsCommand(args: string[]): Promise<string> {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === "errors") {
    const count = sub === "errors" ? 50 : 30;
    const errorTail = await tailLog(join(LOGS_DIR, "error.log"), count);
    const archives = await listArchives();
    const archiveList = archives.length > 0
      ? archives.slice(0, 10).map((a, i) =>
          `  ${i + 1}. ${a.name} (${(a.size / 1024).toFixed(1)} KB)`
        ).join("\n")
      : "  (none)";

    return [
      `--- Current Error Log (last ${count} lines) ---`,
      errorTail,
      "",
      `--- Archives (${archives.length} files, ${RETENTION_DAYS}d retention) ---`,
      archiveList,
      "",
      "Usage: /logs errors | /logs output | /logs <#> | /logs clear",
    ].join("\n");
  }

  if (sub === "output" || sub === "out") {
    const outTail = await tailLog(join(LOGS_DIR, "out.log"), 50);
    return `--- Current Output Log (last 50 lines) ---\n${outTail}`;
  }

  if (sub === "clear") {
    try {
      for (const file of ["error.log", "out.log"]) {
        const path = join(LOGS_DIR, file);
        if (existsSync(path)) await writeFile(path, "");
      }
      return "Logs truncated. Current session logs cleared.";
    } catch (err) {
      return `Failed to clear logs: ${err}`;
    }
  }

  // Numeric index: view archived file
  const idx = parseInt(sub, 10);
  if (!isNaN(idx) && idx > 0) {
    const archives = await listArchives();
    if (idx > archives.length) {
      return `Only ${archives.length} archive(s) available. Use /logs to see the list.`;
    }
    const archive = archives[idx - 1];
    const tail = await tailLog(join(ARCHIVE_DIR, archive.name), 50);
    return `--- ${archive.name} (last 50 lines) ---\n${tail}`;
  }

  return "Usage: /logs | /logs errors | /logs output | /logs <#> | /logs clear";
}
