/**
 * Claude Code Telegram Relay
 *
 * Multi-agent relay connecting Telegram to Claude Code CLI.
 * Routes users to different agent personas with per-agent models,
 * personalities, sessions, and feature flags.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile } from "grammy";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import { textToSpeech } from "./tts.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  browseMemory,
} from "./memory.ts";
import { startCronJobs, stopCronJobs } from "./cron.ts";
import {
  initLogger,
  info,
  warn,
  error as logError,
  trackMessage,
  getMetrics,
  getHealthStatus,
} from "./logger.ts";
import { DEFAULT_MODEL, type ModelTier } from "./constants.ts";
import { callClaude, getSession, saveSessionState, setRuntimeTimeout, getEffectiveTimeout, archiveSessionTranscript, acquireSessionLock, sessionKey } from "./claude.ts";
import {
  loadAgents,
  getAgentForUser,
  isUserAllowed,
  type AgentRuntime,
} from "./agents.ts";
import { getTodoContext } from "./todo.ts";
import {
  initGoogle,
  isGoogleEnabled,
  getGoogleContext,
  processGoogleIntents,
  listUnreadEmails,
  listTodayEvents,
} from "./google.ts";
import { enqueueReply, markDelivered, drainPendingReplies } from "./delivery.ts";
import {
  addEntry,
  accumulate,
  drain,
  formatForPrompt,
  formatAccumulated,
  clearBuffer,
  type PendingMessage,
} from "./conversation.ts";
import {
  getRelevantContext as searchRelevantContext,
  ingestDocument,
  getTodayCosts,
} from "./search.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0);
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  stopCronJobs();
  await saveDedupCache();
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  stopCronJobs();
  await saveDedupCache();
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// Initialize structured logger
initLogger(supabase);

// Load agent configurations
let agentsLoaded = false;
try {
  loadAgents(PROJECT_ROOT);
  agentsLoaded = true;
  info("startup", "Agent configurations loaded");
} catch (err) {
  warn("startup", `Could not load agents.json, using fallback single-user mode: ${err}`);
}

// Initialize Google integration (optional)
if (initGoogle()) {
  info("startup", "Google integration initialized (Gmail + Calendar)");
} else {
  info("startup", "Google integration not configured (missing env vars)");
}

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await supabase.from("messages").insert({
        role,
        content,
        channel: "telegram",
        metadata: metadata || {},
      });
      if (!error) return;
      if (attempt === 0) {
        warn("supabase", `saveMessage failed (retrying): ${error.message}`);
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        logError("supabase", `saveMessage failed after retry: ${error.message}`);
      }
    } catch (err) {
      if (attempt === 1) {
        logError("supabase", `saveMessage exception: ${err}`);
      }
    }
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Route to authorized agents
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();
  if (!userId) return;

  if (agentsLoaded) {
    // Multi-agent mode: check if user is allowed for any agent
    if (!isUserAllowed(userId)) {
      info("security", `Unauthorized: ${userId}`);
      await ctx.reply("This bot is private.");
      return;
    }
  } else {
    // Fallback: single-user mode
    if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
      info("security", `Unauthorized: ${userId}`);
      await ctx.reply("This bot is private.");
      return;
    }
  }

  await next();
});

// ============================================================
// AGENT RESOLUTION HELPER
// ============================================================

function resolveAgent(userId: string): AgentRuntime | null {
  if (agentsLoaded) {
    return getAgentForUser(userId);
  }
  // Fallback: return null (handlers will use defaults)
  return null;
}

// ============================================================
// DEDUPLICATION (ignore rapid resends of the same message)
// ============================================================

const recentMessages: Map<string, number> = new Map();
const DEDUP_WINDOW_MS = 300_000; // 5 minutes (covers long CLI processing cycles)

function isDuplicate(userId: string, text: string): boolean {
  const key = `${userId}:${text.substring(0, 200)}`;
  const lastSeen = recentMessages.get(key);
  const now = Date.now();
  recentMessages.set(key, now);

  // Clean old entries periodically
  if (recentMessages.size > 100) {
    for (const [k, ts] of recentMessages) {
      if (now - ts > DEDUP_WINDOW_MS) recentMessages.delete(k);
    }
  }

  maybeSaveDedupCache();
  return !!lastSeen && now - lastSeen < DEDUP_WINDOW_MS;
}

// Dedup cache persistence: survive restarts without losing dedup state
const DEDUP_CACHE_FILE = join(PROJECT_ROOT, "data", "dedup-cache.json");
let lastDedupSave = 0;
const DEDUP_SAVE_INTERVAL = 30_000; // throttle saves to every 30s

async function loadDedupCache(): Promise<void> {
  try {
    const raw = await readFile(DEDUP_CACHE_FILE, "utf-8");
    const entries: [string, number][] = JSON.parse(raw);
    const now = Date.now();
    let loaded = 0;
    let expired = 0;
    for (const [key, ts] of entries) {
      if (now - ts < DEDUP_WINDOW_MS) {
        recentMessages.set(key, ts);
        loaded++;
      } else {
        expired++;
      }
    }
    info("dedup", `Loaded ${loaded} dedup entries (${expired} expired)`);
  } catch {
    // No cache file or invalid, start fresh
  }
}

async function saveDedupCache(): Promise<void> {
  try {
    const dataDir = join(PROJECT_ROOT, "data");
    await mkdir(dataDir, { recursive: true });
    const entries = Array.from(recentMessages.entries());
    await writeFile(DEDUP_CACHE_FILE, JSON.stringify(entries));
    lastDedupSave = Date.now();
  } catch (err) {
    warn("dedup", `Failed to save dedup cache: ${err}`);
  }
}

// Throttled save: call inside isDuplicate to persist periodically
function maybeSaveDedupCache(): void {
  if (Date.now() - lastDedupSave > DEDUP_SAVE_INTERVAL) {
    saveDedupCache().catch(() => {});
  }
}

// ============================================================
// UPDATE ID PERSISTENCE (survive restarts without re-processing)
// ============================================================

const OFFSET_FILE = join(PROJECT_ROOT, ".last_update_id");

async function loadLastUpdateId(): Promise<number> {
  try {
    const data = await readFile(OFFSET_FILE, "utf-8");
    return parseInt(data.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function saveLastUpdateId(updateId: number): Promise<void> {
  try {
    await writeFile(OFFSET_FILE, String(updateId), "utf-8");
  } catch (e) {
    warn("offset", `Failed to save update ID: ${e}`);
  }
}

let lastProcessedUpdateId = 0;

function isStaleUpdate(updateId: number): boolean {
  return updateId <= lastProcessedUpdateId;
}

// ============================================================
// ADMIN COMMANDS (intercepted before Claude)
// ============================================================

const BOT_START_TIME = Date.now();

async function handleCommand(ctx: Context, text: string, userId: string): Promise<boolean> {
  const lower = text.toLowerCase().trim();
  if (!lower.startsWith("/")) return false;

  const [cmd, ...args] = lower.split(/\s+/);
  const agent = resolveAgent(userId);
  const agentId = agent?.config.id || "atlas";

  switch (cmd) {
    case "/restart": {
      await ctx.reply("Restarting in 2 seconds...");
      info("command", `Restart requested by ${userId}`);
      // Gracefully stop the bot so grammy acknowledges processed updates
      // to Telegram (commits the offset). Without this, Telegram re-delivers
      // all pending messages on restart, including /restart itself, causing
      // an infinite restart loop.
      try {
        stopCronJobs();
        await saveDedupCache();
        await bot.stop();
      } catch (e) {
        warn("command", `Error during graceful stop: ${e}`);
      }
      setTimeout(() => process.exit(0), 1000);
      return true;
    }

    case "/status": {
      const m = getMetrics();
      const h = getHealthStatus();
      const uptimeMs = Date.now() - BOT_START_TIME;
      const uptimeH = Math.floor(uptimeMs / 3_600_000);
      const uptimeM = Math.floor((uptimeMs % 3_600_000) / 60_000);
      const avgSec = m.avgResponseMs > 0 ? (m.avgResponseMs / 1000).toFixed(1) : "n/a";

      const lines = [
        `${h.status === "healthy" ? "OK" : h.status.toUpperCase()} | Uptime: ${uptimeH}h ${uptimeM}m`,
        `Messages: ${m.messageCount} | Claude calls: ${m.claudeCallCount}`,
        `Timeouts: ${m.claudeTimeoutCount} | Errors: ${m.errorCount}`,
        `Avg response: ${avgSec}s`,
      ];

      // Search cost tracking (if available)
      const costs = await getTodayCosts(supabase);
      if (costs.embeddings > 0 || costs.searches > 0) {
        lines.push(
          `Search: $${costs.totalCostUsd.toFixed(4)} today (${costs.embeddings} embeds, ${costs.searches} searches)`
        );
      }

      if (h.issues.length > 0) {
        lines.push("", "Issues:", ...h.issues.map((i) => `  - ${i}`));
      }
      await ctx.reply(lines.join("\n"));
      return true;
    }

    case "/session": {
      const sub = args[0];
      const session = await getSession(agentId, userId);

      if (sub === "reset" || sub === "clear") {
        const oldSessionId = session.sessionId;
        session.sessionId = null;
        session.lastActivity = new Date().toISOString();
        await saveSessionState(agentId, userId, session);
        // Clear conversation ring buffer alongside session
        const sKey = sessionKey(agentId, userId);
        await clearBuffer(sKey);
        await ctx.reply("Session cleared. Next message starts fresh.");
        info("command", `Session reset by ${userId} (was: ${oldSessionId || "none"})`);
        if (oldSessionId) {
          archiveSessionTranscript(oldSessionId, agentId, userId).catch(() => {});
        }
      } else {
        const sid = session.sessionId || "none";
        const lastAct = session.lastActivity
          ? new Date(session.lastActivity).toLocaleString("en-US", { timeZone: USER_TIMEZONE })
          : "never";
        await ctx.reply(`Session: ${sid}\nLast activity: ${lastAct}\n\nUse /session reset to clear.`);
      }
      return true;
    }

    case "/ping": {
      const uptimeMs = Date.now() - BOT_START_TIME;
      const uptimeM = Math.floor(uptimeMs / 60_000);
      await ctx.reply(`Pong. Up ${uptimeM}m.`);
      return true;
    }

    case "/model": {
      const requested = args[0];
      if (!requested) {
        const current = agent?.config.model || DEFAULT_MODEL;
        await ctx.reply(`Current model: ${current}\n\nUsage: /model <opus|sonnet|haiku>`);
      } else if (["opus", "sonnet", "haiku"].includes(requested)) {
        // Runtime model override via agent config
        if (agent) {
          agent.config.model = requested as ModelTier;
          await ctx.reply(`Model switched to ${requested}. Takes effect on next message.`);
          info("command", `Model changed to ${requested} by ${userId}`);
        } else {
          await ctx.reply("No agent config to modify. Model stays at default.");
        }
      } else {
        await ctx.reply("Unknown model. Options: opus, sonnet, haiku");
      }
      return true;
    }

    case "/timeout": {
      const requested = args[0];
      const currentModel = agent?.config.model || DEFAULT_MODEL;
      if (!requested) {
        const eff = getEffectiveTimeout(currentModel);
        await ctx.reply(
          `Model: ${currentModel}\n` +
          `Effective timeout: ${Math.round(eff / 1000)}s\n\n` +
          `Usage: /timeout <seconds> - override base timeout\n` +
          `/timeout reset - restore default`
        );
      } else if (requested === "reset") {
        setRuntimeTimeout(null);
        const eff = getEffectiveTimeout(currentModel);
        await ctx.reply(`Timeout reset to default. Effective: ${Math.round(eff / 1000)}s for ${currentModel}.`);
        info("command", `Timeout reset by ${userId}`);
      } else {
        const secs = parseInt(requested, 10);
        if (isNaN(secs) || secs < 30 || secs > 1800) {
          await ctx.reply("Timeout must be between 30 and 1800 seconds.");
        } else {
          setRuntimeTimeout(secs * 1000);
          const eff = getEffectiveTimeout(currentModel);
          await ctx.reply(`Base timeout set to ${secs}s. Effective for ${currentModel}: ${Math.round(eff / 1000)}s.`);
          info("command", `Timeout set to ${secs}s by ${userId}`);
        }
      }
      return true;
    }

    case "/memory": {
      const sub = args[0];
      const hasSearch = agent?.config.features.search ?? false;
      let result: string;

      if (sub === "facts") {
        result = await browseMemory(supabase, { type: "fact" });
      } else if (sub === "goals") {
        result = await browseMemory(supabase, { type: "goal" });
      } else if (sub === "search" && args[1]) {
        result = await browseMemory(supabase, {
          search: args.slice(1).join(" "),
          useEnterpriseSearch: hasSearch,
        });
      } else if (sub === "all") {
        result = await browseMemory(supabase, { limit: 30 });
      } else {
        result = await browseMemory(supabase);
        result += "\n\nUsage: /memory [facts|goals|all|search <term>]";
      }

      // Truncate for Telegram's 4096 char limit
      if (result.length > 4000) {
        result = result.substring(0, 3997) + "...";
      }
      await ctx.reply(result);
      return true;
    }

    case "/ingest": {
      const hasSearch = agent?.config.features.search ?? false;
      if (!hasSearch || !supabase) {
        await ctx.reply("Search not enabled. Set search: true in agents.json.");
        return true;
      }

      const content = args.join(" ");
      if (!content) {
        await ctx.reply("Usage: /ingest <text to add to knowledge base>\n\nOr send a .txt/.md file.");
        return true;
      }

      await ctx.replyWithChatAction("typing");
      const result = await ingestDocument(supabase, content, { source: "manual" });

      if (result.error) {
        await ctx.reply(`Ingest failed: ${result.error}`);
      } else if (result.chunks_skipped > 0) {
        await ctx.reply("Already ingested (duplicate content).");
      } else {
        await ctx.reply(`Ingested: ${result.chunks_created} chunk(s) created.`);
      }
      info("ingest", `Manual ingest: ${result.chunks_created} chunks, ${result.chunks_skipped} skipped`);
      return true;
    }

    case "/inbox": {
      if (!isGoogleEnabled()) {
        await ctx.reply("Google not configured. Run: bun run setup/google-auth.ts");
        return true;
      }
      await ctx.replyWithChatAction("typing");
      try {
        const emails = await listUnreadEmails(10);
        if (emails.length === 0) {
          await ctx.reply("Inbox zero. No unread emails.");
        } else {
          const lines = emails.map((e, i) =>
            `${i + 1}. ${e.from}\n   ${e.subject}\n   ${e.date}`
          );
          await ctx.reply(`Unread emails (${emails.length}):\n\n${lines.join("\n\n")}`);
        }
      } catch (err) {
        logError("google", `Inbox command failed: ${err}`);
        await ctx.reply("Failed to fetch inbox. Check logs.");
      }
      return true;
    }

    case "/cal":
    case "/calendar": {
      if (!isGoogleEnabled()) {
        await ctx.reply("Google not configured. Run: bun run setup/google-auth.ts");
        return true;
      }
      await ctx.replyWithChatAction("typing");
      try {
        const events = await listTodayEvents();
        if (events.length === 0) {
          await ctx.reply("No events today. Calendar is clear.");
        } else {
          const lines = events.map((e) => {
            const who = e.attendees?.length ? ` (with: ${e.attendees.join(", ")})` : "";
            return `${e.start}-${e.end} ${e.title}${who}`;
          });
          await ctx.reply(`Today's calendar:\n\n${lines.join("\n")}`);
        }
      } catch (err) {
        logError("google", `Calendar command failed: ${err}`);
        await ctx.reply("Failed to fetch calendar. Check logs.");
      }
      return true;
    }

    case "/help": {
      await ctx.reply(
        "Admin commands:\n" +
        "/ping - alive check\n" +
        "/status - uptime, metrics, health, search costs\n" +
        "/session - show current session\n" +
        "/session reset - clear session (fresh context)\n" +
        "/model - show current model\n" +
        "/model <opus|sonnet|haiku> - switch model\n" +
        "/timeout - show/set timeout (seconds)\n" +
        "/memory - browse stored facts and goals\n" +
        "/ingest - add text to knowledge base\n" +
        "/inbox - unread emails\n" +
        "/cal - today's calendar\n" +
        "/restart - restart the bot process"
      );
      return true;
    }

    default:
      return false; // Not a known command, pass through to Claude
  }
}

// ============================================================
// PRE-PROMPT DIAGNOSTICS (OpenClaw #8930)
// ============================================================

function logPrePrompt(
  prompt: string,
  agentId: string,
  model: string,
  sessionId: string | null,
  isResume: boolean
): void {
  info("pre-prompt",
    `[${agentId}] chars=${prompt.length} model=${model} ` +
    `session=${sessionId || "new"} resume=${isResume}`
  );
}

// ============================================================
// UNIFIED MESSAGE HANDLER
// ============================================================

/**
 * Core message processing pipeline. All message types (text, voice, photo,
 * document) flow through this single function. This guarantees:
 *
 * 1. Messages accumulate while Claude is busy (no lost replies)
 * 2. Context is gathered AFTER lock acquisition (always fresh)
 * 3. Conversation ring buffer gives Claude recent turn history
 * 4. All message types get the same context enrichment
 */
