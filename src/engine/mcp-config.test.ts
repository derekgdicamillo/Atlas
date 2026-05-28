import { test, expect } from "bun:test";
import { filterMcpServers } from "./mcp-config.ts";

const ALL = {
  atlas: { command: "bun", args: ["x"] },
  "google-suite": { command: "bun", args: ["g"] },
  "ghl-crm": { command: "bun", args: ["c"] },
  playwright: { command: "npx", args: ["p"] },
};

test("no intent flags -> atlas core only", () => {
  expect(Object.keys(filterMcpServers(ALL))).toEqual(["atlas"]);
});

test("google intent adds google-suite", () => {
  const r = filterMcpServers(ALL, { google: true });
  expect(Object.keys(r).sort()).toEqual(["atlas", "google-suite"]);
});

test("browser intent adds playwright", () => {
  const r = filterMcpServers(ALL, { browser: true });
  expect(r.playwright).toBeDefined();
});

test("intent-mapped server absent from `all` is skipped (not invented)", () => {
  const allWithoutGhl = {
    atlas: { command: "bun", args: ["x"] },
    "google-suite": { command: "bun", args: ["g"] },
    playwright: { command: "npx", args: ["p"] },
  };
  const r = filterMcpServers(allWithoutGhl, { pipeline: true }); // pipeline -> ghl-crm, which is absent
  expect(Object.keys(r).sort()).toEqual(["atlas"]); // only core; ghl-crm not invented
  expect(r["ghl-crm"]).toBeUndefined();
});
