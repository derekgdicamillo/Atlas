#!/usr/bin/env bun
/**
 * Atlas Prime — Verify Beacon (Sprint 7)
 *
 * Walks the local ledger chain via verifyChain(), then asserts the
 * computed root matches data/beacon-repo/roots/latest.json.
 * Exit 0 = match. Exit 1 = mismatch. Exit 2 = setup error.
 */
import { verifyChain, computeRoot } from "../src/ledger.ts";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const BEACON_DIR = join(PROJECT_DIR, "data", "beacon-repo");

async function main() {
  const v = await verifyChain();
  if (!v.valid) {
    console.error(
      `[verify-beacon] LOCAL chain invalid: ${v.reason} at seq=${v.brokenAt}`
    );
    process.exit(2);
  }
  console.log(`[verify-beacon] local chain valid (${v.entries} entries)`);

  const latestPath = join(BEACON_DIR, "roots", "latest.json");
  if (!existsSync(latestPath)) {
    console.error(`[verify-beacon] no latest.json at ${latestPath}`);
    process.exit(2);
  }
  const latest = JSON.parse(await readFile(latestPath, "utf-8"));
  const { root: localRoot } = await computeRoot();

  if (localRoot === latest.root) {
    console.log(
      `[verify-beacon] MATCH — local root ${localRoot.slice(0, 16)}… matches published`
    );
    process.exit(0);
  } else {
    console.error(`[verify-beacon] MISMATCH`);
    console.error(`  local root:     ${localRoot}`);
    console.error(`  published root: ${latest.root}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[verify-beacon] error: ${err}`);
    process.exit(2);
  });
}
