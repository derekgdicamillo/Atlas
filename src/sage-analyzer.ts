/**
 * S.A.G.E. Conversation Analyzer
 *
 * Weekly batch job (Sunday 8 PM) that mines user conversations
 * from maa_conversations to identify knowledge gaps and trends.
 *
 * Pipeline:
 * 1. Pull week's conversations from Supabase
 * 2. Classify by category (keyword-first, Haiku fallback)
 * 3. Score answer quality (heuristic-based)
 * 4. Aggregate into trends
 * 5. Detect gaps and prioritize
 * 6. Write to sage_question_trends + gap report
 */

import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { info, warn, error as logError } from "./logger.ts";
import { TOPIC_REGISTRY, getTopicByCategory, getAllCategories, type TopicConfig } from "./sage-topics.ts";
import { MODELS } from "./constants.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const GAP_REPORT_FILE = join(DATA_DIR, "sage-gap-report.json");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const LOG_TAG = "sage-analyzer";

// ============================================================
// CATEGORY CLASSIFICATION (keyword-first)
// ============================================================

function classifyByKeywords(message: string): string | null {
  const lower = message.toLowerCase();

  for (const topic of TOPIC_REGISTRY) {
    for (const keyword of topic.intentKeywords) {
      if (lower.includes(keyword.toLowerCase())) {
        return topic.category;
      }
    }
  }

  return null;
}

async function classifyBatchWithHaiku(messages: string[]): Promise<Record<number, string>> {
  if (messages.length === 0 || !ANTHROPIC_API_KEY) return {};

  const categories = getAllCategories();
  const numbered = messages.map((m, i) => `[${i}] ${m.substring(0, 200)}`).join("\n");

  const prompt = `Classify each numbered message into one of these categories for a medical aesthetics practice advisor:
${categories.join(", ")}

If a message doesn't fit any category, use "uncategorized".

Messages:
${numbered}

Return ONLY valid JSON mapping index to category:
{"0":"scope_of_practice","1":"marketing_strategy","2":"uncategorized"}`;

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
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) throw new Error(`Haiku ${response.status}`);

    const data = await response.json();
    const text = (data.content || []).find((b: any) => b.type === "text")?.text || "";
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const result: Record<number, string> = {};
    for (const [key, val] of Object.entries(parsed)) {
      result[parseInt(key)] = val as string;
    }
    return result;
  } catch (err) {
    warn(LOG_TAG, `Haiku classification error: ${err}`);
    return {};
  }
}

// ============================================================
// ANSWER QUALITY SCORING (heuristic-based)
// ============================================================

const HEDGING_PHRASES = [
  "i'm not entirely sure",
  "i'm not sure",
  "i don't have specific",
  "i cannot confirm",
  "i don't have current",
  "i'm unable to",
  "i would need to",
  "i cannot provide specific",
];

function scoreAnswerQuality(
  assistantResponse: string,
  userFollowedUp: boolean,
  category: string,
): number {
  let score = 0.5;
  const lower = assistantResponse.toLowerCase();
  const topicConfig = getTopicByCategory(category);
  const exemptions = topicConfig?.hedgingExemptions || [];

  // Check hedging (skip exempted phrases for regulatory categories)
  for (const phrase of HEDGING_PHRASES) {
    if (lower.includes(phrase)) {
      const isExempted = exemptions.some(ex => lower.includes(ex.toLowerCase()));
      if (!isExempted) {
        score -= 0.3;
        break;
      }
    }
  }

  // Follow-up penalty
  if (userFollowedUp) score -= 0.2;

  // Citation boost
  if (/\b(sec\.|section|§|statute|rule|cfr|usc)\b/i.test(assistantResponse) ||
      /https?:\/\/\S+/.test(assistantResponse) ||
      /according to/i.test(assistantResponse)) {
    score += 0.2;
  }

  // Specificity boost
  if (/\$[\d,]+|\d+%|\b\d{4}\b/.test(assistantResponse)) {
    score += 0.1;
  }

  // Short response penalty
  if (assistantResponse.split(/\s+/).length < 100 && assistantResponse.length > 20) {
    score -= 0.1;
  }

  return Math.max(0, Math.min(1, score));
}

