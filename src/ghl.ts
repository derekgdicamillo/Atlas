/**
 * Atlas — GoHighLevel Direct Integration
 *
 * Direct access to GHL API for real-time schedule, leads, pipeline,
 * and operational metrics. Supplements the dashboard integration
 * with live data and proactive alerts.
 *
 * Auth: Private Integration Token (pit-*) via GHL_API_TOKEN env var.
 * API version: 2021-07-28
 */

import { info, warn, error as logError } from "./logger.ts";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const GHL_TOKEN = process.env.GHL_API_TOKEN || "";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "";

// Pipeline IDs (match dashboard)
export const PIPELINES = {
  PATIENT_JOURNEY_WEIGHT_LOSS: "zi2YOdmjJwNYebkCMkVv",
  CURRENT_WEIGHT_LOSS_MEMBER: "BydcHaaFTHMHNN1Icdva",
} as const;

// ============================================================
// TYPES
// ============================================================

export interface GHLContact {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  tags?: string[];
  source?: string;
  dateAdded?: string;
}

export interface GHLOpportunity {
  id: string;
  name: string;
  pipelineId: string;
  pipelineStageId: string;
  status: string;
  monetaryValue?: number;
  source?: string;
  assignedTo?: string;
  contact?: { id: string; name?: string };
  dateAdded?: string;
  dateUpdated?: string;
  lastStageChangeAt?: string;
}

export interface GHLPipelineStage {
  id: string;
  name: string;
  position: number;
}

export interface GHLPipeline {
  id: string;
  name: string;
  stages: GHLPipelineStage[];
}

export interface GHLAppointment {
  id: string;
  calendarId: string;
  contactId: string;
  title: string;
  appointmentStatus: string;
  startTime: string;
  endTime: string;
  assignedUserId?: string;
  notes?: string;
}

// ============================================================
// INIT
// ============================================================

export function isGHLReady(): boolean {
  return !!GHL_TOKEN && !!GHL_LOCATION_ID;
}

export function initGHL(): boolean {
  if (!GHL_TOKEN || !GHL_LOCATION_ID) {
    return false;
  }
  info("ghl", `GHL integration ready: location=${GHL_LOCATION_ID}`);
  return true;
}

// ============================================================
// FETCH HELPER
// ============================================================

async function ghlFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  if (!GHL_TOKEN) throw new Error("GHL_API_TOKEN not configured");

  const url = `${GHL_BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GHL_TOKEN}`,
      Version: GHL_VERSION,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GHL ${endpoint} returned ${res.status}: ${body.substring(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

// ============================================================
// PIPELINES & STAGES
// ============================================================

let cachedStages: Map<string, GHLPipelineStage[]> | null = null;
let stagesCachedAt = 0;
const STAGE_CACHE_TTL = 3600_000; // 1 hour

async function getStages(pipelineId: string): Promise<GHLPipelineStage[]> {
  const now = Date.now();
  if (cachedStages && now - stagesCachedAt < STAGE_CACHE_TTL) {
    return cachedStages.get(pipelineId) || [];
  }

  const res = await ghlFetch<{ pipelines: GHLPipeline[] }>(
    `/opportunities/pipelines?locationId=${GHL_LOCATION_ID}`
  );

  cachedStages = new Map();
  for (const p of res.pipelines) {
    cachedStages.set(p.id, p.stages);
  }
  stagesCachedAt = now;

  return cachedStages.get(pipelineId) || [];
}

function stageName(stages: GHLPipelineStage[], stageId: string): string {
  return stages.find((s) => s.id === stageId)?.name || "Unknown";
}

// ============================================================
// OPPORTUNITIES
// ============================================================

export async function searchOpportunities(
  pipelineId: string,
  opts: {
    status?: string;
    limit?: number;
    startDate?: string;
    endDate?: string;
  } = {}
): Promise<{ opportunities: GHLOpportunity[]; total: number }> {
  const params = new URLSearchParams({
    location_id: GHL_LOCATION_ID,
    pipeline_id: pipelineId,
    limit: String(opts.limit ?? 100),
  });

  if (opts.status && opts.status !== "all") params.set("status", opts.status);
  if (opts.startDate) params.set("date", String(new Date(opts.startDate).getTime()));
  if (opts.endDate) params.set("endDate", String(new Date(opts.endDate + "T23:59:59").getTime()));

  const res = await ghlFetch<{
    opportunities: GHLOpportunity[];
    meta: { total: number; nextPage: number | null; startAfter?: number; startAfterId?: string };
  }>(`/opportunities/search?${params.toString()}`);

  return { opportunities: res.opportunities, total: res.meta.total };
}

/**
 * Get all opportunities with cursor pagination (up to 50 pages).
 */
export async function getAllOpportunities(
  pipelineId: string,
  status?: string
): Promise<GHLOpportunity[]> {
  const all: GHLOpportunity[] = [];
  let startAfter: number | undefined;
  let startAfterId: string | undefined;
  let pages = 0;

  while (pages < 50) {
    const params = new URLSearchParams({
      location_id: GHL_LOCATION_ID,
      pipeline_id: pipelineId,
      limit: "100",
    });
    if (status) params.set("status", status);
    if (startAfter) params.set("startAfter", String(startAfter));
    if (startAfterId) params.set("startAfterId", startAfterId);

    const res = await ghlFetch<{
      opportunities: GHLOpportunity[];
      meta: { nextPage: number | null; startAfter?: number; startAfterId?: string };
    }>(`/opportunities/search?${params.toString()}`);

    all.push(...res.opportunities);
    pages++;
    if (!res.meta.nextPage) break;
    startAfter = res.meta.startAfter as unknown as number;
    startAfterId = res.meta.startAfterId as unknown as string;
  }

  return all;
}

// ============================================================
// CONTACTS
// ============================================================

export async function getRecentLeads(
  days = 7
): Promise<{ leads: GHLContact[]; total: number }> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const params = new URLSearchParams({
    locationId: GHL_LOCATION_ID,
    limit: "100",
    startAfter: startDate.toISOString(),
  });

  const res = await ghlFetch<{
    contacts: GHLContact[];
    meta: { total: number };
  }>(`/contacts/?${params.toString()}`);

  return { leads: res.contacts, total: res.meta.total };
}

// ============================================================
// APPOINTMENTS (Calendar)
// ============================================================

export async function getTodayAppointments(): Promise<GHLAppointment[]> {
  const now = new Date();
  const tz = process.env.USER_TIMEZONE || "America/Phoenix";

  // Get today's date boundaries in local timezone
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz });
  const startTime = new Date(todayStr + "T00:00:00").getTime();
  const endTime = new Date(todayStr + "T23:59:59").getTime();

  const params = new URLSearchParams({
    locationId: GHL_LOCATION_ID,
    startTime: String(startTime),
    endTime: String(endTime),
  });

  try {
    const res = await ghlFetch<{ events: GHLAppointment[] }>(
      `/calendars/events?${params.toString()}`
    );
    return res.events || [];
  } catch (err) {
    // Calendar events endpoint may not be available with pit token
    warn("ghl", `Appointments fetch failed (may need OAuth): ${err}`);
    return [];
  }
}

