#!/usr/bin/env bun
// Reads the most recent replay-results/*.json and writes one trust event
// per entry: +1 if aggregate >= 0.7, -1 if aggregate <= 0.4, skip otherwise.

import { readdir, readFile } from "node:fs/promises";
import { recordEvent } from "../src/trust-engine.ts";
import { loadDataset } from "../src/replay-dataset.ts";

async function main() {
  const dir = "data/replay-results";
  const files = (await readdir(dir).catch(() => []))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .slice(-1);
  if (!files.length) {
    console.error("no replay results");
    return;
  }
  const report = JSON.parse(await readFile(`${dir}/${files[0]}`, "utf8"));
  const dataset = await loadDataset("data/replay-dataset.jsonl");
  const byId = new Map(dataset.map((e) => [e.id, e]));
  let emitted = 0;
  for (const s of report.perEntry as Array<{ entryId: string; aggregate: number }>) {
    if (s.aggregate >= 0.7 === false && s.aggregate > 0.4) continue;
    const entry = byId.get(s.entryId);
    const domain = entry?.tags?.[0] ?? "general";
    const delta = s.aggregate >= 0.7 ? +1 : -1;
    await recordEvent({ ts: new Date().toISOString(), domain, delta, source: s.entryId });
    emitted++;
  }
  console.log(`emitted ${emitted} trust events`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
