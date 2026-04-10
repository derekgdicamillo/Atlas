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

// All 50 states + DC
const ALL_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DC", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas",
  CA: "California", CO: "Colorado", CT: "Connecticut", DC: "District of Columbia",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
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

/**
 * Extract JSON object from a string that may contain markdown fences or surrounding text.
 * Tries multiple strategies with increasing aggressiveness.
 */
function extractJson(text: string): any {
  const trimmed = text.trim();

  // Strategy 1: Direct parse
  try { return JSON.parse(trimmed); } catch {}

  // Strategy 2: Strip markdown fences
  const fenceStripped = trimmed.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  try { return JSON.parse(fenceStripped); } catch {}

  // Strategy 3: Find the outermost { ... } block
  const firstBrace = fenceStripped.indexOf("{");
  const lastBrace = fenceStripped.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonStr = fenceStripped.substring(firstBrace, lastBrace + 1);
    try { return JSON.parse(jsonStr); } catch {}

    // Strategy 4: Fix common JSON issues — unescaped newlines in strings, trailing commas
    try {
      // Replace literal newlines inside JSON string values (between quotes)
      let fixed = jsonStr
        .replace(/,\s*}/g, "}") // trailing commas before }
        .replace(/,\s*]/g, "]"); // trailing commas before ]
      return JSON.parse(fixed);
    } catch {}

    // Strategy 5: Try to find just the "chunks" array
    const chunksMatch = jsonStr.match(/"chunks"\s*:\s*\[/);
    if (chunksMatch) {
      const arrStart = jsonStr.indexOf("[", chunksMatch.index!);
      // Find matching ] by counting brackets
      let depth = 0;
      let arrEnd = -1;
      for (let i = arrStart; i < jsonStr.length; i++) {
        if (jsonStr[i] === "[") depth++;
        if (jsonStr[i] === "]") depth--;
        if (depth === 0) { arrEnd = i; break; }
      }
      if (arrEnd > arrStart) {
        const arrStr = jsonStr.substring(arrStart, arrEnd + 1);
        try {
          const chunks = JSON.parse(arrStr);
          return { chunks };
        } catch {}
      }
    }
  }

  throw new Error(`No valid JSON found in output (${trimmed.length} chars)`);
}

// Original topics (nightly scraper)
const LEGACY_TOPICS = [
  "medspa_compliance",
  "scope_of_practice",
  "delegation_supervision",
  "business_entity",
] as const;

// New P&P manual topics
const NEW_TOPICS = [
  "laser_regulation",
  "glp1_prescribing",
  "medical_records_retention",
  "esthetician_scope",
  "iv_therapy_regulation",
  "continuing_education",
  "advertising_regulation",
] as const;

const ALL_TOPICS = [...LEGACY_TOPICS, ...NEW_TOPICS] as const;
type Topic = typeof ALL_TOPICS[number];

// advertising_regulation only covers these 15 states
const ADVERTISING_STATES = [
  "TX", "CA", "FL", "NY", "NJ", "PA", "IL", "OH", "GA", "AZ",
  "CO", "NC", "VA", "WA", "TN",
];

// ============================================================
// SCRAPER STATE PERSISTENCE
// ============================================================

interface ScraperState {
  lastVerified: Record<string, string>; // state_code -> ISO date
  roundRobinIndex: number;
  totalUpdates: number;
  totalVerified: number;
  topicProgress?: Record<string, string[]>; // topic -> completed state_codes
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
  const apiKey = SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  const url = `${SUPABASE_URL}/functions/v1/embed`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
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
  const apiKey = SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

