#!/usr/bin/env bun
/**
 * Obsidian Vault Ingestion Script
 *
 * Walks an Obsidian vault directory, reads .md files, and ingests them
 * into the Atlas knowledge base via the Supabase ingest Edge Function.
 * Uses content hashing to skip unchanged files on re-runs.
 *
 * Usage:
 *   bun run setup/ingest-obsidian.ts --vault <path>
 *   bun run setup/ingest-obsidian.ts --vault C:\Users\derek\Obsidian\Main
 *
 * Options:
 *   --vault <path>   Path to Obsidian vault (required)
 *   --dry-run        Show what would be ingested without doing it
 *   --force          Re-ingest all files even if unchanged
 */

import { createClient } from "@supabase/supabase-js";
import { readdir, readFile, stat } from "fs/promises";
import { join, relative, extname } from "path";
import { config } from "dotenv";

config(); // Load .env from project root

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

// Parse CLI args
const args = process.argv.slice(2);
let vaultPath = "";
let dryRun = false;
let force = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--vault" && args[i + 1]) {
    vaultPath = args[++i];
  } else if (args[i] === "--dry-run") {
    dryRun = true;
  } else if (args[i] === "--force") {
    force = true;
  }
}

if (!vaultPath) {
  console.error("Usage: bun run setup/ingest-obsidian.ts --vault <path>");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// WALK VAULT
// ============================================================

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Skip hidden dirs/files (Obsidian metadata, .git, etc.)
    if (entry.name.startsWith(".")) continue;
    // Skip node_modules, .trash
    if (entry.name === "node_modules" || entry.name === ".trash") continue;

    if (entry.isDirectory()) {
      files.push(...(await walkDir(fullPath)));
    } else if (extname(entry.name).toLowerCase() === ".md") {
      files.push(fullPath);
    }
  }

  return files;
}

// ============================================================
// SHA-256
// ============================================================

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`Scanning vault: ${vaultPath}`);
  if (dryRun) console.log("(dry run - no changes will be made)");

  const files = await walkDir(vaultPath);
  console.log(`Found ${files.length} .md files`);

  // Get existing content hashes from documents table (for dedup)
  const existingHashes = new Set<string>();
  if (!force) {
    const { data } = await supabase
      .from("documents")
      .select("content_hash")
      .eq("source", "obsidian")
      .eq("chunk_index", 0); // only check first chunk of each doc

    if (data) {
      for (const row of data) {
        if (row.content_hash) existingHashes.add(row.content_hash);
      }
    }
    console.log(`${existingHashes.size} files already ingested`);
  }

  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  for (const filePath of files) {
    const relPath = relative(vaultPath, filePath);
    const content = await readFile(filePath, "utf-8");

    // Skip empty files
    if (!content.trim()) {
      skipped++;
      continue;
    }

    // Check content hash for dedup
    const hash = await sha256(content);
    if (!force && existingHashes.has(hash)) {
      skipped++;
      continue;
    }

    // Extract title from first heading or filename
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1] : relPath.replace(/\.md$/, "");

    if (dryRun) {
      console.log(`  Would ingest: ${relPath} (${content.length} chars)`);
      ingested++;
      continue;
    }

    try {
      const { data, error } = await supabase.functions.invoke("ingest", {
        body: {
          content,
          source: "obsidian",
          source_path: relPath,
          title,
          metadata: { vault: vaultPath },
        },
      });

      if (error) {
        console.error(`  ERROR ${relPath}: ${error.message}`);
        errors++;
      } else {
        const chunks = data?.chunks_created || 0;
        console.log(`  Ingested: ${relPath} (${chunks} chunks)`);
        ingested++;
      }
    } catch (err) {
      console.error(`  ERROR ${relPath}: ${err}`);
      errors++;
    }

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\nDone. Ingested: ${ingested}, Skipped: ${skipped}, Errors: ${errors}`);
}

main().catch(console.error);
