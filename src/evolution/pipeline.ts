/**
 * Atlas — Evolution Pipeline Orchestrator
 *
 * Replaces the monolithic runEvolution() with a multi-phase pipeline:
 *
 * Phase 0: Graph enrichment + multi-resolution summarization (in-process, haiku)
 * Phase 1: Scout — intelligence synthesis (haiku, ~30s)
 * Phase 2: Conversation audit (sonnet, ~30s) [parallel with Phase 1]
 * Phase 3: Architect — design implementation plan (sonnet, ~60s)
 * Phase 4: Implementer — execute plan (opus code agent, ~30-60 min)
 * Phase 5: Validator — verify changes (haiku, ~30s)
 * Phase 6: Scorecard — update evolution history + send email (no LLM)
 *
 * Each phase is independently fail-safe. Pipeline continues on phase failure.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { spawn } from "bun";
import { info, warn, error as logError } from "../logger.ts";
import { MODELS } from "../constants.ts";
import {
  EVOLUTION_MAX_BUDGET_USD,
  EVOLUTION_PHASE_BUDGETS,
} from "./constants.ts";
import { sanitizedEnv, validateSpawnArgs } from "../claude.ts";
import { registerCodeTask, type CodeAgentResult } from "../supervisor.ts";
import { sendEmail } from "../google.ts";

// Phase modules
import { runScout, formatScoutReport, type ScoutReport } from "./scout.ts";
import { runAudit, formatAuditSummary, type ConversationAudit } from "./audit.ts";
import { runArchitect, formatPlanForImplementer, type ArchitectPlan } from "./architect.ts";
import { runValidator, type ValidationResult } from "./validator.ts";
import {
  appendHistory,
  appendMetrics,
  backfillErrorCount,
  buildWeeklyScorecard,
  type EvolutionRecord,
  type EvolutionPhaseResult,
} from "./history.ts";
import { runSummarizationV2, createWeeklySynthesis } from "./summarize-v2.ts";
import { runGraphEnrichment } from "./graph-enrich.ts";

import type { SupabaseClient } from "@supabase/supabase-js";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const TASK_OUTPUT_DIR = join(PROJECT_DIR, "data", "task-output");
const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const DEREK_CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const EVOLUTION_EMAIL_TO = "derek@pvmedispa.com";

// ============================================================
// TYPES
// ============================================================

export interface PipelineResult {
  /** Whether the pipeline ran at all */
  ran: boolean;
  /** Summary message for Telegram */
  message: string;
  /** Per-phase results */
  phases: EvolutionPhaseResult[];
  /** Total cost */
  totalCostUsd: number;
  /** Code agent task ID (if spawned) */
  taskId?: string;
}

// ============================================================
// PROMPT RUNNER (shared utility)
// ============================================================

/**
 * Run a prompt through Claude CLI. Used by scout, audit, architect, validator.
 */
async function runPrompt(prompt: string, model?: string): Promise<string> {
  try {
    const args = [CLAUDE_PATH, "-p", "--output-format", "json"];
    if (model) args.push("--model", model);

    // OpenClaw: Validate spawn args (reject CR/LF injection on Windows)
    validateSpawnArgs(args);

    const proc = spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR,
      env: sanitizedEnv(),
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return "";

    try {
      const parsed = JSON.parse(output);
      return (parsed.result ?? parsed.text ?? output).trim();
    } catch {
      return output.trim();
    }
  } catch (error) {
    logError("evolution:pipeline", `runPrompt ERROR: ${error}`);
    return "";
  }
}

/**
 * Run `bun build` and return pass/fail + output.
 */
async function runBuild(): Promise<{ passed: boolean; output: string }> {
  try {
    const proc = spawn(["bun", "build", "./src/relay.ts", "--outdir", "./dist", "--target", "bun"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR,
      env: sanitizedEnv(),
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    return {
      passed: exitCode === 0,
      output: (stdout + "\n" + stderr).trim().substring(0, 3000),
    };
  } catch (err) {
    return { passed: false, output: `Build error: ${err}` };
  }
}

// ============================================================
// TELEGRAM HELPER
// ============================================================

async function sendTelegram(chatId: string, text: string): Promise<void> {
  if (!BOT_TOKEN || !chatId) return;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 400 && body.includes("parse")) {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(10_000),
        });
      }
    }
  } catch (err) {
    warn("evolution:pipeline", `Telegram send failed: ${err}`);
  }
}

