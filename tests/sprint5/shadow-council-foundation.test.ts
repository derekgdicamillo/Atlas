import { describe, it, expect } from "bun:test";
import { surfaceFor } from "../../src/shadow-council";

describe("shadow-council — surfaceFor", () => {
  it("maps gmail.send to outbound_email when external", () => {
    expect(surfaceFor({ tool: "gmail.send", args: { to: "patient@gmail.com" } })).toBe("outbound_email");
  });

  it("maps gmail.send to internal_email when internal domain", () => {
    expect(surfaceFor({ tool: "gmail.send", args: { to: "esther@pvmedispa.com" } })).toBe("internal_email");
  });

  it("maps brevo.campaign.send to brevo_campaign", () => {
    expect(surfaceFor({ tool: "brevo.campaign.send", args: { campaignId: 1 } })).toBe("brevo_campaign");
  });

  it("maps google.calendar.create with external attendee to cal_invite_external", () => {
    expect(surfaceFor({ tool: "google.calendar.create", args: { has_external_attendee: true } })).toBe("cal_invite_external");
  });

  it("maps ghl.* patient tools to ghl_patient_message", () => {
    expect(surfaceFor({ tool: "ghl.send.email", args: {} })).toBe("ghl_patient_message");
    expect(surfaceFor({ tool: "ghl.send.sms", args: {} })).toBe("ghl_patient_message");
    expect(surfaceFor({ tool: "ghl.workflow.enroll", args: {} })).toBe("ghl_patient_message");
  });

  it("maps social.publish.* to social_publish", () => {
    expect(surfaceFor({ tool: "social.publish.facebook", args: {} })).toBe("social_publish");
  });

  it("returns unconfigured for unknown tools", () => {
    expect(surfaceFor({ tool: "completely.unknown", args: {} })).toBe("unconfigured");
  });
});
