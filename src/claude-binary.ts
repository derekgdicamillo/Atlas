/**
 * Claude CLI binary resolution (Windows-safe).
 *
 * Standalone (no heavy imports) so it can be unit-tested in isolation and
 * shared by both claude.ts (relay/persistent pool) and haiku-client.ts
 * (cron classifiers) without the two drifting apart.
 *
 * THE BUG THIS FIXES:
 *   npm installs `claude` on Windows as a `.cmd` shim. When CLAUDE_PATH points
 *   at that shim AND the path contains spaces — e.g.
 *     C:\Users\Derek DiCamillo\AppData\Roaming\npm\claude.cmd
 *   — passing it bare to `cmd /c <path> <args>` makes cmd.exe split the path on
 *   the first space and try to run `C:\Users\Derek` as the command. Result:
 *   "The system cannot find the file specified" / "is not recognized", exit 1.
 *   This silently took out the entropy probe, twin-predict-morning, and the
 *   weekly knowledge audit (all fan out concurrent callHaiku calls).
 *
 * THE FIX:
 *   The `.cmd` shim just forwards `%*` to a real `claude.exe` living at
 *   <dir>/node_modules/@anthropic-ai/claude-code/bin/claude.exe. Resolve to
 *   that exe and spawn it directly — Bun quotes argv correctly for
 *   CreateProcess, so spaces in the path are no longer a problem and cmd.exe is
 *   never involved. Falls back to the original path if the exe isn't found.
 */
import { join, dirname } from "path";
import { existsSync } from "fs";

/**
 * Resolve a CLAUDE_PATH to a spawn-safe binary. On Windows, a `.cmd` npm shim
 * is mapped to its underlying `claude.exe` when present; otherwise the input is
 * returned unchanged.
 */
export function resolveClaudeBinary(claudePath: string): string {
  if (process.platform === "win32" && claudePath.toLowerCase().endsWith(".cmd")) {
    const exe = join(
      dirname(claudePath),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    if (existsSync(exe)) return exe;
  }
  return claudePath;
}

/**
 * Build the argv for spawning the Claude CLI with the given trailing args.
 * Prefers a direct `.exe` spawn (no cmd.exe). Only when we cannot resolve a
 * real exe and are left holding a `.cmd` on Windows do we wrap in `cmd /c`
 * (legacy fallback; mis-tokenizes space paths, but better than failing outright
 * on installs that lack the bundled exe).
 */
export function buildClaudeSpawnArgs(claudePath: string, extraArgs: string[]): string[] {
  const bin = resolveClaudeBinary(claudePath);
  if (process.platform === "win32" && bin.toLowerCase().endsWith(".cmd")) {
    return ["cmd", "/c", bin, ...extraArgs];
  }
  return [bin, ...extraArgs];
}
