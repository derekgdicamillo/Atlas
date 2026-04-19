import { describe, test, expect } from "bun:test";

describe("haiku-client shape", () => {
  test("exports callHaiku with expected signature", async () => {
    const mod = await import("../src/haiku-client.ts");
    expect(typeof mod.callHaiku).toBe("function");
  });

  test("returns { text, usage } on success", async () => {
    // Skip if no API key (local dev)
    if (!process.env.ANTHROPIC_API_KEY) {
      return;
    }
    const { callHaiku } = await import("../src/haiku-client.ts");
    const result = await callHaiku({
      system: "Respond with exactly: OK",
      userMessage: "test",
      maxTokens: 10,
    });
    expect(result.text.trim()).toBe("OK");
    expect(typeof result.usage.input_tokens).toBe("number");
  });
});
