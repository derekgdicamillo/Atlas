/**
 * Auto-Embedding Edge Function
 *
 * Called via database webhook on INSERT to messages/memory/documents/summaries tables.
 * Generates an OpenAI embedding and stores it on the row.
 * Logs estimated cost to the logs table for tracking.
 *
 * Secrets required:
 *   OPENAI_API_KEY -- stored in Supabase Edge Function secrets
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

const COST_PER_1K_TOKENS = 0.00002; // text-embedding-3-small pricing

Deno.serve(async (req) => {
  try {
    const { record, table } = await req.json();

    if (!record?.content || !record?.id) {
      return new Response("Missing record data", { status: 400 });
    }

    // Skip if embedding already exists
    if (record.embedding) {
      return new Response("Already embedded", { status: 200 });
    }

    // Validate table name (only embed known tables)
    const allowedTables = ["messages", "memory", "documents", "summaries"];
    if (!allowedTables.includes(table)) {
      return new Response(`Unknown table: ${table}`, { status: 400 });
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return new Response("OPENAI_API_KEY not configured", { status: 500 });
    }

    // Generate embedding via OpenAI
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
          input: record.content,
        }),
      }
    );

    if (!embeddingResponse.ok) {
      const err = await embeddingResponse.text();
      return new Response(`OpenAI error: ${err}`, { status: 500 });
    }

    const { data, usage } = await embeddingResponse.json();
    const embedding = data[0].embedding;

    // Estimate tokens (use actual usage if available, else approximate)
    const tokensUsed = usage?.total_tokens || Math.ceil(record.content.length / 4);
    const costUsd = (tokensUsed / 1000) * COST_PER_1K_TOKENS;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Update the row with the embedding
    const { error } = await supabase
      .from(table)
      .update({ embedding })
      .eq("id", record.id);

    if (error) {
      return new Response(`Supabase update error: ${error.message}`, {
        status: 500,
      });
    }

    // Log cost (best-effort, don't fail the request)
    // Best-effort cost logging
    supabase.from("logs").insert({
      level: "info",
      event: "embedding",
      message: `Embedded ${table} row ${record.id}`,
      metadata: {
        table,
        record_id: record.id,
        tokens_est: tokensUsed,
        cost_usd: costUsd,
      },
    }).then(() => {});

    return new Response("ok");
  } catch (error) {
    return new Response(String(error), { status: 500 });
  }
});
