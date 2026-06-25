import { test, expect } from "bun:test";
import { parseExtraction, formatReport, type FlushSummary } from "./fb-intake-lane.ts";

test("parseExtraction reads clean JSON", () => {
  const r = parseExtraction('{"name":"Jane Doe","email":"jane@x.com","details":"RN, AZ"}', "shot-001.jpg");
  expect(r).toEqual({ name: "Jane Doe", email: "jane@x.com", details: "RN, AZ", sourceImage: "shot-001.jpg" });
});

test("parseExtraction strips code fences", () => {
  const r = parseExtraction("```json\n{\"name\":\"Bo\",\"email\":\"bo@y.com\"}\n```", "s2.jpg");
  expect(r.email).toBe("bo@y.com");
});

test("parseExtraction tolerates stray prose around the JSON", () => {
  const r = parseExtraction('Here you go: {"name":"Cy","email":"cy@z.com"} hope that helps', "s2b.jpg");
  expect(r.email).toBe("cy@z.com");
  expect(r.name).toBe("Cy");
});

test("parseExtraction null email on garbage", () => {
  const r = parseExtraction("I can't read this image", "s3.jpg");
  expect(r.email).toBeNull();
  expect(r.sourceImage).toBe("s3.jpg");
});

test("parseExtraction null email when model returns null", () => {
  const r = parseExtraction('{"name":"No Email","email":null,"details":""}', "s4.jpg");
  expect(r.email).toBeNull();
  expect(r.name).toBe("No Email");
});

test("formatReport lists name->email and totals", () => {
  const s: FlushSummary = {
    dryRun: true,
    inputCount: 2,
    added: 1,
    updated: 0,
    alreadyOnTarget: 1,
    alreadyFreeMember: 0,
    alreadyProMember: 0,
    dupInBatch: 0,
    noEmail: 0,
    invalidEmail: 0,
    errors: [],
    fbGroupLeadsTotal: 305,
    auditPath: "data/fb-intake/audit-x.json",
    contacts: [{ name: "Jane Doe", email: "jane@x.com", sourceImage: "shot-001.jpg" }],
  };
  const msg = formatReport(s);
  expect(msg).toContain("Added 1");
  expect(msg).toContain("FB Group Leads total: 305");
  expect(msg).toContain("jane@x.com");
  expect(msg.toLowerCase()).toContain("dry");
});

test("formatReport flags a missing email", () => {
  const s: FlushSummary = {
    dryRun: false,
    inputCount: 1,
    added: 0,
    updated: 0,
    alreadyOnTarget: 0,
    alreadyFreeMember: 0,
    alreadyProMember: 0,
    dupInBatch: 0,
    noEmail: 1,
    invalidEmail: 0,
    errors: [],
    fbGroupLeadsTotal: 300,
    contacts: [{ name: "No Mail", email: null, sourceImage: "s.jpg" }],
  };
  expect(formatReport(s)).toContain("NO EMAIL");
});
