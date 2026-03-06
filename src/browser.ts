/**
 * Atlas — Headless Browser Integration (agent-browser CLI)
 *
 * Wrapper around Vercel's agent-browser CLI for headless web browsing.
 * Used by Atlas tag processing (relay.ts) and the /browser skill.
 *
 * agent-browser uses Playwright under the hood with a ref-based interaction
 * model: snapshot pages to get @e1 refs, then click/fill/type by ref.
 *
 * Install: npm install -g agent-browser
 * Docs: https://github.com/vercel-labs/agent-browser
 */

import { spawn } from "bun";
import { join } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { info, warn, error as logError } from "./logger.ts";
import {
  WEB_BLOCKED_DOMAINS,
  BROWSER_COMMAND_TIMEOUT_MS,
  BROWSER_MAX_OUTPUT_CHARS,
} from "./constants.ts";

// ============================================================
// CONFIG
// ============================================================

const AGENT_BROWSER_PATH = process.env.AGENT_BROWSER_PATH || "agent-browser";
const BROWSER_SESSION_NAME = process.env.AGENT_BROWSER_SESSION_NAME || "atlas";
const SCREENSHOTS_DIR = join(
  process.env.PROJECT_DIR || process.cwd(),
  "data",
  "screenshots"
);

// Windows workaround: Rust canonicalize() produces \\?\ UNC paths that crash Node.js.
// Setting AGENT_BROWSER_HOME bypasses this. See: github.com/vercel-labs/agent-browser/issues/393
if (!process.env.AGENT_BROWSER_HOME && process.platform === "win32") {
  const guessedHome = join(
    process.env.APPDATA || "",
    "npm",
    "node_modules",
    "agent-browser"
  );
  if (existsSync(guessedHome)) {
    process.env.AGENT_BROWSER_HOME = guessedHome;
  }
}

// ============================================================
// TYPES
// ============================================================

export interface BrowserResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface BrowserTagResult {
  cleanedResponse: string;
  screenshots: string[]; // file paths of screenshots to send via Telegram
}

// ============================================================
// READINESS CHECK
// ============================================================

let _browserReady: boolean | null = null;

export function isBrowserReady(): boolean {
  if (_browserReady !== null) return _browserReady;
  try {
    const result = Bun.spawnSync([AGENT_BROWSER_PATH, "--version"]);
    _browserReady = result.exitCode === 0;
  } catch {
    _browserReady = false;
  }
  if (!_browserReady) {
    warn("browser", "agent-browser CLI not found. Install with: npm install -g agent-browser");
  }
  return _browserReady;
}

// ============================================================
// DOMAIN VALIDATION
// ============================================================

function isBlockedDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return WEB_BLOCKED_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith(`.${d}`)
    );
  } catch {
    return true; // malformed URL = blocked
  }
}

// ============================================================
// CORE EXECUTION
// ============================================================

async function execBrowser(args: string[]): Promise<BrowserResult> {
  const fullArgs = ["--session-name", BROWSER_SESSION_NAME, ...args];

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  // Cap output size to prevent context bloat
  env.AGENT_BROWSER_MAX_OUTPUT = String(BROWSER_MAX_OUTPUT_CHARS);

  try {
    const proc = spawn([AGENT_BROWSER_PATH, ...fullArgs], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Race against timeout
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Browser command timed out")), BROWSER_COMMAND_TIMEOUT_MS)
    );

    const result = await Promise.race([proc.exited, timeout]);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (result !== 0) {
      return {
        success: false,
        output: stdout,
        error: stderr || `Exit code ${result}`,
      };
    }

    return {
      success: true,
      output: stdout.substring(0, BROWSER_MAX_OUTPUT_CHARS),
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: String(err),
    };
  }
}

// ============================================================
// PUBLIC API (thin wrappers)
// ============================================================

export async function openUrl(url: string): Promise<BrowserResult> {
  if (isBlockedDomain(url)) {
    return { success: false, output: "", error: `Blocked domain: ${url}` };
  }
  return execBrowser(["open", url]);
}

export async function getSnapshot(interactiveOnly = true): Promise<BrowserResult> {
  const args = interactiveOnly ? ["snapshot", "-i"] : ["snapshot"];
  return execBrowser(args);
}

export async function clickElement(ref: string): Promise<BrowserResult> {
  return execBrowser(["click", ref]);
}

export async function fillElement(ref: string, text: string): Promise<BrowserResult> {
  return execBrowser(["fill", ref, text]);
}

export async function takeScreenshot(filename?: string): Promise<BrowserResult> {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  const name = filename || `browse-${Date.now()}.png`;
  const path = join(SCREENSHOTS_DIR, name);
  const result = await execBrowser(["screenshot", path]);
  if (result.success) {
    result.output = path; // return the file path
  }
  return result;
}

export async function getPageText(selector?: string): Promise<BrowserResult> {
  const args = selector ? ["get", "text", selector] : ["get", "text"];
  return execBrowser(args);
}

export async function closeBrowser(): Promise<BrowserResult> {
  return execBrowser(["close"]);
}

// ============================================================
// TAG PROCESSING (for Atlas relay.ts)
// ============================================================

