// tests/sprint7/shadow-driver.test.ts
import { describe, it, expect } from "bun:test";

describe("shadow-atlas — IPC contract", () => {
  it("module loads without errors", async () => {
    const mod = await import("../../src/shadow-atlas.ts");
    expect(typeof mod.startShadowServer).toBe("function");
  });
});

describe("shadow-driver — classification", () => {
  it("benign for distance < 0.2", async () => {
    const { classifyDistance } = await import("../../src/shadow-driver.ts");
    const c = classifyDistance(0.1, 0);
    expect(c).toBe("benign");
  });

  it("explained for 0.2-0.45 with memory writes", async () => {
    const { classifyDistance } = await import("../../src/shadow-driver.ts");
    const c = classifyDistance(0.3, 5);
    expect(c).toBe("explained");
  });

  it("suspicious for 0.2-0.45 with no memory writes", async () => {
    const { classifyDistance } = await import("../../src/shadow-driver.ts");
    const c = classifyDistance(0.3, 0);
    expect(c).toBe("suspicious");
  });

  it("alarm for >= 0.45 with no memory writes", async () => {
    const { classifyDistance } = await import("../../src/shadow-driver.ts");
    const c = classifyDistance(0.5, 0);
    expect(c).toBe("alarm");
  });

  it("explained for >= 0.45 with memory writes", async () => {
    const { classifyDistance } = await import("../../src/shadow-driver.ts");
    const c = classifyDistance(0.6, 3);
    expect(c).toBe("explained");
  });
});

describe("shadow-driver — freeze flag round-trip", () => {
  it("freeze + isFrozen + resume cycle", async () => {
    const { freeze, isFrozen, resume } = await import("../../src/shadow-driver.ts");
    await resume("test-init"); // start clean
    expect(await isFrozen()).toBe(false);
    await freeze("synthetic test alarm");
    expect(await isFrozen()).toBe(true);
    await resume("test-clear");
    expect(await isFrozen()).toBe(false);
  });
});

describe("shadow-driver — external-action gate", () => {
  it("isExternalAction returns true for SEND/CAL_ADD/GHL_WORKFLOW", async () => {
    const { isExternalAction } = await import("../../src/shadow-driver.ts");
    expect(isExternalAction("SEND")).toBe(true);
    expect(isExternalAction("CAL_ADD")).toBe(true);
    expect(isExternalAction("GHL_WORKFLOW")).toBe(true);
    expect(isExternalAction("DRAFT")).toBe(false);
    expect(isExternalAction("REMEMBER")).toBe(false);
  });
});
