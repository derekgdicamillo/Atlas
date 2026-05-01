import { describe, it, expect } from "bun:test";
import { shouldFireJoint } from "../../src/joint-protocol";
import { createClient } from "@supabase/supabase-js";

// Use SERVICE_ROLE_KEY for RLS bypass; fall back to ANON_KEY for environments without it.
const supabase = createClient(
  process.env.SUPABASE_URL!,
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!
);

describe("joint-protocol — triggers (I3)", () => {
  it("hire-fire matches 'hire a second MD'", async () => {
    const r = await shouldFireJoint(supabase, { tool: "atlas.reply", args: {} }, "Should we hire a 2nd medical director this quarter?");
    expect(r.fire).toBe(true);
    expect(r.trigger).toBe("hire-fire");
  });

  it("capex-over-5k matches '$12,000'", async () => {
    const r = await shouldFireJoint(supabase, { tool: "atlas.reply", args: {} }, "We're considering buying a new laser for $12,000.");
    expect(r.fire).toBe(true);
    expect(r.trigger).toBe("capex-over-5k");
  });

  it("calendar-conflict matches 'family time'", async () => {
    const r = await shouldFireJoint(supabase, { tool: "atlas.reply", args: {} }, "Block out Sunday afternoon for family time.");
    expect(r.fire).toBe(true);
    expect(r.trigger).toBe("calendar-conflict");
  });

  it("brand-tone-change matches 'change our messaging'", async () => {
    const r = await shouldFireJoint(supabase, { tool: "atlas.reply", args: { actionRequested: true } }, "Let's change our messaging to focus more on hormones.");
    expect(r.fire).toBe(true);
    expect(r.trigger).toBe("brand-tone-change");
  });

  it("no trigger for routine messages", async () => {
    const r = await shouldFireJoint(supabase, { tool: "atlas.reply", args: {} }, "What's on the calendar today?");
    expect(r.fire).toBe(false);
  });
});
