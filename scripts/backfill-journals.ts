/**
 * One-time script: backfill existing journal files into Supabase search.
 * Run: bun run scripts/backfill-journals.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

// Bun auto-loads .env from cwd

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const memDir = "memory";
const statePath = "data/journal-ingest-state.json";

let ingested: string[] = [];
try { ingested = JSON.parse(readFileSync(statePath, "utf-8")); } catch {}

const journals = readdirSync(memDir)
  .filter(f => /^2026-\d{2}-\d{2}\.md$/.test(f))
  .filter(f => !ingested.includes(f.replace(".md", "")))
  .sort();

const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });
const toIngest = journals.filter(f => f.replace(".md", "") !== today);
console.log(`Backfilling ${toIngest.length} journals...`);

for (const file of toIngest) {
  const dateStr = file.replace(".md", "");
  const content = readFileSync(join(memDir, file), "utf-8");
  if (!content || content.trim().length < 50) {
    console.log(`  Skip (too short): ${dateStr}`);
    continue;
  }
  const { data, error } = await supabase.functions.invoke("ingest", {
    body: {
      content,
      source: "journal",
      source_path: join(memDir, file),
      title: `Daily Journal - ${dateStr}`,
      metadata: { type: "journal", date: dateStr },
    },
  });
  if (error) {
    console.log(`  FAIL: ${dateStr} ${error.message || error}`);
  } else {
    ingested.push(dateStr);
    console.log(`  OK: ${dateStr} ${(data as any)?.chunks_created || 0} chunks`);
  }
  await new Promise(r => setTimeout(r, 500));
}
if (ingested.length > 90) ingested = ingested.slice(-90);
writeFileSync(statePath, JSON.stringify(ingested));
console.log(`Done. Total ingested: ${ingested.length}`);
