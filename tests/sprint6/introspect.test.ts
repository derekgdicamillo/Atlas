import { describe, it, expect } from "bun:test";
import { resolveTurnId, isWithinTTL } from "../../src/introspect";

describe("introspect — turn_id resolver", () => {
  it("returns turn_id directly if input looks like a UUID", () => {
    expect(resolveTurnId("550e8400-e29b-41d4-a716-446655440000")).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("parses Telegram message link to chat_id/message_id pair", () => {
    const r = resolveTurnId("https://t.me/c/123456/789");
    expect(r).toEqual({ chat_id: "123456", message_id: "789" });
  });

  it("returns null for unrecognized input", () => {
    expect(resolveTurnId("not a uuid or link")).toBeNull();
  });
});

describe("introspect — TTL", () => {
  it("rejects timestamps older than 30 days", () => {
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    expect(isWithinTTL(old)).toBe(false);
  });
  it("accepts timestamps within 30 days", () => {
    const recent = new Date(Date.now() - 29 * 86_400_000).toISOString();
    expect(isWithinTTL(recent)).toBe(true);
  });
  it("accepts very recent timestamps", () => {
    const now = new Date().toISOString();
    expect(isWithinTTL(now)).toBe(true);
  });
});
