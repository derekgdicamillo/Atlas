/**
 * Atlas — Multi-Resolution Summarization (Phase 0)
 *
 * Replaces the dumb 50-message flat batching from summarize.ts with
 * topic-clustered, importance-weighted, entity-aware summarization.
 *
 * Resolution hierarchy:
 * - topic:    Per-topic cluster summaries (nightly, replaces old batches)
 * - daily:    Daily digest combining all topic summaries (nightly)
 * - weekly:   Weekly synthesis of daily digests (Sunday)
 * - monthly:  Monthly narrative of weekly syntheses (1st of month)
 *
 * The old summarize.ts is kept as fallback.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn, error as logError } from "../logger.ts";
import { scoreSalience } from "../cognitive.ts";

const AGE_THRESHOLD_HOURS = 48;
const MAX_MESSAGES_PER_RUN = 500; // process more per night than the old 250 limit
const MIN_CLUSTER_SIZE = 3;       // don't summarize clusters smaller than this
const MAX_CLUSTERS = 15;          // cap clusters per run to control cost

const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";

// ============================================================
// TYPES
// ============================================================

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

interface TopicCluster {
  label: string;
  messages: MessageRow[];
  salience: number; // average salience of messages in cluster
  entityNames: string[];
}

// ============================================================
// TOPIC CLUSTERING
// ============================================================

/**
 * Group messages by topic using keyword co-occurrence.
 * Lightweight approach that doesn't need embeddings (those are expensive at scale).
 *
 * Algorithm:
 * 1. Extract top keywords from each message (stop words removed)
 * 2. Build keyword frequency across all messages
 * 3. For each message, identify its "signature" (top 3 discriminating keywords)
 * 4. Group messages with 2+ shared signature keywords into clusters
 * 5. Assign remaining messages to nearest cluster or "miscellaneous"
 */
