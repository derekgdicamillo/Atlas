import { test, expect } from "bun:test";
import { filterMcpServers } from "./mcp-config.ts";

const ALL = {
  atlas:{}, "google-suite":{}, "ghl-crm":{}, wordpress:{}, gbp:{},
  "ga4-analytics":{}, "pv-dashboard":{}, hevy:{}, playwright:{},
} as Record<string, any>;

test("no intent flags -> ALL servers (matches CLI full-config default)", () => {
  expect(Object.keys(filterMcpServers(ALL)).sort()).toEqual(Object.keys(ALL).sort());
});
test("single intent -> atlas core + that intent's servers (filtered subset)", () => {
  const r = filterMcpServers(ALL, { google: true });
  expect(Object.keys(r).sort()).toEqual(["atlas", "google-suite"]);
});
test(">=5 servers needed -> ALL servers (matches CLI 'not worth filtering')", () => {
  // marketing(pv-dashboard,ga4-analytics)+google(google-suite)+pipeline(ghl-crm)+reputation(gbp) = atlas+5 = 6 >=5
  const r = filterMcpServers(ALL, { marketing: true, google: true, pipeline: true, reputation: true });
  expect(Object.keys(r).sort()).toEqual(Object.keys(ALL).sort());
});
test("intent-mapped server absent from `all` is skipped", () => {
  const allNoGhl = { atlas:{}, "google-suite":{}, playwright:{} } as Record<string, any>;
  const r = filterMcpServers(allNoGhl, { pipeline: true });
  expect(r["ghl-crm"]).toBeUndefined();
});
