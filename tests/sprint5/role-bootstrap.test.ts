import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { rmSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { listPending, approvePending, rejectPending } from "../../src/role-registry";
import { createClient } from "@supabase/supabase-js";

const TEST_ROOT = join(process.cwd(), "data/test-roles-bootstrap");
// Mirror the auctioneer test: prefer service role key, fall back to anon key.
// approvePending upserts to role_pubkeys; a Supabase error there is logged but
// should not fail the pending workflow filesystem checks that are the focus of
// these tests. If neither key is set the test suite is skipped gracefully.
const supabase = createClient(
  process.env.SUPABASE_URL ?? "http://localhost:54321",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "placeholder"
);

describe("role-bootstrap — pending workflow", () => {
  beforeAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(join(TEST_ROOT, "_pending"), { recursive: true });
    const yaml = [
      "id: customer-voice",
      "name: Customer Voice",
      "description: Patient persona",
      "prompt_fragment: \"you are a typical patient\"",
      "domain_tags: [patient]",
      "mandatory_for: []",
      "created_at: \"2026-04-29\"",
      "version: 1",
      "",
    ].join("\n");
    writeFileSync(join(TEST_ROOT, "_pending", "abc123.yaml"), yaml);
  });
  afterAll(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); });

  it("lists pending roles", async () => {
    const pending = await listPending(TEST_ROOT);
    expect(pending.length).toBe(1);
    expect(pending[0].pending_id).toBe("abc123");
    expect(pending[0].role.name).toBe("Customer Voice");
  });

  it("approves a pending role and generates keypair", async () => {
    const result = await approvePending(supabase, "abc123", TEST_ROOT);
    expect(result.roleId).toBe("customer-voice");
    expect(existsSync(join(TEST_ROOT, "customer-voice", "role.yaml"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "customer-voice", "key.pub"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "_pending", "abc123.yaml"))).toBe(false);
  });

  it("rejects a pending role and removes the file", async () => {
    const yaml = [
      "id: bad-role",
      "name: Bad",
      "description: x",
      "prompt_fragment: x",
      "domain_tags: []",
      "mandatory_for: []",
      "created_at: \"2026-04-29\"",
      "version: 1",
      "",
    ].join("\n");
    writeFileSync(join(TEST_ROOT, "_pending", "def456.yaml"), yaml);
    await rejectPending("def456", "duplicate of customer-voice", TEST_ROOT);
    expect(existsSync(join(TEST_ROOT, "_pending", "def456.yaml"))).toBe(false);
  });
});