// ============================================================
// OPERATIONAL METRICS
// ============================================================

export interface OpsSnapshot {
  pipeline: {
    total: number;
    open: number;
    won: number;
    lost: number;
    closeRate: number;
    showRate: number;
    staleCount: number;
  };
  stages: { name: string; count: number }[];
  recentLeads: number;
  todayAppointments: number;
  noShowsThisWeek: number;
}

export async function getOpsSnapshot(): Promise<OpsSnapshot> {
  const stages = await getStages(PIPELINES.PATIENT_JOURNEY_WEIGHT_LOSS);

  // Fetch all statuses in parallel
  const [openRes, wonRes, lostRes] = await Promise.all([
    searchOpportunities(PIPELINES.PATIENT_JOURNEY_WEIGHT_LOSS, { status: "open" }),
    searchOpportunities(PIPELINES.PATIENT_JOURNEY_WEIGHT_LOSS, { status: "won" }),
    searchOpportunities(PIPELINES.PATIENT_JOURNEY_WEIGHT_LOSS, { status: "lost" }),
  ]);

  const total = openRes.total + wonRes.total + lostRes.total;
  const closedCount = wonRes.total + lostRes.total;
  const closeRate = closedCount > 0 ? wonRes.total / closedCount : 0;

  // Count no-shows from open opportunities
  const noShowStageIds = stages
    .filter((s) => s.name.toLowerCase().includes("no show") || s.name.toLowerCase().includes("noshow"))
    .map((s) => s.id);

  let noShowsThisWeek = 0;
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  for (const opp of openRes.opportunities) {
    if (noShowStageIds.includes(opp.pipelineStageId)) {
      const changeDate = opp.lastStageChangeAt || opp.dateUpdated;
      if (changeDate && new Date(changeDate) >= weekAgo) {
        noShowsThisWeek++;
      }
    }
  }

  // Count show rate: (won + lost) / (won + lost + noShows)
  const outcomeCount = closedCount + noShowsThisWeek;
  const showRate = outcomeCount > 0 ? closedCount / outcomeCount : 0;

  // Stage breakdown (open only)
  const stageBreakdown = stages.map((s) => ({
    name: s.name,
    count: openRes.opportunities.filter((o) => o.pipelineStageId === s.id).length,
  })).filter((s) => s.count > 0);

  // Stale leads (open > 7 days in early stages)
  const earlyStageIds = stages
    .filter((s) => {
      const n = s.name.toLowerCase();
      return n.includes("new") || n.includes("lead") || n.includes("undecided");
    })
    .map((s) => s.id);

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const staleCount = openRes.opportunities.filter((o) => {
    if (!earlyStageIds.includes(o.pipelineStageId)) return false;
    const lastChange = o.lastStageChangeAt || o.dateAdded;
    return lastChange ? new Date(lastChange) < sevenDaysAgo : false;
  }).length;

  // Recent leads (last 7 days)
  let recentLeads = 0;
  try {
    const leadsRes = await getRecentLeads(7);
    recentLeads = leadsRes.total;
  } catch {
    // non-critical
  }

  // Today's appointments
  let todayAppointments = 0;
  try {
    const appts = await getTodayAppointments();
    todayAppointments = appts.length;
  } catch {
    // non-critical
  }

  return {
    pipeline: {
      total,
      open: openRes.total,
      won: wonRes.total,
      lost: lostRes.total,
      closeRate,
      showRate,
      staleCount,
    },
    stages: stageBreakdown,
    recentLeads,
    todayAppointments,
    noShowsThisWeek,
  };
}

