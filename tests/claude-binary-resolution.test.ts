/**
 * Regression test for the recurring "The system cannot find the file specified"
 * haiku-client failure (entropy probe, twin-predict-morning, knowledge-audit).
 *
 * Root cause: a CLAUDE_PATH ending in `.cmd` and CONTAINING SPACES
 * (e.g. C:\Users\Derek DiCamillo\AppData\Roaming\npm\claude.cmd) was passed
 * bare to `cmd /c`, which splits the path on the space and tries to run
 * `C:\Users\Derek` as the command. The fix resolves the `.cmd` npm shim to its
 * underlying `claude.exe` and spawns that directly, sidestepping cmd.exe quoting.
 */
import { describe, it, expect } from "bun:test";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { resolveClaudeBinary, buildClaudeSpawnArgs } from "../src/claude-binary.ts";

describe("resolveClaudeBinary", () => {
  it("returns non-.cmd paths unchanged", () => {
    expect(resolveClaudeBinary("claude")).toBe("claude");
    expect(resolveClaudeBinary("/usr/local/bin/claude")).toBe("/usr/local/bin/claude");
  });

  it("falls back to the original .cmd path when the sibling exe does not exist", () => {
    const fake = "C:/no/such/dir/claude.cmd";
    expect(resolveClaudeBinary(fake)).toBe(fake);
  });

  if (process.platform === "win32") {
    it("resolves a real npm .cmd shim (with spaces) to the underlying claude.exe", () => {
      const cmdPath = process.env.CLAUDE_PATH;
      if (!cmdPath || !cmdPath.toLowerCase().endsWith(".cmd")) return; // env-dependent
      const expectedExe = join(
        dirname(cmdPath),
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      );
      if (!existsSync(expectedExe)) return; // skip if layout differs
      const resolved = resolveClaudeBinary(cmdPath);
      expect(resolved).toBe(expectedExe);
      expect(resolved.toLowerCase().endsWith(".exe")).toBe(true);

      // Critical: the resolved exe must NOT be routed through cmd.exe, so spaces
      // in the path can no longer be mis-tokenized.
      const args = buildClaudeSpawnArgs(cmdPath, ["-p", "--model", "haiku"]);
      expect(args[0]).toBe(expectedExe);
      expect(args[0]).not.toBe("cmd");
    });
  }
});
