/** Mirror of claude.ts isRateLimit/isModelError detection. */
export function classifyEngineError(detail?: string): { isRateLimit: boolean; isModelError: boolean } {
  const s = (detail || "").toLowerCase();
  const isRateLimit =
    s.includes("rate limit") || s.includes("rate_limit") || s.includes("429") ||
    s.includes("overloaded") || s.includes("server_error") || s.includes("server error");
  const isModelError =
    s.includes("model_not_found") ||
    (s.includes("model") && (s.includes("unavailable") || s.includes("not found") || s.includes("capacity")));
  return { isRateLimit, isModelError };
}

/**
 * A persistent-process turn must NOT be delivered to the user if it errored or produced
 * no usable text. The persistent CLI can return a raw API 400 as non-empty result text —
 * e.g. interleaved-thinking signature replay ("thinking blocks cannot be modified") during
 * a multi-tool turn — which is an error, not an answer. Callers pass `text` already stripped
 * of reasoning tags. When this returns true, recycle the process and fall back to one-shot.
 */
export function isPersistentTurnUnusable(turnResult: { isError: boolean; text: string }): boolean {
  return turnResult.isError || turnResult.text.trim().length === 0;
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
