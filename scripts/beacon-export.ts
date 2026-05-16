#!/usr/bin/env bun
/**
 * Atlas Prime — Beacon Export (Sprint 7)
 *
 * Reads data/atlas-ledger-roots.jsonl, groups by UTC day, writes per-day
 * JSONL + latest.json to a local clone of the atlas-prime-beacon repo.
 * Idempotent — safe to re-run.
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { spawn } from "node:child_process";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const ROOTS_FILE = join(PROJECT_DIR, "data", "atlas-ledger-roots.jsonl");
const BEACON_REPO_DIR = join(PROJECT_DIR, "data", "beacon-repo");

export interface RootRecord {
  ts: string;
  root: string;
  entries: number;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export async function buildPublicFiles(
  roots: RootRecord[],
  outDir: string
): Promise<void> {
  await mkdir(join(outDir, "roots"), { recursive: true });
  const byDay = new Map<string, RootRecord[]>();
  for (const r of roots) {
    const d = dayOf(r.ts);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }
  for (const [day, recs] of byDay.entries()) {
    const path = join(outDir, "roots", `${day}.jsonl`);
    const content = recs
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n";
    await writeFile(path, content, "utf-8");
  }
  const latest = roots.sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (latest) {
    await writeFile(
      join(outDir, "roots", "latest.json"),
      JSON.stringify({ ...latest, day: dayOf(latest.ts) }, null, 2),
      "utf-8"
    );
  }
}

async function gitInWorkdir(
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("git", args, {
      cwd,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (b) => (stdout += b.toString()));
    p.stderr?.on("data", (b) => (stderr += b.toString()));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function commitAndPush(
  workdir: string
): Promise<{ pushed: boolean; reason?: string }> {
  if (!existsSync(join(workdir, ".git"))) {
    return { pushed: false, reason: "not_a_git_repo" };
  }
  await gitInWorkdir(["add", "."], workdir);
  const status = await gitInWorkdir(["status", "--porcelain"], workdir);
  if (!status.stdout.trim()) return { pushed: false, reason: "no_changes" };
  await gitInWorkdir(
    ["commit", "-m", `beacon update ${new Date().toISOString()}`],
    workdir
  );
  const pushResult = await gitInWorkdir(["push", "origin", "HEAD"], workdir);
  if (pushResult.code !== 0) {
    return {
      pushed: false,
      reason: `push_failed: ${pushResult.stderr.slice(0, 200)}`,
    };
  }
  return { pushed: true };
}

async function readRoots(): Promise<RootRecord[]> {
  if (!existsSync(ROOTS_FILE)) return [];
  const raw = await readFile(ROOTS_FILE, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RootRecord);
}

async function main() {
  const roots = await readRoots();
  if (roots.length === 0) {
    console.log("[beacon-export] no roots to publish");
    return;
  }
  if (!existsSync(BEACON_REPO_DIR)) {
    console.log(
      `[beacon-export] beacon-repo not initialized at ${BEACON_REPO_DIR}`
    );
    console.log(
      "[beacon-export] init: git clone https://github.com/<owner>/" +
        (process.env.BEACON_PUBLIC_REPO ?? "atlas-prime-beacon") +
        ".git " +
        BEACON_REPO_DIR
    );
    return;
  }
  await buildPublicFiles(roots, BEACON_REPO_DIR);
  const r = await commitAndPush(BEACON_REPO_DIR);
  console.log(`[beacon-export] push=${r.pushed} reason=${r.reason ?? "ok"}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[beacon-export] failed: ${err}`);
    process.exit(1);
  });
}
