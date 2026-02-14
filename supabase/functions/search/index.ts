/**
 * Semantic Search Edge Function
 *
 * Generates an embedding for the query, then performs vector-only or
 * hybrid (vector + FTS with RRF) search across one or more tables.
 * Keeps the OpenAI key in Supabase so the relay never needs it.
 *
 * POST body:
 *   {
 *     query: string,
 *     mode?: "vector" | "hybrid",             -- default: "vector" (backwards compat)
 *     table?: "messages" | "memory",           -- legacy single-table param
 *     tables?: string[],                       -- multi-table: ["messages", "memory", "documents", "summaries"]
 *     match_count?: number,                    -- default: 10
 *     match_threshold?: number,                -- default: 0.7 (vector-only mode)
 *     fts_weight?: number,                     -- default: 1.0 (hybrid mode)
 *     semantic_weight?: number                 -- default: 1.0 (hybrid mode)
 *   }
 *
 * Returns: array of matching rows with similarity/relevance scores.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

const COST_PER_1K_TOKENS = 0.00002; // text-embedding-3-small pricing

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const {
      query,
      mode = "vector",
      table,
      tables: tablesParam,
      match_count = 10,
      match_threshold = 0.7,
      fts_weight = 1.0,
      semantic_weight = 1.0,
    } = body;

    if (!query) {
      return json({ error: "Missing query" }, 400);
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return json({ error: "OPENAI_API_KEY not configured" }, 500);
    }

    // Resolve which tables to search.
    // Backwards compat: if `table` is provided (old API), use it.
    // New API: use `tables` array.
    const searchTables: string[] = tablesParam || [table || "messages"];

    // Generate embedding for the search query
    const embeddingResponse = await fetch(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: query,
        }),
      }
    );

    if (!embeddingResponse.ok) {
      const err = await embeddingResponse.text();
      return json({ error: `OpenAI error: ${err}` }, 500);
    }

    const { data, usage } = await embeddingResponse.json();
    const embedding = data[0].embedding;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let results;

    if (mode === "hybrid") {
      // Hybrid search: vector + FTS with RRF fusion
      const { data: hybridResults, error } = await supabase.rpc(
        "hybrid_search",
        {
          query_embedding: embedding,
          query_text: query,
          search_tables: searchTables,
          match_count,
          fts_weight,
          semantic_weight,
        }
      );

      if (error) {
        return json({ error: `Hybrid search error: ${error.message}` }, 500);
      }

      results = hybridResults;
    } else {
      // Vector-only search (backwards compatible)
      if (searchTables.length === 1) {
        // Single table: use specific match_* RPC (faster, backwards compat)
        const rpcMap: Record<string, string> = {
          messages: "match_messages",
          memory: "match_memory",
          documents: "match_documents",
          summaries: "match_summaries",
        };

        const rpcName = rpcMap[searchTables[0]];
        if (!rpcName) {
          return json({ error: `Unknown table: ${searchTables[0]}` }, 400);
        }

        const { data: rpcResults, error } = await supabase.rpc(rpcName, {
          query_embedding: embedding,
          match_threshold,
          match_count,
        });

        if (error) {
          return json({ error: `Search error: ${error.message}` }, 500);
        }

        results = rpcResults;
      } else {
        // Multi-table vector search: use hybrid_search with fts_weight=0
        const { data: multiResults, error } = await supabase.rpc(
          "hybrid_search",
          {
            query_embedding: embedding,
            query_text: query,
            search_tables: searchTables,
            match_count,
            fts_weight: 0,
            semantic_weight: 1.0,
          }
        );

        if (error) {
          return json({ error: `Multi-table search error: ${error.message}` }, 500);
        }

        results = multiResults;
      }
    }

    // Log search cost (best-effort)
    const tokensUsed = usage?.total_tokens || Math.ceil(query.length / 4);
    const costUsd = (tokensUsed / 1000) * COST_PER_1K_TOKENS;

    await supabase
      .from("logs")
      .insert({
        level: "info",
        event: "search",
        message: `Search: ${mode} across [${searchTables.join(",")}]`,
        metadata: {
          mode,
          tables: searchTables,
          match_count,
          results_count: results?.length || 0,
          tokens_est: tokensUsed,
          cost_usd: costUsd,
        },
      })
      .catch(() => {});

    return json(results || []);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
