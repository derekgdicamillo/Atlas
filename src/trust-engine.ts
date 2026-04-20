import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export interface TrustEvent {
  ts: string;
  domain: string;
  delta: number;
  source?: string;
}

const HALF_LIFE_DAYS = 30;
const NEUTRAL_PRIOR = 0.5;
const DEFAULT_SNAPSHOT_PATH = "data/trust-snapshots.jsonl";

function decay(ageDays: number): number {
  return Math.pow(2, -ageDays / HALF_LIFE_DAYS);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function computeDomainTrust(
  domain: string,
  events: TrustEvent[],
  nowMs: number = Date.now()
): number {
  const relevant = events.filter((e) => e.domain === domain);
  if (relevant.length === 0) return NEUTRAL_PRIOR;
  let acc = 0;
  for (const e of relevant) {
    const ageDays = (nowMs - new Date(e.ts).getTime()) / 86_400_000;
    if (ageDays < 0) continue;
    acc += e.delta * decay(ageDays);
  }
  return sigmoid(acc * 1.1);
}

export interface TrustAggregate {
  byDomain: Record<string, number>;
  overall: number;
  eventCount: number;
}

export function aggregateTrust(
  events: TrustEvent[],
  nowMs: number = Date.now()
): TrustAggregate {
  const domains = new Set(events.map((e) => e.domain));
  const byDomain: Record<string, number> = {};
  for (const d of domains) byDomain[d] = computeDomainTrust(d, events, nowMs);
  const scores = Object.values(byDomain);
  const overall = scores.length
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : NEUTRAL_PRIOR;
  return { byDomain, overall, eventCount: events.length };
}

export function shouldEscalate(
  domain: string,
  events: TrustEvent[],
  threshold = Number(process.env.TRUST_MIN_SCORE ?? 0.65),
  nowMs: number = Date.now()
): boolean {
  return computeDomainTrust(domain, events, nowMs) < threshold;
}

export async function recordEvent(
  event: TrustEvent,
  opts?: { snapshotPath?: string }
): Promise<void> {
  const path = opts?.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(event) + "\n", "utf8");
}

export async function loadEvents(path = DEFAULT_SNAPSHOT_PATH): Promise<TrustEvent[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length)
    .map((l) => JSON.parse(l) as TrustEvent);
}