// ============================================================
// MAIN ANALYZER
// ============================================================

interface ConversationRow {
  user_id: number;
  session_id: string;
  role: string;
  content: string;
  intent: string[] | null;
  created_at: string;
}

interface TrendBucket {
  category: string;
  stateCode: string | null;
  questionCount: number;
  sampleQuestions: string[];
  qualityScores: number[];
}

export interface AnalyzerResult {
  conversationsAnalyzed: number;
  questionsClassified: number;
  gapsDetected: number;
  trendsWritten: number;
  errors: string[];
}

export async function runAnalyzer(): Promise<AnalyzerResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { conversationsAnalyzed: 0, questionsClassified: 0, gapsDetected: 0, trendsWritten: 0, errors: ["Missing env vars"] };
  }

  const result: AnalyzerResult = {
    conversationsAnalyzed: 0,
    questionsClassified: 0,
    gapsDetected: 0,
    trendsWritten: 0,
    errors: [],
  };

  // 1. Pull conversations from past 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/maa_conversations?created_at=gte.${weekAgo}&order=user_id,session_id,created_at&select=user_id,session_id,role,content,intent,created_at`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    result.errors.push(`Failed to fetch conversations: ${res.status}`);
    return result;
  }

  const rows: ConversationRow[] = await res.json();
  if (rows.length === 0) {
    info(LOG_TAG, "No conversations in past 7 days");
    return result;
  }

  // 2. Group into sessions and extract user/assistant pairs
  const sessions = new Map<string, ConversationRow[]>();
  for (const row of rows) {
    const key = `${row.user_id}:${row.session_id}`;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key)!.push(row);
  }

  result.conversationsAnalyzed = sessions.size;

  // 3. Classify each user message and score each assistant response
  const buckets = new Map<string, TrendBucket>();
  const unclassified: { index: number; content: string }[] = [];
  const allUserMessages: { content: string; sessionKey: string; index: number }[] = [];

  for (const [sessionKey, messages] of sessions) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "user") continue;

      const category = classifyByKeywords(msg.content);
      const userFollowedUp = messages.slice(i + 2).some(m => m.role === "user");
      const assistantResponse = messages[i + 1]?.role === "assistant" ? messages[i + 1].content : "";

      if (category) {
        addToBucket(buckets, category, null, msg.content, assistantResponse, userFollowedUp);
        result.questionsClassified++;
      } else {
        unclassified.push({ index: allUserMessages.length, content: msg.content });
      }

      allUserMessages.push({ content: msg.content, sessionKey, index: i });
    }
  }

  // Batch classify unclassified messages with Haiku
  if (unclassified.length > 0) {
    const classifications = await classifyBatchWithHaiku(unclassified.map(u => u.content));
    for (const item of unclassified) {
      const category = classifications[unclassified.indexOf(item)];
      if (category && category !== "uncategorized") {
        addToBucket(buckets, category, null, item.content, "", false);
        result.questionsClassified++;
      }
    }
  }

  info(LOG_TAG, `Classified ${result.questionsClassified} questions into ${buckets.size} buckets`);

  // 4. Detect gaps and write trends
  const weekStart = getWeekStart();
  const gaps: any[] = [];

  for (const [key, bucket] of buckets) {
    const avgQuality = bucket.qualityScores.length > 0
      ? bucket.qualityScores.reduce((a, b) => a + b, 0) / bucket.qualityScores.length
      : 0.5;

    const hasKnowledge = await checkKnowledgeExists(bucket.category, bucket.stateCode);
    let gapDetected = false;
    let priority = 3;
    let gapDescription = "";

    if (avgQuality < 0.5 && bucket.questionCount >= 3) {
      gapDetected = true;
      gapDescription = `Consistently weak answers (avg quality ${avgQuality.toFixed(2)})`;
      priority = bucket.questionCount >= 10 && avgQuality < 0.4 ? 1 : 2;
    } else if (bucket.questionCount >= 5 && !hasKnowledge) {
      gapDetected = true;
      gapDescription = `No knowledge chunks exist for this category${bucket.stateCode ? ` in ${bucket.stateCode}` : ""}`;
      priority = 2;
    }

    if (gapDetected) {
      result.gapsDetected++;
      gaps.push({
        category: bucket.category,
        state_code: bucket.stateCode,
        question_count: bucket.questionCount,
        avg_answer_quality: avgQuality,
        gap_description: gapDescription,
        research_priority: priority,
        sample_questions: bucket.sampleQuestions.slice(0, 5),
      });
    }

    // Write trend to Supabase
    try {
      const trendRow = {
        week_start: weekStart,
        category: bucket.category,
        state_code: bucket.stateCode,
        question_count: bucket.questionCount,
        sample_questions: bucket.sampleQuestions.slice(0, 5),
        avg_answer_quality: avgQuality,
        knowledge_gap_detected: gapDetected,
        gap_description: gapDescription || null,
        research_priority: gapDetected ? priority : null,
      };

      await fetch(`${SUPABASE_URL}/rest/v1/sage_question_trends`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(trendRow),
        signal: AbortSignal.timeout(10_000),
      });
      result.trendsWritten++;
    } catch (err) {
      result.errors.push(`Trend write error: ${err}`);
    }
  }

  // Update demand_score on maa_knowledge for popular categories
  for (const [key, bucket] of buckets) {
    if (bucket.questionCount >= 3) {
      try {
        const demandUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge?category=eq.${bucket.category}${bucket.stateCode ? `&state_code=eq.${bucket.stateCode}` : ""}&select=id,demand_score`;
        const demandRes = await fetch(demandUrl, {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          signal: AbortSignal.timeout(10_000),
        });
        const chunks = await demandRes.json();
        for (const chunk of (chunks || [])) {
          const newScore = Math.min((chunk.demand_score || 0) + bucket.questionCount * 0.1, 10);
          await fetch(`${SUPABASE_URL}/rest/v1/maa_knowledge?id=eq.${chunk.id}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify({ demand_score: newScore }),
            signal: AbortSignal.timeout(10_000),
          });
        }
      } catch {}
    }
  }

  // Write gap report for demand research track
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(GAP_REPORT_FILE, JSON.stringify({
    generated: new Date().toISOString(),
    weekStart,
    conversationsAnalyzed: result.conversationsAnalyzed,
    questionsClassified: result.questionsClassified,
    gaps: gaps.sort((a, b) => a.research_priority - b.research_priority),
  }, null, 2));

  info(LOG_TAG, `Analyzer done: ${result.conversationsAnalyzed} sessions, ${result.questionsClassified} classified, ${result.gapsDetected} gaps`);
  return result;
}

