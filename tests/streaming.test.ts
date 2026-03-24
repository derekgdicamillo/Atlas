import { describe, test, expect } from "bun:test";

describe("streaming module", () => {
  test("exports createStreamingSession", async () => {
    const mod = await import("../src/streaming.ts");
    expect(mod.createStreamingSession).toBeDefined();
    expect(typeof mod.createStreamingSession).toBe("function");
  });

  test("StreamingSession interface has required fields", async () => {
    const mod = await import("../src/streaming.ts");
    const session = mod.createStreamingSession({
      api: {
        sendMessage: async (chatId, text) => ({ message_id: 1 }),
        editMessageText: async (chatId, msgId, text) => {},
      },
      chatId: 12345,
    });
    expect(session.onDelta).toBeDefined();
    expect(session.finish).toBeDefined();
    expect(session.messageIds).toEqual([]);
    expect(session.hasContent).toBe(false);
  });

  test("onDelta sets hasContent to true", async () => {
    const mod = await import("../src/streaming.ts");
    const session = mod.createStreamingSession({
      api: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => {},
      },
      chatId: 12345,
    });
    session.onDelta("hello");
    expect(session.hasContent).toBe(true);
  });
});