  // Check existing chunk
  const checkUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge?state_code=eq.${chunk.state_code}&topic=eq.${chunk.topic}&select=id,chunk_hash`;
  const checkRes = await fetch(checkUrl, {
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
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
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ last_verified_at: new Date().toISOString() }),
    });
    return { updated: false };
  }

  // Content changed or new. Generate embedding.
  const embedding = await embedText(`${chunk.title}\n${chunk.content}`);

  const row: Record<string, any> = {
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

  if (existing.length > 0) {
    // Row exists with different content — PATCH to update
    const updateUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge?id=eq.${existing[0].id}`;
    const res = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      throw new Error(`Update failed: ${res.status} ${await res.text()}`);
    }
  } else {
    // New row — INSERT
    const res = await fetch(`${SUPABASE_URL}/rest/v1/maa_knowledge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      throw new Error(`Insert failed: ${res.status} ${await res.text()}`);
    }
  }

  return { updated: true };
}

// ============================================================
// TOPIC-SPECIFIC PROMPT BUILDERS
// ============================================================

function buildTopicPrompt(stateCode: string, topic: string): string {
  const stateName = STATE_NAMES[stateCode] || stateCode;
  const jurisdiction = stateCode === "DC" ? "the District of Columbia" : stateName;

  const promptMap: Record<string, string> = {
    laser_regulation: `You are researching laser and energy-based device regulations for ${jurisdiction} (${stateCode}) for the S.A.G.E. Practice Advisor knowledge base.

Research ALL of the following and provide structured, factual output with real statute/rule citations:

### Laser/Energy Device Operator Regulations
1. **Which provider types can operate lasers and energy-based devices (IPL, RF microneedling, radiofrequency, etc.)?** For EACH of these: MD/DO, NP, PA, RN, LPN/LVN, esthetician, medical assistant — state whether they can operate and under what conditions.
2. **Required supervision level for each provider type** — direct supervision (physician on-site), indirect (available by phone), or general oversight.
3. **Laser Safety Officer (LSO)** — Is an LSO required by ${stateCode} law or regulation? If not mandated, is it recommended per ANSI Z136.3?
4. **Training/certification requirements** — Specific hour requirements, approved courses, manufacturer training, documented competency.
5. **Esthetician IPL/laser rules** — Can licensed estheticians operate IPL devices in ${stateCode}? What about other energy-based devices? Are there specific device categories (Class II, III, IV) that matter?
6. **Device-specific restrictions** — Any restrictions on specific device types, wavelengths, or treatment areas.
7. **Key statute/rule citations** — The specific medical board rule, cosmetology board rule, advisory opinion number, or state statute that governs this.

Search the ${stateCode} Medical Board, ${stateCode} Board of Cosmetology/Esthetics, and any relevant advisory opinions.

## Output Format
Return ONLY valid JSON (no markdown fences):
{
  "state_code": "${stateCode}",
  "state_name": "${stateName}",
  "chunks": [
    {
      "topic": "laser_regulation",
      "title": "${stateName} Laser/Energy Device Operator Regulations",
      "content": "Comprehensive content (400-600 words) covering ALL points above. Use bold headers for sections. Include specific statute/rule numbers.",
      "source_name": "Primary regulatory board name",
      "source_url": "Primary board URL"
    }
  ]
}

Be factual and specific. Include actual statute numbers, board rule numbers, and advisory opinion references. If ${stateCode} has no state-specific laser regulation, note that federal standards and ANSI Z136.3 apply, and state which board to contact for clarification.`,

    glp1_prescribing: `You are researching GLP-1 receptor agonist prescribing rules for weight management in ${jurisdiction} (${stateCode}) for the S.A.G.E. Practice Advisor knowledge base.

Research ALL of the following:

### GLP-1 Prescribing for Medical Weight Management
1. **Who can prescribe GLP-1s** (semaglutide, tirzepatide, liraglutide) for weight management — MD, DO, NP, PA? Under what authority?
2. **NP prescriptive authority** — Does ${stateCode} require a collaborative/supervisory agreement for NPs to prescribe weight management medications? Full practice, reduced practice, or restricted practice state?
3. **Weight management program requirements** — Any state-specific requirements for operating a weight management program (required lab work, BMI thresholds for prescribing, mandated follow-up schedules, nutrition counseling requirements)?
4. **Compounding pharmacy regulations** — Can practices in ${stateCode} use compounded semaglutide or tirzepatide? What is the ${stateCode} pharmacy board's position on 503A vs 503B compounding? Any state-specific compounding restrictions beyond federal?
5. **Telehealth prescribing rules** — Can GLP-1s be prescribed via telehealth in ${stateCode}? Any in-person visit requirements? DEA/Ryan Haight Act considerations (GLP-1s are not controlled but state rules may add requirements).
6. **Key citations** — State medical practice act, nursing practice act prescriptive authority section, pharmacy board compounding rules.

## Output Format
Return ONLY valid JSON (no markdown fences):
{
  "state_code": "${stateCode}",
  "state_name": "${stateName}",
  "chunks": [
    {
      "topic": "glp1_prescribing",
      "title": "${stateName} GLP-1 Prescribing Rules for Weight Management",
      "content": "Comprehensive content (400-600 words). Bold headers for sections. Specific statute/rule citations.",
      "source_name": "Primary board name",
      "source_url": "Primary board URL"
    }
  ]
}

Be factual. If ${stateCode} has no specific weight management prescribing rules beyond general prescriptive authority, state that clearly and cite the general prescriptive authority statute.`,

    medical_records_retention: `You are researching medical records retention requirements for ${jurisdiction} (${stateCode}) for the S.A.G.E. Practice Advisor knowledge base.

Research ALL of the following:

### Medical Records Retention
1. **Minimum retention period for adult patient records** — How many years after last visit/treatment?
2. **Minor patient records** — Retention period (often until age of majority + X years). What is the age of majority in ${stateCode}?
3. **What constitutes a medical record** — ${stateCode}'s definition. Does it include before/after photos, consent forms, treatment notes, financial records?
4. **Electronic vs. physical records** — Any ${stateCode}-specific requirements for electronic health records? Backup requirements?
5. **Destruction/disposal requirements** — How must records be destroyed (shredding, certified destruction)? Must patients be notified before destruction?
6. **Cosmetic/aesthetic procedure documentation** — Any specific requirements for medspa or cosmetic procedure records beyond standard medical records?
7. **Key statute/regulation citations** — The specific state statute or regulation governing medical records retention.

## Output Format
Return ONLY valid JSON (no markdown fences):
{
  "state_code": "${stateCode}",
  "state_name": "${stateName}",
  "chunks": [
    {
      "topic": "medical_records_retention",
      "title": "${stateName} Medical Records Retention Requirements",
      "content": "Comprehensive content (300-500 words). Bold headers. Specific statute citations.",
      "source_name": "Primary regulatory body",
      "source_url": "URL"
    }
  ]
}

Be factual. Include actual statute numbers. If ${stateCode} defers to federal HIPAA minimums, state that explicitly with the HIPAA citation.`,

    esthetician_scope: `You are researching licensed esthetician scope of practice for ${jurisdiction} (${stateCode}) for the S.A.G.E. Practice Advisor knowledge base.

Research ALL of the following:

### Esthetician Scope of Practice
1. **Procedures estheticians CAN perform** — chemical peels (what strength/depth?), microdermabrasion, dermaplaning, LED light therapy, microcurrent, ultrasound, body wraps, lash extensions, waxing, facials. Be specific about each.
2. **Procedures explicitly PROHIBITED** — laser, IPL, injectables, microneedling with serums, RF devices, anything penetrating below the epidermis.
3. **Master/medical esthetician license** — Does ${stateCode} offer a master esthetician, medical esthetician, or advanced esthetician license? What additional procedures does it authorize?
4. **Supervision in medical settings** — When an esthetician works in a medspa under physician oversight, what additional procedures (if any) can they perform? Does this expand their scope?
5. **Microneedling** — Can estheticians perform microneedling in ${stateCode}? At what needle depth? With or without serums/PRP?
6. **IPL/laser** — Can estheticians operate IPL or laser devices? Under supervision? (Cross-reference with laser regulation.)
7. **Training/CE for medical settings** — Any additional training or CE requirements for estheticians working in medical aesthetics?
8. **Key citations** — Cosmetology/esthetics practice act, board rules, advisory opinions.

## Output Format
Return ONLY valid JSON (no markdown fences):
{
  "state_code": "${stateCode}",
  "state_name": "${stateName}",
  "chunks": [
    {
      "topic": "esthetician_scope",
      "title": "${stateName} Esthetician Scope of Practice",
      "content": "Comprehensive content (400-600 words). Bold headers. Specific statute/rule citations.",
      "source_name": "Board of cosmetology/esthetics",
      "source_url": "Board URL"
    }
  ]
}

Be factual. Include actual statute numbers and board rule references.`,

    iv_therapy_regulation: `You are researching IV vitamin infusion therapy regulations for ${jurisdiction} (${stateCode}) for the S.A.G.E. Practice Advisor knowledge base.

Research ALL of the following:

### IV Therapy Administration Rules
1. **Who can initiate IV access** — RN, LPN/LVN, paramedic, other? State nursing board position.
2. **Who can administer IV infusions** — Which provider types can push/drip IV vitamins, NAD+, glutathione, Myers' cocktail, etc.?
3. **Physician order requirements** — Is a physician (MD/DO/NP/PA) order required for each individual patient? Can standing orders/protocols be used?
4. **Supervision requirements** — Must a physician/NP be on-site during IV infusions? Available by phone? General oversight?
5. **Facility licensing** — Does ${stateCode} require a specific facility license to operate an IV therapy clinic or offer IV therapy in a medspa? Any pharmacy license requirements?
6. **Substance restrictions** — Any ${stateCode}-specific restrictions on what can be infused (vitamins, minerals, amino acids, NAD+, glutathione, high-dose vitamin C)?
7. **Nursing board position** — Has the ${stateCode} nursing board issued advisory opinions or position statements on IV therapy in non-hospital settings?
8. **Key citations** — Nursing practice act, medical board rules, facility licensing statutes.

## Output Format
Return ONLY valid JSON (no markdown fences):
{
  "state_code": "${stateCode}",
  "state_name": "${stateName}",
  "chunks": [
    {
      "topic": "iv_therapy_regulation",
      "title": "${stateName} IV Therapy Regulation",
      "content": "Comprehensive content (300-500 words). Bold headers. Specific citations.",
      "source_name": "Primary board",
      "source_url": "Board URL"
    }
  ]
}

If ${stateCode} has no IV-therapy-specific regulation, state that general nursing scope and medical practice act apply, cite those, and note which board to contact.`,

    continuing_education: `You are researching continuing education requirements for medspa providers in ${jurisdiction} (${stateCode}) for the S.A.G.E. Practice Advisor knowledge base.

Research ALL of the following for EACH provider type:

### CE Requirements for MedSpa Providers
1. **MD/DO** — Total CE hours per renewal cycle, cycle length (1yr/2yr/3yr), mandatory topics (opioid prescribing, ethics, cultural competency, pain management, etc.)
2. **NP (APRN)** — CE hours, cycle length, pharmacology CE requirements, certification renewal vs. license renewal
3. **PA** — CE hours, cycle length, NCCPA recertification requirements, ${stateCode}-specific additions
4. **RN** — CE hours, cycle length, mandatory topics
5. **Esthetician** — CE hours, cycle length, mandatory topics, any medspa-specific CE
6. **Laser/energy device CE** — Is laser-specific CE required for any provider type?
7. **Injectable CE** — Is injectable-specific training/CE required or recommended?
8. **Accepted CE providers** — ACCME, ANCC, AAPA, state-approved providers, etc.

## Output Format
Return ONLY valid JSON (no markdown fences):
{
  "state_code": "${stateCode}",
  "state_name": "${stateName}",
  "chunks": [
    {
      "topic": "continuing_education",
      "title": "${stateName} CE Requirements for MedSpa Providers",
      "content": "Comprehensive content (400-600 words). Bold headers per provider type. Specific hour counts and cycle lengths.",
      "source_name": "Primary licensing board",
      "source_url": "Board URL"
    }
  ]
}

Be specific with hour counts and cycle lengths. These are factual data points that practitioners rely on.`,

    advertising_regulation: `You are researching state-specific medical advertising regulations for ${jurisdiction} (${stateCode}) for the S.A.G.E. Practice Advisor knowledge base. Focus on rules BEYOND federal FTC requirements.

Research ALL of the following:

### Medical Advertising Regulations
1. **Medical board advertising rules** — Does the ${stateCode} medical board have specific advertising rules for physicians and medical practices? What are the key restrictions?
2. **"Board certified" claims** — Can practitioners claim "board certified" in ${stateCode}? Must they specify which board? Any restrictions on specialty claims?
3. **Before/after photo requirements** — Does ${stateCode} require specific disclaimers on before/after photos? Any restrictions on photo manipulation? Required consent language?
4. **Testimonial restrictions** — Can ${stateCode} medical practices use patient testimonials? Are disclaimers required? Any restrictions on guarantees of results?
5. **Off-label marketing** — Any ${stateCode}-specific rules on advertising off-label uses (beyond FDA restrictions)?
6. **Social media rules** — Has the ${stateCode} medical board issued guidance on social media advertising? Any platform-specific rules?
7. **Penalties** — What are the penalties for advertising violations (fines, license action, etc.)?
8. **Key citations** — Medical practice act advertising sections, board rules, attorney general guidelines.

## Output Format
Return ONLY valid JSON (no markdown fences):
{
  "state_code": "${stateCode}",
  "state_name": "${stateName}",
  "chunks": [
    {
      "topic": "advertising_regulation",
      "title": "${stateName} Medical Advertising Regulations",
      "content": "Comprehensive content (400-600 words). Bold headers. Specific statute/rule citations.",
      "source_name": "Medical board or AG office",
      "source_url": "URL"
    }
  ]
}

Focus on rules that go BEYOND federal FTC guidelines. If ${stateCode} largely defers to FTC, state that and note any additional state requirements.`,
  };

  return promptMap[topic] || buildResearchPrompt(stateCode);
}

// ============================================================
// SHARED TYPES
// ============================================================

export interface TopicBatchResult extends MaaScraperResult {
  topic: string;
  statesSkipped: string[]; // already done (resume)
}

// ============================================================
// GEMINI BATCH RUNNER (fast, cheap, no session limits)
// ============================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_BATCH_SIZE = 5; // states per API call

/**
 * Build a Gemini-optimized prompt for a batch of states on one topic.
 * Uses the same data requirements as the per-state prompts but formatted
 * for multi-state output.
 */
function buildGeminiBatchPrompt(states: string[], topic: string): string {
  const stateList = states.map((s) => `${STATE_NAMES[s] || s} (${s})`).join(", ");

  const topicInstructions: Record<string, string> = {
    laser_regulation: `## Required Data Points Per State (MUST cover ALL)
1. **Authorized Operators**: For EACH — MD/DO, NP/APRN, PA, RN, LPN/LVN, licensed esthetician, medical assistant — can they operate laser/energy devices? Under what conditions?
2. **Supervision Levels**: Direct (on-site), indirect (by phone), general oversight — per provider type
3. **Laser Safety Officer**: Required by state law? Recommended per ANSI Z136.3?
4. **Training/Certification**: Hour requirements, approved courses, manufacturer training, competency documentation
5. **Esthetician IPL/Laser Rules**: Can estheticians operate IPL? Other energy devices? Under what conditions? Master/medical esthetician distinction?
6. **Device Restrictions**: Restrictions on device types, wavelengths, classes (II, III, IV)
7. **Key Citations**: Specific statute numbers, board rule numbers, advisory opinions`,

    glp1_prescribing: `## Required Data Points Per State (MUST cover ALL)
1. **Who Can Prescribe GLP-1s** (semaglutide, tirzepatide, liraglutide) for weight management — MD, DO, NP, PA? Under what authority?
2. **NP Prescriptive Authority**: Collaborative/supervisory agreement required? Full, reduced, or restricted practice state?
3. **Weight Management Program Requirements**: Required lab work, BMI thresholds, follow-up schedules, nutrition counseling mandates
4. **Compounding Regulations**: Can practices use compounded semaglutide/tirzepatide? State pharmacy board position on 503A vs 503B compounding?
5. **Telehealth Prescribing**: Can GLP-1s be prescribed via telehealth? In-person visit requirements?
6. **Key Citations**: Medical practice act, nursing prescriptive authority, pharmacy board compounding rules`,

    medical_records_retention: `## Required Data Points Per State (MUST cover ALL)
1. **Adult Record Retention**: Minimum years after last visit/treatment
2. **Minor Records**: Retention period (often age of majority + X years). What is age of majority?
3. **What Constitutes a Record**: State definition — includes before/after photos, consent forms, financial records?
4. **Electronic vs Physical**: Any EHR-specific requirements? Backup requirements?
5. **Destruction Requirements**: How must records be destroyed? Patient notification before destruction?
6. **Cosmetic/Aesthetic Specifics**: Any medspa-specific documentation requirements?
7. **Key Citations**: Specific statute or regulation numbers`,

    esthetician_scope: `## Required Data Points Per State (MUST cover ALL)
1. **Permitted Procedures**: Chemical peels (what strength?), microdermabrasion, dermaplaning, LED, microcurrent, ultrasound, body wraps, facials — be specific
2. **Prohibited Procedures**: Laser, IPL, injectables, microneedling with serums, RF — which are explicitly banned?
3. **Master/Medical Esthetician**: Does this license exist? What does it add?
4. **Supervision in Medical Settings**: Can estheticians perform additional procedures under physician oversight?
5. **Microneedling**: Can estheticians perform it? At what depth? With serums/PRP?
6. **IPL/Laser**: Can estheticians operate IPL or laser? Under supervision?
7. **Training/CE**: Additional requirements for medical settings?
8. **Key Citations**: Cosmetology/esthetics practice act, board rules, advisory opinions`,

    iv_therapy_regulation: `## Required Data Points Per State (MUST cover ALL)
1. **IV Access Initiation**: Who can start an IV — RN, LPN/LVN, paramedic, other?
2. **IV Administration**: Who can administer infusions (vitamins, NAD+, glutathione, Myers' cocktail)?
3. **Physician Orders**: Required per patient? Standing orders/protocols allowed?
4. **Supervision**: Physician/NP on-site required? Available by phone?
5. **Facility Licensing**: Specific license needed for IV therapy clinic or medspa IV services?
6. **Substance Restrictions**: Restrictions on what can be infused?
7. **Nursing Board Position**: Advisory opinions on IV therapy in non-hospital settings?
8. **Key Citations**: Nursing practice act, medical board rules, facility licensing statutes`,

    continuing_education: `## Required Data Points Per State (MUST cover ALL for EACH provider type)
1. **MD/DO**: CE hours per cycle, cycle length, mandatory topics (opioids, ethics, cultural competency, etc.)
2. **NP/APRN**: CE hours, cycle, pharmacology CE, certification vs license renewal
3. **PA**: CE hours, cycle, NCCPA recertification, state additions
4. **RN**: CE hours, cycle, mandatory topics
5. **Esthetician**: CE hours, cycle, mandatory topics, medspa-specific CE
6. **Laser/Energy CE**: Required for any provider type?
7. **Injectable CE**: Required or recommended?
8. **Accepted Providers**: ACCME, ANCC, AAPA, state-approved, etc.`,

    advertising_regulation: `## Required Data Points Per State (MUST cover ALL)
1. **Medical Board Advertising Rules**: Specific restrictions for physicians and medical practices
2. **"Board Certified" Claims**: Can practitioners claim it? Must specify which board?
3. **Before/After Photos**: Disclaimer requirements? Photo manipulation restrictions?
4. **Testimonial Restrictions**: Can practices use testimonials? Disclaimers required? Guarantee restrictions?
5. **Off-Label Marketing**: State-specific rules beyond FDA?
6. **Social Media Rules**: Board guidance on social media advertising?
7. **Penalties**: Fines, license action for violations?
8. **Key Citations**: Medical practice act advertising sections, board rules, AG guidelines`,
  };

  const instructions = topicInstructions[topic] || topicInstructions["laser_regulation"];

  return `You are a regulatory research specialist compiling state-by-state medical regulations for a compliance knowledge base used by medical spa owners and practitioners.

## Task
Research ${topic.replace(/_/g, " ")} regulations for these states: ${stateList}

${instructions}

## Output Requirements
- Each state chunk MUST be 400-600 words minimum with substantive detail
- Include SPECIFIC statute/rule numbers (e.g., "Neb. Rev. Stat. § 38-2053"), not generic references
- Use **bold headers** for sections within content
- If a state has no specific regulation for this topic, explicitly state that and cite what general rules apply
- Cover ALL states listed — do not skip any

Return ONLY valid JSON (no markdown fences, no explanatory text before or after):
{
  "chunks": [
    {
      "state_code": "XX",
      "topic": "${topic}",
      "title": "[Full State Name] ${topic.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}",
      "content": "Detailed regulatory content with statute citations...",
      "source_name": "Primary regulatory board name",
      "source_url": "https://board.website.url"
    }
  ]
}`;
}

/**
 * Call Gemini API for a batch of states. Retries once without google_search if JSON parsing fails.
 */
async function callGemini(prompt: string, useSearch: boolean = true): Promise<any> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const body: any = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 16384,
      responseMimeType: "application/json",
    },
  };
  if (useSearch) {
    body.tools = [{ google_search: {} }];
    // Can't use responseMimeType with google_search, so remove it
    delete body.generationConfig.responseMimeType;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const textParts = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean) || [];
  const fullText = textParts.join("");

  if (!fullText) {
    throw new Error("Gemini returned empty response");
  }

  try {
    return extractJson(fullText);
  } catch (parseErr) {
    if (useSearch) {
      // Retry without google_search — forces clean JSON output via responseMimeType
      warn("maa-scraper", "Gemini JSON parse failed with search, retrying without search (JSON mode)...");
      return callGemini(prompt, false);
    }
    throw parseErr;
  }
}

/**
 * Run a topic batch using Gemini Flash. Much faster and cheaper than Claude CLI.
 * Processes states in batches of GEMINI_BATCH_SIZE (default 5).
 */
export async function runGeminiBatch(
  topic: string,
  states?: string[],
): Promise<TopicBatchResult> {
  const hasApiKey = SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !hasApiKey) {
    return { topic, statesProcessed: [], statesSkipped: [], chunksUpdated: 0, chunksVerified: 0, errors: ["Missing Supabase credentials"] };
  }
  if (!GEMINI_API_KEY) {
    return { topic, statesProcessed: [], statesSkipped: [], chunksUpdated: 0, chunksVerified: 0, errors: ["Missing GEMINI_API_KEY"] };
  }

  let targetStates = states || [...ALL_STATES];
  if (topic === "advertising_regulation" && !states) {
    targetStates = [...ADVERTISING_STATES];
  }

  // Resume support
  const scraperState = await loadScraperState();
  if (!scraperState.topicProgress) scraperState.topicProgress = {};
  const completed = scraperState.topicProgress[topic] || [];

  const result: TopicBatchResult = {
    topic,
    statesProcessed: [],
    statesSkipped: targetStates.filter((s) => completed.includes(s)),
    chunksUpdated: 0,
    chunksVerified: 0,
    errors: [],
  };

  const remaining = targetStates.filter((s) => !completed.includes(s));
  if (remaining.length === 0) {
    info("maa-scraper", `[${topic}] All ${targetStates.length} states already completed.`);
    return result;
  }

  info("maa-scraper", `[${topic}] Gemini batch: ${remaining.length} states remaining (${result.statesSkipped.length} already done)`);

  // Process in batches
  for (let i = 0; i < remaining.length; i += GEMINI_BATCH_SIZE) {
    const batch = remaining.slice(i, i + GEMINI_BATCH_SIZE);
    const batchNum = Math.floor(i / GEMINI_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(remaining.length / GEMINI_BATCH_SIZE);

    try {
      info("maa-scraper", `[${topic}] Batch ${batchNum}/${totalBatches}: ${batch.join(", ")}`);

      const prompt = buildGeminiBatchPrompt(batch, topic);
      const parsed = await callGemini(prompt);

      if (!parsed.chunks || !Array.isArray(parsed.chunks)) {
        result.errors.push(`Batch ${batchNum}: No chunks returned`);
        warn("maa-scraper", `[${topic}] Batch ${batchNum}: No chunks in response`);
        continue;
      }

      // Upsert each chunk
      for (const chunk of parsed.chunks) {
        const stateCode = chunk.state_code?.toUpperCase();
        if (!stateCode || !batch.includes(stateCode)) {
          warn("maa-scraper", `[${topic}] Unexpected state_code: ${chunk.state_code}`);
          continue;
        }

        try {
          const { updated } = await upsertChunk({
            state_code: stateCode,
            topic: chunk.topic || topic,
            title: chunk.title,
            content: chunk.content,
            source_name: chunk.source_name || null,
            source_url: chunk.source_url || null,
          });

          if (updated) result.chunksUpdated++;
          else result.chunksVerified++;

          result.statesProcessed.push(stateCode);

          // Track completion
          if (!scraperState.topicProgress![topic]) scraperState.topicProgress![topic] = [];
          if (!scraperState.topicProgress![topic].includes(stateCode)) {
            scraperState.topicProgress![topic].push(stateCode);
          }
        } catch (upsertErr) {
          result.errors.push(`${stateCode}: ${upsertErr}`);
          warn("maa-scraper", `[${topic}] Upsert error ${stateCode}: ${upsertErr}`);
        }
      }

      // Check for states Gemini missed in this batch
      const returnedStates = parsed.chunks.map((c: any) => c.state_code?.toUpperCase());
      const missed = batch.filter((s) => !returnedStates.includes(s));
      if (missed.length > 0) {
        warn("maa-scraper", `[${topic}] Batch ${batchNum} missed states: ${missed.join(", ")}`);
        result.errors.push(`Batch ${batchNum} missed: ${missed.join(", ")}`);
      }

      // Save progress after each batch
      scraperState.totalUpdates += result.chunksUpdated;
      await saveScraperState(scraperState);

      info("maa-scraper", `[${topic}] Batch ${batchNum} done. Total: ${completed.length + result.statesProcessed.length}/${targetStates.length}`);

      // Small delay between batches to be nice to Gemini rate limits
      if (i + GEMINI_BATCH_SIZE < remaining.length) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      result.errors.push(`Batch ${batchNum} (${batch.join(",")}): ${err}`);
      logError("maa-scraper", `[${topic}] Batch ${batchNum} error: ${err}`);
      // Wait a bit longer on error (rate limit?)
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  info("maa-scraper", `[${topic}] Complete: ${result.statesProcessed.length} processed, ${result.chunksUpdated} updated, ${result.errors.length} errors`);
  return result;
}

// ============================================================
// BATCH TOPIC RUNNER (Claude CLI — legacy, slower)
// ============================================================

/**
 * Run a specific topic across all states via Claude CLI. Supports resume.
 * LEGACY: Prefer runGeminiBatch() which is ~100x faster and doesn't use session limits.
 */
export async function runTopicBatch(
  topic: string,
  states?: string[],
): Promise<TopicBatchResult> {
  const hasApiKey = SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !hasApiKey) {
    return {
      topic,
      statesProcessed: [],
      statesSkipped: [],
      chunksUpdated: 0,
      chunksVerified: 0,
      errors: ["Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY"],
    };
  }

  // Determine which states to process
  let targetStates = states || [...ALL_STATES];
  if (topic === "advertising_regulation" && !states) {
    targetStates = [...ADVERTISING_STATES];
  }

  // Load state for resume support
  const scraperState = await loadScraperState();
  if (!scraperState.topicProgress) scraperState.topicProgress = {};
  const completed = scraperState.topicProgress[topic] || [];

  const result: TopicBatchResult = {
    topic,
    statesProcessed: [],
    statesSkipped: [],
    chunksUpdated: 0,
    chunksVerified: 0,
    errors: [],
  };

  const remaining = targetStates.filter((s) => !completed.includes(s));
  result.statesSkipped = targetStates.filter((s) => completed.includes(s));

  if (remaining.length === 0) {
    info("maa-scraper", `[${topic}] All ${targetStates.length} states already completed.`);
    return result;
  }

  info("maa-scraper", `[${topic}] Starting batch: ${remaining.length} states remaining (${result.statesSkipped.length} already done)`);

  for (let i = 0; i < remaining.length; i++) {
    const stateCode = remaining[i];
    const stateName = STATE_NAMES[stateCode] || stateCode;

    try {
      info("maa-scraper", `[${topic}] (${i + 1}/${remaining.length}) Researching ${stateName} (${stateCode})...`);

      const prompt = buildTopicPrompt(stateCode, topic);
      const output = await runPrompt(prompt, MODELS.sonnet);

      // Parse structured output — extract JSON from potentially mixed text
      let parsed: any;
      try {
        parsed = extractJson(output);
      } catch (parseErr) {
        result.errors.push(`${stateCode}: Failed to parse output`);
        warn("maa-scraper", `[${topic}] ${stateCode} parse error: ${parseErr}`);
        warn("maa-scraper", `[${topic}] ${stateCode} output (first 500 chars): ${output.substring(0, 500)}`);
        continue;
      }

      if (!parsed.chunks || !Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
        result.errors.push(`${stateCode}: No chunks in output`);
        warn("maa-scraper", `[${topic}] ${stateCode}: No chunks returned`);
        continue;
      }

      // Upsert chunks
      for (const chunk of parsed.chunks) {
        try {
          const { updated } = await upsertChunk({
            state_code: stateCode,
            topic: chunk.topic || topic,
            title: chunk.title,
            content: chunk.content,
            source_name: chunk.source_name || null,
            source_url: chunk.source_url || null,
          });

          if (updated) {
            result.chunksUpdated++;
          } else {
            result.chunksVerified++;
          }
        } catch (upsertErr) {
          result.errors.push(`${stateCode}/${topic}: ${upsertErr}`);
          warn("maa-scraper", `[${topic}] Upsert error ${stateCode}: ${upsertErr}`);
        }
      }

      result.statesProcessed.push(stateCode);

      // Track completion for resume
      if (!scraperState.topicProgress![topic]) scraperState.topicProgress![topic] = [];
      scraperState.topicProgress![topic].push(stateCode);
      scraperState.totalUpdates += result.chunksUpdated;
      scraperState.totalVerified += result.chunksVerified;
      await saveScraperState(scraperState);

      info("maa-scraper", `[${topic}] ${stateCode} done. Progress: ${completed.length + result.statesProcessed.length}/${targetStates.length}`);
    } catch (err) {
      result.errors.push(`${stateCode}: ${err}`);
      logError("maa-scraper", `[${topic}] Error processing ${stateCode}: ${err}`);
    }
  }

  info("maa-scraper", `[${topic}] Batch complete: ${result.statesProcessed.length} processed, ${result.chunksUpdated} updated, ${result.errors.length} errors`);
  return result;
}

// ============================================================
// CLI ENTRY POINT
// ============================================================

/**
 * Run from command line:
 *   bun run src/maa-scraper.ts --topic laser_regulation                    (Gemini, default)
 *   bun run src/maa-scraper.ts --topic laser_regulation --engine claude     (Claude CLI, legacy)
 *   bun run src/maa-scraper.ts --topic laser_regulation --states TX,CA,FL   (subset)
 *   bun run src/maa-scraper.ts --topic all                                  (all 7 topics sequentially)
 */
async function cliMain() {
  const args = process.argv.slice(2);
  const topicIdx = args.indexOf("--topic");
  const statesIdx = args.indexOf("--states");
  const engineIdx = args.indexOf("--engine");

  if (topicIdx === -1 || !args[topicIdx + 1]) {
    console.log("Usage: bun run src/maa-scraper.ts --topic <topic_name|all> [--states TX,CA,FL] [--engine gemini|claude]");
    console.log(`\nAvailable topics: ${ALL_TOPICS.join(", ")}, all`);
    console.log("Default engine: gemini (fast, cheap). Use --engine claude for legacy Claude CLI.");
    process.exit(1);
  }

  const topicArg = args[topicIdx + 1];
  const engine = engineIdx !== -1 && args[engineIdx + 1] === "claude" ? "claude" : "gemini";
  const states = statesIdx !== -1 && args[statesIdx + 1]
    ? args[statesIdx + 1].split(",").map((s) => s.trim().toUpperCase())
    : undefined;

  // Determine topics to process
  const topics = topicArg === "all" ? [...NEW_TOPICS] : [topicArg];

  for (const topic of topics) {
    if (!ALL_TOPICS.includes(topic as any)) {
      console.error(`Unknown topic: ${topic}\nAvailable: ${ALL_TOPICS.join(", ")}`);
      process.exit(1);
    }
  }

  for (const topic of topics) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Starting: topic=${topic}, engine=${engine}, states=${states ? states.join(",") : "all"}`);
    console.log("=".repeat(60) + "\n");

    const result = engine === "claude"
      ? await runTopicBatch(topic, states)
      : await runGeminiBatch(topic, states);

    console.log("\n--- RESULTS ---");
    console.log(`Topic: ${result.topic}`);
    console.log(`States processed: ${result.statesProcessed.length}`);
    console.log(`States skipped (already done): ${result.statesSkipped.length}`);
    console.log(`Chunks updated: ${result.chunksUpdated}`);
    console.log(`Chunks verified (unchanged): ${result.chunksVerified}`);
    if (result.errors.length > 0) {
      console.log(`Errors (${result.errors.length}):`);
      result.errors.forEach((e) => console.log(`  - ${e}`));
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("maa-scraper.ts")) {
  cliMain().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

// ============================================================
// MAIN SCRAPER FUNCTION (nightly, original 4 topics)
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
        parsed = extractJson(output);
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
    `SAGE KB: ${verifiedCount}/51 jurisdictions verified, ${state.totalUpdates} total updates`,
  ];

  if (staleStates.length > 0) {
    lines.push(`Stale (>30 days): ${staleStates.join(", ")}`);
  }

  return lines.join("\n");
}
