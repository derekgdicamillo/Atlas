import { describe, it, expect, beforeAll } from "bun:test";
import { scoreVoteOutcome, dailyShadowReview } from "../../src/shadow-council";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!
);

describe("shadow-council — scoring", () => {
  it("scoreVoteOutcome rewards critic that vetoed an action Derek rewrote", async () => {
    const actionId = randomUUID();
    await supabase.from("council_votes").insert({
      vote_id: randomUUID(),
      action_id: actionId,
      role_id: "patient-advocate",
      vote: "veto",
      reason: "tone is patronizing",
      confidence: 0.85,
      mode: "shadow",
    });
    const before = (await supabase.from("role_reputation").select("alpha,beta").eq("role_id", "patient-advocate").eq("domain", "email").maybeSingle()).data;
    await scoreVoteOutcome(supabase, actionId, "rewritten");
    const after = (await supabase.from("role_reputation").select("alpha,beta").eq("role_id", "patient-advocate").eq("domain", "email").maybeSingle()).data;
    expect(after?.alpha ?? 0).toBeGreaterThan(before?.alpha ?? 0);
  });

  it("dailyShadowReview produces a markdown report", async () => {
    const md = await dailyShadowReview(supabase, new Date());
    expect(md).toContain("# Council Shadow Report");
    expect(md).toMatch(/Surface\s*\|/);
  });
});