// ============================================================
// HELPERS
// ============================================================

function addToBucket(
  buckets: Map<string, TrendBucket>,
  category: string,
  stateCode: string | null,
  userMessage: string,
  assistantResponse: string,
  userFollowedUp: boolean,
): void {
  const key = `${category}:${stateCode || "national"}`;

  if (!buckets.has(key)) {
    buckets.set(key, {
      category,
      stateCode,
      questionCount: 0,
      sampleQuestions: [],
      qualityScores: [],
    });
  }

  const bucket = buckets.get(key)!;
  bucket.questionCount++;
  if (bucket.sampleQuestions.length < 5) {
    bucket.sampleQuestions.push(userMessage.substring(0, 200));
  }
  if (assistantResponse) {
    bucket.qualityScores.push(scoreAnswerQuality(assistantResponse, userFollowedUp, category));
  }
}

async function checkKnowledgeExists(category: string, stateCode: string | null): Promise<boolean> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/maa_knowledge?category=eq.${category}${stateCode ? `&state_code=eq.${stateCode}` : ""}&select=id&limit=1`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    const data = await res.json();
    return Array.isArray(data) && data.length > 0;
  } catch {
    return true; // Assume exists on error to avoid false gap detection
  }
}

function getWeekStart(): string {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  return weekStart.toISOString().split("T")[0];
}
