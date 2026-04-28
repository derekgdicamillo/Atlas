/**
 * Dynamic Chrome User-Agent string.
 *
 * Fetches the latest stable Chrome version from Google's version API on first
 * use, caches it for 24 hours. Falls back to a hardcoded version if the API
 * is unreachable.
 */

import { info, warn } from "./logger.ts";

const FALLBACK_VERSION = "136";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const VERSION_API =
  "https://versionhistory.googleapis.com/v1/chrome/platforms/win64/channels/stable/versions?pageSize=1";

let cachedVersion: string | null = null;
let cachedAt = 0;

async function fetchChromeVersion(): Promise<string> {
  try {
    const res = await fetch(VERSION_API, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { versions?: { version?: string }[] };
    const version = data.versions?.[0]?.version?.split(".")[0];
    if (version && /^\d+$/.test(version)) {
      info("chrome-ua", `Fetched latest Chrome version: ${version}`);
      return version;
    }
    throw new Error("Unexpected response shape");
  } catch (err) {
    warn("chrome-ua", `Version API failed, using fallback ${FALLBACK_VERSION}: ${err}`);
    return FALLBACK_VERSION;
  }
}

/** Returns a current Chrome UA string. Caches the version for 24h. */
export async function getChromeUA(): Promise<string> {
  if (!cachedVersion || Date.now() - cachedAt > CACHE_TTL) {
    cachedVersion = await fetchChromeVersion();
    cachedAt = Date.now();
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${cachedVersion}.0.0.0 Safari/537.36`;
}