function clusterByTopic(messages: MessageRow[]): TopicCluster[] {
  if (messages.length < MIN_CLUSTER_SIZE) {
    return [{
      label: "general",
      messages,
      salience: 0.5,
      entityNames: [],
    }];
  }

  // Step 1: Extract keywords per message
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "both",
    "each", "few", "more", "most", "other", "some", "such", "no", "nor",
    "not", "only", "own", "same", "so", "than", "too", "very", "just",
    "don", "about", "up", "it", "its", "he", "she", "they", "them",
    "their", "what", "which", "who", "whom", "this", "that", "these",
    "those", "i", "me", "my", "we", "our", "you", "your", "and", "but",
    "or", "if", "while", "because", "until", "although", "though",
    "hi", "hey", "ok", "okay", "yes", "no", "yeah", "sure", "thanks",
    "thank", "please", "right", "got", "get", "like", "know", "think",
    "want", "going", "let", "make", "also", "well", "still", "much",
    "even", "back", "way", "really", "good", "new", "first", "last",
    "long", "great", "little", "one", "two", "three", "time", "day",
    "thing", "see", "look", "come", "say", "said", "tell", "told",
  ]);

  // Extract keywords for each message
  const messageKeywords: Map<string, Set<string>> = new Map();
  const globalFreq: Map<string, number> = new Map();

  for (const msg of messages) {
    const words = msg.content
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    const unique = new Set(words);
    messageKeywords.set(msg.id, unique);

    for (const w of unique) {
      globalFreq.set(w, (globalFreq.get(w) || 0) + 1);
    }
  }

  // Step 2: Score keywords by TF-IDF-like metric
  // Words that appear in 10-60% of messages are most discriminating
  const totalMsgs = messages.length;
  const getDiscriminationScore = (word: string): number => {
    const freq = globalFreq.get(word) || 0;
    const ratio = freq / totalMsgs;
    if (ratio < 0.05 || ratio > 0.6) return 0; // too rare or too common
    return freq * (1 - ratio); // balance between frequency and specificity
  };

  // Step 3: Build message signatures (top 5 discriminating keywords)
  const messageSignatures: Map<string, string[]> = new Map();
  for (const msg of messages) {
    const keywords = messageKeywords.get(msg.id) || new Set<string>();
    const scored = [...keywords]
      .map((w) => ({ word: w, score: getDiscriminationScore(w) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((s) => s.word);
    messageSignatures.set(msg.id, scored);
  }

  // Step 4: Greedy clustering by shared keywords
  const clusters: TopicCluster[] = [];
  const assigned = new Set<string>();

  // Sort messages by time
  const sorted = [...messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  for (const msg of sorted) {
    if (assigned.has(msg.id)) continue;

    const sig = messageSignatures.get(msg.id) || [];
    if (sig.length === 0) continue;

    // Find all unassigned messages that share 2+ keywords
    const cluster: MessageRow[] = [msg];
    assigned.add(msg.id);

    for (const other of sorted) {
      if (assigned.has(other.id)) continue;
      const otherSig = messageSignatures.get(other.id) || [];
      const shared = sig.filter((w) => otherSig.includes(w));
      if (shared.length >= 2) {
        cluster.push(other);
        assigned.add(other.id);
      }
    }

    if (cluster.length >= MIN_CLUSTER_SIZE) {
      // Label = most common keywords in the cluster
      const clusterKeywords = new Map<string, number>();
      for (const m of cluster) {
        const ks = messageSignatures.get(m.id) || [];
        for (const k of ks) {
          clusterKeywords.set(k, (clusterKeywords.get(k) || 0) + 1);
        }
      }
      const topKeywords = [...clusterKeywords.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k]) => k);

      const label = topKeywords.join(", ") || "general";
      const avgSalience = cluster.reduce(
        (s, m) => s + scoreSalience(m.content).overall,
        0,
      ) / cluster.length;

      clusters.push({
        label,
        messages: cluster,
        salience: avgSalience,
        entityNames: extractEntityNamesFromCluster(cluster),
      });
    } else {
      // Uncluster: remove from assigned so they go to miscellaneous
      for (const m of cluster) assigned.delete(m.id);
    }
  }

  // Collect unassigned messages into "miscellaneous"
  const misc = sorted.filter((m) => !assigned.has(m.id));
  if (misc.length >= MIN_CLUSTER_SIZE) {
    clusters.push({
      label: "miscellaneous",
      messages: misc,
      salience: misc.reduce((s, m) => s + scoreSalience(m.content).overall, 0) / misc.length,
      entityNames: extractEntityNamesFromCluster(misc),
    });
  }

  return clusters.slice(0, MAX_CLUSTERS);
}

/**
 * Quick entity name extraction from a cluster (no LLM, just regex).
 */
function extractEntityNamesFromCluster(messages: MessageRow[]): string[] {
  const names = new Set<string>();
  const patterns = [
    /\b(Dr\.?\s+\w+|Esther|Derek|Sarah|Atlas)\b/g,
    /\b(PV\s*(?:Medispa|Med\s*Spa)|Vitality\s*Unchained|Skool|GoHighLevel|GHL|QuickBooks|Meta)\b/gi,
    /\b(GLP-1|semaglutide|tirzepatide|Ozempic|Wegovy|Mounjaro|Zepbound)\b/gi,
    /\b(Claude|Anthropic|Supabase|Telegram|Gmail|Google\s*(?:Ads|Analytics|Business))\b/gi,
  ];

  for (const msg of messages) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of msg.content.matchAll(pattern)) {
        names.add(match[0].trim());
      }
    }
  }

  return [...names];
}

// ============================================================
// CORE SUMMARIZATION
// ============================================================

/**
 * Run multi-resolution summarization. Replaces the flat-batch approach.
 *
 * @param supabase Supabase client
 * @param summarize Callback to run a prompt through Claude (haiku)
 * @returns Number of summaries created
 */
