#!/usr/bin/env bun
// Idempotent seeder: reads data/procedures-seed.yaml and upserts into procedures table.
// Embeds each goal via OpenAI text-embedding-3-small (or skips if SKIP_EMBED=1 for dry-run).

import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { createClient } from "@supabase/supabase-js";

interface SeedProcedure {
  id: string;
  goal: string;
  preconditions: string[];
  action_sequence: any[];
  postconditions: string[];
  tags: string[];
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
  });
  if (!res.ok) throw new Error(`OpenAI embedding ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as any;
  return j.data[0].embedding;
}

async function main() {
  const path = process.argv[2] ?? "data/procedures-seed.yaml";
  const raw = readFileSync(path, "utf8");
  const procedures = yaml.load(raw) as SeedProcedure[];

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  );

  const skipEmbed = process.env.SKIP_EMBED === "1";

  let upserted = 0;
  for (const p of procedures) {
    let goal_embedding: number[] | null = null;
    if (!skipEmbed) {
      try {
        goal_embedding = await embed(p.goal);
      } catch (err) {
        console.error(`embed failed for ${p.id}:`, err);
      }
    }
    const row: any = {
      external_id: p.id,
      goal: p.goal,
      goal_embedding,
      preconditions: p.preconditions ?? [],
      action_sequence: p.action_sequence ?? [],
      postconditions: p.postconditions ?? [],
      tags: p.tags ?? [],
      source: "hand-curated",
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("procedures")
      .upsert(row, { onConflict: "external_id" });
    if (error) {
      console.error(`upsert ${p.id} failed:`, error);
      continue;
    }
    upserted++;
  }
  console.log(`Seeded ${upserted}/${procedures.length} procedures.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