async function handleUserMessage(
  ctx: Context,
  userId: string,
  message: {
    text: string;
    type: "text" | "voice" | "photo" | "document";
    filePath?: string;
    cleanupFile?: string; // file to delete after processing (uploaded photos/docs)
  }
): Promise<void> {
  const agent = resolveAgent(userId);
  const agentId = agent?.config.id || "atlas";
  const agentModel = agent?.config.model || DEFAULT_MODEL;
  const hasMemory = agent?.config.features.memory ?? true;
  const hasResume = agent?.config.features.resume ?? true;
  const hasTodos = agent?.config.features.todos ?? false;
  const hasGoogle = (agent?.config.features.google ?? false) && isGoogleEnabled();
  const hasSearch = agent?.config.features.search ?? false;
  const key = sessionKey(agentId, userId);

  // 1. Save to Supabase immediately (keeps semantic search as fresh as possible)
  await saveMessage("user", message.text, { agentId });

  // 2. Add to conversation ring buffer immediately (survives restarts)
  await addEntry(key, {
    role: "user",
    content: message.text,
    timestamp: new Date().toISOString(),
    type: message.type,
  });

  // 3. Push to accumulator (will be drained after lock acquisition)
  accumulate(key, {
    text: message.text,
    type: message.type,
    filePath: message.filePath,
    timestamp: new Date().toISOString(),
  });

  // 4. Acquire session lock (may wait if Claude is busy processing another message)
  const { acquired, release } = await acquireSessionLock(key, "wait");
  if (!acquired) return;

  try {
    // 5. Drain ALL accumulated messages (ours + any that arrived while waiting)
    const pending = drain(key);

    // 6. Gather FRESH context now (after lock, guaranteed up-to-date)
    const searchQuery = pending.map((m) => m.text).join(" ");
    const [relevantContext, memoryContext, todoContext, googleContext] = await Promise.all([
      hasMemory ? getRelevantContext(supabase, searchQuery, hasSearch) : "",
      hasMemory ? getMemoryContext(supabase) : "",
      hasTodos ? getTodoContext() : "",
      hasGoogle ? getGoogleContext() : "",
    ]);

    // 7. Get conversation history from ring buffer (exclude current turn's messages to avoid duplication)
    const conversationContext = await formatForPrompt(key, pending.length);

    // 8. Build prompt with fresh context + conversation history + accumulated messages
    const enrichedPrompt = buildPrompt(
      pending,
      agent,
      relevantContext,
      memoryContext,
      todoContext,
      googleContext,
      conversationContext
    );
    const session = await getSession(agentId, userId);
    logPrePrompt(enrichedPrompt, agentId, agentModel, session.sessionId, hasResume && !!session.sessionId);

    // 9. Call Claude (skipLock since we already hold it)
    const rawResponse = await callClaude(enrichedPrompt, {
      resume: hasResume,
      model: agentModel,
      agentId,
      userId,
      skipLock: true,
      onTyping: () => ctx.replyWithChatAction("typing").catch(() => {}),
      onStatus: (msg) => ctx.reply(msg).catch(() => {}),
    });

    // 10. Add assistant response to ring buffer (skip empty/error responses)
    if (rawResponse && rawResponse.trim() && !rawResponse.startsWith("Error:") && !rawResponse.startsWith("Sorry, that took too long")) {
      await addEntry(key, {
        role: "assistant",
        content: rawResponse,
        timestamp: new Date().toISOString(),
      });
    }

    // 11. Post-process (memory intents, google intents)
    let response = hasMemory
      ? await processMemoryIntents(supabase, rawResponse)
      : rawResponse;

    if (hasGoogle) {
      response = await processGoogleIntents(response);
    }

    // 12. Save + deliver
    await saveMessage("assistant", response, { agentId });
    await sendResponse(ctx, response);
  } finally {
    release();

    // Cleanup uploaded files after processing
    if (message.cleanupFile) {
      await unlink(message.cleanupFile).catch(() => {});
    }
  }
}

