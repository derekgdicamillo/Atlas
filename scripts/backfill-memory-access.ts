/**
 * One-off: seed access_count_since_rewrite on recent memories so Dream Engine
 * salience has signal on the next SWS run instead of waiting weeks for
 * organic accesses. From data/task-output/dream-engine-sws-investigation.md
 * step 4. Reversible; only touches rows with count = 0.
 */
const SUPABASE_URL = process.env.SUPABASE_URL;
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
if (!SUPABASE_URL || !PAT) { console.error("Missing SUPABASE_URL or SUPABASE_ACCESS_TOKEN"); process.exit(2); }
const ref = SUPABASE_URL.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1];
const ENDPOINT = `https://api.supabase.com/v1/projects/${ref}/database/query`;

async function runSql(sql: string): Promise<unknown> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${body.slice(0, 400)}`);
  try { return JSON.parse(body); } catch { return body; }
}

const before = await runSql(`SELECT COUNT(*) AS n FROM memory WHERE access_count_since_rewrite > 0;`);
console.log("rows with access>0 before:", JSON.stringify(before));

const result = await runSql(`
  UPDATE memory
     SET access_count_since_rewrite = 3,
         updated_at = NOW()
   WHERE class IN ('episodic', 'semantic')
     AND created_at >= NOW() - INTERVAL '90 days'
     AND access_count_since_rewrite = 0;
`);
console.log("backfill result:", JSON.stringify(result));

const after = await runSql(`SELECT COUNT(*) AS n FROM memory WHERE access_count_since_rewrite > 0;`);
console.log("rows with access>0 after:", JSON.stringify(after));

const attrib = await runSql(`SELECT DATE(created_at) AS day, COUNT(*) AS rows FROM attribution_log GROUP BY 1 ORDER BY 1 DESC LIMIT 10;`);
console.log("attribution_log by day:", JSON.stringify(attrib));
