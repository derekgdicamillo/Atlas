/**
 * MAA Knowledge Base Scraper
 *
 * Researches state regulatory data for the S.A.G.E. Practice Advisor
 * knowledge base. Called by the Night Shift worker for "maa-scrape" tasks.
 *
 * Strategy:
 *   1. Pick 2-3 states to research/verify tonight (round-robin, priority states weekly)
 *   2. Generate a research prompt for each state
 *   3. Parse structured output and upsert to maa_knowledge via Supabase
 *   4. Track which states have been verified and when
 *
 * Priority states (checked weekly): TX, CA, FL, NY, AZ
 * All others: round-robin cycle (~17 days for all 50)
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { runPrompt } from "./prompt-runner.ts";
import { MODELS } from "./constants.ts";
import { info, warn, error as logError } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const SCRAPER_STATE_FILE = join(DATA_DIR, "maa-scraper-state.json");

// Supabase config (same project as Atlas)
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Priority states get checked weekly
const PRIORITY_STATES = ["TX", "CA", "FL", "NY", "AZ"];

// All 50 states
const ALL_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas",
  CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming",
};

// Topics to extract per state
const TOPICS = [
  "medspa_compliance",
  "scope_of_practice",
  "delegation_supervision",
  "business_entity",
] as const;

type Topic = typeof TOPICS[number];

// ============================================================
// SCRAPER STATE PERSISTENCE
// ============================================================

interface ScraperState {
  lastVerified: Record<string, string>; // state_code -> ISO date
  roundRobinIndex: number;
  totalUpdates: number;
  totalVerified: number;
}

async function loadScraperState(): Promise<ScraperState> {
  try {
    if (existsSync(SCRAPER_STATE_FILE)) {
      const raw = await readFile(SCRAPER_STATE_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch {}
  return { lastVerified: {}, roundRobinIndex: 0, totalUpdates: 0, totalVerified: 0 };
}

async function saveScraperState(state: ScraperState): Promise<void> {
  await writeFile(SCRAPER_STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// STATE SELECTION
// ============================================================

/**
 * Pick which states to research tonight.
 * Priority states if not checked in 7 days, then round-robin others.
 */
export function pickStatesForTonight(scraperState: ScraperState, count: number = 3): string[] {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const selected: string[] = [];

  // Priority states not checked in 7 days
  for (const code of PRIORITY_STATES) {
    if (selected.length >= count) break;
    const lastCheck = scraperState.lastVerified[code];
    if (!lastCheck || new Date(lastCheck).getTime() < sevenDaysAgo) {
      selected.push(code);
    }
  }

  // Fill remaining from round-robin
  const nonPriority = ALL_STATES.filter((s) => !PRIORITY_STATES.includes(s));
  let idx = scraperState.roundRobinIndex % nonPriority.length;

  while (selected.length < count) {
    const candidate = nonPriority[idx];
    if (!selected.includes(candidate)) {
      selected.push(candidate);
    }
    idx = (idx + 1) % nonPriority.length;
  }

  // Update round-robin index
  scraperState.roundRobinIndex = idx;

  return selected;
}

// ============================================================
// RESEARCH PROMPT
// ============================================================

function buildResearchPrompt(stateCode: string): string {
  const stateName = STATE_NAMES[stateCode] || stateCode;

  return `You are researching medical aesthetics regulations for ${stateName} (${stateCode}) for the S.A.G.E. Practice Advisor knowledge base.

Research the following topics and provide structured, factual output with real statute citations. Use web search to find current regulatory information.

## Topics to Research

### 1. MedSpa Compliance (medspa_compliance)
- Can an NP/PA own a medspa in ${stateName}?
- Corporate Practice of Medicine (CPOM) doctrine applicability
- Medical Director requirements (proximity, availability, compensation)
- MSO/management company structure requirements
- Key board rules and statute citations

### 2. Scope of Practice (scope_of_practice)
- NP practice authority level (full/reduced/restricted)
- Collaborative/supervisory agreement requirements
- What procedures NPs can perform independently
- Board of nursing URL and relevant practice act citations
- APRN compact participation status

### 3. Delegation & Supervision (delegation_supervision)
- What can be delegated to RNs, LPNs, medical assistants, estheticians
- Supervision requirements (on-site, available, general)
- Training/certification requirements for delegated procedures
- Specific rules for injectables, lasers, chemical peels

### 4. Business Entity (business_entity)
- Required entity type (LLC, PLLC, PC, Corp)
- State registration requirements
- Professional licensing for entities
- Tax considerations specific to ${stateName}

## Output Format
Return ONLY valid JSON with this structure (no markdown fences):
{
  "state_code": "${stateCode}",
  "state_name": "${stateName}",
  "chunks": [
    {
      "topic": "medspa_compliance",
      "title": "${stateName} MedSpa Compliance Guide",
      "content": "Detailed content here (300-500 words). Include specific statute citations, board rule numbers, URLs.",
      "source_name": "Source board name",
      "source_url": "https://board.url"
    },
    {
      "topic": "scope_of_practice",
      "title": "${stateName} NP Scope of Practice",
      "content": "...",
      "source_name": "...",
      "source_url": "..."
    },
    {
      "topic": "delegation_supervision",
      "title": "${stateName} Delegation & Supervision Rules",
      "content": "...",
      "source_name": "...",
      "source_url": "..."
    },
    {
      "topic": "business_entity",
      "title": "${stateName} MedSpa Business Formation",
      "content": "...",
      "source_name": "...",
      "source_url": "..."
    }
  ]
}

Be factual and specific. Include actual statute numbers (e.g., "Tex. Occ. Code Ann. sec 157.001"), board URLs, and dates where possible. If you cannot find specific information for a topic, note what is unknown and provide the best available guidance.`;
}

