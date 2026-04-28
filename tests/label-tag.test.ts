import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { processLabelTag } from "../src/label-tag.ts";

const DS = "data/replay-dataset-label-test.jsonl";

describe("label-tag", () => {
  beforeAll(() => {
    mkdirSync("data", { recursive: true });
    if (existsSync(DS)) rmSync(DS);
  });
  afterAll(() => {
    if (existsSync(DS)) rmSync(DS);
  });

  test("promotes previous turn on [LABEL_GOOD]", async () => {
    const out = await processLabelTag({
      tagText: "[LABEL_GOOD]",
      prevUserTurn: "what's revenue?",
      prevAtlasResponse: "$42,100 MTD.",
      agent: "atlas",
      datasetPath: DS,
    });
    expect(out.written).toBe(true);
    const line = readFileSync(DS, "utf8").trim().split("\n").pop()!;
    const entry = JSON.parse(line);
    expect(entry.label).toBe("good");
    expect(entry.userTurn).toBe("what's revenue?");
  });

  test("promotes with reason on [LABEL_BAD: reason]", async () => {
    const out = await processLabelTag({
      tagText: "[LABEL_BAD: hallucinated number]",
      prevUserTurn: "revenue",
      prevAtlasResponse: "$999k",
      agent: "atlas",
      datasetPath: DS,
    });
    expect(out.written).toBe(true);
    const entry = JSON.parse(readFileSync(DS, "utf8").trim().split("\n").pop()!);
    expect(entry.label).toBe("bad");
    expect(entry.derekCorrection).toBe("hallucinated number");
  });

  test("returns written=false when no prev turn", async () => {
    const out = await processLabelTag({
      tagText: "[LABEL_GOOD]",
      prevUserTurn: null,
      prevAtlasResponse: null,
      agent: "atlas",
      datasetPath: DS,
    });
    expect(out.written).toBe(false);
    expect(out.reason).toContain("no previous");
  });
});
