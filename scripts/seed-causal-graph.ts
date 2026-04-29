#!/usr/bin/env bun
// Seed causal_nodes from business_scorecard columns + ledger action types,
// plus 5 manual seed edges from Derek's known causal beliefs.
// Idempotent: ensureNode upserts by name; manual edges deduped by (from, to, proposed_by='manual').

import { createClient } from "@supabase/supabase-js";
import { ensureNode, manuallyAddEdge } from "../src/causal-graph.ts";

const METRICS: Array<{ name: string; description: string; unit: string }> = [
  { name: "revenue_mtd",  description: "Month-to-date revenue (QB or AR)", unit: "$" },
  { name: "leads_count",  description: "Daily lead count (GHL)",            unit: "count" },
  { name: "cpl",          description: "Cost per lead (Meta Ads)",          unit: "$" },
  { name: "show_rate",    description: "Appointment show rate",             unit: "ratio" },
  { name: "close_rate",   description: "Lead → patient close rate",         unit: "ratio" },
  { name: "ad_spend",     description: "Daily Meta ad spend",               unit: "$" },
  { name: "ctr",          description: "Meta ad CTR",                       unit: "ratio" },
  { name: "frequency",    description: "Meta ad frequency",                 unit: "ratio" },
  { name: "lp_cvr",       description: "Landing page conversion rate",      unit: "ratio" },
  { name: "gross_profit", description: "Gross profit ($)",                  unit: "$" },
];

const ACTIONS: Array<{ name: string; description: string }> = [
  { name: "ad_pause",            description: "Paused or stopped a Meta ad/campaign" },
  { name: "ad_launch",           description: "Launched a new Meta ad/campaign" },
  { name: "price_change",        description: "Changed program/service pricing" },
  { name: "product_cut",         description: "Discontinued a service line" },
  { name: "product_launch",      description: "Launched a service line (e.g., peptides)" },
  { name: "telehealth_pause",    description: "Paused telehealth offering" },
  { name: "newsletter_send",     description: "Sent the weekly newsletter" },
  { name: "workflow_enroll",     description: "Enrolled a contact in a GHL workflow" },
  { name: "blog_publish",        description: "Published a blog post (PV or MAA)" },
  { name: "social_post",         description: "Posted to social via GHL Social Planner" },
];

const MANUAL_SEED_EDGES: Array<{
  from_name: string; to_name: string; effect_size: number; note: string;
}> = [
  { from_name: "ad_spend",    to_name: "leads_count", effect_size: 0.3,
    note: "Derek estimate: $1 spend ≈ 0.3 leads (varies by ad set)." },
  { from_name: "leads_count", to_name: "revenue_mtd", effect_size: 180,
    note: "Avg revenue per lead × close rate × LTV proxy." },
  { from_name: "ad_pause",    to_name: "leads_count", effect_size: -15,
    note: "Pausing ads typically drops weekly lead count by ~15." },
  { from_name: "product_cut", to_name: "gross_profit", effect_size: 4000,
    note: "Cutting a negative-GP product line (e.g., PDO) typically lifts monthly GP." },
  { from_name: "frequency",   to_name: "ctr",         effect_size: -0.005,
    note: "High frequency (>3) erodes CTR by ~0.5pp per integer step." },
];

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  );

  console.log("Seeding causal_nodes (metrics)…");
  for (const m of METRICS) {
    await ensureNode(supabase, { kind: "metric", name: m.name, description: m.description, unit: m.unit });
  }

  console.log("Seeding causal_nodes (actions)…");
  for (const a of ACTIONS) {
    await ensureNode(supabase, { kind: "action", name: a.name, description: a.description });
  }

  console.log("Seeding manual edges…");
  let inserted = 0;
  for (const e of MANUAL_SEED_EDGES) {
    // Look up the kinds correctly: from_name might be a metric or action; to_name typically metric.
    const fromKind = ACTIONS.some((a) => a.name === e.from_name) ? "action" : "metric";
    const fromNode = await ensureNode(supabase, { kind: fromKind, name: e.from_name });
    const toNode = await ensureNode(supabase, { kind: "metric", name: e.to_name });

    // Dedup: skip if a manual edge already exists.
    const { data: existing } = await supabase
      .from("causal_edges")
      .select("id")
      .eq("from_node", fromNode.id)
      .eq("to_node", toNode.id)
      .eq("proposed_by", "manual")
      .maybeSingle();
    if (existing) continue;

    await manuallyAddEdge(supabase, {
      from_node: fromNode.id,
      to_node: toNode.id,
      effect_size: e.effect_size,
      evidence: [{ kind: "manual", note: e.note, dated: new Date().toISOString() }],
      notes: e.note,
    });
    inserted++;
  }
  console.log(`Seed complete. Edges inserted: ${inserted}/${MANUAL_SEED_EDGES.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
