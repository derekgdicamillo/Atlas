import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { loadDataset, type ReplayEntry } from "../src/replay-dataset.ts";

const FIXTURE = "data/replay-dataset-fixture.jsonl";

describe("replay-dataset", () => {
  beforeAll(() => {
    mkdirSync("data", { recursive: true });
    const entries: ReplayEntry[] = [
      {
        id: "2026-03-01-0001",
        capturedAt: "2026-03-01T09:14:00.000Z",
        agent: "atlas",
        userTurn: "what's MTD ad spend?",
        contextSummary: "morning brief, fresh",
        atlasResponse: "MTD ad spend is $2,341 per business_scorecard as of 03-01.",
        derekCorrection: null,
        label: "good",
        tags: ["metrics", "grounded"],
      },
      {
        id: "2026-03-02-0007",
        capturedAt: "2026-03-02T15:22:00.000Z",
        agent: "atlas",
        userTurn: "push a newsletter draft to GHL",
        contextSummary: "newsletter thread",
        atlasResponse: "Pushed to GHL.",
        derekCorrection: "you didn't actually emit a PV_NEWSLETTER_PUSH tag",
        label: "bad",
        tags: ["tool-correctness", "missing-tag"],
      },
    ];
    writeFileSync(FIXTURE, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  });

  afterAll(() => {
    if (existsSync(FIXTURE)) rmSync(FIXTURE);
  });

  test("loadDataset parses JSONL into typed entries", async () => {
    const ds = await loadDataset(FIXTURE);
    expect(ds).toHaveLength(2);
    expect(ds[0].label).toBe("good");
    expect(ds[1].derekCorrection).toContain("PV_NEWSLETTER_PUSH");
  });

  test("loadDataset throws on malformed line", async () => {
    const bad = "data/replay-dataset-bad.jsonl";
    writeFileSync(bad, '{"id":"x"}\n{not-json\n');
    try {
      await expect(loadDataset(bad)).rejects.toThrow(/malformed/i);
    } finally {
      rmSync(bad);
    }
  });

  test("rejects entries missing required fields", async () => {
    const bad = "data/replay-dataset-missing.jsonl";
    writeFileSync(bad, JSON.stringify({ id: "x", userTurn: "hi" }) + "\n");
    try {
      await expect(loadDataset(bad)).rejects.toThrow(/missing/i);
    } finally {
      rmSync(bad);
    }
  });
});
