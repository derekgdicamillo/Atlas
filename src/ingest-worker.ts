/**
 * Atlas -- Folder Ingestion Worker
 *
 * Walks a directory, parses supported file types (.txt, .md, .pdf, .docx),
 * and ingests each into the enterprise search pipeline via ingestDocument().
 * Files are chunked, embedded, and deduped by SHA-256 content hash.
 *
 * Runs as a background async task (no Claude CLI subprocess needed).
 * Reuses patterns from setup/ingest-obsidian.ts.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, relative, extname, basename } from "path";
import { PDFParse } from "pdf-parse";
import { info, warn, error as logError } from "./logger.ts";
import { ingestDocument, getRelevantContext, type IngestResult } from "./search.ts";
import { callHaiku } from "./haiku-client.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// CONSTANTS
// ============================================================

const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".pdf", ".docx"]);
const INGEST_DELAY_MS = 200;
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const MIN_TEXT_LENGTH = 20; // skip scanned/image-only PDFs

// ============================================================
// TYPES
// ============================================================

export interface IngestFolderOptions {
  path: string;
  source: string;
  supabase: SupabaseClient;
  recursive?: boolean;
  extensions?: Set<string>;
  onProgress?: (update: IngestProgress) => void;
  onComplete?: (result: IngestFolderResult) => void;
}

export interface IngestProgress {
  current: number;
  total: number;
  skipped: number;
  errors: number;
  currentFile: string;
  elapsedMs: number;
}

export interface IngestFolderResult {
  filesProcessed: number;
  filesSkipped: number;
  filesErrored: number;
  totalChunks: number;
  durationMs: number;
  errors: string[];
}

// ============================================================
// CONTEXTUAL CHUNKING
// ============================================================

export interface ContextualChunk {
  chunk_text: string;
  context_preamble: string;
  embed_text: string; // preamble + "\n\n" + chunk_text
}

export interface DocumentMetadata {
  title: string;
  date?: string;
  source: string;
  nearestHeading?: string;
}

const PREAMBLE_SYSTEM = `You write a single ≤80-token preamble situating a passage in its document. Format: "From [doc title] ([date if known]), [section if known]: this passage discusses [1-sentence topical summary]." Output the preamble only — no quotes, no markdown.`;

/**
 * Generate a Haiku-powered context preamble for each chunk and return
 * enriched ContextualChunk objects whose embed_text combines preamble + chunk.
 *
 * Pass a custom baseChunker to override the default 800-char overlap chunker.
 */
export async function chunkContextually(
  documentText: string,
  metadata: DocumentMetadata,
  baseChunker?: (text: string) => string[],
): Promise<ContextualChunk[]> {
  const chunkRaw = baseChunker ?? defaultChunker;
  const baseChunks = chunkRaw(documentText);
  const out: ContextualChunk[] = [];

  for (const chunk of baseChunks) {
    const userMessage = [
      `Document title: ${metadata.title}`,
      metadata.date ? `Date: ${metadata.date}` : "",
      metadata.nearestHeading ? `Section: ${metadata.nearestHeading}` : "",
      ``,
      `Passage:`,
      chunk,
    ]
      .filter(Boolean)
      .join("\n");

    let preamble = "";
    try {
      const result = await callHaiku({
        system: PREAMBLE_SYSTEM,
        userMessage,
        maxTokens: 100,
        cacheSystem: true,
      });
      preamble = result.text.trim().slice(0, 400);
    } catch (err) {
      logError("ingest-worker", `preamble generation failed: ${err}`);
      preamble = `From ${metadata.title}.`;
    }

    out.push({
      chunk_text: chunk,
      context_preamble: preamble,
      embed_text: preamble + "\n\n" + chunk,
    });
  }

  return out;
}

/**
 * Default chunker: 800-char target with 100-char overlap.
 * Used when no baseChunker is supplied to chunkContextually().
 */
