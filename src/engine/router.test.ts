import { test, expect, afterEach } from "bun:test";
import { selectEngine } from "./router.ts";

const orig = process.env.ATLAS_ENGINE;
afterEach(() => { if (orig === undefined) delete process.env.ATLAS_ENGINE; else process.env.ATLAS_ENGINE = orig; });

test("defaults to cli when unset", () => {
  delete process.env.ATLAS_ENGINE;
  expect(selectEngine()).toBe("cli");
});

test("env ATLAS_ENGINE=sdk selects sdk", () => {
  process.env.ATLAS_ENGINE = "sdk";
  expect(selectEngine()).toBe("sdk");
});

test("per-call override beats env", () => {
  process.env.ATLAS_ENGINE = "sdk";
  expect(selectEngine({ engine: "cli" })).toBe("cli");
});

test("unknown env value falls back to cli (fail safe)", () => {
  process.env.ATLAS_ENGINE = "banana";
  expect(selectEngine()).toBe("cli");
});
