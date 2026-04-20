#!/usr/bin/env bun
// Pulls recent conversation turns from Supabase `messages` and emits unlabeled JSONL.
// Usage: bun run scripts/build-replay-dataset.ts --limit=200 > data/replay-dataset.jsonl

import { createClient } from "@supabase/supabase-js";

const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 200);

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

async function main() {
  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, created_at, metadata")
    .eq("channel", "telegram")
    .order("created_at", { ascending: false })
    .limit(LIMIT * 4);
  if (error) throw error;
  if (!data) return;

  const rows = [...data].reverse();
  let count = 0;
  for (let i = 0; i < rows.length - 1 && count < LIMIT; i++) {
    if (rows[i].role !== "user") continue;
    if (rows[i + 1].role !== "assistant") continue;
    const entry = {
      id: `${rows[i].created_at.slice(0, 10)}-${String(count + 1).padStart(4, "0")}`,
      capturedAt: rows[i].created_at,
      agent: (rows[i].metadata?.agent ?? "atlas") as "atlas" | "ishtar",
      userTurn: String(rows[i].content).slice(0, 4000),
      contextSummary: "",
      atlasResponse: String(rows[i + 1].content).slice(0, 4000),
      derekCorrection: null,
      label: "good",
      tags: [],
    };
    process.stdout.write(JSON.stringify(entry) + "\n");
    count++;
    i++;
  }
  process.stderr.write(`emitted ${count} candidate entries\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
