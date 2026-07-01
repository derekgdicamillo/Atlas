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

  test("no deltas are lost across a message rollover (06-xx truncation bug)", async () => {
    const mod = await import("../src/streaming.ts");
    const texts = new Map<number, string>();
    let nextId = 1;
    const api = {
      // Slow sendMessage simulates the async window where the old code wiped
      // currentMessageText and dropped in-flight deltas.
      sendMessage: async () => {
        await new Promise((r) => setTimeout(r, 30));
        const id = nextId++;
        texts.set(id, "...");
        return { message_id: id };
      },
      editMessageText: async (_c: any, id: number, text: string) => {
        texts.set(id, text);
      },
    };
    const session = mod.createStreamingSession({ api, chatId: 1 });

    // Build a paragraph big enough to cross the 3800 rollover threshold,
    // then keep sending deltas while the rollover is in flight.
    const para = "word ".repeat(200).trim() + "\n\n"; // ~1000 chars
    for (let i = 0; i < 5; i++) session.onDelta(para); // ~5000 chars → rollover fires
    // These arrive while sendMessage is sleeping (mid-rollover):
    session.onDelta("TAIL-MARKER-1 ");
    session.onDelta("TAIL-MARKER-2");

    await new Promise((r) => setTimeout(r, 200));
    await session.finish();

    const all = [...texts.values()].join("\n");
    expect(all).toContain("TAIL-MARKER-1");
    expect(all).toContain("TAIL-MARKER-2");
    expect(session.messageIds.length).toBeGreaterThanOrEqual(2);
  });

  test("finish() rolls over oversized tail instead of exceeding 4096", async () => {
    const mod = await import("../src/streaming.ts");
    const texts = new Map<number, string>();
    let nextId = 1;
    const api = {
      sendMessage: async () => {
        const id = nextId++;
        texts.set(id, "...");
        return { message_id: id };
      },
      editMessageText: async (_c: any, id: number, text: string) => {
        if (text.length > 4096) throw Object.assign(new Error("message too long"), { error_code: 400 });
        texts.set(id, text);
      },
    };
    const session = mod.createStreamingSession({ api, chatId: 1 });
    // One giant delta: no rollover chance before finish.
    session.onDelta("line\n".repeat(2000)); // 10000 chars
    await new Promise((r) => setTimeout(r, 50));
    await session.finish();
    const combined = [...texts.values()].join("");
    expect(combined.length).toBeGreaterThan(9000); // nothing dropped
    for (const t of texts.values()) expect(t.length).toBeLessThanOrEqual(4096);
  });

  test("splitForTelegram splits at paragraph boundaries and loses nothing", async () => {
    const mod = await import("../src/streaming.ts");
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ` + "x".repeat(800));
    const text = paras.join("\n\n");
    const chunks = mod.splitForTelegram(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    // Reassembled content preserves every paragraph marker
    const joined = chunks.join("\n\n");
    for (let i = 0; i < 10; i++) expect(joined).toContain(`Paragraph ${i} `);
  });
});
