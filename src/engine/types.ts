/** Normalized result every engine (CLI today, SDK now, any provider later) produces. */
export interface EngineResult {
  text: string;
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  isError: boolean;
  toolCallCount: number;
}
