import { describe, expect, test } from "bun:test";
import { diffNewBriefs, briefsDueToday, tail } from "../src/tmaa-marketing.ts";

describe("diffNewBriefs", () => {
  test("returns files present after but not before", () => {
    expect(diffNewBriefs(["a.md"], ["a.md", "b.md"])).toEqual(["b.md"]);
  });
  test("empty when nothing new", () => {
    expect(diffNewBriefs(["a.md"], ["a.md"])).toEqual([]);
  });
});

describe("briefsDueToday", () => {
  const brief = (readOn: string) => `## The number\n\nmetric: x\nread_on: ${readOn}\nsuccess: y\n`;
  test("finds briefs whose read_on is today", () => {
    const due = briefsDueToday(
      [
        { file: "a.md", text: brief("2026-08-15") },
        { file: "b.md", text: brief("2026-08-16") },
      ],
      "2026-08-15",
    );
    expect(due).toEqual(["a.md"]);
  });
  test("ignores briefs with no read_on", () => {
    expect(briefsDueToday([{ file: "a.md", text: "no number here" }], "2026-08-15")).toEqual([]);
  });
});

describe("tail", () => {
  test("returns last N lines", () => {
    expect(tail("1\n2\n3\n4", 2)).toBe("3\n4");
  });
});
