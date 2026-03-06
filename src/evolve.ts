/**
 * Atlas -- Nightly Evolution System
 *
 * Multi-source intelligence gathering, error analysis, journal friction extraction,
 * and code agent orchestration for continuous self-improvement.
 *
 * Extracted from cron.ts (lines 560-665) and expanded with:
 * - Anthropic docs/changelog scanning
 * - Claude Code CLI release tracking
 * - Codebase self-audit (TODOs, FIXMEs, stale files, deprecated patterns)
 * - Fallback action plan generation on agent failure/timeout
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { info, warn, error as logError } from "./logger.ts";
import { checkOpenClaw, type CommitInfo, type ReleaseInfo } from "./openclaw.ts";
import { getRecentFailures, formatFailureSummary, type CronRun } from "./run-log.ts";
import { registerCodeTask, type CodeAgentResult } from "./supervisor.ts";
import { sendEmail } from "./google.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const MEMORY_DIR = join(PROJECT_DIR, "memory");
const DATA_DIR = join(PROJECT_DIR, "data");
const TASK_OUTPUT_DIR = join(DATA_DIR, "task-output");
const TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const DEREK_CHAT_ID = process.env.TELEGRAM_USER_ID || "";

// ============================================================
// TYPES
// ============================================================

export interface EvolutionSources {
  /** OpenClaw GitHub activity */
  openclaw: {
    commits: CommitInfo[];
    newRelease: ReleaseInfo | null;
    releaseNotes: string | null;
  };
  /** Anthropic docs changelog entries from last 7 days */
  anthropicChangelog: string[];
  /** Claude Code CLI recent releases */
  claudeCodeReleases: string[];
  /** Codebase self-audit findings */
  selfAudit: {
    todos: string[];
    fixmes: string[];
    staleFiles: string[];
  };
  /** AI agent research papers (awesome-ai-agents repo) */
  agentPapers: string[];
  /** Anthropic research blog posts */
  anthropicResearch: string[];
  /** Hugging Face daily papers (agent-related) */
  hfDailyPapers: string[];
  /** LangGraph releases */
  langGraphReleases: string[];
  /** AI community feeds (Simon Willison, etc.) */
  communityFeeds: string[];
  /** Agent Zero (agent0ai/agent-zero) releases */
  agentZeroReleases: string[];
}

export interface EvolutionErrors {
  failures: CronRun[];
  failureSummary: string;
  errorLogLines: string[];
}

export interface JournalFriction {
  /** Lines mentioning errors, bugs, friction, issues */
  problems: string[];
  /** Lines mentioning wishes, ideas, improvements */
  ideas: string[];
}

export interface ConversationIssue {
  /** Type of behavioral issue detected */
  type:
    | "dropped_task"
    | "repeated_question"
    | "misunderstanding"
    | "went_silent"
    | "premature_cant"
    | "context_loss";
  /** The journal line(s) that evidenced this issue */
  evidence: string;
  /** Which date this was found in */
  date: string;
}

export interface ConversationReview {
  /** All behavioral issues found across yesterday's journals */
  issues: ConversationIssue[];
  /** Summary counts by type */
  counts: Record<ConversationIssue["type"], number>;
  /** Whether there were any issues worth flagging */
  hasIssues: boolean;
}

export interface EvolutionResult {
  /** Whether the evolution actually ran a code agent */
  ran: boolean;
  /** Summary message for Telegram */
  message: string;
  /** Task ID if a code agent was spawned */
  taskId?: string;
}

// ============================================================
// SOURCE 1: OpenClaw GitHub
// ============================================================

// Delegates to existing checkOpenClaw() from openclaw.ts

// ============================================================
// SOURCE 2: Anthropic Docs Changelog
// ============================================================

/**
 * Fetch the Anthropic docs changelog page and extract entries from the last 7 days.
 * Returns an array of entry summaries. Fails gracefully on network errors.
 */
async function fetchAnthropicChangelog(): Promise<string[]> {
  try {
    const res = await fetch("https://docs.anthropic.com/en/docs/changelog", {
      headers: { "User-Agent": "Atlas-Bot/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      warn("evolve", `Anthropic changelog returned ${res.status}`);
      return [];
    }
    const html = await res.text();

    // Parse entries. The changelog page uses date headers and content blocks.
    // We look for date patterns and grab surrounding text.
    const entries: string[] = [];
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Match date-like headings: "January 15, 2026" or "2026-01-15" etc.
    const datePattern = /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}/gi;
    const matches = [...html.matchAll(datePattern)];

    for (const match of matches) {
      const dateStr = match[0];
      const parsed = new Date(dateStr);
      if (isNaN(parsed.getTime())) continue;
      if (parsed.getTime() < sevenDaysAgo) continue;

      // Grab surrounding text (up to 500 chars after the date)
      const startIdx = match.index!;
      const snippet = html
        .substring(startIdx, startIdx + 500)
        .replace(/<[^>]+>/g, " ") // strip HTML tags
        .replace(/\s+/g, " ")
        .trim();

      if (snippet.length > 20) {
        entries.push(snippet.substring(0, 300));
      }
    }

    info("evolve", `Anthropic changelog: found ${entries.length} recent entries`);
    return entries;
  } catch (err) {
    warn("evolve", `Anthropic changelog fetch failed: ${err}`);
    return [];
  }
}

// ============================================================
// SOURCE 3: Claude Code CLI Releases
// ============================================================

/**
 * Check the Claude Code GitHub releases page for new CLI releases.
 * Returns parsed release summaries from the last 7 days.
 */
async function fetchClaudeCodeReleases(): Promise<string[]> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/anthropics/claude-code/releases?per_page=5",
      {
        headers: {
          "User-Agent": "Atlas-Bot/1.0",
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) {
      warn("evolve", `Claude Code releases API returned ${res.status}`);
      return [];
    }
    const releases = (await res.json()) as any[];
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent: string[] = [];

    for (const r of releases) {
      const published = new Date(r.published_at || r.created_at);
      if (published.getTime() < sevenDaysAgo) break;

      const summary = [
        `${r.tag_name}: ${r.name || ""}`,
        (r.body || "").substring(0, 500),
      ].join("\n");
      recent.push(summary);
    }

    info("evolve", `Claude Code releases: found ${recent.length} recent`);
    return recent;
  } catch (err) {
    warn("evolve", `Claude Code releases fetch failed: ${err}`);
    return [];
  }
}

// ============================================================
// SOURCE 4: Codebase Self-Audit
// ============================================================

// (Implementation below after sources 5-9)

// ============================================================
// SOURCE 5: VoltAgent/awesome-ai-agents (GitHub)
// ============================================================

/**
 * Fetch the awesome-ai-agents README and extract recent paper entries.
 * Returns an array of paper summaries, max 15 entries.
 */
async function fetchAgentPapers(): Promise<string[]> {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/VoltAgent/awesome-ai-agents/main/README.md",
      {
        headers: { "User-Agent": "Atlas-Bot/1.0" },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) {
      warn("evolve", `awesome-ai-agents README returned ${res.status}`);
      return [];
    }
    const markdown = await res.text();

    const entries: string[] = [];
    const interestingKeywords = /multi-?agent|memory|rag|eval|observability|agent.?tool|security/i;

    // Parse markdown for links with descriptions
    // Pattern: - [Title](url) - description or - **Title**: description
    const lines = markdown.split("\n");
    for (const line of lines) {
      // Match lines with markdown links: - [Title](url)
      const linkMatch = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        const title = linkMatch[1];
        const url = linkMatch[2];
        const rest = line.substring(linkMatch[0].length).trim();
        const description = rest.replace(/^[-:]\s*/, "").substring(0, 150);

        // Check if it matches our interest areas or just take first entries
        if (interestingKeywords.test(title) || interestingKeywords.test(description) || entries.length < 15) {
          const entry = description
            ? `${title}: ${description} (${url})`
            : `${title} (${url})`;
          entries.push(entry);
        }
      }

      if (entries.length >= 15) break;
    }

    info("evolve", `awesome-ai-agents: found ${entries.length} entries`);
    return entries;
  } catch (err) {
    warn("evolve", `awesome-ai-agents fetch failed: ${err}`);
    return [];
  }
}

