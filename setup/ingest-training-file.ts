#!/usr/bin/env bun
/**
 * Training File Ingestion (Generic)
 *
 * Deletes old chunks for a training file, then re-ingests into enterprise search.
 * Works with any .md file in data/training/.
 *
 * Usage:
 *   bun run setup/ingest-training-file.ts <filename>
 *   bun run setup/ingest-training-file.ts <filename> --dry-run
 *   bun run setup/ingest-training-file.ts --all              # re-ingest all training files
 *   bun run setup/ingest-training-file.ts --all --dry-run
 *
 * Examples:
 *   bun run setup/ingest-training-file.ts facebook-ads-bestpractices.md
 *   bun run setup/ingest-training-file.ts ghl-platform-updates-2024-2026.md
 *   bun run setup/ingest-training-file.ts --all
 */
import { createClient } from "@supabase/supabase-js";
import { readFile, readdir } from "fs/promises";
import { join, basename } from "path";
import { config } from "dotenv";
config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
const all = process.argv.includes("--all");
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const TRAINING_DIR = join("C:/Users/Derek DiCamillo/Projects/atlas/data/training");
const SOURCE = "training";

async function ingestFile(filename: string): Promise<void> {
  const filePath = join(TRAINING_DIR, filename);
  const sourcePath = filename;

  console.log(`\n--- Processing: ${filename} ---`);

  // Step 1: Delete old chunks
  const { data: oldChunks, error: fetchErr } = await supabase
    .from("documents")
    .select("id")
    .eq("source", SOURCE)
    .eq("source_path", sourcePath);

  if (fetchErr) {
    console.error(`  Error fetching old chunks: ${fetchErr.message}`);
  } else if (oldChunks?.length) {
    console.log(`  Found ${oldChunks.length} old chunks`);
    if (!dryRun) {
      const { error: delErr } = await supabase
        .from("documents")
        .delete()
        .eq("source", SOURCE)
        .eq("source_path", sourcePath);
      if (delErr) {
        console.error(`  Error deleting: ${delErr.message}`);
      } else {
        console.log(`  Deleted ${oldChunks.length} old chunks`);
      }
    }
  } else {
    console.log(`  No old chunks (first ingestion or different source)`);
  }

  // Step 2: Read and ingest
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    console.error(`  Cannot read file: ${err}`);
    return;
  }

  if (!content.trim() || content.trim().length < 50) {
    console.log(`  Skipping: file too short`);
    return;
  }

  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1] : filename.replace(/\.md$/, "").replace(/-/g, " ");
  const topic = filename.replace(/\.md$/, "").replace(/-/g, "-");

  console.log(`  Title: ${title} (${content.length} chars)`);

  if (dryRun) {
    console.log(`  Would ingest: ${content.length} chars`);
    return;
  }

  const { data, error } = await supabase.functions.invoke("ingest", {
    body: {
      content,
      source: SOURCE,
      source_path: sourcePath,
      title,
      metadata: { type: "training", topic, updated: new Date().toISOString() },
    },
  });

  if (error) {
    console.error(`  Ingest error: ${error.message}`);
    return;
  }

  console.log(`  Ingested: ${data?.chunks_created || 0} chunks (hash: ${data?.document_hash?.slice(0, 12) || "n/a"})`);
}

async function main() {
  console.log("Training File Ingestion");
  console.log("=======================");
  if (dryRun) console.log("DRY RUN MODE");

  let files: string[];

  if (all) {
    const entries = await readdir(TRAINING_DIR);
    files = entries.filter((f) => f.endsWith(".md"));
    console.log(`Found ${files.length} .md files in ${TRAINING_DIR}`);
  } else if (args.length > 0) {
    files = args;
  } else {
    console.error("Usage: bun run setup/ingest-training-file.ts <filename.md> [--dry-run]");
    console.error("       bun run setup/ingest-training-file.ts --all [--dry-run]");
    process.exit(1);
  }

  for (const file of files) {
    await ingestFile(file);
    await new Promise((r) => setTimeout(r, 500)); // rate limit
  }

  console.log("\n=======================");
  console.log("Done!");
}

main().catch(console.error);
