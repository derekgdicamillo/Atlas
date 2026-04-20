/**
 * Atlas -- Shared Prompt Runner
 * Extracts the runPrompt pattern from cron.ts for reuse by
 * conversation compression, cron jobs, and future consumers.
 *
 * Switched to --output-format stream-json (NDJSON) on 2026-04-20 so we can
 * extract the FIRST assistant turn's text. The previous json output returned
 * `result` = last turn's text, which got contaminated by the project's Stop
 * hook (behavioral-signal classifier) firing as a phantom second turn on
 * every headless call. That silently replaced blog/content generations with
 * `{"signals": []}` and cost real money per invocation. See commit log.
 */
import { spawn } from "bun";
import { sanitizedEnv, validateSpawnArgs } from "./claude.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

/** Run an ad-hoc prompt via Claude CLI. Returns the first assistant turn's text. */
export async function runPrompt(prompt: string, model?: string): Promise<string> {
  try {
    const args = [
      CLAUDE_PATH,
      "-p",
      "--output-format", "stream-json",
      "--verbose", // required by Claude CLI when using stream-json with -p
    ];
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

    return extractFirstAssistantText(output);
  } catch (error) {
    console.error(`[runPrompt] ERROR: ${error}`);
    return "";
  }
}

/**
 * Parse NDJSON from claude -p --output-format stream-json and return the
 * text from the FIRST assistant message. This is the real reply to our
 * prompt; subsequent assistant messages are hook-triggered turns we want
 * to ignore.
 *
 * Falls back to old json parsing if the output doesn't look like NDJSON.
 */
export function extractFirstAssistantText(output: string): string {
  // Try NDJSON stream-json format first
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    let evt: unknown;
    try { evt = JSON.parse(line); } catch { continue; }
    if (!evt || typeof evt !== "object") continue;
    const e = evt as Record<string, unknown>;
    if (e.type !== "assistant") continue;

    // Message shape: { message: { content: [{type:"text", text:"..."}, ...] } }
    const msg = e.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const t = (block as { text?: string }).text;
        if (typeof t === "string") texts.push(t);
      }
    }
    if (texts.length > 0) return texts.join("").trim();
  }

  // Fallback: maybe it was single-object json output (legacy path)
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      if (typeof p.result === "string") return p.result.trim();
      if (typeof p.text === "string") return p.text.trim();
    }
  } catch {
    // not JSON at all — return raw
  }
  return output.trim();
}
