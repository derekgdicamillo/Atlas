import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { rmSync, mkdirSync } from "fs";
import { join } from "path";
import {
  generateRoleKeypair,
  signContract,
  verifyContract,
  loadRole,
  type SignedContract,
} from "../../src/role-registry";

const TEST_ROOT = join(process.cwd(), "data/test-roles");

describe("role-registry — signing", () => {
  beforeAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
  });
  afterAll(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); });

  it("generates an ed25519 keypair and writes pub+priv files", async () => {
    const result = await generateRoleKeypair("test-role-1", TEST_ROOT);
    expect(result.publicKey).toBeInstanceOf(Buffer);
    expect(result.publicKey.length).toBe(32);
  });

  it("signs and verifies a contract", async () => {
    await generateRoleKeypair("test-role-2", TEST_ROOT);
    const contract = await signContract("test-role-2", { vote: "approve", reason: "looks good" }, TEST_ROOT);
    expect(contract.signature).toBeInstanceOf(Buffer);
    expect(contract.role_id).toBe("test-role-2");
    const ok = await verifyContract(contract, TEST_ROOT);
    expect(ok).toBe(true);
  });

  it("rejects a tampered contract", async () => {
    await generateRoleKeypair("test-role-3", TEST_ROOT);
    const contract = await signContract("test-role-3", { vote: "approve" }, TEST_ROOT);
    const tampered: SignedContract = { ...contract, payload: { vote: "veto" } };
    const ok = await verifyContract(tampered, TEST_ROOT);
    expect(ok).toBe(false);
  });

  it("loads a role from YAML", async () => {
    const yaml = [
      "name: Test Role",
      "description: Test purposes only",
      "prompt_fragment: \"You are a test role.\"",
      "domain_tags: [test]",
      "mandatory_for: [test.tool]",
      "created_at: \"2026-04-29\"",
      "version: 1",
      "",
    ].join("\n");
    mkdirSync(join(TEST_ROOT, "test-role-4"), { recursive: true });
    await Bun.write(join(TEST_ROOT, "test-role-4/role.yaml"), yaml);
    const role = await loadRole("test-role-4", TEST_ROOT);
    expect(role.id).toBe("test-role-4");
    expect(role.name).toBe("Test Role");
    expect(role.mandatory_for).toContain("test.tool");
  });
});
