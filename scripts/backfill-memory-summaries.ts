#!/usr/bin/env bun
// One-shot backfill: copies memory.content into original_content + summary
// for every row missing original_content. Idempotent. Uses RPC for atomicity.

import { createClient } from "@supabase/supabase-js";

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  );

  const { data, error } = await supabase.rpc("memory_backfill_summaries");
  if (error) {
    console.error("backfill failed:", error);
    process.exit(1);
  }
  console.log(`backfill rows updated: ${data}`);
}

main();
