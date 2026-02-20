/**
 * Atlas -- Lifecycle Hook System (OpenClaw gateway pattern)
 *
 * Decouples cross-cutting behavior (memory loading, result delivery,
 * run logging, startup recovery) from core relay/cron code.
 *
 * Hook points:
 *   session-start  -- After lock acquired, before context gathering
 *   session-end    -- After response processed, before lock release
 *   cron-before    -- Before a cron job executes
 *   cron-after     -- After a cron job completes (success or failure)
 *   task-complete  -- When a supervised task finishes
 *   startup        -- On Atlas boot (after bot.start succeeds)
 *
 * Hooks are async functions registered by name. Execution order
 * is controlled by the `order` field (lower = earlier). Hooks at
 * the same order run concurrently.
 *
 * Configuration lives in config/hooks.json. Hooks not listed there
 * are disabled by default. Built-in hooks register themselves at
 * import time; the config file controls which ones actually fire.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { info, warn, error as logError } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const HOOKS_CONFIG_PATH = join(PROJECT_DIR, "config", "hooks.json");

// ============================================================
// TYPES
// ============================================================

export type HookPoint =
  | "session-start"
  | "session-end"
  | "cron-before"
  | "cron-after"
  | "task-complete"
  | "startup";

export interface HookContext {
  /** Which hook point triggered this */
  point: HookPoint;

  /** Timestamp when the hook was fired */
  ts: number;

  // -- Session hooks --
  /** Session key (agentId:userId) */
  sessionKey?: string;
  /** Agent ID */
  agentId?: string;
  /** User ID */
  userId?: string;
  /** The user's message text (session-start) */
  messageText?: string;
  /** Claude's response text (session-end) */
  responseText?: string;
  /** Session duration in ms (session-end) */
  durationMs?: number;

  // -- Cron hooks --
  /** Cron job name */
  jobName?: string;
  /** Cron job status (cron-after only) */
  jobStatus?: "ok" | "error" | "timeout" | "skipped";
  /** Cron job duration in ms (cron-after only) */
  jobDurationMs?: number;
  /** Cron job error message (cron-after only, on failure) */
  jobError?: string;

  // -- Task hooks --
  /** Supervised task (task-complete) */
  task?: any;

  // -- Extensible --
  /** Arbitrary data passed by the caller */
  data?: Record<string, any>;
}

export interface Hook {
  /** Unique name for this hook */
  name: string;
  /** Which lifecycle point it runs at */
  point: HookPoint;
  /** Handler function */
  handler: (ctx: HookContext) => Promise<void>;
  /** Execution priority (lower = earlier, default 100) */
  order: number;
  /** Description (for /hooks command) */
  description?: string;
}

/** Configuration from config/hooks.json */
interface HooksConfig {
  [point: string]: string[]; // hook point -> list of enabled hook names
}

// ============================================================
// REGISTRY
// ============================================================

/** All registered hooks (keyed by name for dedup) */
const registry = new Map<string, Hook>();

/** Cached config (loaded once at startup, reloadable) */
let config: HooksConfig = {};
let configLoaded = false;

/** Register a hook. If a hook with the same name exists, it's replaced. */
export function registerHook(hook: Hook): void {
  registry.set(hook.name, hook);
}

/** Unregister a hook by name. */
export function unregisterHook(name: string): void {
  registry.delete(name);
}

/** Load (or reload) hooks config from disk. */
export function loadHooksConfig(): HooksConfig {
  try {
    if (!existsSync(HOOKS_CONFIG_PATH)) {
      info("hooks", "No config/hooks.json found, all registered hooks enabled by default");
      configLoaded = true;
      config = {};
      return config;
    }
    const raw = readFileSync(HOOKS_CONFIG_PATH, "utf-8");
    config = JSON.parse(raw) as HooksConfig;
    configLoaded = true;

    const totalEnabled = Object.values(config).flat().length;
    info("hooks", `Loaded hooks config: ${totalEnabled} hook(s) enabled across ${Object.keys(config).length} point(s)`);
    return config;
  } catch (err) {
    warn("hooks", `Failed to load hooks config: ${err}`);
    config = {};
    configLoaded = true;
    return config;
  }
}

/** Check if a specific hook is enabled for a given point. */
function isHookEnabled(hookName: string, point: HookPoint): boolean {
  if (!configLoaded) loadHooksConfig();

  // If no config file exists, all hooks are enabled
  if (Object.keys(config).length === 0 && !existsSync(HOOKS_CONFIG_PATH)) {
    return true;
  }

  const enabledList = config[point];
  if (!enabledList) return false;
  return enabledList.includes(hookName);
}

// ============================================================
// EXECUTOR
// ============================================================

/**
 * Fire all enabled hooks for a given lifecycle point.
 *
 * Hooks at the same `order` value run concurrently (Promise.allSettled).
 * Different order values run sequentially (lower first).
 *
 * Never throws. Failures are logged but don't block the caller.
 */
