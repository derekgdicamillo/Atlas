import { mkdir, writeFile } from "node:fs/promises";
import { loadDataset, type ReplayEntry } from "./replay-dataset.ts";
import { scoreEntry, type JudgeScore } from "./replay-judge.ts";

const DATASET_PATH = process.env.REPLAY_DATASET_PATH ?? "data/replay-dataset.jsonl";
const RESULTS_DIR = "data/replay-results";

export interface HarnessReport {
  runId: string;
  datasetPath: string;
  startedAt: string;
  finishedAt: string;
  entryCount: number;
  perEntry: JudgeScore[];
  rollup: {
    mean_groundedness: number;
    mean_tool_correctness: number;
    mean_refusal_calibration: number;
    mean_aggregate: number;
    bad_label_mean_aggregate: number | null;
    good_label_mean_aggregate: number | null;
  };
}

function mean(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export async function runHarness(opts?: {
  datasetPath?: string;
  limit?: number;
  writeReport?: boolean;
}): Promise<HarnessReport> {
  const datasetPath = opts?.datasetPath ?? DATASET_PATH;
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, "-");

  const entries = await loadDataset(datasetPath);
  const working = opts?.limit ? entries.slice(0, opts.limit) : entries;

  const perEntry: JudgeScore[] = [];
  for (const entry of working) {
    try {
      const score = await scoreEntry(entry);
      perEntry.push(score);
    } catch (err) {
      console.error(`[replay] entry ${entry.id} failed:`, err);
    }
  }

  const byLabel = (label: ReplayEntry["label"]) =>
    perEntry.filter((s) => working.find((e) => e.id === s.entryId)?.label === label);

  const rollup = {
    mean_groundedness: mean(perEntry.map((s) => s.groundedness)),
    mean_tool_correctness: mean(perEntry.map((s) => s.tool_correctness)),
    mean_refusal_calibration: mean(perEntry.map((s) => s.refusal_calibration)),
    mean_aggregate: mean(perEntry.map((s) => s.aggregate)),
    bad_label_mean_aggregate: byLabel("bad").length ? mean(byLabel("bad").map((s) => s.aggregate)) : null,
    good_label_mean_aggregate: byLabel("good").length ? mean(byLabel("good").map((s) => s.aggregate)) : null,
  };

  const report: HarnessReport = {
    runId,
    datasetPath,
    startedAt,
    finishedAt: new Date().toISOString(),
    entryCount: perEntry.length,
    perEntry,
    rollup,
  };

  if (opts?.writeReport !== false) {
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(
      `${RESULTS_DIR}/${runId}.json`,
      JSON.stringify(report, null, 2),
      "utf8"
    );
  }

  return report;
}

if (import.meta.main) {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
  runHarness({ limit })
    .then((r) => {
      console.log(JSON.stringify(r.rollup, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
