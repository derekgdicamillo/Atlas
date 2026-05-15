// tests/sprint7/shadow-driver.test.ts
import { describe, it, expect } from "bun:test";

describe("shadow-atlas — IPC contract", () => {
  it("module loads without errors", async () => {
    const mod = await import("../../src/shadow-atlas.ts");
    expect(typeof mod.startShadowServer).toBe("function");
  });
});
