/**
 * Atlas — TMAA Marketing Bridge
 *
 * Schedules and narrates the tmaa-marketing repo (the deterministic
 * "brain" at ~/Projects/tmaa-marketing). Daily pull+verify, weekly board
 * session, brief delivery to Derek, approval handoff, producer run.
 *
 * THE WALL: this module never moves a brief itself. The only promotion
 * path is scripts/approve-brief.mjs in the tmaa repo, and the only
 * automated caller is handleBriefApproval(), which the relay invokes
 * exclusively for Derek's explicit `approve <slug>` message.
 */
import { homedir } from "os";
import { join } from "path";

export const TMAA_DIR =
  process.env.TMAA_MARKETING_DIR || join(homedir(), "Projects", "tmaa-marketing");

/** Files in `after` that were not in `before`. */
export function diffNewBriefs(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return after.filter((f) => !seen.has(f));
}

/** Briefs whose `read_on:` date is exactly today (YYYY-MM-DD). */
export function briefsDueToday(
  briefTexts: Array<{ file: string; text: string }>,
  today: string,
): string[] {
  return briefTexts
    .filter(({ text }) => (text.match(/^read_on:\s*(\S+)/m) || [])[1] === today)
    .map(({ file }) => file);
}

/** Last N lines of a string — for stderr excerpts in alerts. */
export function tail(text: string, lines: number): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

// ---- side-effect layer ------------------------------------------------
import { spawn } from "bun";
import { readdirSync, readFileSync, existsSync } from "fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn, error as logError } from "./logger.ts";
import { emit as emitAlert } from "./alerts.ts";
import { buildClaudeSpawnArgs } from "./claude-binary.ts";
import { sanitizedEnv } from "./claude.ts";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const DEREK_CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

function phxToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" }).format(new Date());
}

/** Run a command in TMAA_DIR via cmd /c; capture combined output. Static strings only — no interpolated user input. */
async function run(command: string, timeoutMs = 300_000): Promise<{ code: number; out: string }> {
  const proc = spawn(["cmd", "/c", command], {
    cwd: TMAA_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: sanitizedEnv(), // don't leak Atlas secrets; let tmaa's own .env resolution win
  });
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(killer);
  return { code, out: `${stdout}\n${stderr}` };
}

/** Run a command via direct argv — no shell, no cmd.exe expansion. Use for any path carrying
 *  user- or filesystem-derived input (slugs, filenames), since cmd /c string interpolation is
 *  vulnerable even after quote/backslash stripping (%VAR% expansion, ^ & | < > are still live). */
async function runArgv(argv: string[], timeoutMs = 300_000): Promise<{ code: number; out: string }> {
  const proc = spawn(argv, {
    cwd: TMAA_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: sanitizedEnv(), // don't leak Atlas secrets; let tmaa's own .env resolution win
  });
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(killer);
  return { code, out: `${stdout}\n${stderr}` };
}

async function tellDerek(text: string): Promise<void> {
  if (!BOT_TOKEN || !DEREK_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: DEREK_CHAT_ID, text }),
    });
  } catch (err) {
    logError("tmaa-marketing", `telegram send failed: ${err}`);
  }
}

async function sendDerekDocument(filePath: string, caption: string): Promise<void> {
  if (!BOT_TOKEN || !DEREK_CHAT_ID) return;
  try {
    const form = new FormData();
    form.append("chat_id", DEREK_CHAT_ID);
    form.append("caption", caption.slice(0, 1024));
    form.append("document", Bun.file(filePath));
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
  } catch (err) {
    logError("tmaa-marketing", `telegram document send failed: ${err}`);
  }
}

async function alert(supabase: SupabaseClient | null, severity: "warning" | "critical", message: string) {
  warn("tmaa-marketing", message);
  await tellDerek(`TMAA marketing: ${message}`.slice(0, 3500));
  if (supabase) {
    try {
      await emitAlert(supabase, { source: "tmaa-marketing", severity, category: "tmaa", message });
    } catch (err) {
      logError("tmaa-marketing", `alert emit failed: ${err}`);
    }
  }
}

