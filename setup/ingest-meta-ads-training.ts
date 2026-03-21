#!/usr/bin/env bun
/**
 * Meta Ads Training Data Ingestion
 *
 * Deletes old chunks for the Meta Ads training file, then re-ingests
 * the updated facebook-ads-bestpractices.md into enterprise search.
 *
 * Usage:
 *   bun run setup/ingest-meta-ads-training.ts
 *   bun run setup/ingest-meta-ads-training.ts --dry-run
 */
import { createClient } from "@supabase/supabase-js";
import { readFile } from "fs/promises";
import { join } from "path";
import { config } from "dotenv";
config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const FILE_PATH = join("C:/Users/Derek DiCamillo/Projects/atlas/data/training/facebook-ads-bestpractices.md");
const SOURCE = "training";
const SOURCE_PATH = "facebook-ads-bestpractices.md";

async function main() {
  console.log("Meta Ads Training Data Ingestion");
  console.log("================================");
  if (dryRun) console.log("DRY RUN MODE\n");

  // Step 1: Delete old chunks for this file
  console.log("\n--- Step 1: Removing old chunks ---");
  const { data: oldChunks, error: fetchErr } = await supabase
    .from("documents")
    .select("id")
    .eq("source", SOURCE)
    .eq("source_path", SOURCE_PATH);

  if (fetchErr) {
    console.error(`Error fetching old chunks: ${fetchErr.message}`);
  } else if (oldChunks?.length) {
    console.log(`Found ${oldChunks.length} old chunks to remove`);
    if (!dryRun) {
      const { error: delErr } = await supabase
        .from("documents")
        .delete()
        .eq("source", SOURCE)
        .eq("source_path", SOURCE_PATH);
      if (delErr) {
        console.error(`Error deleting: ${delErr.message}`);
      } else {
        console.log(`Deleted ${oldChunks.length} old chunks`);
      }
    }
  } else {
    // Try alternate source_path patterns
    const { data: altChunks } = await supabase
      .from("documents")
      .select("id, source_path")
      .eq("source", SOURCE)
      .ilike("source_path", "%facebook-ads%");

    if (altChunks?.length) {
      console.log(`Found ${altChunks.length} old chunks (alternate path: ${altChunks[0]?.source_path})`);
      if (!dryRun) {
        const { error: delErr } = await supabase
          .from("documents")
          .delete()
          .eq("source", SOURCE)
          .ilike("source_path", "%facebook-ads%");
        if (delErr) {
          console.error(`Error deleting: ${delErr.message}`);
        } else {
          console.log(`Deleted ${altChunks.length} old chunks`);
        }
      }
    } else {
      console.log("No old chunks found (first ingestion)");
    }
  }

  // Step 2: Read and ingest the updated file
  console.log("\n--- Step 2: Ingesting updated file ---");
  const content = await readFile(FILE_PATH, "utf-8");
  console.log(`File size: ${content.length} chars`);

  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1] : "Meta Ads Best Practices";

  if (dryRun) {
    console.log(`Would ingest: ${title} (${content.length} chars)`);
    console.log("\nDone (dry run)!");
    return;
  }

  const { data, error } = await supabase.functions.invoke("ingest", {
    body: {
      content,
      source: SOURCE,
      source_path: SOURCE_PATH,
      title,
      metadata: { type: "training", topic: "meta-ads", updated: new Date().toISOString() },
    },
  });

  if (error) {
    console.error(`Ingest error: ${error.message}`);
    process.exit(1);
  }

  console.log(`Ingested: ${data?.chunks_created || 0} chunks created`);
  console.log(`Document hash: ${data?.document_hash || "n/a"}`);

  console.log("\n================================");
  console.log("Done! Meta Ads training data is now live in enterprise search.");
}

main().catch(console.error);
