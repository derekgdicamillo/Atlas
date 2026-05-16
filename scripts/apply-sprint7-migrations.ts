/**
 * Apply Sprint 7 migrations 060-064 to Atlas's Supabase.
 * Same pattern as scripts/apply-sprint6-migrations.ts: uses Supabase
 * Management API + Personal Access Token (SUPABASE_ACCESS_TOKEN).
 *
 * Idempotent — all migrations use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
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
  "060_shadow_divergence_log.sql",
  "061_tool_entropy_probes.sql",
  "062_session_keys.sql",
  "063_memory_signature.sql",
  "064_knowledge_audit_log.sql",
];

async function main() {
  console.log(`Project: ${PROJECT_REF}`);
  console.log(`Applying ${MIGRATIONS.length} Sprint 7 migrations...\n`);
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

  console.log("\n=== Sprint 7 schema audit ===");
  const checks: { kind: "table" | "column" | "index"; name: string; on?: string }[] = [
    { kind: "table",  name: "shadow_divergence_log" },
    { kind: "table",  name: "tool_entropy_probes" },
    { kind: "table",  name: "session_keys" },
    { kind: "table",  name: "memory_verification_failures" },
    { kind: "table",  name: "knowledge_audit_log" },
    { kind: "column", name: "session_id",       on: "memory" },
    { kind: "column", name: "signature",        on: "memory" },
    { kind: "column", name: "sig_payload_hash", on: "memory" },
    { kind: "index",  name: "idx_memory_session" },
    { kind: "index",  name: "idx_shadow_divergence_ts" },
    { kind: "index",  name: "idx_entropy_ts" },
    { kind: "index",  name: "idx_session_keys_agent" },
    { kind: "index",  name: "idx_audit_domain" },
    { kind: "index",  name: "idx_mvf_ts" },
  ];
  for (const c of checks) {
    let query = "";
    if (c.kind === "table") {
      query = `SELECT to_regclass('public.${c.name}') as r;`;
    } else if (c.kind === "column") {
      query = `SELECT column_name FROM information_schema.columns WHERE table_name = '${c.on}' AND column_name = '${c.name}';`;
    } else {
      query = `SELECT indexname FROM pg_indexes WHERE indexname = '${c.name}';`;
    }
    try {
      const result = (await runSql(query)) as any[];
      const hit = Array.isArray(result) && result.length > 0 &&
        Object.values(result[0]).some((v) => v !== null);
      const label = c.kind === "column" ? `column ${c.on}.${c.name}` : `${c.kind} ${c.name}`;
      console.log(`  ${hit ? "✓" : "✗"} ${label}`);
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
