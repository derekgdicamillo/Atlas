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
import { tmpdir } from "os";
import { sanitizedEnv, validateSpawnArgs } from "./claude.ts";
import { buildClaudeSpawnArgs } from "./claude-binary.ts";
import { extractFirstAssistantText } from "./prompt-runner.ts";
import { error as logError, warn } from "./logger.ts";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

// Resolve the npm .cmd shim to its underlying claude.exe and spawn directly,
// sidestepping cmd.exe's mis-tokenizing of space-containing paths. This was the
// root cause of the recurring "system cannot find the file specified" crashes
// that silently disabled the entropy probe, twin-predict, and knowledge audit.
// See claude-binary.ts for the full writeup.
function buildSpawnArgs(extraArgs: string[]): string[] {
  return buildClaudeSpawnArgs(CLAUDE_PATH, extraArgs);
}

// Run CLI from a neutral directory so it does NOT load the atlas project's
// CLAUDE.md / rules / skills into the prompt. Each caller passes its own
// --system-prompt; project context is unnecessary and pushes Haiku past
// its 200K token limit as the project grows.
const NEUTRAL_CWD = tmpdir();

// Timeouts per model tier (haiku is fast; opus can take longer for complex prompts)
const CALL_TIMEOUTS: Record<string, number> = {
  haiku: 60_000,   // 60s — classification calls should be fast
  sonnet: 120_000, // 2 min
  opus: 180_000,   // 3 min — prediction generation with Supabase context
};

// Max retries for transient API errors (rate limits, overload)
const MAX_RETRIES = 2;

export interface HaikuMessage {
  system: string;
  userMessage: string;
  maxTokens?: number;
  /** Retained for API compatibility; ignored. The Max-plan CLI handles caching automatically. */
  cacheSystem?: boolean;
  /** Caller identification for error logs (e.g. "reader-gate", "staleness-sentinel"). */
  caller?: string;
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

/**
 * Extract the error message from stdout NDJSON when the CLI exits non-zero.
 * Claude CLI writes errors to stdout as {"type":"result","is_error":true,...},
 * NOT to stderr. Missing this causes empty error messages in logs.
 */
function extractStdoutError(output: string): string {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt.type === "result" && evt.is_error) {
        return String(evt.result || evt.subtype || "");
      }
    } catch { continue; }
  }
  return "";
}

/** True for API errors that are safe to retry (rate limit, overload, 5xx). */
function isRetryable(errorDetail: string): boolean {
  return /rate.limit|overload|529|503|429|temporarily/i.test(errorDetail);
}

async function callModel(model: string, params: HaikuMessage, logTag: string): Promise<HaikuResult> {
  const tag = params.caller ? `${logTag}[${params.caller}]` : logTag;
  const timeoutMs = CALL_TIMEOUTS[model] ?? 60_000;
  validateSpawnArgs([CLAUDE_PATH, "--model", model, "--system-prompt", params.system]);

  const sysChars = params.system.length;
  const usrChars = params.userMessage.length;
  if (sysChars + usrChars > 100_000) {
    warn("haiku-client", `${tag} large prompt: system=${sysChars} user=${usrChars} total=${sysChars + usrChars}`);
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = attempt * 5_000;
      warn("haiku-client", `${tag} retry ${attempt}/${MAX_RETRIES} in ${backoffMs}ms`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    const args = buildSpawnArgs([
      "-p",
      "--model", model,
      "--system-prompt", params.system,
      "--output-format", "stream-json",
      "--verbose",
      "--allowedTools", "",
    ]);

    try {
      const proc = spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: NEUTRAL_CWD,
        env: sanitizedEnv(),
      });

      proc.stdin.write(params.userMessage);
      proc.stdin.end();

      // Kill the process if it exceeds the per-model timeout
      const killTimer = setTimeout(() => {
        try { proc.kill(); } catch {}
      }, timeoutMs);

      let output: string;
      let exitCode: number;
      try {
        output = await new Response(proc.stdout).text();
        exitCode = await proc.exited;
      } finally {
        clearTimeout(killTimer);
      }

      if (exitCode !== 0) {
        // stderr is usually empty — the real error is in stdout NDJSON
        const stderrText = await new Response(proc.stderr).text();
        const stdoutErr = extractStdoutError(output);
        const errorDetail = stderrText.trim() || stdoutErr || `stdout=${output.slice(0, 300)}`;

        if (isRetryable(errorDetail) && attempt < MAX_RETRIES) {
          lastErr = new Error(`${tag} CLI exited ${exitCode} (retryable): ${errorDetail.slice(0, 200)}`);
          warn("haiku-client", String(lastErr));
          continue;
        }

        const sizeInfo = ` [sys=${sysChars} usr=${usrChars}]`;
        throw new Error(`${tag} CLI exited ${exitCode}: ${errorDetail.slice(0, 500)}${sizeInfo}`);
      }

      const text = extractFirstAssistantText(output);
      const usage = extractFinalUsage(output);
      return { text, usage };
    } catch (err) {
      lastErr = err;
      // Only retry on explicit retryable signals; propagate others immediately
      const msg = String(err);
      if (!isRetryable(msg) || attempt >= MAX_RETRIES) {
        logError("haiku-client", `${tag} failed: ${err}`);
        throw err;
      }
    }
  }

  // Exhausted retries
  logError("haiku-client", `${tag} failed after ${MAX_RETRIES + 1} attempts: ${lastErr}`);
  throw lastErr;
}

export async function callHaiku(params: HaikuMessage): Promise<HaikuResult> {
  return callModel("haiku", params, "callHaiku");
}

/** Opus via Max plan CLI (no ANTHROPIC_API_KEY needed — uses ~/.claude/.credentials.json OAuth). */
export async function callOpus(params: HaikuMessage): Promise<HaikuResult> {
  return callModel("opus", params, "callOpus");
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
