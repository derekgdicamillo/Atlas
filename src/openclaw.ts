/**
 * Atlas — OpenClaw Repository Monitor & Evolution Engine
 *
 * Checks openclaw/openclaw GitHub repo for new commits, releases, and changelogs.
 * Compares against Atlas's current capabilities and produces actionable upgrade specs.
 * Uses GitHub REST API (no auth needed for public repos).
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { info, error as logError } from "./logger.ts";

const DATA_DIR = join(process.env.PROJECT_DIR || process.cwd(), "data");
const STATE_FILE = join(DATA_DIR, "openclaw-last-check.json");
const REPO = "openclaw/openclaw";
const API_BASE = "https://api.github.com";
const HEADERS = {
  "User-Agent": "Atlas-Bot/1.0",
  Accept: "application/vnd.github+json",
};

// ============================================================
// TYPES
// ============================================================

interface CheckState {
  lastCheckTime: string;
  lastCommitSha: string | null;
  lastRelease: string | null;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  body: string;
  date: string;
  url: string;
}

export interface OpenClawCheckResult {
  commits: CommitInfo[];
  newRelease: ReleaseInfo | null;
  releaseNotes: string | null;
}

// ============================================================
// STATE PERSISTENCE
// ============================================================

async function loadState(): Promise<CheckState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastCheckTime: new Date(Date.now() - 86400000).toISOString(), // 24h ago
      lastCommitSha: null,
      lastRelease: null,
    };
  }
}

async function saveState(state: CheckState): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// GITHUB API
// ============================================================

/**
 * Check openclaw/openclaw for new commits and releases since last check.
 */
export async function checkOpenClaw(): Promise<OpenClawCheckResult> {
  const state = await loadState();
  const since = state.lastCheckTime;
  const results: OpenClawCheckResult = {
    commits: [],
    newRelease: null,
    releaseNotes: null,
  };

  try {
    // Fetch recent commits since last check
    const commitsRes = await fetch(
      `${API_BASE}/repos/${REPO}/commits?since=${since}&per_page=30`,
      { headers: HEADERS }
    );

    if (commitsRes.ok) {
      const commits = (await commitsRes.json()) as any[];
      results.commits = commits.map((c) => ({
        sha: c.sha.substring(0, 7),
        message: c.commit.message.split("\n")[0],
        author: c.commit.author?.name || "unknown",
        date: c.commit.author?.date || "",
      }));

      const remaining = commitsRes.headers.get("x-ratelimit-remaining");
      if (remaining && parseInt(remaining) < 10) {
        info("openclaw", `GitHub API rate limit low: ${remaining} remaining`);
      }
    } else {
      logError("openclaw", `Commits API returned ${commitsRes.status}`);
    }

    // Fetch latest release
    const releaseRes = await fetch(
      `${API_BASE}/repos/${REPO}/releases/latest`,
      { headers: HEADERS }
    );

    if (releaseRes.ok) {
      const release = (await releaseRes.json()) as any;
      if (release.tag_name !== state.lastRelease) {
        results.newRelease = {
          tag: release.tag_name,
          name: release.name || release.tag_name,
          body: release.body || "",
          date: release.published_at,
          url: release.html_url || "",
        };
        // Full release notes (not truncated)
        results.releaseNotes = release.body || null;
        state.lastRelease = release.tag_name;
      }
    } else if (releaseRes.status !== 404) {
      logError("openclaw", `Releases API returned ${releaseRes.status}`);
    }

    // Update state
    state.lastCheckTime = new Date().toISOString();
    if (results.commits.length > 0) {
      state.lastCommitSha = results.commits[0].sha;
    }
    await saveState(state);

    info(
      "openclaw",
      `Found ${results.commits.length} new commits, release: ${results.newRelease ? results.newRelease.tag : "none"}`
    );
  } catch (err) {
    logError("openclaw", `Check failed: ${err}`);
  }

  return results;
}

/**
 * Fetch the full changelog/release notes for a specific release tag.
 */