export async function fireHooks(point: HookPoint, ctx: Partial<HookContext> = {}): Promise<void> {
  const fullCtx: HookContext = {
    point,
    ts: Date.now(),
    ...ctx,
  };

  // Collect enabled hooks for this point
  const hooks: Hook[] = [];
  for (const hook of registry.values()) {
    if (hook.point === point && isHookEnabled(hook.name, point)) {
      hooks.push(hook);
    }
  }

  if (hooks.length === 0) return;

  // Group by order
  const byOrder = new Map<number, Hook[]>();
  for (const hook of hooks) {
    const group = byOrder.get(hook.order) || [];
    group.push(hook);
    byOrder.set(hook.order, group);
  }

  // Execute in order
  const sortedOrders = [...byOrder.keys()].sort((a, b) => a - b);
  for (const order of sortedOrders) {
    const group = byOrder.get(order)!;
    const results = await Promise.allSettled(
      group.map(async (hook) => {
        const start = Date.now();
        try {
          await hook.handler(fullCtx);
          const dur = Date.now() - start;
          if (dur > 5000) {
            warn("hooks", `Hook "${hook.name}" at ${point} took ${dur}ms`);
          }
        } catch (err) {
          logError("hooks", `Hook "${hook.name}" at ${point} failed: ${err}`);
          throw err;
        }
      })
    );

    // Log any rejections (already logged above, but track count)
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      warn("hooks", `${failures.length}/${group.length} hook(s) failed at ${point} (order ${order})`);
    }
  }
}

// ============================================================
// QUERY / FORMAT (for /hooks command)
// ============================================================

/** List all registered hooks with enabled status. */
export function listHooks(): { name: string; point: HookPoint; enabled: boolean; order: number; description?: string }[] {
  if (!configLoaded) loadHooksConfig();

  const result: { name: string; point: HookPoint; enabled: boolean; order: number; description?: string }[] = [];
  for (const hook of registry.values()) {
    result.push({
      name: hook.name,
      point: hook.point,
      enabled: isHookEnabled(hook.name, hook.point),
      order: hook.order,
      description: hook.description,
    });
  }
  return result.sort((a, b) => {
    if (a.point !== b.point) return a.point.localeCompare(b.point);
    return a.order - b.order;
  });
}

/** Format hooks list for Telegram display. */
export function formatHooksList(): string {
  const hooks = listHooks();
  if (hooks.length === 0) return "No hooks registered.";

  const lines: string[] = ["Lifecycle Hooks:\n"];

  // Group by point
  const byPoint = new Map<HookPoint, typeof hooks>();
  for (const h of hooks) {
    const group = byPoint.get(h.point) || [];
    group.push(h);
    byPoint.set(h.point, group);
  }

  const pointOrder: HookPoint[] = ["startup", "session-start", "session-end", "cron-before", "cron-after", "task-complete"];
  for (const point of pointOrder) {
    const group = byPoint.get(point);
    if (!group) continue;

    lines.push(`[${point}]`);
    for (const h of group) {
      const status = h.enabled ? "ON" : "OFF";
      const desc = h.description ? ` -- ${h.description}` : "";
      lines.push(`  ${status} ${h.name} (order: ${h.order})${desc}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ============================================================
// BUILT-IN HOOKS
// ============================================================
// These register themselves. They only fire if enabled in config/hooks.json.

/**
 * log-session-timing (session-end)
 * Logs session duration for performance tracking.
 */
registerHook({
  name: "log-session-timing",
  point: "session-end",
  order: 90,
  description: "Log session response time to journal",
  handler: async (ctx) => {
    if (ctx.durationMs && ctx.durationMs > 30000) {
      info("hooks:timing", `Slow session: ${ctx.sessionKey} took ${Math.round(ctx.durationMs / 1000)}s`);
    }
  },
});

/**
 * log-cron-run (cron-after)
 * Appends to JSONL run log. This replaces the direct appendRun() call
 * in safeTick() when hooks are fully wired. For now both coexist.
 */
registerHook({
  name: "log-cron-run",
  point: "cron-after",
  order: 10,
  description: "Log cron job execution to JSONL run log",
  handler: async (ctx) => {
    // Import dynamically to avoid circular deps
    const { appendRun } = await import("./run-log.ts");
    if (ctx.jobName) {
      appendRun(ctx.jobName, {
        ts: ctx.ts,
        jobName: ctx.jobName,
        status: ctx.jobStatus || "ok",
        durationMs: ctx.jobDurationMs || 0,
        error: ctx.jobError,
      });
    }
  },
});

/**
 * drain-unannounced (startup)
 * Delivers missed task results on boot.
 */
registerHook({
  name: "drain-unannounced",
  point: "startup",
  order: 10,
  description: "Deliver missed task results on startup",
  handler: async (ctx) => {
    // This is handled directly in relay.ts onStart for now.
    // When we fully migrate, this hook will contain the drain logic.
    // For now it just logs that startup hooks fired.
    info("hooks:startup", "Startup hook fired (drain-unannounced is handled in relay.ts)");
  },
});

/**
 * expire-stale-queue (startup)
 * Clean up stale queued tasks on boot.
 */
registerHook({
  name: "expire-stale-queue",
  point: "startup",
  order: 20,
  description: "Expire stale queued tasks on startup",
  handler: async (ctx) => {
    try {
      const { expireStaleTasks } = await import("./queue.ts");
      const expired = expireStaleTasks();
      if (expired > 0) {
        info("hooks:startup", `Expired ${expired} stale queued task(s)`);
      }
    } catch (err) {
      warn("hooks:startup", `Queue cleanup failed: ${err}`);
    }
  },
});

/**
 * cleanup-swarms (startup)
 * Clean up stale swarms on boot.
 */
registerHook({
  name: "cleanup-swarms",
  point: "startup",
  order: 30,
  description: "Clean up stale swarms on startup",
  handler: async (ctx) => {
    try {
      const { cleanupSwarms } = await import("./orchestrator.ts");
      cleanupSwarms();
    } catch (err) {
      warn("hooks:startup", `Swarm cleanup failed: ${err}`);
    }
  },
});
