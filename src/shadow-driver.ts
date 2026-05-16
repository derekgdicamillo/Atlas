/**
 * Atlas Prime — Shadow-driver (Sprint 7)
 *
 * Main-process client to the shadow-Atlas process. Fires every primary
 * prompt over IPC, scores semantic distance via Haiku, classifies result,
 * sets freeze.flag on alarm-class drift.
 */
import { connect, type Socket } from "net";
import { existsSync } from "fs";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { callHaiku } from "./haiku-client.ts";
import { info, warn, error as logError } from "./logger.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const SHADOW_DIR = join(PROJECT_DIR, "data", "shadow-atlas");
const FREEZE_FLAG = join(SHADOW_DIR, "freeze.flag");
const SOCKET_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\shadow-atlas"
  : join(SHADOW_DIR, "shadow.sock");

const DEFAULT_BUDGET_MS = Number(process.env.SHADOW_BUDGET_MS ?? 90_000);
const DRIFT_THRESHOLD = Number(process.env.SHADOW_DRIFT_THRESHOLD ?? 0.45);

// ============================================================
// IPC CLIENT
// ============================================================

export interface ShadowFireResult {
  ok: boolean;
  shadowText?: string;
  reason?: string;
}

async function sendShadowRequest(
  payload: Record<string, unknown>,
  budgetMs: number
): Promise<ShadowFireResult> {
  if (process.env.SHADOW_ATLAS_ENABLED === "false") {
    return { ok: false, reason: "shadow_disabled" };
  }
  return await new Promise((resolve) => {
    let socket: Socket | null = null;
    let buf = "";
    const timer = setTimeout(() => {
      try { socket?.destroy(); } catch {}
      resolve({ ok: false, reason: "timeout" });
    }, budgetMs);
    try {
      socket = connect(SOCKET_PATH);
    } catch (err) {
      clearTimeout(timer);
      return resolve({ ok: false, reason: `connect: ${err}` });
    }
    socket.on("connect", () => {
      socket!.write(JSON.stringify(payload) + "\n");
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      try {
        const res = JSON.parse(line);
        clearTimeout(timer);
        try { socket?.end(); } catch {}
        if (res.error) resolve({ ok: false, reason: res.error });
        else resolve({ ok: true, shadowText: res.text });
      } catch {
        clearTimeout(timer);
        resolve({ ok: false, reason: "parse_error" });
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `socket: ${err.message}` });
    });
  });
}

export async function fireShadow(
  prompt: string,
  opts?: { budgetMs?: number }
): Promise<ShadowFireResult> {
  const budgetMs = opts?.budgetMs ?? DEFAULT_BUDGET_MS;
  return sendShadowRequest(
    { id: randomUUID(), prompt, budgetMs },
    budgetMs
  );
}

/** Cheap liveness probe — shadow returns "pong" without spawning claude.
 *  Use this from the watchdog cron, not fireShadow. */
export async function pingShadow(
  opts?: { budgetMs?: number }
): Promise<ShadowFireResult> {
  const budgetMs = opts?.budgetMs ?? 5_000;
  return sendShadowRequest(
    { id: randomUUID(), prompt: "", ping: true, budgetMs },
    budgetMs
  );
}

// ============================================================
// DRIFT SCORING (Haiku via CLI)
// ============================================================

