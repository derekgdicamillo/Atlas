/**
 * Atlas — Strategic Weekly Memo
 *
 * Saturday 9 PM. Sonnet synthesizes the week's data into a 3-point
 * actionable memo. Not a report. A genuine "here's what I think you
 * should do" recommendation from Atlas as a strategic partner.
 *
 * Cost: ~$0.50-1.00 per week (Sonnet).
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { runPrompt } from "./prompt-runner.ts";
import { MODELS } from "./constants.ts";
import { info, warn } from "./logger.ts";
import { isGHLReady, getOpsSnapshot, searchContacts, addTagToContact, removeTagFromContact } from "./ghl.ts";
import { getFinancials, isDashboardReady } from "./dashboard.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const MEMORY_DIR = join(PROJECT_DIR, "memory");
const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";

function getWeekDates(): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toLocaleDateString("en-CA", { timeZone: TIMEZONE }));
  }
  return dates;
}

/** Gather the week's journal entries */
function getWeekJournals(): string {
  const dates = getWeekDates();
  const entries: string[] = [];

  for (const date of dates) {
    const path = join(MEMORY_DIR, `${date}.md`);
    try {
      if (existsSync(path)) {
        const content = readFileSync(path, "utf-8");
        // Keep first 800 chars per day to stay within prompt limits
        entries.push(`### ${date}\n${content.length > 800 ? content.slice(0, 800) + "..." : content}`);
      }
    } catch {}
  }

  return entries.length > 0 ? entries.join("\n\n") : "(no journal entries this week)";
}

/** Gather night shift history for the week */
function getNightShiftWeek(): string {
  const historyPath = join(DATA_DIR, "night-shift-history.json");
  try {
    if (!existsSync(historyPath)) return "(no night shift data)";
    const history = JSON.parse(readFileSync(historyPath, "utf-8"));
    const dates = new Set(getWeekDates());
    const weekEntries = history.filter((h: any) => dates.has(h.date));
    if (weekEntries.length === 0) return "(no night shift runs this week)";
    return weekEntries
      .map((h: any) => `${h.date}: ${h.tasksCompleted}/${h.tasksPlanned} tasks, $${h.totalSpent.toFixed(2)}. ${h.highlights.join("; ")}`)
      .join("\n");
  } catch {
    return "(no night shift data)";
  }
}

/** Gather recent task outputs from this week */
function getWeekOutputs(): string {
  const outputDir = join(DATA_DIR, "task-output");
  try {
    if (!existsSync(outputDir)) return "(none)";
    const dates = new Set(getWeekDates());
    const files = readdirSync(outputDir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => {
        // Check if file was created this week by date prefix in filename
        for (const date of dates) {
          if (f.includes(date.replace(/-/g, ""))) return true;
        }
        return false;
      });
    return files.length > 0 ? files.join(", ") : "(none this week)";
  } catch {
    return "(none)";
  }
}

/** Live health check of key integrations. Prevents stale journal data from misleading the memo. */
async function getLiveSystemHealth(): Promise<string> {
  const checks: string[] = [];

  // GHL API health
  if (isGHLReady()) {
    try {
      const ops = await getOpsSnapshot();
      checks.push(`GHL API: HEALTHY (pipeline: ${ops.pipeline.total} total, ${ops.pipeline.open} open, ${ops.pipeline.won} won, close rate ${(ops.pipeline.closeRate * 100).toFixed(0)}%)`);

      // Test write capability
      const testContacts = await searchContacts("test", 1);
      if (testContacts.length > 0) {
        const tag = "atlas-health-check";
        const added = await addTagToContact(testContacts[0].id, tag);
        if (added) {
          await removeTagFromContact(testContacts[0].id, tag);
          checks.push("GHL writes (tags): HEALTHY");
        } else {
          checks.push("GHL writes (tags): FAILING (addTag returned false)");
        }
      }
    } catch (err) {
      checks.push(`GHL API: ERROR (${String(err).slice(0, 100)})`);
    }
  } else {
    checks.push("GHL API: NOT INITIALIZED");
  }

  // Show-rate state
  try {
    const showPath = join(DATA_DIR, "show-rate-state.json");
    if (existsSync(showPath)) {
      const data = JSON.parse(readFileSync(showPath, "utf-8"));
      const stats = data.dailyStats || {};
      const dates = Object.keys(stats).sort();
      const lastActive = dates.filter(d => {
        const s = stats[d];
        return (s.remindersTotal || 0) > 0;
      }).pop();
      if (lastActive) {
        checks.push(`Show-rate engine: last active ${lastActive}`);
      } else {
        checks.push("Show-rate engine: no activity recorded in dailyStats");
      }
    }
  } catch {}

  // Automation pause state
  try {
    const pausePath = join(DATA_DIR, "automation-pause.json");
    if (existsSync(pausePath)) {
      const pause = JSON.parse(readFileSync(pausePath, "utf-8"));
      const pausedKeys = Object.keys(pause.paused || {});
      if (pausedKeys.length > 0) {
        checks.push(`PAUSED automations: ${pausedKeys.join(", ")}`);
      } else {
        checks.push("Automation pauses: NONE (all systems active)");
      }
    }
  } catch {}

  // Ad tracker freshness
  try {
    const trackerPath = join(DATA_DIR, "ad-tracker.json");
    if (existsSync(trackerPath)) {
      const tracker = JSON.parse(readFileSync(trackerPath, "utf-8"));
      const snaps = tracker.snapshots || [];
      if (snaps.length > 0) {
        const lastDate = snaps[snaps.length - 1].date;
        checks.push(`Ad tracker: last snapshot ${lastDate}, ${snaps.length} total snapshots`);
      }
    }
  } catch {}

  // Lead volume freshness
  try {
    const leadPath = join(DATA_DIR, "lead-volume.json");
    if (existsSync(leadPath)) {
      const data = JSON.parse(readFileSync(leadPath, "utf-8"));
      const days = data.days || data || [];
      if (days.length > 0) {
        const lastDay = days[days.length - 1];
        checks.push(`Lead volume: last entry ${lastDay.date}, ${lastDay.total || lastDay.count || 0} leads`);
      }
    }
  } catch {}

  return checks.length > 0 ? checks.join("\n") : "(health checks unavailable)";
}

