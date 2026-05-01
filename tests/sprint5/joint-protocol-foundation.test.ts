import { describe, it, expect } from "bun:test";
import { openDeliberation, postCounter, listOpen, get } from "../../src/joint-protocol";
import { createClient } from "@supabase/supabase-js";

// Use SERVICE_ROLE_KEY for RLS bypass; fall back to ANON_KEY for environments without it.
const supabase = createClient(
  process.env.SUPABASE_URL!,
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!
);

describe("joint-protocol — foundation", () => {
  it("opens a deliberation with branch + DB row", async () => {
    const result = await openDeliberation(supabase, "atlas", "Should we hire a 2nd MD this quarter?", "routine", "test-trigger");
    expect(result.deliberationId).toBeTruthy();
    expect(result.branch).toMatch(/^joint\//);
    const { deliberation } = await get(supabase, result.deliberationId);
    expect(deliberation.opened_by).toBe("atlas");
    expect(deliberation.urgency).toBe("routine");
    expect(deliberation.status).toBe("pending");
  });

  it("posts a counter-proposal as a new commit on the branch", async () => {
    const opened = await openDeliberation(supabase, "atlas", "Test proposal", "routine", "test");
    await postCounter(supabase, opened.deliberationId, "ishtar", "Counter: prefer to wait until Q4");
    const { transcript } = await get(supabase, opened.deliberationId);
    expect(transcript.length).toBeGreaterThanOrEqual(2);
  });

  it("lists open deliberations", async () => {
    const open = await listOpen(supabase);
    expect(open.length).toBeGreaterThan(0);
  });
});