// ============================================================
// MESSAGE HANDLERS (thin wrappers around handleUserMessage)
// ============================================================

// Text messages
// BACKSLASH SAFETY: User message text passes to Claude as-is.
// No backslash normalization is applied. Internal paths use path.join().
// See OpenClaw #11547 for context on this pattern.
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from?.id.toString() || "";
  const updateId = ctx.update.update_id;
  trackMessage();

  if (isStaleUpdate(updateId)) {
    info("dedup", `Skipping stale update ${updateId} (already processed)`);
    return;
  }

  if (await handleCommand(ctx, text, userId)) {
    await saveLastUpdateId(updateId);
    return;
  }

  if (isDuplicate(userId, text)) {
    info("dedup", `Skipping duplicate from ${userId}: ${text.substring(0, 60)}...`);
    return;
  }

  const agentId = resolveAgent(userId)?.config.id || "atlas";
  info("message", `[${agentId}] Text from ${userId}: ${text.substring(0, 80)}...`);
  await ctx.replyWithChatAction("typing");

  await handleUserMessage(ctx, userId, { text, type: "text" });
  await saveLastUpdateId(updateId);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  const userId = ctx.from?.id.toString() || "";
  const updateId = ctx.update.update_id;
  trackMessage();

  if (isStaleUpdate(updateId)) {
    info("dedup", `Skipping stale voice update ${updateId}`);
    return;
  }

  const agentId = resolveAgent(userId)?.config.id || "atlas";
  info("message", `[${agentId}] Voice from ${userId}: ${voice.duration}s`);
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    await handleUserMessage(ctx, userId, {
      text: `[Voice message transcribed]: ${transcription}`,
      type: "voice",
    });

    // Voice response: try TTS after handleUserMessage has already sent text
    // Note: TTS is best-effort, text response is already delivered above
  } catch (err) {
    logError("voice", `Voice processing failed: ${err}`);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
  await saveLastUpdateId(updateId);
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  const userId = ctx.from?.id.toString() || "";
  const updateId = ctx.update.update_id;
  trackMessage();

  if (isStaleUpdate(updateId)) {
    info("dedup", `Skipping stale photo update ${updateId}`);
    return;
  }

  const agentId = resolveAgent(userId)?.config.id || "atlas";
  info("message", `[${agentId}] Image from ${userId}`);
  await ctx.replyWithChatAction("typing");

  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || "Analyze this image.";

    await handleUserMessage(ctx, userId, {
      text: `[Image: ${filePath}]\n\n${caption}`,
      type: "photo",
      filePath,
      cleanupFile: filePath,
    });
  } catch (err) {
    logError("image", `Image processing failed: ${err}`);
    await ctx.reply("Could not process image.");
  }
  await saveLastUpdateId(updateId);
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const userId = ctx.from?.id.toString() || "";
  const updateId = ctx.update.update_id;
  trackMessage();

  if (isStaleUpdate(updateId)) {
    info("dedup", `Skipping stale document update ${updateId}`);
    return;
  }

  const agentId = resolveAgent(userId)?.config.id || "atlas";
  info("message", `[${agentId}] Document from ${userId}: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Auto-ingest text documents into knowledge base when search is enabled
    const agent = resolveAgent(userId);
    const hasSearch = agent?.config.features.search ?? false;
    const isTextDoc = /\.(txt|md|markdown)$/i.test(fileName);

    if (hasSearch && isTextDoc && supabase) {
      try {
        const textContent = Buffer.from(buffer).toString("utf-8");
        const result = await ingestDocument(supabase, textContent, {
          source: "telegram",
          sourcePath: fileName,
          title: fileName.replace(/\.[^/.]+$/, ""),
        });
        if (result.chunks_created > 0) {
          info("ingest", `Auto-ingested ${fileName}: ${result.chunks_created} chunks`);
        }
      } catch (err) {
        warn("ingest", `Auto-ingest failed for ${fileName}: ${err}`);
      }
    }

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;

    await handleUserMessage(ctx, userId, {
      text: `[File: ${filePath}]\n\n${caption}`,
      type: "document",
      filePath,
      cleanupFile: filePath,
    });
  } catch (err) {
    logError("document", `Document processing failed: ${err}`);
    await ctx.reply("Could not process document.");
  }
  await saveLastUpdateId(updateId);
});

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  pendingMessages: PendingMessage[],
  agent: AgentRuntime | null,
  relevantContext?: string,
  memoryContext?: string,
  todoContext?: string,
  googleContext?: string,
  conversationContext?: string
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Use agent's system prompt or fall back to default
  const systemPrompt = agent?.config.systemPrompt ||
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.";
  const parts = [systemPrompt];

  // Inject agent personality if available
  if (agent?.personality) parts.push(`\n${agent.personality}`);

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);

  // Conversation history (recent turns for continuity)
  if (conversationContext) parts.push(`\n${conversationContext}`);

  const hasMemory = agent?.config.features.memory ?? true;
  const hasTodos = agent?.config.features.todos ?? false;

  if (hasMemory && memoryContext) parts.push(`\n${memoryContext}`);
  if (hasMemory && relevantContext) parts.push(`\n${relevantContext}`);
  if (hasTodos && todoContext) parts.push(`\n${todoContext}`);

  if (hasMemory) {
    parts.push(
      "\nMEMORY MANAGEMENT:" +
        "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
        "include these tags in your response (they are processed automatically and hidden from the user):" +
        "\n[REMEMBER: fact to store]" +
        "\n[GOAL: goal text | DEADLINE: optional date]" +
        "\n[DONE: search text for completed goal]"
    );
  }

  if (hasTodos) {
    parts.push(
      "\nTASK MANAGEMENT:" +
        "\nWhen the user mentions a task, to-do, or action item, use these tags:" +
        "\n[TODO: task description as next physical action]" +
        "\n[TODO_DONE: search text matching completed task]" +
        "\nThese are parsed automatically, added to the Obsidian MASTER TODO, and hidden from the user."
    );
  }

  const hasGoogle = agent?.config.features.google ?? false;

  if (hasGoogle && googleContext) parts.push(`\n${googleContext}`);

  if (hasGoogle) {
    parts.push(
      "\nGOOGLE INTEGRATION:" +
        "\nYou have access to Derek's Gmail (read + draft), Google Calendar, and Google Contacts." +
        "\nYou also have your own Gmail account (assistant.ai.atlas@gmail.com) that can send emails." +
        "\nDerek's contacts are listed in the context above. Use them to resolve names to email addresses." +
        "\nWhen the user says 'email Esther' or 'invite John', look up the email from the CONTACTS list." +
        "\nUse these tags in your response (processed automatically, hidden from the user):" +
        "\n[DRAFT: to=email@example.com | subject=Subject line | body=Full email body text]" +
        "\n  Creates a draft in Derek's Gmail. Never sends." +
        "\n[SEND: to=email@example.com | subject=Subject line | body=Full email body text]" +
        "\n  Sends an email from your Atlas account (assistant.ai.atlas@gmail.com)." +
        "\n[CAL_ADD: title=Event title | date=YYYY-MM-DD | time=HH:MM | duration=minutes | invite=email@example.com]" +
        "\n  Creates a calendar event. Sends invites to attendees if provided. Duration defaults to 60 min." +
        "\n[CAL_REMOVE: search text matching event title]" +
        "\n  Deletes the first matching event in the next 30 days."
    );
  }

  // User message(s) — single or accumulated
  const userSection = formatAccumulated(pendingMessages);
  parts.push(`\n${userSection}`);

  return parts.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Guard against empty responses (Telegram rejects empty message text)
  if (!response || !response.trim()) {
    warn("send", "Skipping empty response (would cause Telegram 400 error)");
    await ctx.reply("(No response generated. Try again or check /status.)");
    return;
  }

  // Write-ahead: persist before delivery so we can retry on crash
  const chatId = String(ctx.chat?.id || "");
  const deliveryId = chatId ? await enqueueReply(chatId, response) : null;

  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
  } else {
    const chunks = [];
    let remaining = response;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = MAX_LENGTH;

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trim();
    }

    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  }

  // Mark delivered after successful send
  if (deliveryId) {
    await markDelivered(deliveryId);
  }
}

// ============================================================
// ERROR HANDLER
// ============================================================

bot.catch((err) => {
  const ctx = err.ctx;
  const e = err.error;

  // 409 = two bot instances polling simultaneously. Log and don't crash.
  if (e && typeof e === "object" && "error_code" in e && (e as any).error_code === 409) {
    logError("grammy", "409 conflict: another bot instance is polling. Will retry.");
    return;
  }

  logError("grammy", `Error handling update ${ctx.update.update_id}: ${e}`);
  ctx.reply("Something went wrong. I've logged the error.").catch(() => {});
});

// ============================================================
// START
// ============================================================

info("startup", "Starting Atlas Telegram Relay...");
if (agentsLoaded) {
  info("startup", "Multi-agent mode active");
} else {
  info("startup", `Fallback single-user mode: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
}
info("startup", `Project directory: ${process.env.PROJECT_DIR || "(relay working directory)"}`);
info("startup", `Claude timeout: ${(parseInt(process.env.CLAUDE_TIMEOUT_MS || "120000", 10)) / 1000}s`);

