import { test, expect } from "bun:test";
import { filterMcpServers } from "./mcp-config.ts";

const ALL = {
  atlas:{}, "google-suite":{}, "ghl-crm":{}, wordpress:{}, gbp:{},
  "ga4-analytics":{}, "pv-dashboard":{}, hevy:{}, playwright:{},
} as Record<string, any>;

const CORE = ["atlas", "ghl-crm", "pv-dashboard", "google-suite", "wordpress"].sort();

test("no intent -> lean always-on core only (heavy servers NOT loaded)", () => {
  const r = filterMcpServers(ALL);
  expect(Object.keys(r).sort()).toEqual(CORE);
  expect(r.playwright).toBeUndefined(); // heavy browser server gated out by default
  expect(r["ga4-analytics"]).toBeUndefined();
});

test("browser intent adds playwright on top of core", () => {
  const r = filterMcpServers(ALL, { browser: true });
  expect(r.playwright).toBeDefined();
  expect(Object.keys(r).sort()).toEqual([...CORE, "playwright"].sort());
});

test("reputation intent adds gbp on top of core", () => {
  const r = filterMcpServers(ALL, { reputation: true });
  expect(r.gbp).toBeDefined();
});

test("ghl-crm is ALWAYS present (Derek's primary need), intent or not", () => {
  expect(filterMcpServers(ALL)["ghl-crm"]).toBeDefined();
  expect(filterMcpServers(ALL, { browser: true })["ghl-crm"]).toBeDefined();
});

test("intent-mapped server absent from `all` is skipped, not invented", () => {
  const allNoPlaywright = { atlas:{}, "ghl-crm":{}, "pv-dashboard":{}, "google-suite":{}, wordpress:{} } as Record<string, any>;
  const r = filterMcpServers(allNoPlaywright, { browser: true });
  expect(r.playwright).toBeUndefined();
});
