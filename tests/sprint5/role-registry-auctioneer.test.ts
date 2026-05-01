import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { rmSync, mkdirSync } from "fs";
import { join } from "path";
import { domainFor, auctionFor, generateRoleKeypair } from "../../src/role-registry";
import { createClient } from "@supabase/supabase-js";

const TEST_ROOT = join(process.cwd(), "data/test-roles-auct");
// Adapt to SUPABASE_ANON_KEY since SUPABASE_SERVICE_ROLE_KEY is not available.
// getReputation handles DB misses gracefully (defaults to alpha=2, beta=2, mean=0.5).
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

describe("role-registry — auctioneer", () => {
  beforeAll(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
    const roles = [
      { id: "patient-advocate", name: "Patient Advocate", mandatory_for: ["gmail.send"] },
      { id: "compliance-lawyer", name: "Compliance Lawyer", mandatory_for: ["gmail.send"] },
      { id: "brand-voice", name: "Brand Voice", mandatory_for: [] },
      { id: "skeptic", name: "Skeptic", mandatory_for: [] },
    ];
    for (const r of roles) {
      mkdirSync(join(TEST_ROOT, r.id), { recursive: true });
      await generateRoleKeypair(r.id, TEST_ROOT);
      const yaml = [
        "name: " + r.name,
        "description: test",
        "prompt_fragment: \"you are " + r.name + "\"",
        "domain_tags: [email]",
        "mandatory_for: [" + r.mandatory_for.join(",") + "]",
        "created_at: \"2026-04-29\"",
        "version: 1",
        "",
      ].join("\n");
      await Bun.write(join(TEST_ROOT, r.id, "role.yaml"), yaml);
    }
  });
  afterAll(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); });

  it("domainFor maps known tools to domains", () => {
    expect(domainFor({ tool: "gmail.send", args: {} })).toBe("email");
    expect(domainFor({ tool: "pv-newsletter.push", args: {} })).toBe("newsletter");
    expect(domainFor({ tool: "gbp.post.create", args: {} })).toBe("gbp-post");
    expect(domainFor({ tool: "unknown.tool", args: {} })).toBe("default");
  });

  it("auctionFor returns mandatory floor + filled ceiling", async () => {
    const result = await auctionFor(supabase, { tool: "gmail.send", args: { to: "x@y.com" } }, { ceilingSeats: 3 }, TEST_ROOT);
    expect(result.seats.map((s) => s.id)).toContain("patient-advocate");
    expect(result.seats.map((s) => s.id)).toContain("compliance-lawyer");
    expect(result.seats.length).toBe(3);
    expect(result.reasoning).toMatch(/Mandatory floor/);
  });
});