export async function scoreDrift(
  primaryText: string,
  shadowText: string
): Promise<{ distance: number; reason: string }> {
  try {
    const { text } = await callHaiku({
      system:
        "You score the semantic distance between two responses to the same user prompt. " +
        "0 = identical meaning, 0.5 = different emphasis or detail, 1 = contradictory or unrelated. " +
        'Output strict JSON: {"distance": <0..1 number, 2 decimals>, "reason": <one sentence>}.',
      userMessage:
        `### Primary response\n${primaryText}\n\n### Shadow response\n${shadowText}`,
      maxTokens: 200,
      cacheSystem: true,
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { distance: 0, reason: "scorer_no_json" };
    const obj = JSON.parse(m[0]);
    const d = Math.max(0, Math.min(1, Number(obj.distance ?? 0)));
    return { distance: d, reason: String(obj.reason ?? "") };
  } catch (err) {
    return { distance: 0, reason: `scorer_failed: ${err}` };
  }
}

// ============================================================
// CLASSIFICATION
// ============================================================

export type DriftClass = "benign" | "explained" | "suspicious" | "alarm";

export function classifyDistance(distance: number, memoryWritesInWindow: number): DriftClass {
  if (distance < 0.2) return "benign";
  if (distance < DRIFT_THRESHOLD) {
    return memoryWritesInWindow > 0 ? "explained" : "suspicious";
  }
  return memoryWritesInWindow > 0 ? "explained" : "alarm";
}

// ============================================================
// FREEZE FLAG
// ============================================================

async function ensureDir(): Promise<void> {
  if (!existsSync(SHADOW_DIR)) await mkdir(SHADOW_DIR, { recursive: true });
}

export async function isFrozen(): Promise<boolean> {
  return existsSync(FREEZE_FLAG);
}

export async function readFreezeReason(): Promise<{ reason: string; since: string; divergence_id?: string } | null> {
  if (!existsSync(FREEZE_FLAG)) return null;
  try {
    const raw = await readFile(FREEZE_FLAG, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { reason: "unknown (corrupt freeze.flag)", since: new Date().toISOString() };
  }
}

export async function freeze(reason: string, divergence_id?: string): Promise<void> {
  await ensureDir();
  await writeFile(
    FREEZE_FLAG,
    JSON.stringify({ frozen: true, since: new Date().toISOString(), reason, divergence_id }),
    "utf-8"
  );
  warn("shadow-driver", `FROZEN — ${reason}`);
}

export async function resume(by: string, note?: string): Promise<void> {
  if (existsSync(FREEZE_FLAG)) {
    try { await unlink(FREEZE_FLAG); } catch {}
  }
  info("shadow-driver", `resumed by ${by}${note ? ` — ${note}` : ""}`);
}

// ============================================================
// DIVERGENCE RECORDER
// ============================================================

export async function countMemoryWritesInWindow(
  supabase: any,
  sinceIso: string
): Promise<number> {
  if (!supabase) return 0;
  try {
    const { count } = await supabase
      .from("memory")
      .select("id", { count: "exact", head: true })
      .gte("created_at", sinceIso);
    return count ?? 0;
  } catch {
    return 0;
  }
}

export async function recordDivergence(opts: {
  supabase: any;
  turn_id: string | null;
  primaryText: string;
  shadowText: string;
  distance: number;
  reason: string;
  memoryWritesInWindow: number;
}): Promise<{ classified: DriftClass; froze: boolean; id?: string }> {
  const classified = classifyDistance(opts.distance, opts.memoryWritesInWindow);
  let froze = false;
  let id: string | undefined;

  if (classified !== "benign" && opts.supabase) {
    const { data } = await opts.supabase
      .from("shadow_divergence_log")
      .insert({
        turn_id: opts.turn_id,
        primary_text: opts.primaryText.slice(0, 8000),
        shadow_text: opts.shadowText.slice(0, 8000),
        distance: opts.distance,
        judge_reason: opts.reason,
        memory_writes_in_window: opts.memoryWritesInWindow,
        classified,
        froze: classified === "alarm",
      })
      .select("id")
      .maybeSingle();
    id = (data as any)?.id;
  }

  if (classified === "alarm") {
    await freeze(`shadow divergence — distance=${opts.distance.toFixed(2)} reason=${opts.reason}`, id);
    froze = true;
  }
  return { classified, froze, id };
}

// ============================================================
// EXTERNAL-ACTION CLASSIFIER (used by freeze-flag gate)
// ============================================================

const EXTERNAL_ACTION_TOOLS = new Set([
  "SEND", "TMAA_SEND",
  "CAL_ADD", "CAL_REMOVE", "TMAA_CAL_ADD", "TMAA_CAL_REMOVE",
  "GHL_WORKFLOW",
  "GHL_SOCIAL",
  "WP_POST", "WP_UPDATE",
  "PLANNER_TASK", "PLANNER_MOVE", "PLANNER_DONE",
]);

export function isExternalAction(toolName: string): boolean {
  return EXTERNAL_ACTION_TOOLS.has(toolName);
}