// Register command menu with Telegram (cap at 100 per Telegram limit, OpenClaw #15844)
const botCommands = [
  { command: "ping", description: "Alive check with uptime" },
  { command: "status", description: "Metrics, health, search costs" },
  { command: "session", description: "Show or reset session" },
  { command: "model", description: "Show or switch model" },
  { command: "memory", description: "Browse facts, goals, search" },
  { command: "ingest", description: "Add text to knowledge base" },
  { command: "inbox", description: "Show unread emails" },
  { command: "cal", description: "Today's calendar events" },
  { command: "restart", description: "Restart the bot" },
  { command: "help", description: "List all commands" },
];
if (botCommands.length > 100) {
  warn("startup", `${botCommands.length} commands exceeds Telegram's 100 limit. Truncating.`);
  botCommands.length = 100;
}
bot.api.setMyCommands(botCommands)
  .catch((err) => warn("startup", `Could not register commands: ${err}`));

// Load persisted dedup cache (survive restarts without losing dedup state)
loadDedupCache();

// Start cron jobs (pass supabase for heartbeat memory context)
startCronJobs(supabase);

// Load persisted update offset to skip already-processed messages after restart
loadLastUpdateId().then((id) => {
  lastProcessedUpdateId = id;
  info("startup", `Loaded last update ID: ${id}`);

  // Use drop_pending_updates when we have no saved offset (crash recovery).
  // This prevents re-processing stale messages (including /restart) that
  // caused infinite restart loops when grammy couldn't acknowledge them.
  const dropPending = id === 0;
  if (dropPending) {
    warn("startup", "No saved update ID found. Dropping pending updates to avoid replay loops.");
  }

  bot.start({
    drop_pending_updates: dropPending,
    onStart: () => {
      info("startup", "Bot is running!");
      // Drain any replies that were enqueued but not delivered before the last crash
      drainPendingReplies(async (chatId, text) => {
        await bot.api.sendMessage(chatId, text);
      }).catch((err) => warn("delivery", `Failed to drain pending replies: ${err}`));
    },
  });
});