function defaultChunker(text: string): string[] {
  const CHUNK_SIZE = 800;
  const OVERLAP = 100;
  const out: string[] = [];
  if (text.length === 0) return out;
  for (let i = 0; i < text.length; i += CHUNK_SIZE - OVERLAP) {
    out.push(text.slice(i, i + CHUNK_SIZE));
  }
  return out;
}

/**
 * Generate an OpenAI text-embedding-3-small embedding for the given text.
 * Used client-side so we can embed preamble+chunk before insert.
 */
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

// ============================================================
// DIRECTORY WALKER
// ============================================================

async function walkDirectory(
  dir: string,
  extensions: Set<string>,
  recursive: boolean,
): Promise<string[]> {
  const files: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    warn("ingest-worker", `Cannot read directory ${dir}: ${err}`);
    return files;
  }

  for (const entry of entries) {
    // Skip hidden files/dirs, node_modules, .trash, desktop.ini, Thumbs.db
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules" || entry.name === ".trash") continue;
    if (entry.name.toLowerCase() === "desktop.ini") continue;
    if (entry.name.toLowerCase() === "thumbs.db") continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory() && recursive) {
      files.push(...(await walkDirectory(fullPath, extensions, recursive)));
    } else if (extensions.has(extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

// ============================================================
// FILE PARSERS
// ============================================================

async function parseTextFile(filePath: string): Promise<string> {
  return await readFile(filePath, "utf-8");
}

async function parsePdfFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  await parser.destroy();
  return result.text;
}

async function parseDocxFile(filePath: string): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

async function parseFileContent(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();

  switch (ext) {
    case ".txt":
    case ".md":
    case ".markdown":
      return await parseTextFile(filePath);
    case ".pdf":
      return await parsePdfFile(filePath);
    case ".docx":
      return await parseDocxFile(filePath);
    default:
      return "";
  }
}

// ============================================================
// SHA-256 HASHING
// ============================================================

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
// DEDUP: FETCH EXISTING HASHES
// ============================================================

async function getExistingHashes(
  supabase: SupabaseClient,
  source: string,
): Promise<Set<string>> {
  const hashes = new Set<string>();

  try {
    const { data } = await supabase
      .from("documents")
      .select("content_hash")
      .eq("source", source)
      .eq("chunk_index", 0);

    if (data) {
      for (const row of data) {
        if (row.content_hash) hashes.add(row.content_hash);
      }
    }
  } catch (err) {
    warn("ingest-worker", `Failed to fetch existing hashes for source=${source}: ${err}`);
  }

  return hashes;
}

// ============================================================
// MAIN ORCHESTRATOR
// ============================================================

export async function ingestFolder(opts: IngestFolderOptions): Promise<IngestFolderResult> {
  const startTime = Date.now();
  const extensions = opts.extensions || SUPPORTED_EXTENSIONS;
  const recursive = opts.recursive !== false;

  info("ingest-worker", `Starting folder ingestion: ${opts.path} (source: ${opts.source})`);

  // Walk directory
  const files = await walkDirectory(opts.path, extensions, recursive);
  info("ingest-worker", `Found ${files.length} supported files`);

  if (files.length === 0) {
    const result: IngestFolderResult = {
      filesProcessed: 0,
      filesSkipped: 0,
      filesErrored: 0,
      totalChunks: 0,
      durationMs: Date.now() - startTime,
      errors: [],
    };
    opts.onComplete?.(result);
    return result;
  }

  // Pre-fetch existing hashes for dedup
  const existingHashes = await getExistingHashes(opts.supabase, opts.source);
  info("ingest-worker", `${existingHashes.size} files already ingested for source=${opts.source}`);

  let processed = 0;
  let skipped = 0;
  let errored = 0;
  let totalChunks = 0;
  const errors: string[] = [];

  for (const filePath of files) {
    const relPath = relative(opts.path, filePath);

    // Progress callback
    opts.onProgress?.({
      current: processed + skipped + errored + 1,
      total: files.length,
      skipped,
      errors: errored,
      currentFile: relPath,
      elapsedMs: Date.now() - startTime,
    });

    try {
      // Size check
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        warn("ingest-worker", `Skipping ${relPath}: exceeds ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB limit`);
        skipped++;
        continue;
      }

      // Parse text content
      let textContent: string;
      try {
        textContent = await parseFileContent(filePath);
      } catch (parseErr) {
        // File might be locked, corrupted, or cloud-only (OneDrive placeholder)
        errored++;
        const msg = `${relPath}: parse error: ${parseErr}`;
        errors.push(msg);
        warn("ingest-worker", msg);
        continue;
      }

      if (!textContent || textContent.trim().length < MIN_TEXT_LENGTH) {
        skipped++;
        continue;
      }

      // Dedup check via SHA-256
      const hash = await sha256(textContent);
      if (existingHashes.has(hash)) {
        skipped++;
        continue;
      }

      // Extract title from first heading or filename
      const titleMatch = textContent.match(/^#\s+(.+)/m);
      const title = titleMatch ? titleMatch[1] : basename(filePath).replace(/\.[^/.]+$/, "");

      // Contextual chunking: generate per-chunk preambles via Haiku, embed client-side
      let chunksInserted = 0;
      let chunkError: string | undefined;
      try {
        const contextualChunks = await chunkContextually(textContent, {
          title,
          source: opts.source,
        });

        const rows = await Promise.all(
          contextualChunks.map(async (c, index) => {
            const embedding = await embedText(c.embed_text);
            return {
              source: opts.source,
              source_path: relPath,
              title,
              content: c.chunk_text,
              context_preamble: c.context_preamble,
              chunked_strategy: "contextual-v1" as const,
              chunk_index: index,
              chunk_count: contextualChunks.length,
              content_hash: hash,
              token_count: Math.ceil(c.chunk_text.length / 4),
              metadata: { rootDir: opts.path, originalPath: filePath },
              embedding,
            };
          }),
        );

        // Insert in batches of 10 to avoid payload limits
        const BATCH = 10;
        for (let b = 0; b < rows.length; b += BATCH) {
          const { error: insertErr } = await opts.supabase
            .from("documents")
            .insert(rows.slice(b, b + BATCH));
          if (insertErr) throw new Error(insertErr.message);
        }
        chunksInserted = rows.length;
      } catch (err) {
        chunkError = String(err);
      }

      if (chunkError) {
        errored++;
        const msg = `${relPath}: ingest error: ${chunkError}`;
        errors.push(msg);
        warn("ingest-worker", msg);
      } else {
        processed++;
        totalChunks += chunksInserted;
        existingHashes.add(hash); // prevent re-processing within same batch
        info("ingest-worker", `Ingested: ${relPath} (${chunksInserted} chunks, contextual-v1)`);
      }
    } catch (err) {
      errored++;
      const msg = `${relPath}: ${err}`;
      errors.push(msg);
      warn("ingest-worker", msg);
    }

    // Rate limiting
    await new Promise((r) => setTimeout(r, INGEST_DELAY_MS));
  }

  const finalResult: IngestFolderResult = {
    filesProcessed: processed,
    filesSkipped: skipped,
    filesErrored: errored,
    totalChunks,
    durationMs: Date.now() - startTime,
    errors: errors.slice(0, 10),
  };

  info(
    "ingest-worker",
    `Ingestion complete: ${processed} files (${totalChunks} chunks), ${skipped} skipped, ${errored} errors. ${Math.round(finalResult.durationMs / 1000)}s.`
  );

  opts.onComplete?.(finalResult);
  return finalResult;
}

/**
 * Auto-detect source name from a file path.
 */
export function detectSource(path: string): string {
  const lower = path.toLowerCase();
  if (lower.includes("onedrive")) return "onedrive";
  if (lower.includes("sharepoint")) return "sharepoint";
  if (lower.includes("training")) return "training";
  if (lower.includes("obsidian")) return "obsidian";
  return "local";
}
