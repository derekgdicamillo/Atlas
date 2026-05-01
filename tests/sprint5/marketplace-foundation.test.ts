import { describe, it, expect } from "bun:test";
import { registerBidder, betaSummary, recordOutcome } from "../../src/marketplace";
import { createClient } from "@supabase/supabase-js";

// Use SUPABASE_ANON_KEY — SUPABASE_SERVICE_ROLE_KEY is not in the env.
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

describe("marketplace — foundation", () => {
  it("registers a bidder and stores its vow-card", async () => {
    await registerBidder(supabase, {
      id: "test-bidder-1",
      type: "skill",
      domains: ["email"],
      vowCard: { cost_estimate_usd: 0.10, expected_latency_ms: 1500, confidence_baseline: 0.7 },
    });
    const { data } = await supabase
      .from("marketplace_bidders")
      .select("*")
      .eq("bidder_id", "test-bidder-1")
      .maybeSingle();
    expect(data).not.toBeNull();
    expect((data?.vow_card_json as any).cost_estimate_usd).toBe(0.10);
  });

  it("recordOutcome win → alpha increments", async () => {
    await registerBidder(supabase, { id: "test-bidder-2", type: "skill", domains: ["email"], vowCard: {} });
    const before = await betaSummary(supabase, "test-bidder-2", "default");
    // Insert a winning bid so recordOutcome can find it
    await supabase.from("marketplace_bids").insert({
      bid_id: "bid-1",
      task_id: "task-1",
      bidder_id: "test-bidder-2",
      want: true,
      confidence_now: 0.8,
      cost_now: 0.1,
      won: true,
      mode: "live",
    });
    await recordOutcome(supabase, "task-1", "win", 1200, 0.09, "judge");
    const after = await betaSummary(supabase, "test-bidder-2", "default");
    expect(after.alpha).toBeGreaterThan(before.alpha);
  });

  it("betaSummary returns mean and 95% CI", async () => {
    const s = await betaSummary(supabase, "test-bidder-2", "default");
    expect(s.mean).toBeGreaterThanOrEqual(0);
    expect(s.mean).toBeLessThanOrEqual(1);
    expect(s.ci95[0]).toBeLessThanOrEqual(s.mean);
    expect(s.ci95[1]).toBeGreaterThanOrEqual(s.mean);
  });
});
