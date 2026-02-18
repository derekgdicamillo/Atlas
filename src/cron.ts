/**
 * Atlas — Scheduled Jobs
 *
 * In-process cron jobs using the `cron` package.
 * All times are in America/Phoenix (Arizona — MST, no DST).
 */

import { CronJob } from "cron";
import { spawn } from "bun";
import { existsSync, copyFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMetrics, getHealthStatus, getTodayClaudeCosts, error as logError, warn } from "./logger.ts";
import { getAllBreakerStats } from "./circuit-breaker.ts";
import { MODELS } from "./constants.ts";
import { readTodoFile } from "./todo.ts";
import { checkOpenClaw, formatForSummary } from "./openclaw.ts";
import { runHeartbeat } from "./heartbeat.ts";
import { runSummarization } from "./summarize.ts";
import { loadTasks, checkTasks, registerTask, type CompletedTaskInfo } from "./supervisor.ts";
import { callClaude, sessionKey } from "./claude.ts";
import { addEntry } from "./conversation.ts";
import { isDashboardReady, getFinancialPulse, getPipelinePulse } from "./dashboard.ts";
import { isGHLReady, getNewLeadsSince, getOpsSnapshot, formatOpsSnapshot } from "./ghl.ts";
import { isGBPReady, getGBPContext } from "./gbp.ts";
import { isGA4Ready, getGA4Context } from "./analytics.ts";
import { buildWeeklySummary, formatWeeklySummary } from "./executive.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";
const HEARTBEAT_CRON = process.env.HEARTBEAT_CRON || "*/30 7-22 * * *";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const DEREK_CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const MEMORY_DIR = join(PROJECT_DIR, "memory");
const DATA_DIR = join(PROJECT_DIR, "data");
const BACKUP_DIR = "C:\\Users\\derek\\OneDrive - PV MEDISPA LLC\\Backups\\atlas";

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

function log(job: string, message: string): void {
  const ts = new Date().toLocaleString("en-US", { timeZone: TIMEZONE });
  console.log(`[cron:${job}] ${ts} — ${message}`);
}

// ============================================================
// SAFE TICK WRAPPER (OpenClaw #15108 — prevent cron silent death)
// ============================================================

function safeTick(jobName: string, fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      logError("cron", `[${jobName}] onTick crashed: ${err}`);
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
      env: { ...process.env },
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

/** Run an ad-hoc prompt via Claude CLI (for cron summaries) */
async function runPrompt(prompt: string, model?: string): Promise<string> {
  try {
    const args = [CLAUDE_PATH, "-p", "--output-format", "json"];
    if (model) args.push("--model", model);

    const proc = spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR,
      env: { ...process.env },
    });

    // Pipe prompt via stdin (avoids Windows command-line length limits)
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
    log("runPrompt", `ERROR: ${error}`);
    return "";
  }
}

