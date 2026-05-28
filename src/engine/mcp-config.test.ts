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

test("unknown server names in intent map are ignored safely", () => {
  const r = filterMcpServers(ALL, { pipeline: true }); // pipeline -> ghl-crm
  expect(Object.keys(r).sort()).toEqual(["atlas", "ghl-crm"]);
});
