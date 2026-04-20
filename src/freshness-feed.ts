/**
 * Atlas Prime — Freshness Feed
 *
 * Nightly refresh of authoritative docs for every hot domain in
 * data/hot-domains.json. Prefers llms.txt when available; falls back
 * to the changelog URL; falls back to scraping the first authoritative
 * source.
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
  error?: string;
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      // Some SiteGround-style WAFs block short user agents
      "User-Agent": "Mozilla/5.0 (Atlas-Freshness-Feed; +https://pvmedispa.com)",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

async function refreshDomain(name: string, spec: HotDomainsFile["domains"][string]): Promise<RefreshReport> {
  const candidates = [spec.llms_txt, spec.changelog_url, ...spec.authoritative_sources].filter(
    (x): x is string => !!x
  );
  for (const url of candidates) {
    try {
      const text = await fetchText(url);
      const hash = createHash("sha256").update(text).digest("hex");
      const out = {
        pulled_at: new Date().toISOString(),
        url,
        content_hash: hash,
        text: text.slice(0, 200_000), // cap to prevent runaway files
      };
      writeFileSync(join(FRESH_DIR, `${name}.json`), JSON.stringify(out, null, 2));
      return { domain: name, refreshed: true, urlUsed: url, bytes: text.length };
    } catch (err) {
      // try next candidate
      continue;
    }
  }
  return { domain: name, refreshed: false, error: "no candidate URL succeeded" };
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
