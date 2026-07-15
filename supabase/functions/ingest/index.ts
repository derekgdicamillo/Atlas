/**
 * Document Ingestion Edge Function
 *
 * Accepts raw text content, chunks it recursively, and inserts chunks
 * into the documents table. Embeddings are generated automatically by
 * the embed Edge Function via database webhook.
 *
 * POST body:
 *   {
 *     content: string,           -- full document text
 *     source?: string,           -- "obsidian" | "pdf" | "url" | "telegram" | "manual"
 *     source_path?: string,      -- original file path or URL
 *     title?: string,            -- document title
 *     metadata?: object          -- arbitrary metadata
 *   }
 *
 * Returns:
 *   { chunks_created: number, chunks_skipped: number, chunks_deleted: number, document_hash: string }
 *
 * Re-ingest / self-heal behavior:
 *   When a source_path is provided, (source, source_path) identifies one
 *   logical document. On re-ingest we (a) skip if the current content is
 *   already present unchanged, and (b) delete any prior chunks for the same
 *   (source, source_path) whose content_hash differs — so editing a file
 *   REPLACES its chunks instead of orphaning the old version. Path-less
 *   ingests (source_path null, e.g. "manual") keep the original global
 *   content-hash dedup with no deletion.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

// Target ~512 tokens per chunk. 1 token ~ 4 chars for English text.
const TARGET_CHUNK_CHARS = 2000;
const OVERLAP_CHARS = 200;
const MIN_CHUNK_CHARS = 100; // don't create tiny chunks

Deno.serve(async (req) => {
  try {
    const {
      content,
      source = "manual",
      source_path,
      title,
      metadata = {},
    } = await req.json();

    if (!content || typeof content !== "string") {
      return json({ error: "Missing or invalid content" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Content hash for deduplication
    const contentHash = await sha256(content);

    // Is the CURRENT content already present? Scope the check to
    // (source, source_path) when a path is given so distinct documents
    // that happen to share content don't shadow each other; fall back to
    // the original global content-hash check for path-less ingests.
    let existingQuery = supabase
      .from("documents")
      .select("id")
      .eq("content_hash", contentHash)
      .eq("chunk_index", 0)
      .limit(1);
    if (source_path) {
      existingQuery = existingQuery.eq("source", source).eq("source_path", source_path);
    }
    const { data: existing } = await existingQuery;
    const unchanged = !!(existing && existing.length > 0);

    // Chunk + insert only when the current content isn't already stored.
    let chunksCreated = 0;
    if (!unchanged) {
      const chunks = recursiveChunk(content, TARGET_CHUNK_CHARS, OVERLAP_CHARS);
      const rows = chunks.map((chunk, index) => ({
        source,
        source_path: source_path || null,
        title: title || null,
        content: chunk,
        chunk_index: index,
        chunk_count: chunks.length,
        content_hash: contentHash,
        token_count: Math.ceil(chunk.length / 4),
        metadata,
      }));

      const { error } = await supabase.from("documents").insert(rows);
      if (error) {
        return json({ error: `Insert failed: ${error.message}` }, 500);
      }
      chunksCreated = chunks.length;
    }

    // Self-heal: remove any PRIOR chunks for this logical document
    // (same source + source_path) whose content differs from the version
    // we just confirmed/inserted. Runs on both changed and unchanged paths
    // so pre-existing orphans get cleaned up too. Insert-before-delete means
    // there is never a moment with zero current chunks for a changed doc.
    let chunksDeleted = 0;
    if (source_path) {
      const { data: deleted, error: delError } = await supabase
        .from("documents")
        .delete()
        .eq("source", source)
        .eq("source_path", source_path)
        .neq("content_hash", contentHash)
        .select("id");
      if (delError) {
        return json({ error: `Stale-chunk cleanup failed: ${delError.message}` }, 500);
      }
      chunksDeleted = deleted ? deleted.length : 0;
    }

    return json({
      chunks_created: chunksCreated,
      chunks_skipped: unchanged ? 1 : 0,
      chunks_deleted: chunksDeleted,
      document_hash: contentHash,
      ...(unchanged ? { message: "Document already ingested (matching content hash)" } : {}),
    });
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});

// ============================================================
// RECURSIVE CHUNKING
// ============================================================

/**
 * Split text into chunks of approximately targetSize characters.
 * Uses a hierarchy of separators to avoid breaking mid-sentence:
 *   1. Double newline (paragraph breaks)
 *   2. Single newline
 *   3. Period + space (sentence breaks)
 *   4. Space (word breaks)
 *
 * Each chunk overlaps with the next by overlapSize characters
 * to preserve context across boundaries.
 */
function recursiveChunk(
  text: string,
  targetSize: number,
  overlapSize: number
): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= targetSize) {
    return [trimmed];
  }

  const separators = ["\n\n", "\n", ". ", " "];
  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length) {
    // End of last chunk? Just take the rest.
    if (start + targetSize >= trimmed.length) {
      const remaining = trimmed.slice(start).trim();
      if (remaining.length >= MIN_CHUNK_CHARS) {
        chunks.push(remaining);
      } else if (chunks.length > 0) {
        // Append small remainder to last chunk
        chunks[chunks.length - 1] += " " + remaining;
      } else {
        chunks.push(remaining);
      }
      break;
    }

    // Find best split point within target window
    const window = trimmed.slice(start, start + targetSize);
    let splitAt = -1;

    for (const sep of separators) {
      const lastIdx = window.lastIndexOf(sep);
      if (lastIdx > targetSize * 0.3) {
        // Don't split too early (at least 30% into the chunk)
        splitAt = lastIdx + sep.length;
        break;
      }
    }

    // Fallback: hard split at target size
    if (splitAt === -1) {
      splitAt = targetSize;
    }

    const chunk = trimmed.slice(start, start + splitAt).trim();
    if (chunk.length >= MIN_CHUNK_CHARS) {
      chunks.push(chunk);
    }

    // Advance with overlap
    start += splitAt - overlapSize;
    if (start < 0) start = splitAt; // safety
  }

  return chunks;
}

// ============================================================
// HELPERS
// ============================================================

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
