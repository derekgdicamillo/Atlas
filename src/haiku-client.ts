/**
 * Atlas Prime — Fast Haiku Client (Max-plan path)
 *
 * Wraps `claude -p --model haiku` so all classifier calls go through Derek's
 * Max plan OAuth instead of a separate ANTHROPIC_API_KEY. Same interface as
 * the previous SDK-backed version so consumers don't need changes.
 *
 * Trade-off vs SDK: ~3-4s of CLI startup overhead per call. Acceptable for
 * cron-spaced work (ingest, content critic, memory rewrite, replay judge).
 * The 1h prompt cache absorbs most of the system-prompt cost on subsequent
 * calls within the hour.
 */
import { spawn } from "bun";
import { sanitizedEnv, validateSpawnArgs } from "./claude.ts";
import { extractFirstAssistantText } from "./prompt-runner.ts";
import { error as logError } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

export interface HaikuMessage {
  system: string;
  userMessage: string;
  maxTokens?: number;
  /** Retained for API compatibility; ignored. The Max-plan CLI handles caching automatically. */
  cacheSystem?: boolean;
}

export interface HaikuResult {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export async function callHaiku(params: HaikuMessage): Promise<HaikuResult> {
  const args = [
    CLAUDE_PATH,
    "-p",
    "--model", "haiku",
    "--system-prompt", params.system,
    "--output-format", "stream-json",
    "--verbose",
    "--allowedTools", "",
  ];
  validateSpawnArgs(args);

  try {
    const proc = spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR,
      env: sanitizedEnv(),
    });

    proc.stdin.write(params.userMessage);
    proc.stdin.end();

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`callHaiku CLI exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    const text = extractFirstAssistantText(output);
    const usage = extractFinalUsage(output);
    return { text, usage };
  } catch (err) {
    logError("haiku-client", `callHaiku failed: ${err}`);
    throw err;
  }
}

function extractFinalUsage(output: string): HaikuResult["usage"] {
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    let evt: unknown;
    try { evt = JSON.parse(lines[i]); } catch { continue; }
    if (!evt || typeof evt !== "object") continue;
    const e = evt as Record<string, unknown>;
    if (e.type !== "result") continue;
    const u = e.usage as Record<string, unknown> | undefined;
    if (!u) continue;
    return {
      input_tokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
      output_tokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
      cache_read_input_tokens:
        typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined,
      cache_creation_input_tokens:
        typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined,
    };
  }
  return { input_tokens: 0, output_tokens: 0 };
}
