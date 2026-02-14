/**
 * Atlas -- Enterprise Search Module
 *
 * Central search interface that supports:
 * - Vector-only search (backwards compatible with existing memory.ts)
 * - Hybrid search (vector + FTS with RRF fusion)
 * - Multi-table search (messages, memory, documents, summaries)
 * - Semantic memory browsing (replaces ilike in browseMemory)
 *
 * All embedding generation happens in Supabase Edge Functions.
 * The relay never touches the OpenAI key.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// TYPES
// ============================================================

export interface SearchOptions {
  tables?: string[];           // which tables to search (default: ["messages"])
  mode?: "vector" | "hybrid";  // search mode (default: "hybrid")
  matchCount?: number;          // max results (default: 10)
  matchThreshold?: number;      // similarity threshold for vector-only (default: 0.7)
  ftsWeight?: number;           // full-text weight for hybrid (default: 1.0)
  semanticWeight?: number;      // vector weight for hybrid (default: 1.0)
}

export interface SearchResult {
  source_table: string;
  source_id: string;
  content: string;
  role?: string;
  source_type?: string;
  created_at: string;
  similarity: number;
  combined_score?: number;
}

// ============================================================
// CORE SEARCH
// ============================================================

/**
 * Unified search across Atlas knowledge stores.
 * Calls the search Edge Function which handles embedding generation and
 * routes to the appropriate RPC (vector-only or hybrid with RRF).
 */
export async function search(
  supabase: SupabaseClient,
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const {
    tables = ["messages"],
    mode = "hybrid",
    matchCount = 10,
    matchThreshold = 0.7,
    ftsWeight = 1.0,
    semanticWeight = 1.0,
  } = options;

  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: {
        query,
        mode,
        tables,
        match_count: matchCount,
        match_threshold: matchThreshold,
        fts_weight: ftsWeight,
        semantic_weight: semanticWeight,
      },
    });

    if (error || !data) return [];

    // Handle both array results and error objects
    if (Array.isArray(data)) return data;
    if (data.error) return [];

    return [];
  } catch {
    return [];
  }
}

// ============================================================
// CONTEXT RETRIEVAL (replaces memory.ts getRelevantContext)
// ============================================================

/**
 * Get relevant context from past conversations, summaries, and documents.
 * Uses hybrid search across multiple tables for maximum recall.
 * Returns formatted text ready to inject into Claude's prompt.
 */
export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string
): Promise<string> {
  if (!supabase) return "";

  try {
    const results = await search(supabase, query, {
      tables: ["messages", "summaries", "documents"],
      mode: "hybrid",
      matchCount: 8,
      ftsWeight: 1.0,
      semanticWeight: 1.5, // favor semantic matches for context
    });

    if (!results.length) return "";

    // Group results by source for organized context
    const messages = results.filter((r) => r.source_table === "messages");
    const summaries = results.filter((r) => r.source_table === "summaries");
    const documents = results.filter((r) => r.source_table === "documents");

    const parts: string[] = [];

    if (messages.length > 0) {
      parts.push(
        "RELEVANT PAST MESSAGES:\n" +
          messages.map((m) => `[${m.role || "unknown"}]: ${m.content}`).join("\n")
      );
    }

    if (summaries.length > 0) {
      parts.push(
        "RELEVANT CONVERSATION SUMMARIES:\n" +
          summaries.map((s) => s.content).join("\n")
      );
    }

    if (documents.length > 0) {
      parts.push(
        "RELEVANT KNOWLEDGE BASE:\n" +
          documents.map((d) => {
            const label = d.source_type || "doc";
            return `[${label}]: ${d.content}`;
          }).join("\n")
      );
    }

    return parts.join("\n\n");
  } catch {
    return "";
  }
}

// ============================================================
// SEMANTIC MEMORY SEARCH (replaces ilike in browseMemory)
// ============================================================

/**
 * Search the memory table using hybrid semantic + keyword search.
 * Returns raw results for the caller to format.
 */
export async function semanticMemorySearch(
  supabase: SupabaseClient,
  query: string,
  limit = 20
): Promise<SearchResult[]> {
  return search(supabase, query, {
    tables: ["memory"],
    mode: "hybrid",
    matchCount: limit,
    ftsWeight: 1.5, // favor keyword matches for memory browsing
    semanticWeight: 1.0,
  });
}

// ============================================================
// DOCUMENT INGESTION (calls ingest Edge Function)
// ============================================================

export interface IngestResult {
  chunks_created: number;
  chunks_skipped: number;
  document_hash: string;
  message?: string;
  error?: string;
}

/**
 * Ingest a document into the knowledge base.
 * The Edge Function handles chunking and dedup.
 * Embeddings are generated automatically via webhook.
 */
export async function ingestDocument(
  supabase: SupabaseClient,
  content: string,
  options: {
    source?: string;
    sourcePath?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  } = {}
): Promise<IngestResult> {
  try {
    const { data, error } = await supabase.functions.invoke("ingest", {
      body: {
        content,
        source: options.source || "manual",
        source_path: options.sourcePath,
        title: options.title,
        metadata: options.metadata || {},
      },
    });

    if (error) {
      return { chunks_created: 0, chunks_skipped: 0, document_hash: "", error: error.message };
    }

    return data as IngestResult;
  } catch (err) {
    return { chunks_created: 0, chunks_skipped: 0, document_hash: "", error: String(err) };
  }
}

// ============================================================
// COST QUERY (for /status command)
// ============================================================

/**
 * Get today's search/embedding costs from the logs table.
 */
export async function getTodayCosts(
  supabase: SupabaseClient | null
): Promise<{ embeddings: number; searches: number; totalCostUsd: number }> {
  if (!supabase) return { embeddings: 0, searches: 0, totalCostUsd: 0 };

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { data } = await supabase
      .from("logs")
      .select("event, metadata")
      .in("event", ["embedding", "search"])
      .gte("created_at", today.toISOString());

    if (!data?.length) return { embeddings: 0, searches: 0, totalCostUsd: 0 };

    let embeddings = 0;
    let searches = 0;
    let totalCostUsd = 0;

    for (const log of data) {
      const cost = (log.metadata as any)?.cost_usd || 0;
      totalCostUsd += cost;
      if (log.event === "embedding") embeddings++;
      else if (log.event === "search") searches++;
    }

    return { embeddings, searches, totalCostUsd };
  } catch {
    return { embeddings: 0, searches: 0, totalCostUsd: 0 };
  }
}
