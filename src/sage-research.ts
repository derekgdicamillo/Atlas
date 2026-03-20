/**
 * S.A.G.E. Research Engine
 *
 * Orchestrates knowledge acquisition through three tracks:
 * 1. State regulatory sweep (daily 10:30 PM)
 * 2. National topic rotation (daily 10:45 PM)
 * 3. Demand-driven research (Sunday 11 PM)
 *
 * Uses direct Anthropic API with web search for factual research.
 * Quality gate via Haiku before database insertion.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { info, warn, error as logError } from "./logger.ts";
import {
  TOPIC_REGISTRY,
  ALL_STATES,
  STATE_NAMES,
  PRIORITY_STATES,
  getStateTopics,
  getNationalTopics,
  getTopicByCategory,
  type TopicConfig,
} from "./sage-topics.ts";
import { MODELS } from "./constants.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const STATE_FILE = join(DATA_DIR, "sage-research-state.json");
const GAP_REPORT_FILE = join(DATA_DIR, "sage-gap-report.json");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const LOG_TAG = "sage-research";

// ============================================================
// STATE PERSISTENCE
// ============================================================

interface ResearchState {
  stateLastVerified: Record<string, Record<string, string>>; // state_code -> category -> ISO date
  nationalLastVerified: Record<string, string>;               // category -> ISO date
  stateRoundRobinIndex: number;
  nationalRoundRobinIndex: number;
  totalUpdates: number;
  totalVerified: number;
  totalRejected: number;
  lastRunAt: string | null;
}

async function loadState(): Promise<ResearchState> {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(await readFile(STATE_FILE, "utf-8"));
    }
  } catch {}
  return {
    stateLastVerified: {},
    nationalLastVerified: {},
    stateRoundRobinIndex: 0,
    nationalRoundRobinIndex: 0,
    totalUpdates: 0,
    totalVerified: 0,
    totalRejected: 0,
    lastRunAt: null,
  };
}

async function saveState(state: ResearchState): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// ANTHROPIC API WITH WEB SEARCH
// ============================================================

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: any }>;
}

async function runResearchPrompt(prompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: MODELS.sonnet,
      max_tokens: 8192,
      tools: [{ type: "web_search_20250305" }],
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000), // 2 min timeout per research call
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic API ${response.status}: ${body.substring(0, 300)}`);
  }

  const data = await response.json();

  // Extract text from content blocks (may include tool_use results)
  const textBlocks = (data.content || [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text);

  return textBlocks.join("\n").trim();
}

// ============================================================
// QUALITY GATE
// ============================================================

interface QualityEval {
  score: number;
  has_citations: boolean;
  has_specific_data: boolean;
  content_depth: "thin" | "adequate" | "comprehensive";
  issues: string[];
}

async function evaluateChunkQuality(
  content: string,
  title: string,
  category: string,
  stateCode: string | null,
): Promise<QualityEval> {
  const topicConfig = getTopicByCategory(category);
  const criteria = topicConfig?.qualityCriteria?.join(", ") || "accuracy, specificity, depth";

  const prompt = `You are a fact-checker for a medical aesthetics knowledge base.
Evaluate this content chunk for quality.

Category: ${category}
Scope: ${stateCode ? `State (${stateCode})` : "National"}
Quality criteria to check: ${criteria}

Title: ${title}
Content:
${content}

Score 0-1 on:
1. Source citations (statute numbers, board URLs, org references)
2. Specificity (concrete numbers, dates, requirements vs vague guidance)
3. Depth (covers the topic thoroughly vs surface-level)
4. Accuracy signals (consistent terminology, plausible requirements)

Return ONLY valid JSON:
{"score":0.0,"has_citations":false,"has_specific_data":false,"content_depth":"thin","issues":["issue1"]}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODELS.haiku,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) throw new Error(`Haiku ${response.status}`);

    const data = await response.json();
    const text = (data.content || []).find((b: any) => b.type === "text")?.text || "";
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    warn(LOG_TAG, `Quality gate error for ${category}/${stateCode || "national"}: ${err}`);
    return { score: 0.5, has_citations: false, has_specific_data: false, content_depth: "adequate", issues: ["quality gate error"] };
  }
}

// ============================================================
// EMBEDDING & UPSERT
// ============================================================

async function embedText(text: string): Promise<number[]> {
  const url = `${SUPABASE_URL}/functions/v1/embed`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ text: text.substring(0, 2000) }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Embed failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.embedding;
}

interface ChunkInput {
  stateCode: string | null;
  category: string;
  title: string;
  content: string;
  sourceName: string | null;
  sourceUrl: string | null;
  scope: "state" | "national";
  qualityScore: number;
  flagged: boolean;
  refreshCadenceDays: number;
}

async function upsertChunk(chunk: ChunkInput): Promise<{ action: "updated" | "verified" | "rejected" }> {
  const contentHash = createHash("sha256").update(chunk.content).digest("hex");

  // Check if identical content already exists
  const checkUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge?category=eq.${chunk.category}&chunk_hash=eq.${contentHash}${chunk.stateCode ? `&state_code=eq.${chunk.stateCode}` : "&state_code=is.null"}&select=id`;
  const checkRes = await fetch(checkUrl, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  const existing = await checkRes.json();

  if (Array.isArray(existing) && existing.length > 0) {
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
      signal: AbortSignal.timeout(10_000),
    });
    return { action: "verified" };
  }

  // New or changed content. Generate embedding.
  const embeddingInput = `${chunk.title}\n${chunk.content.substring(0, 1800)}`;
  const embedding = await embedText(embeddingInput);

  const row = {
    state_code: chunk.stateCode,
    category: chunk.category,
    title: chunk.title,
    content: chunk.content,
    source_url: chunk.sourceUrl,
    source_name: chunk.sourceName,
    embedding: JSON.stringify(embedding),
    chunk_hash: contentHash,
    scope: chunk.scope,
    quality_score: chunk.qualityScore,
    demand_score: 0,
    source_count: (chunk.sourceUrl ? 1 : 0),
    flagged: chunk.flagged,
    refresh_cadence_days: chunk.refreshCadenceDays,
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
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Upsert failed: ${res.status} ${await res.text()}`);
  return { action: "updated" };
}

// ============================================================
// RESEARCH PIPELINE
// ============================================================

interface ResearchResult {
  chunksUpdated: number;
  chunksVerified: number;
  chunksRejected: number;
  errors: string[];
}

async function researchTopic(
  topicConfig: TopicConfig,
  stateCode: string | null,
): Promise<ResearchResult> {
  const result: ResearchResult = { chunksUpdated: 0, chunksVerified: 0, chunksRejected: 0, errors: [] };
  const label = stateCode ? `${stateCode}/${topicConfig.category}` : `national/${topicConfig.category}`;

  try {
    // Build prompt from template
    let prompt = topicConfig.researchPromptTemplate;
    if (stateCode) {
      const stateName = STATE_NAMES[stateCode] || stateCode;
      prompt = prompt.replace(/\{\{state_name\}\}/g, stateName).replace(/\{\{state_code\}\}/g, stateCode);
    }

    info(LOG_TAG, `Researching: ${label}`);
    const output = await runResearchPrompt(prompt);

    // Parse JSON response
    let parsed: any;
    try {
      const cleaned = output.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      result.errors.push(`${label}: JSON parse failed`);
      warn(LOG_TAG, `${label} parse error: ${parseErr}`);
      return result;
    }

    const chunks = parsed.chunks || [];
    if (!Array.isArray(chunks) || chunks.length === 0) {
      result.errors.push(`${label}: No chunks in output`);
      return result;
    }

    // Process each chunk through quality gate and upsert
    for (const chunk of chunks) {
      try {
        const quality = await evaluateChunkQuality(
          chunk.content || "",
          chunk.title || "",
          topicConfig.category,
          stateCode,
        );

        if (quality.score < 0.4) {
          result.chunksRejected++;
          warn(LOG_TAG, `  Rejected: ${label} "${chunk.title}" (score ${quality.score.toFixed(2)}: ${quality.issues.join(", ")})`);
          continue;
        }

        const { action } = await upsertChunk({
          stateCode,
          category: topicConfig.category,
          title: chunk.title || `${topicConfig.label} - ${stateCode || "National"}`,
          content: chunk.content,
          sourceName: chunk.source_name || null,
          sourceUrl: chunk.source_url || null,
          scope: topicConfig.scope,
          qualityScore: quality.score,
          flagged: quality.score < 0.7,
          refreshCadenceDays: topicConfig.refreshCadenceDays,
        });

        if (action === "updated") {
          result.chunksUpdated++;
          info(LOG_TAG, `  Updated: ${label} "${chunk.title}" (quality ${quality.score.toFixed(2)})`);
        } else {
          result.chunksVerified++;
        }
      } catch (chunkErr) {
        result.errors.push(`${label}/${chunk.title}: ${chunkErr}`);
        warn(LOG_TAG, `  Chunk error: ${chunkErr}`);
      }
    }
  } catch (err) {
    result.errors.push(`${label}: ${err}`);
    logError(LOG_TAG, `Error researching ${label}: ${err}`);
  }

  return result;
}

// ============================================================
// STATE SELECTION
// ============================================================

function pickStatesForTonight(state: ResearchState, count: number = 3): string[] {
  const now = Date.now();
  const selected: string[] = [];

  // 1. Check gap report for states needing research
  try {
    if (existsSync(GAP_REPORT_FILE)) {
      const gaps = JSON.parse(readFileSync(GAP_REPORT_FILE, "utf-8"));
      const stateGaps = (gaps.gaps || [])
        .filter((g: any) => g.state_code && g.research_priority <= 2)
        .map((g: any) => g.state_code);

      for (const code of stateGaps) {
        if (selected.length >= count) break;
        if (!selected.includes(code)) selected.push(code);
      }
    }
  } catch {}

  // 2. Priority states not verified in 14 days
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
  for (const code of PRIORITY_STATES) {
    if (selected.length >= count) break;
    if (selected.includes(code)) continue;

    const stateVerified = state.stateLastVerified[code] || {};
    const oldestVerification = Object.values(stateVerified)
      .map(d => new Date(d).getTime())
      .sort()[0] || 0;

    if (oldestVerification < fourteenDaysAgo) {
      selected.push(code);
    }
  }

  // 3. Round-robin remaining states
  const nonPriority = ALL_STATES.filter(s => !PRIORITY_STATES.includes(s));
  let idx = state.stateRoundRobinIndex % nonPriority.length;

  while (selected.length < count) {
    const candidate = nonPriority[idx];
    if (!selected.includes(candidate)) {
      selected.push(candidate);
    }
    idx = (idx + 1) % nonPriority.length;
  }

  state.stateRoundRobinIndex = idx;
  return selected;
}

function pickNationalTopicsForTonight(state: ResearchState, count: number = 3): TopicConfig[] {
  const nationalTopics = getNationalTopics();
  const now = Date.now();
  const selected: TopicConfig[] = [];

  // Topics past their refresh cadence go first
  const stale = nationalTopics.filter(t => {
    const lastVerified = state.nationalLastVerified[t.category];
    if (!lastVerified) return true;
    const age = now - new Date(lastVerified).getTime();
    return age > t.refreshCadenceDays * 24 * 60 * 60 * 1000;
  });

  for (const topic of stale) {
    if (selected.length >= count) break;
    selected.push(topic);
  }

  // Round-robin remaining
  let idx = state.nationalRoundRobinIndex % nationalTopics.length;
  while (selected.length < count) {
    const candidate = nationalTopics[idx];
    if (!selected.find(s => s.category === candidate.category)) {
      selected.push(candidate);
    }
    idx = (idx + 1) % nationalTopics.length;
  }

  state.nationalRoundRobinIndex = idx;
  return selected;
}

// ============================================================
// TRACK 1: STATE REGULATORY SWEEP
// ============================================================

export interface SweepResult {
  statesProcessed: string[];
  topicsResearched: number;
  chunksUpdated: number;
  chunksVerified: number;
  chunksRejected: number;
  errors: string[];
}

export async function runStateSweep(): Promise<SweepResult> {
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statesProcessed: [], topicsResearched: 0, chunksUpdated: 0, chunksVerified: 0, chunksRejected: 0, errors: ["Missing env vars"] };
  }

  const state = await loadState();
  const states = pickStatesForTonight(state, 3);
  const stateTopics = getStateTopics();

  info(LOG_TAG, `State sweep: ${states.join(", ")} (${stateTopics.length} topics each)`);

  const result: SweepResult = {
    statesProcessed: [],
    topicsResearched: 0,
    chunksUpdated: 0,
    chunksVerified: 0,
    chunksRejected: 0,
    errors: [],
  };

  for (const stateCode of states) {
    for (const topic of stateTopics) {
      // Rate limit: 2s delay between API calls to avoid hitting Anthropic rate limits
      await new Promise(r => setTimeout(r, 2000));
      const res = await researchTopic(topic, stateCode);
      result.topicsResearched++;
      result.chunksUpdated += res.chunksUpdated;
      result.chunksVerified += res.chunksVerified;
      result.chunksRejected += res.chunksRejected;
      result.errors.push(...res.errors);

      // Track verification
      if (!state.stateLastVerified[stateCode]) state.stateLastVerified[stateCode] = {};
      state.stateLastVerified[stateCode][topic.category] = new Date().toISOString();
    }
    result.statesProcessed.push(stateCode);
  }

  state.totalUpdates += result.chunksUpdated;
  state.totalVerified += result.chunksVerified;
  state.totalRejected += result.chunksRejected;
  state.lastRunAt = new Date().toISOString();
  await saveState(state);

  info(LOG_TAG, `State sweep done: ${result.statesProcessed.length} states, ${result.chunksUpdated} updated, ${result.chunksVerified} verified, ${result.chunksRejected} rejected`);
  return result;
}

// ============================================================
// TRACK 2: NATIONAL TOPIC ROTATION
// ============================================================

export async function runNationalSweep(): Promise<SweepResult> {
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statesProcessed: [], topicsResearched: 0, chunksUpdated: 0, chunksVerified: 0, chunksRejected: 0, errors: ["Missing env vars"] };
  }

  const state = await loadState();
  const topics = pickNationalTopicsForTonight(state, 3);

  info(LOG_TAG, `National sweep: ${topics.map(t => t.category).join(", ")}`);

  const result: SweepResult = {
    statesProcessed: [],
    topicsResearched: 0,
    chunksUpdated: 0,
    chunksVerified: 0,
    chunksRejected: 0,
    errors: [],
  };

  for (const topic of topics) {
    const res = await researchTopic(topic, null);
    result.topicsResearched++;
    result.chunksUpdated += res.chunksUpdated;
    result.chunksVerified += res.chunksVerified;
    result.chunksRejected += res.chunksRejected;
    result.errors.push(...res.errors);

    state.nationalLastVerified[topic.category] = new Date().toISOString();
  }

  state.totalUpdates += result.chunksUpdated;
  state.totalVerified += result.chunksVerified;
  state.totalRejected += result.chunksRejected;
  state.lastRunAt = new Date().toISOString();
  await saveState(state);

  info(LOG_TAG, `National sweep done: ${result.topicsResearched} topics, ${result.chunksUpdated} updated, ${result.chunksVerified} verified, ${result.chunksRejected} rejected`);
  return result;
}

// ============================================================
// TRACK 3: DEMAND-DRIVEN RESEARCH
// ============================================================

export async function runDemandResearch(): Promise<SweepResult> {
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statesProcessed: [], topicsResearched: 0, chunksUpdated: 0, chunksVerified: 0, chunksRejected: 0, errors: ["Missing env vars"] };
  }

  const result: SweepResult = {
    statesProcessed: [],
    topicsResearched: 0,
    chunksUpdated: 0,
    chunksVerified: 0,
    chunksRejected: 0,
    errors: [],
  };

  // Read gap report
  if (!existsSync(GAP_REPORT_FILE)) {
    info(LOG_TAG, "No gap report found, skipping demand research");
    return result;
  }

  let gaps: any;
  try {
    gaps = JSON.parse(await readFile(GAP_REPORT_FILE, "utf-8"));
  } catch {
    info(LOG_TAG, "Could not parse gap report");
    return result;
  }

  const priorityGaps = (gaps.gaps || [])
    .filter((g: any) => g.research_priority <= 2)
    .sort((a: any, b: any) => a.research_priority - b.research_priority)
    .slice(0, 5); // Max 5 gaps per session

  info(LOG_TAG, `Demand research: ${priorityGaps.length} priority gaps`);

  for (const gap of priorityGaps) {
    const topicConfig = getTopicByCategory(gap.category);
    if (!topicConfig) {
      result.errors.push(`Unknown category: ${gap.category}`);
      continue;
    }

    const res = await researchTopic(topicConfig, gap.state_code || null);
    result.topicsResearched++;
    result.chunksUpdated += res.chunksUpdated;
    result.chunksVerified += res.chunksVerified;
    result.chunksRejected += res.chunksRejected;
    result.errors.push(...res.errors);

    if (gap.state_code) result.statesProcessed.push(gap.state_code);

    // Mark gap as researched in Supabase
    try {
      const updateUrl = `${SUPABASE_URL}/rest/v1/sage_question_trends?id=eq.${gap.id}`;
      await fetch(updateUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ researched_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {}
  }

  const state = await loadState();
  state.totalUpdates += result.chunksUpdated;
  state.totalVerified += result.chunksVerified;
  state.totalRejected += result.chunksRejected;
  state.lastRunAt = new Date().toISOString();
  await saveState(state);

  info(LOG_TAG, `Demand research done: ${result.topicsResearched} topics, ${result.chunksUpdated} updated, ${result.chunksRejected} rejected`);
  return result;
}

// ============================================================
// STATUS REPORTING (for morning brief)
// ============================================================

export async function getResearchStatus(): Promise<string> {
  const state = await loadState();
  const stateCount = Object.keys(state.stateLastVerified).length;
  const nationalCount = Object.keys(state.nationalLastVerified).length;
  const totalNational = getNationalTopics().length;

  const lines = [
    `SAGE KB: ${stateCount}/50 states, ${nationalCount}/${totalNational} national topics`,
    `Totals: ${state.totalUpdates} updated, ${state.totalVerified} verified, ${state.totalRejected} rejected`,
  ];

  if (state.lastRunAt) {
    const ago = Math.round((Date.now() - new Date(state.lastRunAt).getTime()) / 3600000);
    lines.push(`Last run: ${ago}h ago`);
  }

  // Check for stale states (>30 days)
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const staleStates: string[] = [];
  for (const [code, categories] of Object.entries(state.stateLastVerified)) {
    const oldest = Math.min(...Object.values(categories).map(d => new Date(d).getTime()));
    if (oldest < thirtyDaysAgo) staleStates.push(code);
  }

  if (staleStates.length > 0) {
    lines.push(`Stale (>30d): ${staleStates.join(", ")}`);
  }

  // Check for flagged chunks
  try {
    const flaggedUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge?flagged=eq.true&select=id`;
    const res = await fetch(flaggedUrl, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    const flagged = await res.json();
    if (Array.isArray(flagged) && flagged.length > 0) {
      lines.push(`Flagged chunks (review needed): ${flagged.length}`);
    }
  } catch {}

  return lines.join("\n");
}