// ============================================================
// SOURCE 6: Anthropic Research Blog
// ============================================================

/**
 * Fetch the Anthropic research page and extract recent blog posts.
 * Returns up to 5 entries from the last 14 days.
 */
async function fetchAnthropicResearch(): Promise<string[]> {
  try {
    const res = await fetch("https://www.anthropic.com/research", {
      headers: { "User-Agent": "Atlas-Bot/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      warn("evolve", `Anthropic research page returned ${res.status}`);
      return [];
    }
    const html = await res.text();

    const entries: string[] = [];
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

    // Look for article/post patterns in the HTML
    // Common patterns: <article>, <h2> or <h3> with titles, date elements
    // Extract title-like headings followed by descriptions

    // Match date patterns: "Jan 15, 2026", "January 15, 2026", "2026-01-15"
    const datePattern = /(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}/gi;

    // Find all headings that might be post titles
    const titlePattern = /<h[23][^>]*>([^<]+)<\/h[23]>/gi;
    const titles: { title: string; idx: number }[] = [];
    let match;
    while ((match = titlePattern.exec(html)) !== null) {
      titles.push({ title: match[1].trim(), idx: match.index });
    }

    // For each title, look for a nearby date and description
    for (const { title, idx } of titles) {
      const context = html.substring(idx, idx + 1000);

      // Try to find a date in the context
      const dateMatches = context.match(datePattern);
      if (dateMatches && dateMatches.length > 0) {
        const parsed = new Date(dateMatches[0]);
        if (!isNaN(parsed.getTime()) && parsed.getTime() >= fourteenDaysAgo) {
          // Extract description (look for <p> after title)
          const descMatch = context.match(/<p[^>]*>([^<]{20,200})/);
          const desc = descMatch
            ? descMatch[1].replace(/\s+/g, " ").trim().substring(0, 150)
            : "";

          entries.push(desc ? `${title}: ${desc}` : title);
        }
      }

      if (entries.length >= 5) break;
    }

    info("evolve", `Anthropic research: found ${entries.length} recent posts`);
    return entries;
  } catch (err) {
    warn("evolve", `Anthropic research fetch failed: ${err}`);
    return [];
  }
}

// ============================================================
// SOURCE 7: Hugging Face Daily Papers
// ============================================================

/**
 * Fetch Hugging Face daily papers API and filter for agent-related papers.
 * Returns up to 10 entries from the last 7 days.
 */
async function fetchHFDailyPapers(): Promise<string[]> {
  try {
    const res = await fetch("https://huggingface.co/api/daily_papers", {
      headers: { "User-Agent": "Atlas-Bot/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      warn("evolve", `HuggingFace daily papers API returned ${res.status}`);
      return [];
    }
    const papers = (await res.json()) as any[];
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const agentKeywords = /agent|tool.?use|function.?call|multi.?agent|memory|rag|planning/i;

    const entries: string[] = [];
    for (const paper of papers) {
      // Check date (papers have publishedAt or createdAt)
      const dateStr = paper.publishedAt || paper.createdAt || paper.date;
      if (dateStr) {
        const published = new Date(dateStr);
        if (published.getTime() < sevenDaysAgo) continue;
      }

      const title = paper.title || paper.paper?.title || "";
      const summary = paper.summary || paper.paper?.summary || paper.abstract || "";

      // Filter for agent-related keywords
      if (agentKeywords.test(title) || agentKeywords.test(summary)) {
        const truncatedSummary = summary.substring(0, 200).replace(/\s+/g, " ").trim();
        entries.push(truncatedSummary ? `${title}: ${truncatedSummary}` : title);
      }

      if (entries.length >= 10) break;
    }

    info("evolve", `HuggingFace daily papers: found ${entries.length} agent-related papers`);
    return entries;
  } catch (err) {
    warn("evolve", `HuggingFace daily papers fetch failed: ${err}`);
    return [];
  }
}

// ============================================================
// SOURCE 8: LangChain/LangGraph Releases
// ============================================================

/**
 * Check the LangGraph GitHub releases for recent updates.
 * Returns parsed release summaries from the last 14 days.
 */
async function fetchLangGraphReleases(): Promise<string[]> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/langchain-ai/langgraph/releases?per_page=5",
      {
        headers: {
          "User-Agent": "Atlas-Bot/1.0",
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) {
      warn("evolve", `LangGraph releases API returned ${res.status}`);
      return [];
    }
    const releases = (await res.json()) as any[];
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recent: string[] = [];

    for (const r of releases) {
      const published = new Date(r.published_at || r.created_at);
      if (published.getTime() < fourteenDaysAgo) break;

      const summary = [
        `${r.tag_name}: ${r.name || ""}`,
        (r.body || "").substring(0, 500),
      ].join("\n");
      recent.push(summary);
    }

    info("evolve", `LangGraph releases: found ${recent.length} recent`);
    return recent;
  } catch (err) {
    warn("evolve", `LangGraph releases fetch failed: ${err}`);
    return [];
  }
}

// ============================================================
// SOURCE 9: AI Community Feeds (Simon Willison)
// ============================================================

/**
 * Fetch Simon Willison's Atom feed and filter for AI/agent-related entries.
 * Returns up to 10 entries from the last 7 days.
 */
async function fetchCommunityFeeds(): Promise<string[]> {
  try {
    const res = await fetch("https://simonwillison.net/atom/everything/", {
      headers: { "User-Agent": "Atlas-Bot/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      warn("evolve", `Simon Willison feed returned ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const aiKeywords = /claude|llm|agent|ai\b|tool.?use|anthropic|openai|gpt/i;

    const entries: string[] = [];

    // Parse Atom feed entries
    // <entry>...<title>...</title>...<link href="..."/>...<updated>...</updated>...</entry>
    const entryPattern = /<entry>([\s\S]*?)<\/entry>/gi;
    let match;
    while ((match = entryPattern.exec(xml)) !== null) {
      const entryXml = match[1];

      // Extract title
      const titleMatch = entryXml.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract link
      const linkMatch = entryXml.match(/<link[^>]*href="([^"]+)"/i);
      const link = linkMatch ? linkMatch[1] : "";

      // Extract updated date
      const dateMatch = entryXml.match(/<updated>([^<]+)<\/updated>/i);
      if (dateMatch) {
        const updated = new Date(dateMatch[1]);
        if (updated.getTime() < sevenDaysAgo) continue;
      }

      // Filter for AI-related keywords
      if (title && aiKeywords.test(title)) {
        entries.push(`${title} (${link})`);
      }

      if (entries.length >= 10) break;
    }

    info("evolve", `Simon Willison feed: found ${entries.length} AI-related entries`);
    return entries;
  } catch (err) {
    warn("evolve", `Simon Willison feed fetch failed: ${err}`);
    return [];
  }
}

// ============================================================
// SOURCE 10: Agent Zero (agent0ai/agent-zero) Releases
// ============================================================

/**
 * Check the Agent Zero GitHub releases for recent updates.
 * Agent Zero is an organic, self-evolving AI framework with dynamic memory,
 * tool usage, and multi-agent cooperation. Good reference architecture for Atlas.
 * Returns parsed release summaries from the last 14 days.
 */
async function fetchAgentZeroReleases(): Promise<string[]> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/agent0ai/agent-zero/releases?per_page=5",
      {
        headers: {
          "User-Agent": "Atlas-Bot/1.0",
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) {
      warn("evolve", `Agent Zero releases API returned ${res.status}`);
      return [];
    }
    const releases = (await res.json()) as any[];
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recent: string[] = [];

    for (const r of releases) {
      const published = new Date(r.published_at || r.created_at);
      if (published.getTime() < fourteenDaysAgo) break;

      const summary = [
        `${r.tag_name}: ${r.name || ""}`,
        (r.body || "").substring(0, 500),
      ].join("\n");
      recent.push(summary);
    }

    info("evolve", `Agent Zero releases: found ${recent.length} recent`);
    return recent;
  } catch (err) {
    warn("evolve", `Agent Zero releases fetch failed: ${err}`);
    return [];
  }
}

// ============================================================
// SOURCE 4 (continued): Codebase Self-Audit
// ============================================================

/**
 * Scan the Atlas codebase for improvement signals:
 * - TODO/FIXME comments
 * - Files not updated in 30+ days that reference potentially stale patterns
 */
function auditCodebase(): { todos: string[]; fixmes: string[]; staleFiles: string[] } {
  const srcDir = join(PROJECT_DIR, "src");
  const todos: string[] = [];
  const fixmes: string[] = [];
  const staleFiles: string[] = [];

  if (!existsSync(srcDir)) {
    return { todos, fixmes, staleFiles };
  }

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  try {
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      const filePath = join(srcDir, file);
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bTODO\b/i.test(line) && !/TODO_DONE|TodoWrite/i.test(line)) {
          todos.push(`src/${file}:${i + 1}: ${line.trim().substring(0, 120)}`);
        }
        if (/\bFIXME\b/i.test(line)) {
          fixmes.push(`src/${file}:${i + 1}: ${line.trim().substring(0, 120)}`);
        }
      }

      // Check for stale files
      try {
        const stat = statSync(filePath);
        if (stat.mtimeMs < thirtyDaysAgo) {
          staleFiles.push(`src/${file} (last modified: ${new Date(stat.mtimeMs).toLocaleDateString("en-CA")})`);
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    warn("evolve", `Codebase audit failed: ${err}`);
  }

  // Cap results to keep prompt manageable
  return {
    todos: todos.slice(0, 30),
    fixmes: fixmes.slice(0, 20),
    staleFiles: staleFiles.slice(0, 15),
  };
}

// ============================================================
// SCAN SOURCES — Multi-source intelligence gathering
// ============================================================

/**
 * Gather intelligence from all sources in parallel.
 * Uses Promise.allSettled so one failing source doesn't crash the entire scan.
 */
export async function scanSources(): Promise<EvolutionSources> {
  const emptyOpenClaw = { commits: [], newRelease: null, releaseNotes: null };

  const results = await Promise.allSettled([
    checkOpenClaw(),
    fetchAnthropicChangelog(),
    fetchClaudeCodeReleases(),
    fetchAgentPapers(),
    fetchAnthropicResearch(),
    fetchHFDailyPapers(),
    fetchLangGraphReleases(),
    fetchCommunityFeeds(),
    fetchAgentZeroReleases(),
  ]);

  // Extract values with safe defaults for rejected promises
  const settled = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    warn("evolve", `Source ${i} failed: ${r.reason}`);
    return null;
  });

  const selfAudit = auditCodebase();

  return {
    openclaw: (settled[0] as Awaited<ReturnType<typeof checkOpenClaw>>) ?? emptyOpenClaw,
    anthropicChangelog: (settled[1] as string[]) ?? [],
    claudeCodeReleases: (settled[2] as string[]) ?? [],
    selfAudit,
    agentPapers: (settled[3] as string[]) ?? [],
    anthropicResearch: (settled[4] as string[]) ?? [],
    hfDailyPapers: (settled[5] as string[]) ?? [],
    langGraphReleases: (settled[6] as string[]) ?? [],
    communityFeeds: (settled[7] as string[]) ?? [],
    agentZeroReleases: (settled[8] as string[]) ?? [],
  };
}

// ============================================================
// SCAN ERRORS — Error analysis
// ============================================================

/**
 * Analyze recent errors from cron run logs and error.log.
 */
export function scanErrors(hoursBack: number = 48): EvolutionErrors {
  const failures = getRecentFailures(hoursBack);
  const failureSummary = formatFailureSummary(failures);

  // Also read recent error.log lines
  const errorLogPath = join(PROJECT_DIR, "logs", "error.log");
  let errorLogLines: string[] = [];
  if (existsSync(errorLogPath)) {
    try {
      const content = readFileSync(errorLogPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      // Take last 50 lines
      errorLogLines = lines.slice(-50);
    } catch { /* skip */ }
  }

  return { failures, failureSummary, errorLogLines };
}

// ============================================================
// SCAN JOURNALS — Friction extraction
// ============================================================

/**
 * Read recent journals and extract friction points and improvement ideas.
 */
export function scanJournals(daysBack: number = 3): JournalFriction {
  const problems: string[] = [];
  const ideas: string[] = [];

  for (let i = 0; i < daysBack; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
    const jPath = join(MEMORY_DIR, `${dateStr}.md`);
    if (!existsSync(jPath)) continue;

    try {
      const content = readFileSync(jPath, "utf-8");
      const lines = content.split("\n");

      for (const line of lines) {
        if (/error|fail|bug|fix|broke|crash|timeout|retry|friction|issue|problem/i.test(line)) {
          problems.push(`[${dateStr}] ${line.trim().substring(0, 200)}`);
        }
        if (/wish|idea|improv|would be nice|should|could|want|enhance|better|upgrade/i.test(line)) {
          ideas.push(`[${dateStr}] ${line.trim().substring(0, 200)}`);
        }
      }
    } catch { /* skip unreadable */ }
  }

  return {
    problems: problems.slice(0, 30),
    ideas: ideas.slice(0, 20),
  };
}

// ============================================================
// CONVERSATION REVIEW — Behavioral self-analysis
// ============================================================

/**
 * Analyze yesterday's journal entries for Atlas behavioral issues:
 * dropped tasks, repeated questions, misunderstandings, going silent,
 * premature "I can't", and context losses between messages.
 *
 * This is distinct from scanJournals() which looks for errors/friction/ideas.
 * This phase specifically examines HOW Atlas handled conversations.
 */
export function reviewConversations(daysBack: number = 1): ConversationReview {
  const issues: ConversationIssue[] = [];

  // Patterns that indicate specific behavioral failures
  const patterns: {
    type: ConversationIssue["type"];
    regex: RegExp;
    description: string;
  }[] = [
    // Dropped tasks: user asked for something and Atlas never delivered or moved on
    {
      type: "dropped_task",
      regex: /(?:never (?:followed up|delivered|completed|finished|responded|did)|forgot to|dropped the ball|didn't (?:finish|complete|do|follow)|still waiting|pending.*never|abandoned|left hanging|no response|unfinished)/i,
      description: "Task was started or acknowledged but never completed",
    },
    // Repeated questions: user had to ask the same thing multiple times
    {
      type: "repeated_question",
      regex: /(?:asked (?:again|twice|multiple|three)|re-?asked|already (?:asked|told|said|mentioned)|I (?:already|just) (?:said|told|asked)|repeat(?:ed|ing)? (?:the |my )?(?:question|request)|how many times|again\?)/i,
      description: "User had to repeat themselves because Atlas didn't get it the first time",
    },
    // Misunderstandings: Atlas interpreted something wrong
    {
      type: "misunderstanding",
      regex: /(?:misunderst(?:ood|anding)|wrong (?:thing|one|file|approach|direction)|not what I (?:meant|asked|wanted)|that's not|no,? I meant|confused about|misinterpreted|got it wrong|incorrect(?:ly)?|didn't mean)/i,
      description: "Atlas misunderstood what the user wanted",
    },
    // Went silent: Atlas stopped responding or cut off mid-response
    {
      type: "went_silent",
      regex: /(?:went silent|stopped respond|no response|cut off|truncat|incomplete (?:response|reply|answer)|mid-?(?:response|sentence|thought)|disappeared|timed? ?out|watchdog (?:kill|restart)|crash(?:ed|ing)?.*(?:during|while|mid)|poll(?:ing)? (?:died|stopped))/i,
      description: "Atlas stopped responding or was cut off mid-conversation",
    },
    // Premature "I can't": Atlas gave up when it could have tried harder
    {
      type: "premature_cant",
      regex: /(?:(?:I |atlas )(?:can'?t|cannot|unable|don'?t (?:have|know how)|not able)|(?:not (?:possible|supported|available))|(?:beyond my|outside my|out of (?:my )?scope)|(?:you(?:'ll| will)? (?:need|have) to (?:do|handle|check) (?:it |that |this )?(?:manually|yourself)))/i,
      description: "Atlas said it couldn't do something instead of trying harder",
    },
    // Context loss: Atlas forgot something from earlier in the conversation
    {
      type: "context_loss",
      regex: /(?:(?:already|just|earlier) (?:told|said|mentioned|explained|showed|gave)|forgot (?:what|that|about)|lost (?:context|track)|didn't remember|context (?:loss|lost|reset|window)|started over|from scratch|re-?explain)/i,
      description: "Atlas lost context from earlier in the conversation",
    },
  ];

  for (let i = 0; i < daysBack; i++) {
    const d = new Date();
    d.setDate(d.getDate() - 1 - i); // Start from yesterday
    const dateStr = d.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
    const jPath = join(MEMORY_DIR, `${dateStr}.md`);
    if (!existsSync(jPath)) continue;

    try {
      const content = readFileSync(jPath, "utf-8");
      const lines = content.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue; // skip headers and blank lines

        for (const pattern of patterns) {
          if (pattern.regex.test(trimmed)) {
            // Avoid duplicate evidence from the same line
            const alreadyFound = issues.some(
              (iss) => iss.type === pattern.type && iss.evidence === trimmed.substring(0, 200)
            );
            if (!alreadyFound) {
              issues.push({
                type: pattern.type,
                evidence: trimmed.substring(0, 200),
                date: dateStr,
              });
            }
          }
        }
      }
    } catch {
      /* skip unreadable */
    }
  }

  // Build counts
  const counts: Record<ConversationIssue["type"], number> = {
    dropped_task: 0,
    repeated_question: 0,
    misunderstanding: 0,
    went_silent: 0,
    premature_cant: 0,
    context_loss: 0,
  };
  for (const issue of issues) {
    counts[issue.type]++;
  }

  return {
    issues: issues.slice(0, 30), // Cap to keep prompt manageable
    counts,
    hasIssues: issues.length > 0,
  };
}

// ============================================================
// BUILD EVOLUTION PLAN — Assemble the code agent prompt
// ============================================================

/**
 * Build the full evolution prompt for the code agent.
 * Expands on the existing buildEvolutionPrompt() with all new sources.
 * Returns null if there's nothing actionable.
 */
export function buildEvolutionPlan(
  sources: EvolutionSources,
  errors: EvolutionErrors,
  journals: JournalFriction,
  conversationReview?: ConversationReview,
): string | null {
  const hasOpenClaw = sources.openclaw.commits.length > 0 || sources.openclaw.newRelease;
  const hasErrors = errors.failures.length > 0 || errors.errorLogLines.length > 0;
  const hasChangelog = sources.anthropicChangelog.length > 0;
  const hasClaudeCode = sources.claudeCodeReleases.length > 0;
  const hasTodos = sources.selfAudit.todos.length > 0 || sources.selfAudit.fixmes.length > 0;
  const hasJournalProblems = journals.problems.length > 0;
  const hasJournalIdeas = journals.ideas.length > 0;
  const hasAgentPapers = sources.agentPapers.length > 0;
  const hasAnthropicResearch = sources.anthropicResearch.length > 0;
  const hasHFPapers = sources.hfDailyPapers.length > 0;
  const hasLangGraph = sources.langGraphReleases.length > 0;
  const hasCommunityFeeds = sources.communityFeeds.length > 0;
  const hasAgentZero = sources.agentZeroReleases.length > 0;
  const hasConversationIssues = conversationReview?.hasIssues ?? false;

  // Nothing at all to do
  if (
    !hasOpenClaw &&
    !hasErrors &&
    !hasChangelog &&
    !hasClaudeCode &&
    !hasTodos &&
    !hasJournalProblems &&
    !hasJournalIdeas &&
    !hasAgentPapers &&
    !hasAnthropicResearch &&
    !hasHFPapers &&
    !hasLangGraph &&
    !hasCommunityFeeds &&
    !hasAgentZero &&
    !hasConversationIssues
  ) {
    return null;
  }

  const sections: string[] = [
    "You are Atlas's nightly evolution agent. Your job is to improve Atlas by analyzing multiple intelligence sources and implementing safe, high-value improvements.",
    "",
    "PRIORITY ORDER (highest first):",
    "1. Critical/recurring errors from logs",
    "2. Conversation review: behavioral failures (dropped tasks, going silent, context loss, premature give-ups)",
    "3. Security patches from OpenClaw releases",
    "4. New features or patterns from OpenClaw, Anthropic, or Claude Code updates",
    "5. FIXME markers in the codebase",
    "6. Journal friction points and improvement ideas",
    "7. TODO items and code polish",
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

  // --- OpenClaw Section ---
  if (sources.openclaw.newRelease) {
    sections.push("## Source: OpenClaw New Release");
    sections.push(`Tag: ${sources.openclaw.newRelease.tag}`);
    sections.push(`Name: ${sources.openclaw.newRelease.name}`);
    sections.push(`URL: ${sources.openclaw.newRelease.url}`);
    sections.push("");
    if (sources.openclaw.releaseNotes) {
      sections.push("### Release Notes");
      sections.push(sources.openclaw.releaseNotes.substring(0, 3000));
      sections.push("");
    }
    sections.push(
      "Analyze these release notes. Identify features or patterns that would benefit Atlas.",
      "Atlas is a Telegram bot built on Claude Code CLI with: multi-agent swarms, Supabase memory,",
      "cron jobs, circuit breakers, GHL/Google/Meta/GA4 integrations, and a supervisor system.",
      "Implement any relevant improvements directly in the Atlas codebase.",
      ""
    );
  }

  if (sources.openclaw.commits.length > 0) {
    sections.push("## Source: Recent OpenClaw Commits");
    for (const c of sources.openclaw.commits.slice(0, 20)) {
      sections.push(`- ${c.sha} ${c.message} (${c.author}, ${c.date})`);
    }
    sections.push("");
    sections.push("Look for patterns, bug fixes, or improvements in these commits that Atlas should adopt.");
    sections.push("");
  }

  // --- Anthropic Changelog Section ---
  if (hasChangelog) {
    sections.push("## Source: Anthropic Docs Changelog (last 7 days)");
    for (const entry of sources.anthropicChangelog) {
      sections.push(`- ${entry}`);
    }
    sections.push("");
    sections.push(
      "Check for: new model releases, API changes, deprecations, new features.",
      "If there are model updates, check if Atlas's constants.ts needs updating.",
      "If there are new API features, consider if any Atlas module could benefit.",
      ""
    );
  }

  // --- Claude Code CLI Section ---
  if (hasClaudeCode) {
    sections.push("## Source: Claude Code CLI Releases (last 7 days)");
    for (const rel of sources.claudeCodeReleases) {
      sections.push(rel.substring(0, 600));
      sections.push("");
    }
    sections.push(
      "Check for new CLI features, flags, or output format changes that Atlas should adopt.",
      "Atlas spawns Claude Code via supervisor.ts. Check if spawn args need updating.",
      ""
    );
  }

  // --- AI Agent Research Papers Section ---
  if (hasAgentPapers) {
    sections.push("## Source: AI Agent Research Papers");
    for (const entry of sources.agentPapers) {
      sections.push(`- ${entry}`);
    }
    sections.push("");
    sections.push(
      "Look for new techniques in agent architecture, memory systems, tool use, or multi-agent coordination that could improve Atlas.",
      ""
    );
  }

  // --- Anthropic Research Section ---
  if (hasAnthropicResearch) {
    sections.push("## Source: Anthropic Research");
    for (const entry of sources.anthropicResearch) {
      sections.push(`- ${entry}`);
    }
    sections.push("");
    sections.push(
      "Check for new model capabilities, safety research, or techniques Atlas could adopt.",
      ""
    );
  }

  // --- Hugging Face Daily Papers Section ---
  if (hasHFPapers) {
    sections.push("## Source: Hugging Face Daily Papers (Agent-Related)");
    for (const entry of sources.hfDailyPapers) {
      sections.push(`- ${entry}`);
    }
    sections.push("");
    sections.push(
      "Scan for novel approaches to agent planning, memory, tool-use, or evaluation.",
      ""
    );
  }

  // --- LangGraph Releases Section ---
  if (hasLangGraph) {
    sections.push("## Source: LangGraph Releases");
    for (const rel of sources.langGraphReleases) {
      sections.push(rel.substring(0, 600));
      sections.push("");
    }
    sections.push(
      "Check for patterns in graph-based agent orchestration that Atlas's supervisor/swarm system could adopt.",
      ""
    );
  }

  // --- AI Community Feeds Section ---
  if (hasCommunityFeeds) {
    sections.push("## Source: AI Community Feeds");
    for (const entry of sources.communityFeeds) {
      sections.push(`- ${entry}`);
    }
    sections.push("");
    sections.push(
      "Look for practical techniques, gotchas, or patterns from practitioners building with Claude/LLMs.",
      ""
    );
  }

  // --- Agent Zero Releases Section ---
  if (hasAgentZero) {
    sections.push("## Source: Agent Zero Releases (agent0ai/agent-zero)");
    for (const rel of sources.agentZeroReleases) {
      sections.push(rel.substring(0, 600));
      sections.push("");
    }
    sections.push(
      "Agent Zero is a self-evolving AI agent framework with dynamic memory, tool creation, and multi-agent cooperation.",
      "Check for patterns in memory management, self-improvement loops, tool usage, or agent orchestration that Atlas could adopt.",
      ""
    );
  }

  // --- Error Section ---
  if (hasErrors) {
    sections.push("## Source: Recent Atlas Errors");
    if (errors.failureSummary) {
      sections.push("### Cron Run Failures");
      sections.push(errors.failureSummary);
      sections.push("");
    }
    if (errors.errorLogLines.length > 0) {
      sections.push("### Error Log (recent lines)");
      // Deduplicate similar errors
      const uniqueErrors = [...new Set(errors.errorLogLines.map((l) => l.substring(0, 150)))];
      for (const line of uniqueErrors.slice(0, 20)) {
        sections.push(`  ${line}`);
      }
      sections.push("");
    }
    sections.push(
      "For each error:",
      "- Identify the root cause by reading the relevant source files",
      "- Implement a fix if the cause is clear",
      "- Add better error handling or circuit breaking if the cause is external",
      "- Skip if the error is transient and already handled by retry logic",
      ""
    );
  }

  // --- Conversation Review Section ---
  if (hasConversationIssues && conversationReview) {
    sections.push("## Source: Conversation Review (Atlas Behavioral Analysis)");
    sections.push(
      "These are behavioral issues found in yesterday's conversations. Atlas failed the user in these ways.",
      "For each issue, diagnose the root cause and implement a concrete fix.",
      ""
    );

    // Group by type for clarity
    const typeLabels: Record<ConversationIssue["type"], string> = {
      dropped_task: "Dropped Tasks (started/acknowledged but never delivered)",
      repeated_question: "Repeated Questions (user had to ask multiple times)",
      misunderstanding: "Misunderstandings (Atlas got the intent wrong)",
      went_silent: "Went Silent (stopped responding or cut off mid-response)",
      premature_cant: "Premature 'I Can't' (gave up instead of trying harder)",
      context_loss: "Context Loss (forgot earlier conversation details)",
    };

    const rootCauseGuidance: Record<ConversationIssue["type"], string> = {
      dropped_task:
        "Root causes: timeout/watchdog kill mid-task, context window overflow losing the original request, no TODO tracking for multi-step work. Fix: add [TODO:] tagging for user requests, improve task persistence, add completion verification.",
      repeated_question:
        "Root causes: poor listening/parsing of user intent, not storing key facts to memory, over-reliance on in-context vs persisted memory. Fix: add [REMEMBER:] for important user statements, improve intent parsing in claude.ts.",
      misunderstanding:
        "Root causes: bad assumption without clarifying, not reading referenced files before acting, pattern-matching on keywords instead of understanding. Fix: add clarification prompts in SOUL.md, improve pre-read behavior.",
      went_silent:
        "Root causes: watchdog kill (exceeded timeout), unhandled exception in relay pipeline, Telegram API failure, context window exceeded causing silent truncation. Fix: improve watchdog recovery, add partial-response checkpointing, increase timeout for complex tasks.",
      premature_cant:
        "Root causes: SOUL.md rules not strong enough about trying before refusing, missing tool awareness, over-cautious safety checks. Fix: strengthen 'exhaust options before refusing' rules in SOUL.md, add tool discovery prompts.",
      context_loss:
        "Root causes: conversation exceeded context window, session reset between messages, important facts not saved to [REMEMBER:] or graph memory. Fix: more aggressive memory persistence, session continuity improvements in relay.ts.",
    };

    for (const [type, label] of Object.entries(typeLabels) as [ConversationIssue["type"], string][]) {
      const typeIssues = conversationReview.issues.filter((i) => i.type === type);
      if (typeIssues.length === 0) continue;

      sections.push(`### ${label} (${typeIssues.length} instance(s))`);
      for (const issue of typeIssues) {
        sections.push(`- [${issue.date}] ${issue.evidence}`);
      }
      sections.push("");
      sections.push(rootCauseGuidance[type]);
      sections.push("");
    }

    sections.push(
      "For each conversation issue above:",
      "- Diagnose which root cause applies based on the evidence",
      "- If it's a prompt/personality issue: update SOUL.md, IDENTITY.md, or CLAUDE.md",
      "- If it's a code issue: fix the relevant source file (relay.ts, claude.ts, supervisor.ts, etc.)",
      "- If it's a memory issue: add appropriate [REMEMBER:] entries or improve memory persistence logic",
      "- Include your diagnosis and fix in the evolution report",
      ""
    );
  }

  // --- Journal Friction Section ---
  if (hasJournalProblems || hasJournalIdeas) {
    sections.push("## Source: Journal Friction & Ideas (last 3 days)");
    if (journals.problems.length > 0) {
      sections.push("### Problems / Friction");
      for (const p of journals.problems.slice(0, 15)) {
        sections.push(`- ${p}`);
      }
      sections.push("");
    }
    if (journals.ideas.length > 0) {
      sections.push("### Ideas / Improvement Wishes");
      for (const idea of journals.ideas.slice(0, 10)) {
        sections.push(`- ${idea}`);
      }
      sections.push("");
    }
  }

  // --- Self-Audit Section ---
  if (hasTodos) {
    sections.push("## Source: Codebase Self-Audit");
    if (sources.selfAudit.fixmes.length > 0) {
      sections.push("### FIXME Markers (address these first)");
      for (const f of sources.selfAudit.fixmes.slice(0, 10)) {
        sections.push(`- ${f}`);
      }
      sections.push("");
    }
    if (sources.selfAudit.todos.length > 0) {
      sections.push("### TODO Markers");
      for (const t of sources.selfAudit.todos.slice(0, 15)) {
        sections.push(`- ${t}`);
      }
      sections.push("");
    }
    if (sources.selfAudit.staleFiles.length > 0) {
      sections.push("### Stale Files (30+ days without modification)");
      for (const s of sources.selfAudit.staleFiles) {
        sections.push(`- ${s}`);
      }
      sections.push("");
    }
    sections.push(
      "Address FIXME markers if you can determine the fix. For TODOs, only address ones",
      "that are clearly actionable and low-risk. Skip stale files unless they have obvious issues.",
      ""
    );
  }

  // --- Output Section ---
  sections.push(
    "## Output",
    "After making changes, write a markdown report to data/task-output/nightly-evolution.md with:",
    "- Date and summary",
    "- Sources analyzed and what you found",
    "- What you implemented (file, line, what changed, why)",
    "- What errors you fixed",
    "- What you skipped and why",
    "- Build status (pass/fail)",
    "",
    "If there's nothing worth implementing, still write the report explaining why you passed.",
  );

  return sections.join("\n");
}

// ============================================================
// TELEGRAM HELPER (local, avoids importing from cron.ts)
// ============================================================

async function sendTelegram(chatId: string, text: string): Promise<void> {
  if (!BOT_TOKEN || !chatId) return;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    // Try with Markdown first for nice formatting
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(10_000),
    });
    // OpenClaw #20591 pattern: if Markdown parse fails (400), retry without parse_mode
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 400 && body.includes("parse")) {
        warn("evolve", `Telegram Markdown parse failed, retrying without parse_mode`);
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(10_000),
        });
      }
    }
  } catch (err) {
    warn("evolve", `Telegram send failed: ${err}`);
  }
}

// ============================================================
// FALLBACK ACTION PLAN
// ============================================================

/**
 * Generate a markdown action plan when the code agent fails or times out.
 * Captures what SHOULD have been done so Derek has a manual roadmap.
 */
async function writeActionPlan(
  sources: EvolutionSources,
  errors: EvolutionErrors,
  journals: JournalFriction,
  reason: string,
  conversationReview?: ConversationReview,
): Promise<string> {
  const planPath = join(TASK_OUTPUT_DIR, "nightly-evolution-plan.md");

  const now = new Date().toLocaleString("en-US", { timeZone: TIMEZONE });
  const lines: string[] = [
    `# Evolution Action Plan`,
    `Generated: ${now}`,
    `Reason: Code agent ${reason}`,
    "",
    "This plan lists what the evolution agent would have done. Review and implement manually or re-trigger with /evolve.",
    "",
  ];

  // Errors (highest priority)
  if (errors.failures.length > 0) {
    lines.push("## Critical: Error Fixes Needed");
    for (const f of errors.failures.slice(0, 10)) {
      const time = new Date(f.ts).toLocaleString("en-US", { timeZone: TIMEZONE, hour: "numeric", minute: "2-digit" });
      lines.push(`- [ ] ${f.jobName} at ${time}: ${f.error || f.status}`);
    }
    lines.push("");
  }

  // Conversation Review (high priority)
  if (conversationReview?.hasIssues) {
    lines.push("## Behavioral Issues: Conversation Review");
    const typeLabels: Record<string, string> = {
      dropped_task: "Dropped Task",
      repeated_question: "Repeated Question",
      misunderstanding: "Misunderstanding",
      went_silent: "Went Silent",
      premature_cant: "Premature Give-Up",
      context_loss: "Context Loss",
    };
    for (const issue of conversationReview.issues.slice(0, 15)) {
      lines.push(`- [ ] [${typeLabels[issue.type] || issue.type}] [${issue.date}] ${issue.evidence}`);
    }
    lines.push("");
  }

  // OpenClaw
  if (sources.openclaw.newRelease) {
    lines.push("## OpenClaw Release to Port");
    lines.push(`- [ ] Review and port: ${sources.openclaw.newRelease.tag} (${sources.openclaw.newRelease.name})`);
    lines.push(`  URL: ${sources.openclaw.newRelease.url}`);
    lines.push("");
  }
  if (sources.openclaw.commits.length > 0) {
    lines.push("## OpenClaw Commits to Review");
    for (const c of sources.openclaw.commits.slice(0, 10)) {
      lines.push(`- [ ] ${c.sha}: ${c.message}`);
    }
    lines.push("");
  }

  // Anthropic changelog
  if (sources.anthropicChangelog.length > 0) {
    lines.push("## Anthropic Changelog Updates");
    for (const entry of sources.anthropicChangelog) {
      lines.push(`- [ ] ${entry.substring(0, 150)}`);
    }
    lines.push("");
  }

  // Claude Code
  if (sources.claudeCodeReleases.length > 0) {
    lines.push("## Claude Code CLI Updates");
    for (const rel of sources.claudeCodeReleases) {
      lines.push(`- [ ] ${rel.split("\n")[0]}`);
    }
    lines.push("");
  }

  // FIXME/TODO
  if (sources.selfAudit.fixmes.length > 0) {
    lines.push("## FIXMEs to Address");
    for (const f of sources.selfAudit.fixmes.slice(0, 10)) {
      lines.push(`- [ ] ${f}`);
    }
    lines.push("");
  }

  // Journal ideas
  if (journals.ideas.length > 0) {
    lines.push("## Improvement Ideas from Journals");
    for (const idea of journals.ideas.slice(0, 10)) {
      lines.push(`- [ ] ${idea}`);
    }
    lines.push("");
  }

  // AI Agent Research Papers
  if (sources.agentPapers.length > 0) {
    lines.push("## AI Agent Research Papers to Review");
    for (const entry of sources.agentPapers.slice(0, 10)) {
      lines.push(`- [ ] ${entry.substring(0, 150)}`);
    }
    lines.push("");
  }

  // Anthropic Research
  if (sources.anthropicResearch.length > 0) {
    lines.push("## Anthropic Research Posts to Review");
    for (const entry of sources.anthropicResearch.slice(0, 5)) {
      lines.push(`- [ ] ${entry.substring(0, 150)}`);
    }
    lines.push("");
  }

  // Hugging Face Daily Papers
  if (sources.hfDailyPapers.length > 0) {
    lines.push("## Hugging Face Agent Papers to Review");
    for (const entry of sources.hfDailyPapers.slice(0, 10)) {
      lines.push(`- [ ] ${entry.substring(0, 150)}`);
    }
    lines.push("");
  }

  // LangGraph Releases
  if (sources.langGraphReleases.length > 0) {
    lines.push("## LangGraph Releases to Review");
    for (const rel of sources.langGraphReleases) {
      lines.push(`- [ ] ${rel.split("\n")[0]}`);
    }
    lines.push("");
  }

  // Community Feeds
  if (sources.communityFeeds.length > 0) {
    lines.push("## AI Community Feed Posts to Review");
    for (const entry of sources.communityFeeds.slice(0, 10)) {
      lines.push(`- [ ] ${entry.substring(0, 150)}`);
    }
    lines.push("");
  }

  // Agent Zero Releases
  if (sources.agentZeroReleases.length > 0) {
    lines.push("## Agent Zero Releases to Review");
    for (const rel of sources.agentZeroReleases) {
      lines.push(`- [ ] ${rel.split("\n")[0]}`);
    }
    lines.push("");
  }

  try {
    await mkdir(TASK_OUTPUT_DIR, { recursive: true });
    await writeFile(planPath, lines.join("\n"));
    info("evolve", `Wrote action plan to ${planPath}`);
  } catch (err) {
    logError("evolve", `Failed to write action plan: ${err}`);
  }

  return planPath;
}

// ============================================================
// EVOLUTION EMAIL SUMMARY
// ============================================================

const EVOLUTION_EMAIL_TO = "derek@pvmedispa.com";

/** Format today's date for the email subject line. */
function emailDate(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Build an HTML email body from the evolution report markdown file.
 * Parses the report for individual changes and structures them into
 * a clean email with what/why/how/source for each change.
 */
function buildEvolutionEmailHtml(
  reportContent: string,
  findingSummary: string,
  costUsd: string,
  durationSec: number,
): string {
  // Parse individual changes from the report.
  // The code agent writes structured markdown with file/line/change/why sections.
  // We look for patterns like "### " headings, "- " items, "**File:**" markers.
  const lines = reportContent.split("\n");

  // Extract changes (sections starting with ### or ## that describe implementations)
  const changes: { what: string; why: string; how: string; source: string }[] = [];
  const skipped: string[] = [];
  let inSkipped = false;
  let currentChange: { what: string; why: string; how: string; source: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect skipped/deferred section
    if (/^#{1,3}\s.*(skip|defer|pass|not implement)/i.test(trimmed)) {
      inSkipped = true;
      if (currentChange) {
        changes.push(currentChange);
        currentChange = null;
      }
      continue;
    }

    if (inSkipped) {
      if (/^#{1,3}\s/.test(trimmed) && !/skip|defer|pass/i.test(trimmed)) {
        inSkipped = false;
      } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        skipped.push(trimmed.replace(/^[-*]\s*/, ""));
        continue;
      } else if (trimmed.length > 0 && !trimmed.startsWith("#")) {
        skipped.push(trimmed);
        continue;
      }
    }

    // Detect change headings
    if (/^#{2,3}\s/.test(trimmed) && !inSkipped) {
      if (currentChange) changes.push(currentChange);
      currentChange = {
        what: trimmed.replace(/^#{2,3}\s*/, ""),
        why: "",
        how: "",
        source: "",
      };
      continue;
    }

    if (currentChange) {
      const lower = trimmed.toLowerCase();
      if (lower.startsWith("**why") || lower.startsWith("why:") || lower.startsWith("- why:")) {
        currentChange.why = trimmed.replace(/^\*?\*?why\*?\*?:?\s*/i, "").replace(/^-\s*why:\s*/i, "");
      } else if (lower.startsWith("**source") || lower.startsWith("source:") || lower.startsWith("- source:")) {
        currentChange.source = trimmed.replace(/^\*?\*?source\*?\*?:?\s*/i, "").replace(/^-\s*source:\s*/i, "");
      } else if (lower.startsWith("**how") || lower.startsWith("how:") || lower.startsWith("- how:") || lower.startsWith("**improvement") || lower.startsWith("improvement:")) {
        currentChange.how = trimmed.replace(/^\*?\*?(?:how|improvement)\*?\*?:?\s*/i, "").replace(/^-\s*(?:how|improvement):\s*/i, "");
      } else if (lower.startsWith("**file") || lower.startsWith("file:")) {
        // Append file info to "what"
        const fileInfo = trimmed.replace(/^\*?\*?file\*?\*?:?\s*/i, "");
        if (fileInfo) currentChange.what += ` (${fileInfo})`;
      } else if (trimmed.startsWith("- ") && !currentChange.why) {
        // Bullet point as description
        currentChange.why = trimmed.replace(/^-\s*/, "");
      }
    }
  }
  if (currentChange) changes.push(currentChange);

  // If parsing found no structured changes, treat each non-empty non-heading line as a change
  if (changes.length === 0 && reportContent.length > 50) {
    changes.push({
      what: "Evolution changes implemented",
      why: "See full report for details",
      how: "Improvements applied to the Atlas codebase",
      source: "nightly-evolution.md",
    });
  }

  // Build HTML
  const changeRows = changes
    .map(
      (c, i) =>
        `<tr style="border-bottom:1px solid #e0e0e0;">
          <td style="padding:12px;vertical-align:top;color:#666;font-size:13px;">${i + 1}</td>
          <td style="padding:12px;">
            <div style="font-weight:600;color:#1a1a2e;margin-bottom:4px;">${escapeHtml(c.what)}</div>
            ${c.why ? `<div style="color:#555;font-size:13px;margin-bottom:2px;"><strong>Why:</strong> ${escapeHtml(c.why)}</div>` : ""}
            ${c.how ? `<div style="color:#555;font-size:13px;margin-bottom:2px;"><strong>Improvement:</strong> ${escapeHtml(c.how)}</div>` : ""}
            ${c.source ? `<div style="color:#888;font-size:12px;"><strong>Source:</strong> ${escapeHtml(c.source)}</div>` : ""}
          </td>
        </tr>`
    )
    .join("\n");

  const skippedSection =
    skipped.length > 0
      ? `<div style="margin-top:24px;padding:16px;background:#f8f8f8;border-radius:6px;">
          <h3 style="margin:0 0 8px;color:#666;font-size:14px;">Skipped / Deferred</h3>
          <ul style="margin:0;padding-left:20px;color:#888;font-size:13px;">
            ${skipped.map((s) => `<li>${escapeHtml(s)}</li>`).join("\n")}
          </ul>
        </div>`
      : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);color:white;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:20px;">Atlas Nightly Evolution</h1>
    <p style="margin:8px 0 0;opacity:0.85;font-size:14px;">${emailDate()}</p>
  </div>

  <div style="background:white;border:1px solid #e0e0e0;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
    <div style="display:flex;gap:16px;margin-bottom:20px;font-size:13px;color:#666;">
      <span><strong>Changes Shipped:</strong> ${changes.length}</span>
      <span><strong>Cost:</strong> $${costUsd}</span>
      <span><strong>Duration:</strong> ${durationSec}s</span>
    </div>

    <p style="color:#555;font-size:14px;margin-bottom:16px;">
      <strong>Analyzed:</strong> ${escapeHtml(findingSummary)}
    </p>

    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="border-bottom:2px solid #1a1a2e;">
          <th style="padding:8px 12px;text-align:left;color:#1a1a2e;font-size:12px;width:30px;">#</th>
          <th style="padding:8px 12px;text-align:left;color:#1a1a2e;font-size:12px;">Change</th>
        </tr>
      </thead>
      <tbody>
        ${changeRows}
      </tbody>
    </table>

    ${skippedSection}
  </div>

  <p style="text-align:center;color:#aaa;font-size:11px;margin-top:16px;">
    Full report: data/task-output/nightly-evolution.md
  </p>
</body>
</html>`;
}

/** Build a minimal "no changes" email. */
function buildNoChangesEmailHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);color:white;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:20px;">Atlas Nightly Evolution</h1>
    <p style="margin:8px 0 0;opacity:0.85;font-size:14px;">${emailDate()}</p>
  </div>
  <div style="background:white;border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px;text-align:center;">
    <p style="font-size:16px;color:#555;margin:16px 0;">No changes tonight.</p>
    <p style="font-size:13px;color:#888;">All sources scanned. No new activity, errors, or actionable improvements found.</p>
  </div>
</body>
</html>`;
}

/** Escape HTML special characters. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Send the evolution summary email. Wrapped in try/catch so it never crashes the pipeline.
 */
async function sendEvolutionEmail(subject: string, htmlBody: string): Promise<void> {
  try {
    const msgId = await sendEmail(EVOLUTION_EMAIL_TO, subject, htmlBody);
    if (msgId) {
      info("evolve", `Evolution email sent to ${EVOLUTION_EMAIL_TO} (msgId: ${msgId})`);
    } else {
      warn("evolve", "Evolution email: sendEmail returned null (Atlas Gmail may not be configured)");
    }
  } catch (err) {
    warn("evolve", `Evolution email failed (non-fatal): ${err}`);
  }
}

// ============================================================
// RUN EVOLUTION — Main orchestrator
// ============================================================

/**
 * Run the full evolution pipeline.
 * @param opts.manual - true if triggered by /evolve, false if from cron
 */
export async function runEvolution(opts: { manual?: boolean } = {}): Promise<EvolutionResult> {
  const label = opts.manual ? "Manual evolution" : "Nightly evolution";
  info("evolve", `${label} starting...`);

  // 1. Gather intelligence from all sources
  const [sources, errors, journals] = await Promise.all([
    scanSources(),
    Promise.resolve(scanErrors(48)),
    Promise.resolve(scanJournals(3)),
  ]);

  // 1b. Conversation review: analyze yesterday's journal for behavioral issues
  const conversationReview = reviewConversations(1);
  if (conversationReview.hasIssues) {
    info("evolve", `Conversation review: ${conversationReview.issues.length} behavioral issue(s) found`);
  }

  // 2. Build the evolution plan
  const prompt = buildEvolutionPlan(sources, errors, journals, conversationReview);

  if (!prompt) {
    const msg = `${label}: All quiet. No new activity, errors, or improvements found.`;
    info("evolve", msg);

    // Send "no changes tonight" email
    try {
      const subject = `Atlas Nightly Evolution \u2014 ${emailDate()}`;
      await sendEvolutionEmail(subject, buildNoChangesEmailHtml());
    } catch (emailErr) {
      warn("evolve", `Evolution no-changes email failed (non-fatal): ${emailErr}`);
    }

    return { ran: false, message: msg };
  }

  // 3. Summarize what we found for the heads-up message
  const findings: string[] = [];
  if (sources.openclaw.newRelease) {
    findings.push(`OpenClaw release: ${sources.openclaw.newRelease.tag}`);
  } else if (sources.openclaw.commits.length > 0) {
    findings.push(`${sources.openclaw.commits.length} OpenClaw commit(s)`);
  }
  if (sources.anthropicChangelog.length > 0) {
    findings.push(`${sources.anthropicChangelog.length} Anthropic changelog entries`);
  }
  if (sources.claudeCodeReleases.length > 0) {
    findings.push(`${sources.claudeCodeReleases.length} Claude Code release(s)`);
  }
  if (sources.agentPapers.length > 0) {
    findings.push(`${sources.agentPapers.length} agent paper(s)`);
  }
  if (sources.anthropicResearch.length > 0) {
    findings.push(`${sources.anthropicResearch.length} Anthropic research post(s)`);
  }
  if (sources.hfDailyPapers.length > 0) {
    findings.push(`${sources.hfDailyPapers.length} HF daily paper(s)`);
  }
  if (sources.langGraphReleases.length > 0) {
    findings.push(`${sources.langGraphReleases.length} LangGraph release(s)`);
  }
  if (sources.communityFeeds.length > 0) {
    findings.push(`${sources.communityFeeds.length} community feed entry(s)`);
  }
  if (sources.agentZeroReleases.length > 0) {
    findings.push(`${sources.agentZeroReleases.length} Agent Zero release(s)`);
  }
  if (errors.failures.length > 0) {
    findings.push(`${errors.failures.length} error(s) to investigate`);
  }
  if (sources.selfAudit.fixmes.length > 0) {
    findings.push(`${sources.selfAudit.fixmes.length} FIXME(s)`);
  }
  if (journals.problems.length > 0) {
    findings.push(`${journals.problems.length} journal friction point(s)`);
  }
  if (conversationReview.hasIssues) {
    // Build a compact summary of behavioral issue types
    const behaviorCounts: string[] = [];
    for (const [type, count] of Object.entries(conversationReview.counts)) {
      if (count > 0) {
        const shortLabels: Record<string, string> = {
          dropped_task: "dropped",
          repeated_question: "repeated asks",
          misunderstanding: "misunderstood",
          went_silent: "went silent",
          premature_cant: "gave up early",
          context_loss: "context lost",
        };
        behaviorCounts.push(`${count} ${shortLabels[type] || type}`);
      }
    }
    findings.push(`behavior review: ${behaviorCounts.join(", ")}`);
  }

  const findingSummary = findings.join(", ");

  // 4. Spawn code agent
  try {
    const taskId = await registerCodeTask({
      description: `${label}: ${findingSummary}`,
      prompt,
      cwd: PROJECT_DIR,
      model: "opus",
      requestedBy: opts.manual ? "manual:/evolve" : "cron:evolution",
      wallClockMs: 60 * 60 * 1000, // 60 min max
      budgetUsd: 5.00,
      onComplete: async (result: CodeAgentResult) => {
        const status = result.exitReason === "completed" ? "completed" : `stopped (${result.exitReason})`;
        const cost = result.costUsd?.toFixed(2) || "?";

        if (result.exitReason !== "completed" || !result.success) {
          // Agent failed or timed out. Generate fallback action plan.
          const reason = result.exitReason === "completed" ? "errored" : result.exitReason;
          const planPath = await writeActionPlan(sources, errors, journals, reason, conversationReview);

          const durationSec = Math.round((result.durationMs || 0) / 1000);
          const msg = [
            `**${label} ${status}**`,
            `Analyzed: ${findingSummary}`,
            `Cost: $${cost} | Duration: ${durationSec}s`,
            "",
            `Code agent ${reason} but I saved an action plan.`,
            `Plan: ${planPath}`,
          ].join("\n");

          await sendTelegram(DEREK_CHAT_ID, msg);

          // Email failure summary to Derek
          try {
            const subject = `Atlas Nightly Evolution \u2014 ${emailDate()}`;
            const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:linear-gradient(135deg,#8b0000,#c0392b);color:white;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:20px;">Atlas Nightly Evolution</h1>
    <p style="margin:8px 0 0;opacity:0.85;font-size:14px;">${emailDate()} \u2014 Agent ${escapeHtml(reason)}</p>
  </div>
  <div style="background:white;border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="color:#c0392b;font-weight:600;">Code agent ${escapeHtml(reason)}</p>
    <p style="color:#555;font-size:14px;"><strong>Analyzed:</strong> ${escapeHtml(findingSummary)}</p>
    <p style="color:#666;font-size:13px;">Cost: $${cost} | Duration: ${durationSec}s</p>
    <p style="color:#555;font-size:14px;">An action plan has been saved to <code>${escapeHtml(planPath)}</code>. Review and implement manually or re-trigger with /evolve.</p>
  </div>
</body>
</html>`;
            await sendEvolutionEmail(subject, htmlBody);
          } catch (emailErr) {
            warn("evolve", `Evolution email step failed (non-fatal): ${emailErr}`);
          }
        } else {
          // Success
          const durationSec = Math.round((result.durationMs || 0) / 1000);
          const msg = [
            `**${label} completed**`,
            `Analyzed: ${findingSummary}`,
            `Cost: $${cost} | Duration: ${durationSec}s`,
            "",
            "Report: data/task-output/nightly-evolution.md",
          ].join("\n");

          await sendTelegram(DEREK_CHAT_ID, msg);

          // Email the evolution summary to Derek
          try {
            const reportPath = join(TASK_OUTPUT_DIR, "nightly-evolution.md");
            let reportContent = "";
            if (existsSync(reportPath)) {
              reportContent = readFileSync(reportPath, "utf-8");
            }
            const subject = `Atlas Nightly Evolution \u2014 ${emailDate()}`;
            const htmlBody = reportContent
              ? buildEvolutionEmailHtml(reportContent, findingSummary, cost, durationSec)
              : buildNoChangesEmailHtml();
            await sendEvolutionEmail(subject, htmlBody);
          } catch (emailErr) {
            warn("evolve", `Evolution email step failed (non-fatal): ${emailErr}`);
          }
        }
      },
    });

    info("evolve", `Spawned code agent: ${taskId} for ${findingSummary}`);

    // Send heads-up
    await sendTelegram(
      DEREK_CHAT_ID,
      `**${label} started.** ${findingSummary}. Code agent is analyzing and implementing improvements.`
    );

    return {
      ran: true,
      message: `${label} started. Analyzing: ${findingSummary}. Code agent spawned (${taskId}).`,
      taskId,
    };
  } catch (err) {
    logError("evolve", `Code agent failed to spawn: ${err}`);

    // Fallback: write the action plan even if spawn failed
    const planPath = await writeActionPlan(sources, errors, journals, "spawn failed", conversationReview);

    return {
      ran: false,
      message: `${label} failed to spawn code agent: ${err}. Action plan saved to ${planPath}.`,
    };
  }
}
