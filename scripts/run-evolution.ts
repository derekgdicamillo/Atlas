/**
 * Manual trigger for the evolution pipeline.
 * Usage: bun run scripts/run-evolution.ts
 */
import { createClient } from "@supabase/supabase-js";
import { runEvolutionPipeline } from "../src/evolution/pipeline.ts";

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

if (!supabase) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

console.log("[runner] Starting evolution pipeline...");
console.log("[runner] Time:", new Date().toLocaleString("en-US", { timeZone: "America/Denver" }));

try {
  const result = await runEvolutionPipeline(supabase, { manual: true });
  console.log("\n[runner] Pipeline complete!");
  console.log("[runner] Message:", result.message);
  console.log("[runner] Phases:", result.phases.length);
  for (const phase of result.phases) {
    const status = phase.status === "success" ? "✓" : phase.status === "skipped" ? "○" : "✗";
    const cost = phase.costUsd > 0 ? ` ($${phase.costUsd.toFixed(2)})` : "";
    const dur = phase.durationMs ? ` ${(phase.durationMs / 1000).toFixed(1)}s` : "";
    console.log(`  ${status} ${phase.phase}${dur}${cost}: ${phase.message || ""}`);
  }
  console.log(`[runner] Total cost: $${result.totalCostUsd.toFixed(2)}`);
} catch (err) {
  console.error("[runner] Pipeline failed:", err);
  process.exit(1);
}
