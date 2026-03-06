/**
 * Atlas -- Shared Prompt Runner
 * Extracts the runPrompt pattern from cron.ts for reuse by
 * conversation compression, cron jobs, and future consumers.
 */
import { spawn } from "bun";
import { sanitizedEnv, validateSpawnArgs } from "./claude.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

/** Run an ad-hoc prompt via Claude CLI. Returns the text result. */
export async function runPrompt(prompt: string, model?: string): Promise<string> {
  try {
    const args = [CLAUDE_PATH, "-p", "--output-format", "json"];
    if (model) args.push("--model", model);

    // OpenClaw 2026.2.23: Validate spawn args (reject CR/LF injection on Windows)
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

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return "";

    try {
      const parsed = JSON.parse(output);
      return (parsed.result ?? parsed.text ?? output).trim();
    } catch {
      return output.trim();
    }
  } catch (error) {
    console.error(`[runPrompt] ERROR: ${error}`);
    return "";
  }
}
