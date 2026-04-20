import { describe, test, expect } from "bun:test";
import { isSpaShell } from "../src/freshness-feed.ts";

describe("freshness-feed — SPA shell detection", () => {
  test("flags Next.js skeleton", () => {
    const html = '<html><head><script src="/_next/static/chunks/x.js"></script></head><body><div id="__next"></div></body></html>';
    expect(isSpaShell(html)).toBe(true);
  });

  test("flags __NEXT_DATA__ marker", () => {
    const html = '<html><body><script id="__NEXT_DATA__">{}</script></body></html>';
    expect(isSpaShell(html)).toBe(true);
  });

  test("flags Fern-hosted docs", () => {
    const html = '<html><head><link href="https://files.buildwithfern.com/x.css" /></head><body></body></html>';
    expect(isSpaShell(html)).toBe(true);
  });

  test("flags React CRA-style root", () => {
    const html = '<html><body><div id="root"></div><script src="/static/main.js"></script><script src="/static/vendor.js"></script><script src="/static/runtime.js"></script></body></html>';
    expect(isSpaShell(html)).toBe(true);
  });

  test("does NOT flag plain markdown llms.txt", () => {
    const md = "# Claude Code Docs\n\n## Agents\nFoo bar baz\n## Tools\nMany words of actual content here that describe the thing in real substantive detail.\n".repeat(10);
    expect(isSpaShell(md)).toBe(false);
  });

  test("does NOT flag real HTML docs with substantive content", () => {
    const html = "<html><head><title>Docs</title></head><body><h1>API Reference</h1>" +
      ("<p>Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(200)) +
      "</body></html>";
    expect(isSpaShell(html)).toBe(false);
  });
});
