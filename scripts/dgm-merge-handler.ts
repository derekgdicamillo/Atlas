#!/usr/bin/env bun
// Handles ✓ merge / ✗ archive button actions from the morning DGM review.
// Usage: bun run scripts/dgm-merge-handler.ts <merge|archive> <variant_id> [approver]

import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY)!
);

async function mergeVariant(variantId: string, approver: "derek" | "esther"): Promise<{ ok: boolean; sha?: string; error?: string }> {
  const { data: row } = await supabase
    .from("dgm_variants")
    .select("*")
    .eq("id", variantId)
    .single();
  if (!row) return { ok: false, error: "variant not found" };
  const v = row as any;
  if (v.status !== "queued") return { ok: false, error: `variant status is ${v.status}, expected 'queued'` };
  const worktreePath = `data/dgm-worktrees/${v.id}`;
  // Fast-forward variant branch over current master.
  const ff = spawnSync("git", ["-C", worktreePath, "rebase", "master"], { encoding: "utf8" });
  if (ff.status !== 0) return { ok: false, error: `rebase failed: ${ff.stderr}` };
  // Apply variant changes onto main repo (single squashed commit).
  const apply = spawnSync("git", ["merge", "--squash", "--no-commit", `dgm-worktrees/${v.id}`], { encoding: "utf8" });
  if (apply.status !== 0) return { ok: false, error: `squash failed: ${apply.stderr}` };
  const msg = `dgm: ${v.diff_summary}\n\nApproved-by: ${approver}\nReplay-delta: ${(v.delta_aggregate ?? 0).toFixed(3)}\nVariant-id: ${v.id}\n`;
  const commit = spawnSync("git", ["commit", "-m", msg], { encoding: "utf8" });
  if (commit.status !== 0) return { ok: false, error: `commit failed: ${commit.stderr}` };
  const shaResult = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const sha = shaResult.stdout.trim();
  await supabase.from("dgm_variants").update({
    status: "merged",
    approved_by: approver,
    approved_at: new Date().toISOString(),
    merge_commit_sha: sha,
  }).eq("id", variantId);
  return { ok: true, sha };
}

async function archiveVariant(variantId: string): Promise<void> {
  await supabase.from("dgm_variants").update({ status: "archived" }).eq("id", variantId);
}

const action = process.argv[2];
const variantId = process.argv[3];
const approver = (process.argv[4] ?? "derek") as "derek" | "esther";

if (action === "merge") {
  mergeVariant(variantId, approver).then((r) => console.log(JSON.stringify(r)));
} else if (action === "archive") {
  archiveVariant(variantId).then(() => console.log(JSON.stringify({ ok: true })));
} else {
  console.error("Usage: dgm-merge-handler.ts merge|archive <variant_id> [approver]");
  process.exit(1);
}