/** Send a proactive message to Derek via Telegram Bot API */
async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
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

        const fullBrief = [result, businessPulse, digest].filter(Boolean).join("\n\n");
        await sendTelegramMessage(DEREK_CHAT_ID, fullBrief);
        log("morning-brief", "Sent to Derek (with system digest + business pulse)");
      } else {
        log("morning-brief", "No output generated");
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 5. Content engine — 7:00 AM daily (sonnet)
jobs.push(
  CronJob.from({
    cronTime: "0 7 * * *",
    onTick: safeTick("content-engine", async () => {
      log("content-engine", "Running content waterfall...");
      const result = await runSkill("pv-content-waterfall", MODELS.sonnet);
      if (result) {
        const summary = result.length > 3900
          ? result.substring(0, 3900) + "\n\n(truncated, full output saved to files and emailed)"
          : result;
        await sendTelegramMessage(DEREK_CHAT_ID, `Content Waterfall:\n\n${summary}`);
        log("content-engine", "Sent to Derek");
      } else {
        log("content-engine", "No output generated");
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
          { stdout: "pipe", stderr: "pipe", cwd: PROJECT_DIR }
        );
        await addProc.exited;

        const diffProc = spawn(
          ["git", "diff", "--cached", "--quiet"],
          { stdout: "pipe", stderr: "pipe", cwd: PROJECT_DIR }
        );
        const diffExit = await diffProc.exited;

        if (diffExit === 0) {
          log("git-backup", "No changes to commit");
          return;
        }

        const date = today();
        const commitProc = spawn(
          ["git", "commit", "-m", `Auto-backup ${date}`],
          { stdout: "pipe", stderr: "pipe", cwd: PROJECT_DIR }
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
          { stdout: "pipe", stderr: "pipe", cwd: PROJECT_DIR }
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

        writeFileSync(
          join(DATA_DIR, "health.json"),
          JSON.stringify(healthData, null, 2)
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
    onTick: safeTick("cleanup", () => {
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
      } catch (error) {
        log("cleanup", `ERROR: ${error}`);
      }
    }),
    timeZone: TIMEZONE,
  })
);

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

// 9. OpenClaw monitoring — daily at 8:00 AM ET
//    Checks openclaw/openclaw for new commits/releases, summarizes via Haiku
jobs.push(
  CronJob.from({
    cronTime: "0 8 * * *",
    onTick: safeTick("openclaw", async () => {
      log("openclaw", "Checking openclaw/openclaw for updates...");

      const { commits, newRelease } = await checkOpenClaw();
      const prompt = formatForSummary(commits, newRelease);

      if (!prompt) {
        log("openclaw", "No new activity");
        return;
      }

      const summary = await runPrompt(prompt, MODELS.haiku);

      if (summary) {
        await sendTelegramMessage(
          DEREK_CHAT_ID,
          `OpenClaw Update:\n\n${summary}`
        );
        log("openclaw", "Sent summary to Derek");
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 10. Conversation summarization — 1:00 AM nightly (needs supabase, added in startCronJobs)

// 11. GHL new lead polling — every 15 minutes during business hours
// FALLBACK: Webhooks via supabase/functions/ghl-webhook are the primary alert mechanism.
// This poll catches anything webhooks miss (downtime, missed events, etc.)
jobs.push(
  CronJob.from({
    cronTime: "*/15 7-20 * * 1-6",
    onTick: safeTick("ghl-leads", async () => {
      if (!isGHLReady()) return;

      try {
        const { leads } = await getNewLeadsSince();
        if (leads.length > 0) {
          const names = leads.map((l) => {
            const name = l.contact?.name || l.name || "Unknown";
            const src = l.source ? ` (${l.source})` : "";
            return `${name}${src}`;
          });
          const msg = `New lead${leads.length > 1 ? "s" : ""}: ${names.join(", ")}`;
          await sendTelegramMessage(DEREK_CHAT_ID, msg);
          log("ghl-leads", `${leads.length} new lead(s) alerted`);
        }
      } catch (err) {
        log("ghl-leads", `ERROR: ${err}`);
      }
    }),
    timeZone: TIMEZONE,
  })
);

// 12. Weekly self-improvement — Sunday at 8:00 PM MST
//     Spawns a sonnet subagent to research external updates, review past week's
//     journals for friction points, and produce a structured improvement report.
jobs.push(
  CronJob.from({
    cronTime: "0 20 * * 0",
    onTick: safeTick("self-improve", async () => {
      log("self-improve", "Starting weekly self-improvement review...");

      // Collect the past 7 days of journal filenames for the subagent prompt
      const journalFiles: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
        const jPath = join(MEMORY_DIR, `${dateStr}.md`);
        if (existsSync(jPath)) {
          journalFiles.push(jPath);
        }
      }

      const journalList = journalFiles.length > 0
        ? journalFiles.map((f) => `- ${f}`).join("\n")
        : "No journal files found for the past week.";

      const outputFile = "data/task-output/self-improvement-weekly.md";

      const prompt = [
        "You are Atlas's weekly self-improvement agent. Your job is to identify ways Atlas can get better.",
        "",
        "Do these three things:",
        "",
        "## 1. External Opportunities",
        "Check these sources for new features, patterns, or tools worth adopting:",
        "- OpenClaw GitHub releases: https://github.com/openclaw/openclaw/releases",
        "  Fetch this page and look for recent releases. Note any features relevant to a Telegram bot built on Claude Code CLI.",
        "- Claude Code updates: Search the web for 'Claude Code changelog 2026' or 'Claude Code new features 2026'.",
        "  Note anything that could improve Atlas (new tools, better prompting patterns, MCP improvements, etc.).",
        "- Notable AI assistant projects: Search for 'AI assistant framework open source 2026' or 'Claude agent patterns'.",
        "  Look for patterns or architectures other projects use that Atlas could adopt.",
        "",
        "For each finding, note: what it is, why it matters to Atlas, and effort to adopt (low/medium/high).",
        "",
        "## 2. Internal Friction Points",
        "Read the following journal files from the past week and look for:",
        "- Recurring errors or failures",
        "- Tasks that failed or timed out",
        "- Things Derek had to repeat or got frustrated about",
        "- Workarounds or manual steps that could be automated",
        "- Any pattern of friction (slow responses, missing capabilities, confusion)",
        "",
        "Journal files to read:",
        journalList,
        "",
        "## 3. Recommended Actions",
        "Based on your findings, produce a prioritized list of recommended actions.",
        "Each action should have:",
        "- Priority: P1 (do this week), P2 (do this month), P3 (backlog)",
        "- Description: What to do",
        "- Source: Which finding led to this recommendation",
        "- Effort: Low (< 1 hour), Medium (1-4 hours), High (4+ hours)",
        "",
        "## Output Format",
        "Write a clean markdown report with these three sections.",
        "Include a date header and a brief executive summary at the top.",
        "Be specific and actionable. Skip generic advice.",
      ].join("\n");

      try {
        const taskId = await registerTask({
          description: "Weekly self-improvement review",
          outputFile,
          prompt,
          model: "sonnet",
          timeoutMs: 15 * 60 * 1000, // 15 min (web research takes time)
          maxRetries: 1,
          requestedBy: "cron:self-improve",
        });

        log("self-improve", `Spawned subagent: ${taskId}`);

        // Send a brief heads-up to Derek
        await sendTelegramMessage(
          DEREK_CHAT_ID,
          "Running weekly self-improvement review. I'll check OpenClaw releases, Claude Code updates, and this week's journals for friction points. Report incoming."
        );
      } catch (err) {
        logError("cron", `Self-improvement task failed to spawn: ${err}`);
      }
    }),
    timeZone: TIMEZONE,
  })
);

// ============================================================
// START ALL JOBS
// ============================================================

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
    writeFileSync(LAST_RUN_FILE, JSON.stringify(runLog, null, 2));
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

export async function startCronJobs(supabase: SupabaseClient | null): Promise<void> {
  // Load persisted task state from disk
  await loadTasks();
  // Create summarization job (needs supabase for message access)
  if (supabase) {
    jobs.push(
      CronJob.from({
        cronTime: "0 1 * * *",
        onTick: safeTick("summarize", async () => {
          log("summarize", "Starting nightly conversation summarization...");
          const count = await runSummarization(supabase, async (prompt) => {
            return runPrompt(prompt, MODELS.haiku);
          });
          log("summarize", `Created ${count} summaries`);
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
        const result = await checkTasks();

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
                lockBehavior: "skip", // don't block if user is chatting
              });

              if (summary && summary.trim() && !summary.startsWith("Error:") && summary !== "No response generated.") {
                await sendTelegramMessage(DEREK_CHAT_ID, summary);
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
              }
            } catch (err) {
              warn("supervisor", `Claude summary failed for task ${task.id}: ${err}`);
              await sendTelegramMessage(DEREK_CHAT_ID, `[Task Supervisor] Task completed: "${task.description}" — output at ${task.outputFile}`);
            }
          } else {
            // Failed/timeout tasks get the raw alert (already in result.alerts)
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

        if (result.alerts.length > 0) {
          log("supervisor", `${result.alerts.length} alerts processed (${result.completedTasks.length} with summaries)`);
        }
      }),
      timeZone: TIMEZONE,
    })
  );

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
  console.log("  - Sunday 8 PM  Weekly self-improvement review (sonnet)");
  console.log("  - 8:00 AM      OpenClaw monitoring (haiku)");
  console.log("  - 1:00 AM      Conversation summarization (haiku)");
  console.log("  - Every 5min   Task supervisor check");
  console.log("  - 7:05 AM      GHL webhook health check");

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
