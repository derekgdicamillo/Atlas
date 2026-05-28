/**
 * Atlas Prime — Staleness Sentinel
 *
 * Classifies each incoming user message along the staleness axis:
 *   timeless → slow → medium → fast → real_time
 *
 * For 'fast' domains, Atlas is forbidden from answering without a fresh
 * cite from data/fresh-knowledge/<domain>.json or an on-demand fetch.
 *
 * Two-layer design:
 *   1. Trigger-based fallback (free, instant, deterministic) — catches
 *      obvious cases via data/hot-domains.json trigger phrases.
 *   2. Haiku classifier (cheap, fast, catches the non-obvious).
 *      Only invoked if the trigger layer is uncertain.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { callHaiku } from "./haiku-client.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const HOT_DOMAINS_PATH = join(PROJECT_DIR, "data", "hot-domains.json");

export type StalenessTier = "timeless" | "slow" | "medium" | "fast" | "real_time";

export interface HotDomain {
  half_life_days: number;
  authoritative_sources: string[];
  llms_txt: string | null;
  changelog_url: string | null;
  last_refresh: string | null;
  tier: StalenessTier;
  triggers: string[];
}

interface HotDomainsFile {
  version: number;
  updated_at: string;
  domains: Record<string, HotDomain>;
}

let cached: HotDomainsFile | null = null;
function loadDomains(): HotDomainsFile {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(HOT_DOMAINS_PATH, "utf-8"));
  return cached!;
}

export function resetHotDomainsCache(): void { cached = null; }

export interface ClassifyResult {
  tier: StalenessTier;
  matchedDomain?: string;
  confidence: number;
  mustFetch: boolean;
  reason: string;
}

/** Cheap deterministic classifier — always runs. */
export function classifyByTriggers(userMessage: string): ClassifyResult {
  const lower = userMessage.toLowerCase();
  const file = loadDomains();
  let best: { domain: string; spec: HotDomain } | null = null;
  for (const [domain, spec] of Object.entries(file.domains)) {
    for (const trigger of spec.triggers) {
      if (lower.includes(trigger.toLowerCase())) {
        if (!best || spec.half_life_days < best.spec.half_life_days) {
          best = { domain, spec };
        }
      }
    }
  }
  if (best) {
    return {
      tier: best.spec.tier,
      matchedDomain: best.domain,
      confidence: 0.9,
      mustFetch: best.spec.tier === "fast" || best.spec.tier === "real_time",
      reason: `trigger match on '${best.domain}'`,
    };
  }
  return {
    tier: "timeless",
    confidence: 0.6,
    mustFetch: false,
    reason: "no hot-domain trigger matched",
  };
}

/** Full classifier — calls Haiku if triggers are silent or uncertain. */
export async function classify(userMessage: string): Promise<ClassifyResult> {
  const trig = classifyByTriggers(userMessage);
  if (trig.matchedDomain) return trig;

  // No trigger match; ask Haiku.
  try {
    const { text } = await callHaiku({
      system:
        "You classify user messages by knowledge-staleness axis. " +
        "Respond with a single word: timeless, slow, medium, fast, or real_time. " +
        "Guidance: " +
        "timeless = math, physics, classical business strategy, general principles; " +
        "slow = medical fundamentals, long-lived regulations; " +
        "medium = industry trends, recent business context; " +
        "fast = specific SaaS UIs/APIs (GHL, Meta Ads, WordPress, Brevo, Claude Code); " +
        "real_time = news, prices, current events, competitor moves.",
      userMessage,
      maxTokens: 20,
      cacheSystem: true,
      caller: "staleness-sentinel",
    });
    const tier = text.trim().toLowerCase() as StalenessTier;
    const valid: StalenessTier[] = ["timeless", "slow", "medium", "fast", "real_time"];
    if (!valid.includes(tier)) {
      return { ...trig, reason: `haiku returned invalid tier '${text.trim()}'; fell back to triggers` };
    }
    return {
      tier,
      confidence: 0.75,
      mustFetch: tier === "fast" || tier === "real_time",
      reason: `haiku classified as ${tier}`,
    };
  } catch (err) {
    return { ...trig, reason: `haiku failed (${err}); fell back to triggers` };
  }
}
