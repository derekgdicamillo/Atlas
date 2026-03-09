/**
 * Atlas — Scheduled Jobs
 *
 * In-process cron jobs using the `cron` package.
 * All times are in America/Phoenix (Arizona — MST, no DST).
 */

import { CronJob } from "cron";
import { spawn } from "bun";
import { existsSync, copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMetrics, getHealthStatus, getTodayClaudeCosts, error as logError, warn, redactObject } from "./logger.ts";
import { getAllBreakerStats } from "./circuit-breaker.ts";
import { MODELS, CRON_JITTER_MAX_MS, CRON_JITTER_EXEMPT } from "./constants.ts";
import { ingestDocument } from "./search.ts";
import { readTodoFile } from "./todo.ts";
import { runEvolution } from "./evolve.ts";
import { runEvolutionPipeline } from "./evolution/index.ts";
import { runHeartbeat } from "./heartbeat.ts";
import { runSummarization } from "./summarize.ts";
import { runPrompt } from "./prompt-runner.ts";
import { loadTasks, checkTasks, registerTask, markAnnounced, incrementAnnounceRetry, getLocalTaskIds, type CompletedTaskInfo } from "./supervisor.ts";
import { initTaskPersistence, syncTasksFromSupabase } from "./task-persistence.ts";
import { runSupervisorWorker, getCodeAgentStatus } from "./supervisor-worker.ts";
import { withLock } from "./supervisor-lock.ts";
import { checkScheduledMessages } from "./scheduled.ts";
import { runConsolidation, checkTimeTriggers } from "./cognitive.ts";
import { callClaude, sessionKey, sanitizedEnv } from "./claude.ts";
import { addEntry } from "./conversation.ts";
import { isDashboardReady, getFinancialPulse, getPipelinePulse } from "./dashboard.ts";
import { isGHLReady, getNewLeadsSince, getOpsSnapshot, formatOpsSnapshot, getRecentWebhookEvents, markEventsProcessed, getAllOpportunities, addTagToContact, createContactTask, getContact, PIPELINES, registerShowRateDigest, type GHLOpportunity } from "./ghl.ts";
import { instantiateWorkflow } from "./workflows.ts";
import { isGBPReady, getGBPContext } from "./gbp.ts";
import { isGA4Ready, getGA4Context } from "./analytics.ts";
import { buildWeeklySummary, formatWeeklySummary, detectAllAnomalies } from "./executive.ts";
import { appendRun, cleanupOldRuns, type CronRun } from "./run-log.ts";
import { runPharmacyInvoiceProcessor, formatPharmacySummary } from "./pharmacy-invoices.ts";
import { fireHooks } from "./hooks.ts";
import { sendEmail } from "./google.ts";
import { emit as emitAlert, deliver as deliverAlerts } from "./alerts.ts";
import { checkAppointmentReminders, cleanupStaleReminderTags, getShowRateDigest } from "./show-rate.ts";
import { isEffectivelyPaused, shouldSuppressAnnouncement, recordSuppressedTask } from "./automation-pause.ts";
import { critiqueContent, formatCriticReport } from "./content-critic.ts";
import { runNightShiftPlanner, runNightShiftWorker, getNightShiftReport } from "./night-shift.ts";
import { trackContentGeneration } from "./content-tracker.ts";
import { runStrategicMemo } from "./strategic-memo.ts";
import { cleanupOldNotes } from "./progress-notes.ts";
import { decayStaleEntries } from "./codex.ts";
import { cleanupOldEvents } from "./agent-events.ts";
import { recordAdSnapshots, insightsToSnapshots, analyzeAdPerformance } from "./ad-tracker.ts";
import { buildFunnelSnapshot, checkFunnelHealth, formatFunnelAlerts, buildAdDigest, buildWeeklyAttribution, formatAttributionTelegram, buildContentHooksMemo, runCompetitorRecon, buildMonthlyBrief, draftGBPPost } from "./marketing.ts";
import { captureDaily as captureDailyScorecard } from "./metrics-engine.ts";

// Module-level supabase reference. Set by startCronJobs().
// Needed by jobs declared at module scope (evolution, appointment-reminders)
// that fire after startup. Without this, those callbacks get ReferenceError.
let supabase: SupabaseClient | null = null;

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";
const HEARTBEAT_CRON = process.env.HEARTBEAT_CRON || "*/30 7-22 * * *";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const DEREK_CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const MEMORY_DIR = join(PROJECT_DIR, "memory");
const DATA_DIR = join(PROJECT_DIR, "data");
const BACKUP_DIR = "C:\\Users\\derek\\OneDrive - PV MEDISPA LLC\\Backups\\atlas";
const WATERFALL_VAULT_DIR = "C:\\Users\\derek\\OneDrive - PV MEDISPA LLC\\PV Vault\\02 - PV MediSpa\\Content\\Waterfalls";

/** Atomic JSON write: write to tmp file, then rename. Prevents corrupt state on crash. */
function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

const PILLAR_NAMES: Record<number, string> = {
  1: "Precision Weight Science",
  2: "Nourishing Health",
  3: "Dynamic Movement",
  4: "Mindful Wellness",
  5: "Functional Wellness",
};

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

function log(job: string, message: string): void {
  const ts = new Date().toLocaleString("en-US", { timeZone: TIMEZONE });
  console.log(`[cron:${job}] ${ts} — ${message}`);
}

// ============================================================
// CONTENT WATERFALL HELPERS (OneDrive vault save + email)
// ============================================================

/** Parse pillar number and subtopic from waterfall output header.
 *  Expects a line like: "Pillar: Nourishing Health | Subtopic: Protein Paradox ..." */
function parseWaterfallMeta(content: string): { pillar: number; subtopic: string } {
  // Try to match the header line: "Pillar: <name> | Subtopic: <name> | Format: <type>"
  const headerMatch = content.match(/Pillar:\s*([^|]+)\|\s*Subtopic:\s*([^|]+)/i);
  if (headerMatch) {
    const pillarName = headerMatch[1].trim();
    const subtopic = headerMatch[2].trim();
    // Map name back to number
    const pillarNum = Object.entries(PILLAR_NAMES).find(
      ([, name]) => pillarName.toLowerCase() === name.toLowerCase()
    );
    return { pillar: pillarNum ? Number(pillarNum[0]) : 0, subtopic };
  }

  // Fallback: read the rotation file for the current state (already updated by the skill)
  try {
    const rotationPath = join(MEMORY_DIR, "content-rotation.json");
    if (existsSync(rotationPath)) {
      const rotation = JSON.parse(readFileSync(rotationPath, "utf-8"));
      return {
        pillar: rotation.lastPillar || 0,
        subtopic: rotation.lastSubtopic || "Unknown",
      };
    }
  } catch (e) { warn("cron", `Failed to parse content-rotation.json: ${e}`); }
  return { pillar: 0, subtopic: "Unknown" };
}

/** Save waterfall markdown to the OneDrive vault directory. */
function saveWaterfallToVault(content: string, pillarNum: number): string | null {
  try {
    if (!existsSync(WATERFALL_VAULT_DIR)) {
      mkdirSync(WATERFALL_VAULT_DIR, { recursive: true });
    }
    const date = today();
    const filename = `${date}-pillar-${pillarNum}.md`;
    const filepath = join(WATERFALL_VAULT_DIR, filename);
    writeFileSync(filepath, content, "utf-8");
    log("content-engine", `Saved waterfall to vault: ${filename}`);
    return filepath;
  } catch (err) {
    logError("cron", `Failed to save waterfall to vault: ${err}`);
    return null;
  }
}

/** Email the waterfall content to Derek via Atlas's Gmail. */
async function emailWaterfall(content: string, pillarNum: number, subtopic: string): Promise<boolean> {
  const subject = `Content Waterfall — Pillar ${pillarNum}: ${subtopic}`;
  const body = `${subject}\n\n${content}`;

  try {
    const msgId = await sendEmail("derek@pvmedispa.com", subject, body);
    if (msgId) {
      log("content-engine", `Emailed waterfall to Derek (msgId: ${msgId})`);
      return true;
    }
    warn("cron", "sendEmail returned null (Atlas Gmail may not be configured)");
    return false;
  } catch (err) {
    logError("cron", `Failed to email waterfall: ${err}`);
    return false;
  }
}

// ============================================================
// SAFE TICK WRAPPER (OpenClaw #15108 — prevent cron silent death)
// ============================================================

// OpenClaw #18073: Minimum refire gap prevents spin loops from node-cron edge cases
const MIN_REFIRE_GAP_MS = 25_000; // 25 seconds (5s margin for cron scheduling jitter)
const lastFireTimes = new Map<string, number>();

// OpenClaw #22413: maxConcurrentRuns guard. Long-running cron jobs (evolution,
// summarization) must not overlap if a previous run hasn't finished.
const runningJobs = new Set<string>();

// OpenClaw 2026.2.22: Per-job wall-clock timeout guards.
// Prevents stuck cron jobs from holding the runningJobs lock indefinitely.
// If a job exceeds its timeout, it's treated as an error and the lock is released.
const JOB_TIMEOUTS_MS: Record<string, number> = {
  "evolution":      20 * 60 * 1000, // 20 min — includes code agent spawn
  "summarize":      15 * 60 * 1000, // 15 min — may process many conversations
  "reflect":        10 * 60 * 1000, // 10 min
  "content-engine": 10 * 60 * 1000, // 10 min
  "morning-brief":   5 * 60 * 1000, //  5 min
  "weekly-exec":     8 * 60 * 1000, //  8 min
  "todo-review":     3 * 60 * 1000, //  3 min
  "git-backup":      2 * 60 * 1000, //  2 min
  "backup":          1 * 60 * 1000, //  1 min
  "journal":         1 * 60 * 1000, //  1 min
  "cleanup":         2 * 60 * 1000, //  2 min
  "health-dump":    30 * 1000,       // 30 sec
  "prospective-memory": 30 * 1000,   // 30 sec (just a Supabase RPC, should be <5s; halved to prevent overlap with 1-min cron)
  "ghl-leads":       2 * 60 * 1000, //  2 min
  "appointment-reminders": 3 * 60 * 1000, // 3 min
  "lead-enrich":     3 * 60 * 1000, //  3 min
  "stale-leads":     3 * 60 * 1000, //  3 min
  "lead-volume":     2 * 60 * 1000, //  2 min
  "alert-deliver":  30 * 1000,        // 30 sec (just a Supabase query, should be <5s; halved to prevent overlap with 1-min cron)
  "scheduled-msgs": 30 * 1000,       // 30 sec (quick check for due messages)
  "anomaly-scan":    2 * 60 * 1000, //  2 min
  "monitor-fast":    3 * 60 * 1000, //  3 min (fast tier: leads, reviews, urgent email)
  "monitor-medium":  5 * 60 * 1000, //  5 min (medium tier: ads, pipeline, speed-to-lead)
  "monitor-slow":   10 * 60 * 1000, // 10 min (slow tier: financials, traffic, conversions)
  "monitor-daily":   5 * 60 * 1000, //  5 min (daily tier: morning calendar pre-load)
  "observation-reflector": 8 * 60 * 1000, // 8 min (semantic analysis over recent messages)
  "supervisor-worker": 30 * 1000,   // 30 sec (quick agent status check)
  "tox-post":        3 * 60 * 1000, //  3 min (posts to multiple platforms)
  "tox-analytics":   3 * 60 * 1000, //  3 min (fetches from multiple APIs)
  "tox-weekly":      2 * 60 * 1000, //  2 min
  "etsy-sync":       2 * 60 * 1000, //  2 min
  "metric-cleanup":  60 * 1000,     //  1 min (single Supabase RPC)
  "ghl-webhook-health": 30 * 1000,  // 30 sec (single Supabase query)
  "pharmacy-invoices": 5 * 60 * 1000, // 5 min — M365 API + PDF parsing + OneDrive save
  "overnight-content": 10 * 60 * 1000, // 10 min — overnight draft generation
  "night-shift-plan": 3 * 60 * 1000, //  3 min — Haiku planner, quick
  "night-shift-work": 15 * 60 * 1000, // 15 min — processes up to 5 tasks
  "strategic-memo":   5 * 60 * 1000, //  5 min — Sonnet weekly memo
  "codex-decay":     60 * 1000,       //  1 min — prune stale codex entries
  "progress-cleanup": 60 * 1000,      //  1 min — delete old progress notes
  "event-cleanup":   60 * 1000,       //  1 min — delete old agent event logs
  "journal-ingest":  5 * 60 * 1000,   //  5 min — ingest journals to searchable store
  "daily-scorecard": 2 * 60 * 1000, //  2 min — daily business scorecard to Supabase
  "midas-funnel":    3 * 60 * 1000, //  3 min — daily funnel conversion monitor
  "midas-digest":    3 * 60 * 1000, //  3 min — daily ad performance digest
  "midas-attribution": 5 * 60 * 1000, //  5 min — weekly full-funnel attribution
  "midas-hooks":     5 * 60 * 1000, //  5 min — content hooks memo (Opus)
  "midas-recon":     5 * 60 * 1000, //  5 min — competitor recon (Opus)
  "midas-monthly":  10 * 60 * 1000, // 10 min — monthly strategic brief (Opus, big prompt)
  "midas-gbp":       3 * 60 * 1000, //  3 min — GBP content draft (Sonnet)
  "metrics-reminder": 30 * 1000,    // 30 sec — just sends a Telegram message
  "meeting-check":   3 * 60 * 1000, // 3 min — fetch + process transcripts via Claude
  "default":         5 * 60 * 1000, //  5 min catch-all
};