export async function fetchReleaseChangelog(tag: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/repos/${REPO}/releases/tags/${tag}`, {
      headers: HEADERS,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return data.body || null;
  } catch (err) {
    logError("openclaw", `Failed to fetch changelog for ${tag}: ${err}`);
    return null;
  }
}

/**
 * Fetch recent releases (up to limit) for broader comparison.
 */
export async function fetchRecentReleases(limit = 5): Promise<ReleaseInfo[]> {
  try {
    const res = await fetch(
      `${API_BASE}/repos/${REPO}/releases?per_page=${limit}`,
      { headers: HEADERS }
    );
    if (!res.ok) return [];
    const releases = (await res.json()) as any[];
    return releases.map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      body: r.body || "",
      date: r.published_at,
      url: r.html_url || "",
    }));
  } catch (err) {
    logError("openclaw", `Failed to fetch recent releases: ${err}`);
    return [];
  }
}

// ============================================================
// EVOLUTION PROMPT BUILDER
// ============================================================

/**
 * Build the prompt for the nightly evolution code agent.
 * Includes: OpenClaw changes, error log data, and Atlas context.
 */
export function buildEvolutionPrompt(opts: {
  commits: CommitInfo[];
  newRelease: ReleaseInfo | null;
  releaseNotes: string | null;
  recentFailures: string;
  journalContext: string;
}): string | null {
  const hasChanges = opts.commits.length > 0 || opts.newRelease;
  const hasErrors = opts.recentFailures.length > 0;

  // Nothing to do
  if (!hasChanges && !hasErrors) return null;

  const sections: string[] = [
    "You are Atlas's nightly evolution agent. Your job is to improve Atlas by:",
    "1. Analyzing new OpenClaw releases/commits and implementing relevant upgrades",
    "2. Detecting and fixing recurring errors from Atlas's logs",
    "",
    "IMPORTANT RULES:",
    "- Only implement changes that are clearly beneficial and low-risk",
    "- Do NOT break existing functionality. Run `bun build` to verify after changes.",
    "- Do NOT modify .env, credentials, or security-sensitive files",
    "- Do NOT change the bot's external behavior (Telegram messages, CRM actions) without adding a feature flag",
    "- Focus on internal improvements: better error handling, new utility functions, pattern adoption, bug fixes",
    "- Write clean TypeScript that matches the existing codebase style",
    "- After implementing changes, write a summary to data/task-output/nightly-evolution.md",
    "",
  ];

  if (opts.newRelease) {
    sections.push("## New OpenClaw Release");
    sections.push(`Tag: ${opts.newRelease.tag}`);
    sections.push(`Name: ${opts.newRelease.name}`);
    sections.push(`URL: ${opts.newRelease.url}`);
    sections.push("");
    if (opts.releaseNotes) {
      sections.push("### Release Notes");
      sections.push(opts.releaseNotes.substring(0, 3000));
      sections.push("");
    }
    sections.push(
      "Analyze these release notes. Identify features or patterns that would benefit Atlas.",
      "Atlas is a Telegram bot built on Claude Code CLI with: multi-agent swarms, Supabase memory,",
      "cron jobs, circuit breakers, GHL/Google/Meta/GA4 integrations, and a supervisor system.",
      "Implement any relevant improvements directly in the Atlas codebase at C:\\Users\\derek\\Projects\\atlas.",
      ""
    );
  }

  if (opts.commits.length > 0) {
    sections.push("## Recent OpenClaw Commits");
    for (const c of opts.commits.slice(0, 20)) {
      sections.push(`- ${c.sha} ${c.message} (${c.author}, ${c.date})`);
    }
    sections.push("");
    sections.push(
      "Look for patterns, bug fixes, or improvements in these commits that Atlas should adopt.",
      ""
    );
  }

  if (hasErrors) {
    sections.push("## Recent Atlas Errors (last 48h)");
    sections.push(opts.recentFailures);
    sections.push("");
    sections.push(
      "Investigate these errors. For each one:",
      "- Identify the root cause by reading the relevant source files",
      "- Implement a fix if the cause is clear",
      "- Add better error handling or circuit breaking if the cause is external",
      "- Skip if the error is transient and already handled by retry logic",
      ""
    );
  }

  if (opts.journalContext) {
    sections.push("## Recent Journal Context (friction points)");
    sections.push(opts.journalContext.substring(0, 2000));
    sections.push("");
  }

  sections.push(
    "## Output",
    "After making changes, write a markdown report to data/task-output/nightly-evolution.md with:",
    "- Date and summary",
    "- What OpenClaw changes you analyzed",
    "- What you implemented (file, line, what changed, why)",
    "- What errors you fixed",
    "- What you skipped and why",
    "- Build status (pass/fail)",
    "",
    "If there's nothing worth implementing, still write the report explaining why you passed.",
  );

  return sections.join("\n");
}

/**
 * Format check results into a prompt for Haiku summarization (legacy, kept for compatibility).
 * Returns null if no activity.
 */
export function formatForSummary(
  commits: CommitInfo[],
  newRelease: ReleaseInfo | null
): string | null {
  if (commits.length === 0 && !newRelease) return null;

  let prompt =
    "Summarize the following activity from the openclaw/openclaw GitHub repository. " +
    "Atlas is a Telegram bot built on Claude Code CLI with multi-agent personas, Supabase memory, and cron jobs. " +
    "Answer concisely: (1) What changed? (2) Does any of this apply to Atlas or could benefit it? " +
    "(3) Is anything worth investigating further? Keep it brief for Telegram.\n\n";

  if (newRelease) {
    prompt += `NEW RELEASE: ${newRelease.tag} — ${newRelease.name}\n${newRelease.body.substring(0, 500)}\n\n`;
  }

  if (commits.length > 0) {
    prompt += `RECENT COMMITS (${commits.length}):\n`;
    for (const c of commits.slice(0, 15)) {
      prompt += `- ${c.sha} ${c.message} (${c.author})\n`;
    }
  }

  return prompt;
}
