#!/usr/bin/env bun
/**
 * One-shot: ingest the PV-Knowledge-Layer repo into Supabase under
 * source="pv-knowledge-layer". Reuses the same ingestFolder() worker
 * the relay uses for [INGEST_FOLDER:] tags so dedup-by-content-hash
 * means re-runs only re-process changed files.
 *
 * Usage:
 *   bun run scripts/ingest-knowledge-layer.ts
 *   bun run scripts/ingest-knowledge-layer.ts --path "C:\custom\path"
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { ingestFolder } from "../src/ingest-worker.ts";

config();

const DEFAULT_PATH = process.env.PV_KNOWLEDGE_LAYER_DIR
  || "C:\\Users\\Derek DiCamillo\\Projects\\PV-Knowledge-Layer\\knowledge";

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

console.log(`Ingesting ${knowledgePath} as source="pv-knowledge-layer"...\n`);

const result = await ingestFolder({
  path: knowledgePath,
  source: "pv-knowledge-layer",
  supabase,
  recursive: true,
  onProgress: (p) => {
    if (p.current % 5 === 0 || p.current === p.total) {
      console.log(`  [${p.current}/${p.total}] ${p.currentFile} (skipped: ${p.skipped}, errors: ${p.errors})`);
    }
  },
});

console.log(`\nDone in ${Math.round(result.durationMs / 1000)}s.`);
console.log(`  files processed: ${result.filesProcessed}`);
console.log(`  files skipped:   ${result.filesSkipped}`);
console.log(`  files errored:   ${result.filesErrored}`);
console.log(`  total chunks:    ${result.totalChunks}`);
if (result.errors.length > 0) {
  console.log(`\nFirst errors:`);
  result.errors.forEach((e) => console.log(`  - ${e}`));
}
