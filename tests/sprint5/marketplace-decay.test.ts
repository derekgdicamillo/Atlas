import { describe, it, expect } from "bun:test";
import { decayAll, registerBidder, betaSummary } from "../../src/marketplace";
import { createClient } from "@supabase/supabase-js";

// Use SUPABASE_ANON_KEY — SUPABASE_SERVICE_ROLE_KEY is not in the env.
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

describe("marketplace — decay", () => {
  it("decays a high-alpha bidder back toward prior", async () => {
    await registerBidder(supabase, { id: "decay-test-1", type: "skill", domains: ["newsletter"], vowCard: {} });
    // Manually set alpha=10, beta=2, last_decay 100 days ago, half_life=30
    const past = new Date(Date.now() - 100 * 86400_000).toISOString();
    await supabase.from("marketplace_reputation").upsert(
      { bidder_id: "decay-test-1", domain: "newsletter", alpha: 10, beta: 2, last_decay_at: past, prior_alpha: 2, prior_beta: 2, half_life_days: 30 },
      { onConflict: "bidder_id,domain" }
    );
    const before = await betaSummary(supabase, "decay-test-1", "newsletter");
    await decayAll(supabase);
    const after = await betaSummary(supabase, "decay-test-1", "newsletter");
    expect(after.alpha).toBeLessThan(before.alpha);
    expect(after.alpha).toBeGreaterThan(2.0); // didn't go all the way to prior
  });
});
