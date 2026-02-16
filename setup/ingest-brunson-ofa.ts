#!/usr/bin/env bun
/**
 * Ingest Russell Brunson OFA Expert Challenge transcripts
 * into Atlas knowledge base via Supabase ingest Edge Function.
 *
 * Usage:
 *   bun run setup/ingest-brunson-ofa.ts
 *   bun run setup/ingest-brunson-ofa.ts --dry-run
 *   bun run setup/ingest-brunson-ofa.ts --force
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
const force = process.argv.includes("--force");

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const DATA_DIR = join(import.meta.dir, "..", "data", "training", "brunson-ofa");

const episodes = [
  { day: 1,  file: "day-1-One-Funnel-Away.txt",       title: "OFA Day 1: One Funnel Away" },
  { day: 2,  file: "day-2-Offer-Hacking.txt",          title: "OFA Day 2: Offer Hacking" },
  { day: 3,  file: "day-3-Creating-Your-Offer.txt",     title: "OFA Day 3: Creating Your Offer" },
  { day: 4,  file: "day-4-The-ASK-Campaign.txt",        title: "OFA Day 4: The ASK Campaign" },
  { day: 5,  file: "day-5-Building-Your-Funnel.txt",    title: "OFA Day 5: Building Your Funnel" },
  { day: 6,  file: "day-6-The-Perfect-Webinar.txt",     title: "OFA Day 6: The Perfect Webinar" },
  { day: 7,  file: "day-7-The-VSL-Page.txt",            title: "OFA Day 7: The VSL Page" },
  { day: 8,  file: "day-8-The-Order-Form.txt",          title: "OFA Day 8: The Order Form" },
  { day: 9,  file: "day-9-Your-Membership-Site.txt",    title: "OFA Day 9: Your Membership Site" },
  { day: 10, file: "day-10-Traffic.txt",                title: "OFA Day 10: Traffic" },
];

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function main() {
  console.log("Ingesting Russell Brunson OFA Expert Challenge transcripts");
  if (dryRun) console.log("(dry run)");

  // Get existing hashes for dedup
  const existingHashes = new Set<string>();
  if (!force) {
    const { data } = await supabase
      .from("documents")
      .select("content_hash")
      .eq("source", "brunson-ofa")
      .eq("chunk_index", 0);

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

  for (const ep of episodes) {
    const filePath = join(DATA_DIR, ep.file);
    let content: string;

    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      console.error(`  MISSING: ${ep.file}`);
      errors++;
      continue;
    }

    if (!content.trim()) {
      console.log(`  EMPTY: ${ep.file}`);
      skipped++;
      continue;
    }

    const hash = await sha256(content);
    if (!force && existingHashes.has(hash)) {
      console.log(`  SKIP: ${ep.title} (unchanged)`);
      skipped++;
      continue;
    }

    // Prepend context header so chunks carry metadata
    const enriched = [
      `# ${ep.title}`,
      `Source: Russell Brunson, One Funnel Away Expert Challenge (ClickFunnels)`,
      `Topic: Funnel building, direct response marketing, online business`,
      ``,
      content,
    ].join("\n");

    if (dryRun) {
      console.log(`  Would ingest: ${ep.title} (${enriched.length} chars)`);
      ingested++;
      continue;
    }

    try {
      const { data, error } = await supabase.functions.invoke("ingest", {
        body: {
          content: enriched,
          source: "brunson-ofa",
          source_path: `ofa-expert/day-${ep.day}`,
          title: ep.title,
          metadata: {
            author: "Russell Brunson",
            course: "One Funnel Away Expert Challenge",
            day: ep.day,
            platform: "ClickFunnels",
          },
        },
      });

      if (error) {
        console.error(`  ERROR: ${ep.title} - ${error.message}`);
        errors++;
      } else {
        const chunks = data?.chunks_created || "?";
        console.log(`  OK: ${ep.title} (${chunks} chunks, ${Math.round(enriched.length / 1024)} KB)`);
        ingested++;
      }
    } catch (err) {
      console.error(`  ERROR: ${ep.title} - ${err}`);
      errors++;
    }

    // Delay between files to avoid rate limiting the Edge Function
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone. Ingested: ${ingested}, Skipped: ${skipped}, Errors: ${errors}`);
}

main().catch(console.error);