// ============================================================
// SUPABASE UPSERT
// ============================================================

interface KnowledgeChunk {
  state_code: string;
  topic: string;
  title: string;
  content: string;
  source_name: string | null;
  source_url: string | null;
}

async function embedText(text: string): Promise<number[]> {
  const url = `${SUPABASE_URL}/functions/v1/embed`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ text: text.substring(0, 2000) }),
  });

  if (!res.ok) {
    throw new Error(`Embed failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.embedding;
}

async function upsertChunk(chunk: KnowledgeChunk): Promise<{ updated: boolean }> {
  const contentHash = createHash("sha256").update(chunk.content).digest("hex");

  // Check existing chunk
  const checkUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge?state_code=eq.${chunk.state_code}&topic=eq.${chunk.topic}&select=id,chunk_hash`;
  const checkRes = await fetch(checkUrl, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const existing = await checkRes.json();

  if (existing.length > 0 && existing[0].chunk_hash === contentHash) {
    // Content unchanged, just update last_verified_at
    const updateUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge?id=eq.${existing[0].id}`;
    await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ last_verified_at: new Date().toISOString() }),
    });
    return { updated: false };
  }

  // Content changed or new. Generate embedding and upsert.
  const embedding = await embedText(`${chunk.title}\n${chunk.content}`);

  const row = {
    state_code: chunk.state_code,
    topic: chunk.topic,
    title: chunk.title,
    content: chunk.content,
    source_url: chunk.source_url,
    source_name: chunk.source_name,
    embedding: JSON.stringify(embedding),
    chunk_hash: contentHash,
    last_verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const upsertUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge`;
  const res = await fetch(upsertUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    throw new Error(`Upsert failed: ${res.status} ${await res.text()}`);
  }

  return { updated: true };
}

// ============================================================
// MAIN SCRAPER FUNCTION
// ============================================================

export interface MaaScraperResult {
  statesProcessed: string[];
  chunksUpdated: number;
  chunksVerified: number;
  errors: string[];
}

/**
 * Run the MAA knowledge scraper for tonight's selected states.
 * Called by the Night Shift worker when processing maa-scrape tasks.
 */
export async function runMaaScraper(): Promise<MaaScraperResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return {
      statesProcessed: [],
      chunksUpdated: 0,
      chunksVerified: 0,
      errors: ["Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"],
    };
  }

  const scraperState = await loadScraperState();
  const states = pickStatesForTonight(scraperState, 3);
  info("maa-scraper", `Tonight's states: ${states.join(", ")}`);

  const result: MaaScraperResult = {
    statesProcessed: [],
    chunksUpdated: 0,
    chunksVerified: 0,
    errors: [],
  };

  for (const stateCode of states) {
    try {
      info("maa-scraper", `Researching ${STATE_NAMES[stateCode]} (${stateCode})...`);

      // Generate research via Claude
      const prompt = buildResearchPrompt(stateCode);
      const output = await runPrompt(prompt, MODELS.sonnet);

      // Parse structured output
      let parsed: any;
      try {
        const cleaned = output.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        result.errors.push(`${stateCode}: Failed to parse output`);
        warn("maa-scraper", `${stateCode} parse error: ${parseErr}`);
        continue;
      }

      if (!parsed.chunks || !Array.isArray(parsed.chunks)) {
        result.errors.push(`${stateCode}: No chunks in output`);
        continue;
      }

      // Upsert each chunk
      for (const chunk of parsed.chunks) {
        try {
          const { updated } = await upsertChunk({
            state_code: stateCode,
            topic: chunk.topic,
            title: chunk.title,
            content: chunk.content,
            source_name: chunk.source_name || null,
            source_url: chunk.source_url || null,
          });

          if (updated) {
            result.chunksUpdated++;
            info("maa-scraper", `  Updated: ${stateCode}/${chunk.topic}`);
          } else {
            result.chunksVerified++;
            info("maa-scraper", `  Verified (unchanged): ${stateCode}/${chunk.topic}`);
          }
        } catch (upsertErr) {
          result.errors.push(`${stateCode}/${chunk.topic}: ${upsertErr}`);
          warn("maa-scraper", `  Upsert error: ${stateCode}/${chunk.topic}: ${upsertErr}`);
        }
      }

      result.statesProcessed.push(stateCode);
      scraperState.lastVerified[stateCode] = new Date().toISOString();
    } catch (err) {
      result.errors.push(`${stateCode}: ${err}`);
      logError("maa-scraper", `Error processing ${stateCode}: ${err}`);
    }
  }

  // Update totals and save state
  scraperState.totalUpdates += result.chunksUpdated;
  scraperState.totalVerified += result.chunksVerified;
  await saveScraperState(scraperState);

  info("maa-scraper", `Done: ${result.statesProcessed.length} states, ${result.chunksUpdated} updated, ${result.chunksVerified} verified, ${result.errors.length} errors`);

  return result;
}

/**
 * Get scraper status for reporting (morning brief).
 */
export async function getScraperStatus(): Promise<string> {
  const state = await loadScraperState();
  const verifiedCount = Object.keys(state.lastVerified).length;
  const staleStates: string[] = [];
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  for (const [code, date] of Object.entries(state.lastVerified)) {
    if (new Date(date).getTime() < thirtyDaysAgo) {
      staleStates.push(code);
    }
  }

  const lines = [
    `SAGE KB: ${verifiedCount}/50 states verified, ${state.totalUpdates} total updates`,
  ];

  if (staleStates.length > 0) {
    lines.push(`Stale (>30 days): ${staleStates.join(", ")}`);
  }

  return lines.join("\n");
}
