import { describe, test, expect } from "bun:test";
import {
  thompsonSample,
  rankByThompson,
  fillSlots,
  type Procedure,
  type Step,
} from "../src/procedures.ts";

describe("procedures Thompson sampling", () => {
  test("thompsonSample returns value in [0,1]", () => {
    for (let i = 0; i < 100; i++) {
      const v = thompsonSample(5, 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("alpha >> beta yields high mean sample", () => {
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += thompsonSample(50, 1);
    expect(sum / 1000).toBeGreaterThan(0.9);
  });

  test("alpha << beta yields low mean sample", () => {
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += thompsonSample(1, 50);
    expect(sum / 1000).toBeLessThan(0.1);
  });

  test("rankByThompson returns all candidates and reorders", () => {
    const procs: Procedure[] = [
      { id: "a", goal: "g", action_sequence: [], preconditions: [], postconditions: [], alpha: 50, beta: 1, use_count: 0, tags: [], source: "hand-curated" } as any,
      { id: "b", goal: "g", action_sequence: [], preconditions: [], postconditions: [], alpha: 1, beta: 50, use_count: 0, tags: [], source: "hand-curated" } as any,
      { id: "c", goal: "g", action_sequence: [], preconditions: [], postconditions: [], alpha: 5, beta: 5, use_count: 0, tags: [], source: "hand-curated" } as any,
    ];
    const out = rankByThompson(procs);
    expect(out).toHaveLength(3);
    let aWinCount = 0;
    for (let i = 0; i < 100; i++) {
      const r = rankByThompson(procs);
      if (r[0].id === "a") aWinCount++;
    }
    expect(aWinCount).toBeGreaterThan(70);
  });
});

describe("procedures slot-filling", () => {
  test("fillSlots renders {slot} placeholders from a values map", () => {
    const steps: Step[] = [
      { kind: "tag", tag: "[GHL_TASK: contact={contact_name} | task={task} | due={due_date}]" },
      { kind: "say", template: "Hey {contact_name}, your task is scheduled." },
    ];
    const filled = fillSlots(steps, {
      contact_name: "John Doe",
      task: "follow-up labs",
      due_date: "2026-05-01",
    });
    expect(filled[0]).toContain("contact=John Doe");
    expect(filled[0]).toContain("task=follow-up labs");
    expect(filled[1]).toContain("Hey John Doe");
  });

  test("fillSlots leaves unknown slots literal so caller can detect", () => {
    const steps: Step[] = [{ kind: "tag", tag: "[X: a={known} b={unknown}]" }];
    const filled = fillSlots(steps, { known: "K" });
    expect(filled[0]).toContain("a=K");
    expect(filled[0]).toContain("b={unknown}");
  });

  test("fillSlots skips wait and branch step kinds", () => {
    const steps: Step[] = [
      { kind: "tag", tag: "[A: x={x}]" },
      { kind: "wait", for: "human" },
      { kind: "branch", if: "y", then: [{ kind: "tag", tag: "[B]" }] },
      { kind: "say", template: "done" },
    ];
    const filled = fillSlots(steps, { x: "X" });
    expect(filled).toHaveLength(2);
    expect(filled[0]).toBe("[A: x=X]");
    expect(filled[1]).toBe("done");
  });
});