function listBriefs(subdir: string): string[] {
  const dir = join(TMAA_DIR, "briefs", subdir);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}

/** Daily 06:00 — pull, verify, commit state. Silent when healthy. */
export async function runDailyPipeline(supabase: SupabaseClient | null): Promise<void> {
  if (!existsSync(TMAA_DIR)) {
    await alert(supabase, "critical", `repo not found at ${TMAA_DIR}`);
    return;
  }
  const brief = await run("npm run brief");
  if (brief.code !== 0) {
    await alert(supabase, "critical", `daily pull FAILED:\n${tail(brief.out, 10)}`);
    return;
  }
  const verify = await run("npm run verify");
  if (verify.code !== 0) {
    await alert(supabase, "warning", `verify DRIFT — business changed or pull broke:\n${tail(verify.out, 12)}`);
  }
  const dirty = await run("git status --porcelain state/");
  if (dirty.out.trim()) {
    // Sequential argv spawns — cmd /c string interpolation mangles the quoted -m message
    // (observed: "pathspec '2026-08-09' did not match any file(s)"). No shell, no quoting bugs.
    const add = await runArgv(["git", "add", "state/"]);
    if (add.code !== 0) {
      await alert(supabase, "warning", `state commit failed:\n${tail(add.out, 8)}`);
    } else {
      const commitMsg = `state: ${phxToday()} pull (atlas daily)`;
      const commit = await runArgv(["git", "commit", "-m", commitMsg]);
      if (commit.code !== 0) {
        await alert(supabase, "warning", `state commit failed:\n${tail(commit.out, 8)}`);
      } else {
        const push = await runArgv(["git", "push"]);
        if (push.code !== 0) await alert(supabase, "warning", `state commit failed:\n${tail(push.out, 8)}`);
      }
    }
  }
  // read_on reminders — a running bet's number is due today
  const due: string[] = [];
  for (const subdir of ["approved", "done"]) {
    const texts = listBriefs(subdir).map((file) => ({
      file,
      text: readFileSync(join(TMAA_DIR, "briefs", subdir, file), "utf-8"),
    }));
    due.push(...briefsDueToday(texts, phxToday()));
  }
  if (due.length > 0) {
    await tellDerek(`TMAA: time to read the number on ${due.join(", ")} — that bet's read_on date is today.`);
  }
  info("tmaa-marketing", "daily pipeline done");
}

/** Extract the session's text result from `--output-format json` output, falling back to the raw string. */
function extractSessionText(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.result ?? parsed.text ?? raw).trim();
  } catch {
    return raw.trim();
  }
}

async function runHeadlessSession(prompt: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  const args = buildClaudeSpawnArgs(CLAUDE_PATH, ["-p", prompt, "--output-format", "json"]);
  const proc = spawn(args, { cwd: TMAA_DIR, stdout: "pipe", stderr: "pipe", env: sanitizedEnv() });
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(killer);
  return { code, out: `${stdout}\n${stderr}` };
}