export async function runSummarizationV2(
  supabase: SupabaseClient,
  summarize: (text: string) => Promise<string>,
): Promise<{ topicSummaries: number; dailyDigest: boolean }> {
  let topicSummaries = 0;
  let dailyDigest = false;

  // Step 1: Get unsummarized messages
  const messages = await getUnsummarizedMessages(supabase);
  if (messages.length === 0) {
    info("summarize-v2", "No messages to summarize.");
    return { topicSummaries: 0, dailyDigest: false };
  }

  info("summarize-v2", `Processing ${messages.length} unsummarized messages...`);

  // Step 2: Cluster by topic
  const clusters = clusterByTopic(messages);
  info("summarize-v2", `Formed ${clusters.length} topic clusters`);

  // Step 3: Summarize each cluster
  for (const cluster of clusters) {
    try {
      const formattedText = cluster.messages
        .map((m) => {
          const time = new Date(m.created_at).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
          const role = m.role === "user" ? "User" : "Atlas";
          return `[${time}] ${role}: ${m.content}`;
        })
        .join("\n");

      // Adjust detail based on salience
      const sentenceCount = cluster.salience > 0.5 ? "3-5" : "2-3";

      const prompt = [
        `Topic: ${cluster.label}`,
        `Summarize this conversation about "${cluster.label}" in ${sentenceCount} sentences.`,
        "Focus on key facts, decisions, and action items. Be specific, not vague.",
        cluster.entityNames.length > 0
          ? `Key entities mentioned: ${cluster.entityNames.join(", ")}`
          : "",
        "",
        formattedText,
      ].filter(Boolean).join("\n");

      const summary = await summarize(prompt);
      if (!summary) {
        warn("summarize-v2", `Empty summary for cluster "${cluster.label}", skipping`);
        continue;
      }

      await saveSummary(supabase, {
        content: summary,
        messageIds: cluster.messages.map((m) => m.id),
        periodStart: cluster.messages[0].created_at,
        periodEnd: cluster.messages[cluster.messages.length - 1].created_at,
        messageCount: cluster.messages.length,
        resolution: "topic",
        topicLabel: cluster.label,
        entityNames: cluster.entityNames,
      });

      topicSummaries++;
      info("summarize-v2", `Created topic summary: "${cluster.label}" (${cluster.messages.length} msgs, salience: ${cluster.salience.toFixed(2)})`);
    } catch (err) {
      logError("summarize-v2", `Cluster "${cluster.label}" failed: ${err}`);
    }
  }

  // Step 4: Create daily digest
  if (topicSummaries > 0) {
    try {
      dailyDigest = await createDailyDigest(supabase, summarize);
    } catch (err) {
      logError("summarize-v2", `Daily digest failed: ${err}`);
    }
  }

  return { topicSummaries, dailyDigest };
}

/**
 * Create a daily digest summarizing all topic summaries from today.
 */
async function createDailyDigest(
  supabase: SupabaseClient,
  summarize: (text: string) => Promise<string>,
): Promise<boolean> {
  const today = new Date();
  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);

  // Get today's topic summaries
  const { data: topics, error } = await supabase
    .from("summaries")
    .select("content, topic_label, entity_names, period_start, period_end, message_count")
    .eq("resolution", "topic")
    .gte("created_at", todayStart.toISOString())
    .order("period_start", { ascending: true });

  if (error || !topics?.length) return false;

  const topicList = topics.map((t: any) => {
    const entities = t.entity_names?.length > 0
      ? ` (entities: ${t.entity_names.join(", ")})`
      : "";
    return `[${t.topic_label}]${entities}: ${t.content}`;
  }).join("\n\n");

  const dateStr = today.toLocaleDateString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const prompt = [
    `Create a daily digest for ${dateStr}.`,
    `Combine these ${topics.length} topic summaries into a 2-3 paragraph overview of the day.`,
    "Include: main activities, key decisions, notable topics, and any unresolved items.",
    "Write in third person ('Derek discussed...', 'Atlas worked on...').",
    "",
    topicList,
  ].join("\n");

  const digest = await summarize(prompt);
  if (!digest) return false;

  // Collect all entity names from topic summaries
  const allEntities = new Set<string>();
  for (const t of topics) {
    if (t.entity_names) {
      for (const e of t.entity_names) allEntities.add(e);
    }
  }

  // Find the overall time range
  const starts = topics.map((t: any) => t.period_start).filter(Boolean);
  const ends = topics.map((t: any) => t.period_end).filter(Boolean);

  await saveSummary(supabase, {
    content: digest,
    messageIds: [], // digest doesn't track individual message IDs
    periodStart: starts[0] || todayStart.toISOString(),
    periodEnd: ends[ends.length - 1] || today.toISOString(),
    messageCount: topics.reduce((s: number, t: any) => s + (t.message_count || 0), 0),
    resolution: "daily",
    topicLabel: `daily_${today.toLocaleDateString("en-CA", { timeZone: TIMEZONE })}`,
    entityNames: [...allEntities],
  });

  info("summarize-v2", `Created daily digest (${topics.length} topics, ${allEntities.size} entities)`);
  return true;
}

