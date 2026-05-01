import { describe, it, expect } from "bun:test";
import { openDeliberation, postCounter, arbitrate } from "../../src/joint-protocol";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!
);

describe("joint-protocol — arbitrate", () => {
  it("arbitrates an agreed deliberation and writes final-memo", async () => {
    const opened = await openDeliberation(
      supabase,
      "atlas",
      "Test proposal: hire 2nd MD",
      "routine",
      "hire-fire"
    );
    await postCounter(
      supabase,
      opened.deliberationId,
      "ishtar",
      "I agree, but suggest waiting until Q4."
    );
    const result = await arbitrate(supabase, opened.deliberationId);
    expect(result.memo).toBeTruthy();
    expect(typeof result.agreed).toBe("boolean");
    expect(result.mergeCommit).toMatch(/^[a-f0-9]{40}$/);
  }, 30000);
});
