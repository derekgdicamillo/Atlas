/** Normalized result every engine (CLI today, SDK now, any provider later) produces. */
export interface EngineResult {
  text: string;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  isError: boolean;
  toolCallCount: number;
  /** Set when isError: a short reason ("timeout" | "tool_call_loop" | "rate_limit" | "model_error" | "error"). */
  errorReason?: string;
  /** Raw error text/subtype from the SDK, used to classify rate-limit vs model-error for fallback. */
  errorDetail?: string;
}
