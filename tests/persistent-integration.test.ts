/**
 * Integration test for PersistentProcess with a real Claude CLI.
 *
 * Requires `claude` CLI to be installed and authenticated.
 * Uses Haiku (cheapest model) to minimize cost.
 *
 * Run: bun test tests/persistent-integration.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { PersistentProcess } from "../src/persistent-process.ts";
import { sanitizedEnv } from "../src/claude.ts";
import { MODELS } from "../src/constants.ts";
import { dirname } from "path";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

// Check if Claude CLI is available
const canRunClaude = (() => {
  try {
    const result = Bun.spawnSync([CLAUDE_PATH, "--version"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!canRunClaude)("PersistentProcess Integration", () => {
  let proc: PersistentProcess;

  afterAll(async () => {
    if (proc) await proc.shutdown();
  });

  test("spawns, sends a turn, and receives a result", async () => {
    proc = new PersistentProcess({
      agentId: "test-integration",
      modelId: MODELS.haiku,
      claudePath: CLAUDE_PATH,
      cwd: PROJECT_ROOT,
      env: sanitizedEnv() as Record<string, string | undefined>,
    });

    await proc.ensureAlive();
    expect(proc.isAlive()).toBe(true);
    expect(proc.getState().pid).not.toBeNull();

    const result = await proc.sendTurn("Reply with exactly the word: PONG. Nothing else.");

    expect(result.isError).toBe(false);
    expect(result.text.toUpperCase()).toContain("PONG");
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.sessionId).toBeTruthy();
  }, 120_000); // 2 min timeout

  test("second turn reuses the same process and has conversation context", async () => {
    // proc should still be alive from previous test
    expect(proc.isAlive()).toBe(true);

    const result = await proc.sendTurn(
      "What was the exact word I asked you to reply with in my first message? Reply with just that word."
    );

    expect(result.isError).toBe(false);
    expect(result.text.toUpperCase()).toContain("PONG");
    expect(result.durationMs).toBeGreaterThan(0);
  }, 120_000);

  test("process remains alive after multiple turns", async () => {
    expect(proc.isAlive()).toBe(true);

    const result = await proc.sendTurn("Say 'hello' and nothing else.");

    expect(result.isError).toBe(false);
    expect(result.text.toLowerCase()).toContain("hello");
    // Process should still be alive and ready for more
    expect(proc.isAlive()).toBe(true);
    expect(proc.isBusy()).toBe(false);
  }, 120_000);
});
