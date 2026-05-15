#!/usr/bin/env bun
// Exports dpo_pairs to OpenAI/Anthropic fine-tuning JSONL format.
// Usage: bun run scripts/export-dpo-jsonl.ts > data/dpo-export-$(date +%F).jsonl

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!
);

async function main() {
  const { data, error } = await supabase
    .from("dpo_pairs")
    .select("user_turn, atlas_original, derek_corrected, domain, reason, captured_at")
    .order("captured_at", { ascending: true })
    .limit(5000);

  if (error) {
    console.error("export failed:", error);
    process.exit(1);
  }

  for (const p of (data ?? []) as any[]) {
    process.stdout.write(
      JSON.stringify({
        messages: [
          { role: "user", content: p.user_turn as string },
          { role: "assistant", content: p.derek_corrected as string },
        ],
        rejected: p.atlas_original as string,
        metadata: {
          domain: p.domain as string | null,
          reason: p.reason as string | null,
          captured_at: p.captured_at as string,
        },
      }) + "\n"
    );
  }
}

main();
