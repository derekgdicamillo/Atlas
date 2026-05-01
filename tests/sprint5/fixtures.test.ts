/**
 * Sprint 5 — Fixture Test Runner
 *
 * Exercises deterministic primitives:
 *   - should-be-joint: shouldFireJoint (regex trigger detection, no Haiku)
 *   - council-bypass: checkAction against atlas.spec invariants
 *   - role-contract-forgery: verifyContract ed25519 rejection
 *   - marketplace-gaming: Beta posterior dampening after repeated losses
 *
 * NOTE: prompt-injection and contested-roles fixtures are DATA-ONLY.
 * They require live Council critic responses (Haiku calls) which are
 * intentionally not invoked here to avoid cost. These fixtures exist
 * for the Sprint 6 replay harness.
 */
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { readdirSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { checkAction, resetSpecCache } from "../../src/tool-gate";
import { shouldFireJoint } from "../../src/joint-protocol";
import {
  verifyContract,
  signContract,
  generateRoleKeypair,
} from "../../src/role-registry";
import {
  betaSummary,
  registerBidder,
  recordOutcome,
} from "../../src/marketplace";

// ============================================================
// SUPABASE CLIENT (lazy — only instantiated if env vars present)
// ============================================================

function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase-backed tests");
  return createClient(url, key);
}

const HAS_SUPABASE = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY));

// ============================================================
// FIXTURE LOADER
// ============================================================

function loadFixtures(dir: string): { name: string; fixture: Record<string, unknown> }[] {
  const root = join(process.cwd(), dir);
  return readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      name: f,
      fixture: JSON.parse(readFileSync(join(root, f), "utf-8")),
    }));
}

const FIX = "tests/sprint5/fixtures";
const ADV = "tests/sprint5/adversarial";

// ============================================================
// SHOULD-BE-JOINT
// ============================================================

describe("sprint5 fixtures — should-be-joint", () => {
  for (const { name, fixture } of loadFixtures(join(FIX, "should-be-joint"))) {
    it(name, async () => {
      if (!HAS_SUPABASE) {
        console.log(`  [SKIP] ${name} — SUPABASE_URL not set`);
        return;
      }
      const expected = fixture.expected as { fire: boolean; trigger: string | null };
      const action = fixture.action as { tool: string; args: Record<string, unknown> };
      const context = (fixture.context as string) ?? "";

      const r = await shouldFireJoint(getSupabase(), action, context);

      expect(r.fire).toBe(expected.fire);
      if (expected.fire) {
        expect(r.trigger).toBe(expected.trigger);
      } else {
        // False-positive case: should not fire any trigger
        expect(r.trigger).toBeNull();
      }
    });
  }
});

// ============================================================
// COUNCIL-BYPASS (deterministic — no live Haiku, no Supabase)
// ============================================================

describe("sprint5 adversarial — council-bypass", () => {
  beforeAll(() => resetSpecCache());

  for (const { name, fixture } of loadFixtures(join(ADV, "council-bypass"))) {
    it(name, () => {
      const action = fixture.action as { tool: string; args: Record<string, unknown> };
      const expected = fixture.expected as {
        tool_gate_blocks: boolean;
        matched_invariant: string;
      };

      const r = checkAction(action);

      expect(r.allowed).toBe(false);
      expect(r.matchedInvariant).toBe(expected.matched_invariant);
    });
  }
});

// ============================================================
// ROLE-CONTRACT-FORGERY (no Supabase — pure ed25519 crypto)
// ============================================================

const FORGERY_ROOT = join(process.cwd(), "data/test-roles-forgery");

