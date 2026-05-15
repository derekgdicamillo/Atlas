import { describe, it, expect } from "bun:test";
import { regenerate } from "../../src/self-regen";

describe("self-regen", () => {
  it("returns v2_text + rationale via injected callClaude", async () => {
    const callClaude = async () =>
      JSON.stringify({
        v2_text: "improved skill content",
        rationale: "addressed verbose hedging in 4 of last 30 invocations",
      });
    const out = await regenerate({
      skill_id: "humanizer",
      current_text: "current skill content",
      invocations: [
        { input: "a", output: "b", correction: "shorter" },
        { input: "c", output: "d", correction: null },
      ],
      callClaude,
    });
    expect(out.v2_text).toContain("improved");
    expect(out.rationale).toContain("addressed");
  });

  it("throws on malformed Opus output", async () => {
    const callClaude = async () => "not json";
    await expect(
      regenerate({ skill_id: "x", current_text: "y", invocations: [], callClaude })
    ).rejects.toThrow(/parse/i);
  });

  it("throws when output lacks required fields", async () => {
    const callClaude = async () => JSON.stringify({ v2_text: "x" });
    await expect(
      regenerate({ skill_id: "x", current_text: "y", invocations: [], callClaude })
    ).rejects.toThrow(/missing/i);
  });

  it("includes invocation history in the prompt", async () => {
    let capturedPrompt = "";
    const callClaude = async (prompt: string) => {
      capturedPrompt = prompt;
      return JSON.stringify({ v2_text: "x", rationale: "y" });
    };
    await regenerate({
      skill_id: "humanizer",
      current_text: "current",
      invocations: [{ input: "in1", output: "out1", correction: "fix1" }],
      callClaude,
    });
    expect(capturedPrompt).toContain("in1");
    expect(capturedPrompt).toContain("out1");
    expect(capturedPrompt).toContain("fix1");
  });
});
