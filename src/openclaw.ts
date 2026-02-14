/**
 * Atlas — OpenClaw Repository Monitor
 *
 * Checks openclaw/openclaw GitHub repo for new commits and releases.
 * Summarizes activity and flags anything relevant to Atlas.
 * Uses GitHub REST API (no auth needed for public repos).
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { info, error as logError } from "./logger.ts";

const DATA_DIR = join(process.env.PROJECT_DIR || process.cwd(), "data");
const STATE_FILE = join(DATA_DIR, "openclaw-last-check.json");
const REPO = "openclaw/openclaw";
const API_BASE = "https://api.github.com";

interface CheckState {
  lastCheckTime: string;
  lastCommitSha: string | null;
  lastRelease: string | null;
}

interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

interface ReleaseInfo {
  tag: string;
  name: string;
  body: string;
  date: string;
}

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

/**
 * Check openclaw/openclaw for new commits and releases since last check.
 */
export async function checkOpenClaw(): Promise<{
  commits: CommitInfo[];
  newRelease: ReleaseInfo | null;
}> {
  const state = await loadState();
  const since = state.lastCheckTime;
  const results = { commits: [] as CommitInfo[], newRelease: null as ReleaseInfo | null };
  const headers = {
    "User-Agent": "Atlas-Bot/1.0",
    Accept: "application/vnd.github+json",
  };

  try {
    // Fetch recent commits since last check
    const commitsRes = await fetch(
      `${API_BASE}/repos/${REPO}/commits?since=${since}&per_page=20`,
      { headers }
    );

    if (commitsRes.ok) {
      const commits = await commitsRes.json() as any[];
      results.commits = commits.map((c) => ({
        sha: c.sha.substring(0, 7),
        message: c.commit.message.split("\n")[0],
        author: c.commit.author?.name || "unknown",
        date: c.commit.author?.date || "",
      }));

      // Log rate limit status
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
      { headers }
    );

    if (releaseRes.ok) {
      const release = await releaseRes.json() as any;
      if (release.tag_name !== state.lastRelease) {
        results.newRelease = {
          tag: release.tag_name,
          name: release.name || release.tag_name,
          body: (release.body || "").substring(0, 500),
          date: release.published_at,
        };
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

    info("openclaw", `Found ${results.commits.length} new commits, release: ${results.newRelease ? "YES" : "no"}`);
  } catch (err) {
    logError("openclaw", `Check failed: ${err}`);
  }

  return results;
}

/**
 * Format check results into a prompt for Haiku summarization.
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
    prompt += `NEW RELEASE: ${newRelease.tag} — ${newRelease.name}\n${newRelease.body}\n\n`;
  }

  if (commits.length > 0) {
    prompt += `RECENT COMMITS (${commits.length}):\n`;
    for (const c of commits.slice(0, 15)) {
      prompt += `- ${c.sha} ${c.message} (${c.author})\n`;
    }
  }

  return prompt;
}
