import { describe, test, expect, beforeEach } from "bun:test";
import { checkAction, resetSpecCache } from "../src/tool-gate.ts";

describe("gate integration with atlas.spec tool names", () => {
  beforeEach(() => resetSpecCache());

  test("gmail.send with allowlisted domain and council_review_id passes", () => {
    const r = checkAction({ tool: "gmail.send", args: { to: "test@gmail.com", subject: "x", body: "y", council_review_id: "rev_123" } });
    expect(r.allowed).toBe(true);
  });

  test("gmail.send with non-allowlisted domain blocks", () => {
    const r = checkAction({ tool: "gmail.send", args: { to: "attacker@example.net", subject: "x", body: "y" } });
    expect(r.allowed).toBe(false);
  });

  test("ghl.workflow.enroll without approved_by_user blocks on action=add", () => {
    const r = checkAction({ tool: "ghl.workflow.enroll", args: { action: "add", workflowId: "abc", approved_by_user: false } });
    expect(r.allowed).toBe(false);
  });

  test("ghl.workflow.enroll with action=remove passes without approved_by_user", () => {
    const r = checkAction({ tool: "ghl.workflow.enroll", args: { action: "remove", workflowId: "abc" } });
    expect(r.allowed).toBe(true);
  });

  test("google.calendar.create without title blocks", () => {
    const r = checkAction({ tool: "google.calendar.create", args: { date: "2026-05-01" } });
    expect(r.allowed).toBe(false);
  });

  test("gmail.draft without council_review_id blocks for external recipient", () => {
    const r = checkAction({ tool: "gmail.draft", args: { to: "anyone@anywhere.net", subject: "x", body: "y" } });
    expect(r.allowed).toBe(false);
    expect(r.matchedInvariant).toBe("outbound_email_draft_requires_council");
  });
});