// ============================================================
// PIPELINE ORCHESTRATOR
// ============================================================

/**
 * Run the full evolution pipeline.
 *
 * @param supabase Supabase client (for Phase 0: summarization + graph enrichment)
 * @param opts.manual true if triggered by /evolve
 */
export async function runEvolutionPipeline(
  supabase: SupabaseClient | null,
  opts: { manual?: boolean } = {},
): Promise<PipelineResult> {
  const label = opts.manual ? "Manual evolution" : "Nightly evolution";
  const pipelineStart = Date.now();
  info("evolution:pipeline", `${label} pipeline starting...`);

  const phases: EvolutionPhaseResult[] = [];
  let totalCostUsd = 0;

  // Backfill last night's error count
  try {
    const { scanErrors } = await import("../evolve.ts");
    const errors = scanErrors(24);
    await backfillErrorCount(errors.failures.length + errors.errorLogLines.length);
  } catch { /* non-critical */ }

  // ── Phase 0: Graph enrichment + multi-resolution summarization ──
  if (supabase) {
    const p0Start = Date.now();
    try {
      info("evolution:pipeline", "Phase 0: Graph enrichment + summarization...");

      const [summaryResult, enrichResult] = await Promise.all([
        runSummarizationV2(supabase, (p) => runPrompt(p, MODELS.haiku)),
        runGraphEnrichment(supabase),
      ]);

      // Weekly synthesis on Sundays
      const isSunday = new Date().getDay() === 0;
      if (isSunday) {
        await createWeeklySynthesis(supabase, (p) => runPrompt(p, MODELS.haiku));
      }

      const p0Cost = 0.03 * (summaryResult.topicSummaries + 1); // rough estimate
      totalCostUsd += p0Cost;

      phases.push({
        phase: "summarization",
        status: "ok",
        durationMs: Date.now() - p0Start,
        costUsd: p0Cost,
        output: `${summaryResult.topicSummaries} topic summaries, daily digest: ${summaryResult.dailyDigest}, ${enrichResult.entitiesCreated} entities, ${enrichResult.edgesCreated} edges`,
      });
    } catch (err) {
      warn("evolution:pipeline", `Phase 0 failed: ${err}`);
      phases.push({
        phase: "summarization",
        status: "error",
        durationMs: Date.now() - p0Start,
        costUsd: 0,
        output: `Error: ${err}`,
      });
    }
  }

  // ── Phase 1 + 2: Scout + Audit (parallel) ──
  let scoutReport: ScoutReport | null = null;
  let audit: ConversationAudit | null = null;

  const p12Start = Date.now();
  try {
    info("evolution:pipeline", "Phase 1+2: Scout + Audit (parallel)...");

    const [scoutResult, auditResult] = await Promise.all([
      runScout((p) => runPrompt(p, MODELS.haiku)).catch((err) => {
        warn("evolution:pipeline", `Scout failed: ${err}`);
        return null;
      }),
      runAudit((p) => runPrompt(p, MODELS.sonnet)).catch((err) => {
        warn("evolution:pipeline", `Audit failed: ${err}`);
        return null;
      }),
    ]);

    scoutReport = scoutResult;
    audit = auditResult;

    const scoutCost = 0.02; // rough: ~10K input tokens haiku
    const auditCost = 0.05; // rough: ~10K input tokens sonnet
    totalCostUsd += scoutCost + auditCost;

    phases.push({
      phase: "scout",
      status: scoutReport ? "ok" : "error",
      durationMs: Date.now() - p12Start,
      costUsd: scoutCost,
      output: scoutReport
        ? `${scoutReport.findings.length} findings from ${scoutReport.sourcesScanned} sources`
        : "Scout failed",
    });

    phases.push({
      phase: "audit",
      status: audit ? "ok" : "error",
      durationMs: Date.now() - p12Start,
      costUsd: auditCost,
      output: audit
        ? formatAuditSummary(audit)
        : "Audit failed",
    });
  } catch (err) {
    warn("evolution:pipeline", `Phase 1+2 failed: ${err}`);
  }

  // ── Fast-track: inject low-risk behavioral rules immediately ──
  // Simple behavioral fixes (over-explaining, filler, style issues) get written
  // as rules right now instead of waiting for the architect->implementer cycle.
  const BEHAVIORAL_TYPES = new Set([
    "over_explaining", "filler_heavy", "premature_cant", "context_loss",
  ]);

  if (audit && audit.grades.length > 0) {
    const lowRiskIssues = audit.grades.flatMap((g) =>
      g.issues.filter(
        (i) => i.severity === "minor" || BEHAVIORAL_TYPES.has(i.type),
      ),
    );

    if (lowRiskIssues.length > 0) {
      try {
        const rulesDir = join(PROJECT_DIR, ".claude", "rules");
        const rulesPath = join(rulesDir, "behavioral-fixes.md");

        // Read existing rules to deduplicate
        let existing = "";
        if (existsSync(rulesPath)) {
          existing = readFileSync(rulesPath, "utf-8");
        } else {
          mkdirSync(rulesDir, { recursive: true });
          existing = "# Behavioral Fixes (auto-injected by evolution audit)\n\n";
        }

        const today = new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
        let added = 0;

        for (const issue of lowRiskIssues) {
          const fix = issue.suggestedFix || issue.description;
          // Skip if a substantially similar rule already exists
          const fixLower = fix.toLowerCase();
          if (existing.toLowerCase().includes(fixLower.substring(0, 40))) continue;

          existing += `- [${today}] ${issue.description} -> ${fix}\n`;
          added++;
        }

        if (added > 0) {
          writeFileSync(rulesPath, existing, "utf-8");
          info("evolution:pipeline", `Fast-track: injected ${added} behavioral rule(s) to ${rulesPath}`);

          phases.push({
            phase: "fast-track",
            status: "ok",
            durationMs: 0,
            costUsd: 0,
            output: `${added} behavioral rule(s) injected immediately`,
          });
        }
      } catch (err) {
        warn("evolution:pipeline", `Fast-track behavioral injection failed: ${err}`);
      }
    }
  }

  // ── Check if there's anything to do ──
  const hasFindings = scoutReport && scoutReport.findings.length > 0;
  const hasAuditIssues = audit && audit.overallScore >= 0 && audit.overallScore < 85;
  const hasAuditRegexIssues = audit?.regexReview?.hasIssues;

  if (!hasFindings && !hasAuditIssues && !hasAuditRegexIssues) {
    const msg = `${label}: All quiet. No findings, no conversation issues.`;
    info("evolution:pipeline", msg);

    // Still record history
    await recordEvolution(phases, totalCostUsd, pipelineStart, null, null, null, label);

    return { ran: false, message: msg, phases, totalCostUsd };
  }

  // ── Phase 3: Architect ──
  let architectPlan: ArchitectPlan | null = null;

  if (scoutReport || audit) {
    const p3Start = Date.now();
    try {
      info("evolution:pipeline", "Phase 3: Architect...");

      const defaultScout: ScoutReport = {
        timestamp: new Date().toISOString(),
        sourcesScanned: 0,
        rawFindingsCount: 0,
        findings: [],
        summary: "No scout data.",
        rawSources: { openclaw: { commits: [], newRelease: null, releaseNotes: null }, anthropicChangelog: [], claudeCodeReleases: [], selfAudit: { todos: [], fixmes: [], staleFiles: [] }, agentPapers: [], anthropicResearch: [], hfDailyPapers: [], langGraphReleases: [], communityFeeds: [], agentZeroReleases: [] },
        rawErrors: { failures: [], failureSummary: "", errorLogLines: [] },
        rawJournals: { problems: [], ideas: [] },
        historyContext: "",
      };
      const defaultAudit: ConversationAudit = {
        timestamp: new Date().toISOString(),
        conversationsAudited: 0,
        overallScore: -1,
        grades: [],
        improvements: [],
        regexReview: { issues: [], counts: { dropped_task: 0, repeated_question: 0, misunderstanding: 0, went_silent: 0, premature_cant: 0, context_loss: 0 }, hasIssues: false },
        durationMs: 0,
      };

      architectPlan = await runArchitect(
        (p) => runPrompt(p, MODELS.sonnet),
        scoutReport || defaultScout,
        audit || defaultAudit,
      );

      const p3Cost = 0.08;
      totalCostUsd += p3Cost;

      phases.push({
        phase: "architect",
        status: architectPlan.changes.length > 0 ? "ok" : "skipped",
        durationMs: Date.now() - p3Start,
        costUsd: p3Cost,
        output: `${architectPlan.changes.length} changes planned, ${architectPlan.skipped.length} skipped, risk: ${architectPlan.overallRisk}`,
      });
    } catch (err) {
      warn("evolution:pipeline", `Phase 3 failed: ${err}`);
      phases.push({
        phase: "architect",
        status: "error",
        durationMs: Date.now() - p3Start,
        costUsd: 0,
        output: `Error: ${err}`,
      });
    }
  }

  // ── Phase 4: Implementer (code agent) ──
  if (architectPlan && architectPlan.changes.length > 0) {
    const implementerPrompt = formatPlanForImplementer(architectPlan);

    // Build findings summary for Telegram
    const findings: string[] = [];
    if (scoutReport && scoutReport.findings.length > 0) {
      findings.push(`${scoutReport.findings.length} scout finding(s)`);
    }
    if (audit && audit.overallScore >= 0) {
      findings.push(`conv quality: ${audit.overallScore}/100`);
    }
    const findingSummary = findings.join(", ");

    try {
      info("evolution:pipeline", "Phase 4: Spawning implementer (code agent)...");

      const taskId = await registerCodeTask({
        description: `${label}: ${findingSummary}`,
        prompt: implementerPrompt,
        cwd: PROJECT_DIR,
        model: "opus",
        requestedBy: opts.manual ? "manual:/evolve" : "cron:evolution",
        wallClockMs: 60 * 60 * 1000, // 60 min
        budgetUsd: EVOLUTION_PHASE_BUDGETS.implementer,
        onComplete: async (result: CodeAgentResult) => {
          // Phase 5: Validator
          let validation: ValidationResult | null = null;
          try {
            validation = await runValidator(
              runBuild,
              architectPlan!,
              (p) => runPrompt(p, MODELS.haiku),
            );
          } catch (err) {
            warn("evolution:pipeline", `Validator failed: ${err}`);
          }

          // Phase 6: Record history + send notifications
          const implementerCost = result.costUsd || 0;
          const validatorCost = 0.02;

          phases.push({
            phase: "implementer",
            status: result.exitReason === "completed" ? "ok" : "error",
            durationMs: result.durationMs || 0,
            costUsd: implementerCost,
            output: `${result.toolCallCount} tool calls, exit: ${result.exitReason}`,
          });

          if (validation) {
            phases.push({
              phase: "validator",
              status: validation.buildPassed ? "ok" : "error",
              durationMs: validation.durationMs,
              costUsd: validatorCost,
              output: validation.summary,
            });
          }

          const finalCost = totalCostUsd + implementerCost + validatorCost;
          await recordEvolution(
            phases,
            finalCost,
            pipelineStart,
            scoutReport,
            audit,
            validation,
            label,
          );

          // Telegram notification
          const status = result.exitReason === "completed" ? "completed" : `stopped (${result.exitReason})`;
          const buildStatus = validation?.buildPassed ? "build OK" : "BUILD FAILED";
          const durationSec = Math.round((Date.now() - pipelineStart) / 1000);
          const msg = [
            `**${label} ${status}**`,
            `Scout: ${scoutReport?.findings.length || 0} findings | Audit: ${audit?.overallScore ?? "N/A"}/100`,
            `Architect: ${architectPlan!.changes.length} changes | ${buildStatus}`,
            `Cost: $${finalCost.toFixed(2)} | Duration: ${durationSec}s`,
          ].join("\n");

          await sendTelegram(DEREK_CHAT_ID, msg);
          await sendEvolutionEmail(label, phases, finalCost, durationSec, scoutReport, audit, validation);
        },
      });

      // Send heads-up
      await sendTelegram(
        DEREK_CHAT_ID,
        `**${label} pipeline started.** Scout: ${scoutReport?.findings.length || 0} findings, Audit: ${audit?.overallScore ?? "N/A"}/100. Architect planned ${architectPlan.changes.length} changes. Implementer spawned.`,
      );

      return {
        ran: true,
        message: `${label} pipeline started. ${findingSummary}. ${architectPlan.changes.length} changes planned.`,
        phases,
        totalCostUsd,
        taskId,
      };
    } catch (err) {
      logError("evolution:pipeline", `Implementer spawn failed: ${err}`);
      phases.push({
        phase: "implementer",
        status: "error",
        durationMs: 0,
        costUsd: 0,
        output: `Spawn failed: ${err}`,
      });
    }
  }

  // If we got here without spawning an implementer, record what we have
  await recordEvolution(phases, totalCostUsd, pipelineStart, scoutReport, audit, null, label);

  return {
    ran: phases.some((p) => p.status === "ok"),
    message: `${label} completed phases 0-3. No implementer needed.`,
    phases,
    totalCostUsd,
  };
}

