import { describe, it, expect, beforeAll } from "bun:test";
import { canonicalMemoryPayload } from "../../src/memory-signing.ts";

describe("memory-signing — canonicalMemoryPayload", () => {
  it("produces stable hash for identical input", () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      content: "hello",
      embedding: null,
      created_at: "2026-05-14T00:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
    };
    const a = canonicalMemoryPayload(row);
    const b = canonicalMemoryPayload({ ...row });
    expect(a.hashHex).toBe(b.hashHex);
    expect(a.hashHex.length).toBe(64); // sha256 hex
  });

  it("changes hash when content changes", () => {
    const base = {
      id: "11111111-1111-1111-1111-111111111111",
      content: "hello",
      embedding: null,
      created_at: "2026-05-14T00:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
    };
    const a = canonicalMemoryPayload(base);
    const b = canonicalMemoryPayload({ ...base, content: "hello!" });
    expect(a.hashHex).not.toBe(b.hashHex);
  });

  it("rounds embedding components to 6 decimals for stability", () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      content: "hello",
      embedding: [0.1234567891, 0.9876543219],
      created_at: "2026-05-14T00:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
    };
    const a = canonicalMemoryPayload(row);
    const b = canonicalMemoryPayload({
      ...row,
      embedding: [0.1234568, 0.9876543],
    });
    expect(a.hashHex).toBe(b.hashHex);
  });
});

describe("memory-signing — keypair sign/verify", () => {
  it("signs and verifies a row payload round-trip", async () => {
    const { initSessionKeyForTest, signMemoryRow, verifyMemoryRow } =
      await import("../../src/memory-signing.ts");
    const handle = initSessionKeyForTest("atlas");
    const row = {
      id: "22222222-2222-2222-2222-222222222222",
      content: "hello world",
      embedding: null,
      created_at: "2026-05-14T01:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
    };
    const signed = await signMemoryRow(row);
    expect(signed.session_id).toBe(handle.session_id);
    expect(signed.signature.length).toBeGreaterThan(0);
    const dbRow = {
      ...row,
      signature: signed.signature,
      sig_payload_hash: signed.sig_payload_hash,
      session_id: signed.session_id,
    };
    const v = await verifyMemoryRow(
      { _testMode: true, publicKeyPem: handle.publicKeyPem },
      dbRow
    );
    expect(v.valid).toBe(true);
  });

  it("detects content tampering", async () => {
    const { initSessionKeyForTest, signMemoryRow, verifyMemoryRow } =
      await import("../../src/memory-signing.ts");
    const handle = initSessionKeyForTest("atlas");
    const row = {
      id: "33333333-3333-3333-3333-333333333333",
      content: "original",
      embedding: null,
      created_at: "2026-05-14T01:00:00.000Z",
      agent: "atlas",
      user_id: "u1",
      class: "episodic",
    };
    const signed = await signMemoryRow(row);
    const dbRow = {
      ...row,
      content: "tampered",
      signature: signed.signature,
      sig_payload_hash: signed.sig_payload_hash,
      session_id: signed.session_id,
    };
    const v = await verifyMemoryRow(
      { _testMode: true, publicKeyPem: handle.publicKeyPem },
      dbRow
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("hash");
  });
});
