/**
 * Atlas Prime — Freshness Feed
 *
 * Nightly refresh of authoritative docs for every hot domain in
 * data/hot-domains.json. Prefers llms.txt when available; falls back
 * to the changelog URL; falls back to scraping the first authoritative
 * source.
 *
 * Fetch strategy:
 *   1. Plain HTTP fetch (fast, free)
 *   2. Detect if the result is a JS-rendered SPA shell (Next.js / React root
 *      with no real content) — if so, re-fetch via headless Playwright to
 *      render the page and extract visible text.
 *
 * Output: data/fresh-knowledge/<domain>.json with { pulled_at, url, content_hash, text }.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const HOT_DOMAINS_PATH = join(PROJECT_DIR, "data", "hot-domains.json");
const FRESH_DIR = join(PROJECT_DIR, "data", "fresh-knowledge");

interface HotDomainsFile {
  version: number;
  updated_at: string;
  domains: Record<string, {
    half_life_days: number;
    authoritative_sources: string[];
    llms_txt: string | null;
    changelog_url: string | null;
    last_refresh: string | null;
    tier: string;
    triggers: string[];
  }>;
}

export interface RefreshReport {
  domain: string;
  refreshed: boolean;
  urlUsed?: string;
  bytes?: number;
  renderedWith?: "fetch" | "playwright";
  error?: string;
}

// ============================================================
// SPA DETECTION
// ============================================================

/**
 * Heuristic: is this response HTML a SPA skeleton rather than real content?
 * Looks for Next.js / Vite / Create-React-App markers combined with a
 * tiny visible-text payload.
 */
export function isSpaShell(text: string): boolean {
  // Obvious Next.js markers
  if (text.includes("/_next/static/") || text.includes("__NEXT_DATA__")) return true;
  // Vite / React default scaffolding
  if (text.includes('<div id="root"></div>') || text.includes("/@vite/client")) return true;
  // Fern docs platform (used by Brevo, Resend, etc.) — shells can be large due
  // to preload/prefetch blocks, so no size cap. Fern-hosted pages are always SPAs.
  if (text.includes("buildwithfern.com") || text.includes("files.buildwithfern.com")) return true;
  // Stoplight Elements (used by GHL docs)
  if (text.includes("stoplight-elements") || text.includes("elements-stoplight")) return true;
  // Stoplight's React-based docs product (highlevel.stoplight.io)
  if (text.includes("stoplight.io") && text.includes("react")) return true;
  // Fallback: strip tags and measure real text
  const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Shell detected if visible text is under 2000 chars AND the raw HTML
  // is obviously JS-heavy (many <script src> tags)
  const scriptCount = (text.match(/<script\b[^>]*src=/gi) || []).length;
  return stripped.length < 2000 && scriptCount >= 3;
}

// ============================================================
// FETCH STRATEGIES
// ============================================================

const UA = "Mozilla/5.0 (Atlas-Freshness-Feed; +https://pvmedispa.com)";

async function plainFetch(url: string): Promise<string> {
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

async function playwrightFetch(url: string): Promise<string> {
  // Dynamic import so plain-fetch-only environments don't pay the cost
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    // Give client-side content one more tick to settle
    await page.waitForTimeout(500);
    // Prefer innerText (rendered) over innerHTML — smaller, focused on content
    const text = await page.evaluate(() => document.body?.innerText || "");
    return text;
  } finally {
    await browser.close();
  }
}

/**
 * Smart fetch: plain HTTP first, Playwright fallback if the content
 * looks like a SPA shell. Returns { text, renderedWith }.
 */
export async function fetchText(url: string): Promise<{ text: string; renderedWith: "fetch" | "playwright" }> {
  const raw = await plainFetch(url);
  if (!isSpaShell(raw)) {
    return { text: raw, renderedWith: "fetch" };
  }
  // SPA detected — try Playwright
  try {
    const rendered = await playwrightFetch(url);
    if (rendered.length > 1000) {
      return { text: rendered, renderedWith: "playwright" };
    }
    // Rendered content still too thin; keep raw as fallback
    return { text: raw, renderedWith: "fetch" };
  } catch {
    // Playwright failed (not installed, timeout, etc.) — return the raw shell
    return { text: raw, renderedWith: "fetch" };
  }
}

// ============================================================
// REFRESH
// ============================================================

async function refreshDomain(name: string, spec: HotDomainsFile["domains"][string]): Promise<RefreshReport> {
  const candidates = [spec.llms_txt, spec.changelog_url, ...spec.authoritative_sources].filter(
    (x): x is string => !!x
  );
  for (const url of candidates) {
    try {
      const { text, renderedWith } = await fetchText(url);
      // Skip candidates that produced too-thin content — try the next URL
      if (text.length < 500) continue;
      const hash = createHash("sha256").update(text).digest("hex");
      const out = {
        pulled_at: new Date().toISOString(),
        url,
        content_hash: hash,
        rendered_with: renderedWith,
        text: text.slice(0, 200_000), // cap to prevent runaway files
      };
      writeFileSync(join(FRESH_DIR, `${name}.json`), JSON.stringify(out, null, 2));
      return { domain: name, refreshed: true, urlUsed: url, bytes: text.length, renderedWith };
    } catch {
      // try next candidate
      continue;
    }
  }
  return { domain: name, refreshed: false, error: "no candidate URL produced usable content" };
}

export async function refreshAll(): Promise<RefreshReport[]> {
  const file: HotDomainsFile = JSON.parse(readFileSync(HOT_DOMAINS_PATH, "utf-8"));
  const reports: RefreshReport[] = [];
  for (const [name, spec] of Object.entries(file.domains)) {
    reports.push(await refreshDomain(name, spec));
  }
  // Write last_refresh timestamps back to hot-domains.json
  const now = new Date().toISOString();
  for (const r of reports) {
    if (r.refreshed) file.domains[r.domain].last_refresh = now;
  }
  file.updated_at = now;
  writeFileSync(HOT_DOMAINS_PATH, JSON.stringify(file, null, 2));
  return reports;
}

export async function readFresh(domain: string): Promise<{ pulled_at: string; text: string; url: string } | null> {
  try {
    const raw = readFileSync(join(FRESH_DIR, `${domain}.json`), "utf-8");
    const parsed = JSON.parse(raw);
    return { pulled_at: parsed.pulled_at, text: parsed.text, url: parsed.url };
  } catch {
    return null;
  }
}