/** Monday 06:30 — board session; deliver any new draft as an HTML memo. */
export async function runBoardSession(supabase: SupabaseClient | null): Promise<void> {
  const before = listBriefs("draft");
  const session = await runHeadlessSession(
    "You are running a TMAA board session. Read .claude/agents/tmaa-board.md and follow it exactly: " +
      "read state/ and knowledge/, refuse stale state, make at most one decision, write at most one draft " +
      "brief to briefs/draft/ following briefs/TEMPLATE.md, and audit it with scripts/audit-brief.mjs. " +
      "If you refuse or decline to decide, say why in one paragraph as your final output.",
    45 * 60_000,
  );
  const fresh = diffNewBriefs(before, listBriefs("draft"));
  if (fresh.length === 0) {
    const reason = tail(extractSessionText(session.out), 15) || "(no output)";
    await tellDerek(`TMAA board session made no brief this week. Board says:\n${reason.slice(0, 2000)}`);
    return;
  }
  for (const file of fresh) {
    const mdPath = join(TMAA_DIR, "briefs", "draft", file);
    const render = await runArgv(["node", "scripts/render-brief.mjs", `briefs/draft/${file}`]);
    const slug = file.replace(/\.md$/, "");
    const text = readFileSync(mdPath, "utf-8");
    const title = (text.match(/^# Brief:\s*(.+)$/m) || [null, file])[1];
    const metric = (text.match(/^success:\s*(.+)$/m) || [null, "unknown"])[1];
    const expires = (text.match(/^expires:\s*(\S+)/m) || [null, "unknown"])[1];
    if (render.code === 0 && existsSync(mdPath.replace(/\.md$/, ".html"))) {
      await sendDerekDocument(
        mdPath.replace(/\.md$/, ".html"),
        `TMAA draft brief: ${title}`,
      );
    }
    await tellDerek(
      `The board drafted a brief.\n\n${title}\nThe number: ${metric}\nExpires: ${expires}\n\nReply "approve ${slug}" to run it. It stays in draft/ until you do.`,
    );
  }
  if (supabase) info("tmaa-marketing", `board session delivered ${fresh.length} brief(s)`);
}

/** Relay calls this ONLY for Derek's explicit `approve <slug>` message. */
export async function handleBriefApproval(
  slug: string,
  reply: (text: string) => Promise<unknown>,
): Promise<void> {
  if (!/^[\w.-]+$/.test(slug)) {
    await reply("Invalid slug.");
    return;
  }
  const gate = await runArgv(["node", "scripts/approve-brief.mjs", slug]);
  if (gate.code === 2) {
    await reply(`Not moved. ${tail(gate.out, 3)}`);
    return;
  }
  if (gate.code !== 0) {
    await reply(`approve-brief errored:\n${tail(gate.out, 6)}`);
    return;
  }
  await reply(
    `Approved on your instruction — brief is through the wall. Producer running in the background (up to 45 min) — I'll deliver the copy here when it's done.`,
  );
  // Fire-and-forget: awaiting a 45-min producer session here would stall grammY's
  // sequential update processing long enough to trip the polling watchdog (relay.ts,
  // 5-min stale threshold), which would gracefulShutdown + pm2-restart atlas mid-run
  // and kill the producer. Detach it instead; getUpdates keeps flowing.
  void runProducerSession(reply).catch(async (err) => {
    logError("tmaa-marketing", `producer session failed: ${err}`);
    await reply("Producer session crashed — check logs. The brief remains in approved/.");
  });
}

/** Producer session on the (single) approved brief; deliver the copy. */
export async function runProducerSession(reply: (text: string) => Promise<unknown>): Promise<void> {
  const assetsDir = join(TMAA_DIR, "assets");
  const listAssets = (): string[] => {
    if (!existsSync(assetsDir)) return [];
    return readdirSync(assetsDir, { recursive: true }).map(String);
  };
  const before = listAssets();
  const session = await runHeadlessSession(
    "You are the TMAA producer. Read .claude/agents/tmaa-producer.md and follow it exactly: take the one " +
      "brief in briefs/approved/, produce exactly what its 'What the producer makes' section specifies, " +
      "claim only what 'What the producer may claim' allows, run your evaluator loop, and save deliverables " +
      "under assets/ as the brief directs. You do not send anything — Derek sends. " +
      "If you must refuse, say why in one paragraph as your final output.",
    45 * 60_000,
  );
  const fresh = diffNewBriefs(before, listAssets()).filter((f) => /\.(md|txt|html)$/.test(f));
  if (fresh.length === 0) {
    await reply(`Producer made no deliverable. It says:\n${tail(extractSessionText(session.out), 15).slice(0, 2000)}`);
    return;
  }
  for (const rel of fresh) {
    const full = join(assetsDir, rel);
    const content = readFileSync(full, "utf-8");
    await reply(`Producer deliverable ${rel}:\n\n${content.slice(0, 3500)}`);
  }
  await reply("You send it — the producer never does. Copy above; brief stays in approved/ until the number is read.");
}
