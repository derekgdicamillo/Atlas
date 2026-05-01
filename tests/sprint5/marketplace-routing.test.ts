import { describe, it, expect, beforeAll } from "bun:test";
import { registerBidder, routeTask, promoteTaskType, currentRouting } from "../../src/marketplace";
import { createClient } from "@supabase/supabase-js";

// Use SUPABASE_ANON_KEY — SUPABASE_SERVICE_ROLE_KEY is not in the env.
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

describe("marketplace — routing", () => {
  beforeAll(async () => {
    // Register test bidders.
    await registerBidder(supabase, { id: "newsletter-bidder-A", type: "skill", domains: ["newsletter"], vowCard: { cost_estimate_usd: 0.18, confidence_baseline: 0.84 } });
    await registerBidder(supabase, { id: "newsletter-bidder-B", type: "skill", domains: ["newsletter"], vowCard: { cost_estimate_usd: 0.34, confidence_baseline: 0.71 } });
    // Reset newsletter-draft to shadow mode with sample_count >= NOVEL_THRESHOLD so the routine
    // (non-Haiku) path is taken in the shadow test, keeping it deterministic and fast.
    await supabase.from("marketplace_task_types").upsert(
      { task_type: "newsletter-draft", mode: "shadow", sample_count: 50, promoted_by: null, promoted_at: null },
      { onConflict: "task_type" }
    );
  });

  it("currentRouting returns a known mapping", () => {
    expect(currentRouting("newsletter-draft")).toBe("pv-newsletter");
    expect(currentRouting("never-seen")).toBe("code-research");
  });

  it("shadow-mode routeTask returns currentRouting winner but logs would-have-won", async () => {
    const result = await routeTask(supabase, {
      type: "newsletter-draft",
      description: "Write a 600-word weekly newsletter on GLP-1 pricing trends.",
      payload: {},
      domain: "newsletter",
    });
    expect(result.mode).toBe("shadow");
    expect(result.winner).toBe("pv-newsletter");
    expect(result.bids.length).toBeGreaterThan(0);
  }, 15000);

  it("live-mode routeTask returns scored winner", async () => {
    await promoteTaskType(supabase, "newsletter-draft", "test");
    const result = await routeTask(supabase, {
      type: "newsletter-draft",
      description: "Write a 600-word weekly newsletter on GLP-1 pricing trends.",
      payload: {},
      domain: "newsletter",
    });
    expect(result.mode).toBe("live");
    expect(["newsletter-bidder-A", "newsletter-bidder-B", "pv-newsletter"]).toContain(result.winner);
  }, 60000);
});
