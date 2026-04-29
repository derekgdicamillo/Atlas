import { describe, test, expect } from "bun:test";
import {
  isEligibleForRewrite,
  buildRewritePrompt,
  sanitizeRewrite,
  rewriteSummary,
  type MemoryForRewrite,
} from "../src/memory-rewrite.ts";

const now = new Date("2026-04-28T12:00:00Z").getTime();
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

describe("memory-rewrite eligibility", () => {
  const base: MemoryForRewrite = {
    id: "m1",
    original_content: "x",
    summary: "x",
    summary_rewritten_at: daysAgo(8),
    access_count_since_rewrite: 5,
  };

  test("eligible when age > 7 AND access >= 5", () => {
    expect(isEligibleForRewrite(base, now)).toBe(true);
  });

  test("not eligible when age > 7 BUT access < 5", () => {
    expect(isEligibleForRewrite({ ...base, access_count_since_rewrite: 4 }, now)).toBe(false);
  });

  test("not eligible when age < 7 EVEN IF access >= 5", () => {
    expect(
      isEligibleForRewrite({ ...base, summary_rewritten_at: daysAgo(6) }, now)
    ).toBe(false);
  });

  test("not eligible at exact 7 day boundary (needs > 7)", () => {
    expect(
      isEligibleForRewrite({ ...base, summary_rewritten_at: daysAgo(7) }, now)
    ).toBe(false);
  });

  test("eligible at age > 7 (e.g. 7.01 days)", () => {
    expect(
      isEligibleForRewrite(
        { ...base, summary_rewritten_at: new Date(now - 7.01 * 86_400_000).toISOString() },
        now
      )
    ).toBe(true);
  });
});

describe("memory-rewrite formatting", () => {
  test("sanitizeRewrite strips markdown fences", () => {
    expect(sanitizeRewrite("```\nhello\n```")).toBe("hello");
    expect(sanitizeRewrite("```markdown\nfoo\n```")).toBe("foo");
  });

  test("sanitizeRewrite caps length at 2000 chars", () => {
    const big = "a".repeat(3000);
    expect(sanitizeRewrite(big).length).toBe(2000);
  });

  test("buildRewritePrompt includes original, current summary, today, contradictions", () => {
    const out = buildRewritePrompt({
      original: "Tirzepatide is $400.",
      currentSummary: "Tirzepatide is $400.",
      contradictions: ["April 1: Hallandale price reduced to $320."],
      today: "2026-04-28",
    });
    expect(out).toContain("$400");
    expect(out).toContain("Hallandale");
    expect(out).toContain("2026-04-28");
  });
});

describe("memory-rewrite worker", () => {
  test("rewriteSummary defers retry on critic rejection", async () => {
    const updates: any[] = [];
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: {
                id: "m1",
                original_content: "old",
                summary: "old",
                summary_rewritten_at: daysAgo(10),
                access_count_since_rewrite: 6,
              },
              error: null,
            }),
          }),
        }),
        update: (u: any) => {
          updates.push(u);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      }),
    } as any;
    const callHaiku = async () => ({
      text: "rewritten badly",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const criticize = async () => ({ score: 0.4, flags: ["hallucination"] });
    await rewriteSummary("m1", { supabase: fakeSupabase, callHaiku, criticize, today: "2026-04-28" });
    // Must NOT update the summary; only bump summary_rewritten_at to defer retry.
    const summaryUpdates = updates.filter((u) => "summary" in u);
    const deferUpdates = updates.filter(
      (u) => "summary_rewritten_at" in u && !("summary" in u)
    );
    expect(summaryUpdates).toHaveLength(0);
    expect(deferUpdates).toHaveLength(1);
  });

  test("rewriteSummary commits on critic pass", async () => {
    const updates: any[] = [];
    const fakeSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: {
                id: "m1",
                original_content: "old",
                summary: "old",
                summary_rewritten_at: daysAgo(10),
                access_count_since_rewrite: 6,
              },
              error: null,
            }),
          }),
        }),
        update: (u: any) => {
          updates.push(u);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      }),
    } as any;
    const callHaiku = async () => ({
      text: "AT THE TIME, old. AS OF 2026-04-28, updated summary.",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const criticize = async () => ({ score: 0.85, flags: [] });
    await rewriteSummary("m1", { supabase: fakeSupabase, callHaiku, criticize, today: "2026-04-28" });
    expect(updates[0].summary).toContain("AS OF");
    expect(updates[0].access_count_since_rewrite).toBe(0);
  });
});
