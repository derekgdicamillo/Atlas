/**
 * Atlas — Critical Alert Escalation
 *
 * The Atlas → Derek alert chain has a single point of failure: Derek. During
 * the 2026-06-15 → 06-30 quiet stretch, peptide-launch blockers were flagged
 * repeatedly with zero acknowledgment and nothing escalated. This module
 * closes the loop: critical alerts that Derek hasn't acknowledged (by sending
 * ANY message) within ESCALATION_HOURS get forwarded to Esther via the
 * Ishtar bot.
 *
 * State lives in data/pending-critical-alerts.json (tiny, survives restarts).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { info, warn } from "./logger.ts";

// resolve(): PROJECT_DIR may be relative (e.g. ".." from the test runner) and
// recursive mkdir on a ..-containing path fails with EEXIST on Windows.
const PROJECT_DIR = resolve(process.env.PROJECT_DIR || process.cwd());
const STATE_FILE = join(PROJECT_DIR, "data", "pending-critical-alerts.json");

const ESCALATION_HOURS = Number(process.env.ALERT_ESCALATION_HOURS || 3);
const MAX_PENDING = 50;
/** Drop escalated/stale entries after 7 days so the file can't grow forever. */
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingAlert {
  id: string;
  message: string;
  sentAt: string;
  escalated: boolean;
}

function load(): PendingAlert[] {
  try {
    if (!existsSync(STATE_FILE)) return [];
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function save(alerts: PendingAlert[]): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(alerts, null, 2));
  } catch (err) {
    warn("escalation", `Failed to persist pending alerts: ${err}`);
  }
}

/**
 * In-memory fast path: acknowledgeAll runs on EVERY inbound Derek message, so
 * skip the file read when we already know nothing is pending. null = unknown
 * (first call after boot reads the file once).
 */
let knownEmpty: boolean | null = null;

/** Record a critical alert that was just delivered to Derek. */
export function recordCriticalDelivery(message: string): void {
  knownEmpty = false;
  const alerts = load().filter(
    (a) => Date.now() - new Date(a.sentAt).getTime() < PRUNE_MS
  );
  alerts.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    message: message.slice(0, 1500),
    sentAt: new Date().toISOString(),
    escalated: false,
  });
  save(alerts.slice(-MAX_PENDING));
}

/**
 * Derek sent a message — treat as acknowledgment of everything pending.
 * Called from the relay on every inbound Derek message. Cheap no-op when
 * nothing is pending (existsSync + empty check only).
 */
export function acknowledgeAll(): void {
  if (knownEmpty === true) return;
  const alerts = load();
  if (alerts.length === 0) {
    knownEmpty = true;
    return;
  }
  save([]);
  knownEmpty = true;
  info("escalation", `Cleared ${alerts.length} pending critical alert(s) on user activity`);
}

/**
 * Escalate unacknowledged criticals older than ESCALATION_HOURS.
 * `sendToEsther` is injected so this module stays transport-free.
 */
export async function sweepEscalations(
  sendToEsther: (text: string) => Promise<void>
): Promise<number> {
  const alerts = load();
  if (alerts.length === 0) return 0;

  const cutoff = Date.now() - ESCALATION_HOURS * 3_600_000;
  const due = alerts.filter(
    (a) => !a.escalated && new Date(a.sentAt).getTime() < cutoff
  );
  if (due.length === 0) return 0;

  const header =
    due.length === 1
      ? `Heads up — Derek hasn't acknowledged this critical alert from ${ESCALATION_HOURS}+ hours ago:`
      : `Heads up — Derek hasn't acknowledged these ${due.length} critical alerts (oldest ${ESCALATION_HOURS}+ hours):`;
  const body = due.map((a) => a.message).join("\n\n");

  try {
    await sendToEsther(`${header}\n\n${body}`);
    for (const a of due) a.escalated = true;
    save(alerts);
    info("escalation", `Escalated ${due.length} critical alert(s) to Esther`);
    return due.length;
  } catch (err) {
    warn("escalation", `Escalation send failed (will retry next sweep): ${err}`);
    return 0;
  }
}
