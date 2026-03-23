/**
 * Unit tests for ProcessPool (processPool singleton).
 *
 * Tests cover the public API surface without spawning actual Claude CLI processes.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { processPool } from "../src/persistent-pool.ts";
import { PersistentProcess } from "../src/persistent-process.ts";

afterEach(async () => {
  await processPool.shutdownAll();
});

describe("ProcessPool", () => {
  test("exports processPool singleton", () => {
    expect(processPool).toBeDefined();
    expect(typeof processPool.get).toBe("function");
    expect(typeof processPool.hasAlive).toBe("function");
    expect(typeof processPool.getStatus).toBe("function");
    expect(typeof processPool.shutdownAll).toBe("function");
    expect(typeof processPool.restartAgent).toBe("function");
  });

  test("get() returns a PersistentProcess for a given agent", () => {
    const proc = processPool.get("atlas");
    expect(proc).toBeInstanceOf(PersistentProcess);
    expect(proc.agentId).toBe("atlas");
  });

  test("get() returns same instance for same agent (identity check)", () => {
    const proc1 = processPool.get("atlas");
    const proc2 = processPool.get("atlas");
    expect(proc1).toBe(proc2);
  });

  test("get() returns different instances for different agents", () => {
    const atlas = processPool.get("atlas");
    const ishtar = processPool.get("ishtar");
    expect(atlas).not.toBe(ishtar);
    expect(atlas.agentId).toBe("atlas");
    expect(ishtar.agentId).toBe("ishtar");
  });

  test("getStatus() returns state for all created processes", () => {
    processPool.get("atlas");
    processPool.get("ishtar");
    const status = processPool.getStatus();
    expect(Object.keys(status)).toContain("atlas");
    expect(Object.keys(status)).toContain("ishtar");
    expect(typeof status["atlas"].status).toBe("string");
    expect(typeof status["ishtar"].status).toBe("string");
  });

  test("hasAlive() returns false for uncreated agents", () => {
    expect(processPool.hasAlive("nonexistent-agent")).toBe(false);
  });

  test("shutdownAll() clears the pool", async () => {
    processPool.get("atlas");
    processPool.get("ishtar");
    await processPool.shutdownAll();
    // After shutdown, pool should be empty — new get() returns a fresh instance
    const statusAfter = processPool.getStatus();
    expect(Object.keys(statusAfter)).toHaveLength(0);
  });
});
