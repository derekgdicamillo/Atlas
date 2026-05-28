/** Mirror of claude.ts isRateLimit/isModelError detection. */
export function classifyEngineError(detail?: string): { isRateLimit: boolean; isModelError: boolean } {
  const s = (detail || "").toLowerCase();
  const isRateLimit = s.includes("rate limit") || s.includes("429") || s.includes("overloaded");
  const isModelError = s.includes("model") && (s.includes("unavailable") || s.includes("not found") || s.includes("capacity"));
  return { isRateLimit, isModelError };
}

/** Mirror of the CLI's user-facing strings. */
export function friendlyErrorText(reason: string | undefined, toolCallCount: number): string {
  if (reason === "tool_call_loop") {
    return `Hit the tool call limit (${toolCallCount} calls). For complex tasks like this, try the /code command or break it into smaller pieces.`;
  }
  if (reason === "timeout") {
    return `Sorry, that took too long. Try again or simplify your request.`;
  }
  return `Sorry, something went wrong on that request. Please try again.`;
}
