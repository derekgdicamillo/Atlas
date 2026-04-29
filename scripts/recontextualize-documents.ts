#!/usr/bin/env bun
/**
 * Backfill script: Re-chunk + re-embed all documents rows where
 * chunked_strategy = 'raw' by generating Haiku context preambles and
 * producing a new embedding from preamble + chunk text.
 *
 * Idempotent — rows are updated in-place, and the WHERE clause filters
 * only 'raw' rows, so re-running is safe.
 *
 * Rate: ~100 rows/min (600 ms/row) to respect Haiku API limits.
 * Estimated cost: ~$0.0003/row (Haiku preamble + OpenAI embedding).
 *
 * Usage:
 *   bun scripts/recontextualize-documents.ts
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { callHaiku } from "../src/haiku-client.ts";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

const PREAMBLE_SYSTEM = `You write a single ≤80-token preamble situating a passage in its document. Format: "From [doc title] ([date if known]): this passage discusses [1-sentence topical summary]." Output the preamble only — no quotes, no markdown.`;

const RATE_PER_MIN = 100;
const SLEEP_MS = Math.floor(60_000 / RATE_PER_MIN); // 600 ms per row
const BATCH = 50;

async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("embedText: OPENAI_API_KEY not set");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return j.data[0].embedding;
}

async function processOne(row: {
  id: string;
  title: string | null;
  source: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
}): Promise<void> {
  const title = row.title ?? "(unknown)";

  const userMessage = [
    `Document title: ${title}`,
    row.metadata?.date ? `Date: ${row.metadata.date}` : "",
    row.source ? `Source: ${row.source}` : "",
    ``,
    `Passage:`,
    row.content,
  ]
    .filter(Boolean)
    .join("\n");

  let preamble: string;
  try {
    const r = await callHaiku({
      system: PREAMBLE_SYSTEM,
      userMessage,
      maxTokens: 100,
      cacheSystem: true,
    });
    preamble = r.text.trim().slice(0, 400);
  } catch (err) {
    console.error(`[backfill] preamble failed for ${row.id}:`, err);
    preamble = `From ${title}.`;
  }

  const combined = preamble + "\n\n" + row.content;
  const embedding = await embedText(combined);

  const { error } = await supabase
    .from("documents")
    .update({
      context_preamble: preamble,
      chunked_strategy: "contextual-v1",
      embedding,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (error) throw new Error(`update failed for ${row.id}: ${error.message}`);
}

async function main(): Promise<void> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error("[backfill] SUPABASE_URL and SUPABASE_ANON_KEY are required");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[backfill] ANTHROPIC_API_KEY is required");
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("[backfill] OPENAI_API_KEY is required");
    process.exit(1);
  }

  let processed = 0;
  let failed = 0;
  const startTime = Date.now();

  console.log("[backfill] Starting recontextualize pass (chunked_strategy = raw)...");

  while (true) {
    const { data, error } = await supabase
      .from("documents")
      .select("id, title, source, content, metadata")
      .eq("chunked_strategy", "raw")
      .limit(BATCH);

    if (error) {
      console.error("[backfill] Query failed:", error);
      process.exit(1);
    }

    if (!data || data.length === 0) break;

    console.log(`[backfill] Processing batch of ${data.length} rows (total so far: ${processed})`);

    for (const row of data) {
      try {
        await processOne(row as {
          id: string;
          title: string | null;
          source: string | null;
          content: string;
          metadata: Record<string, unknown> | null;
        });
        processed++;
        if (processed % 50 === 0) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(`[backfill] ${processed} processed, ${failed} failed — ${elapsed}s elapsed`);
        }
      } catch (err) {
        console.error(`[backfill] row ${row.id} failed:`, err);
        failed++;
      }

      await new Promise((r) => setTimeout(r, SLEEP_MS));
    }
  }

  const totalSecs = Math.round((Date.now() - startTime) / 1000);
  console.log(
    `[backfill] Complete: ${processed} updated, ${failed} failed — ${totalSecs}s total`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
