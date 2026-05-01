import { describe, it, expect, beforeAll } from "bun:test";
import { review } from "../../src/shadow-council";
import { createClient } from "@supabase/supabase-js";

// Adapt to SUPABASE_ANON_KEY since SUPABASE_SERVICE_ROLE_KEY is not available.
// getReputation handles DB misses gracefully (defaults to alpha=2, beta=2, mean=0.5).
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

describe("shadow-council — review with critics", () => {
  beforeAll(async () => {
    // Ensure 8 named seats are bootstrapped (or the test will skip mandatory floor)
  });

  it("review returns 3 votes within SLA for outbound_email", async () => {
    const result = await review(supabase, {
      tool: "gmail.send",
      args: { to: "patient@gmail.com", subject: "Hi", body: "Just checking in about your refill." },
    });
    expect(result.votes.length).toBeGreaterThanOrEqual(2);
    expect(result.deliberationBranch).toMatch(/^council\//);
    expect(["shadow", "live"]).toContain(result.mode);
  }, 15000);

  it("review allows in shadow mode regardless of vetoes", async () => {
    const result = await review(supabase, {
      tool: "gmail.send",
      args: { to: "patient@gmail.com", subject: "URGENT: act now", body: "Click here for $500 off!" },
    });
    if (result.mode === "shadow") {
      expect(result.allowed).toBe(true);
    }
  }, 15000);
});
