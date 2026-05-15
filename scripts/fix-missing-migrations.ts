/**
 * One-off: applies migrations 023 (attribution_log) and 031
 * (memory_increment_access) which are missing from Atlas's Supabase.
 *
 * Also audits migrations 023-042 to report any other gaps.
 *
 * Same pattern as scripts/apply-sprint5-migrations.ts:
 * uses Supabase Management API + Personal Access Token.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const PAT = process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !PAT) {
  console.error("Missing SUPABASE_URL or SUPABASE_ACCESS_TOKEN in env");
  process.exit(2);
}

const refMatch = SUPABASE_URL.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
if (!refMatch) {
  console.error("Could not extract project ref from SUPABASE_URL");
  process.exit(2);
}
const PROJECT_REF = refMatch[1];
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

async function runSql(sql: string): Promise<unknown> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status}: ${body.slice(0, 400)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

// ============================================================
// AUDIT: which objects from migrations 023-042 are missing?
// ============================================================

const EXPECTED = [
  { migration: "023", kind: "table", name: "attribution_log" },
  { migration: "024", kind: "column", table: "memory", name: "needs_rewrite" },
  { migration: "025", kind: "column", table: "memory", name: "demotion_pressure" },
  { migration: "026", kind: "table", name: "procedures" },
  { migration: "027", kind: "table", name: "procedure_outcomes" },
  { migration: "028", kind: "column", table: "documents", name: "contextual_summary" },
  { migration: "029", kind: "function", name: "record_memory_failure" },
  { migration: "030", kind: "function", name: "memory_backfill_rewrite_status" },
  { migration: "031", kind: "function", name: "memory_increment_access" },
  { migration: "032", kind: "function", name: "procedures_search" },
  { migration: "033", kind: "function", name: "episodic_clusters_for_user" },
  { migration: "034", kind: "table", name: "causal_nodes" },
  { migration: "035", kind: "table", name: "causal_edges" },
  { migration: "036", kind: "table", name: "causal_observations" },
  { migration: "037", kind: "table", name: "world_model_forecasts" },
  { migration: "038", kind: "table", name: "dreams" },
  { migration: "039", kind: "table", name: "twin_stated_preferences" },
  { migration: "040", kind: "table", name: "twin_revealed_observations" },
  { migration: "041", kind: "table", name: "twin_divergence" },
  { migration: "042", kind: "table", name: "twin_predictions" },
];

async function exists(item: typeof EXPECTED[number]): Promise<boolean> {
  let sql = "";
  if (item.kind === "table") {
    sql = `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='${item.name}') AS e;`;
  } else if (item.kind === "function") {
    sql = `SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${item.name}') AS e;`;
  } else if (item.kind === "column") {
    sql = `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${item.table}' AND column_name='${item.name}') AS e;`;
  }
  const r = (await runSql(sql)) as Array<{ e: boolean }>;
  return r?.[0]?.e === true;
}

console.log(`\nAuditing migrations 023-042 against project ${PROJECT_REF}...\n`);
const missing: string[] = [];
const present: string[] = [];
for (const item of EXPECTED) {
  const ok = await exists(item);
  const label = `${item.migration} ${item.kind}:${"table" in item ? item.table + "." : ""}${item.name}`;
  if (ok) {
    present.push(label);
    console.log(`  ✓ ${label}`);
  } else {
    missing.push(label);
    console.log(`  ✗ MISSING: ${label}`);
  }
}

console.log(`\nPresent: ${present.length}, Missing: ${missing.length}\n`);

// ============================================================
// APPLY: 023 and 031 (the two we know are missing & needed now)
// ============================================================

const TARGETS = ["023_attribution_log.sql", "031_memory_increment_access_fn.sql"];
const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

console.log("Applying 023 + 031...");
for (const file of TARGETS) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
  try {
    await runSql(sql);
    console.log(`  ✓ ${file}`);
  } catch (err) {
    console.error(`  ✗ ${file} — ${err}`);
    process.exitCode = 1;
  }
}

console.log("\nDone.");
if (missing.length > 2) {
  console.log(`\nNOTE: ${missing.length - 2} other objects are missing. Re-run after reviewing the audit above to apply additional migrations.`);
}