// ============================================================
// HISTORY RECORDING
// ============================================================

async function recordEvolution(
  phases: EvolutionPhaseResult[],
  totalCost: number,
  startTime: number,
  scout: ScoutReport | null,
  audit: ConversationAudit | null,
  validation: ValidationResult | null,
  label: string,
): Promise<void> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: TIMEZONE });

  // Extract implemented/skipped from evolution report
  const reportPath = join(TASK_OUTPUT_DIR, "nightly-evolution.md");
  let implemented: string[] = [];
  let skipped: string[] = [];

  if (existsSync(reportPath)) {
    try {
      const content = readFileSync(reportPath, "utf-8");
      // Parse implemented changes (lines starting with "- " under implementation headers)
      const implSection = content.match(/(?:implement|change|update|fix)[\s\S]*?(?=(?:##|$))/gi);
      if (implSection) {
        for (const section of implSection) {
          for (const line of section.split("\n")) {
            if (line.trim().startsWith("- ")) {
              implemented.push(line.trim().substring(2).substring(0, 150));
            }
          }
        }
      }
    } catch { /* skip */ }
  }

  // Follow-ups from scout/architect
  const followUps: string[] = [];
  if (scout) {
    for (const f of scout.findings) {
      if (f.effort === "high") {
        followUps.push(`[${f.category}] ${f.description.substring(0, 100)}`);
      }
    }
  }

  // Conversation issues from audit
  const conversationIssues: string[] = [];
  if (audit) {
    for (const g of audit.grades) {
      for (const issue of g.issues) {
        conversationIssues.push(`[${issue.type}] ${issue.description.substring(0, 100)}`);
      }
    }
  }

  const record: EvolutionRecord = {
    date: dateStr,
    startedAt: new Date(startTime).toISOString(),
    completedAt: now.toISOString(),
    phases,
    sourcesWithFindings: scout
      ? [
          scout.rawSources.openclaw.commits.length > 0 ? "openclaw" : "",
          scout.rawSources.anthropicChangelog.length > 0 ? "anthropic" : "",
          scout.rawSources.claudeCodeReleases.length > 0 ? "claude-code" : "",
          scout.rawErrors.failures.length > 0 ? "errors" : "",
        ].filter(Boolean)
      : [],
    implemented: implemented.slice(0, 20),
    skipped: skipped.slice(0, 10),
    buildPassed: validation?.buildPassed ?? true,
    totalCostUsd: totalCost,
    totalDurationSec: Math.round((Date.now() - startTime) / 1000),
    conversationScore: audit?.overallScore ?? null,
    conversationIssues: conversationIssues.slice(0, 10),
    followUps: followUps.slice(0, 5),
    errorCount24h: scout?.rawErrors.failures.length ?? 0,
  };

  await appendHistory(record);

  // Also record metrics
  await appendMetrics({
    date: dateStr,
    sourcesScanned: scout?.sourcesScanned ?? 0,
    findingsCount: scout?.findings.length ?? 0,
    implementedCount: implemented.length,
    skippedCount: skipped.length,
    buildPassed: validation?.buildPassed ?? true,
    costUsd: totalCost,
    durationSec: record.totalDurationSec,
    conversationScore: audit?.overallScore ?? null,
    errorCountBefore: scout?.rawErrors.failures.length ?? 0,
    errorCountAfter: null, // filled next night
  });
}

// ============================================================
// EMAIL
// ============================================================

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function emailDate(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

async function sendEvolutionEmail(
  label: string,
  phases: EvolutionPhaseResult[],
  totalCost: number,
  durationSec: number,
  scout: ScoutReport | null,
  audit: ConversationAudit | null,
  validation: ValidationResult | null,
): Promise<void> {
  try {
    const phaseRows = phases.map((p) => {
      const statusIcon = p.status === "ok" ? "&#9989;" : p.status === "error" ? "&#10060;" : "&#9898;";
      return `<tr>
        <td style="padding:6px 12px;">${statusIcon}</td>
        <td style="padding:6px 12px;font-weight:600;">${escapeHtml(p.phase)}</td>
        <td style="padding:6px 12px;">${(p.durationMs / 1000).toFixed(0)}s</td>
        <td style="padding:6px 12px;">$${p.costUsd.toFixed(2)}</td>
        <td style="padding:6px 12px;color:#555;font-size:13px;">${escapeHtml(p.output || "")}</td>
      </tr>`;
    }).join("\n");

    // Scout findings section
    let findingsHtml = "";
    if (scout && scout.findings.length > 0) {
      findingsHtml = `<h3 style="margin:16px 0 8px;">Scout Findings</h3><ol style="font-size:13px;color:#555;">`;
      for (const f of scout.findings) {
        findingsHtml += `<li><strong>[${escapeHtml(f.category)}]</strong> ${escapeHtml(f.description)}<br/><em>Action: ${escapeHtml(f.action)}</em></li>`;
      }
      findingsHtml += "</ol>";
    }

    // Audit section
    let auditHtml = "";
    if (audit && audit.overallScore >= 0) {
      auditHtml = `<h3 style="margin:16px 0 8px;">Conversation Audit: ${audit.overallScore}/100</h3>`;
      for (const g of audit.grades) {
        auditHtml += `<p style="font-size:13px;"><strong>${escapeHtml(g.session)}</strong>: ${g.grade} (${g.score})</p>`;
      }
    }

    const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:700px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);color:white;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:20px;">Atlas Evolution Pipeline</h1>
    <p style="margin:8px 0 0;opacity:0.85;font-size:14px;">${emailDate()}</p>
  </div>
  <div style="background:white;border:1px solid #e0e0e0;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
    <div style="display:flex;gap:16px;margin-bottom:16px;font-size:13px;color:#666;">
      <span><strong>Total cost:</strong> $${totalCost.toFixed(2)}</span>
      <span><strong>Duration:</strong> ${durationSec}s</span>
      <span><strong>Build:</strong> ${validation?.buildPassed ? "PASS" : validation ? "FAIL" : "N/A"}</span>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="border-bottom:2px solid #1a1a2e;">
        <th style="padding:6px 12px;text-align:left;">St</th>
        <th style="padding:6px 12px;text-align:left;">Phase</th>
        <th style="padding:6px 12px;text-align:left;">Time</th>
        <th style="padding:6px 12px;text-align:left;">Cost</th>
        <th style="padding:6px 12px;text-align:left;">Output</th>
      </tr></thead>
      <tbody>${phaseRows}</tbody>
    </table>
    ${findingsHtml}
    ${auditHtml}
  </div>
</body></html>`;

    const subject = `Atlas Evolution Pipeline \u2014 ${emailDate()}`;
    await sendEmail(EVOLUTION_EMAIL_TO, subject, htmlBody);
    info("evolution:pipeline", "Evolution email sent");
  } catch (err) {
    warn("evolution:pipeline", `Evolution email failed (non-fatal): ${err}`);
  }
}