beforeAll(() => {
  rmSync(FORGERY_ROOT, { recursive: true, force: true });
  mkdirSync(FORGERY_ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(FORGERY_ROOT, { recursive: true, force: true });
});

describe("sprint5 adversarial — role-contract-forgery", () => {
  it("01.json: wrong-key-signature is rejected", async () => {
    await generateRoleKeypair("role-A", FORGERY_ROOT);
    await generateRoleKeypair("role-B", FORGERY_ROOT);

    // Sign with role-A's key, then claim role_id = role-B
    const sigByA = await signContract("role-A", { vote: "approve" }, FORGERY_ROOT);
    const claimedAsB = { ...sigByA, role_id: "role-B" };

    expect(await verifyContract(claimedAsB, FORGERY_ROOT)).toBe(false);
  });

  it("02.json: tampered-payload-after-signing is rejected", async () => {
    await generateRoleKeypair("role-C", FORGERY_ROOT);

    const original = await signContract("role-C", { vote: "approve" }, FORGERY_ROOT);

    // Mutate the payload after signing — canonical re-check will catch it
    const tampered = {
      ...original,
      payload: { vote: "veto" }, // changed from "approve"
    };

    expect(await verifyContract(tampered, FORGERY_ROOT)).toBe(false);
  });

  it("03.json: modified-payload-canonical is rejected", async () => {
    await generateRoleKeypair("role-D", FORGERY_ROOT);

    const original = await signContract("role-D", { vote: "approve" }, FORGERY_ROOT);

    // Overwrite payload_canonical with a different string while leaving payload unchanged
    const tampered = {
      ...original,
      payload_canonical: '{"vote":"veto"}',
    };

    expect(await verifyContract(tampered, FORGERY_ROOT)).toBe(false);
  });
});

// ============================================================
// MARKETPLACE-GAMING
// ============================================================

describe("sprint5 adversarial — marketplace-gaming", () => {
  it(
    "01.json: Beta posterior dampens always-confidence=1 bidder after 10 losses",
    async () => {
      if (!HAS_SUPABASE) {
        console.log("  [SKIP] marketplace-gaming/01 — SUPABASE_URL not set");
        return;
      }
      const supabase = getSupabase();
      const id = "gamer-conf1-" + randomUUID().slice(0, 8);

      await registerBidder(supabase, {
        id,
        type: "skill",
        domains: ["default"],
        vowCard: { confidence_baseline: 1.0 },
      });

      // Insert 10 bid rows (all won=true) then record each as a loss
      for (let i = 0; i < 10; i++) {
        const taskId = randomUUID();

        await supabase.from("marketplace_bids").insert({
          bid_id: randomUUID(),
          task_id: taskId,
          bidder_id: id,
          want: true,
          confidence_now: 1.0,
          cost_now: 0.1,
          won: true,
          mode: "live",
        });

        await recordOutcome(supabase, taskId, "loss", 1000, 0.1, "judge");
      }

      const summary = await betaSummary(supabase, id, "default");

      // alpha starts at 2, beta starts at 2; after 10 losses: alpha=2, beta=12
      // mean = 2 / (2+12) = 0.143 — well below 0.5
      expect(summary.mean).toBeLessThan(0.5);
    },
    30_000
  );

  it(
    "02.json: Beta posterior dampens cost-manipulation bidder after 10 losses",
    async () => {
      if (!HAS_SUPABASE) {
        console.log("  [SKIP] marketplace-gaming/02 — SUPABASE_URL not set");
        return;
      }
      const supabase = getSupabase();
      const id = "gamer-cost-" + randomUUID().slice(0, 8);

      await registerBidder(supabase, {
        id,
        type: "skill",
        domains: ["default"],
        vowCard: { cost_estimate_usd: 0.001, confidence_baseline: 0.8 },
      });

      for (let i = 0; i < 10; i++) {
        const taskId = randomUUID();

        await supabase.from("marketplace_bids").insert({
          bid_id: randomUUID(),
          task_id: taskId,
          bidder_id: id,
          want: true,
          confidence_now: 0.8,
          cost_now: 0.001,
          won: true,
          mode: "live",
        });

        await recordOutcome(supabase, taskId, "loss", 500, 0.001, "judge");
      }

      const summary = await betaSummary(supabase, id, "default");
      expect(summary.mean).toBeLessThan(0.5);
    },
    30_000
  );

  it(
    "03.json: domain-spam bidder reputation is isolated per domain",
    async () => {
      if (!HAS_SUPABASE) {
        console.log("  [SKIP] marketplace-gaming/03 — SUPABASE_URL not set");
        return;
      }
      const supabase = getSupabase();
      const id = "gamer-domain-" + randomUUID().slice(0, 8);

      const allDomains = [
        "email",
        "careplan",
        "marketing",
        "ad-creative",
        "code",
        "newsletter",
        "gbp-post",
        "social",
      ];

      await registerBidder(supabase, {
        id,
        type: "skill",
        domains: allDomains,
        vowCard: { confidence_baseline: 0.9 },
      });

      // Record 10 losses via "default" domain (Sprint 5 limitation)
      for (let i = 0; i < 10; i++) {
        const taskId = randomUUID();

        await supabase.from("marketplace_bids").insert({
          bid_id: randomUUID(),
          task_id: taskId,
          bidder_id: id,
          want: true,
          confidence_now: 0.9,
          cost_now: 0.05,
          won: true,
          mode: "live",
        });

        await recordOutcome(supabase, taskId, "loss", 800, 0.05, "judge");
      }

      // "default" domain should be dampened after 10 losses
      const defaultSummary = await betaSummary(supabase, id, "default");
      expect(defaultSummary.mean).toBeLessThan(0.5);

      // Other specific domains were seeded at alpha=2, beta=2 → mean ≈ 0.5 (untouched)
      const codeSummary = await betaSummary(supabase, id, "code");
      expect(codeSummary.mean).toBeCloseTo(0.5, 1);
    },
    30_000
  );
});

// ============================================================
// DATA-ONLY FIXTURE VALIDATION (schema check — no live calls)
// ============================================================

describe("sprint5 fixtures — data-only schema validation", () => {
  it("all prompt-injection fixtures have required fields", () => {
    for (const { name, fixture } of loadFixtures(join(FIX, "prompt-injection"))) {
      expect(fixture.name, `${name}: missing name`).toBeTruthy();
      expect(fixture.action, `${name}: missing action`).toBeTruthy();
      const expected = fixture.expected as Record<string, unknown> | undefined;
      expect(expected, `${name}: missing expected`).toBeTruthy();
      expect(
        expected?.council_should_veto,
        `${name}: council_should_veto must be true`
      ).toBe(true);
    }
  });

  it("all contested-roles fixtures have required fields", () => {
    for (const { name, fixture } of loadFixtures(join(FIX, "contested-roles"))) {
      expect(fixture.name, `${name}: missing name`).toBeTruthy();
      expect(fixture.force_seats, `${name}: missing force_seats`).toBeTruthy();
      expect(fixture.scenario, `${name}: missing scenario`).toBeTruthy();
      const expected = fixture.expected as Record<string, unknown> | undefined;
      expect(
        expected?.arbitration_should_emit,
        `${name}: missing arbitration_should_emit`
      ).toBeTruthy();
    }
  });

  it("all marketplace-gaming adversarial fixtures have required fields", () => {
    for (const { name, fixture } of loadFixtures(join(ADV, "marketplace-gaming"))) {
      expect(fixture.name, `${name}: missing name`).toBeTruthy();
      expect(fixture.scenario, `${name}: missing scenario`).toBeTruthy();
      expect(fixture.expected, `${name}: missing expected`).toBeTruthy();
    }
  });

  it("all role-forgery adversarial fixtures have required fields", () => {
    for (const { name, fixture } of loadFixtures(join(ADV, "role-contract-forgery"))) {
      expect(fixture.name, `${name}: missing name`).toBeTruthy();
      expect(fixture.scenario, `${name}: missing scenario`).toBeTruthy();
      const expected = fixture.expected as Record<string, unknown> | undefined;
      expect(
        expected?.verifyContract_returns,
        `${name}: verifyContract_returns must be false`
      ).toBe(false);
    }
  });

  it("all council-bypass adversarial fixtures have required fields", () => {
    for (const { name, fixture } of loadFixtures(join(ADV, "council-bypass"))) {
      expect(fixture.name, `${name}: missing name`).toBeTruthy();
      expect(fixture.action, `${name}: missing action`).toBeTruthy();
      const expected = fixture.expected as Record<string, unknown> | undefined;
      expect(expected?.tool_gate_blocks, `${name}: tool_gate_blocks must be true`).toBe(true);
      expect(expected?.matched_invariant, `${name}: missing matched_invariant`).toBeTruthy();
    }
  });
});
