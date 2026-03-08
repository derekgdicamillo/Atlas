/**
 * Darwin Loop — Performance tracking and configuration optimization
 *
 * Records task performance (model, time, cost, outcome) and analyzes
 * patterns to recommend optimal configurations per task category.
 *
 * Data stored in data/darwin-records.json (append-only, 90-day retention).
 * Nightly optimization outputs to data/task-output/darwin-report-{date}.md.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type { ModelTier } from "./constants.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || join(dirname(dirname(import.meta.path)));
const RECORDS_PATH = join(PROJECT_DIR, "data", "darwin-records.json");
const REPORT_DIR = join(PROJECT_DIR, "data", "task-output");
const RETENTION_DAYS = 90;

export interface TaskRecord {
  taskId: string;
  category: string;
  model: ModelTier;
  timeoutMs: number;
  wallClockMs: number;
  costUsd: number;
  outcome: "success" | "partial" | "failure";
  toolCalls: number;
  createdAt: string;
}

// ============================================================
// PERSISTENCE
// ============================================================

async function loadRecords(): Promise<TaskRecord[]> {
  try {
    const raw = await readFile(RECORDS_PATH, "utf-8");
    return JSON.parse(raw) as TaskRecord[];
  } catch {
    return [];
  }
}

async function saveRecords(records: TaskRecord[]): Promise<void> {
  await mkdir(dirname(RECORDS_PATH), { recursive: true });
  await writeFile(RECORDS_PATH, JSON.stringify(records, null, 2));
}

function pruneOldRecords(records: TaskRecord[]): TaskRecord[] {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return records.filter((r) => new Date(r.createdAt).getTime() > cutoff);
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Record a completed task's performance metrics.
 */
export async function recordTaskPerformance(record: TaskRecord): Promise<void> {
  const records = await loadRecords();
  records.push(record);
  const pruned = pruneOldRecords(records);
  await saveRecords(pruned);
}

/**
 * Analyze performance for a given category and recommend optimal config.
 */
export async function getOptimalConfig(category: string): Promise<{
  recommendedModel: ModelTier;
  recommendedTimeoutMs: number;
  avgCost: number;
  successRate: number;
  sampleSize: number;
}> {
  const records = await loadRecords();
  const catRecords = records.filter((r) => r.category === category);

  if (catRecords.length === 0) {
    return {
      recommendedModel: "sonnet",
      recommendedTimeoutMs: 120_000,
      avgCost: 0,
      successRate: 0,
      sampleSize: 0,
    };
  }

  // Group by model, find best success-rate-to-cost ratio
  const byModel = new Map<ModelTier, TaskRecord[]>();
  for (const r of catRecords) {
    const list = byModel.get(r.model) || [];
    list.push(r);
    byModel.set(r.model, list);
  }

  let bestModel: ModelTier = "sonnet";
  let bestScore = -1;

  for (const [model, recs] of byModel) {
    const successes = recs.filter((r) => r.outcome === "success").length;
    const successRate = successes / recs.length;
    const avgCost = recs.reduce((s, r) => s + r.costUsd, 0) / recs.length;
    // Score: success rate / (cost + 0.01 to avoid division by zero)
    const score = successRate / (avgCost + 0.01);
    if (score > bestScore) {
      bestScore = score;
      bestModel = model;
    }
  }

  // Timeout recommendation: p90 of successful wall clock times, with 20% headroom
  const successfulTimes = catRecords
    .filter((r) => r.outcome === "success")
    .map((r) => r.wallClockMs)
    .sort((a, b) => a - b);

  let recommendedTimeout = 120_000;
  if (successfulTimes.length > 0) {
    const p90Index = Math.floor(successfulTimes.length * 0.9);
    const p90 = successfulTimes[Math.min(p90Index, successfulTimes.length - 1)];
    recommendedTimeout = Math.ceil(p90 * 1.2); // 20% headroom
    // Floor at 30s, cap at 10 min
    recommendedTimeout = Math.max(30_000, Math.min(recommendedTimeout, 600_000));
  }

  const totalSuccesses = catRecords.filter((r) => r.outcome === "success").length;
  const totalCost = catRecords.reduce((s, r) => s + r.costUsd, 0);

  return {
    recommendedModel: bestModel,
    recommendedTimeoutMs: recommendedTimeout,
    avgCost: totalCost / catRecords.length,
    successRate: totalSuccesses / catRecords.length,
    sampleSize: catRecords.length,
  };
}

/**
 * Nightly optimization: analyze all categories and produce a report.
 * Returns the report text.
 */
export async function runDarwinOptimization(): Promise<string> {
  const records = await loadRecords();
  const pruned = pruneOldRecords(records);

  // Save pruned (garbage collect old records)
  if (pruned.length !== records.length) {
    await saveRecords(pruned);
  }

  if (pruned.length === 0) {
    return "No task records to analyze.";
  }

  // Find all categories
  const categories = [...new Set(pruned.map((r) => r.category))].sort();

  const lines: string[] = [
    `# Darwin Optimization Report`,
    ``,
    `**Date:** ${new Date().toISOString().split("T")[0]}`,
    `**Total records:** ${pruned.length}`,
    `**Categories:** ${categories.length}`,
    ``,
    `## Category Analysis`,
    ``,
  ];

  for (const cat of categories) {
    const config = await getOptimalConfig(cat);
    const catRecords = pruned.filter((r) => r.category === cat);
    const outcomes = {
      success: catRecords.filter((r) => r.outcome === "success").length,
      partial: catRecords.filter((r) => r.outcome === "partial").length,
      failure: catRecords.filter((r) => r.outcome === "failure").length,
    };

    lines.push(`### ${cat}`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Sample size | ${config.sampleSize} |`);
    lines.push(`| Success rate | ${(config.successRate * 100).toFixed(1)}% |`);
    lines.push(`| Avg cost | $${config.avgCost.toFixed(4)} |`);
    lines.push(`| Recommended model | ${config.recommendedModel} |`);
    lines.push(`| Recommended timeout | ${(config.recommendedTimeoutMs / 1000).toFixed(0)}s |`);
    lines.push(`| Outcomes | ${outcomes.success}S / ${outcomes.partial}P / ${outcomes.failure}F |`);
    lines.push(``);
  }

  // Summary recommendations
  lines.push(`## Recommendations`);
  lines.push(``);

  for (const cat of categories) {
    const config = await getOptimalConfig(cat);
    if (config.sampleSize < 3) {
      lines.push(`- **${cat}**: Insufficient data (${config.sampleSize} records). Need 3+ to recommend.`);
    } else if (config.successRate < 0.5) {
      lines.push(`- **${cat}**: Low success rate (${(config.successRate * 100).toFixed(0)}%). Consider upgrading model or increasing timeout.`);
    } else {
      lines.push(`- **${cat}**: Use **${config.recommendedModel}** with ${(config.recommendedTimeoutMs / 1000).toFixed(0)}s timeout. ${(config.successRate * 100).toFixed(0)}% success at $${config.avgCost.toFixed(4)}/task avg.`);
    }
  }

  const report = lines.join("\n");

  // Write report file
  const dateStr = new Date().toISOString().split("T")[0];
  const reportPath = join(REPORT_DIR, `darwin-report-${dateStr}.md`);
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(reportPath, report);

  console.log(`[darwin] Optimization report written to ${reportPath}`);
  return report;
}
