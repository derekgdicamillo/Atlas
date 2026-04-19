import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { rm, readFile } from "fs/promises";
import { join } from "path";

const TEST_DIR = join(process.cwd(), "data", "atlas-ledger-test");

describe("ledger", () => {
  beforeAll(() => {
    process.env.LEDGER_DIR = TEST_DIR;
  });
  afterAll(async () => {
    delete process.env.LEDGER_DIR;
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  test("appendEntry writes a chained, signed entry", async () => {
    const { appendEntry, verifyChain } = await import("../src/ledger.ts");
    const e1 = await appendEntry({
      actor: "atlas",
      action: { tool: "GHL_TAG", args: { contact: "test", tag: "demo" } },
      sourceClaims: [],
    });
    expect(e1.seq).toBe(1);
    expect(e1.prevHash).toBe("GENESIS");
    expect(e1.entryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(e1.signature).toMatch(/^[a-f0-9]+$/);

    const e2 = await appendEntry({
      actor: "atlas",
      action: { tool: "CAL_ADD", args: { title: "meeting" } },
      sourceClaims: [],
    });
    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.entryHash);

    const ok = await verifyChain();
    expect(ok.valid).toBe(true);
    expect(ok.entries).toBe(2);
  });

  test("tampering invalidates the chain", async () => {
    const { appendEntry, verifyChain } = await import("../src/ledger.ts");
    const dayFile = await findLatestLedgerFile(TEST_DIR);
    const raw = await readFile(dayFile, "utf-8");
    // Corrupt first entry's action
    const lines = raw.split("\n").filter(Boolean);
    const first = JSON.parse(lines[0]);
    first.action.args = { contact: "MALICIOUS" };
    lines[0] = JSON.stringify(first);
    await Bun.write(dayFile, lines.join("\n") + "\n");

    const ok = await verifyChain();
    expect(ok.valid).toBe(false);
  });
});

async function findLatestLedgerFile(dir: string): Promise<string> {
  const files = (await import("fs/promises")).readdir;
  const list = (await files(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  return join(dir, list[list.length - 1]);
}
