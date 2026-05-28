import { test, expect } from "bun:test";
import { mapSdkMessageToEvents } from "./sdk-adapter.ts";

test("init system message yields a system event with session id", () => {
  const evs = mapSdkMessageToEvents({ type: "system", subtype: "init", session_id: "sess_123" });
  expect(evs).toEqual([{ type: "system", sessionId: "sess_123" }]);
});

test("assistant text block yields a text_delta event", () => {
  const evs = mapSdkMessageToEvents({
    type: "assistant", session_id: "s", message: { content: [{ type: "text", text: "hello" }] },
  });
  expect(evs).toContainEqual({ type: "text_delta", sessionId: "s", textDelta: "hello" });
});

test("assistant tool_use block yields an assistant tool event", () => {
  const evs = mapSdkMessageToEvents({
    type: "assistant", session_id: "s",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  });
  expect(evs).toContainEqual({ type: "assistant", sessionId: "s", toolName: "Bash", toolInput: { command: "ls" } });
});

test("thinking block yields a thinking event (keeps inactivity timer alive)", () => {
  const evs = mapSdkMessageToEvents({
    type: "assistant", session_id: "s", message: { content: [{ type: "thinking", thinking: "..." }] },
  });
  expect(evs).toContainEqual({ type: "thinking", sessionId: "s" });
});

test("result message yields a result event with text, error flag, and tokens", () => {
  const evs = mapSdkMessageToEvents({
    type: "result", session_id: "s", subtype: "success", result: "final answer",
    is_error: false, usage: { input_tokens: 100, output_tokens: 50 },
  });
  expect(evs).toEqual([{
    type: "result", sessionId: "s", resultText: "final answer",
    isError: false, errorSubtype: "success", inputTokens: 100, outputTokens: 50,
  }]);
});

test("unknown message type yields no events", () => {
  expect(mapSdkMessageToEvents({ type: "stream_event" } as any)).toEqual([]);
});
