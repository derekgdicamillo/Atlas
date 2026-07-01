const MAA_SITE_URL = "https://medicalaestheticsassociation.com";
const WP_USER = process.env.MAA_WP_USER!;
const WP_PASS = process.env.MAA_WP_APP_PASSWORD!;
const DASH_TOKEN = process.env.MAA_DASHBOARD_TOKEN!;

import { getChromeUA } from "./src/chrome-ua.ts";
const ua = await getChromeUA();

const postsRes = await fetch(`${MAA_SITE_URL}/wp-json/wp/v2/posts?per_page=10&orderby=date&order=desc&_fields=id,title,excerpt,link,date,categories`, {
  headers: { Authorization: `Basic ${Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64")}`, "User-Agent": ua },
  signal: AbortSignal.timeout(15000)
});
const posts = await postsRes.json() as any[];
console.log("=== RECENT BLOG POSTS ===");
for (const p of posts) {
  const title = p.title.rendered.replace(/<[^>]*>/g, '');
  console.log(`[${p.id}] ${title} (${p.date.split('T')[0]}) cats:${p.categories}`);
}

if (DASH_TOKEN) {
  const sageRes = await fetch(`${MAA_SITE_URL}/wp-json/maa/v1/dashboard/sage?period=30d`, {
    headers: { Authorization: `Bearer ${DASH_TOKEN}`, "User-Agent": ua },
    signal: AbortSignal.timeout(15000)
  });
  if (sageRes.ok) {
    const sage = await sageRes.json() as any;
    console.log("\n=== SAGE TOP TOPICS ===");
    for (const t of (sage.top_topics || []).slice(0, 8)) {
      console.log(`- ${t.topic} (${t.count})`);
    }
    console.log("\n=== SAGE TOP QUESTIONS ===");
    for (const q of (sage.top_questions || []).slice(0, 8)) {
      console.log(`- "${q.question}" (${q.count})`);
    }
  } else {
    console.log("\nSAGE API:", sageRes.status);
  }
}
