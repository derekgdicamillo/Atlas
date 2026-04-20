import { describe, test, expect } from "bun:test";
import { extractFirstAssistantText } from "../src/prompt-runner.ts";

describe("extractFirstAssistantText — stream-json parsing", () => {
  test("returns first assistant text from ndjson stream", () => {
    const stream = [
      '{"type":"system","subtype":"init","session_id":"abc"}',
      '{"type":"user","message":{"content":"hello"}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"The real blog post content."}]}}',
      '{"type":"result","subtype":"success","result":"{\\"signals\\":[]}"}',
    ].join("\n");
    expect(extractFirstAssistantText(stream)).toBe("The real blog post content.");
  });

  test("ignores hook-triggered second assistant turn", () => {
    const stream = [
      '{"type":"system","subtype":"init"}',
      '{"type":"user","message":{"content":"write a poem"}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Roses are red.\\nViolets are blue."}]}}',
      '{"type":"user","message":{"content":"Analyze this conversation for behavioral signals..."}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"signals\\": []}"}]}}',
      '{"type":"result","subtype":"success","result":"{\\"signals\\": []}"}',
    ].join("\n");
    expect(extractFirstAssistantText(stream)).toBe("Roses are red.\nViolets are blue.");
  });

  test("concatenates multiple text blocks in one assistant message", () => {
    const stream =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Part A. "},{"type":"text","text":"Part B."}]}}';
    expect(extractFirstAssistantText(stream)).toBe("Part A. Part B.");
  });

  test("falls back to legacy json shape when stream-json absent", () => {
    const legacy = JSON.stringify({ result: "legacy single-turn output", num_turns: 1 });
    expect(extractFirstAssistantText(legacy)).toBe("legacy single-turn output");
  });

  test("returns raw string when neither shape matches", () => {
    expect(extractFirstAssistantText("just plain text")).toBe("just plain text");
  });

  test("skips tool_use blocks and grabs text only", () => {
    const stream =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}},{"type":"text","text":"Final answer."}]}}';
    expect(extractFirstAssistantText(stream)).toBe("Final answer.");
  });

  test("skips assistant messages that have only tool_use (picks next one with text)", () => {
    const stream = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"file data"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Here is what I found."}]}}',
    ].join("\n");
    expect(extractFirstAssistantText(stream)).toBe("Here is what I found.");
  });
});
