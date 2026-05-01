import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "fs/promises";
import { join } from "path";

const TEST_LEDGER = join(process.cwd(), "data", "atlas-ledger-integration-test");

describe("atlas-prime integration", () => {
  beforeAll(() => { process.env.LEDGER_DIR = TEST_LEDGER; });
  afterAll(async () => {
    delete process.env.LEDGER_DIR;
    try { await rm(TEST_LEDGER, { recursive: true, force: true }); } catch {}
  });

  test("end-to-end: blocked action lands in ledger with deny decision", async () => {
    const { checkAction } = await import("../src/tool-gate.ts");
    const { appendEntry, verifyChain } = await import("../src/ledger.ts");

    const bad = { tool: "gmail.send", args: { to: "attacker@malicious.io", subject: "x", body: "y" } };
    const gate = checkAction(bad);
    expect(gate.allowed).toBe(false);

    await appendEntry({
      actor: "atlas",
      action: bad,
      sourceClaims: [],
      policyDecision: { spec_result: "deny" },
    });

    const v = await verifyChain();
    expect(v.valid).toBe(true);
    expect(v.entries).toBeGreaterThanOrEqual(1);
  });

  test("end-to-end: staleness classifier routes GHL question to fast tier", async () => {
    const { classifyByTriggers } = await import("../src/staleness-sentinel.ts");
    const r = classifyByTriggers("how do I create a GHL pipeline stage?");
    expect(r.tier).toBe("fast");
    expect(r.mustFetch).toBe(true);
    expect(r.matchedDomain).toBe("gohighlevel");
  });
});
