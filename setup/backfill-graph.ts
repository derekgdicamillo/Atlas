#!/usr/bin/env bun
/**
 * Graph Memory Backfill
 *
 * Reads existing facts from the memory table and uses Claude (haiku)
 * to extract entities and relationships, populating memory_entities
 * and memory_edges tables.
 *
 * Usage:
 *   bun run setup/backfill-graph.ts
 *   bun run setup/backfill-graph.ts --dry-run
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { processGraphIntents } from "../src/graph.ts";

config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const dryRun = process.argv.includes("--dry-run");
const BATCH_SIZE = 20;

async function main() {
  console.log(`Graph Memory Backfill${dryRun ? " (DRY RUN)" : ""}`);
  console.log("=".repeat(50));

  // 1. Fetch all facts from memory table
  const { data: facts, error } = await supabase
    .from("memory")
    .select("id, content")
    .eq("type", "fact");

  if (error) {
    console.error("Failed to fetch facts:", error.message);
    process.exit(1);
  }

  if (!facts?.length) {
    console.log("No facts to process.");
    return;
  }

  console.log(`Found ${facts.length} facts to analyze.\n`);

  let totalEntities = 0;
  let totalEdges = 0;

  for (let i = 0; i < facts.length; i += BATCH_SIZE) {
    const batch = facts.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const factList = batch.map((f, idx) => `${idx + 1}. ${f.content}`).join("\n");

    const prompt = `Extract entities and relationships from these facts. Output ONLY the tags, one per line. No other text.

Facts:
${factList}

Use these formats:
[ENTITY: name | TYPE: person/org/program/tool/concept/location | DESC: short description]
[RELATE: source -> relationship -> target]

Rules:
- Only extract what's explicitly stated, don't infer
- Use consistent entity names (e.g., always "PV MediSpa" not "the clinic")
- Relationships should be simple verbs: owns, manages, offers, uses, located_in, works_at, enrolled_in, includes
- Skip vague facts that don't contain clear entities
- TYPE must be one of: person, org, program, tool, concept, location`;

    if (dryRun) {
      console.log(`[DRY RUN] Batch ${batchNum}: ${batch.length} facts`);
      console.log(`  First fact: ${batch[0].content.substring(0, 80)}...`);
      continue;
    }

    try {
      console.log(`Batch ${batchNum}: processing ${batch.length} facts...`);

      const proc = Bun.spawn(
        ["claude", "--model", "haiku", "--print", "-p", prompt],
        { stdout: "pipe", stderr: "pipe" }
      );

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        console.error(`  Batch ${batchNum} failed (exit ${exitCode}): ${stderr.substring(0, 200)}`);
        continue;
      }

      // Count what we got
      const entityMatches = output.match(/\[ENTITY:/gi) || [];
      const relateMatches = output.match(/\[RELATE:/gi) || [];

      // Process through the same intent parser Atlas uses
      await processGraphIntents(supabase, output);

      totalEntities += entityMatches.length;
      totalEdges += relateMatches.length;

      console.log(`  -> ${entityMatches.length} entities, ${relateMatches.length} edges`);
    } catch (err) {
      console.error(`  Batch ${batchNum} error:`, err);
    }

    // Rate limit between batches
    if (i + BATCH_SIZE < facts.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Backfill complete: ${totalEntities} entities, ${totalEdges} edges created.`);

  // Show final counts from DB
  if (!dryRun) {
    const { count: entityCount } = await supabase
      .from("memory_entities")
      .select("id", { count: "exact", head: true });
    const { count: edgeCount } = await supabase
      .from("memory_edges")
      .select("id", { count: "exact", head: true });
    console.log(`Database totals: ${entityCount} entities, ${edgeCount} edges`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
