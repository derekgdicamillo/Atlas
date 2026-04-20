import { describe, test, expect } from "bun:test";
import { findCodeRanges, isInCodeBlock } from "../src/tag-utils.ts";

describe("tag-utils — code-block detection", () => {
  test("finds ranges for triple-backtick fences", () => {
    const text = "before\n```\n[SEND: to=a]\n```\nafter";
    const ranges = findCodeRanges(text);
    expect(ranges.length).toBe(1);
    const sendPos = text.indexOf("[SEND:");
    expect(isInCodeBlock(sendPos, ranges)).toBe(true);
  });

  test("finds ranges for single-backtick inline code", () => {
    const text = "try `[GHL_WORKFLOW: x | y | action=add]` for that";
    const ranges = findCodeRanges(text);
    expect(ranges.length).toBe(1);
    const ghlPos = text.indexOf("[GHL_WORKFLOW:");
    expect(isInCodeBlock(ghlPos, ranges)).toBe(true);
  });

  test("does NOT flag tags outside code blocks", () => {
    const text = "real action: [SEND: to=x@gmail.com | subject=hi | body=hello]";
    const ranges = findCodeRanges(text);
    const sendPos = text.indexOf("[SEND:");
    expect(isInCodeBlock(sendPos, ranges)).toBe(false);
  });

  test("handles mixed code and live tags", () => {
    const text =
      "Here's the syntax: `[SEND: to=a | subject=b | body=c]`\n" +
      "Now I'll actually do it: [SEND: to=real@gmail.com | subject=X | body=Y]";
    const ranges = findCodeRanges(text);
    const exampleSend = text.indexOf("[SEND: to=a");
    const liveSend = text.indexOf("[SEND: to=real");
    expect(isInCodeBlock(exampleSend, ranges)).toBe(true);
    expect(isInCodeBlock(liveSend, ranges)).toBe(false);
  });

  test("does not double-count backticks inside a triple fence", () => {
    const text = "```\nhere is `inline` inside a fence\n```";
    const ranges = findCodeRanges(text);
    expect(ranges.length).toBe(1);
  });
});
