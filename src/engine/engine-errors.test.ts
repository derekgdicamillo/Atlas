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
test("detects SDK structured codes", () => {
  expect(classifyEngineError("rate_limit").isRateLimit).toBe(true);
  expect(classifyEngineError("server_error").isRateLimit).toBe(true);
  expect(classifyEngineError("model_not_found").isModelError).toBe(true);
});
test("friendly text matches CLI wording", () => {
  expect(friendlyErrorText("tool_call_loop", 312)).toContain("Hit the tool call limit (312 calls)");
  expect(friendlyErrorText("timeout", 0)).toContain("took too long");
  expect(friendlyErrorText("error", 0)).toBeTruthy();
});
