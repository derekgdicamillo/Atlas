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
import { ghlBreaker } from "./circuit-breaker.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

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

export interface GHLConversation {
  id: string;
  contactId: string;
  type: string;
  lastMessageDate?: string;
  lastMessageType?: string;
  lastMessageBody?: string;
  unreadCount?: number;
}

export interface GHLMessage {
  id: string;
  conversationId: string;
  body: string;
  type: number;
  direction: string;
  status: string;
  dateAdded: string;
  contactId?: string;
}

export interface GHLNote {
  id: string;
  contactId: string;
  body: string;
  userId?: string;
  dateAdded: string;
}

export interface GHLTask {
  id: string;
  contactId: string;
  title: string;
  body?: string;
  dueDate?: string;
  completed: boolean;
  assignedTo?: string;
  dateAdded: string;
}

export interface GHLWorkflow {
  id: string;
  name: string;
  status: string;
}

export interface GHLTag {
  id: string;
  name: string;
  locationId: string;
}

export interface GHLCustomField {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
}

export interface GHLWebhookEvent {
  id: string;
  event_type: string;
  contact_id: string | null;
  opportunity_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
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

async function ghlFetchRaw<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
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
    signal: AbortSignal.timeout(ghlBreaker.getTimeoutMs()),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GHL ${endpoint} returned ${res.status}: ${body.substring(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

/** GHL fetch with circuit breaker protection */
async function ghlFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  return ghlBreaker.exec(() => ghlFetchRaw<T>(endpoint, options));
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
// CONTACT SEARCH
// ============================================================

export async function searchContacts(
  query: string,
  limit = 10
): Promise<GHLContact[]> {
  const params = new URLSearchParams({
    locationId: GHL_LOCATION_ID,
    query,
    limit: String(limit),
  });
  const res = await ghlFetch<{ contacts: GHLContact[] }>(
    `/contacts/search/duplicate?${params.toString()}`
  );
  return res.contacts || [];
}

export async function getContact(contactId: string): Promise<GHLContact | null> {
  try {
    const res = await ghlFetch<{ contact: GHLContact }>(
      `/contacts/${contactId}`
    );
    return res.contact;
  } catch {
    return null;
  }
}

export async function resolveContact(
  nameOrQuery: string
): Promise<{ contact: GHLContact | null; candidates: GHLContact[] }> {
  const contacts = await searchContacts(nameOrQuery, 5);
  if (contacts.length === 0) return { contact: null, candidates: [] };
  if (contacts.length === 1) return { contact: contacts[0], candidates: contacts };
  const exact = contacts.find(
    (c) =>
      `${c.firstName || ""} ${c.lastName || ""}`.trim().toLowerCase() ===
      nameOrQuery.toLowerCase()
  );
  return { contact: exact || null, candidates: contacts };
}

// ============================================================
// CONVERSATIONS / MESSAGES (Read Only)
// ============================================================

export async function getConversations(
  contactId: string
): Promise<GHLConversation[]> {
  const params = new URLSearchParams({
    locationId: GHL_LOCATION_ID,
    contactId,
  });
  const res = await ghlFetch<{ conversations: GHLConversation[] }>(
    `/conversations/search?${params.toString()}`
  );
  return res.conversations || [];
}

export async function getMessages(
  conversationId: string,
  limit = 20
): Promise<GHLMessage[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await ghlFetch<{ messages: { messages: GHLMessage[] } }>(
    `/conversations/${conversationId}/messages?${params.toString()}`
  );
  return res.messages?.messages || [];
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

export async function getAppointments(
  opts: { startDate?: string; endDate?: string; days?: number } = {}
): Promise<GHLAppointment[]> {
  const tz = process.env.USER_TIMEZONE || "America/Phoenix";
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz });
  const startStr = opts.startDate || todayStr;
  const startTime = new Date(startStr + "T00:00:00").getTime();
  let endTime: number;
  if (opts.endDate) {
    endTime = new Date(opts.endDate + "T23:59:59").getTime();
  } else {
    const days = opts.days || 1;
    const endDate = new Date(startTime);
    endDate.setDate(endDate.getDate() + days);
    endTime = endDate.getTime() - 1;
  }
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
    warn("ghl", `Appointments fetch failed: ${err}`);
    return [];
  }
}

// ============================================================
// CONTACT NOTES (Read + Write)
// ============================================================

export async function getContactNotes(contactId: string): Promise<GHLNote[]> {
  const res = await ghlFetch<{ notes: GHLNote[] }>(
    `/contacts/${contactId}/notes`
  );
  return res.notes || [];
}

export async function addContactNote(
  contactId: string,
  body: string
): Promise<GHLNote | null> {
  try {
    const res = await ghlFetch<{ note: GHLNote }>(
      `/contacts/${contactId}/notes`,
      { method: "POST", body: JSON.stringify({ body }) }
    );
    info("ghl", `Note added to contact ${contactId}`);
    return res.note;
  } catch (err) {
    logError("ghl", `Failed to add note: ${err}`);
    return null;
  }
}

// ============================================================
// CONTACT TASKS (Read + Write)
// ============================================================

export async function getContactTasks(contactId: string): Promise<GHLTask[]> {
  const res = await ghlFetch<{ tasks: GHLTask[] }>(
    `/contacts/${contactId}/tasks`
  );
  return res.tasks || [];
}

export async function createContactTask(
  contactId: string,
  title: string,
  opts: { dueDate?: string; description?: string; assignedTo?: string } = {}
): Promise<GHLTask | null> {
  try {
    const res = await ghlFetch<{ task: GHLTask }>(
      `/contacts/${contactId}/tasks`,
      {
        method: "POST",
        body: JSON.stringify({
          title,
          body: opts.description || "",
          dueDate: opts.dueDate || new Date(Date.now() + 86400_000).toISOString(),
          completed: false,
          assignedTo: opts.assignedTo,
        }),
      }
    );
    info("ghl", `Task created for contact ${contactId}: ${title}`);
    return res.task;
  } catch (err) {
    logError("ghl", `Failed to create task: ${err}`);
    return null;
  }
}

export async function completeContactTask(
  contactId: string,
  taskId: string
): Promise<boolean> {
  try {
    await ghlFetch<{ task: GHLTask }>(
      `/contacts/${contactId}/tasks/${taskId}`,
      { method: "PUT", body: JSON.stringify({ completed: true }) }
    );
    info("ghl", `Task ${taskId} completed`);
    return true;
  } catch (err) {
    logError("ghl", `Failed to complete task: ${err}`);
    return false;
  }
}

// ============================================================
// WORKFLOWS (Read + Enroll/Remove)
// ============================================================

let cachedWorkflows: GHLWorkflow[] | null = null;
let workflowsCachedAt = 0;
const WORKFLOW_CACHE_TTL = 3600_000;

export async function listWorkflows(): Promise<GHLWorkflow[]> {
  const now = Date.now();
  if (cachedWorkflows && now - workflowsCachedAt < WORKFLOW_CACHE_TTL) {
    return cachedWorkflows;
  }
  const res = await ghlFetch<{ workflows: GHLWorkflow[] }>(
    `/workflows/?locationId=${GHL_LOCATION_ID}`
  );
  cachedWorkflows = res.workflows || [];
  workflowsCachedAt = now;
  return cachedWorkflows;
}

export async function addContactToWorkflow(
  contactId: string,
  workflowId: string
): Promise<boolean> {
  try {
    await ghlFetch<unknown>(
      `/contacts/${contactId}/workflow/${workflowId}`,
      { method: "POST" }
    );
    info("ghl", `Contact ${contactId} enrolled in workflow ${workflowId}`);
    return true;
  } catch (err) {
    logError("ghl", `Failed to enroll in workflow: ${err}`);
    return false;
  }
}

export async function removeContactFromWorkflow(
  contactId: string,
  workflowId: string
): Promise<boolean> {
  try {
    await ghlFetch<unknown>(
      `/contacts/${contactId}/workflow/${workflowId}`,
      { method: "DELETE" }
    );
    info("ghl", `Contact ${contactId} removed from workflow ${workflowId}`);
    return true;
  } catch (err) {
    logError("ghl", `Failed to remove from workflow: ${err}`);
    return false;
  }
}

// ============================================================
// TAGS (Read + Write)
// ============================================================

let cachedTags: GHLTag[] | null = null;
let tagsCachedAt = 0;
const TAG_CACHE_TTL = 1800_000;

export async function getLocationTags(): Promise<GHLTag[]> {
  const now = Date.now();
  if (cachedTags && now - tagsCachedAt < TAG_CACHE_TTL) {
    return cachedTags;
  }
  const res = await ghlFetch<{ tags: GHLTag[] }>(
    `/locations/${GHL_LOCATION_ID}/tags`
  );
  cachedTags = res.tags || [];
  tagsCachedAt = now;
  return cachedTags;
}

export async function addTagToContact(
  contactId: string,
  tag: string
): Promise<boolean> {
  try {
    const contact = await getContact(contactId);
    if (!contact) return false;
    const currentTags = contact.tags || [];
    if (currentTags.includes(tag)) return true;
    await ghlFetch<unknown>(`/contacts/${contactId}`, {
      method: "PUT",
      body: JSON.stringify({ tags: [...currentTags, tag] }),
    });
    info("ghl", `Tag "${tag}" added to contact ${contactId}`);
    return true;
  } catch (err) {
    logError("ghl", `Failed to add tag: ${err}`);
    return false;
  }
}

export async function removeTagFromContact(
  contactId: string,
  tag: string
): Promise<boolean> {
  try {
    const contact = await getContact(contactId);
    if (!contact) return false;
    const currentTags = (contact.tags || []).filter((t) => t !== tag);
    await ghlFetch<unknown>(`/contacts/${contactId}`, {
      method: "PUT",
      body: JSON.stringify({ tags: currentTags }),
    });
    info("ghl", `Tag "${tag}" removed from contact ${contactId}`);
    return true;
  } catch (err) {
    logError("ghl", `Failed to remove tag: ${err}`);
    return false;
  }
}

// ============================================================
// CUSTOM FIELDS (Read Only)
// ============================================================

let cachedCustomFields: GHLCustomField[] | null = null;
let customFieldsCachedAt = 0;

export async function getCustomFields(): Promise<GHLCustomField[]> {
  const now = Date.now();
  if (cachedCustomFields && now - customFieldsCachedAt < STAGE_CACHE_TTL) {
    return cachedCustomFields;
  }
  const res = await ghlFetch<{ customFields: GHLCustomField[] }>(
    `/locations/${GHL_LOCATION_ID}/customFields`
  );
  cachedCustomFields = res.customFields || [];
  customFieldsCachedAt = now;
  return cachedCustomFields;
}

// ============================================================
// WEBHOOK EVENT READER (from Supabase ghl_events table)
// ============================================================

export async function getRecentWebhookEvents(
  supabase: SupabaseClient | null,
  opts: { eventTypes?: string[]; limit?: number; hoursBack?: number } = {}
): Promise<GHLWebhookEvent[]> {
  if (!supabase) return [];
  const limit = opts.limit || 20;
  const hoursBack = opts.hoursBack || 24;
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  let query = supabase
    .from("ghl_events")
    .select("id, event_type, contact_id, opportunity_id, payload, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (opts.eventTypes && opts.eventTypes.length > 0) {
    query = query.in("event_type", opts.eventTypes);
  }
  const { data, error } = await query;
  if (error) {
    warn("ghl", `Failed to read webhook events: ${error.message}`);
    return [];
  }
  return (data as GHLWebhookEvent[]) || [];
}

export async function markEventsProcessed(
  supabase: SupabaseClient,
  eventIds: string[]
): Promise<void> {
  if (eventIds.length === 0) return;
  await supabase
    .from("ghl_events")
    .update({ processed: true })
    .in("id", eventIds);
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

// ============================================================
// FORMATTERS (new)
// ============================================================

export function formatConversationMessages(
  messages: GHLMessage[],
  contactName: string
): string {
  if (messages.length === 0) return `No messages found for ${contactName}.`;
  const tz = process.env.USER_TIMEZONE || "America/Phoenix";
  const lines = [`MESSAGES: ${contactName} (${messages.length} recent)`];
  for (const m of messages) {
    const dir = m.direction === "inbound" ? "IN" : "OUT";
    const time = new Date(m.dateAdded).toLocaleString("en-US", {
      timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const body = m.body?.substring(0, 200) || "(empty)";
    lines.push(`  [${dir}] ${time}: ${body}`);
  }
  return lines.join("\n");
}

export function formatAppointments(appts: GHLAppointment[], label: string): string {
  if (appts.length === 0) return `No appointments ${label}.`;
  const tz = process.env.USER_TIMEZONE || "America/Phoenix";
  const lines = [`APPOINTMENTS ${label} (${appts.length})`];
  for (const a of appts) {
    const start = new Date(a.startTime).toLocaleString("en-US", {
      timeZone: tz, weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    const status = a.appointmentStatus || "confirmed";
    lines.push(`  ${start} - ${a.title} [${status}]`);
  }
  return lines.join("\n");
}

export function formatWorkflows(workflows: GHLWorkflow[]): string {
  if (workflows.length === 0) return "No workflows found.";
  const lines = [`WORKFLOWS (${workflows.length})`];
  for (const w of workflows) {
    lines.push(`  ${w.name} [${w.status}] (${w.id})`);
  }
  return lines.join("\n");
}

// ============================================================
// GHL INTENT PROCESSING
// ============================================================

/**
 * Scan Claude's response for GHL action tags and execute them.
 * Tags are removed from the response before delivery to Telegram.
 *
 * Uses [\s\S]+? (not .+?) so content can span lines and contain brackets.
 * Pipe splitting uses lookahead so pipes within body text don't break parsing.
 */
export async function processGHLIntents(response: string): Promise<string> {
  let clean = response;

  // [GHL_NOTE: contactName | body text]
  // Split on | only when NOT followed by a known field key (body is the last positional field)
  for (const match of response.matchAll(
    /\[GHL_NOTE:\s*([\s\S]+?)\]/gi
  )) {
    const inner = match[1];
    // Split on first pipe to get contactName and body
    const pipeIdx = inner.indexOf("|");
    if (pipeIdx === -1) {
      warn("ghl", `GHL_NOTE missing pipe separator: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }
    const nameQuery = inner.slice(0, pipeIdx).trim();
    const body = inner.slice(pipeIdx + 1).trim();

    if (!nameQuery || !body) {
      warn("ghl", `GHL_NOTE missing name or body: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    try {
      const { contact } = await resolveContact(nameQuery);
      if (contact) {
        await addContactNote(contact.id, body);
      } else {
        warn("ghl", `GHL_NOTE: could not resolve contact "${nameQuery}"`);
      }
    } catch (err) {
      warn("ghl", `GHL_NOTE failed: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [GHL_TASK: contactName | title | due=YYYY-MM-DD]
  // Split on | only when followed by known field prefixes (due=)
  for (const match of response.matchAll(
    /\[GHL_TASK:\s*([\s\S]+?)\]/gi
  )) {
    const inner = match[1];
    const parts = inner.split(/\s*\|\s*(?=due\s*=)/i);
    // First part has "contactName | title" (split on first pipe)
    const firstPart = parts[0];
    const pipeIdx = firstPart.indexOf("|");

    let nameQuery: string;
    let title: string;
    let dueDate: string | undefined;

    if (pipeIdx === -1) {
      warn("ghl", `GHL_TASK missing pipe separator: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    nameQuery = firstPart.slice(0, pipeIdx).trim();
    title = firstPart.slice(pipeIdx + 1).trim();

    // Parse due date from remaining parts
    for (let i = 1; i < parts.length; i++) {
      const dueMatch = parts[i].match(/^due\s*=\s*([\s\S]*)/i);
      if (dueMatch) dueDate = dueMatch[1].trim() || undefined;
    }

    if (!nameQuery || !title) {
      warn("ghl", `GHL_TASK missing name or title: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    try {
      const { contact } = await resolveContact(nameQuery);
      if (contact) {
        await createContactTask(contact.id, title, { dueDate });
      } else {
        warn("ghl", `GHL_TASK: could not resolve contact "${nameQuery}"`);
      }
    } catch (err) {
      warn("ghl", `GHL_TASK failed: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [GHL_TAG: contactName | tagName | action=add|remove]
  // Split on | only when followed by action=
  for (const match of response.matchAll(
    /\[GHL_TAG:\s*([\s\S]+?)\]/gi
  )) {
    const inner = match[1];
    const parts = inner.split(/\s*\|\s*(?=action\s*=)/i);
    // First part has "contactName | tagName" (split on first pipe)
    const firstPart = parts[0];
    const pipeIdx = firstPart.indexOf("|");

    let nameQuery: string;
    let tagName: string;
    let action = "add";

    if (pipeIdx === -1) {
      warn("ghl", `GHL_TAG missing pipe separator: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    nameQuery = firstPart.slice(0, pipeIdx).trim();
    tagName = firstPart.slice(pipeIdx + 1).trim();

    // Parse action from remaining parts
    for (let i = 1; i < parts.length; i++) {
      const actionMatch = parts[i].match(/^action\s*=\s*([\s\S]*)/i);
      if (actionMatch) action = (actionMatch[1].trim() || "add").toLowerCase();
    }

    if (!nameQuery || !tagName) {
      warn("ghl", `GHL_TAG missing name or tag: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    try {
      const { contact } = await resolveContact(nameQuery);
      if (contact) {
        if (action === "remove") {
          await removeTagFromContact(contact.id, tagName);
        } else {
          await addTagToContact(contact.id, tagName);
        }
      }
    } catch (err) {
      warn("ghl", `GHL_TAG failed: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [GHL_WORKFLOW: contactName | workflowId | action=add|remove]
  // Split on | only when followed by action=
  for (const match of response.matchAll(
    /\[GHL_WORKFLOW:\s*([\s\S]+?)\]/gi
  )) {
    const inner = match[1];
    const parts = inner.split(/\s*\|\s*(?=action\s*=)/i);
    // First part has "contactName | workflowId" (split on first pipe)
    const firstPart = parts[0];
    const pipeIdx = firstPart.indexOf("|");

    let nameQuery: string;
    let workflowId: string;
    let action: string;

    if (pipeIdx === -1) {
      warn("ghl", `GHL_WORKFLOW missing pipe separator: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    nameQuery = firstPart.slice(0, pipeIdx).trim();
    workflowId = firstPart.slice(pipeIdx + 1).trim();

    // Parse action (required for workflow)
    let foundAction = false;
    for (let i = 1; i < parts.length; i++) {
      const actionMatch = parts[i].match(/^action\s*=\s*([\s\S]*)/i);
      if (actionMatch) {
        action = actionMatch[1].trim().toLowerCase();
        foundAction = true;
      }
    }

    if (!foundAction) {
      // Default to add if action field is missing
      action = "add";
      warn("ghl", `GHL_WORKFLOW missing action field, defaulting to add: ${match[0].substring(0, 100)}`);
    }

    if (!nameQuery || !workflowId) {
      warn("ghl", `GHL_WORKFLOW missing name or workflowId: ${match[0].substring(0, 100)}`);
      clean = clean.replace(match[0], "");
      continue;
    }

    try {
      const { contact } = await resolveContact(nameQuery);
      if (contact) {
        if (action! === "remove") {
          await removeContactFromWorkflow(contact.id, workflowId);
        } else {
          await addContactToWorkflow(contact.id, workflowId);
        }
      }
    } catch (err) {
      warn("ghl", `GHL_WORKFLOW failed: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  return clean;
}

// ============================================================
// CONTEXT
// ============================================================

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
