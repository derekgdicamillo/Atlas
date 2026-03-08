/**
 * Atlas -- Institutional Memory (Codex)
 *
 * When agents complete tasks, they do an "exit interview" capturing what
 * they learned. Future agents get these lessons injected before starting,
 * so they don't repeat the same mistakes. Like ant colony pheromone trails.
 *
 * Storage: data/codex.json (atomic writes via tmp+rename).
 */

import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { info, warn } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const CODEX_FILE = join(DATA_DIR, "codex.json");

// ============================================================
// TYPES
// ============================================================

export interface CodexEntry {
  id: string;
  domain: string;
  lesson: string;
  guidance: string;
  confidence: number;
  sourceTaskIds: string[];
  keywords: string[];
  createdAt: string;
  lastCorroboratedAt: string;
  occurrences: number;
  isAntipattern: boolean;
}

interface Codex {
  entries: CodexEntry[];
  version: number;
  lastUpdatedAt: string;
}

// ============================================================
// PERSISTENCE
// ============================================================

let codexCache: Codex | null = null;

async function loadCodex(): Promise<Codex> {
  if (codexCache) return codexCache;
  try {
    if (existsSync(CODEX_FILE)) {
      const raw = await readFile(CODEX_FILE, "utf-8");
      codexCache = JSON.parse(raw) as Codex;
      return codexCache;
    }
  } catch (err) {
    warn("codex", `Failed to load codex: ${err}`);
  }
  codexCache = { entries: [], version: 1, lastUpdatedAt: new Date().toISOString() };
  return codexCache;
}

async function saveCodex(codex: Codex): Promise<void> {
  codex.lastUpdatedAt = new Date().toISOString();
  codexCache = codex;

  await mkdir(DATA_DIR, { recursive: true });
  const tmpFile = CODEX_FILE + ".tmp";
  await writeFile(tmpFile, JSON.stringify(codex, null, 2), "utf-8");
  await rename(tmpFile, CODEX_FILE);
}

// ============================================================
// KEYWORD SIMILARITY
// ============================================================

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Jaccard-style overlap: intersection / union, weighted by entry confidence. */
function keywordSimilarity(queryTokens: string[], entryKeywords: string[]): number {
  const entrySet = new Set(entryKeywords.map((k) => k.toLowerCase()));
  if (entrySet.size === 0 || queryTokens.length === 0) return 0;
  let overlap = 0;
  for (const t of queryTokens) {
    if (entrySet.has(t)) overlap++;
  }
  const union = new Set([...queryTokens, ...entrySet]).size;
  return union > 0 ? overlap / union : 0;
}

// ============================================================
// CORE FUNCTIONS
// ============================================================

/**
 * Add a new lesson or corroborate an existing one.
 * If a lesson with >0.7 keyword similarity already exists, we merge.
 */
export async function addLesson(
  domain: string,
  lesson: string,
  guidance: string,
  keywords: string[],
  taskId: string,
  isAntipattern = false
): Promise<{ merged: boolean; entryId: string }> {
  const codex = await loadCodex();
  const normalizedKeywords = keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
  const queryTokens = tokenize([lesson, guidance, ...normalizedKeywords].join(" "));

  // Check for existing similar entry
  let bestMatch: { entry: CodexEntry; score: number } | null = null;
  for (const entry of codex.entries) {
    const score = keywordSimilarity(queryTokens, entry.keywords);
    if (score > 0.7 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { entry, score };
    }
  }

  if (bestMatch) {
    // Corroborate existing entry
    const entry = bestMatch.entry;
    entry.confidence = Math.min(1.0, entry.confidence + 0.15);
    entry.occurrences++;
    entry.lastCorroboratedAt = new Date().toISOString();
    if (!entry.sourceTaskIds.includes(taskId)) {
      entry.sourceTaskIds.push(taskId);
    }
    // Merge any new keywords
    const existingSet = new Set(entry.keywords);
    for (const kw of normalizedKeywords) {
      if (!existingSet.has(kw)) entry.keywords.push(kw);
    }
    await saveCodex(codex);
    info("codex", `Corroborated entry ${entry.id} (confidence=${entry.confidence.toFixed(2)}, occurrences=${entry.occurrences})`);
    return { merged: true, entryId: entry.id };
  }

  // Create new entry
  const entry: CodexEntry = {
    id: crypto.randomUUID(),
    domain,
    lesson,
    guidance,
    confidence: 0.5,
    sourceTaskIds: [taskId],
    keywords: normalizedKeywords,
    createdAt: new Date().toISOString(),
    lastCorroboratedAt: new Date().toISOString(),
    occurrences: 1,
    isAntipattern,
  };
  codex.entries.push(entry);
  await saveCodex(codex);
  info("codex", `Added new entry ${entry.id} [${domain}] (${normalizedKeywords.length} keywords)`);
  return { merged: false, entryId: entry.id };
}

/**
 * Search entries by keyword overlap with query. Returns top N sorted by relevance.
 */