// Sentinel used to distinguish wall-clock timeouts from regular errors
const CRON_TIMEOUT_SENTINEL = Symbol("CronTimeout");

function safeTick(jobName: string, fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    // Concurrent run guard: skip if this job is still running from a previous tick
    if (runningJobs.has(jobName)) {
      warn("cron", `[${jobName}] Already running, skipping concurrent tick`);
      appendRun(jobName, {
        ts: Date.now(),
        jobName,
        status: "skipped",
        durationMs: 0,
        summary: "concurrent run guard",
      });
      return;
    }

    // Cron jitter: random delay to spread load across the minute (OpenClaw pattern)
    if (!CRON_JITTER_EXEMPT.has(jobName)) {
      const jitter = Math.floor(Math.random() * CRON_JITTER_MAX_MS);
      await new Promise(r => setTimeout(r, jitter));
      // Re-check concurrent guard after jitter delay (another tick may have started)
      if (runningJobs.has(jobName)) return;
    }

    // Spin loop guard: skip if job fired too recently
    const lastFire = lastFireTimes.get(jobName) || 0;
    if (Date.now() - lastFire < MIN_REFIRE_GAP_MS) {
      warn("cron", `[${jobName}] Spin loop guard: skipping refire (${Date.now() - lastFire}ms since last)`);
      appendRun(jobName, {
        ts: Date.now(),
        jobName,
        status: "skipped",
        durationMs: 0,
        summary: "spin loop guard",
      });
      return;
    }
    lastFireTimes.set(jobName, Date.now());
    runningJobs.add(jobName);

    const startMs = Date.now();

    // Fire cron-before hooks (non-blocking on failure)
    await fireHooks("cron-before", { jobName }).catch(() => {});

    // Resolve the wall-clock timeout for this job
    const timeoutMs = JOB_TIMEOUTS_MS[jobName] ?? JOB_TIMEOUTS_MS["default"];

    try {
      // Race the job against a wall-clock timeout to prevent hung jobs from
      // holding the runningJobs lock indefinitely.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof CRON_TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(CRON_TIMEOUT_SENTINEL), timeoutMs);
      });

      const result = await Promise.race([
        Promise.resolve(fn()).then(() => "ok" as const),
        timeoutPromise,
      ]);

      clearTimeout(timer);

      if (result === CRON_TIMEOUT_SENTINEL) {
        // Job exceeded its wall-clock limit
        const durationMs = Date.now() - startMs;
        const limitSec = Math.round(timeoutMs / 1000);
        logError("cron", `[${jobName}] Wall-clock timeout after ${limitSec}s (limit: ${limitSec}s)`);
        appendRun(jobName, {
          ts: Date.now(),
          jobName,
          status: "timeout",
          durationMs,
          error: `Wall-clock timeout (${limitSec}s limit exceeded)`,
        });

        fireHooks("cron-after", {
          jobName,
          jobStatus: "timeout",
          jobDurationMs: durationMs,
          jobError: `Wall-clock timeout (${limitSec}s)`,
        }).catch(() => {});
      } else {
        const durationMs = Date.now() - startMs;
        appendRun(jobName, {
          ts: Date.now(),
          jobName,
          status: "ok",
          durationMs,
        });

        // Fire cron-after hooks with success context
        fireHooks("cron-after", {
          jobName,
          jobStatus: "ok",
          jobDurationMs: durationMs,
        }).catch(() => {});
      }
    } catch (err) {
      const durationMs = Date.now() - startMs;
      logError("cron", `[${jobName}] onTick crashed: ${err}`);
      appendRun(jobName, {
        ts: Date.now(),
        jobName,
        status: "error",
        durationMs,
        error: String(err).substring(0, 200),
      });

      // Fire cron-after hooks with error context
      fireHooks("cron-after", {
        jobName,
        jobStatus: "error",
        jobDurationMs: durationMs,
        jobError: String(err).substring(0, 200),
      }).catch(() => {});
    } finally {
      // OpenClaw #22413: Always release the concurrent run lock
      runningJobs.delete(jobName);
    }
  };
}

// ============================================================
// CLAUDE CLI HELPERS
// ============================================================

/** Run a Claude Code skill via CLI with optional model selection */
async function runSkill(skill: string, model?: string): Promise<string> {
  try {
    const args = [CLAUDE_PATH, "-p", `/${skill}`, "--output-format", "json"];
    if (model) args.push("--model", model);

    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR,
      env: sanitizedEnv(), // OpenClaw 2.19: don't leak tokens to spawned CLI
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      log(skill, `FAILED (exit ${exitCode}): ${stderr.substring(0, 200)}`);
      return "";
    }

    if (!output) return "";

    try {
      const parsed = JSON.parse(output);
      return (parsed.result ?? parsed.text ?? output).trim();
    } catch {
      return output.trim();
    }
  } catch (error) {
    log(skill, `ERROR: ${error}`);
    return "";
  }
}

/** Send a proactive message to Derek via Telegram Bot API.
 *  Supports optional message_thread_id for topic-based delivery. */
async function sendTelegramMessage(chatId: string, text: string, threadId?: number): Promise<void> {
  if (!BOT_TOKEN || !chatId) return;
  try {
    const payload: Record<string, unknown> = { chat_id: chatId, text };
    if (threadId) payload.message_thread_id = threadId;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    log("telegram", `Failed to send message: ${err}`);
  }
}

// ============================================================
// JOB DEFINITIONS
// ============================================================

const jobs: CronJob[] = [];

