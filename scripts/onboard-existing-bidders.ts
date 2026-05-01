/**
 * One-time: register existing skills + named subagents as marketplace bidders.
 * Reads data/marketplace-current-routing.json and creates a bidder per unique winner.
 * Idempotent — registerBidder uses upsert; running twice does not duplicate bidders.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { registerBidder } from "../src/marketplace";
import { createClient } from "@supabase/supabase-js";

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) must be set"
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);
  const routing = JSON.parse(
    readFileSync(join("data", "marketplace-current-routing.json"), "utf-8")
  ) as Record<string, string>;

  const seen = new Set<string>();
  for (const [taskType, winner] of Object.entries(routing)) {
    if (seen.has(winner)) continue;
    seen.add(winner);

    const domain = taskType.includes("newsletter")
      ? "newsletter"
      : taskType.includes("ad-")
      ? "ad-creative"
      : taskType.includes("careplan")
      ? "careplan"
      : taskType.includes("brief")
      ? "default"
      : "default";

    await registerBidder(supabase, {
      id: winner,
      type: winner.includes("agent") ? "subagent" : "skill",
      domains: [domain],
      vowCard: {
        cost_estimate_usd: 0.20,
        expected_latency_ms: 5000,
        confidence_baseline: 0.65,
      },
    });
    console.log("[onboard] " + winner + " registered (domain=" + domain + ")");
  }

  console.log("[onboard] done — " + seen.size + " unique bidders registered.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