export async function searchCodex(
  query: string,
  limit = 5
): Promise<Array<CodexEntry & { relevance: number }>> {
  const codex = await loadCodex();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scored = codex.entries.map((entry) => {
    const sim = keywordSimilarity(queryTokens, entry.keywords);
    return { ...entry, relevance: sim * entry.confidence };
  });

  return scored
    .filter((e) => e.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}

/**
 * Build a prompt section with relevant institutional knowledge for a task.
 */
export async function buildCodexContext(taskPrompt: string): Promise<string> {
  const results = await searchCodex(taskPrompt, 5);
  if (results.length === 0) return "";

  const lines = [
    "## INSTITUTIONAL KNOWLEDGE",
    "Previous agents learned these lessons relevant to your task:",
    "",
  ];

  for (const entry of results) {
    const prefix = entry.isAntipattern ? "AVOID" : "TIP";
    lines.push(
      `- [${prefix}] (${entry.domain}, confidence=${entry.confidence.toFixed(2)}, ${entry.occurrences}x corroborated)`,
      `  Lesson: ${entry.lesson}`,
      `  Guidance: ${entry.guidance}`,
      ""
    );
  }

  return lines.join("\n");
}

/**
 * Parse a LESSONS section from agent output text.
 * Looks for "LESSONS:" followed by bullet points.
 */
export function parseExitInterview(
  agentOutput: string
): Array<{ lesson: string; guidance: string; keywords: string[]; domain: string; isAntipattern: boolean }> {
  const results: Array<{ lesson: string; guidance: string; keywords: string[]; domain: string; isAntipattern: boolean }> = [];

  // Find the LESSONS section
  const lessonsMatch = agentOutput.match(/LESSONS:\s*\n([\s\S]*?)(?:\n##|\n---|\n\*\*|$)/i);
  if (!lessonsMatch) return results;

  const section = lessonsMatch[1];
  // Parse bullet points: "- [domain: keyword] Lesson text. Guidance: what to do."
  const bulletPattern = /[-*]\s*(?:\[([^\]]*)\]\s*)?(.+)/g;
  let match: RegExpExecArray | null;

  while ((match = bulletPattern.exec(section)) !== null) {
    const tag = match[1] || "";
    const body = match[2].trim();
    if (!body || body.length < 10) continue; // skip empty/trivial bullets

    // Parse tag: "domain: keyword1, keyword2" or just "domain"
    let domain = "general";
    let keywords: string[] = [];
    if (tag) {
      const tagParts = tag.split(":").map((s) => s.trim());
      domain = tagParts[0] || "general";
      if (tagParts[1]) {
        keywords = tagParts[1].split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
      }
    }

    // Split body into lesson and guidance at "Guidance:" delimiter
    let lesson = body;
    let guidance = "";
    const guidanceMatch = body.match(/\.\s*Guidance:\s*(.*)/i);
    if (guidanceMatch) {
      lesson = body.substring(0, guidanceMatch.index! + 1).trim();
      guidance = guidanceMatch[1].trim();
    }

    // Detect antipatterns: starts with "Don't", "Avoid", "Never", "Do not"
    const isAntipattern = /^(don'?t|avoid|never|do not)\b/i.test(lesson);

    // Auto-generate keywords from lesson text if none provided
    if (keywords.length === 0) {
      keywords = tokenize(lesson + " " + guidance)
        .filter((w) => w.length > 3)
        .slice(0, 8);
    }
    // Always include domain as a keyword
    if (!keywords.includes(domain.toLowerCase())) {
      keywords.push(domain.toLowerCase());
    }

    results.push({ lesson, guidance, keywords, domain, isAntipattern });
  }

  return results;
}

/**
 * Reduce confidence for entries not corroborated in N days.
 * Removes entries that drop below 0.1 confidence.
 */
export async function decayStaleEntries(maxAgeDays = 30): Promise<{ decayed: number; removed: number }> {
  const codex = await loadCodex();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let decayed = 0;
  let removed = 0;

  codex.entries = codex.entries.filter((entry) => {
    const lastCorroborated = new Date(entry.lastCorroboratedAt).getTime();
    if (lastCorroborated < cutoff) {
      entry.confidence = Math.round((entry.confidence - 0.1) * 100) / 100;
      decayed++;
      if (entry.confidence < 0.1) {
        removed++;
        return false; // Remove entry
      }
    }
    return true;
  });

  if (decayed > 0 || removed > 0) {
    await saveCodex(codex);
    info("codex", `Decay pass: ${decayed} decayed, ${removed} removed (cutoff=${maxAgeDays}d)`);
  }
  return { decayed, removed };
}

/**
 * Get stats about the codex: count, domain breakdown, avg confidence.
 */
export async function getCodexStats(): Promise<{
  totalEntries: number;
  domainBreakdown: Record<string, number>;
  avgConfidence: number;
  antipatternCount: number;
}> {
  const codex = await loadCodex();
  const domainBreakdown: Record<string, number> = {};
  let totalConfidence = 0;
  let antipatternCount = 0;

  for (const entry of codex.entries) {
    domainBreakdown[entry.domain] = (domainBreakdown[entry.domain] || 0) + 1;
    totalConfidence += entry.confidence;
    if (entry.isAntipattern) antipatternCount++;
  }

  return {
    totalEntries: codex.entries.length,
    domainBreakdown,
    avgConfidence: codex.entries.length > 0 ? totalConfidence / codex.entries.length : 0,
    antipatternCount,
  };
}

/** Exit interview prompt to append to code agent instructions. */
export const EXIT_INTERVIEW_PROMPT = `

## Exit Interview
Before your final response, write a LESSONS section with what you learned that would help a future agent doing similar work. Include non-obvious gotchas, workarounds, and things harder than expected.
Format:
LESSONS:
- [domain: keyword1, keyword2] Lesson text. Guidance: what to do about it.
- [domain: keyword] Another lesson. Guidance: specific advice.`;
