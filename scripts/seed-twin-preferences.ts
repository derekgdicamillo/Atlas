/**
 * One-off: seed twin_stated_preferences from USER.md / SOUL.md documented
 * preferences. The twin tables (migrations 039-042) were missing from
 * Supabase until 2026-07-01, so twin-predict-morning produced 0 predictions
 * from day one. Idempotent: skips seeding if any active rows already exist.
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

const { count } = await sb
  .from("twin_stated_preferences")
  .select("*", { count: "exact", head: true })
  .eq("active", true);

if ((count ?? 0) > 0) {
  console.log(`twin_stated_preferences already has ${count} active rows — nothing to do.`);
  process.exit(0);
}

const SRC = "seed-2026-07-01";
const derek = (preference: string, domain: string) =>
  ({ user_id: "derek", preference, domain, source: "USER.md", source_ref: SRC });
const esther = (preference: string, domain: string) =>
  ({ user_id: "esther", preference, domain, source: "USER.md", source_ref: SRC });

const rows = [
  derek("Casual, direct communication. Less formal, less wordy. No em dashes.", "communication"),
  derek("Deliver and stop: no trailing 'want me to tweak anything?' offers after a completed deliverable.", "communication"),
  derek("Always draft and ask for approval before sending emails/posts or making external changes.", "external-actions"),
  derek("Business metrics must come from the Supabase business_scorecard table at runtime, never from memory or estimates.", "metrics"),
  derek("Default coding tasks to Claude Code CLI; for shared code, brief explanation of what changed and why.", "coding"),
  derek("Use /humanizer as final polish on patient/provider-facing content to reduce AI smell.", "content"),
  derek("Budget is not a concern; use the best tool for the job, draft-first for external content.", "cost"),
  derek("Proactive help: morning brief with weight loss medicine + Bible verse + business dial-movers.", "daily-rhythm"),
  derek("Delegate tasks over 2-3 minutes to sub-agents; stay responsive in the main session.", "delegation"),
  derek("Send files via OneDrive/SharePoint links, never as direct email attachments.", "file-sharing"),
  derek("Strategic identity: medical weight loss clinic first; aesthetics only for high-margin lines.", "strategy"),
  esther("Warm, direct, practical communication style.", "communication"),
  esther("Full admin authority identical to Derek; never gate her requests behind Derek's approval.", "authority"),
  esther("For ANE member screening: 3-4 line clean approves, full breakdown only for borderline cases.", "ane-screening"),
];

const { error } = await sb.from("twin_stated_preferences").insert(rows);
if (error) { console.error("insert failed:", error.message); process.exit(1); }
console.log(`Seeded ${rows.length} stated preferences.`);
