import { describe, test, expect } from "bun:test";
import { isTopicChange, shouldInjectTier1, type TurnContext } from "../src/tiered-context.ts";

describe("isTopicChange", () => {
  test("returns true when previous is null (first turn)", () => {
    expect(isTopicChange({ financial: true }, null)).toBe(true);
  });

  test("returns false when same intent flags", () => {
    const flags = { financial: true, pipeline: true };
    expect(isTopicChange(flags, flags)).toBe(false);
  });

  test("returns true when new intent flag appears", () => {
    expect(isTopicChange(
      { financial: true, marketing: true },
      { financial: true, marketing: false },
    )).toBe(true);
  });

  test("returns true when intent flag disappears", () => {
    expect(isTopicChange(
      { financial: true, marketing: false },
      { financial: true, marketing: true },
    )).toBe(true);
  });

  test("returns false when both empty (casual to casual)", () => {
    expect(isTopicChange({}, {})).toBe(false);
  });

  test("returns false when same casual flags", () => {
    expect(isTopicChange(
      { casual: true },
      { casual: true },
    )).toBe(false);
  });

  test("returns true when switching from casual to intent", () => {
    expect(isTopicChange(
      { financial: true },
      { casual: true },
    )).toBe(true);
  });

  test("returns true when intent substitution at same count", () => {
    expect(isTopicChange(
      { pipeline: true, marketing: false },
      { pipeline: false, marketing: true },
    )).toBe(true);
  });
});

describe("shouldInjectTier1", () => {
  test("returns true when tiered context disabled (legacy)", () => {
    const ctx: TurnContext = {
      isFirstTurn: false,
      previousIntentFlags: { financial: true },
      tieredContextEnabled: false,
    };
    expect(shouldInjectTier1(ctx, { financial: true })).toBe(true);
  });

  test("returns true on first turn", () => {
    const ctx: TurnContext = {
      isFirstTurn: true,
      previousIntentFlags: null,
      tieredContextEnabled: true,
    };
    expect(shouldInjectTier1(ctx, { financial: true })).toBe(true);
  });

  test("returns false on subsequent turn with same topic", () => {
    const ctx: TurnContext = {
      isFirstTurn: false,
      previousIntentFlags: { financial: true },
      tieredContextEnabled: true,
    };
    expect(shouldInjectTier1(ctx, { financial: true })).toBe(false);
  });

  test("returns true on subsequent turn with topic change", () => {
    const ctx: TurnContext = {
      isFirstTurn: false,
      previousIntentFlags: { financial: true },
      tieredContextEnabled: true,
    };
    expect(shouldInjectTier1(ctx, { marketing: true })).toBe(true);
  });
});

describe("TurnContext type", () => {
  test("type exports correctly", () => {
    const ctx: TurnContext = {
      isFirstTurn: true,
      previousIntentFlags: null,
      tieredContextEnabled: true,
    };
    expect(ctx.isFirstTurn).toBe(true);
  });
});
