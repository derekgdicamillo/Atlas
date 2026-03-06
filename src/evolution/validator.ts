/**
 * Atlas — Evolution Validator (Phase 5)
 *
 * Runs after the implementer finishes. Verifies changes by running the build,
 * checking for suspicious patterns, and grading work against the architect's plan.
 *
 * Lightweight: uses Haiku with minimal budget. Primarily runs `bun build`
 * and does textual analysis of the code agent's output.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { info, warn } from "../logger.ts";
import type { ArchitectPlan } from "./architect.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const TASK_OUTPUT_DIR = join(PROJECT_DIR, "data", "task-output");

// ============================================================
// TYPES
// ============================================================

export interface ValidationResult {
  /** Whether the build passes */
  buildPassed: boolean;
  /** Build output (truncated) */
  buildOutput: string;
  /** Per-change verification */
  changeResults: Array<{
    order: number;
    description: string;
    status: "implemented" | "partial" | "missing" | "deviated";
    notes: string;
  }>;
  /** Overall assessment */
  assessment: "approved" | "needs_review" | "rollback_recommended";
  /** Summary for the evolution record */
  summary: string;
  /** Duration of validation */
  durationMs: number;
}

// ============================================================
// VALIDATION LOGIC
// ============================================================

/**
 * Run validation on the implementer's work.
 *
 * @param runBuild Callback that runs `bun build` and returns {passed, output}
 * @param plan The architect's plan to validate against
 * @param runPrompt Callback to run a prompt through Claude (haiku) for analysis
 * @returns ValidationResult
 */
export async function runValidator(
  runBuild: () => Promise<{ passed: boolean; output: string }>,
  plan: ArchitectPlan,
  runPrompt: (prompt: string) => Promise<string>,
): Promise<ValidationResult> {
  const startTime = Date.now();
  info("evolution:validator", "Starting validation...");

  // Step 1: Run build
  const buildResult = await runBuild();
  info("evolution:validator", `Build ${buildResult.passed ? "PASSED" : "FAILED"}`);

  // Step 2: Read the evolution report
  const reportPath = join(TASK_OUTPUT_DIR, "nightly-evolution.md");
  let reportContent = "";
  if (existsSync(reportPath)) {
    try {
      reportContent = readFileSync(reportPath, "utf-8");
    } catch { /* skip */ }
  }

  // Step 3: Grade changes against the plan
  let changeResults: ValidationResult["changeResults"] = [];
  let assessment: ValidationResult["assessment"] = "approved";

  if (plan.changes.length > 0 && reportContent) {
    // Use Haiku to check if each planned change was implemented
    const prompt = buildValidationPrompt(plan, reportContent, buildResult);
    const response = await runPrompt(prompt);
    const parsed = parseValidationResponse(response, plan);
    changeResults = parsed.changeResults;
    assessment = parsed.assessment;
  } else if (!buildResult.passed) {
    assessment = "rollback_recommended";
  }

  // Build failed = always needs review at minimum
  if (!buildResult.passed && assessment === "approved") {
    assessment = "needs_review";
  }

  const durationMs = Date.now() - startTime;

  // Build summary
  const implemented = changeResults.filter((c) => c.status === "implemented").length;
  const partial = changeResults.filter((c) => c.status === "partial").length;
  const missing = changeResults.filter((c) => c.status === "missing").length;
  const summary = `Build: ${buildResult.passed ? "PASS" : "FAIL"} | ${implemented} implemented, ${partial} partial, ${missing} missing | ${assessment}`;

  info("evolution:validator", `Validation complete: ${summary} (${(durationMs / 1000).toFixed(1)}s)`);

  return {
    buildPassed: buildResult.passed,
    buildOutput: buildResult.output.substring(0, 2000),
    changeResults,
    assessment,
    summary,
    durationMs,
  };
}

function buildValidationPrompt(
  plan: ArchitectPlan,
  reportContent: string,
  buildResult: { passed: boolean; output: string },
): string {
  const sections = [
    "Check if each planned change was implemented. Compare the plan to the evolution report.",
    "",
    "Output format (JSON):",
    '```json',
    '{"changeResults":[{"order":1,"status":"implemented|partial|missing|deviated","notes":"brief explanation"}],',
    '"assessment":"approved|needs_review|rollback_recommended"}',
    '```',
    "",
    `Build status: ${buildResult.passed ? "PASSED" : "FAILED"}`,
    "",
    "PLANNED CHANGES:",
  ];

  for (const c of plan.changes) {
    sections.push(`${c.order}. ${c.description} (files: ${c.files.join(", ")})`);
  }

  sections.push("");
  sections.push("EVOLUTION REPORT:");
  sections.push(reportContent.substring(0, 4000));

  if (!buildResult.passed) {
    sections.push("");
    sections.push("BUILD OUTPUT:");
    sections.push(buildResult.output.substring(0, 1000));
  }

  return sections.join("\n");
}

function parseValidationResponse(
  raw: string,
  plan: ArchitectPlan,
): { changeResults: ValidationResult["changeResults"]; assessment: ValidationResult["assessment"] } {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      changeResults: plan.changes.map((c) => ({
        order: c.order,
        description: c.description,
        status: "missing" as const,
        notes: "Validator could not parse response",
      })),
      assessment: "needs_review",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    const changeResults = (parsed.changeResults || []).map((cr: any, i: number) => ({
      order: cr.order || i + 1,
      description: plan.changes[i]?.description || "",
      status: (["implemented", "partial", "missing", "deviated"].includes(cr.status)
        ? cr.status
        : "missing") as "implemented" | "partial" | "missing" | "deviated",
      notes: String(cr.notes || ""),
    }));

    const assessment = (["approved", "needs_review", "rollback_recommended"].includes(parsed.assessment)
      ? parsed.assessment
      : "needs_review") as ValidationResult["assessment"];

    return { changeResults, assessment };
  } catch {
    return {
      changeResults: plan.changes.map((c) => ({
        order: c.order,
        description: c.description,
        status: "missing" as const,
        notes: "JSON parse failed",
      })),
      assessment: "needs_review",
    };
  }
}
