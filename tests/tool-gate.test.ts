import { describe, test, expect } from "bun:test";
import { checkAction } from "../src/tool-gate.ts";

describe("tool-gate", () => {
  test("allows valid email", () => {
    const r = checkAction({ tool: "SEND", args: { to: "test@gmail.com", subject: "x", body: "y" } });
    expect(r.allowed).toBe(true);
  });

  test("blocks email to non-allowlisted domain", () => {
    const r = checkAction({ tool: "SEND", args: { to: "attacker@example.net", subject: "x", body: "y" } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("NoEmailOutsideAllowlist");
  });

  test("blocks GHL workflow enroll without approval flag", () => {
    const r = checkAction({ tool: "GHL_WORKFLOW", args: { action: "add", workflowId: "abc" } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("GHLWorkflowRequiresExplicitApproval");
  });

  test("allows GHL workflow enroll with approval flag", () => {
    const r = checkAction({
      tool: "GHL_WORKFLOW",
      args: { action: "add", workflowId: "abc", approved_by_user: true },
    });
    expect(r.allowed).toBe(true);
  });

  test("blocks cal_add without title", () => {
    const r = checkAction({ tool: "CAL_ADD", args: { date: "2026-05-01" } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("CalendarInviteRequiresTitle");
  });

  test("blocks META_ADS_UPDATE above spend cap", () => {
    const r = checkAction({ tool: "META_ADS_UPDATE", args: { spend_delta_usd: 150 } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("AdSpendChangeCap");
  });
});
