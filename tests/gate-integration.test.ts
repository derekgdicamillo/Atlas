import { describe, test, expect } from "bun:test";
import { checkAction } from "../src/tool-gate.ts";

describe("gate integration with atlas.spec tool names", () => {
  test("SEND with allowlisted domain passes", () => {
    const r = checkAction({ tool: "SEND", args: { to: "test@gmail.com", subject: "x", body: "y" } });
    expect(r.allowed).toBe(true);
  });

  test("SEND with non-allowlisted domain blocks", () => {
    const r = checkAction({ tool: "SEND", args: { to: "attacker@example.net", subject: "x", body: "y" } });
    expect(r.allowed).toBe(false);
  });

  test("GHL_WORKFLOW without approved_by_user blocks on action=add", () => {
    const r = checkAction({ tool: "GHL_WORKFLOW", args: { action: "add", workflowId: "abc", approved_by_user: false } });
    expect(r.allowed).toBe(false);
  });

  test("GHL_WORKFLOW with action=remove passes without approved_by_user", () => {
    const r = checkAction({ tool: "GHL_WORKFLOW", args: { action: "remove", workflowId: "abc" } });
    expect(r.allowed).toBe(true);
  });

  test("CAL_ADD without title blocks", () => {
    const r = checkAction({ tool: "CAL_ADD", args: { date: "2026-05-01" } });
    expect(r.allowed).toBe(false);
  });

  test("DRAFT passes (not in spec)", () => {
    const r = checkAction({ tool: "DRAFT", args: { to: "anyone@anywhere.net", subject: "x", body: "y" } });
    expect(r.allowed).toBe(true);
  });
});
