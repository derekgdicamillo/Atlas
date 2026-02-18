#!/usr/bin/env bun
/**
 * Business Intelligence Ingestion Script
 *
 * Reads business intelligence .md files, ingests them into Atlas knowledge base
 * via Supabase, and creates graph entities + edges for business leaders and frameworks.
 *
 * Usage:
 *   bun run setup/ingest-business-intelligence.ts
 *   bun run setup/ingest-business-intelligence.ts --dry-run
 *   bun run setup/ingest-business-intelligence.ts --force
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
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const BI_DIR = join("C:/Users/derek/Projects/atlas/data/training/business-intelligence");
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
// ENTITY + EDGE DEFINITIONS
// ============================================================
interface PersonDef {
  name: string;
  description: string;
}
interface ConceptDef {
  name: string;
}
interface EdgeDef {
  source: string;
  target: string;
  relationship: string;
}
const PEOPLE: PersonDef[] = [
  { name: "Warren Buffett", description: "Investor and CEO of Berkshire Hathaway, master of value investing and capital allocation" },
  { name: "Charlie Munger", description: "Vice Chairman of Berkshire Hathaway, multidisciplinary thinker and mental models pioneer" },
  { name: "Jeff Bezos", description: "Founder of Amazon, pioneer of customer obsession and flywheel strategy" },
  { name: "Sam Walton", description: "Founder of Walmart, built the world's largest retailer from a single small-town store" },
  { name: "Alex Hormozi", description: "Entrepreneur and author of $100M Offers, expert in offer creation and lead generation" },
  { name: "Tim Cook", description: "CEO of Apple, master of supply chain optimization and operational excellence" },
  { name: "Ray Dalio", description: "Founder of Bridgewater Associates, creator of Principles framework and idea meritocracy" },
  { name: "Peter Thiel", description: "Co-founder of PayPal, author of Zero to One, contrarian startup thinker" },
  { name: "Sara Blakely", description: "Founder of Spanx, bootstrapped $5K into a billion-dollar brand" },
  { name: "Keith Cunningham", description: "Author of The Road Less Stupid, business financial intelligence educator" },
];
const CONCEPTS: ConceptDef[] = [
  // Buffett
  { name: "Economic Moat" }, { name: "Circle of Competence" }, { name: "Margin of Safety" },
  { name: "Owner Earnings" }, { name: "Pricing Power" },
  // Munger
  { name: "Mental Models" }, { name: "Inversion Principle" }, { name: "Lollapalooza Effects" },
  { name: "Multidisciplinary Thinking" },
  // Bezos
  { name: "Day 1 Philosophy" }, { name: "Flywheel Effect" }, { name: "Working Backwards" },
  { name: "Two-Way Door Decisions" }, { name: "Leadership Principles" },
  // Walton
  { name: "EDLP (Everyday Low Prices)" }, { name: "Saturday Morning Meeting" },
  { name: "Cross-Docking" }, { name: "Small Town Strategy" },
  // Hormozi
  { name: "Grand Slam Offer" }, { name: "Value Equation" }, { name: "Core Four Lead Generation" },
  { name: "CLOSER Framework" }, { name: "Ascension Model" },
  // Cook
  { name: "Just-in-Time Inventory" }, { name: "Ecosystem Lock-in" },
  { name: "Services Revenue" }, { name: "Single-Threaded Leadership" },
  // Dalio
  { name: "Idea Meritocracy" }, { name: "Radical Transparency" }, { name: "Five-Step Process" },
  { name: "Believability Weighting" }, { name: "Pain Plus Reflection" },
  // Thiel
  { name: "Zero to One" }, { name: "Monopoly Theory" }, { name: "Power Law" },
  { name: "Secrets Framework" }, { name: "Last Mover Advantage" },
  // Blakely
  { name: "Bootstrapping" }, { name: "Show Don't Tell" }, { name: "Failure Reframing" },
  { name: "Scrappy Execution" },
  // Cunningham
  { name: "Thinking Time" }, { name: "Dumb Tax" }, { name: "Financial Drivers" },
  { name: "Dashboard Concept" }, { name: "Unit Economics" },
];
const PERSON_CONCEPT_EDGES: Record<string, string[]> = {
  "Warren Buffett": ["Economic Moat", "Circle of Competence", "Margin of Safety", "Owner Earnings", "Pricing Power"],
  "Charlie Munger": ["Mental Models", "Inversion Principle", "Lollapalooza Effects", "Multidisciplinary Thinking"],
  "Jeff Bezos": ["Day 1 Philosophy", "Flywheel Effect", "Working Backwards", "Two-Way Door Decisions", "Leadership Principles"],
  "Sam Walton": ["EDLP (Everyday Low Prices)", "Saturday Morning Meeting", "Cross-Docking", "Small Town Strategy"],
  "Alex Hormozi": ["Grand Slam Offer", "Value Equation", "Core Four Lead Generation", "CLOSER Framework", "Ascension Model"],
  "Tim Cook": ["Just-in-Time Inventory", "Ecosystem Lock-in", "Services Revenue", "Single-Threaded Leadership"],
  "Ray Dalio": ["Idea Meritocracy", "Radical Transparency", "Five-Step Process", "Believability Weighting", "Pain Plus Reflection"],
  "Peter Thiel": ["Zero to One", "Monopoly Theory", "Power Law", "Secrets Framework", "Last Mover Advantage"],
  "Sara Blakely": ["Bootstrapping", "Show Don't Tell", "Failure Reframing", "Scrappy Execution"],
  "Keith Cunningham": ["Thinking Time", "Dumb Tax", "Financial Drivers", "Dashboard Concept", "Unit Economics"],
};
const CROSS_EDGES: EdgeDef[] = [
  { source: "Charlie Munger", target: "Warren Buffett", relationship: "partner_of" },
  { source: "Warren Buffett", target: "Charlie Munger", relationship: "influenced_by" },
  { source: "Jeff Bezos", target: "Sam Walton", relationship: "influenced_by" },
  { source: "Tim Cook", target: "Jeff Bezos", relationship: "succeeded" },
  { source: "Alex Hormozi", target: "Keith Cunningham", relationship: "influenced_by" },
  { source: "Sara Blakely", target: "Warren Buffett", relationship: "inspired_by" },
];// ============================================================
// HELPER: RESOLVE OR CREATE ENTITY
// ============================================================
async function resolveEntityId(name: string, entityType: string, description?: string): Promise<string | null> {
  // Check if exists (case-insensitive)
  const { data: existing } = await supabase
    .from("memory_entities")
    .select("id")
    .ilike("name", name.trim())
    .limit(1);
  if (existing?.length) {
    // Update description if provided and different
    if (description) {
      await supabase
        .from("memory_entities")
        .update({ description, entity_type: entityType, updated_at: new Date().toISOString() })
        .eq("id", existing[0].id);
    }
    return existing[0].id;
  }
  // Create new
  const { data, error } = await supabase
    .from("memory_entities")
    .insert({
      name: name.trim(),
      entity_type: entityType,
      description: description || null,
    })
    .select("id")
    .single();
  if (error) {
    console.error(`  Failed to create entity "${name}": ${error.message}`);
    return null;
  }
  return data.id;
}
// ============================================================
// HELPER: UPSERT EDGE
// ============================================================
async function upsertEdge(sourceId: string, targetId: string, relationship: string): Promise<boolean> {
  const { error } = await supabase
    .from("memory_edges")
    .upsert(
      {
        source_entity_id: sourceId,
        target_entity_id: targetId,
        relationship,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "source_entity_id,target_entity_id,relationship" }
    );
  if (error) {
    console.error(`  Failed to upsert edge: ${error.message}`);
    return false;
  }
  return true;
}
// ============================================================
// STEP 1: INGEST DOCUMENTS
// ============================================================
async function ingestDocuments() {
  console.log("\n=== STEP 1: Ingesting documents ===");
  if (dryRun) console.log("(dry run)");
  const files = await readdir(BI_DIR);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  console.log(`Found ${mdFiles.length} .md files in ${BI_DIR}`);
  // Get existing hashes for dedup
  const existingHashes = new Set<string>();
  if (!force) {
    const { data } = await supabase
      .from("documents")
      .select("content_hash")
      .eq("source", "business-intelligence")
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
  for (const file of mdFiles) {
    const filePath = join(BI_DIR, file);
    const content = await readFile(filePath, "utf-8");
    if (!content.trim()) {
      skipped++;
      continue;
    }
    const hash = await sha256(content);
    if (!force && existingHashes.has(hash)) {
      console.log(`  Skip (unchanged): ${file}`);
      skipped++;
      continue;
    }
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1] : file.replace(/\.md$/, "").replace(/-/g, " ");
    if (dryRun) {
      console.log(`  Would ingest: ${file} (${content.length} chars)`);
      ingested++;
      continue;
    }
    try {
      const { data, error } = await supabase.functions.invoke("ingest", {
        body: {
          content,
          source: "business-intelligence",
          source_path: file,
          title,
          metadata: { type: "business-intelligence" },
        },
      });
      if (error) {
        console.error(`  ERROR ${file}: ${error.message}`);
        errors++;
      } else {
        const chunks = data?.chunks_created || 0;
        console.log(`  Ingested: ${file} (${chunks} chunks)`);
        ingested++;
      }
    } catch (err) {
      console.error(`  ERROR ${file}: ${err}`);
      errors++;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`Documents: Ingested=${ingested}, Skipped=${skipped}, Errors=${errors}`);
}// ============================================================
// STEP 2: CREATE GRAPH ENTITIES
// ============================================================
async function createGraphEntities() {
  console.log("\n=== STEP 2: Creating graph entities ===");
  if (dryRun) console.log("(dry run)");
  let created = 0;
  let updated = 0;
  let errors = 0;
  // Create person entities
  for (const person of PEOPLE) {
    if (dryRun) {
      console.log(`  Would create/update person: ${person.name}`);
      created++;
      continue;
    }
    const id = await resolveEntityId(person.name, "person", person.description);
    if (id) {
      console.log(`  Person: ${person.name} -> ${id}`);
      created++;
    } else {
      errors++;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Create concept entities
  for (const concept of CONCEPTS) {
    if (dryRun) {
      console.log(`  Would create/update concept: ${concept.name}`);
      created++;
      continue;
    }
    const id = await resolveEntityId(concept.name, "concept");
    if (id) {
      console.log(`  Concept: ${concept.name} -> ${id}`);
      created++;
    } else {
      errors++;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`Entities: Created/Updated=${created}, Errors=${errors}`);
}
// ============================================================
// STEP 3: CREATE GRAPH EDGES
// ============================================================
async function createGraphEdges() {
  console.log("\n=== STEP 3: Creating graph edges ===");
  if (dryRun) console.log("(dry run)");
  let created = 0;
  let errors = 0;
  // Person -> created -> Concept edges
  for (const [personName, concepts] of Object.entries(PERSON_CONCEPT_EDGES)) {
    for (const conceptName of concepts) {
      if (dryRun) {
        console.log(`  Would create edge: ${personName} -> created -> ${conceptName}`);
        created++;
        continue;
      }
      const sourceId = await resolveEntityId(personName, "person");
      const targetId = await resolveEntityId(conceptName, "concept");
      if (sourceId && targetId) {
        const ok = await upsertEdge(sourceId, targetId, "created");
        if (ok) {
          console.log(`  Edge: ${personName} -> created -> ${conceptName}`);
          created++;
        } else {
          errors++;
        }
      } else {
        console.error(`  Could not resolve: ${personName} or ${conceptName}`);
        errors++;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // Cross-person edges
  for (const edge of CROSS_EDGES) {
    if (dryRun) {
      console.log(`  Would create edge: ${edge.source} -> ${edge.relationship} -> ${edge.target}`);
      created++;
      continue;
    }
    const sourceId = await resolveEntityId(edge.source, "person");
    const targetId = await resolveEntityId(edge.target, "person");
    if (sourceId && targetId) {
      const ok = await upsertEdge(sourceId, targetId, edge.relationship);
      if (ok) {
        console.log(`  Edge: ${edge.source} -> ${edge.relationship} -> ${edge.target}`);
        created++;
      } else {
        errors++;
      }
    } else {
      console.error(`  Could not resolve: ${edge.source} or ${edge.target}`);
      errors++;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`Edges: Created/Updated=${created}, Errors=${errors}`);
}
// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log("Business Intelligence Ingestion");
  console.log("================================");
  if (dryRun) console.log("DRY RUN MODE - no changes will be made\n");
  if (force) console.log("FORCE MODE - re-ingesting all files\n");
  await ingestDocuments();
  await createGraphEntities();
  await createGraphEdges();
  console.log("\n================================");
  console.log("Done!");
}
main().catch(console.error);