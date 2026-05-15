#!/usr/bin/env bun
/**
 * atlas-prime-beacon — verify a local ledger against published roots.
 *
 * Usage:
 *   bun verify/verify-beacon.ts --against=<ledger-dir>
 *   bun verify/verify-beacon.ts --date=2026-05-14 --against=<ledger-dir>
 *
 * Exit 0 = match. Exit 1 = mismatch. Exit 2 = setup error.
 */
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

interface RootRecord {
  ts: string;
  root: string;
  entries: number;
}

interface LedgerEntry {
  seq: number;
  ts: string;
  prevHash: string;
  entryHash: string;
  signature: string;
  actor: string;
  action: { tool: string; args: any };
  sourceClaims?: any[];
  outcome?: { success: boolean; apiResponseHash?: string };
  policyDecision?: any;
}

function parseArgs(): { ledgerDir?: string; date?: string } {
  const out: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--(\w+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return { ledgerDir: out.against, date: out.date };
}

function canonicalJson(o: unknown): string {
  if (o === null || o === undefined) return "null";
  if (typeof o === "number") return String(o);
  if (typeof o === "boolean" || typeof o === "string") return JSON.stringify(o);
  if (Array.isArray(o))
    return "[" + o.map((v) => canonicalJson(v ?? null)).join(",") + "]";
  if (typeof o === "object") {
    const obj = o as Record<string, unknown>;
    const keys = Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined);
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(o);
}

function computeEntryHash(
  e: Omit<LedgerEntry, "entryHash" | "signature">
): string {
  return createHash("sha256").update(canonicalJson(e)).digest("hex");
}

async function loadLedger(dir: string): Promise<LedgerEntry[]> {
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const out: LedgerEntry[] = [];
  for (const f of files) {
    const txt = await readFile(join(dir, f), "utf-8");
    for (const line of txt.split("\n").filter(Boolean)) {
      out.push(JSON.parse(line));
    }
  }
  return out;
}

async function main() {
  const { ledgerDir, date } = parseArgs();
  if (!ledgerDir) {
    console.error(
      "usage: bun verify/verify-beacon.ts --against=<ledger-dir> [--date=YYYY-MM-DD]"
    );
    process.exit(2);
  }
  if (!existsSync(ledgerDir)) {
    console.error(`ledger dir not found: ${ledgerDir}`);
    process.exit(2);
  }
  const entries = await loadLedger(ledgerDir);
  let prev = "GENESIS";
  let seq = 1;
  for (const e of entries) {
    if (e.seq !== seq) {
      console.error(`seq gap at ${seq}`);
      process.exit(1);
    }
    if (e.prevHash !== prev) {
      console.error(`prevHash mismatch at seq=${e.seq}`);
      process.exit(1);
    }
    const { entryHash: _, signature: __, ...rest } = e;
    if (computeEntryHash(rest) !== e.entryHash) {
      console.error(`entryHash mismatch at seq=${e.seq}`);
      process.exit(1);
    }
    prev = e.entryHash;
    seq++;
  }
  const localRoot = prev === "GENESIS" ? "GENESIS" : prev;

  const targetFile = date ? `roots/${date}.jsonl` : "roots/latest.json";
  if (!existsSync(targetFile)) {
    console.error(`published file not found: ${targetFile}`);
    process.exit(2);
  }
  let published: RootRecord;
  if (date) {
    const lines = (await readFile(targetFile, "utf-8"))
      .split("\n")
      .filter(Boolean);
    published = JSON.parse(lines[lines.length - 1]);
  } else {
    published = JSON.parse(await readFile(targetFile, "utf-8"));
  }

  if (localRoot === published.root) {
    console.log(
      `MATCH: local root ${localRoot.slice(0, 16)}… matches published`
    );
    process.exit(0);
  }
  console.error("MISMATCH");
  console.error(`  local:     ${localRoot}`);
  console.error(`  published: ${published.root}`);
  process.exit(1);
}

if (import.meta.main) main();
