import { describe, test, expect } from "bun:test";
import { buildBlogPrompt } from "../src/maa-blog.ts";

describe("buildBlogPrompt", () => {
  test("produces basic prompt without SAGE context", () => {
    const prompt = buildBlogPrompt("Pricing your services", "Business Growth", []);
    expect(prompt).toContain("Pricing your services");
    expect(prompt).toContain("Business Growth");
    expect(prompt).toContain("focusKeyphrase");
    expect(prompt).toContain("metaDescription");
    expect(prompt).toContain("slug");
    expect(prompt).toContain("faq");
    expect(prompt).toContain("tags");
    expect(prompt).not.toContain("actively seeking guidance");
  });

  test("includes SAGE context when provided", () => {
    const prompt = buildBlogPrompt(
      "Hiring & Staffing",
      "Hiring & Staffing",
      ["Previous post title"],
      {
        theme: "Hiring & Staffing",
        concerns: [
          "Compensation structures and fair pay models",
          "Hiring, staffing, and team management",
        ],
      }
    );
    expect(prompt).toContain("actively seeking guidance on hiring & staffing");
    expect(prompt).toContain("Compensation structures and fair pay models");
    expect(prompt).toContain("Previous post title");
    expect(prompt).not.toContain("SAGE");
    expect(prompt).not.toContain("dashboard");
    expect(prompt).not.toContain("member asked");
  });

  test("includes recent titles block", () => {
    const prompt = buildBlogPrompt("Test topic", "Test pillar", [
      "Title One",
      "Title Two",
    ]);
    expect(prompt).toContain("Title One");
    expect(prompt).toContain("Title Two");
    expect(prompt).toContain("avoid duplicating");
  });

  test("requires internal links in prompt", () => {
    const prompt = buildBlogPrompt("Test", "Test", []);
    expect(prompt).toContain("/join");
    expect(prompt).toContain("/resources");
    expect(prompt).toContain("/advisor/");
  });

  test("requires FAQ in prompt", () => {
    const prompt = buildBlogPrompt("Test", "Test", []);
    expect(prompt).toContain("exactly 3 FAQ");
    expect(prompt).toContain("questions practitioners commonly have");
  });
});
