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

      // Ingest via Supabase edge function
      const result = await ingestDocument(opts.supabase, textContent, {
        source: opts.source,
        sourcePath: relPath,
        title,
        metadata: { rootDir: opts.path, originalPath: filePath },
      });

      if (result.error) {
        errored++;
        const msg = `${relPath}: ingest error: ${result.error}`;
        errors.push(msg);
        warn("ingest-worker", msg);
      } else {
        processed++;
        totalChunks += result.chunks_created;
        existingHashes.add(hash); // prevent re-processing within same batch
        info("ingest-worker", `Ingested: ${relPath} (${result.chunks_created} chunks)`);
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
