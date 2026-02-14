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
import { callClaude, getSession, saveSessionState, setRuntimeTimeout, getEffectiveTimeout } from "./claude.ts";
import {
  loadAgents,
  getAgentForUser,
  isUserAllowed,
  type AgentRuntime,
} from "./agents.ts";
import { getTodoContext } from "./todo.ts";

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
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  stopCronJobs();
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

  return !!lastSeen && now - lastSeen < DEDUP_WINDOW_MS;
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
        session.sessionId = null;
        session.lastActivity = new Date().toISOString();
        await saveSessionState(agentId, userId, session);
        await ctx.reply("Session cleared. Next message starts fresh.");
        info("command", `Session reset by ${userId}`);
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
      let result: string;

      if (sub === "facts") {
        result = await browseMemory(supabase, { type: "fact" });
      } else if (sub === "goals") {
        result = await browseMemory(supabase, { type: "goal" });
      } else if (sub === "search" && args[1]) {
        result = await browseMemory(supabase, { search: args.slice(1).join(" ") });
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

    case "/help": {
      await ctx.reply(
        "Admin commands:\n" +
        "/ping - alive check\n" +
        "/status - uptime, metrics, health\n" +
        "/session - show current session\n" +
        "/session reset - clear session (fresh context)\n" +
        "/model - show current model\n" +
        "/model <opus|sonnet|haiku> - switch model\n" +
        "/timeout - show/set timeout (seconds)\n" +
        "/memory - browse stored facts and goals\n" +
        "/restart - restart the bot process"
      );
      return true;
    }

    default:
      return false; // Not a known command, pass through to Claude
  }
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from?.id.toString() || "";
  const updateId = ctx.update.update_id;
  trackMessage();

  // Skip updates we already processed before a restart
  if (isStaleUpdate(updateId)) {
    info("dedup", `Skipping stale update ${updateId} (already processed)`);
    return;
  }

  // Handle admin commands first
  if (await handleCommand(ctx, text, userId)) {
    await saveLastUpdateId(updateId);
    return;
  }

  // Skip duplicate messages sent within the dedup window
  if (isDuplicate(userId, text)) {
    info("dedup", `Skipping duplicate from ${userId}: ${text.substring(0, 60)}...`);
    return;
  }

  const agent = resolveAgent(userId);
  const agentId = agent?.config.id || "atlas";
  const agentModel = agent?.config.model || DEFAULT_MODEL;
  const hasMemory = agent?.config.features.memory ?? true;
  const hasResume = agent?.config.features.resume ?? true;
  const hasTodos = agent?.config.features.todos ?? false;

  info("message", `[${agentId}] Text from ${userId}: ${text.substring(0, 80)}...`);

  await ctx.replyWithChatAction("typing");
  await saveMessage("user", text, { agentId });

  // Gather context based on agent features
  const [relevantContext, memoryContext, todoContext] = await Promise.all([
    hasMemory ? getRelevantContext(supabase, text) : "",
    hasMemory ? getMemoryContext(supabase) : "",
    hasTodos ? getTodoContext() : "",
  ]);

  const enrichedPrompt = buildPrompt(text, agent, relevantContext, memoryContext, todoContext);
  const rawResponse = await callClaude(enrichedPrompt, {
    resume: hasResume,
    model: agentModel,
    agentId,
    userId,
    onTyping: () => ctx.replyWithChatAction("typing").catch(() => {}),
    onStatus: (msg) => ctx.reply(msg).catch(() => {}),
  });

  const response = hasMemory
    ? await processMemoryIntents(supabase, rawResponse)
    : rawResponse;

  await saveMessage("assistant", response, { agentId });
  await sendResponse(ctx, response);

  // Persist update ID so we don't re-process this message after a restart
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

  const agent = resolveAgent(userId);
  const agentId = agent?.config.id || "atlas";
  const agentModel = agent?.config.model || DEFAULT_MODEL;
  const hasMemory = agent?.config.features.memory ?? true;
  const hasResume = agent?.config.features.resume ?? true;
  const hasTodos = agent?.config.features.todos ?? false;

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

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`, { agentId });

    const [relevantContext, memoryContext, todoContext] = await Promise.all([
      hasMemory ? getRelevantContext(supabase, transcription) : "",
      hasMemory ? getMemoryContext(supabase) : "",
      hasTodos ? getTodoContext() : "",
    ]);

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      agent,
      relevantContext,
      memoryContext,
      todoContext
    );
    const rawResponse = await callClaude(enrichedPrompt, {
      resume: hasResume,
      model: agentModel,
      agentId,
      userId,
      onTyping: () => ctx.replyWithChatAction("typing").catch(() => {}),
      onStatus: (msg) => ctx.reply(msg).catch(() => {}),
    });
    const claudeResponse = hasMemory
      ? await processMemoryIntents(supabase, rawResponse)
      : rawResponse;

    await saveMessage("assistant", claudeResponse, { agentId });

    // Try to respond with voice, fall back to text
    const audioBuffer = await textToSpeech(claudeResponse);
    if (audioBuffer) {
      await ctx.replyWithVoice(new InputFile(audioBuffer, "response.mp3"));
      // Also send text so it's readable/searchable
      await sendResponse(ctx, claudeResponse);
    } else {
      await sendResponse(ctx, claudeResponse);
    }
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

  const agent = resolveAgent(userId);
  const agentId = agent?.config.id || "atlas";
  const agentModel = agent?.config.model || DEFAULT_MODEL;
  const hasMemory = agent?.config.features.memory ?? true;
  const hasResume = agent?.config.features.resume ?? true;

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
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`, { agentId });

    const claudeResponse = await callClaude(prompt, {
      resume: hasResume,
      model: agentModel,
      agentId,
      userId,
      onTyping: () => ctx.replyWithChatAction("typing").catch(() => {}),
      onStatus: (msg) => ctx.reply(msg).catch(() => {}),
    });

    await unlink(filePath).catch(() => {});

    const cleanResponse = hasMemory
      ? await processMemoryIntents(supabase, claudeResponse)
      : claudeResponse;
    await saveMessage("assistant", cleanResponse, { agentId });
    await sendResponse(ctx, cleanResponse);
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
  trackMessage();

  const agent = resolveAgent(userId);
  const agentId = agent?.config.id || "atlas";
  const agentModel = agent?.config.model || DEFAULT_MODEL;
  const hasMemory = agent?.config.features.memory ?? true;
  const hasResume = agent?.config.features.resume ?? true;

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

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`, { agentId });

    const claudeResponse = await callClaude(prompt, {
      resume: hasResume,
      model: agentModel,
      agentId,
      userId,
      onTyping: () => ctx.replyWithChatAction("typing").catch(() => {}),
      onStatus: (msg) => ctx.reply(msg).catch(() => {}),
    });

    await unlink(filePath).catch(() => {});

    const cleanResponse = hasMemory
      ? await processMemoryIntents(supabase, claudeResponse)
      : claudeResponse;
    await saveMessage("assistant", cleanResponse, { agentId });
    await sendResponse(ctx, cleanResponse);
  } catch (err) {
    logError("document", `Document processing failed: ${err}`);
    await ctx.reply("Could not process document.");
  }
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
  userMessage: string,
  agent: AgentRuntime | null,
  relevantContext?: string,
  memoryContext?: string,
  todoContext?: string
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

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Guard against empty responses (Telegram rejects empty message text)
  if (!response || !response.trim()) {
    warn("send", "Skipping empty response (would cause Telegram 400 error)");
    await ctx.reply("(No response generated. Try again or check /status.)");
    return;
  }

  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

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

// Register command menu with Telegram
bot.api.setMyCommands([
  { command: "ping", description: "Alive check with uptime" },
  { command: "status", description: "Metrics, health, uptime" },
  { command: "session", description: "Show or reset session" },
  { command: "model", description: "Show or switch model" },
  { command: "restart", description: "Restart the bot" },
  { command: "help", description: "List all commands" },
]).catch((err) => warn("startup", `Could not register commands: ${err}`));

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
    },
  });
});
