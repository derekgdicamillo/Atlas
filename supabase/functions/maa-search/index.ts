/**
 * MAA Knowledge Search Edge Function
 *
 * Embeds a query via OpenAI, then performs vector search on maa_knowledge.
 * Called by the MAA Advisor Cloudflare Worker.
 *
 * POST body:
 *   {
 *     query: string,          -- the user's question
 *     state_code?: string,    -- optional 2-letter state filter (e.g., "TX")
 *     match_count?: number,   -- default: 5
 *     match_threshold?: number -- default: 0.5
 *   }
 *
 * Returns: array of matching knowledge chunks with similarity scores.
 *
 * Secrets: OPENAI_API_KEY (auto-available from existing embed function config)
 * Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  try {
    const body = await req.json();
    const {
      query,
      state_code = null,
      match_count = 5,
      match_threshold = 0.5,
    } = body;

    if (!query || typeof query !== "string") {
      return json({ error: "Missing or invalid query" }, 400);
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return json({ error: "OPENAI_API_KEY not configured" }, 500);
    }

    // Generate embedding for the query
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
          input: query.substring(0, 2000),
        }),
      }
    );

    if (!embeddingResponse.ok) {
      const err = await embeddingResponse.text();
      return json({ error: `OpenAI error: ${err}` }, 500);
    }

    const { data } = await embeddingResponse.json();
    const embedding = data[0].embedding;

    // Search maa_knowledge via RPC
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: results, error } = await supabase.rpc(
      "maa_search_knowledge",
      {
        query_embedding: embedding,
        p_state_code: state_code,
        p_match_count: match_count,
        p_match_threshold: match_threshold,
      }
    );

    if (error) {
      return json({ error: `Search error: ${error.message}` }, 500);
    }

    return json(results || []);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
