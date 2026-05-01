import { describe, it, expect, beforeEach } from "bun:test";
import { resetSpecCache, checkAction } from "../../src/tool-gate";

describe("atlas.spec v2 invariants", () => {
  beforeEach(() => resetSpecCache());

  it("blocks gmail.send to external domain without council_review_id", () => {
    const result = checkAction({
      tool: "gmail.send",
      args: { to: "patient@gmail.com", subject: "Hi", body: "test" },
    });
    expect(result.allowed).toBe(false);
    expect(result.matchedInvariant).toBe("outbound_email_requires_council");
  });

  it("allows gmail.send to external with council_review_id", () => {
    const result = checkAction({
      tool: "gmail.send",
      args: {
        to: "patient@gmail.com",
        subject: "Hi",
        body: "test",
        council_review_id: "rev_abc123",
      },
    });
    expect(result.allowed).toBe(true);
  });

  it("allows gmail.send to internal pvmedispa.com without council", () => {
    const result = checkAction({
      tool: "gmail.send",
      args: { to: "esther@pvmedispa.com", subject: "Hi", body: "test" },
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks brevo.campaign.send without council_review_id", () => {
    const result = checkAction({
      tool: "brevo.campaign.send",
      args: { campaignId: 42 },
    });
    expect(result.allowed).toBe(false);
    expect(result.matchedInvariant).toBe("brevo_campaign_requires_council");
  });

  it("blocks joint-tagged action without joint_deliberation_id", () => {
    const result = checkAction({
      tool: "ghl.workflow.enroll",
      args: { contactId: "abc", workflowId: "w1", joint_required: true },
    });
    expect(result.allowed).toBe(false);
    expect(result.matchedInvariant).toBe("joint_action_requires_joint_deliberation");
  });
});