export async function runStrategicMemo(): Promise<string> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  info("strategic-memo", "Generating weekly strategic memo...");

  const journals = getWeekJournals();
  const nightShift = getNightShiftWeek();
  const outputs = getWeekOutputs();
  const systemHealth = await getLiveSystemHealth();

  // Load canonical business metrics from Supabase business_scorecard
  let businessContext = "(business_scorecard not available)";
  try {
    if (isDashboardReady()) {
      const fin = await getFinancials("month");
      if (fin?.currentMonth) {
        const cm = fin.currentMonth;
        const ue = fin.unitEconomics;
        businessContext = [
          `- Revenue: $${Math.round((cm.revenue || 0) / 1000)}K this month`,
          `- Net margin: ${cm.profitMargin ? (cm.profitMargin * 100).toFixed(1) : "N/A"}%`,
          `- Active patients: ${cm.totalPatients || "N/A"}`,
          `- Monthly churn: ${ue?.churnRate ? (ue.churnRate * 100).toFixed(1) : "N/A"}%`,
          `- Close rate: ${cm.closeRate ? (cm.closeRate * 100).toFixed(1) : "N/A"}%`,
          `- Ad spend: $${Math.round(cm.adSpend || 0)} | CPL: $${Math.round(cm.costPerLead || 0)}`,
          `- CAC: $${Math.round(ue?.cac || 0)} | LTV:CAC: ${ue?.ltvCacRatio?.toFixed(1) || "N/A"}x`,
          "- Core services: GLP-1 weight loss, functional medicine, aesthetics",
          "- Peptide therapy launching July 2026",
          "- Marketing: Facebook ads, Google, YouTube/content creation focus",
          "- Community: Vitality Unchained (Skool group, currently inactive)",
          "- Midas marketing agent: 7 cron jobs live (funnel monitor, ad digest, attribution, content hooks, competitor recon, GBP drafts, monthly brief)",
        ].join("\n");
      }
    }
  } catch {
    businessContext = "- (Could not load business metrics from Supabase. Check dashboard.ts init.)";
  }

  const prompt = `You are Atlas, strategic advisor to Derek DiCamillo (FNP, owner of PV MediSpa & Weight Loss in Prescott Valley, AZ).

Write a weekly strategic memo. NOT a report. A memo. The difference: a report tells you what happened. A memo tells you what to DO.

## This Week's Activity
${journals}

## Overnight Work This Week
${nightShift}

## Research Outputs Generated
${outputs}

## Live System Health (checked just now, OVERRIDES any stale journal data)
${systemHealth}

IMPORTANT: The system health section above reflects the CURRENT state of integrations, checked live seconds ago. If journals mention API errors or broken systems but the live health check shows HEALTHY, trust the live check. Do NOT recommend fixing something that is already working.

## Business Context (from Supabase business_scorecard)
${businessContext}

## Memo Rules
- Exactly 3 points. No more, no less.
- Each point: what you noticed + what you recommend + why now
- Be specific. "Increase ad spend" is useless. "Increase daily ad budget from $X to $Y on the weight loss campaign because CPL dropped 22% this week" is useful.
- Be honest. If something isn't working, say so.
- Write like a trusted business partner, not a consultant. Casual, direct.
- If you don't have enough data on a point, say what data you need and how to get it.
- Do NOT flag issues that the live system health check shows as resolved.
- End with one question for Derek to think about over the weekend.

Write the memo now. No preamble.`;

  const result = await runPrompt(prompt, MODELS.sonnet);

  if (result && result.length > 100) {
    // Save to file
    const outputDir = join(DATA_DIR, "task-output");
    if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });
    const filename = `weekly-strategic-memo-${today}.md`;
    const header = `# Weekly Strategic Memo\n*${today} | Generated by Atlas*\n\n---\n\n`;
    await writeFile(join(outputDir, filename), header + result);
    info("strategic-memo", `Saved to ${filename}`);
    return result;
  }

  warn("strategic-memo", "Empty or too-short response from Sonnet");
  return "";
}
