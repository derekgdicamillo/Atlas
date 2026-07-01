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

  test("normalizes 2026-06-28 seeded labeler schema", async () => {
    const seeded = "data/replay-dataset-seeded.jsonl";
    writeFileSync(
      seeded,
      JSON.stringify({
        turn_id: "atlas-20260620-001",
        agent: "atlas",
        user_message: "You back",
        atlas_response: "Yeah, back up.",
        label: "bad",
        confidence: 0.85,
        reason: "Trailing open question appended to clean status update.",
        source_date: "2026-06-20",
        source: "atlas-ring-buffer[2]",
      }) + "\n"
    );
    try {
      const ds = await loadDataset(seeded);
      expect(ds).toHaveLength(1);
      expect(ds[0].id).toBe("atlas-20260620-001");
      expect(ds[0].userTurn).toBe("You back");
      expect(ds[0].atlasResponse).toBe("Yeah, back up.");
      expect(ds[0].capturedAt).toBe("2026-06-20");
      expect(ds[0].derekCorrection).toContain("Trailing open question");
      expect(ds[0].tags).toEqual(["seeded"]);
    } finally {
      rmSync(seeded);
    }
  });

  test("lenient mode skips invalid entries instead of throwing", async () => {
    const mixed = "data/replay-dataset-mixed.jsonl";
    writeFileSync(
      mixed,
      JSON.stringify({ id: "only-id" }) +
        "\n{not-json\n" +
        JSON.stringify({
          id: "ok-1",
          capturedAt: "2026-03-01T09:14:00.000Z",
          agent: "atlas",
          userTurn: "hi",
          contextSummary: "ctx",
          atlasResponse: "hello",
          derekCorrection: null,
          label: "good",
          tags: [],
        }) + "\n"
    );
    try {
      const ds = await loadDataset(mixed, { strict: false });
      expect(ds).toHaveLength(1);
      expect(ds[0].id).toBe("ok-1");
    } finally {
      rmSync(mixed);
    }
  });
});
