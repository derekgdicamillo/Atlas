import type { StreamEvent } from "../claude.ts";

/**
 * Translate ONE Claude Agent SDK message into zero-or-more Atlas StreamEvents.
 * Pure function — mirrors createStreamParser()'s CLI-JSON handling so the rest
 * of callClaude() (callbacks, cost, session) works identically for either engine.
 */
export function mapSdkMessageToEvents(msg: any): StreamEvent[] {
  const sessionId = msg?.session_id || undefined;
  switch (msg?.type) {
    case "system":
      return [{ type: "system", sessionId }];
    case "assistant": {
      const out: StreamEvent[] = [];
      for (const block of msg?.message?.content ?? []) {
        if (block.type === "tool_use") {
          out.push({ type: "assistant", sessionId, toolName: block.name || "unknown", toolInput: block.input });
        } else if (block.type === "text" && block.text) {
          out.push({ type: "text_delta", sessionId, textDelta: block.text });
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          out.push({ type: "thinking", sessionId });
        }
      }
      return out;
    }
    case "result":
      return [{
        type: "result",
        sessionId,
        resultText: msg.result || "",
        isError: !!msg.is_error,
        errorSubtype: msg.subtype,
        inputTokens: msg.usage?.input_tokens || 0,
        outputTokens: msg.usage?.output_tokens || 0,
      }];
    default:
      return [];
  }
}
