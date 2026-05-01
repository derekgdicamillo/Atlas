#!/usr/bin/env bun
/**
 * One-shot: ingest the PV-Knowledge-Layer repo into Supabase under
 * source="pv-knowledge-layer". Walks the directory and pushes each
 * file through the same Supabase Edge Function (`ingest`) that the
 * journal-ingest cron uses — which handles chunking + embedding
 * server-side and dedups by content hash on re-runs.
 *
 * Why not src/ingest-worker.ts? That worker writes to a
 * `chunked_strategy` column that isn't on the live schema (drift
 * between code and DB). The Edge Function path is schema-compatible
 * with what's deployed.
 *
 * Usage:
 *   bun run scripts/ingest-knowledge-layer.ts
 *   bun run scripts/ingest-knowledge-layer.ts --path "C:\custom\path"
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { readdir, readFile, stat } from "fs/promises";
import { join, relative, extname, basename } from "path";
import { ingestDocument } from "../src/search.ts";

config({ override: true });

const DEFAULT_PATH = process.env.PV_KNOWLEDGE_LAYER_DIR
  || "C:\\Users\\Derek DiCamillo\\Projects\\PV-Knowledge-Layer\\knowledge";
const SUPPORTED = new Set([".md", ".markdown", ".txt"]);
const MIN_LEN = 50;

const args = process.argv.slice(2);
let knowledgePath = DEFAULT_PATH;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--path" && args[i + 1]) knowledgePath = args[++i];
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env");
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (SUPPORTED.has(extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

console.log(`Ingesting ${knowledgePath} as source="pv-knowledge-layer"...`);
const files = await walk(knowledgePath);
console.log(`Found ${files.length} files.\n`);

const t0 = Date.now();
let processed = 0;
let skipped = 0;
let errored = 0;
let totalChunks = 0;
const errors: string[] = [];

for (const filePath of files) {
  const rel = relative(knowledgePath, filePath);
  try {
    const fst = await stat(filePath);
    if (fst.size > 50 * 1024 * 1024) { skipped++; continue; }
    const text = await readFile(filePath, "utf-8");
    if (!text || text.trim().length < MIN_LEN) { skipped++; continue; }

    const titleMatch = text.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1] : basename(filePath).replace(/\.[^/.]+$/, "");

    const result = await ingestDocument(supabase, text, {
      source: "pv-knowledge-layer",
      sourcePath: rel,
      title,
      metadata: { rootDir: knowledgePath, originalPath: filePath, repo: "PV-Knowledge-Layer" },
    });

    if (result.error) {
      errored++;
      errors.push(`${rel}: ${result.error}`);
      console.log(`  [${processed + skipped + errored}/${files.length}] ERR  ${rel}: ${result.error}`);
    } else if (result.chunks_created === 0 && result.chunks_skipped > 0) {
      skipped++;
      processed++;
    } else {
      processed++;
      totalChunks += result.chunks_created;
      if (processed % 5 === 0 || processed === files.length) {
        console.log(`  [${processed + skipped + errored}/${files.length}] OK   ${rel} (+${result.chunks_created} chunks)`);
      }
    }
  } catch (err) {
    errored++;
    errors.push(`${rel}: ${err}`);
    console.log(`  [${processed + skipped + errored}/${files.length}] EXC  ${rel}: ${err}`);
  }
}

console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s.`);
console.log(`  files processed: ${processed}`);
console.log(`  files skipped:   ${skipped}`);
console.log(`  files errored:   ${errored}`);
console.log(`  total chunks:    ${totalChunks}`);
if (errors.length > 0) {
  console.log(`\nFirst errors:`);
  errors.slice(0, 10).forEach((e) => console.log(`  - ${e}`));
}
