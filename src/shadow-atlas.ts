/**
 * Atlas Prime — Shadow-Atlas process (Sprint 7)
 *
 * Cold-context shadow of primary Atlas. Reads only the static CLAUDE.md +
 * personality files + a memory-snapshot synced every 4 hours. Responds to
 * IPC requests with a Sonnet-generated text reply, no tools, no MCP.
 *
 * Run as its own Bun process:
 *   bun src/shadow-atlas.ts
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createServer, type Socket } from "net";
import { spawn } from "bun";
import { sanitizedEnv, validateSpawnArgs } from "./claude.ts";
import { buildClaudeSpawnArgs } from "./claude-binary.ts";
import { extractFirstAssistantText } from "./prompt-runner.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const SHADOW_DIR = join(PROJECT_DIR, "data", "shadow-atlas");
const SNAPSHOT_FILE = join(SHADOW_DIR, "memory-snapshot.jsonl");
/** Cold context written to disk and passed to claude via --system-prompt-file.
 *  The full personality stack (~37KB) exceeds Windows's ~32KB CLI arg limit,
 *  so we cannot use --system-prompt directly. */
const SYSTEM_PROMPT_FILE = join(SHADOW_DIR, "cold-system-prompt.txt");
const SOCKET_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\shadow-atlas"
  : join(SHADOW_DIR, "shadow.sock");

let coldSystemPath: string | null = null;

/** Strip CR so the assembled system prompt is LF-only.
 *  Windows checkouts use CRLF line endings; src/claude.ts:validateSpawnArgs
 *  rejects any arg containing \r as a potential injection vector. */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** Assemble the cold context once, write to disk, and return the path. */
async function loadColdContextPath(): Promise<string> {
  if (coldSystemPath) return coldSystemPath;
  await mkdir(SHADOW_DIR, { recursive: true });
  const parts: string[] = [];
  for (const f of ["CLAUDE.md", "SOUL.md", "IDENTITY.md", "USER.md", "SHIELD.md", "TOOLS.md", "GOOGLE.md"]) {
    const p = join(PROJECT_DIR, f);
    if (existsSync(p)) parts.push(normalizeNewlines(await readFile(p, "utf-8")));
  }
  if (existsSync(SNAPSHOT_FILE)) {
    parts.push("## Memory snapshot (frozen at last shadow sync)");
    parts.push(normalizeNewlines(await readFile(SNAPSHOT_FILE, "utf-8")));
  }
  const assembled = parts.join("\n\n---\n\n");
  await writeFile(SYSTEM_PROMPT_FILE, assembled, "utf-8");
  coldSystemPath = SYSTEM_PROMPT_FILE;
  return coldSystemPath;
}

async function shadowRespond(prompt: string, budgetMs: number): Promise<{ text: string }> {
  const systemPath = await loadColdContextPath();
  const args = buildClaudeSpawnArgs(process.env.CLAUDE_PATH || "claude", [
    "-p",
    "--model", process.env.SHADOW_ATLAS_MODEL || "sonnet",
    "--system-prompt-file", systemPath,
    "--output-format", "stream-json",
    "--verbose",
    "--allowedTools", "",
  ]);
  validateSpawnArgs(args);
  const proc = spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_DIR,
    env: sanitizedEnv(),
  });
  proc.stdin.write(prompt);
  proc.stdin.end();

  const timer = setTimeout(() => {
    try { proc.kill(); } catch {}
  }, budgetMs);
  try {
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (exitCode !== 0) {
      throw new Error(`shadow-atlas exited ${exitCode}`);
    }
    return { text: extractFirstAssistantText(output) };
  } finally {
    clearTimeout(timer);
  }
}

interface IPCRequest {
  id: string;
  prompt: string;
  budgetMs?: number;
  /** When true, skip claude spawn and return a synthetic 'pong' immediately.
   *  Used by the watchdog cron to verify process liveness cheaply. */
  ping?: boolean;
}
interface IPCResponse {
  id: string;
  text?: string;
  error?: string;
}

function handleConnection(socket: Socket): void {
  let buffer = "";
  socket.on("data", async (chunk) => {
    buffer += chunk.toString("utf-8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let req: IPCRequest;
      try {
        req = JSON.parse(line);
      } catch (err) {
        const out: IPCResponse = { id: "?", error: `parse: ${err}` };
        socket.write(JSON.stringify(out) + "\n");
        continue;
      }
      if (req.ping) {
        // Cheap liveness check — bypass claude spawn entirely.
        const out: IPCResponse = { id: req.id, text: "pong" };
        socket.write(JSON.stringify(out) + "\n");
        continue;
      }
      try {
        const res = await shadowRespond(req.prompt, req.budgetMs ?? 90_000);
        const out: IPCResponse = { id: req.id, text: res.text };
        socket.write(JSON.stringify(out) + "\n");
      } catch (err) {
        const out: IPCResponse = { id: req.id, error: String(err) };
        socket.write(JSON.stringify(out) + "\n");
      }
    }
  });
  socket.on("error", () => {});
}

export async function startShadowServer(): Promise<void> {
  if (process.platform !== "win32" && existsSync(SOCKET_PATH)) {
    const { unlinkSync } = await import("fs");
    try { unlinkSync(SOCKET_PATH); } catch {}
  }
  const server = createServer(handleConnection);
  await new Promise<void>((resolve, reject) => {
    server.listen(SOCKET_PATH, () => resolve());
    server.on("error", reject);
  });
  console.log(`[shadow-atlas] listening at ${SOCKET_PATH}`);
}

if (import.meta.main) {
  if (process.env.SHADOW_ATLAS_ENABLED === "false") {
    console.log("[shadow-atlas] disabled via SHADOW_ATLAS_ENABLED=false — running as no-op heartbeat");
    // Keep the process alive without binding the named pipe, so PM2 doesn't
    // restart-spam (max_restarts: 5 in ecosystem.config.cjs would otherwise eventually
    // give up and report "crashed"). Re-enable: flip the env var to "true" and
    // `pm2 restart shadow-atlas`. Tier 1 Fix #05B.
    setInterval(() => {}, 60_000);
  } else {
    startShadowServer().catch((err) => {
      console.error(`[shadow-atlas] failed to start: ${err}`);
      process.exit(1);
    });
  }
}