/**
 * Create a weekly synthesis from daily digests. Run on Sundays.
 */
export async function createWeeklySynthesis(
  supabase: SupabaseClient,
  summarize: (text: string) => Promise<string>,
): Promise<boolean> {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);

  // Get this week's daily digests
  const { data: dailies, error } = await supabase
    .from("summaries")
    .select("content, topic_label, entity_names, period_start, period_end, message_count")
    .eq("resolution", "daily")
    .gte("created_at", weekStart.toISOString())
    .order("period_start", { ascending: true });

  if (error || !dailies?.length || dailies.length < 2) {
    info("summarize-v2", "Not enough daily digests for weekly synthesis.");
    return false;
  }

  const dailyList = dailies.map((d: any) => {
    const date = d.topic_label?.replace("daily_", "") || "unknown";
    return `[${date}]: ${d.content}`;
  }).join("\n\n");

  const prompt = [
    "Create a weekly synthesis from these daily digests.",
    "Identify: persistent themes, resolved topics, evolving situations, and open items.",
    "Write 2-3 paragraphs in third person. Focus on patterns and progress, not daily details.",
    "",
    dailyList,
  ].join("\n");

  const synthesis = await summarize(prompt);
  if (!synthesis) return false;

  const allEntities = new Set<string>();
  for (const d of dailies) {
    if (d.entity_names) for (const e of d.entity_names) allEntities.add(e);
  }

  await saveSummary(supabase, {
    content: synthesis,
    messageIds: [],
    periodStart: dailies[0].period_start,
    periodEnd: dailies[dailies.length - 1].period_end || now.toISOString(),
    messageCount: dailies.reduce((s: number, d: any) => s + (d.message_count || 0), 0),
    resolution: "weekly",
    topicLabel: `weekly_${weekStart.toLocaleDateString("en-CA", { timeZone: TIMEZONE })}`,
    entityNames: [...allEntities],
  });

  info("summarize-v2", `Created weekly synthesis (${dailies.length} daily digests)`);
  return true;
}

// ============================================================
// DATABASE OPERATIONS
// ============================================================

async function getUnsummarizedMessages(supabase: SupabaseClient): Promise<MessageRow[]> {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - AGE_THRESHOLD_HOURS);

  try {
    // Get already-summarized message IDs (from v2 topic summaries)
    const { data: existingSummaries } = await supabase
      .from("summaries")
      .select("source_message_ids");

    const summarizedIds = new Set<string>();
    if (existingSummaries) {
      for (const s of existingSummaries) {
        if (s.source_message_ids) {
          for (const id of s.source_message_ids) summarizedIds.add(id);
        }
      }
    }

    // Get old messages
    const { data: messages, error } = await supabase
      .from("messages")
      .select("id, role, content, created_at")
      .lt("created_at", cutoff.toISOString())
      .order("created_at", { ascending: true })
      .limit(MAX_MESSAGES_PER_RUN);

    if (error || !messages?.length) return [];

    return messages.filter((m: MessageRow) => !summarizedIds.has(m.id));
  } catch (err) {
    logError("summarize-v2", `Failed to fetch messages: ${err}`);
    return [];
  }
}

async function saveSummary(
  supabase: SupabaseClient,
  data: {
    content: string;
    messageIds: string[];
    periodStart: string;
    periodEnd: string;
    messageCount: number;
    resolution: string;
    topicLabel: string;
    entityNames: string[];
  },
): Promise<void> {
  const { error } = await supabase.from("summaries").insert({
    content: data.content,
    source_message_ids: data.messageIds,
    period_start: data.periodStart,
    period_end: data.periodEnd,
    message_count: data.messageCount,
    resolution: data.resolution,
    topic_label: data.topicLabel,
    entity_names: data.entityNames,
  });

  if (error) {
    throw new Error(`Failed to save summary: ${error.message}`);
  }
}
