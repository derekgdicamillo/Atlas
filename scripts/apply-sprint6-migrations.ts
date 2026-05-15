/**
 * Apply Sprint 6 migrations 054-059 to Atlas's Supabase.
 * Same pattern as scripts/fix-missing-migrations.ts and apply-sprint5-migrations.ts:
 * uses Supabase Management API + Personal Access Token (SUPABASE_ACCESS_TOKEN).
 *
 * Idempotent — all migrations use IF NOT EXISTS / CREATE OR REPLACE.
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

const MIGRATIONS = [
  "054_dgm_variants.sql",
  "055_skill_shadow_scores.sql",
  "056_dpo_pairs.sql",
  "057_dpo_pair_embeddings.sql",
  "058_introspect_cache.sql",
  "059_dpo_pairs_match_rpc.sql",
];

async function main() {
  console.log(`Project: ${PROJECT_REF}`);
  console.log(`Applying ${MIGRATIONS.length} Sprint 6 migrations...\n`);
  let applied = 0;
  let failed = 0;
  for (const fname of MIGRATIONS) {
    const path = join("db", "migrations", fname);
    let sql: string;
    try {
      sql = readFileSync(path, "utf8");
    } catch (err) {
      console.error(`  ❌ ${fname} — could not read: ${err}`);
      failed++;
      continue;
    }
    process.stdout.write(`  ${fname} ... `);
    try {
      await runSql(sql);
      console.log("✓");
      applied++;
    } catch (err) {
      console.log(`✗ ${err}`);
      failed++;
    }
  }
  console.log(`\nApplied: ${applied}/${MIGRATIONS.length}, Failed: ${failed}`);

  // Audit: do the expected tables + index + RPC exist?
  console.log("\n=== Sprint 6 schema audit ===");
  const checks = [
    { kind: "table", name: "dgm_variants" },
    { kind: "table", name: "skill_shadow_scores" },
    { kind: "table", name: "dpo_pairs" },
    { kind: "table", name: "introspect_cache" },
    { kind: "index", name: "idx_dpo_pairs_embedding" },
    { kind: "rpc",   name: "dpo_pairs_match" },
  ];
  for (const c of checks) {
    let query = "";
    if (c.kind === "table") {
      query = `SELECT to_regclass('public.${c.name}') as r;`;
    } else if (c.kind === "index") {
      query = `SELECT indexname FROM pg_indexes WHERE indexname = '${c.name}';`;
    } else {
      query = `SELECT proname FROM pg_proc WHERE proname = '${c.name}';`;
    }
    try {
      const result = (await runSql(query)) as any[];
      const hit = Array.isArray(result) && result.length > 0 &&
        Object.values(result[0]).some((v) => v !== null);
      console.log(`  ${hit ? "✓" : "✗"} ${c.kind} ${c.name}`);
    } catch (err) {
      console.log(`  ? ${c.kind} ${c.name} — query failed: ${err}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
