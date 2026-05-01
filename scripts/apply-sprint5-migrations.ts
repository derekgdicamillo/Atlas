/**
 * Sprint 5 one-off migration applier.
 *
 * Reads db/migrations/043_*.sql through 053_*.sql and applies each via
 * Supabase Management API (https://api.supabase.com/v1/projects/{ref}/database/query).
 * Auth: SUPABASE_ACCESS_TOKEN (Personal Access Token) from Atlas's .env.
 *
 * Project ref derived from SUPABASE_URL hostname.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const PAT = process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !PAT) {
  console.error("Missing SUPABASE_URL or SUPABASE_ACCESS_TOKEN in env");
  process.exit(2);
}

const refMatch = SUPABASE_URL.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
if (!refMatch) {
  console.error(`Could not extract project ref from SUPABASE_URL: ${SUPABASE_URL}`);
  process.exit(2);
}
const PROJECT_REF = refMatch[1];

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");
const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^(04[3-9]|05[0-3])_.*\.sql$/.test(f))
  .sort();

if (FILES.length !== 11) {
  console.error(`Expected 11 Sprint 5 migrations (043-053), found ${FILES.length}: ${FILES.join(", ")}`);
  process.exit(2);
}

console.log(`Applying ${FILES.length} migrations to project ${PROJECT_REF}`);

const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

async function applyOne(file: string): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`${file} → ${res.status}: ${body.slice(0, 400)}`);
  }
  console.log(`  ✓ ${file}`);
}

for (const f of FILES) {
  await applyOne(f);
}
console.log(`\nDone. ${FILES.length} migrations applied.`);