// 1. Daily journal creation — 12:01 AM ET
jobs.push(
  CronJob.from({
    cronTime: "1 0 * * *",
    onTick: safeTick("journal", () => {
      const date = today();
      const journalPath = join(MEMORY_DIR, `${date}.md`);

      if (!existsSync(MEMORY_DIR)) {
        mkdirSync(MEMORY_DIR, { recursive: true });
      }

      if (!existsSync(journalPath)) {
        writeFileSync(journalPath, `# Journal — ${date}\n\n`);
        log("journal", `Created ${date}.md`);
      } else {
        log("journal", `${date}.md already exists`);
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 2. Heartbeat — created in startCronJobs() (needs supabase)

// 3. Nightly reflect — 2:00 AM ET (uses Sonnet for medium-complexity analysis)
jobs.push(
  CronJob.from({
    cronTime: "0 2 * * *",
    onTick: safeTick("reflect", async () => {
      log("reflect", "Starting daily reflection...");
      const result = await runSkill("reflect", MODELS.sonnet);
      if (result) {
        log("reflect", `Completed: ${result.substring(0, 100)}`);
        markJobRan("reflect");
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 4. Morning brief — 6:00 AM daily (sonnet)
jobs.push(
  CronJob.from({
    cronTime: "0 6 * * *",
    onTick: safeTick("morning-brief", async () => {
      log("morning-brief", "Generating morning brief...");
      const result = await runSkill("pv-morning-brief", MODELS.sonnet);
      if (result) {
        // Append Atlas system digest (costs, health, errors)
        const digest = buildSystemDigest();

        // Append business pulse from dashboard (financials + pipeline + marketing)
        let businessPulse = "";
        try {
          const pulsePromises: Promise<string>[] = [];
          if (isDashboardReady()) {
            pulsePromises.push(getFinancialPulse().catch(() => ""));
            pulsePromises.push(getPipelinePulse().catch(() => ""));
          }
          if (isGBPReady()) {
            pulsePromises.push(getGBPContext().catch(() => ""));
          }
          if (isGA4Ready()) {
            pulsePromises.push(getGA4Context().catch(() => ""));
          }
          if (pulsePromises.length > 0) {
            const results = await Promise.all(pulsePromises);
            const pulseLines = results.filter(Boolean);
            if (pulseLines.length > 0) businessPulse = pulseLines.join("\n\n");
          }
        } catch (err) {
          warn("morning-brief", `Business pulse failed: ${err}`);
        }

        // Append show-rate reminder digest
        const showRateInfo = getShowRateDigest();

        // Append Night Shift overnight report
        let nightShiftInfo = "";
        try {
          nightShiftInfo = (await getNightShiftReport()) || "";
        } catch (e) { warn("morning-brief", `Night shift report failed: ${e}`); }

        // Append WoW trend analysis
        let trendContext = "";
        try {
          trendContext = await buildTrendContext();
        } catch (e) { warn("morning-brief", `Trend context failed: ${e}`); }

        const fullBrief = [result, businessPulse, showRateInfo, nightShiftInfo, trendContext, digest].filter(Boolean).join("\n\n");
        await sendTelegramMessage(DEREK_CHAT_ID, fullBrief);
        log("morning-brief", "Sent to Derek (with system digest + business pulse + show rate + trends)");
      } else {
        log("morning-brief", "No output generated");
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 5. Content engine — 7:00 AM daily (sonnet)
//    Auto-saves to OneDrive vault + emails to Derek after generation.
jobs.push(
  CronJob.from({
    cronTime: "0 7 * * *",
    onTick: safeTick("content-engine", async () => {
      log("content-engine", "Running content waterfall...");
      const result = await runSkill("pv-content-waterfall", MODELS.sonnet);
      if (result) {
        // Parse pillar/subtopic from the output
        const { pillar, subtopic } = parseWaterfallMeta(result);

        // Run content critic quality gate
        const critic = await critiqueContent(result, "skool");
        const criticBlock = formatCriticReport(critic);
        log("content-engine", criticBlock);

        // Track content generation for engagement analysis
        trackContentGeneration({
          date: today(),
          pillar,
          pillarName: PILLAR_NAMES[pillar] || "Unknown",
          subtopic,
          format: "skool",
          criticScore: critic.overallScore,
          criticPassed: critic.passed,
        });

        // Save to OneDrive vault
        const vaultPath = saveWaterfallToVault(result, pillar);

        // Build email body with critic report prepended
        const criticHeader = critic.passed
          ? `Content Critic: PASSED (${Math.round(critic.overallScore * 100)}%)\n\n`
          : `\u26a0\ufe0f Content Critic flagged issues: ${critic.issues.join("; ")}\n${criticBlock}\n\n`;
        const emailContent = criticHeader + result;

        // Email to Derek (with critic results)
        const subject = `Content Waterfall — Pillar ${pillar}: ${subtopic}`;
        const emailed = !!(await sendEmail("derek@pvmedispa.com", subject, emailContent).catch(() => null));
        if (emailed) {
          log("content-engine", `Emailed waterfall to Derek`);
        }

        // Send Telegram summary (truncated if long)
        const statusLine = [
          vaultPath ? "Saved to OneDrive vault." : "",
          emailed ? "Emailed to derek@pvmedispa.com." : "",
        ].filter(Boolean).join(" ");

        const summary = result.length > 3900
          ? result.substring(0, 3900) + "\n\n(truncated, full output saved to vault and emailed)"
          : result;
        const criticTelegram = critic.passed
          ? `\n\n${criticBlock}`
          : `\n\n\u26a0\ufe0f ${criticBlock}`;
        const telegramMsg = statusLine
          ? `Content Waterfall:\n\n${summary}${criticTelegram}\n\n${statusLine}`
          : `Content Waterfall:\n\n${summary}${criticTelegram}`;
        await sendTelegramMessage(DEREK_CHAT_ID, telegramMsg);
        log("content-engine", `Sent to Derek (vault: ${!!vaultPath}, email: ${emailed})`);
      } else {
        log("content-engine", "No output generated");
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 5b. Overnight content draft — 11:30 PM daily (sonnet)
//     Generates tomorrow's content waterfall as a draft for morning review.
//     Does NOT send to Telegram. Saves to data/content-drafts/ with date prefix.
//     Runs content critic on output.
const CONTENT_DRAFTS_DIR = join(DATA_DIR, "content-drafts");
jobs.push(
  CronJob.from({
    cronTime: "30 23 * * *",
    onTick: safeTick("overnight-content", async () => {
      log("overnight-content", "Generating overnight content draft for tomorrow...");

      // Calculate tomorrow's date
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toLocaleDateString("en-CA", { timeZone: TIMEZONE });

      // Determine tomorrow's pillar rotation
      let nextPillar = 1;
      try {
        const rotationPath = join(MEMORY_DIR, "content-rotation.json");
        if (existsSync(rotationPath)) {
          const rotation = JSON.parse(readFileSync(rotationPath, "utf-8"));
          nextPillar = ((rotation.lastPillar || 0) % 5) + 1;
        }
      } catch (e) { warn("overnight-content", `Failed to read content rotation: ${e}`); }
      const pillarName = PILLAR_NAMES[nextPillar] || "Unknown";
      log("overnight-content", `Tomorrow's pillar: ${nextPillar} (${pillarName})`);

      const result = await runSkill("pv-content-waterfall", MODELS.sonnet);
      if (result) {
        // Run content critic quality gate
        const critic = await critiqueContent(result, "skool");
        const criticBlock = formatCriticReport(critic);
        log("overnight-content", criticBlock);

        // Track overnight content generation for engagement analysis
        const { pillar: overnightPillar, subtopic: overnightSubtopic } = parseWaterfallMeta(result);
        trackContentGeneration({
          date: tomorrowStr,
          pillar: overnightPillar,
          pillarName: PILLAR_NAMES[overnightPillar] || "Unknown",
          subtopic: overnightSubtopic,
          format: "skool",
          criticScore: critic.overallScore,
          criticPassed: critic.passed,
        });

        // Save draft to data/content-drafts/
        if (!existsSync(CONTENT_DRAFTS_DIR)) {
          mkdirSync(CONTENT_DRAFTS_DIR, { recursive: true });
        }
        const draftFilename = `${tomorrowStr}-pillar-${overnightPillar}-draft.md`;
        const criticHeader = critic.passed
          ? `<!-- Content Critic: PASSED (${Math.round(critic.overallScore * 100)}%) -->\n\n`
          : `<!-- Content Critic: FLAGGED (${Math.round(critic.overallScore * 100)}%) — ${critic.issues.join("; ")} -->\n\n`;
        const draftContent = criticHeader + criticBlock + "\n\n---\n\n" + result;
        writeFileSync(join(CONTENT_DRAFTS_DIR, draftFilename), draftContent, "utf-8");
        log("overnight-content", `Saved draft: ${draftFilename} (critic: ${critic.passed ? "PASSED" : "FLAGGED"})`);
      } else {
        log("overnight-content", "No output generated");
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 6. Backup .md files to OneDrive — 4:00 AM ET
jobs.push(
  CronJob.from({
    cronTime: "0 4 * * *",
    onTick: safeTick("backup", () => {
      log("backup", "Backing up personality files to OneDrive...");

      if (!existsSync(BACKUP_DIR)) {
        mkdirSync(BACKUP_DIR, { recursive: true });
      }

      const files = ["SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "CLAUDE.md", "SHIELD.md"];
      let copied = 0;

      for (const file of files) {
        const src = join(PROJECT_DIR, file);
        if (existsSync(src)) {
          copyFileSync(src, join(BACKUP_DIR, file));
          copied++;
        }
      }

      log("backup", `Backed up ${copied}/${files.length} files`);
    }),
    timeZone: TIMEZONE,
  })
);

// 5. Git backup — daily at 5:00 AM ET
jobs.push(
  CronJob.from({
    cronTime: "0 5 * * *",
    onTick: safeTick("git-backup", async () => {
      log("git-backup", "Starting git backup...");

      try {
        const addProc = spawn(
          ["git", "add",
            "src/", "config/", ".claude/", "db/", "setup/",
            "*.md", "package.json", "ecosystem.config.cjs",
            "tsconfig.json",
          ],
          { stdout: "pipe", stderr: "pipe", cwd: PROJECT_DIR, env: sanitizedEnv() }
        );
        await addProc.exited;

        const diffProc = spawn(
          ["git", "diff", "--cached", "--quiet"],
          { stdout: "pipe", stderr: "pipe", cwd: PROJECT_DIR, env: sanitizedEnv() }
        );
        const diffExit = await diffProc.exited;

        if (diffExit === 0) {
          log("git-backup", "No changes to commit");
          return;
        }

        const date = today();
        const commitProc = spawn(
          ["git", "commit", "-m", `Auto-backup ${date}`],
          { stdout: "pipe", stderr: "pipe", cwd: PROJECT_DIR, env: sanitizedEnv() }
        );
        const commitOut = await new Response(commitProc.stdout).text();
        const commitExit = await commitProc.exited;

        if (commitExit !== 0) {
          log("git-backup", `Commit failed (exit ${commitExit})`);
          return;
        }
        log("git-backup", `Committed: ${commitOut.trim().split("\n")[0]}`);

        const pushProc = spawn(
          ["git", "push", "origin", "master"],
          { stdout: "pipe", stderr: "pipe", cwd: PROJECT_DIR, env: sanitizedEnv() }
        );

        const pushTimeout = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 30000)
        );

        const pushResult = await Promise.race([
          pushProc.exited.then((code) => ({ code })),
          pushTimeout,
        ]);

        if (pushResult === "timeout") {
          pushProc.kill();
          log("git-backup", "Push timed out after 30s");
        } else if (pushResult.code !== 0) {
          log("git-backup", `Push failed (exit ${pushResult.code})`);
        } else {
          log("git-backup", "Pushed to origin/master");
        }
      } catch (err) {
        log("git-backup", `ERROR: ${err}`);
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 6. Health state dump — every 15 minutes
jobs.push(
  CronJob.from({
    cronTime: "*/15 * * * *",
    onTick: safeTick("health-dump", () => {
      try {
        if (!existsSync(DATA_DIR)) {
          mkdirSync(DATA_DIR, { recursive: true });
        }

        const healthData = {
          timestamp: new Date().toISOString(),
          metrics: getMetrics(),
          health: getHealthStatus(),
          costs: getTodayClaudeCosts(),
          circuitBreakers: getAllBreakerStats(),
        };

        // Deep-redact before writing to disk to prevent token leakage
        // in error messages, circuit breaker lastError, or metrics metadata.
        atomicWriteFileSync(
          join(DATA_DIR, "health.json"),
          JSON.stringify(redactObject(healthData), null, 2)
        );
      } catch (err) {
        log("health-dump", `ERROR: ${err}`);
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 7. Memory cleanup — 1st of each month at 3:00 AM ET
jobs.push(
  CronJob.from({
    cronTime: "0 3 1 * *",
    onTick: safeTick("cleanup", async () => {
      log("cleanup", "Archiving old journal entries...");

      const archiveDir = join(MEMORY_DIR, "archive");
      if (!existsSync(archiveDir)) {
        mkdirSync(archiveDir, { recursive: true });
      }

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      try {
        const entries = readdirSync(MEMORY_DIR);
        let archived = 0;

        for (const entry of entries) {
          const match = entry.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
          if (!match) continue;

          const entryDate = new Date(match[1] + "T00:00:00");
          if (entryDate < thirtyDaysAgo) {
            const src = join(MEMORY_DIR, entry);
            const dest = join(archiveDir, entry);
            copyFileSync(src, dest);
            unlinkSync(src);
            archived++;
          }
        }

        log("cleanup", `Archived ${archived} journal entries`);

        // Clean up old cron run logs (>30 days)
        const trimmed = cleanupOldRuns();
        if (trimmed > 0) log("cleanup", `Trimmed ${trimmed} old cron run log entries`);

        // Clean up stale show-rate reminder tags from contacts
        const tagsCleaned = await cleanupStaleReminderTags();
        if (tagsCleaned > 0) log("cleanup", `Cleaned ${tagsCleaned} stale reminder tags`);
      } catch (error) {
        log("cleanup", `ERROR: ${error}`);
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 7b. (REMOVED — duplicate of progress-cleanup job at 3:20 AM in maintenance section)

// 8. Weekly todo review — Sunday at 7:00 PM ET
//    Reads MASTER TODO and sends a summary to Derek via Haiku
jobs.push(
  CronJob.from({
    cronTime: "0 19 * * 0",
    onTick: safeTick("todo-review", async () => {
      log("todo-review", "Running weekly todo review...");

      const todoContent = await readTodoFile();
      if (!todoContent) {
        log("todo-review", "No todo file found or empty");
        return;
      }

      const prompt =
        "Review this task list. Summarize briefly for Telegram: " +
        "(1) How many open tasks total, " +
        "(2) What's in TODAY/THIS WEEK that looks stale or overdue, " +
        "(3) Any tasks that could be broken down smaller. " +
        "Be concise.\n\n" +
        todoContent;

      const summary = await runPrompt(prompt, MODELS.haiku);

      if (summary) {
        await sendTelegramMessage(DEREK_CHAT_ID, `Weekly Todo Review:\n\n${summary}`);
        log("todo-review", "Sent review to Derek");
      } else {
        log("todo-review", "No summary generated");
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 8b. Weekly executive summary — Sunday at 6:00 PM
//     Full-funnel report + anomalies + channel scorecards + insights
jobs.push(
  CronJob.from({
    cronTime: "0 18 * * 0",
    onTick: safeTick("weekly-exec", async () => {
      if (!isDashboardReady()) {
        log("weekly-exec", "Dashboard not configured, skipping");
        return;
      }
      log("weekly-exec", "Building weekly executive summary...");
      try {
        const summary = await buildWeeklySummary();
        const formatted = formatWeeklySummary(summary);
        await sendTelegramMessage(DEREK_CHAT_ID, formatted);
        log("weekly-exec", "Sent weekly executive summary to Derek");
      } catch (err) {
        logError("cron", `Weekly executive summary failed: ${err}`);
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 9. Nightly Evolution Pipeline — 11:00 PM MST
//    Multi-phase pipeline: Phase 0 (summarization + graph enrichment) → Phase 1 (scout)
//    + Phase 2 (conversation audit) → Phase 3 (architect) → Phase 4 (implementer)
//    → Phase 5 (validator) → Phase 6 (scorecard + email).
//    Logic lives in src/evolution/. Manually triggerable via /evolve skill.
jobs.push(
  CronJob.from({
    cronTime: "0 23 * * *",
    onTick: safeTick("evolution", async () => {
      log("evolution", "Starting nightly evolution pipeline...");
      try {
        const result = await runEvolutionPipeline(supabase, { manual: false });
        log("evolution", result.message);
      } catch (err) {
        logError("evolution", `Pipeline failed: ${err}`);
        // Fallback to legacy evolution on pipeline failure
        log("evolution", "Falling back to legacy evolution...");
        try {
          const legacyResult = await runEvolution({ manual: false });
          log("evolution", `Legacy fallback: ${legacyResult.message}`);
        } catch (legacyErr) {
          logError("evolution", `Legacy fallback also failed: ${legacyErr}`);
        }
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 10. Conversation summarization — 1:00 AM nightly (needs supabase, added in startCronJobs)

// 11. GHL new lead polling — DISABLED 2026-02-26
// Caused duplicate notifications: webhook (instant) + monitor (5min) + polling (15min)
// all fired independently for the same lead. Webhook is primary, monitor tracks metrics.
// Source tagging is now handled in the webhook edge function.
// jobs.push(
//   CronJob.from({
//     cronTime: "*/15 7-20 * * 1-6",
//     ...
//   })
// );

// 11b. Appointment reminder engine — every 15 minutes during business hours
// Scans upcoming appointments and sends 72h/24h/2h reminders via GHL tags.
// Also handles no-show recovery outreach for missed appointments.
jobs.push(
  CronJob.from({
    cronTime: "*/15 7-20 * * 1-6",
    onTick: safeTick("appointment-reminders", async () => {
      if (isEffectivelyPaused("appointment_reminders")) {
        log("appointment-reminders", "Skipped: patient engagement paused");
        return;
      }
      if (!isGHLReady()) return;
      try {
        const result = await checkAppointmentReminders(supabase);
        const total = result.reminders72h + result.reminders24h +
          result.reminders2h + result.noshowRecoveries;
        if (total > 0) {
          log("appointment-reminders",
            `Sent ${result.reminders72h} confirm, ${result.reminders24h} logistics, ` +
            `${result.reminders2h} nudge, ${result.noshowRecoveries} no-show recovery ` +
            `(${result.errors} errors)`
          );
        }
      } catch (err) {
        logError("show-rate", `Appointment reminder check failed: ${err}`);
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 11c. Scheduled messages — check every minute for due one-off messages
jobs.push(
  CronJob.from({
    cronTime: "* * * * *",
    onTick: safeTick("scheduled-msgs", async () => {
      const sent = await checkScheduledMessages(sendTelegramMessage);
      if (sent > 0) log("scheduled-msgs", `Sent ${sent} scheduled message(s)`);
    }),
    timeZone: TIMEZONE,
  })
);

// 12. (REMOVED — merged into nightly evolution job #9)

// 13. Pharmacy invoice processing — 6 AM daily (2-day lookback catches missed days)
jobs.push(
  CronJob.from({
    cronTime: "0 6 * * *",
    onTick: safeTick("pharmacy-invoices", async () => {
      log("pharmacy-invoices", "Processing pharmacy invoices...");
      const result = await runPharmacyInvoiceProcessor({ lookbackDays: 2 });
      const summary = formatPharmacySummary(result);
      if (summary && summary !== "No new pharmacy invoices to process.") {
        await sendTelegramMessage(DEREK_CHAT_ID, summary);
      }
      markJobRan("pharmacy-invoices");
      log("pharmacy-invoices", `Done: ${result.invoicesProcessed} invoices, ${result.lineItemsTotal} items, $${result.totalAmount.toFixed(2)}`);
    }),
    timeZone: TIMEZONE,
  })
);

// 14. Sunday night content batch — Sunday at 8:00 PM MST
//     Runs Social Pulse (X + Reddit trends), then generates 3 social posts
//     for the upcoming week (Mon/Wed/Fri) with Facebook + X versions.
//     Posts are pushed to Planner as tasks with due dates.
jobs.push(
  CronJob.from({
    cronTime: "0 20 * * 0",
    onTick: safeTick("sunday-content-batch", async () => {
      log("sunday-content-batch", "Running Sunday night content batch...");

      // Step 1: Run Social Pulse to get trending topics
      log("sunday-content-batch", "Step 1: Running Social Pulse...");
      const pulseResult = await runSkill("social-pulse", MODELS.sonnet);
      const pulseFile = pulseResult ? join(DATA_DIR, "social-pulse", `${today()}.md`) : "";
      if (pulseResult) {
        log("sunday-content-batch", `Social Pulse saved to ${pulseFile}`);
      } else {
        log("sunday-content-batch", "Social Pulse returned no output, continuing with default topics");
      }

      // Step 2: Generate 3 posts for the week using content waterfall + pulse data
      log("sunday-content-batch", "Step 2: Generating weekly social content...");
      const pulseContext = pulseResult
        ? `\n\nUse these trending topics from this week's Social Pulse scan to inform your content hooks:\n${pulseResult.substring(0, 2000)}`
        : "";

      const weekPrompt =
        `Generate 3 social media posts for PV MediSpa for next week (Mon/Wed/Fri). ` +
        `Follow the 5-Pillar rotation. Each post needs:\n` +
        `1. Facebook version (150-250 words, hook-story-offer format)\n` +
        `2. X/Twitter version (under 280 chars)\n` +
        `3. Which Pillar it maps to\n` +
        `4. Suggested image concept\n\n` +
        `Format each post clearly with headers: POST 1 (Mon), POST 2 (Wed), POST 3 (Fri).\n` +
        `Under each, include sections: FACEBOOK:, X VERSION:, PILLAR:, IMAGE IDEA:\n` +
        `Apply /humanizer principles (no AI smell, no em dashes, Derek's voice).` +
        pulseContext;

      const contentResult = await runPrompt(weekPrompt, MODELS.sonnet);

      if (contentResult) {
        // Step 3: Send summary to Derek
        const summary = contentResult.length > 3800
          ? contentResult.substring(0, 3800) + "\n\n(truncated — full content in Planner tasks)"
          : contentResult;

        const telegramMsg =
          `**Sunday Content Batch**\n\n` +
          `Social Pulse ran ${pulseResult ? "successfully" : "(no data, used defaults)"}.\n` +
          `3 posts generated for next week.\n\n` +
          `${summary}\n\n` +
          `Posts will be pushed to Planner with due dates. Copy, paste, post, mark done.`;

        await sendTelegramMessage(DEREK_CHAT_ID, telegramMsg);
        log("sunday-content-batch", "Sent weekly content batch to Derek");
      } else {
        log("sunday-content-batch", "Content generation returned no output");
        await sendTelegramMessage(DEREK_CHAT_ID,
          "Sunday content batch ran but content generation failed. I'll retry in the morning brief.");
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 15. Monthly metrics reminder — 3rd of each month at 9:00 AM MST
//     Reminds Derek to export Aesthetic Record data for monthly metrics update.
jobs.push(
  CronJob.from({
    cronTime: "0 9 3 * *",
    onTick: safeTick("metrics-reminder", async () => {
      log("metrics-reminder", "Sending monthly metrics reminder...");
      const msg =
        `**Monthly Metrics Update**\n\n` +
        `Time to update business metrics for last month. I need 3 exports from you (~5 min):\n\n` +
        `1. **Aesthetic Record membership export** - Dashboard > Members > Export CSV\n` +
        `2. **Aesthetic Record churn report** - Dashboard > Cancellations > Export for last month\n` +
        `3. **Pharmacy invoices** - Drop any Partell/Hallandale invoices from last month into Downloads\n\n` +
        `Drop the files and say "update metrics" and I'll calculate everything: active patients, MRR, churn, LTV, margins, month-over-month trends.\n\n` +
        `_See data/metrics-methodology.md for the full procedure._`;
      await sendTelegramMessage(DEREK_CHAT_ID, msg);
      markJobRan("metrics-reminder");
    }),
    timeZone: TIMEZONE,
  })
);

// 16. Meeting check — daily at 6 PM MST, processes new Otter.ai transcripts
jobs.push(
  CronJob.from({
    cronTime: "0 18 * * *",
    onTick: safeTick("meeting-check", async () => {
      log("meeting-check", "Checking for new Otter.ai meeting transcripts...");
      try {
        const { checkNewMeetings, formatMeetingSummaryTelegram } = await import("./meetings.ts");
        const summaries = await checkNewMeetings();
        if (summaries.length === 0) {
          log("meeting-check", "No new meetings to process.");
        } else {
          for (const ms of summaries) {
            const formatted = formatMeetingSummaryTelegram(ms);
            await sendTelegramMessage(DEREK_CHAT_ID, formatted);
          }
          log("meeting-check", `Processed ${summaries.length} new meeting(s).`);
        }
      } catch (err) {
        logError("meeting-check", `Failed: ${err}`);
      }
      markJobRan("meeting-check");
    }),
    timeZone: TIMEZONE,
  })
);

// ============================================================
// START ALL JOBS
// ============================================================

// ============================================================
// WEEKLY TREND CONTEXT (WoW comparison for morning brief)
// ============================================================

async function buildTrendContext(): Promise<string> {
  const lines: string[] = [];

  // Lead volume trends (from data/lead-volume.json)
  try {
    const volumePath = join(DATA_DIR, "lead-volume.json");
    if (existsSync(volumePath)) {
      const volumeLog = JSON.parse(readFileSync(volumePath, "utf-8"));
      if (volumeLog.length >= 7) {
        const lastWeek = volumeLog.slice(-7);
        const thisWeekAvg = lastWeek.reduce((s: number, d: any) => s + d.count, 0) / lastWeek.length;

        // Compare to prior 7 days
        if (volumeLog.length >= 14) {
          const priorWeek = volumeLog.slice(-14, -7);
          const priorAvg = priorWeek.reduce((s: number, d: any) => s + d.count, 0) / priorWeek.length;
          const change = priorAvg > 0 ? Math.round(((thisWeekAvg - priorAvg) / priorAvg) * 100) : 0;
          const arrow = change > 0 ? "up" : change < 0 ? "down" : "flat";
          lines.push(`Leads: ${thisWeekAvg.toFixed(1)}/day avg (${arrow} ${Math.abs(change)}% WoW)`);
        }

        // Top sources this week
        const sourceTotals: Record<string, number> = {};
        for (const day of lastWeek) {
          for (const [src, count] of Object.entries(day.sources || {})) {
            sourceTotals[src] = (sourceTotals[src] || 0) + (count as number);
          }
        }
        const topSources = Object.entries(sourceTotals)
          .sort(([, a], [, b]) => (b as number) - (a as number))
          .slice(0, 3)
          .map(([src, count]) => `${src}: ${count}`)
          .join(", ");
        if (topSources) lines.push(`Top sources (7d): ${topSources}`);
      }
    }
  } catch (e) { warn("trends", `Failed to read lead-volume.json: ${e}`); }

  // Show rate trends (from data/show-rate-state.json daily stats)
  try {
    const showRatePath = join(DATA_DIR, "show-rate-state.json");
    if (existsSync(showRatePath)) {
      const state = JSON.parse(readFileSync(showRatePath, "utf-8"));
      if (state.dailyStats) {
        const days = Object.entries(state.dailyStats).sort(([a], [b]) => b.localeCompare(a)).slice(0, 7);
        if (days.length > 0) {
          const totalReminders = days.reduce((s, [, d]: any) => s + (d.reminders72h || 0) + (d.reminders24h || 0) + (d.reminders2h || 0), 0);
          const totalNoShows = days.reduce((s, [, d]: any) => s + (d.noshowRecoveries || 0), 0);
          if (totalReminders > 0 || totalNoShows > 0) {
            lines.push(`Reminders (7d): ${totalReminders} sent, ${totalNoShows} no-show recoveries`);
          }
        }
      }
    }
  } catch (e) { warn("trends", `Failed to read show-rate-state.json: ${e}`); }

  return lines.length > 0 ? "--- Weekly Trends ---\n" + lines.join("\n") : "";
}

// ============================================================
// SYSTEM DIGEST (appended to morning brief)
// ============================================================

function buildSystemDigest(): string {
  try {
    const healthPath = join(DATA_DIR, "health.json");
    if (!existsSync(healthPath)) return "";

    const raw = readFileSync(healthPath, "utf-8");
    const data = JSON.parse(raw);
    const m = data.metrics;
    const h = data.health;
    const c = data.costs;

    const lines = ["--- Atlas System ---"];

    // Health status
    const status = h?.status === "healthy" ? "OK" : (h?.status || "unknown").toUpperCase();
    lines.push(`Health: ${status}`);

    // Yesterday's usage
    if (m) {
      const avgSec = m.claudeCallCount > 0 ? ((m.totalResponseTimeMs / m.claudeCallCount) / 1000).toFixed(1) : "n/a";
      lines.push(`Messages: ${m.messageCount} | Calls: ${m.claudeCallCount} | Avg: ${avgSec}s`);
      if (m.errorCount > 0) lines.push(`Errors: ${m.errorCount} | Timeouts: ${m.claudeTimeoutCount}`);
    }

    // Cost breakdown
    if (c && c.totalCostUsd > 0) {
      lines.push(`API cost: $${c.totalCostUsd.toFixed(4)} (${c.calls} calls, ${c.inputTokens?.toLocaleString() || 0}in/${c.outputTokens?.toLocaleString() || 0}out)`);
      if (c.byModel) {
        for (const [model, info] of Object.entries(c.byModel) as [string, any][]) {
          lines.push(`  ${model}: ${info.calls} calls, $${info.costUsd.toFixed(4)}`);
        }
      }
    }

    // Issues
    if (h?.issues?.length > 0) {
      lines.push(`Issues: ${h.issues.join(", ")}`);
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

// ============================================================
// MISSED-JOB DETECTION (OpenClaw v2026.2.14 cron resilience)
// ============================================================
// If Atlas was down when a critical job was scheduled, detect and catch up
// on startup. Prevents nightly summarization, morning briefs, etc. from
// being silently skipped after a restart.

const LAST_RUN_FILE = join(DATA_DIR, "cron-last-run.json");

interface CronRunLog {
  [jobName: string]: string; // ISO timestamp of last successful run
}

async function loadCronRunLog(): Promise<CronRunLog> {
  try {
    if (!existsSync(LAST_RUN_FILE)) return {};
    const raw = readFileSync(LAST_RUN_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveCronRunLog(runLog: CronRunLog): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    atomicWriteFileSync(LAST_RUN_FILE, JSON.stringify(runLog, null, 2));
  } catch (err) {
    log("cron", `Failed to save run log: ${err}`);
  }
}

/** Mark a job as having run successfully. */
function markJobRan(jobName: string): void {
  const runLog = JSON.parse(
    existsSync(LAST_RUN_FILE)
      ? readFileSync(LAST_RUN_FILE, "utf-8")
      : "{}"
  );
  runLog[jobName] = new Date().toISOString();
  saveCronRunLog(runLog);
}

/** Check if a job's last run was more than maxAgeMs ago. */
function isJobOverdue(runLog: CronRunLog, jobName: string, maxAgeMs: number): boolean {
  const lastRun = runLog[jobName];
  if (!lastRun) return true; // never ran
  return Date.now() - new Date(lastRun).getTime() > maxAgeMs;
}

export async function startCronJobs(supabaseClient: SupabaseClient | null): Promise<void> {
  // Store in module-level variable so module-scope cron callbacks can access it
  supabase = supabaseClient;

  // Load persisted task state from disk
  await loadTasks();

  // Initialize Supabase task persistence and reconcile with remote state
  initTaskPersistence(supabaseClient);
  if (supabaseClient) {
    try {
      const { abandoned, recovered } = await syncTasksFromSupabase(getLocalTaskIds());
      if (abandoned > 0) {
        log("startup", `Task sync: ${abandoned} stale task(s) marked abandoned in Supabase`);
      }
      if (recovered.length > 0) {
        log("startup", `Task sync: ${recovered.length} orphaned task(s) found (were lost in restart). Marking as failed.`);
        // Mark recovered tasks as failed in Supabase since their processes are gone
        for (const orphan of recovered) {
          const { error: updateErr } = await supabaseClient
            .from("agent_tasks")
            .update({
              status: "failed",
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              metadata: { ...(orphan.metadata || {}), recovery_note: "process_lost_on_restart" },
            })
            .eq("id", orphan.id);
          if (updateErr) {
            warn("startup", `Failed to mark orphan ${orphan.id} as failed: ${updateErr.message}`);
          }
        }
      }
    } catch (err) {
      warn("startup", `Task sync from Supabase failed (non-fatal): ${err}`);
    }
  }

  // Register show-rate digest callback so /ops includes reminder stats
  registerShowRateDigest(getShowRateDigest);
  // Create consolidation job (needs supabase for message access)
  // Note: Summarization is now handled by the evolution pipeline Phase 0 at 11 PM.
  // This 1 AM job runs cognitive consolidation + fallback summarization if needed.
  if (supabase) {
    jobs.push(
      CronJob.from({
        cronTime: "0 1 * * *",
        onTick: safeTick("summarize", async () => {
          log("summarize", "Starting nightly consolidation (fallback summarization if needed)...");

          // Fallback: run old-style summarization for any messages the pipeline missed
          const count = await runSummarization(supabase, async (prompt) => {
            return runPrompt(prompt, MODELS.haiku);
          });
          if (count > 0) {
            log("summarize", `Fallback summarization: ${count} summaries (pipeline may have missed these)`);
          }

          // Cognitive consolidation: contradiction resolution, memory pruning, thread updates
          try {
            const consolidation = await runConsolidation(supabase, async (prompt) => {
              return runPrompt(prompt, MODELS.haiku);
            });
            log("summarize", `Consolidation: ${consolidation.contradictionsResolved} contradictions, ${consolidation.memoriesPruned} pruned, ${consolidation.threadsUpdated} threads updated, ${consolidation.entitiesMerged} entities merged`);
          } catch (err) {
            warn("summarize", `Consolidation failed (non-fatal): ${err}`);
          }

          markJobRan("summarize");
        }),
        timeZone: TIMEZONE,
      })
    );
  }
  // Task supervisor check — every 5 minutes
  jobs.push(
    CronJob.from({
      cronTime: "*/5 * * * *",
      onTick: safeTick("supervisor", async () => {
        const result = await withLock("checkTasks", () => checkTasks());
        if (!result) return; // lock held by another job

        // For completed tasks, generate a conversational summary via Claude
        for (const task of result.completedTasks) {
          if (task.status === "completed" && task.outputPreview) {
            try {
              const prompt =
                `A background task just finished. Summarize what was done and let the user know the output is ready.\n\n` +
                `Task: "${task.description}"\n` +
                `Output file: ${task.outputFile || "none"}\n` +
                `Preview of output:\n${task.outputPreview}\n\n` +
                `Keep it brief (2-3 sentences). Mention the output file so they can review it. Be conversational, not robotic.`;

              const summary = await callClaude(prompt, {
                model: "haiku",
                agentId: "atlas",
                userId: DEREK_CHAT_ID,
                resume: false,
                isolated: true, // don't save session ID back (prevents cron contaminating user session)
                lockBehavior: "skip", // don't block if user is chatting
              });

              if (summary && summary.trim() && !summary.startsWith("Error:") && summary !== "No response generated.") {
                await sendTelegramMessage(DEREK_CHAT_ID, summary);
                await markAnnounced(task.id);
                // Add to conversation ring buffer so Atlas has context
                const key = sessionKey("atlas", DEREK_CHAT_ID);
                await addEntry(key, {
                  role: "assistant",
                  content: summary,
                  timestamp: new Date().toISOString(),
                });
                log("supervisor", `Sent Claude summary for task ${task.id}`);
              } else {
                // Fallback to raw alert
                await sendTelegramMessage(DEREK_CHAT_ID, `[Task Supervisor] Task completed: "${task.description}" — output at ${task.outputFile}`);
                await markAnnounced(task.id);
              }
            } catch (err) {
              warn("supervisor", `Claude summary failed for task ${task.id}: ${err}`);
              try {
                await sendTelegramMessage(DEREK_CHAT_ID, `[Task Supervisor] Task completed: "${task.description}" — output at ${task.outputFile}`);
                await markAnnounced(task.id);
              } catch {
                await incrementAnnounceRetry(task.id);
                warn("supervisor", `Telegram send also failed for task ${task.id}, will retry next tick`);
              }
            }
          } else if (task.status === "failed" || task.status === "timeout") {
            // Failed/timeout tasks: send alert with error detail
            const errorDetail = task.error || task.outputPreview || "no output produced";
            const truncated = errorDetail.substring(0, 300);
            await sendTelegramMessage(
              DEREK_CHAT_ID,
              `[Task Supervisor] Task ${task.status}: "${task.description}" — ${truncated}`
            );
            await markAnnounced(task.id);
          }
        }

        // Send raw alerts for non-completion events (retries, failures, timeouts)
        const summarizedDescriptions = new Set(
          result.completedTasks
            .filter(t => t.status === "completed" && t.outputPreview)
            .map(t => t.description)
        );
        for (const alert of result.alerts) {
          // Skip alerts for tasks that already got a Claude summary
          const alreadySummarized = [...summarizedDescriptions].some(d => alert.includes(`"${d}"`));
          if (alreadySummarized) continue;
          await sendTelegramMessage(DEREK_CHAT_ID, `[Task Supervisor] ${alert}`);
        }

        // Retry delivery for previously unannounced tasks (OpenClaw #18444: max attempts + expiry)
        const MAX_ANNOUNCE_RETRIES = 5;
        const ANNOUNCE_EXPIRY_MS = 60 * 60_000; // 1 hour: stop retrying after this
        const completedTaskIds = new Set(result.completedTasks.map(t => t.id));
        for (const task of result.unannouncedTasks) {
          // Skip tasks we just processed above (they were newly completed this tick)
          if (completedTaskIds.has(task.id)) continue;
          // Suppress announcements for paused automation tasks
          if (shouldSuppressAnnouncement(task)) {
            await markAnnounced(task.id);
            recordSuppressedTask(task.id);
            log("supervisor", `Suppressed announcement for paused-automation task ${task.id}`);
            continue;
          }
          // Skip tasks that have exceeded retry limit
          if (task.announceRetryCount >= MAX_ANNOUNCE_RETRIES) {
            warn("supervisor", `Task ${task.id} exceeded ${MAX_ANNOUNCE_RETRIES} announce retries, giving up`);
            await markAnnounced(task.id); // stop retrying
            continue;
          }
          // Skip tasks that are too old (expiry prevents infinite retry across restarts)
          const completedAt = task.completedAt ? new Date(task.completedAt).getTime() : 0;
          if (completedAt > 0 && Date.now() - completedAt > ANNOUNCE_EXPIRY_MS) {
            warn("supervisor", `Task ${task.id} announce expired (completed ${Math.round((Date.now() - completedAt) / 60000)}m ago), giving up`);
            await markAnnounced(task.id);
            continue;
          }
          try {
            const status = task.status === "completed" ? "completed" : task.status === "failed" ? "failed" : "timed out";
            const detail = task.result || task.error || "";
            const msg = `[Task Supervisor] Task ${status}: "${task.description}"${detail ? ` — ${detail.substring(0, 200)}` : ""}`;
            await sendTelegramMessage(DEREK_CHAT_ID, msg);
            await markAnnounced(task.id);
            log("supervisor", `Retry-announced task ${task.id} (attempt ${task.announceRetryCount + 1})`);
          } catch {
            await incrementAnnounceRetry(task.id);
            warn("supervisor", `Retry announce failed for task ${task.id} (attempt ${task.announceRetryCount})`);
          }
        }

        if (result.alerts.length > 0 || result.unannouncedTasks.length > 0) {
          log("supervisor", `${result.alerts.length} alerts, ${result.completedTasks.length} summaries, ${result.unannouncedTasks.length} unannounced`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // Code Agent Supervisor Worker — every 30 seconds
  // Monitors running code agents, runs pattern detection, shadow evaluation
  // Keeps relay responsive by doing supervision in background
  jobs.push(
    CronJob.from({
      cronTime: "*/30 * * * * *", // Every 30 seconds
      onTick: safeTick("supervisor-worker", async () => {
        const result = await withLock("supervisorWorker", () => runSupervisorWorker());
        if (!result) return; // lock held by another job
        if (result.checked > 0 || result.interventions > 0 || result.completed > 0) {
          log("supervisor-worker", `Checked ${result.checked} agents, ${result.interventions} interventions, ${result.completed} completed`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // Prospective memory: check time-based triggers every minute
  if (supabase) {
    jobs.push(
      CronJob.from({
        cronTime: "* * * * *",
        onTick: safeTick("prospective-memory", async () => {
          const triggered = await checkTimeTriggers(supabase);
          for (const { action } of triggered) {
            await sendTelegramMessage(DEREK_CHAT_ID, `[Reminder] ${action}`);
          }
          if (triggered.length > 0) log("prospective-memory", `Fired ${triggered.length} time trigger(s)`);
        }),
        timeZone: TIMEZONE,
      })
    );
  }

  // Create heartbeat job (needs supabase for memory context)
  jobs.push(
    CronJob.from({
      cronTime: HEARTBEAT_CRON,
      onTick: safeTick("heartbeat", async () => {
        const result = await runHeartbeat(supabase);
        if (result.skipped) {
          log("heartbeat", "Skipped (session busy)");
        } else if (result.shouldNotify && result.message) {
          await sendTelegramMessage(DEREK_CHAT_ID, result.message);
          log("heartbeat", `Notified: ${result.message.substring(0, 100)}`);
        } else {
          log("heartbeat", "OK (suppressed)");
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // 12. GHL webhook health check — daily at 7:05 AM
  if (supabase) {
    jobs.push(
      CronJob.from({
        cronTime: "5 7 * * *",
        onTick: safeTick("ghl-webhook-health", async () => {
          const { count, error } = await supabase
            .from("ghl_events")
            .select("id", { count: "exact", head: true })
            .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString());

          if (!error && (count || 0) === 0) {
            await sendTelegramMessage(
              DEREK_CHAT_ID,
              "GHL webhook health: 0 events in last 24h. Check webhook configuration in GHL Settings."
            );
            log("ghl-webhook-health", "WARNING: No webhook events in 24h");
          } else {
            log("ghl-webhook-health", `OK: ${count} events in last 24h`);
          }
        }),
        timeZone: TIMEZONE,
      })
    );
  }

  // Alert delivery: flush pending alerts every minute
  if (supabase) {
    jobs.push(
      CronJob.from({
        cronTime: "* * * * *",
        onTick: safeTick("alert-deliver", async () => {
          const messages = await deliverAlerts(supabase);
          for (const msg of messages) {
            await sendTelegramMessage(DEREK_CHAT_ID, msg);
          }
          if (messages.length > 0) log("alert-deliver", `Delivered ${messages.length} alert group(s)`);
        }),
        timeZone: TIMEZONE,
      })
    );
  }

  // ============================================================
  // LEAD PIPELINE AUTOMATION (reactivated pipeline + content inbound)
  // ============================================================

  // Lead auto-enrichment: process new OpportunityCreate webhook events
  // and trigger the new-lead-enrich workflow for each new lead.
  // Runs every 10 minutes during business hours. Catches leads from
  // webhook events and auto-drafts personalized outreach.
  if (supabase && isGHLReady()) {
    jobs.push(
      CronJob.from({
        cronTime: "*/10 7-20 * * 1-6",
        onTick: safeTick("lead-enrich", async () => {
          try {
            // Fetch unprocessed OpportunityCreate events from last 2 hours
            const events = await getRecentWebhookEvents(supabase, {
              eventTypes: ["OpportunityCreate"],
              hoursBack: 2,
              limit: 20,
            });

            // Filter to unprocessed events only
            const unprocessed = events.filter((e) => !(e as any).processed);
            if (unprocessed.length === 0) return;

            let enriched = 0;
            const processedIds: string[] = [];

            for (const event of unprocessed) {
              const payload = event.payload as Record<string, any>;
              let contactName =
                payload?.contact_name ||
                payload?.contactName ||
                payload?.full_name ||
                payload?.name ||
                [payload?.first_name, payload?.last_name].filter(Boolean).join(" ") ||
                "";

              // GHL workflow webhooks often omit name fields. Look up via API.
              if (!contactName && event.contact_id) {
                try {
                  const contact = await getContact(event.contact_id);
                  if (contact) {
                    contactName = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.name || "";
                  }
                } catch { /* API lookup failed, continue without name */ }
              }

              if (!contactName) {
                processedIds.push(event.id);
                continue;
              }

              const source = payload?.source || payload?.leadSource || "Unknown";

              // Tag the lead with source for attribution
              if (event.contact_id && source !== "Unknown") {
                const sourceTag = "source:" + source.toLowerCase().replace(/\s+/g, "-");
                await addTagToContact(event.contact_id, sourceTag).catch(() => {});
                await addTagToContact(event.contact_id, "auto-enriched").catch(() => {});
              }

              // Create a follow-up task in GHL so Derek has visibility
              if (event.contact_id) {
                const tomorrow = new Date(Date.now() + 86400_000).toISOString().split("T")[0];
                await createContactTask(event.contact_id, "Review auto-enrichment: " + contactName, {
                  dueDate: tomorrow,
                  description: "Auto-enrichment workflow triggered for new lead from " + source + ". Review the draft outreach and send if appropriate.",
                }).catch(() => {});
              }

              // Trigger the enrichment workflow
              const result = await instantiateWorkflow("new-lead-enrich", {
                lead_name: contactName,
                source,
              });

              if (result) {
                enriched++;
                log("lead-enrich", "Enrichment workflow started for \"" + contactName + "\" (" + source + ")");
              }

              processedIds.push(event.id);
            }

            // Mark events as processed
            if (processedIds.length > 0) {
              await markEventsProcessed(supabase, processedIds);
            }

            if (enriched > 0) {
              await sendTelegramMessage(
                DEREK_CHAT_ID,
                "Lead pipeline: " + enriched + " new lead" + (enriched > 1 ? "s" : "") + " auto-enriched. Outreach drafts incoming."
              );
              log("lead-enrich", enriched + " lead(s) enriched, " + processedIds.length + " events processed");
            }
          } catch (err) {
            logError("cron", "Lead enrichment failed: " + err);
          }
        }),
        timeZone: TIMEZONE,
      })
    );
  }

  // Stale lead reactivation: twice daily (10 AM, 3 PM), scan for leads
  // sitting >7 days in early pipeline stages and trigger re-engagement.
  // Recovers leads that would otherwise be lost to inaction.
  if (isGHLReady()) {
    jobs.push(
      CronJob.from({
        cronTime: "0 10,15 * * 1-5",
        onTick: safeTick("stale-leads", async () => {
          if (isEffectivelyPaused("stale_leads")) {
            log("stale-leads", "Skipped: patient engagement paused");
            return;
          }
          try {
            const allOpen = await getAllOpportunities(PIPELINES.PATIENT_JOURNEY_WEIGHT_LOSS, "open");

            // Find stale leads: open >7 days, in early stages
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            const fourteenDaysAgo = new Date();
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

            const staleLeads = allOpen.filter((o: GHLOpportunity) => {
              const lastActivity = o.lastStageChangeAt || o.dateUpdated || o.dateAdded;
              if (!lastActivity) return false;
              const activityDate = new Date(lastActivity);
              // Stale: inactive 7-14 days (beyond 14 days, they need manual attention)
              return activityDate < sevenDaysAgo && activityDate > fourteenDaysAgo;
            });

            if (staleLeads.length === 0) return;

            // Limit to 3 reactivations per run to avoid overwhelming
            const batch = staleLeads.slice(0, 3);
            let reactivated = 0;

            for (const lead of batch) {
              const name = lead.contact?.name || lead.name || "Unknown";
              if (name === "Unknown") continue;

              const lastActivity = lead.lastStageChangeAt || lead.dateUpdated || lead.dateAdded;
              const daysStale = lastActivity
                ? Math.round((Date.now() - new Date(lastActivity).getTime()) / 86400_000)
                : 7;
              const source = lead.source || "Unknown";

              // Tag for tracking
              if (lead.contact?.id) {
                await addTagToContact(lead.contact.id, "reactivation-attempted").catch(() => {});
              }

              const result = await instantiateWorkflow("stale-lead-reactivate", {
                lead_name: name,
                days_stale: String(daysStale),
                source,
              });

              if (result) {
                reactivated++;
                log("stale-leads", "Reactivation workflow for \"" + name + "\" (" + daysStale + "d stale)");
              }
            }

            if (reactivated > 0) {
              await sendTelegramMessage(
                DEREK_CHAT_ID,
                "Lead pipeline: " + reactivated + " stale lead" + (reactivated > 1 ? "s" : "") + " queued for re-engagement. " +
                staleLeads.length + " total stale (7-14d)."
              );
            }
          } catch (err) {
            logError("cron", "Stale lead reactivation failed: " + err);
          }
        }),
        timeZone: TIMEZONE,
      })
    );
  }

  // Lead volume monitoring: track daily lead counts and alert on drops.
  // Runs at 8 PM daily, compares today's leads vs 7-day average.
  // Early warning system for ad/funnel issues.
  if (supabase && isGHLReady()) {
    jobs.push(
      CronJob.from({
        cronTime: "0 20 * * *",
        onTick: safeTick("lead-volume", async () => {
          try {
            // Get today's leads
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const { leads: todayLeads } = await getNewLeadsSince(todayStart.toISOString());

            // Get 7-day lead count for baseline
            const { leads: weekLeads } = await getNewLeadsSince(
              new Date(Date.now() - 7 * 86400_000).toISOString()
            );
            const dailyAvg = weekLeads.length / 7;

            // Track in a lead volume log for trend analysis
            const volumeEntry = {
              date: today(),
              count: todayLeads.length,
              weekAvg: Math.round(dailyAvg * 10) / 10,
              sources: {} as Record<string, number>,
            };

            // Attribution: count leads by source
            for (const lead of todayLeads) {
              const src = lead.source || "Unknown";
              volumeEntry.sources[src] = (volumeEntry.sources[src] || 0) + 1;
            }

            // Persist lead volume data
            const volumePath = join(DATA_DIR, "lead-volume.json");
            let volumeLog: any[] = [];
            try {
              if (existsSync(volumePath)) {
                volumeLog = JSON.parse(readFileSync(volumePath, "utf-8"));
              }
            } catch (e) { warn("lead-volume", `Failed to parse lead-volume.json: ${e}`); }
            volumeLog.push(volumeEntry);
            // Keep last 90 days
            if (volumeLog.length > 90) volumeLog = volumeLog.slice(-90);
            atomicWriteFileSync(volumePath, JSON.stringify(volumeLog, null, 2));

            // Alert on significant drops (>40% below average, with minimum threshold)
            if (dailyAvg >= 1 && todayLeads.length < dailyAvg * 0.6) {
              await emitAlert(supabase, {
                source: "lead-pipeline",
                severity: "warning",
                category: "Pipeline",
                message: "Lead volume drop: " + todayLeads.length + " today vs " + dailyAvg.toFixed(1) + " daily avg (7d). Check ads/landing page.",
                metadata: { todayCount: todayLeads.length, dailyAvg, sources: volumeEntry.sources },
              });
            }

            // Alert on zero leads on a business day (Mon-Sat)
            const dayOfWeek = new Date().getDay();
            if (todayLeads.length === 0 && dayOfWeek >= 1 && dayOfWeek <= 6) {
              await emitAlert(supabase, {
                source: "lead-pipeline",
                severity: "critical",
                category: "Pipeline",
                message: "Zero leads today. Check ad campaigns, landing page, and GHL webhook health.",
              });
            }

            // Source attribution summary
            const srcSummary = Object.entries(volumeEntry.sources)
              .sort(([, a], [, b]) => (b as number) - (a as number))
              .map(([src, count]) => src + ": " + count)
              .join(", ");

            log("lead-volume", "Today: " + todayLeads.length + " leads (avg: " + dailyAvg.toFixed(1) + "). Sources: " + (srcSummary || "none"));
          } catch (err) {
            logError("cron", "Lead volume monitoring failed: " + err);
          }
        }),
        timeZone: TIMEZONE,
      })
    );
  }

  // Daily business scorecard: 9:15 PM daily
  // Snapshots funnel + pipeline metrics to Supabase business_scorecard table.
  // Runs after ad-tracker (9 PM) so Meta data is fresh.
  if (supabase) {
    jobs.push(
      CronJob.from({
        cronTime: "15 21 * * *",
        onTick: safeTick("daily-scorecard", async () => {
          try {
            const result = await captureDailyScorecard(supabase!);
            if (result) {
              log("daily-scorecard", `Captured: ${result.leads} leads, $${result.ad_spend} spend, ${result.show_rate}% show`);
            } else {
              warn("daily-scorecard", "Capture returned null (Supabase write may have failed)");
            }
          } catch (err) {
            logError("cron", `Daily scorecard capture failed: ${err}`);
          }
        }),
        timeZone: TIMEZONE,
      })
    );
  }

  // Ad creative performance tracker: 9 PM daily
  // Pulls per-ad insights from Meta, records snapshots, runs analysis.
  // Only runs if Meta API is configured.
  {
    const { isMetaReady, getTopAds } = await import("./meta.ts");
    if (isMetaReady()) {
      jobs.push(
        CronJob.from({
          cronTime: "0 21 * * *",
          onTick: safeTick("ad-tracker", async () => {
            try {
              const todayStr = today();
              const ads = await getTopAds("today", 100);
              if (ads.length === 0) {
                log("ad-tracker", "No ad data for today, skipping snapshot");
                return;
              }

              const snapshots = insightsToSnapshots(ads, todayStr);
              recordAdSnapshots(snapshots);
              log("ad-tracker", `Recorded ${snapshots.length} ad snapshots for ${todayStr}`);

              // Run 7-day analysis
              const recommendations = analyzeAdPerformance(7);
              if (recommendations.length > 0) {
                const summary = recommendations
                  .slice(0, 5)
                  .map(r => `[${r.type.toUpperCase()}] ${r.adName}: ${r.reason}`)
                  .join("\n");
                log("ad-tracker", `${recommendations.length} recommendation(s):\n${summary}`);
              }
            } catch (err) {
              logError("cron", `Ad tracker snapshot failed: ${err}`);
            }
          }),
          timeZone: TIMEZONE,
        })
      );
    }
  }

  // ============================================================
  // MIDAS MARKETING INTELLIGENCE: Daily + Weekly jobs
  // ============================================================

  // Midas Funnel Monitor: 9 AM daily
  // Builds yesterday's funnel snapshot, compares against 7-day avg, alerts on drops.
  jobs.push(
    CronJob.from({
      cronTime: "0 9 * * *",
      onTick: safeTick("midas-funnel", async () => {
        try {
          const yesterday = new Date(Date.now() - 86400_000);
          const dateStr = yesterday.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
          const snapshot = buildFunnelSnapshot(dateStr);
          if (!snapshot) {
            log("midas-funnel", `No funnel data for ${dateStr}, skipping`);
            return;
          }

          const alerts = checkFunnelHealth(snapshot);
          log("midas-funnel", `Funnel snapshot ${dateStr}: ${snapshot.impressions} imp, ${snapshot.clicks} clicks, ${snapshot.leadsCreated} leads, ${snapshot.consultationsShowed} showed`);

          if (alerts.length > 0) {
            const msg = formatFunnelAlerts(alerts);
            await sendTelegramMessage(DEREK_CHAT_ID, msg);
            log("midas-funnel", `${alerts.length} funnel alert(s) sent to Derek`);
          }
        } catch (err) {
          logError("cron", `Midas funnel monitor failed: ${err}`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // Midas Ad Digest: 9:30 PM daily (30 min after ad-tracker collects data)
  // Adds Midas analysis lens on top of raw ad-tracker data.
  jobs.push(
    CronJob.from({
      cronTime: "30 21 * * *",
      onTick: safeTick("midas-digest", async () => {
        try {
          const { entries, summary } = buildAdDigest();
          if (entries.length === 0) {
            log("midas-digest", "No ad data for digest");
            return;
          }

          log("midas-digest", `Built digest: ${entries.length} ads analyzed`);

          // Only alert Derek if there are actionable items
          const adsWithAlerts = entries.filter(e => e.alerts.length > 0);
          const declining = entries.filter(e => e.trend === "declining");
          if (adsWithAlerts.length > 0 || declining.length > 0) {
            await sendTelegramMessage(DEREK_CHAT_ID, summary);
          }
        } catch (err) {
          logError("cron", `Midas ad digest failed: ${err}`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // Midas Weekly Attribution: Sunday 9 AM
  // Stitches full funnel: Meta spend → leads → booked → showed → patient → revenue → ROAS
  jobs.push(
    CronJob.from({
      cronTime: "0 9 * * 0", // Sunday 9 AM
      onTick: safeTick("midas-attribution", async () => {
        try {
          log("midas-attribution", "Building weekly attribution report...");
          const { report, rows } = await buildWeeklyAttribution();
          const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
          const totalLeads = rows.reduce((s, r) => s + r.leads, 0);

          // Send condensed version to Telegram
          const telegramMsg = formatAttributionTelegram(rows, totalSpend, totalLeads);
          await sendTelegramMessage(DEREK_CHAT_ID, telegramMsg);
          log("midas-attribution", `Attribution report sent: $${totalSpend.toFixed(0)} spend, ${totalLeads} leads, ${rows.length} sources`);
        } catch (err) {
          logError("cron", `Midas attribution failed: ${err}`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // Midas Content Hooks Memo: Tues/Fri 7 AM
  // Generates 3 content hook ideas based on trends. Opus for strategic depth.
  jobs.push(
    CronJob.from({
      cronTime: "0 7 * * 2,5", // Tuesday and Friday at 7 AM
      onTick: safeTick("midas-hooks", async () => {
        try {
          log("midas-hooks", "Building content hooks memo...");
          const result = await buildContentHooksMemo();
          if (result) {
            // Send a brief notification (not the full memo)
            await sendTelegramMessage(DEREK_CHAT_ID, `**Midas Content Hooks** ready.\nSee memory/marketing/content-hooks/ for 3 new hook ideas.`);
            log("midas-hooks", "Content hooks memo complete");
          }
        } catch (err) {
          logError("cron", `Midas content hooks failed: ${err}`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // Midas Competitor Recon: Wednesday 8 AM
  // Weekly competitor analysis from watchlist. Opus for strategic depth.
  jobs.push(
    CronJob.from({
      cronTime: "0 8 * * 3", // Wednesday 8 AM
      onTick: safeTick("midas-recon", async () => {
        try {
          log("midas-recon", "Running competitor recon...");
          const result = await runCompetitorRecon();
          if (result) {
            // Send brief summary
            const firstLine = result.split("\n").find(l => l.trim().length > 10) || "Analysis complete";
            await sendTelegramMessage(DEREK_CHAT_ID, `**Midas Competitor Recon** ready.\n${firstLine.slice(0, 200)}\nFull report: memory/marketing/competitors/`);
            log("midas-recon", "Competitor recon complete");
          }
        } catch (err) {
          logError("cron", `Midas competitor recon failed: ${err}`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // Midas GBP Content Draft: Mon/Thu 7:30 AM
  // Drafts GBP posts from waterfall content. Sonnet (drafting, not analysis).
  // Requires approval before posting (GBP write scope not yet available).
  jobs.push(
    CronJob.from({
      cronTime: "30 7 * * 1,4", // Monday and Thursday at 7:30 AM
      onTick: safeTick("midas-gbp", async () => {
        try {
          log("midas-gbp", "Drafting GBP post...");
          const result = await draftGBPPost();
          if (result) {
            await sendTelegramMessage(DEREK_CHAT_ID, `**Midas GBP Draft** ready for review.\n\n${result.slice(0, 500)}\n\n_Saved to data/content-drafts/. Reply to approve._`);
            log("midas-gbp", "GBP draft complete");
          }
        } catch (err) {
          logError("cron", `Midas GBP draft failed: ${err}`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // Midas Monthly Strategic Brief: 1st of month at 10 AM
  // The capstone: full creative audit, funnel analysis, next month's plan.
  // Opus, big prompt, 10 min timeout.
  jobs.push(
    CronJob.from({
      cronTime: "0 10 1 * *", // 1st of month at 10 AM
      onTick: safeTick("midas-monthly", async () => {
        try {
          log("midas-monthly", "Building monthly marketing strategic brief...");
          const result = await buildMonthlyBrief();
          if (result) {
            // Send condensed version to Telegram
            const execSummary = result.match(/### 1\. Executive Summary[\s\S]*?(?=### 2\.)/);
            const summary = execSummary ? execSummary[0].slice(0, 600) : result.slice(0, 400);
            await sendTelegramMessage(DEREK_CHAT_ID, `**Midas Monthly Brief** ready.\n\n${summary}\n\n_Full brief: memory/marketing/attribution/_`);
            log("midas-monthly", "Monthly brief complete");
          }
        } catch (err) {
          logError("cron", `Midas monthly brief failed: ${err}`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // Anomaly scan: check for anomalies every 15 minutes during business hours
  // NOTE: Being absorbed by proactive monitoring system (monitor.ts) over time.
  // Keep as fallback until monitor checks prove stable.
  if (supabase && isDashboardReady()) {
    jobs.push(
      CronJob.from({
        cronTime: "*/15 7-22 * * *",
        onTick: safeTick("anomaly-scan", async () => {
          try {
            const anomalies = await detectAllAnomalies();
            for (const anomaly of anomalies) {
              await emitAlert(supabase, {
                source: "anomaly",
                severity: anomaly.severity === "critical" ? "critical" : anomaly.severity === "warning" ? "warning" : "info",
                category: anomaly.category || "general",
                message: anomaly.message,
                metadata: { originalSeverity: anomaly.severity },
              });
            }
            if (anomalies.length > 0) log("anomaly-scan", `Emitted ${anomalies.length} anomaly alert(s)`);
          } catch (err) {
            warn("anomaly-scan", `Anomaly detection failed: ${err}`);
          }
        }),
        timeZone: TIMEZONE,
      })
    );
  }

  // ============================================================
  // PROACTIVE MONITORING ENGINE (fast/medium/slow tiers)
  // ============================================================
  if (supabase) {
    const { runMonitorTick } = await import("./monitor.ts");
    const { MONITOR_ENABLED } = await import("./constants.ts");

    if (MONITOR_ENABLED) {
      // Fast tier: every 5 min during business hours (new leads, reviews, urgent email)
      jobs.push(
        CronJob.from({
          cronTime: "*/5 7-22 * * *",
          onTick: safeTick("monitor-fast", async () => {
            const result = await runMonitorTick(supabase, "fast");
            if (result.alertsEmitted > 0) log("monitor-fast", `${result.checksRun} checks, ${result.alertsEmitted} alerts`);
          }),
          timeZone: TIMEZONE,
        })
      );

      // Medium tier: every 15 min during business hours (ads, pipeline, speed-to-lead)
      jobs.push(
        CronJob.from({
          cronTime: "*/15 7-22 * * *",
          onTick: safeTick("monitor-medium", async () => {
            const result = await runMonitorTick(supabase, "medium");
            if (result.alertsEmitted > 0) log("monitor-medium", `${result.checksRun} checks, ${result.alertsEmitted} alerts`);
          }),
          timeZone: TIMEZONE,
        })
      );

      // Slow tier: every hour (financials, traffic, conversion, review health)
      jobs.push(
        CronJob.from({
          cronTime: "0 * * * *",
          onTick: safeTick("monitor-slow", async () => {
            const result = await runMonitorTick(supabase, "slow");
            if (result.alertsEmitted > 0) log("monitor-slow", `${result.checksRun} checks, ${result.alertsEmitted} alerts`);
          }),
          timeZone: TIMEZONE,
        })
      );

      // Daily tier: 6 AM (morning calendar pre-load)
      jobs.push(
        CronJob.from({
          cronTime: "0 6 * * *",
          onTick: safeTick("monitor-daily", async () => {
            const result = await runMonitorTick(supabase, "daily");
            log("monitor-daily", `${result.checksRun} checks, ${result.alertsEmitted} alerts`);
          }),
          timeZone: TIMEZONE,
        })
      );

      // Metric snapshot cleanup: daily at 3:30 AM (remove >90 day snapshots)
      jobs.push(
        CronJob.from({
          cronTime: "30 3 * * *",
          onTick: safeTick("metric-cleanup", async () => {
            const { data } = await supabase.rpc("cleanup_old_metric_snapshots");
            if (data > 0) log("metric-cleanup", `Cleaned up ${data} old metric snapshots`);
          }),
          timeZone: TIMEZONE,
        })
      );
    }
  }

  // ============================================================
  // OBSERVATION REFLECTOR (30 min schedule)
  // ============================================================
  if (supabase) {
    const { runReflector } = await import("./observations.ts");
    jobs.push(
      CronJob.from({
        cronTime: "*/30 7-22 * * *",
        onTick: safeTick("observation-reflector", async () => {
          const count = await runReflector(supabase, (p: string) => runPrompt(p, MODELS.haiku));
          if (count > 0) log("observation-reflector", `Generated ${count} insight(s)`);
        }),
        timeZone: TIMEZONE,
      })
    );
  }

  // ============================================================
  // TOX TRAY BUSINESS OPERATOR JOBS
  // ============================================================

  const TOX_THREAD_ID = process.env.TOX_TRAY_THREAD_ID ? parseInt(process.env.TOX_TRAY_THREAD_ID, 10) : undefined;

  // Tox tray: post approved content (every 30 min, 8 AM - 8 PM)
  if (supabase) {
    const { getReadyToPost, markPosted, markFailed, sendPostConfirmation } = await import("./approval.ts");
    const { publishPost } = await import("./social.ts");

    jobs.push(
      CronJob.from({
        cronTime: "*/30 8-20 * * *",
        onTick: safeTick("tox-post", async () => {
          const items = await getReadyToPost();
          if (items.length === 0) return;

          log("tox-post", `${items.length} item(s) ready to post`);
          for (const item of items) {
            try {
              const result = await publishPost({
                platform: item.platform as "pinterest" | "instagram" | "facebook" | "tiktok",
                content: item.body,
                title: item.title || undefined,
                imageUrl: item.image_url || undefined,
                link: item.link_url || undefined,
                hashtags: item.hashtags || [],
              });
              await markPosted(item.id, result.externalId);
              await sendPostConfirmation(item.id, item.platform, result.url);
              log("tox-post", `Posted #${item.id} to ${item.platform}: ${result.externalId}`);
            } catch (err) {
              await markFailed(item.id, String(err).substring(0, 500));
              logError("tox-post", `Failed to post #${item.id}: ${err}`);
            }
          }
        }),
        timeZone: TIMEZONE,
      })
    );

    // Tox tray: collect social analytics (11 PM daily)
    jobs.push(
      CronJob.from({
        cronTime: "0 23 * * *",
        onTick: safeTick("tox-analytics", async () => {
          const { getPostAnalytics } = await import("./social.ts");
          log("tox-analytics", "Collecting social analytics...");

          // Get all posted items from content_queue
          const { data: posted } = await supabase
            .from("content_queue")
            .select("id, platform, external_id")
            .eq("business", "tox_tray")
            .eq("status", "posted")
            .not("external_id", "is", null)
            .order("posted_at", { ascending: false })
            .limit(50);

          if (!posted || posted.length === 0) {
            log("tox-analytics", "No posted items to collect analytics for");
            return;
          }

          let collected = 0;
          for (const item of posted) {
            try {
              const analytics = await getPostAnalytics(item.platform, item.external_id);
              await supabase.from("social_analytics").insert({
                business: "tox_tray",
                platform: item.platform,
                post_external_id: item.external_id,
                content_queue_id: item.id,
                impressions: analytics.impressions,
                reach: analytics.reach,
                engagement: analytics.engagement,
                clicks: analytics.clicks,
                saves: analytics.saves,
              });
              collected++;
            } catch (err) {
              warn("tox-analytics", `Failed for ${item.platform}/${item.external_id}: ${err}`);
            }
          }

          log("tox-analytics", `Collected analytics for ${collected}/${posted.length} posts`);
        }),
        timeZone: TIMEZONE,
      })
    );

    // Tox tray: weekly digest (Sunday 5 PM)
    jobs.push(
      CronJob.from({
        cronTime: "0 17 * * 0",
        onTick: safeTick("tox-weekly", async () => {
          log("tox-weekly", "Generating weekly tox tray digest...");

          // Get this week's stats
          const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

          const { data: weekPosts } = await supabase
            .from("content_queue")
            .select("platform, status")
            .eq("business", "tox_tray")
            .gte("created_at", weekAgo);

          const { data: weekAnalytics } = await supabase
            .from("social_analytics")
            .select("impressions, reach, engagement, clicks, saves")
            .eq("business", "tox_tray")
            .gte("snapshot_at", weekAgo);

          const posted = (weekPosts || []).filter((p) => p.status === "posted").length;
          const pending = (weekPosts || []).filter((p) => p.status === "pending_approval").length;

          const totalImpressions = (weekAnalytics || []).reduce((s, a) => s + (a.impressions || 0), 0);
          const totalEngagement = (weekAnalytics || []).reduce((s, a) => s + (a.engagement || 0), 0);
          const totalClicks = (weekAnalytics || []).reduce((s, a) => s + (a.clicks || 0), 0);

          const digest = [
            "Tox Tray Weekly Digest",
            "",
            `Posts: ${posted} published, ${pending} pending`,
            `Impressions: ${totalImpressions.toLocaleString()}`,
            `Engagement: ${totalEngagement.toLocaleString()}`,
            `Clicks: ${totalClicks.toLocaleString()}`,
          ].join("\n");

          await sendTelegramMessage(DEREK_CHAT_ID, digest, TOX_THREAD_ID);
          log("tox-weekly", "Weekly digest sent");
        }),
        timeZone: TIMEZONE,
      })
    );
  }

  // Tox tray: Etsy listing sync (6 AM daily, only if Etsy is configured)
  {
    const { isEtsyReady, syncListingsToCache } = await import("./etsy.ts");
    if (isEtsyReady()) {
      jobs.push(
        CronJob.from({
          cronTime: "0 6 * * *",
          onTick: safeTick("etsy-sync", async () => {
            log("etsy-sync", "Syncing Etsy listings...");
            const count = await syncListingsToCache();
            log("etsy-sync", `Synced ${count} listings`);
          }),
          timeZone: TIMEZONE,
        })
      );
    }
  }

  // ============================================================
  // NIGHT SHIFT: Autonomous overnight work (planner + worker)
  // ============================================================

  // Night Shift Planner — 10:00 PM nightly
  // Haiku reviews the day's activity and generates a prioritized overnight work queue
  jobs.push(
    CronJob.from({
      cronTime: "0 22 * * *",
      onTick: safeTick("night-shift-plan", async () => {
        log("night-shift-plan", "Running Night Shift planner...");
        const queue = await runNightShiftPlanner();
        log("night-shift-plan", `Planned ${queue.tasks.length} overnight tasks`);
        if (queue.tasks.length > 0) {
          const taskList = queue.tasks.map((t) => `  - [${t.priority}] ${t.title} (${t.type}, ~$${t.estimatedCost})`).join("\n");
          await sendTelegramMessage(
            DEREK_CHAT_ID,
            `Night shift planned ${queue.tasks.length} task${queue.tasks.length > 1 ? "s" : ""} for tonight:\n${taskList}\n\nWorker starts at 10:15 PM.`
          );
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // Night Shift Worker — 10:15 PM nightly
  // Processes the queue with budget caps and diminishing returns detection
  jobs.push(
    CronJob.from({
      cronTime: "15 22 * * *",
      onTick: safeTick("night-shift-work", async () => {
        log("night-shift-work", "Night Shift worker starting...");
        const result = await runNightShiftWorker();
        if (result.completed > 0 || result.failed > 0) {
          await sendTelegramMessage(
            DEREK_CHAT_ID,
            `Night shift done: ${result.completed} completed, ${result.failed} failed, ${result.skipped} skipped. $${result.totalSpent.toFixed(2)} spent.\n` +
            (result.highlights.length > 0 ? `Highlights: ${result.highlights.join(", ")}` : "")
          );
        }
        log("night-shift-work", `Worker done: ${result.completed}/${result.completed + result.failed + result.skipped} tasks`);
      }),
      timeZone: TIMEZONE,
    })
  );

  // ============================================================
  // STRATEGIC WEEKLY MEMO: Saturday 9 PM
  // ============================================================

  jobs.push(
    CronJob.from({
      cronTime: "0 21 * * 6", // Saturday 9 PM
      onTick: safeTick("strategic-memo", async () => {
        log("strategic-memo", "Generating weekly strategic memo...");
        const memo = await runStrategicMemo();
        if (memo) {
          // Send a trimmed version to Telegram (full version saved to file)
          const telegramVersion = memo.length > 3500 ? memo.slice(0, 3500) + "\n\n_(full memo saved to data/task-output/)_" : memo;
          await sendTelegramMessage(DEREK_CHAT_ID, `**Weekly Strategic Memo**\n\n${telegramVersion}`);
          log("strategic-memo", "Memo sent to Telegram and saved to file");
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  // ============================================================
  // MAINTENANCE: Codex decay, progress note cleanup, event cleanup
  // ============================================================

  // 3:15 AM — cleanup stale codex entries, progress notes, and event logs
  jobs.push(
    CronJob.from({
      cronTime: "15 3 * * *",
      onTick: safeTick("codex-decay", async () => {
        const { decayed, removed } = await decayStaleEntries(30);
        if (decayed > 0 || removed > 0) {
          log("codex-decay", `Codex maintenance: ${decayed} decayed, ${removed} removed`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  jobs.push(
    CronJob.from({
      cronTime: "20 3 * * *",
      onTick: safeTick("progress-cleanup", async () => {
        const count = await cleanupOldNotes(7);
        if (count > 0) log("progress-cleanup", `Cleaned ${count} old progress note files`);
      }),
      timeZone: TIMEZONE,
    })
  );

  jobs.push(
    CronJob.from({
      cronTime: "25 3 * * *",
      onTick: safeTick("event-cleanup", async () => {
        const count = await cleanupOldEvents(14);
        if (count > 0) log("event-cleanup", `Cleaned ${count} old agent event log files`);
      }),
      timeZone: TIMEZONE,
    })
  );

  // 3:35 AM — Ingest yesterday's journal into Supabase for semantic search.
  // Journals exist as markdown files in memory/ but are invisible to Atlas
  // unless explicitly read via tool calls. Ingesting makes them searchable
  // via the same hybrid search that powers conversation recall.
  jobs.push(
    CronJob.from({
      cronTime: "35 3 * * *",
      onTick: safeTick("journal-ingest", async () => {
        if (!supabase) return;
        // Ingest yesterday's journal (today's is still being written)
        const yesterday = new Date(Date.now() - 86400_000);
        const dateStr = yesterday.toLocaleDateString("en-CA", { timeZone: TIMEZONE }); // YYYY-MM-DD
        const journalPath = join(MEMORY_DIR, `${dateStr}.md`);
        if (!existsSync(journalPath)) return;

        const content = readFileSync(journalPath, "utf-8");
        if (!content || content.trim().length < 50) return; // skip empty/stub journals

        // Check state file to avoid re-ingesting
        const statePath = join(PROJECT_DIR, "data", "journal-ingest-state.json");
        let ingested: string[] = [];
        try {
          ingested = JSON.parse(readFileSync(statePath, "utf-8"));
        } catch { /* first run */ }

        if (ingested.includes(dateStr)) return;

        const result = await ingestDocument(supabase, content, {
          source: "journal",
          sourcePath: journalPath,
          title: `Daily Journal — ${dateStr}`,
          metadata: { type: "journal", date: dateStr },
        });

        if (!result.error) {
          ingested.push(dateStr);
          // Keep only last 90 days in state
          if (ingested.length > 90) ingested = ingested.slice(-90);
          writeFileSync(statePath, JSON.stringify(ingested));
          log("journal-ingest", `Ingested journal ${dateStr}: ${result.chunks_created} chunks`);
        } else {
          warn("journal-ingest", `Failed to ingest ${dateStr}: ${result.error}`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

  for (const job of jobs) {
    job.start();
  }
  console.log(`[cron] Started ${jobs.length} scheduled jobs (timezone: ${TIMEZONE})`);
  console.log("[cron] Schedule:");
  console.log("  - 12:01 AM     Daily journal creation");
  console.log(`  - ${HEARTBEAT_CRON}  Heartbeat (sonnet, in-session, active hours)`);
  console.log("  - 2:00 AM      Nightly reflection (sonnet)");
  console.log("  - 4:00 AM      Backup .md files to OneDrive");
  console.log("  - 5:00 AM      Git backup to GitHub");
  console.log("  - 6:00 AM      Morning brief (sonnet)");
  console.log("  - 7:00 AM      Content waterfall (sonnet)");
  console.log("  - Every 15min  Health state dump");
  console.log("  - 3:00 AM      Monthly memory cleanup (1st of month)");
  console.log("  - Sunday 6 PM  Weekly executive summary");
  console.log("  - Sunday 7 PM  Weekly todo review (haiku)");
  console.log("  - 11:00 PM     Nightly evolution pipeline (scout+audit+architect+implementer+validator)");
  console.log("  - 1:00 AM      Cognitive consolidation + fallback summarization (haiku)");
  console.log("  - Every 5min   Task supervisor check");
  console.log("  - Every 1min   Scheduled message delivery");
  console.log("  - Every 1min   Prospective memory time triggers");
  console.log("  - 7:05 AM      GHL webhook health check");
  console.log("  - Every 15min  Appointment reminders (72h/24h/2h + no-show recovery)");
  console.log("  - Every 1min   Alert delivery pipeline");
  console.log("  - Every 10min  Lead auto-enrichment (business hours)");
  console.log("  - 10AM/3PM     Stale lead reactivation (weekdays)");
  console.log("  - 8:00 PM      Lead volume monitoring + attribution");
  console.log("  - 9:00 PM      Ad creative performance tracker (daily snapshots + analysis)");
  console.log("  - Every 15min  Anomaly scan (business hours)");
  console.log("  - Every 5min   Monitor: fast tier (leads, reviews, urgent email)");
  console.log("  - Every 15min  Monitor: medium tier (ads, pipeline, speed-to-lead)");
  console.log("  - Every 1hr    Monitor: slow tier (financials, traffic, conversions)");
  console.log("  - 6:00 AM      Monitor: daily tier (morning calendar pre-load)");
  console.log("  - 3:30 AM      Metric snapshot cleanup (>90 day retention)");
  console.log("  - Every 30min  Observation reflector (business hours)");
  console.log("  - 6:00 AM      Pharmacy invoice processing (daily, 2-day lookback)");
  console.log("  - */30 8-20    Tox tray: post approved content");
  console.log("  - 11:00 PM     Tox tray: collect social analytics");
  console.log("  - Sunday 5 PM  Tox tray: weekly digest");
  console.log("  - 6:00 AM      Tox tray: Etsy listing sync (if configured)");
  console.log("  - 11:30 PM     Overnight content draft (sonnet + content critic)");
  console.log("  - 10:00 PM     Night Shift planner (haiku, generates overnight work queue)");
  console.log("  - 10:15 PM     Night Shift worker (processes queue, budget-capped)");
  console.log("  - Saturday 9PM Weekly strategic memo (sonnet)");
  console.log("  - 3:15 AM      Codex decay (prune stale lessons)");
  console.log("  - 3:20 AM      Progress notes cleanup (7-day retention)");
  console.log("  - 3:25 AM      Agent event log cleanup (14-day retention)");
  console.log("  - 3:35 AM      Journal ingestion (yesterday's journal -> searchable)");
  console.log("  - 9:00 AM      Midas: funnel conversion monitor (daily)");
  console.log("  - 9:30 PM      Midas: ad performance digest (daily, after ad-tracker)");
  console.log("  - Sunday 9 AM  Midas: weekly full-funnel attribution report");
  console.log("  - Tue/Fri 7AM  Midas: content hooks memo (opus)");
  console.log("  - Wed 8 AM     Midas: competitor recon (opus)");
  console.log("  - Mon/Thu 7:30 Midas: GBP content draft (sonnet, requires approval)");
  console.log("  - 1st 10 AM    Midas: monthly strategic brief (opus)");

  // ---- Missed-job catch-up (OpenClaw v2026.2.14 cron resilience) ----
  // If Atlas restarted and a critical daily job was missed, run it now.
  // Only catches up jobs that are safe to replay (idempotent or append-only).
  const runLog = await loadCronRunLog();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const catchUpJobs: { name: string; maxAge: number; fn: () => Promise<void> }[] = [
    {
      name: "summarize",
      maxAge: DAY_MS,
      fn: async () => {
        if (!supabase) return;
        log("catch-up", "Running missed summarization...");
        const count = await runSummarization(supabase, async (prompt) => {
          return runPrompt(prompt, MODELS.haiku);
        });
        log("catch-up", `Summarization catch-up: ${count} summaries created`);
        markJobRan("summarize");
      },
    },
    {
      name: "reflect",
      maxAge: DAY_MS,
      fn: async () => {
        log("catch-up", "Running missed reflection...");
        const result = await runSkill("reflect", MODELS.sonnet);
        if (result) log("catch-up", `Reflection catch-up done`);
        markJobRan("reflect");
      },
    },
    {
      name: "pharmacy-invoices",
      maxAge: DAY_MS,
      fn: async () => {
        log("catch-up", "Running missed pharmacy invoice processing...");
        const result = await runPharmacyInvoiceProcessor({ lookbackDays: 2 });
        const summary = formatPharmacySummary(result);
        if (summary && summary !== "No new pharmacy invoices to process.") {
          await sendTelegramMessage(DEREK_CHAT_ID, summary);
        }
        markJobRan("pharmacy-invoices");
      },
    },
  ];

  for (const job of catchUpJobs) {
    if (isJobOverdue(runLog, job.name, job.maxAge)) {
      log("catch-up", `Job "${job.name}" is overdue, running catch-up`);
      job.fn().catch((err) => logError("catch-up", `Catch-up for ${job.name} failed: ${err}`));
    }
  }
}

export function stopCronJobs(): void {
  for (const job of jobs) {
    job.stop();
  }
  console.log("[cron] All jobs stopped");
}
