/**
 * Atlas Prime — Memory Rewriter (Lazy-on-Stale)
 *
 * Rewrites stale memory summaries using Haiku with a critic gate.
 * Eligibility: age > 7 days AND access_count_since_rewrite >= 5.
 * A critic score < 0.7 or hallucination flag defers retry by bumping the timestamp.
 * Designed for nightly cron; processes up to DAILY_LIMIT rows per run.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { callHaiku as defaultCallHaiku, type HaikuResult } from "./haiku-client.ts";

const MIN_AGE_DAYS = Number(process.env.MEMORY_REWRITE_MIN_AGE_DAYS ?? 7);
const MIN_ACCESS = Number(process.env.MEMORY_REWRITE_MIN_ACCESS ?? 5);
const DAILY_LIMIT = Number(process.env.MEMORY_REWRITE_DAILY_LIMIT ?? 50);
const MAX_SUMMARY_CHARS = 2000;

export interface MemoryForRewrite {
  id: string;
  original_content: string;
  summary: string;
  summary_rewritten_at: string; // ISO
  access_count_since_rewrite: number;
}

export function isEligibleForRewrite(row: MemoryForRewrite, nowMs = Date.now()): boolean {
  const ageMs = nowMs - new Date(row.summary_rewritten_at).getTime();
  const ageDays = ageMs / 86_400_000;
  return ageDays > MIN_AGE_DAYS && row.access_count_since_rewrite >= MIN_ACCESS;
}

const REWRITE_SYSTEM = `You rewrite a memory summary to incorporate today's hindsight while preserving the original belief.

Format your output as ONE paragraph. Begin with "AT THE TIME, [original belief]." and follow with "AS OF [today], [updated understanding] because [reason]." When no contradictions exist, write "AS OF [today], the original still holds."

Do not invent facts. Only use the original content + provided contradictions. No markdown fences, no preamble.`;

export interface BuildPromptInput {
  original: string;
  currentSummary: string;
  contradictions: string[];
  today: string;
}

export function buildRewritePrompt(input: BuildPromptInput): string {
  const contradictionsBlock = input.contradictions.length
    ? "Recent contradictions or refinements:\n" +
      input.contradictions.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : "No contradictions in recent context.";
  return [
    `TODAY: ${input.today}`,
    ``,
    `ORIGINAL CONTENT (immutable):`,
    input.original,
    ``,
    `CURRENT SUMMARY:`,
    input.currentSummary,
    ``,
    contradictionsBlock,
    ``,
    `Rewrite the summary per the system instructions.`,
  ].join("\n");
}

export function sanitizeRewrite(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    const firstNewline = s.indexOf("\n");
    if (firstNewline >= 0) s = s.slice(firstNewline + 1);
    if (s.endsWith("```")) s = s.slice(0, -3);
    s = s.trim();
  }
  if (s.length > MAX_SUMMARY_CHARS) s = s.slice(0, MAX_SUMMARY_CHARS);
  return s;
}

export interface RewriteOpts {
  supabase: SupabaseClient;
  callHaiku?: typeof defaultCallHaiku;
  criticize?: (text: string, opts?: any) => Promise<{ score: number; flags: string[] }>;
  searchContradictions?: (original: string) => Promise<string[]>;
  today?: string;
}

export async function rewriteSummary(
  memoryId: string,
  opts: RewriteOpts
): Promise<void> {
  const callHaiku = opts.callHaiku ?? defaultCallHaiku;
  const criticize = opts.criticize ?? (async () => ({ score: 1.0, flags: [] }));
  const searchContradictions = opts.searchContradictions ?? (async () => []);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  const { data, error } = await opts.supabase
    .from("memory")
    .select("id, original_content, summary, summary_rewritten_at, access_count_since_rewrite")
    .eq("id", memoryId)
    .single();
  if (error || !data) {
    console.error(`[memory-rewrite] load failed for ${memoryId}:`, error);
    return;
  }
  const row = data as MemoryForRewrite;

  const contradictions = await searchContradictions(row.original_content);
  const userMessage = buildRewritePrompt({
    original: row.original_content,
    currentSummary: row.summary,
    contradictions,
    today,
  });

  const result: HaikuResult = await callHaiku({
    system: REWRITE_SYSTEM,
    userMessage,
    maxTokens: 600,
    cacheSystem: true,
    caller: "memory-rewrite",
  });
  const newSummary = sanitizeRewrite(result.text);

  const critique = await criticize(newSummary, { type: "memory-summary" });
  if (critique.score < 0.7 || critique.flags.includes("hallucination")) {
    // Reject. Bump rewrite timestamp to defer 24h retry.
    await opts.supabase
      .from("memory")
      .update({ summary_rewritten_at: new Date().toISOString() })
      .eq("id", memoryId);
    return;
  }

  await opts.supabase
    .from("memory")
    .update({
      summary: newSummary,
      summary_rewritten_at: new Date().toISOString(),
      access_count_since_rewrite: 0,
    })
    .eq("id", memoryId);
}

/**
 * Find eligible rows up to DAILY_LIMIT and rewrite each. Designed for nightly cron.
 */
export async function processNightlyRewrites(supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - MIN_AGE_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("memory")
    .select("id")
    .lt("summary_rewritten_at", cutoff)
    .gte("access_count_since_rewrite", MIN_ACCESS)
    .neq("class", "demoted")
    .limit(DAILY_LIMIT)
    .order("access_count_since_rewrite", { ascending: false });
  if (error) {
    console.error("[memory-rewrite] nightly query failed:", error);
    return 0;
  }
  if (!data?.length) return 0;
  let count = 0;
  for (const row of data) {
    try {
      await rewriteSummary(row.id, { supabase });
      count++;
    } catch (err) {
      console.error(`[memory-rewrite] failed for ${row.id}:`, err);
    }
  }
  return count;
}
