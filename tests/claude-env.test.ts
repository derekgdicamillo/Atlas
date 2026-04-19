import { describe, test, expect } from "bun:test";
import { sanitizedEnv } from "../src/claude.ts";

describe("sanitizedEnv", () => {
  test("sets ENABLE_PROMPT_CACHING_1H=1 by default", () => {
    const env = sanitizedEnv();
    expect(env.ENABLE_PROMPT_CACHING_1H).toBe("1");
  });

  test("respects explicit override when caller sets it", () => {
    const original = process.env.ENABLE_PROMPT_CACHING_1H;
    process.env.ENABLE_PROMPT_CACHING_1H = "0";
    try {
      const env = sanitizedEnv();
      expect(env.ENABLE_PROMPT_CACHING_1H).toBe("0");
    } finally {
      if (original === undefined) delete process.env.ENABLE_PROMPT_CACHING_1H;
      else process.env.ENABLE_PROMPT_CACHING_1H = original;
    }
  });
});
