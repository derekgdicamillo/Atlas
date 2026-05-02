import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { decayAll, registerBidder, betaSummary } from "../../src/marketplace";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!
);

// Unique bidder id per run avoids state contamination from prior test runs.
const TEST_BIDDER = `decay-test-${randomUUID().slice(0, 8)}`;

async function cleanup() {
  await supabase.from("marketplace_reputation").delete().eq("bidder_id", TEST_BIDDER);
  await supabase.from("marketplace_bidders").delete().eq("bidder_id", TEST_BIDDER);
}

describe("marketplace — decay", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("decays a high-alpha bidder back toward prior", async () => {
    await registerBidder(supabase, { id: TEST_BIDDER, type: "skill", domains: ["newsletter"], vowCard: {} });
    // Manually set alpha=10, beta=2, last_decay 100 days ago, half_life=30
    const past = new Date(Date.now() - 100 * 86400_000).toISOString();
    await supabase.from("marketplace_reputation").upsert(
      { bidder_id: TEST_BIDDER, domain: "newsletter", alpha: 10, beta: 2, last_decay_at: past, prior_alpha: 2, prior_beta: 2, half_life_days: 30 },
      { onConflict: "bidder_id,domain" }
    );
    const before = await betaSummary(supabase, TEST_BIDDER, "newsletter");
    await decayAll(supabase);
    const after = await betaSummary(supabase, TEST_BIDDER, "newsletter");
    expect(after.alpha).toBeLessThan(before.alpha);
    expect(after.alpha).toBeGreaterThan(2.0); // didn't go all the way to prior
  }, 30000);
});