// ============================================================
// NEW LEADS SINCE (for polling-based alerts)
// ============================================================

let lastLeadCheckTime: string | null = null;

export async function getNewLeadsSince(
  sinceIso?: string
): Promise<{ leads: GHLOpportunity[]; checkTime: string }> {
  const since = sinceIso || lastLeadCheckTime || new Date(Date.now() - 300_000).toISOString();
  const checkTime = new Date().toISOString();

  const res = await searchOpportunities(PIPELINES.PATIENT_JOURNEY_WEIGHT_LOSS, {
    status: "open",
    startDate: since.split("T")[0],
    limit: 50,
  });

  // Filter to only truly new ones (after `since`)
  const sinceMs = new Date(since).getTime();
  const newLeads = res.opportunities.filter((o) => {
    const added = o.dateAdded ? new Date(o.dateAdded).getTime() : 0;
    return added > sinceMs;
  });

  lastLeadCheckTime = checkTime;
  return { leads: newLeads, checkTime };
}

// ============================================================
// FORMATTERS
// ============================================================

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatOpsSnapshot(ops: OpsSnapshot): string {
  const lines: string[] = ["OPERATIONS DASHBOARD"];
  const p = ops.pipeline;

  lines.push(
    `\nPipeline: ${p.total} total | ${p.open} open | ${p.won} won | ${p.lost} lost`,
    `Close rate: ${pct(p.closeRate)} | Show rate: ${pct(p.showRate)}`,
  );

  if (p.staleCount > 0) {
    lines.push(`Stale leads (>7d in early stage): ${p.staleCount}`);
  }

  if (ops.noShowsThisWeek > 0) {
    lines.push(`No-shows this week: ${ops.noShowsThisWeek}`);
  }

  if (ops.stages.length > 0) {
    lines.push(`\nStage breakdown:`);
    for (const s of ops.stages) {
      lines.push(`  ${s.name}: ${s.count}`);
    }
  }

  lines.push(`\nNew leads (7d): ${ops.recentLeads}`);

  if (ops.todayAppointments > 0) {
    lines.push(`Today's appointments: ${ops.todayAppointments}`);
  }

  return lines.join("\n");
}

export function formatNewLeads(leads: GHLOpportunity[], stages: GHLPipelineStage[]): string {
  if (leads.length === 0) return "";

  const lines: string[] = [`NEW LEAD${leads.length > 1 ? "S" : ""} (${leads.length}):`];
  for (const lead of leads.slice(0, 10)) {
    const stage = stageName(stages, lead.pipelineStageId);
    const name = lead.contact?.name || lead.name || "Unknown";
    const src = lead.source ? ` (${lead.source})` : "";
    lines.push(`  ${name}${src} — ${stage}`);
  }
  if (leads.length > 10) {
    lines.push(`  ...and ${leads.length - 10} more`);
  }
  return lines.join("\n");
}

/**
 * GHL context for Claude's prompt.
 * Light operational awareness without hitting API too hard.
 */
export async function getGHLContext(): Promise<string> {
  if (!isGHLReady()) return "";

  try {
    // Just pipeline counts (3 parallel calls, lightweight)
    const [openRes, wonRes, lostRes] = await Promise.all([
      searchOpportunities(PIPELINES.PATIENT_JOURNEY_WEIGHT_LOSS, { status: "open", limit: 1 }),
      searchOpportunities(PIPELINES.PATIENT_JOURNEY_WEIGHT_LOSS, { status: "won", limit: 1 }),
      searchOpportunities(PIPELINES.PATIENT_JOURNEY_WEIGHT_LOSS, { status: "lost", limit: 1 }),
    ]);

    const total = openRes.total + wonRes.total + lostRes.total;
    const closedCount = wonRes.total + lostRes.total;
    const closeRate = closedCount > 0 ? (wonRes.total / closedCount * 100).toFixed(1) : "n/a";

    return [
      "GHL PIPELINE (live):",
      `Total: ${total} | Open: ${openRes.total} | Won: ${wonRes.total} | Lost: ${lostRes.total}`,
      `Close rate: ${closeRate}%`,
    ].join("\n");
  } catch (err) {
    warn("ghl", `Context fetch failed: ${err}`);
    return "";
  }
}
