import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { registerBidder, routeTask, promoteTaskType, currentRouting } from "../../src/marketplace";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!
);

// Unique bidder + task-type ids per run isolate the test from any other bidders
// previously registered for the "newsletter" domain or any leftover task-type rows.
const SUFFIX = randomUUID().slice(0, 8);
const BIDDER_A = `newsletter-bidder-A-${SUFFIX}`;
const BIDDER_B = `newsletter-bidder-B-${SUFFIX}`;
const TASK_TYPE = `newsletter-draft-${SUFFIX}`;

async function cleanup() {
  for (const id of [BIDDER_A, BIDDER_B]) {
    await supabase.from("marketplace_reputation").delete().eq("bidder_id", id);
    await supabase.from("marketplace_bidders").delete().eq("bidder_id", id);
    await supabase.from("marketplace_bids").delete().eq("bidder_id", id);
  }
  await supabase.from("marketplace_task_types").delete().eq("task_type", TASK_TYPE);
}

describe("marketplace — routing", () => {
  beforeAll(async () => {
    await cleanup();
    await registerBidder(supabase, { id: BIDDER_A, type: "skill", domains: ["newsletter"], vowCard: { cost_estimate_usd: 0.18, confidence_baseline: 0.84 } });
    await registerBidder(supabase, { id: BIDDER_B, type: "skill", domains: ["newsletter"], vowCard: { cost_estimate_usd: 0.34, confidence_baseline: 0.71 } });
    // Reset to shadow mode with sample_count >= NOVEL_THRESHOLD so the routine
    // (non-Haiku) path is taken in the shadow test, keeping it deterministic and fast.
    await supabase.from("marketplace_task_types").upsert(
      { task_type: TASK_TYPE, mode: "shadow", sample_count: 50, promoted_by: null, promoted_at: null },
      { onConflict: "task_type" }
    );
  });

  afterAll(cleanup);

  it("currentRouting returns a known mapping", () => {
    expect(currentRouting("newsletter-draft")).toBe("pv-newsletter");
    expect(currentRouting("never-seen")).toBe("code-research");
  });

  it("shadow-mode routeTask returns currentRouting winner but logs would-have-won", async () => {
    const result = await routeTask(supabase, {
      type: TASK_TYPE,
      description: "Write a 600-word weekly newsletter on GLP-1 pricing trends.",
      payload: {},
      domain: "newsletter",
    });
    expect(result.mode).toBe("shadow");
    expect(result.winner).toBe(currentRouting(TASK_TYPE));
    expect(result.bids.length).toBeGreaterThan(0);
  }, 15000);

  it("live-mode routeTask returns scored winner", async () => {
    await promoteTaskType(supabase, TASK_TYPE, "test");
    const result = await routeTask(supabase, {
      type: TASK_TYPE,
      description: "Write a 600-word weekly newsletter on GLP-1 pricing trends.",
      payload: {},
      domain: "newsletter",
    });
    expect(result.mode).toBe("live");
    // Winner should be one of OUR test bidders OR currentRouting fallback.
    // Other bidders for "newsletter" domain in the live DB may also bid; we
    // just verify the winner came from a bidder that actually participated.
    expect(result.bids.map((b) => b.bidder_id)).toContain(result.winner);
  }, 60000);
});
