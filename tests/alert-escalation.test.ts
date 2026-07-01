import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { rmSync, existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

// The module resolves its state file from resolve(PROJECT_DIR || cwd) —
// mirror that exactly so the test reads/writes the same file regardless of cwd.
const TEST_DIR = join(resolve(process.env.PROJECT_DIR || process.cwd()), "data");
const STATE_FILE = join(TEST_DIR, "pending-critical-alerts.json");

const { recordCriticalDelivery, acknowledgeAll, sweepEscalations } = await import(
  "../src/alert-escalation.ts"
);

function clearState() {
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
}

describe("alert-escalation", () => {
  beforeEach(clearState);
  afterAll(clearState);

  test("recordCriticalDelivery persists a pending alert", () => {
    recordCriticalDelivery("[!!!] Peptide launch blocker: pharmacy order unconfirmed");
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    expect(state).toHaveLength(1);
    expect(state[0].escalated).toBe(false);
    expect(state[0].message).toContain("pharmacy order");
  });

  test("acknowledgeAll clears pending alerts", () => {
    recordCriticalDelivery("[!!!] Something urgent");
    acknowledgeAll();
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    expect(state).toHaveLength(0);
  });

  test("sweepEscalations skips fresh alerts", async () => {
    recordCriticalDelivery("[!!!] Fresh alert");
    const sent: string[] = [];
    const n = await sweepEscalations(async (t) => { sent.push(t); });
    expect(n).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("sweepEscalations forwards stale alerts once", async () => {
    recordCriticalDelivery("[!!!] Old alert about GHL automation");
    // Backdate the alert past the escalation window
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    state[0].sentAt = new Date(Date.now() - 12 * 3_600_000).toISOString();
    await Bun.write(STATE_FILE, JSON.stringify(state));

    const sent: string[] = [];
    const n1 = await sweepEscalations(async (t) => { sent.push(t); });
    expect(n1).toBe(1);
    expect(sent[0]).toContain("Derek hasn't acknowledged");
    expect(sent[0]).toContain("GHL automation");

    // Second sweep: already escalated, nothing sent
    const n2 = await sweepEscalations(async (t) => { sent.push(t); });
    expect(n2).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test("failed escalation send is retried next sweep", async () => {
    recordCriticalDelivery("[!!!] Alert that fails to send");
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    state[0].sentAt = new Date(Date.now() - 12 * 3_600_000).toISOString();
    await Bun.write(STATE_FILE, JSON.stringify(state));

    const n1 = await sweepEscalations(async () => { throw new Error("network down"); });
    expect(n1).toBe(0);

    const sent: string[] = [];
    const n2 = await sweepEscalations(async (t) => { sent.push(t); });
    expect(n2).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
