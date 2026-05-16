import { describe, it, expect } from "bun:test";
import { proposeHalfLife } from "../../src/knowledge-audit.ts";

describe("knowledge-audit — proposeHalfLife", () => {
  it("returns current when drift is 0", () => {
    expect(proposeHalfLife(30, 0)).toBe(30);
  });

  it("ratchets down when drift is high", () => {
    const p = proposeHalfLife(30, 0.5);
    expect(p).toBeLessThan(30);
    expect(p).toBeGreaterThan(0);
  });

  it("clips to 1.5x current ceiling", () => {
    const p = proposeHalfLife(30, 0.001);
    expect(p).toBeLessThanOrEqual(45);
  });

  it("never returns < 1", () => {
    const p = proposeHalfLife(30, 0.99);
    expect(p).toBeGreaterThanOrEqual(1);
  });
});
