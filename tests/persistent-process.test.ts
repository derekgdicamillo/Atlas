/**
 * Unit tests for PersistentProcess class.
 *
 * These tests cover the public API surface without spawning actual Claude CLI processes.
 * Integration tests with live CLI are in Task 8.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PersistentProcess, type PersistentProcessConfig } from "../src/persistent-process.ts";

function makeConfig(overrides?: Partial<PersistentProcessConfig>): PersistentProcessConfig {
  return {
    agentId: "test-agent",
    modelId: "claude-opus-4-6",
    claudePath: "claude",
    cwd: process.cwd(),
    env: {},
    ...overrides,
  };
}

describe("PersistentProcess", () => {
  // Track instances for cleanup
  const instances: PersistentProcess[] = [];
  function create(overrides?: Partial<PersistentProcessConfig>): PersistentProcess {
    const proc = new PersistentProcess(makeConfig(overrides));
    instances.push(proc);
    return proc;
  }

  afterEach(async () => {
    // Clean up all instances to prevent leaked timers
    for (const proc of instances) {
      await proc.shutdown();
    }
    instances.length = 0;
  });

  describe("exports", () => {
    test("module exports PersistentProcess class", () => {
      expect(PersistentProcess).toBeDefined();
      expect(typeof PersistentProcess).toBe("function");
    });
  });

  describe("constructor", () => {
    test("accepts config and sets agentId", () => {
      const proc = create({ agentId: "atlas-main" });
      expect(proc.agentId).toBe("atlas-main");
    });

    test("accepts sessionId in config", () => {
      const proc = create({ sessionId: "sess-123" });
      expect(proc.getSessionId()).toBe("sess-123");
    });

    test("defaults sessionId to null when not provided", () => {
      const proc = create();
      expect(proc.getSessionId()).toBeNull();
    });
  });

  describe("isAlive()", () => {
    test("returns false initially", () => {
      const proc = create();
      expect(proc.isAlive()).toBe(false);
    });
  });

  describe("isBusy()", () => {
    test("returns false initially", () => {
      const proc = create();
      expect(proc.isBusy()).toBe(false);
    });
  });

  describe("getState()", () => {
    test("returns correct initial state", () => {
      const proc = create();
      const state = proc.getState();

      expect(state.status).toBe("idle");
      expect(state.restartCount).toBe(0);
      expect(state.turnInProgress).toBe(false);
      expect(state.pid).toBeNull();
      expect(typeof state.lastActivityAt).toBe("number");
      expect(state.lastActivityAt).toBeGreaterThan(0);
    });
  });

  describe("setSessionId / getSessionId", () => {
    test("set and get session ID", () => {
      const proc = create();
      expect(proc.getSessionId()).toBeNull();

      proc.setSessionId("session-abc");
      expect(proc.getSessionId()).toBe("session-abc");

      proc.setSessionId("session-def");
      expect(proc.getSessionId()).toBe("session-def");
    });

    test("set session ID to null", () => {
      const proc = create({ sessionId: "existing" });
      expect(proc.getSessionId()).toBe("existing");

      proc.setSessionId(null);
      expect(proc.getSessionId()).toBeNull();
    });
  });

  describe("shutdown()", () => {
    test("can be called on idle process without error", async () => {
      const proc = create();
      await proc.shutdown();
      // Should not throw
      expect(proc.getState().status).toBe("shutdown");
    });

    test("shutdown is idempotent", async () => {
      const proc = create();
      await proc.shutdown();
      await proc.shutdown();
      expect(proc.getState().status).toBe("shutdown");
    });
  });

  describe("sendTurn() without live process", () => {
    test("returns error result when process is not alive and cannot start", async () => {
      const proc = create({
        // Use a nonexistent path so spawn fails
        claudePath: "/nonexistent/claude-binary-that-does-not-exist",
      });

      const result = await proc.sendTurn("hello");
      expect(result.isError).toBe(true);
      expect(result.errorInfo.length).toBeGreaterThan(0);
    });

    test("returns error after shutdown", async () => {
      const proc = create();
      await proc.shutdown();

      const result = await proc.sendTurn("hello");
      expect(result.isError).toBe(true);
      expect(result.errorInfo).toContain("not alive");
    });
  });

  describe("agentId getter", () => {
    test("returns the configured agentId", () => {
      const proc = create({ agentId: "my-special-agent" });
      expect(proc.agentId).toBe("my-special-agent");
    });
  });
});