/**
 * Process browser intent tags from Claude's response.
 * Pattern follows processWebsiteIntents / processGHLIntents.
 *
 * Tags:
 *   [BROWSE: url]                        - Open URL, snapshot, return page summary
 *   [BROWSE_SCREENSHOT: url]             - Open URL, take screenshot, close
 *   [BROWSE_CLICK: url | @ref]           - Open URL, click element by ref
 *   [BROWSE_FILL: url | @ref | text]     - Open URL, fill element by ref
 */
export async function processBrowserIntents(response: string): Promise<BrowserTagResult> {
  if (!isBrowserReady()) return { cleanedResponse: response, screenshots: [] };

  let clean = response;
  const screenshots: string[] = [];

  // [BROWSE: url] -- open, snapshot, log
  for (const match of response.matchAll(/\[BROWSE:\s*(https?:\/\/[^\]]+)\]/gi)) {
    const url = match[1].trim();
    if (isBlockedDomain(url)) {
      warn("browser", `Blocked domain in BROWSE tag: ${url}`);
      clean = clean.replace(match[0], "");
      continue;
    }
    try {
      const openResult = await openUrl(url);
      if (!openResult.success) throw new Error(openResult.error);
      const snap = await getSnapshot(false);
      info("browser", `Browsed ${url} (${snap.output.length} chars)`);
    } catch (err) {
      logError("browser", `BROWSE failed for "${url}": ${err}`);
    } finally {
      await closeBrowser();
    }
    clean = clean.replace(match[0], "");
  }

  // [BROWSE_SCREENSHOT: url] -- open, screenshot, close, queue for Telegram delivery
  for (const match of response.matchAll(/\[BROWSE_SCREENSHOT:\s*(https?:\/\/[^\]]+)\]/gi)) {
    const url = match[1].trim();
    if (isBlockedDomain(url)) {
      warn("browser", `Blocked domain in BROWSE_SCREENSHOT tag: ${url}`);
      clean = clean.replace(match[0], "");
      continue;
    }
    try {
      const openResult = await openUrl(url);
      if (!openResult.success) throw new Error(openResult.error);
      // Wait for page to settle
      await execBrowser(["wait", "--load", "networkidle"]);
      const ssResult = await takeScreenshot();
      if (ssResult.success && existsSync(ssResult.output)) {
        screenshots.push(ssResult.output);
        info("browser", `Screenshot taken: ${ssResult.output}`);
      } else {
        logError("browser", `Screenshot failed for "${url}": ${ssResult.error}`);
      }
    } catch (err) {
      logError("browser", `BROWSE_SCREENSHOT failed for "${url}": ${err}`);
    } finally {
      await closeBrowser();
    }
    clean = clean.replace(match[0], "");
  }

  // [BROWSE_CLICK: url | @ref] -- open, snapshot, click, re-snapshot
  for (const match of response.matchAll(/\[BROWSE_CLICK:\s*([\s\S]+?)\]/gi)) {
    const inner = match[1];
    const pipeIdx = inner.indexOf("|");
    if (pipeIdx === -1) {
      warn("browser", `BROWSE_CLICK missing pipe separator: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }
    const url = inner.slice(0, pipeIdx).trim();
    const ref = inner.slice(pipeIdx + 1).trim();

    if (isBlockedDomain(url)) {
      warn("browser", `Blocked domain in BROWSE_CLICK tag: ${url}`);
      clean = clean.replace(match[0], "");
      continue;
    }
    try {
      const openResult = await openUrl(url);
      if (!openResult.success) throw new Error(openResult.error);
      await execBrowser(["wait", "--load", "networkidle"]);
      const clickResult = await clickElement(ref);
      if (!clickResult.success) {
        logError("browser", `Click failed on ${ref}: ${clickResult.error}`);
      } else {
        info("browser", `Clicked ${ref} on ${url}`);
      }
    } catch (err) {
      logError("browser", `BROWSE_CLICK failed: ${err}`);
    } finally {
      await closeBrowser();
    }
    clean = clean.replace(match[0], "");
  }

  // [BROWSE_FILL: url | @ref | text] -- open, fill, re-snapshot
  for (const match of response.matchAll(/\[BROWSE_FILL:\s*([\s\S]+?)\]/gi)) {
    const inner = match[1];
    const parts = inner.split("|").map((p) => p.trim());
    if (parts.length < 3) {
      warn("browser", `BROWSE_FILL needs url|ref|text: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }
    const [url, ref, ...textParts] = parts;
    const text = textParts.join("|"); // rejoin in case text had pipes

    if (isBlockedDomain(url)) {
      warn("browser", `Blocked domain in BROWSE_FILL tag: ${url}`);
      clean = clean.replace(match[0], "");
      continue;
    }
    try {
      const openResult = await openUrl(url);
      if (!openResult.success) throw new Error(openResult.error);
      await execBrowser(["wait", "--load", "networkidle"]);
      const fillResult = await fillElement(ref, text);
      if (!fillResult.success) {
        logError("browser", `Fill failed on ${ref}: ${fillResult.error}`);
      } else {
        info("browser", `Filled ${ref} with "${text.substring(0, 50)}" on ${url}`);
      }
    } catch (err) {
      logError("browser", `BROWSE_FILL failed: ${err}`);
    } finally {
      await closeBrowser();
    }
    clean = clean.replace(match[0], "");
  }

  return { cleanedResponse: clean, screenshots };
}
