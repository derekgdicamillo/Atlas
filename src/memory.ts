/**
 * Memory Module
 *
 * Persistent facts, goals, and preferences stored in Supabase.
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *   [TODO: task text]        → adds to Obsidian MASTER TODO
 *   [TODO_DONE: search text] → checks off matching task
 *
 * The relay parses these tags, saves to Supabase, and strips them
 * from the response before sending to the user.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { addTodo, completeTodo } from "./todo.ts";
import {
  getRelevantContext as searchRelevantContext,
  semanticMemorySearch,
} from "./search.ts";

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 */
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string
): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [REMEMBER: fact to store] — with dedup via semantic similarity
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    const newFact = match[1];
    const existing = await findSimilarFact(supabase, newFact);

    if (existing) {
      // Update existing fact instead of creating a duplicate
      await supabase
        .from("memory")
        .update({ content: newFact, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    } else {
      await supabase.from("memory").insert({
        type: "fact",
        content: newFact,
      });
    }
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    await supabase.from("memory").insert({
      type: "goal",
      content: match[1],
      deadline: match[2] || null,
    });
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const { data } = await supabase
      .from("memory")
      .select("id")
      .eq("type", "goal")
      .ilike("content", `%${match[1]}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("memory")
        .update({
          type: "completed_goal",
          completed_at: new Date().toISOString(),
        })
        .eq("id", data[0].id);
    }
    clean = clean.replace(match[0], "");
  }

  // [TODO: task text] — add to Obsidian MASTER TODO INBOX
  for (const match of response.matchAll(/\[TODO:\s*(.+?)\]/gi)) {
    await addTodo(match[1]);
    clean = clean.replace(match[0], "");
  }

  // [TODO_DONE: search text] — check off matching task in MASTER TODO
  for (const match of response.matchAll(/\[TODO_DONE:\s*(.+?)\]/gi)) {
    await completeTodo(match[1]);
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

/**
 * Find an existing fact semantically similar to the new one (dedup).
 * Uses the search Edge Function to check the memory table.
 * Returns the matching row if similarity >= 0.85, else null.
 */
async function findSimilarFact(
  supabase: SupabaseClient,
  content: string
): Promise<{ id: string; content: string } | null> {
  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: {
        query: content,
        table: "memory",
        match_count: 1,
        match_threshold: 0.85,
      },
    });

    if (error || !data?.length) return null;

    // Only dedup facts, not goals
    const match = data[0];
    if (match.type !== "fact") return null;

    return { id: match.id, content: match.content };
  } catch {
    // Edge Function not available, skip dedup
    return null;
  }
}

/**
 * Browse stored facts and goals. Used by /memory command.
 * When a search term is provided and enterprise search is enabled,
 * uses semantic search (hybrid vector + FTS) instead of basic ilike.
 */
export async function browseMemory(
  supabase: SupabaseClient | null,
  options: { type?: string; search?: string; limit?: number; useEnterpriseSearch?: boolean } = {}
): Promise<string> {
  if (!supabase) return "Memory not available (Supabase not configured).";

  const { type, search, limit = 20, useEnterpriseSearch = false } = options;

  // Semantic search path: use hybrid search from search.ts
  if (search && useEnterpriseSearch) {
    try {
      const results = await semanticMemorySearch(supabase, search, limit);
      if (!results.length) return "No memories found.";

      const lines = results.map((r) => {
        const date = new Date(r.created_at).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        const prefix = (r.source_type || "fact").toUpperCase();
        const sim = (r.similarity * 100).toFixed(0);
        return `[${prefix}] ${date} — ${r.content} (${sim}% match)`;
      });

      return lines.join("\n");
    } catch {
      // Fall through to basic search if semantic fails
    }
  }

  // Basic search path: ilike text matching
  try {
    let query = supabase
      .from("memory")
      .select("id, type, content, created_at, deadline, completed_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (type) {
      query = query.eq("type", type);
    } else {
      query = query.neq("type", "completed_goal");
    }

    if (search) {
      query = query.ilike("content", `%${search}%`);
    }

    const { data, error } = await query;

    if (error) return `Memory error: ${error.message}`;
    if (!data?.length) return "No memories found.";

    const lines = data.map((m: any) => {
      const date = new Date(m.created_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      const prefix = m.type === "goal" ? "GOAL" : m.type === "fact" ? "FACT" : m.type.toUpperCase();
      const deadline = m.deadline
        ? ` (by ${new Date(m.deadline).toLocaleDateString()})`
        : "";
      return `[${prefix}] ${date} — ${m.content}${deadline}`;
    });

    return lines.join("\n");
  } catch (error) {
    return `Memory error: ${error}`;
  }
}

/**
 * Delete a memory entry by ID.
 */
export async function deleteMemory(
  supabase: SupabaseClient | null,
  id: string
): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from("memory").delete().eq("id", id);
  return !error;
}

/**
 * Get all facts and active goals for prompt context.
 */
export async function getMemoryContext(
  supabase: SupabaseClient | null
): Promise<string> {
  if (!supabase) return "";

  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts"),
      supabase.rpc("get_active_goals"),
    ]);

    const parts: string[] = [];

    if (factsResult.data?.length) {
      parts.push(
        "FACTS:\n" +
          factsResult.data.map((f: any) => `- ${f.content}`).join("\n")
      );
    }

    if (goalsResult.data?.length) {
      parts.push(
        "GOALS:\n" +
          goalsResult.data
            .map((g: any) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
                : "";
              return `- ${g.content}${deadline}`;
            })
            .join("\n")
      );
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
    return "";
  }
}

/**
 * Semantic search for relevant past messages via the search Edge Function.
 * The Edge Function handles embedding generation (OpenAI key stays in Supabase).
 *
 * When enterprise search is enabled, delegates to search.ts which uses
 * hybrid multi-table search (messages + summaries + documents).
 * Falls back to basic single-table vector search otherwise.
 */
export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string,
  useEnterpriseSearch = false
): Promise<string> {
  if (!supabase) return "";

  // Enterprise search: hybrid multi-table via search.ts
  if (useEnterpriseSearch) {
    return searchRelevantContext(supabase, query);
  }

  // Legacy: basic vector-only search on messages table
  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: { query, match_count: 5, table: "messages" },
    });

    if (error || !data?.length) return "";

    return (
      "RELEVANT PAST MESSAGES:\n" +
      data
        .map((m: any) => `[${m.role}]: ${m.content}`)
        .join("\n")
    );
  } catch {
    return "";
  }
}
