import { test, expect } from "bun:test";
import { classifyEngineError, friendlyErrorText } from "./engine-errors.ts";

test("detects rate limit / overload", () => {
  expect(classifyEngineError("Error: 429 rate limit exceeded")).toEqual({ isRateLimit: true, isModelError: false });
  expect(classifyEngineError("the model is Overloaded")).toEqual({ isRateLimit: true, isModelError: false });
});
test("detects model error", () => {
  expect(classifyEngineError("model claude-x is unavailable")).toEqual({ isRateLimit: false, isModelError: true });
  expect(classifyEngineError("model not found")).toEqual({ isRateLimit: false, isModelError: true });
});
test("plain error is neither", () => {
  expect(classifyEngineError("some other failure")).toEqual({ isRateLimit: false, isModelError: false });
  expect(classifyEngineError(undefined)).toEqual({ isRateLimit: false, isModelError: false });
});
test("friendly text matches CLI wording", () => {
  expect(friendlyErrorText("tool_call_loop", 312)).toContain("Hit the tool call limit (312 calls)");
  expect(friendlyErrorText("timeout", 0)).toContain("took too long");
  expect(friendlyErrorText("error", 0)).toBeTruthy();
});
