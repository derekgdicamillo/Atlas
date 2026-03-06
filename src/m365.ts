/**
 * Atlas -- Microsoft 365 Integration (Graph API)
 *
 * Client credentials flow for background/daemon access to:
 * - SharePoint (sites, document libraries, files)
 * - Teams (teams, channels, messages)
 * - Users (profiles, org chart)
 * - OneDrive (files via SharePoint Sites API)
 * - Planner (plans, buckets, tasks)
 *
 * Auth: Azure Entra ID app registration with Application permissions.
 * Uses @azure/msal-node for token acquisition and caching.
 *
 * Permissions (Application):
 *   Sites.ReadWrite.All, Team.ReadBasic.All, ChannelMessage.Read.All,
 *   Group.ReadWrite.All, User.Read.All, Tasks.ReadWrite, Mail.Read
 *
 * NOTE: Tasks.ReadWrite and Mail.Read must be added in Azure portal.
 *       Go to Azure Entra ID > App registrations > [your app] > API permissions
 */

import { ConfidentialClientApplication } from "@azure/msal-node";
import { info, warn, error as logError } from "./logger.ts";
import { m365Breaker } from "./circuit-breaker.ts";

// ============================================================
// CONFIG
// ============================================================

const TENANT_ID = process.env.AZURE_TENANT_ID || "";
const CLIENT_ID = process.env.AZURE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || "";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPES = ["https://graph.microsoft.com/.default"];

// ============================================================
// TYPES
// ============================================================

export interface M365Site {
  id: string;
  name: string;
  displayName: string;
  webUrl: string;
  description?: string;
  createdDateTime?: string;
}

export interface M365DriveItem {
  id: string;
  name: string;
  webUrl: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  folder?: { childCount: number };
  file?: { mimeType: string };
  createdBy?: { user?: { displayName: string } };
  lastModifiedBy?: { user?: { displayName: string } };
}

export interface M365List {
  id: string;
  name: string;
  displayName: string;
  webUrl: string;
  description?: string;
  list?: { template: string };
  createdDateTime?: string;
}

export interface M365Team {
  id: string;
  displayName: string;
  description?: string;
  webUrl?: string;
  visibility?: string;
}

export interface M365Channel {
  id: string;
  displayName: string;
  description?: string;
  membershipType?: string;
  webUrl?: string;
}

export interface M365ChannelMessage {
  id: string;
  createdDateTime: string;
  body: { content: string; contentType: string };
  from?: { user?: { displayName: string } };
  subject?: string;
}

export interface M365User {
  id: string;
  displayName: string;
  mail?: string;
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  mobilePhone?: string;
  businessPhones?: string[];
  userPrincipalName?: string;
}

export interface PlannerPlan {
  id: string;
  title: string;
  owner: string; // group ID
  createdDateTime?: string;
}

export interface PlannerBucket {
  id: string;
  name: string;
  planId: string;
  orderHint: string;
  "@odata.etag"?: string;
}

export interface PlannerTask {
  id: string;
  title: string;
  planId: string;
  bucketId: string;
  percentComplete: number; // 0, 50, or 100
  assignments?: Record<string, any>;
  dueDateTime?: string;
  orderHint?: string;
  priority?: number; // 0-10 (1=urgent, 3=important, 5=medium, 9=low)
  createdDateTime?: string;
  // Details (separate endpoint)
  description?: string;
  notes?: string;
  "@odata.etag"?: string;
}

export interface PlannerTaskDetails {
  id: string;
  description: string;
  notes?: { content: string; contentType: string };
  "@odata.etag"?: string;
}

// ============================================================
// AUTH (MSAL Client Credentials)
// ============================================================

let msalClient: ConfidentialClientApplication | null = null;

function getMsalClient(): ConfidentialClientApplication {
  if (!msalClient) {
    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: `https://login.microsoftonline.com/${TENANT_ID}`,
        clientSecret: CLIENT_SECRET,
      },
    });
  }
  return msalClient;
}

export async function getAccessToken(): Promise<string> {
  const client = getMsalClient();
  const result = await client.acquireTokenByClientCredential({
    scopes: GRAPH_SCOPES,
  });
  if (!result?.accessToken) {
    throw new Error("MSAL: failed to acquire access token");
  }
  return result.accessToken;
}

// ============================================================
// INIT + READY CHECK
// ============================================================

export function initM365(): boolean {
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    return false;
  }
  info("m365", `M365 integration ready: tenant=${TENANT_ID.substring(0, 8)}...`);
  return true;
}

export function isM365Ready(): boolean {
  return !!TENANT_ID && !!CLIENT_ID && !!CLIENT_SECRET;
}

// ============================================================
// GRAPH FETCH HELPER
// ============================================================

async function graphFetchRaw<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE}${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(m365Breaker.getTimeoutMs()),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Graph ${endpoint.substring(0, 80)} returned ${res.status}: ${body.substring(0, 200)}`);
  }

  // 204 No Content (DELETE responses) has no body to parse
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

/** Graph API fetch with circuit breaker protection */
async function graphFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  return m365Breaker.exec(() => graphFetchRaw<T>(endpoint, options));
}

// ============================================================
// SHAREPOINT SITES
// ============================================================

/** List all SharePoint sites in the tenant */
export async function listSites(): Promise<M365Site[]> {
  const res = await graphFetch<{ value: M365Site[] }>("/sites?search=*&$top=50");
  return res.value || [];
}

/** Get a specific site by name (hostname path) */
export async function getSite(siteNameOrId: string): Promise<M365Site> {
  // Try by ID first, then by relative path
  if (siteNameOrId.includes(",")) {
    return graphFetch<M365Site>(`/sites/${siteNameOrId}`);
  }
  // Search for the site by name
  const res = await graphFetch<{ value: M365Site[] }>(`/sites?search=${encodeURIComponent(siteNameOrId)}&$top=5`);
  if (!res.value?.length) {
    throw new Error(`Site not found: ${siteNameOrId}`);
  }
  return res.value[0];
}

/** Get the root/default site */
export async function getRootSite(): Promise<M365Site> {
  return graphFetch<M365Site>("/sites/root");
}

// ============================================================
// SHAREPOINT DOCUMENT LIBRARIES (Drives)
// ============================================================

/** List document libraries (drives) for a site */
export async function listDrives(siteId: string): Promise<M365DriveItem[]> {
  const res = await graphFetch<{ value: any[] }>(`/sites/${siteId}/drives`);
  return res.value || [];
}

/** List items in a drive (document library root) */
export async function listDriveItems(siteId: string, driveId: string, folderId?: string): Promise<M365DriveItem[]> {
  const path = folderId
    ? `/sites/${siteId}/drives/${driveId}/items/${folderId}/children`
    : `/sites/${siteId}/drives/${driveId}/root/children`;
  const res = await graphFetch<{ value: M365DriveItem[] }>(path + "?$top=50&$orderby=lastModifiedDateTime desc");
  return res.value || [];
}

/** Search files across a site */
export async function searchFiles(siteId: string, query: string): Promise<M365DriveItem[]> {
  const res = await graphFetch<{ value: M365DriveItem[] }>(
    `/sites/${siteId}/drive/root/search(q='${encodeURIComponent(query)}')?$top=20`
  );
  return res.value || [];
}

/** Get file content (text-based files only) */
export async function getFileContent(siteId: string, driveId: string, itemId: string): Promise<string> {
  const token = await getAccessToken();
  const url = `${GRAPH_BASE}/sites/${siteId}/drives/${driveId}/items/${itemId}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(m365Breaker.getTimeoutMs()),
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Failed to get file content: ${res.status}`);
  }
  return res.text();
}

/** Upload a file to a document library */
export async function uploadFile(
  siteId: string,
  driveId: string,
  fileName: string,
  content: string | Buffer,
  folderPath?: string
): Promise<M365DriveItem> {
  const path = folderPath
    ? `/sites/${siteId}/drives/${driveId}/root:/${folderPath}/${fileName}:/content`
    : `/sites/${siteId}/drives/${driveId}/root:/${fileName}:/content`;

  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: content,
    signal: AbortSignal.timeout(m365Breaker.getTimeoutMs()),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Upload failed: ${res.status} ${body.substring(0, 200)}`);
  }

  return res.json() as Promise<M365DriveItem>;
}

// ============================================================
// SHAREPOINT LISTS
// ============================================================

/** List all lists on a site */
export async function listSiteLists(siteId: string): Promise<M365List[]> {
  const res = await graphFetch<{ value: M365List[] }>(`/sites/${siteId}/lists?$top=50`);
  return res.value || [];
}

// ============================================================
// SHAREPOINT PAGES
// ============================================================

export interface SharePointPage {
  id: string;
  name: string;
  title: string;
  webUrl: string;
  pageLayout?: string;
  publishingState?: { level: string; versionId?: string };
}

/** Create a SharePoint page with HTML content */
export async function createSharePointPage(
  siteId: string,
  title: string,
  htmlContent: string,
  opts?: { name?: string; publish?: boolean }
): Promise<SharePointPage> {
  const slug = (opts?.name || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "")) + ".aspx";

  const body = {
    "@odata.type": "#microsoft.graph.sitePage",
    name: slug,
    title,
    pageLayout: "article",
    showComments: false,
    showRecommendedPages: false,
    titleArea: {
      layout: "plain",
      showAuthor: false,
      showPublishedDate: true,
      textAlignment: "left",
    },
    canvasLayout: {
      horizontalSections: [
        {
          layout: "fullWidth",
          id: "1",
          emphasis: "none",
          columns: [
            {
              id: "1",
              width: 0,
              webparts: [
                {
                  id: crypto.randomUUID(),
                  innerHtml: htmlContent,
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const page = await graphFetch<SharePointPage>(`/sites/${siteId}/pages`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  // Publish the page so it's visible
  if (opts?.publish !== false && page.id) {
    try {
      await graphFetch(`/sites/${siteId}/pages/${page.id}/microsoft.graph.sitePage/publish`, {
        method: "POST",
      });
      info("m365", `Published SharePoint page: "${title}" at ${page.webUrl}`);
    } catch (err) {
      warn("m365", `Created page "${title}" but publish failed: ${err}`);
    }
  }

  info("m365", `Created SharePoint page: "${title}" (${slug})`);
  return page;
}

/** List SharePoint pages in a site */
export async function listSharePointPages(siteId: string): Promise<SharePointPage[]> {
  const res = await graphFetch<{ value: SharePointPage[] }>(
    `/sites/${siteId}/pages/microsoft.graph.sitePage?$select=id,name,title,webUrl,pageLayout,publishingState&$top=50&$orderby=lastModifiedDateTime desc`
  );
  return res.value || [];
}

/** Delete a SharePoint page */
export async function deleteSharePointPage(siteId: string, pageId: string): Promise<void> {
  await graphFetch(`/sites/${siteId}/pages/${pageId}`, { method: "DELETE" });
  info("m365", `Deleted SharePoint page ${pageId}`);
}

// ============================================================
// TEAMS
// ============================================================

/** List all teams the app can see */
export async function listTeams(): Promise<M365Team[]> {
  const res = await graphFetch<{ value: M365Team[] }>("/groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id,displayName,description,visibility&$top=50");
  return res.value || [];
}

/** List channels in a team */
export async function listChannels(teamId: string): Promise<M365Channel[]> {
  const res = await graphFetch<{ value: M365Channel[] }>(`/teams/${teamId}/channels`);
  return res.value || [];
}

/** Get recent messages from a channel */
export async function getChannelMessages(teamId: string, channelId: string, top = 15): Promise<M365ChannelMessage[]> {
  const res = await graphFetch<{ value: M365ChannelMessage[] }>(
    `/teams/${teamId}/channels/${channelId}/messages?$top=${top}`
  );
  return res.value || [];
}

/** Send a message to a channel */
export async function sendChannelMessage(teamId: string, channelId: string, content: string): Promise<void> {
  await graphFetch(`/teams/${teamId}/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      body: { content, contentType: "text" },
    }),
  });
}

// ============================================================
// USERS
// ============================================================

/** List all users in the tenant */
export async function listUsers(): Promise<M365User[]> {
  const res = await graphFetch<{ value: M365User[] }>(
    "/users?$select=id,displayName,mail,jobTitle,department,officeLocation,mobilePhone,businessPhones,userPrincipalName&$top=100"
  );
  return res.value || [];
}

/** Get a specific user by ID or UPN */
export async function getUser(userIdOrUpn: string): Promise<M365User> {
  return graphFetch<M365User>(
    `/users/${encodeURIComponent(userIdOrUpn)}?$select=id,displayName,mail,jobTitle,department,officeLocation,mobilePhone,businessPhones,userPrincipalName`
  );
}

/** Search users by display name */
export async function searchUsers(query: string): Promise<M365User[]> {
  const res = await graphFetch<{ value: M365User[] }>(
    `/users?$filter=startswith(displayName,'${encodeURIComponent(query)}')&$select=id,displayName,mail,jobTitle,department&$top=10`
  );
  return res.value || [];
}

// ============================================================
// SITE CREATION (via Group -> Team provisioning)
// ============================================================

/** Create a new SharePoint communication site via the Graph sites API */
export async function createSite(displayName: string, description?: string): Promise<any> {
  // Communication sites are created via the SharePoint admin API.
  // For team sites, we create an M365 Group which auto-provisions a SharePoint site.
  const groupPayload = {
    displayName,
    description: description || `SharePoint site for ${displayName}`,
    groupTypes: ["Unified"],
    mailEnabled: true,
    mailNickname: displayName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().substring(0, 40),
    securityEnabled: false,
    visibility: "Private",
  };

  const group = await graphFetch<any>("/groups", {
    method: "POST",
    body: JSON.stringify(groupPayload),
  });

  info("m365", `Created M365 group: ${group.displayName} (${group.id}). SharePoint site will provision automatically.`);
  return group;
}

// ============================================================
// PLANNER (Plans, Buckets, Tasks)
// NOTE: Requires Tasks.ReadWrite permission in Azure portal.
// ============================================================

/** List all plans for an M365 group */
export async function listPlansForGroup(groupId: string): Promise<PlannerPlan[]> {
  const res = await graphFetch<{ value: PlannerPlan[] }>(`/groups/${groupId}/planner/plans`);
  return res.value || [];
}

/** Create a new plan in an M365 group */
export async function createPlan(groupId: string, title: string): Promise<PlannerPlan> {
  return graphFetch<PlannerPlan>("/planner/plans", {
    method: "POST",
    body: JSON.stringify({ owner: groupId, title }),
  });
}

/** List all buckets in a plan */
export async function listBuckets(planId: string): Promise<PlannerBucket[]> {
  const res = await graphFetch<{ value: PlannerBucket[] }>(`/planner/plans/${planId}/buckets`);
  return res.value || [];
}

/** Create a new bucket in a plan */
export async function createBucket(planId: string, name: string, orderHint?: string): Promise<PlannerBucket> {
  return graphFetch<PlannerBucket>("/planner/buckets", {
    method: "POST",
    body: JSON.stringify({ planId, name, orderHint: orderHint || " !" }),
  });
}

/** Update a bucket (reorder, rename). Requires etag from prior GET. */
export async function updateBucket(
  bucketId: string,
  updates: { name?: string; orderHint?: string },
  etag: string
): Promise<void> {
  await graphFetch(`/planner/buckets/${bucketId}`, {
    method: "PATCH",
    headers: { "If-Match": etag },
    body: JSON.stringify(updates),
  });
  info("m365", `Updated planner bucket ${bucketId}: ${JSON.stringify(updates)}`);
}

/** Delete a bucket by ID. Requires etag from prior GET. */
export async function deleteBucket(bucketId: string, etag: string): Promise<void> {
  await graphFetch(`/planner/buckets/${bucketId}`, {
    method: "DELETE",
    headers: { "If-Match": etag },
  });
  info("m365", `Deleted planner bucket ${bucketId}`);
}

/** Reorder buckets in a plan by name order. Names listed first appear leftmost. */
export async function reorderBuckets(planId: string, nameOrder: string[]): Promise<void> {
  const buckets = await listBuckets(planId);
  // Planner orderHint format: "<previous_hint> <next_hint>!" where the service
  // calculates the actual stored value. To place first: " !" (no previous, no next).
  // To place after an item: "<that_item_hint> !" (after it, before nothing).
  let updated = 0;
  let prevHint = ""; // empty = place at start
  for (let i = 0; i < nameOrder.length; i++) {
    const bucket = buckets.find((b) => b.name.toLowerCase() === nameOrder[i].toLowerCase());
    if (!bucket) {
      warn("m365", `Bucket "${nameOrder[i]}" not found in plan, skipping`);
      continue;
    }
    try {
      // Fetch individual bucket to get fresh etag
      const fresh = await graphFetch<PlannerBucket & { "@odata.etag": string }>(
        `/planner/buckets/${bucket.id}`
      );
      const etag = fresh["@odata.etag"] || "";
      if (!etag) {
        warn("m365", `No etag for bucket "${bucket.name}", skipping`);
        continue;
      }
      // Build hint: place after previous item, before nothing
      const hint = prevHint ? `${prevHint} !` : " !";
      await updateBucket(bucket.id, { orderHint: hint }, etag);
      // Re-fetch to get the service-computed orderHint for next iteration
      const refreshed = await graphFetch<PlannerBucket>(`/planner/buckets/${bucket.id}`);
      prevHint = refreshed.orderHint;
      updated++;
      // Small delay to avoid Planner API throttling
      if (i < nameOrder.length - 1) await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      warn("m365", `Failed to reorder bucket "${bucket.name}": ${err}`);
    }
  }
  info("m365", `Reordered ${updated}/${nameOrder.length} buckets in plan ${planId}`);
}

/** List all tasks in a plan (up to 100) */
export async function listPlannerTasks(planId: string): Promise<PlannerTask[]> {
  const res = await graphFetch<{ value: PlannerTask[] }>(`/planner/plans/${planId}/tasks?$top=100`);
  return res.value || [];
}

/** Get a single task by ID */
export async function getTask(taskId: string): Promise<PlannerTask> {
  return graphFetch<PlannerTask>(`/planner/tasks/${taskId}`);
}

/** Get task details (description, notes) */
export async function getTaskDetails(taskId: string): Promise<PlannerTaskDetails> {
  return graphFetch<PlannerTaskDetails>(`/planner/tasks/${taskId}/details`);
}

/**
 * Create a task in a plan bucket.
 * If description is provided, makes a second PATCH call to set task details.
 */
export async function createTask(
  planId: string,
  bucketId: string,
  title: string,
  opts?: { assignedTo?: string; dueDate?: string; priority?: number; description?: string }
): Promise<PlannerTask> {
  const body: Record<string, any> = { planId, bucketId, title };

  if (opts?.dueDate) {
    body.dueDateTime = new Date(opts.dueDate).toISOString();
  }
  if (opts?.priority !== undefined) {
    body.priority = opts.priority;
  }
  if (opts?.assignedTo) {
    body.assignments = {
      [opts.assignedTo]: {
        "@odata.type": "#microsoft.graph.plannerAssignment",
        orderHint: " !",
      },
    };
  }

  const task = await graphFetch<PlannerTask>("/planner/tasks", {
    method: "POST",
    body: JSON.stringify(body),
  });

  // If description provided, patch task details (requires etag from details endpoint)
  if (opts?.description && task.id) {
    try {
      const details = await getTaskDetails(task.id);
      const detailEtag = details["@odata.etag"] || "";
      await graphFetch(`/planner/tasks/${task.id}/details`, {
        method: "PATCH",
        headers: { "If-Match": detailEtag },
        body: JSON.stringify({ description: opts.description }),
      });
      task.description = opts.description;
    } catch (err) {
      warn("m365", `Created task "${title}" but failed to set description: ${err}`);
    }
  }

  info("m365", `Created planner task: "${title}" in plan ${planId}`);
  return task;
}

/**
 * Update a task. Requires the @odata.etag from a prior GET.
 * Planner PATCH operations require If-Match header with the etag value.
 */
export async function updateTask(
  taskId: string,
  updates: { percentComplete?: number; bucketId?: string; title?: string; priority?: number },
  etag: string
): Promise<void> {
  await graphFetch(`/planner/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "If-Match": etag },
    body: JSON.stringify(updates),
  });
  info("m365", `Updated planner task ${taskId}: ${JSON.stringify(updates)}`);
}

/**
 * Find a plan by name substring across all groups.
 * Returns the first match along with its group ID.
 */
async function findPlanByName(name: string): Promise<{ plan: PlannerPlan; groupId: string } | null> {
  const teams = await listTeams();
  const lower = name.toLowerCase();
  for (const team of teams) {
    try {
      const plans = await listPlansForGroup(team.id);
      const match = plans.find(p => p.title.toLowerCase().includes(lower));
      if (match) return { plan: match, groupId: team.id };
    } catch {
      // Group may not have planner access, skip
    }
  }
  return null;
}

/**
 * Find a task by title substring within a plan.
 * Returns the task with its @odata.etag for update operations.
 */
async function findTaskInPlan(planId: string, taskTitle: string): Promise<PlannerTask | null> {
  const tasks = await listPlannerTasks(planId);
  const lower = taskTitle.toLowerCase();
  return tasks.find(t => t.title.toLowerCase().includes(lower)) || null;
}

/**
 * Resolve a user ID from email for task assignment.
 * Uses the existing listUsers() to find a match.
 */
async function resolveUserId(email: string): Promise<string | null> {
  try {
    const user = await getUser(email);
    return user.id;
  } catch {
    // Fall back to listing users and matching
    const users = await listUsers();
    const lower = email.toLowerCase();
    const match = users.find(u =>
      u.mail?.toLowerCase() === lower || u.userPrincipalName?.toLowerCase() === lower
    );
    return match?.id || null;
  }
}

// ============================================================
// FORMATTERS
// ============================================================

function formatBytes(bytes?: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function shortDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatSitesList(sites: M365Site[]): string {
  if (!sites.length) return "No SharePoint sites found.";
  const lines = ["📂 SharePoint Sites", ""];
  for (const s of sites) {
    lines.push(`  ${s.displayName || s.name}`);
    if (s.description) lines.push(`    ${s.description.substring(0, 80)}`);
    lines.push(`    ${s.webUrl}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatDriveItems(items: M365DriveItem[], siteName?: string): string {
  if (!items.length) return "No files found.";
  const header = siteName ? `📁 Files in ${siteName}` : "📁 Files";
  const lines = [header, ""];
  for (const item of items) {
    const icon = item.folder ? "📁" : "📄";
    const size = item.file ? ` (${formatBytes(item.size)})` : item.folder ? ` (${item.folder.childCount} items)` : "";
    const modified = item.lastModifiedDateTime ? ` - ${shortDate(item.lastModifiedDateTime)}` : "";
    lines.push(`  ${icon} ${item.name}${size}${modified}`);
  }
  return lines.join("\n");
}

export function formatTeamsList(teams: M365Team[]): string {
  if (!teams.length) return "No Teams found.";
  const lines = ["👥 Microsoft Teams", ""];
  for (const t of teams) {
    const vis = t.visibility ? ` (${t.visibility})` : "";
    lines.push(`  ${t.displayName}${vis}`);
    if (t.description) lines.push(`    ${t.description.substring(0, 80)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatChannelsList(channels: M365Channel[], teamName?: string): string {
  if (!channels.length) return "No channels found.";
  const header = teamName ? `💬 Channels in ${teamName}` : "💬 Channels";
  const lines = [header, ""];
  for (const c of channels) {
    const type = c.membershipType === "private" ? " 🔒" : "";
    lines.push(`  #${c.displayName}${type}`);
    if (c.description) lines.push(`    ${c.description.substring(0, 80)}`);
  }
  return lines.join("\n");
}

export function formatChannelMessages(messages: M365ChannelMessage[], channelName?: string): string {
  if (!messages.length) return "No messages found.";
  const header = channelName ? `💬 Recent in #${channelName}` : "💬 Recent Messages";
  const lines = [header, ""];
  for (const m of messages) {
    const from = m.from?.user?.displayName || "Unknown";
    const time = shortDate(m.createdDateTime);
    // Strip HTML tags for plain text
    const body = m.body.content.replace(/<[^>]+>/g, "").trim().substring(0, 200);
    if (body) {
      lines.push(`  [${time}] ${from}: ${body}`);
    }
  }
  return lines.join("\n");
}

export function formatUsersList(users: M365User[]): string {
  if (!users.length) return "No users found.";
  const lines = ["👤 M365 Users", ""];
  for (const u of users) {
    const role = u.jobTitle ? ` - ${u.jobTitle}` : "";
    const dept = u.department ? ` (${u.department})` : "";
    lines.push(`  ${u.displayName}${role}${dept}`);
    if (u.mail) lines.push(`    ${u.mail}`);
  }
  return lines.join("\n");
}

/** Format a Planner board as Kanban view for Telegram */
export function formatPlannerBoard(plan: PlannerPlan, buckets: PlannerBucket[], tasks: PlannerTask[]): string {
  const lines: string[] = [`**${plan.title}**`, ""];

  // Group tasks by bucket
  const tasksByBucket = new Map<string, PlannerTask[]>();
  for (const bucket of buckets) {
    tasksByBucket.set(bucket.id, []);
  }
  // Uncategorized bucket for tasks without a matching bucket
  const uncategorized: PlannerTask[] = [];

  for (const task of tasks) {
    const list = tasksByBucket.get(task.bucketId);
    if (list) {
      list.push(task);
    } else {
      uncategorized.push(task);
    }
  }

  for (const bucket of buckets) {
    const bucketTasks = tasksByBucket.get(bucket.id) || [];
    lines.push(`**${bucket.name}** (${bucketTasks.length})`);

    if (bucketTasks.length === 0) {
      lines.push("  (empty)");
    } else {
      for (const t of bucketTasks) {
        const status = t.percentComplete === 100 ? "done" : t.percentComplete === 50 ? "in progress" : "pending";
        const icon = t.percentComplete === 100 ? "[x]" : t.percentComplete === 50 ? "[-]" : "[ ]";
        const assignees = t.assignments ? Object.keys(t.assignments) : [];
        const assigneeStr = assignees.length > 0 ? ` @${assignees.length}` : "";
        const due = t.dueDateTime ? ` due ${shortDate(t.dueDateTime)}` : "";
        const prio = t.priority !== undefined && t.priority <= 3 ? " !" : "";
        lines.push(`  ${icon} ${t.title}${prio}${due}${assigneeStr}`);
      }
    }
    lines.push("");
  }

  if (uncategorized.length > 0) {
    lines.push(`**Uncategorized** (${uncategorized.length})`);
    for (const t of uncategorized) {
      const icon = t.percentComplete === 100 ? "[x]" : t.percentComplete === 50 ? "[-]" : "[ ]";
      lines.push(`  ${icon} ${t.title}`);
    }
    lines.push("");
  }

  const total = tasks.length;
  const done = tasks.filter(t => t.percentComplete === 100).length;
  const inProg = tasks.filter(t => t.percentComplete === 50).length;
  lines.push(`${total} tasks: ${done} done, ${inProg} in progress, ${total - done - inProg} pending`);

  return lines.join("\n");
}

// ============================================================
// CONTEXT INJECTION
// ============================================================

/** Get M365 context summary for Claude's prompt */
export async function getM365Context(): Promise<string> {
  if (!isM365Ready()) return "";

  try {
    const [sites, teams, users] = await Promise.all([
      listSites().catch(() => [] as M365Site[]),
      listTeams().catch(() => [] as M365Team[]),
      listUsers().catch(() => [] as M365User[]),
    ]);

    const parts: string[] = ["[M365]"];

    if (sites.length > 0) {
      parts.push(`SharePoint: ${sites.length} sites (${sites.slice(0, 5).map(s => s.displayName || s.name).join(", ")}${sites.length > 5 ? "..." : ""})`);
    } else {
      parts.push("SharePoint: no sites yet");
    }

    if (teams.length > 0) {
      parts.push(`Teams: ${teams.length} (${teams.slice(0, 5).map(t => t.displayName).join(", ")}${teams.length > 5 ? "..." : ""})`);
    }

    if (users.length > 0) {
      parts.push(`Users: ${users.length} licensed`);
    }

    return parts.join(" | ");
  } catch (err) {
    warn("m365", `Context fetch failed: ${err}`);
    return "";
  }
}

// ============================================================
// COMMAND HANDLER
// ============================================================

/**
 * Handle /m365, /sites, /teams, /sharepoint, /planner commands.
 * Returns formatted text for Telegram.
 */
export async function handleM365Command(command: string, args: string[]): Promise<string> {
  if (!isM365Ready()) {
    return "M365 not configured. Add AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET to .env.";
  }

  try {
    switch (command) {
      case "/m365":
      case "/sharepoint": {
        const sub = args[0];

        if (!sub || sub === "sites") {
          const sites = await listSites();
          return formatSitesList(sites);
        }

        if (sub === "files") {
          const siteName = args[1];
          if (!siteName) return "Usage: /m365 files <site-name> [folder]";
          const site = await getSite(siteName);
          const drives = await listDrives(site.id);
          if (!drives.length) return `No document libraries found in ${site.displayName || site.name}.`;
          const items = await listDriveItems(site.id, (drives[0] as any).id);
          return formatDriveItems(items, site.displayName || site.name);
        }

        if (sub === "search") {
          const query = args.slice(1).join(" ");
          if (!query) return "Usage: /m365 search <query>";
          const rootSite = await getRootSite();
          const results = await searchFiles(rootSite.id, query);
          return results.length > 0
            ? formatDriveItems(results)
            : `No files matching "${query}".`;
        }

        if (sub === "create") {
          const name = args.slice(1).join(" ");
          if (!name) return "Usage: /m365 create <site-name>";
          const group = await createSite(name);
          return `Created M365 group "${group.displayName}". SharePoint site will provision in a few minutes.\nGroup ID: ${group.id}`;
        }

        if (sub === "users") {
          const users = await listUsers();
          return formatUsersList(users);
        }

        return [
          "M365 Commands",
          "",
          "/m365 sites - List SharePoint sites",
          "/m365 files <site> - Browse files in a site",
          "/m365 search <query> - Search files across SharePoint",
          "/m365 create <name> - Create new SharePoint site",
          "/m365 users - List tenant users",
          "/teams - List Teams and channels",
          "/teams <team> - View channels in a team",
          "/teams messages <team> <channel> - Read recent messages",
          "/planner - List all plans across groups",
          "/planner <plan-name> - Show board view for a plan",
          "/planner add <plan> | <bucket> | <task> - Create a task",
          "/planner move <task-title> | <bucket> - Move task to bucket",
          "/planner done <task-title> - Mark task complete",
        ].join("\n");
      }

      case "/teams": {
        const sub = args[0];

        if (!sub) {
          const teams = await listTeams();
          return formatTeamsList(teams);
        }

        if (sub === "messages") {
          const teamName = args[1];
          const channelName = args[2];
          if (!teamName || !channelName) return "Usage: /teams messages <team-name> <channel-name>";

          const teams = await listTeams();
          const team = teams.find(t => t.displayName.toLowerCase().includes(teamName.toLowerCase()));
          if (!team) return `Team not found: ${teamName}`;

          const channels = await listChannels(team.id);
          const channel = channels.find(c => c.displayName.toLowerCase().includes(channelName.toLowerCase()));
          if (!channel) return `Channel not found: ${channelName} in ${team.displayName}`;

          const messages = await getChannelMessages(team.id, channel.id);
          return formatChannelMessages(messages, channel.displayName);
        }

        // Treat remaining args as team name search
        const teamName = args.join(" ");
        const teams = await listTeams();
        const team = teams.find(t => t.displayName.toLowerCase().includes(teamName.toLowerCase()));
        if (!team) return `Team not found: ${teamName}`;

        const channels = await listChannels(team.id);
        return formatChannelsList(channels, team.displayName);
      }

      case "/planner": {
        const sub = args[0];

        // /planner or /planner boards - list all plans across groups
        if (!sub || sub === "boards") {
          const teams = await listTeams();
          const planLines: string[] = ["**Planner Boards**", ""];
          let totalPlans = 0;

          for (const team of teams) {
            try {
              const plans = await listPlansForGroup(team.id);
              if (plans.length > 0) {
                for (const p of plans) {
                  planLines.push(`  ${p.title} (${team.displayName})`);
                  totalPlans++;
                }
              }
            } catch {
              // Group may not have planner, skip
            }
          }

          if (totalPlans === 0) {
            return "No Planner boards found across any groups.";
          }
          planLines.push("");
          planLines.push(`${totalPlans} plan(s) found. Use \`/planner <name>\` to view a board.`);
          return planLines.join("\n");
        }

        // /planner add <plan> | <bucket> | <task>
        if (sub === "add") {
          const rest = args.slice(1).join(" ");
          const parts = rest.split("|").map(s => s.trim());
          if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) {
            return "Usage: /planner add <plan-name> | <bucket-name> | <task-title>";
          }
          const [planName, bucketName, taskTitle] = parts;

          const found = await findPlanByName(planName);
          if (!found) return `Plan not found: ${planName}`;

          const buckets = await listBuckets(found.plan.id);
          let bucket = buckets.find(b => b.name.toLowerCase().includes(bucketName.toLowerCase()));

          if (!bucket) {
            // Create the bucket if it doesn't exist
            bucket = await createBucket(found.plan.id, bucketName);
            info("m365", `Created new bucket "${bucketName}" in plan "${found.plan.title}"`);
          }

          const task = await createTask(found.plan.id, bucket.id, taskTitle);
          return `Created task "${task.title}" in ${bucket.name} (${found.plan.title})`;
        }

        // /planner move <task-title> | <bucket-name>
        if (sub === "move") {
          const rest = args.slice(1).join(" ");
          const parts = rest.split("|").map(s => s.trim());
          if (parts.length < 2 || !parts[0] || !parts[1]) {
            return "Usage: /planner move <task-title> | <bucket-name>";
          }
          const [taskTitle, bucketName] = parts;

          // Search all plans for the task
          const teams = await listTeams();
          for (const team of teams) {
            try {
              const plans = await listPlansForGroup(team.id);
              for (const plan of plans) {
                const task = await findTaskInPlan(plan.id, taskTitle);
                if (task) {
                  const buckets = await listBuckets(plan.id);
                  const bucket = buckets.find(b => b.name.toLowerCase().includes(bucketName.toLowerCase()));
                  if (!bucket) return `Bucket not found: ${bucketName} in plan ${plan.title}`;

                  // Fetch fresh task to get current etag
                  const freshTask = await getTask(task.id);
                  const etag = freshTask["@odata.etag"] || "";
                  if (!etag) return "Could not get task etag for update. Try again.";

                  await updateTask(task.id, { bucketId: bucket.id }, etag);
                  return `Moved "${task.title}" to ${bucket.name} (${plan.title})`;
                }
              }
            } catch {
              // Skip groups without planner
            }
          }
          return `Task not found: ${taskTitle}`;
        }

        // /planner done <task-title>
        if (sub === "done") {
          const taskTitle = args.slice(1).join(" ");
          if (!taskTitle) return "Usage: /planner done <task-title>";

          // Search all plans for the task
          const teams = await listTeams();
          for (const team of teams) {
            try {
              const plans = await listPlansForGroup(team.id);
              for (const plan of plans) {
                const task = await findTaskInPlan(plan.id, taskTitle);
                if (task) {
                  const freshTask = await getTask(task.id);
                  const etag = freshTask["@odata.etag"] || "";
                  if (!etag) return "Could not get task etag for update. Try again.";

                  await updateTask(task.id, { percentComplete: 100 }, etag);
                  return `Marked "${task.title}" as done (${plan.title})`;
                }
              }
            } catch {
              // Skip groups without planner
            }
          }
          return `Task not found: ${taskTitle}`;
        }

        // /planner <plan-name> - show board view
        const planName = args.join(" ");
        const found = await findPlanByName(planName);
        if (!found) return `Plan not found: ${planName}. Use \`/planner\` to list all plans.`;

        const buckets = await listBuckets(found.plan.id);
        const tasks = await listPlannerTasks(found.plan.id);
        return formatPlannerBoard(found.plan, buckets, tasks);
      }

      default:
        return "Unknown M365 command. Try /m365, /teams, or /planner.";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("m365", `Command ${command} failed: ${msg}`);
    return `M365 error: ${msg.substring(0, 300)}`;
  }
}

// ============================================================
// INTENT PROCESSING (Tags from Claude responses)
// ============================================================

const M365_TAG_REGEX = /\[M365_UPLOAD:\s*site=([^\|]+)\|\s*path=([^\|]+)\|\s*content=([^\]]+)\]/g;
const M365_MSG_REGEX = /\[TEAMS_MSG:\s*team=([^\|]+)\|\s*channel=([^\|]+)\|\s*content=([^\]]+)\]/g;
const PLANNER_TASK_REGEX = /\[PLANNER_TASK:\s*plan=([^\|]+)\|\s*bucket=([^\|]+)\|\s*title=([^\|\]]+)(?:\|\s*assignee=([^\|\]]+))?(?:\|\s*due=([^\|\]]+))?(?:\|\s*description=([^\]]+))?\]/g;
const PLANNER_MOVE_REGEX = /\[PLANNER_MOVE:\s*task=([^\|]+)\|\s*bucket=([^\|]+)\|\s*plan=([^\]]+)\]/g;
const PLANNER_DONE_REGEX = /\[PLANNER_DONE:\s*task=([^\|]+)\|\s*plan=([^\]]+)\]/g;

export async function processM365Intents(response: string): Promise<string> {
  if (!isM365Ready()) return response;

  let result = response;

  // Process file upload tags
  for (const match of response.matchAll(M365_TAG_REGEX)) {
    const [fullMatch, siteName, filePath, content] = match;
    try {
      const site = await getSite(siteName.trim());
      const drives = await listDrives(site.id);
      if (drives.length > 0) {
        const pathParts = filePath.trim().split("/");
        const fileName = pathParts.pop() || "untitled.txt";
        const folderPath = pathParts.join("/") || undefined;
        await uploadFile(site.id, (drives[0] as any).id, fileName, content.trim(), folderPath);
        info("m365", `Uploaded ${fileName} to ${site.displayName}`);
      }
    } catch (err) {
      logError("m365", `Upload intent failed: ${err}`);
    }
    result = result.replace(fullMatch, "");
  }

  // Process Teams message tags
  for (const match of response.matchAll(M365_MSG_REGEX)) {
    const [fullMatch, teamName, channelName, content] = match;
    try {
      const teams = await listTeams();
      const team = teams.find(t => t.displayName.toLowerCase().includes(teamName.trim().toLowerCase()));
      if (team) {
        const channels = await listChannels(team.id);
        const channel = channels.find(c => c.displayName.toLowerCase().includes(channelName.trim().toLowerCase()));
        if (channel) {
          await sendChannelMessage(team.id, channel.id, content.trim());
          info("m365", `Sent message to #${channel.displayName} in ${team.displayName}`);
        }
      }
    } catch (err) {
      logError("m365", `Teams message intent failed: ${err}`);
    }
    result = result.replace(fullMatch, "");
  }

  // Process Planner task creation tags
  for (const match of response.matchAll(PLANNER_TASK_REGEX)) {
    const [fullMatch, planName, bucketName, title, assignee, due, description] = match;
    try {
      const found = await findPlanByName(planName.trim());
      if (found) {
        const buckets = await listBuckets(found.plan.id);
        let bucket = buckets.find(b => b.name.toLowerCase().includes(bucketName.trim().toLowerCase()));
        if (!bucket) {
          bucket = await createBucket(found.plan.id, bucketName.trim());
        }

        const opts: { assignedTo?: string; dueDate?: string; priority?: number; description?: string } = {};
        if (assignee?.trim()) {
          const userId = await resolveUserId(assignee.trim());
          if (userId) opts.assignedTo = userId;
        }
        if (due?.trim()) opts.dueDate = due.trim();
        if (description?.trim()) opts.description = description.trim();

        await createTask(found.plan.id, bucket.id, title.trim(), opts);
        info("m365", `Planner intent: created task "${title.trim()}" in ${found.plan.title}/${bucket.name}`);
      } else {
        warn("m365", `Planner intent: plan not found: ${planName.trim()}`);
      }
    } catch (err) {
      logError("m365", `Planner task intent failed: ${err}`);
    }
    result = result.replace(fullMatch, "");
  }

  // Process Planner move tags
  for (const match of response.matchAll(PLANNER_MOVE_REGEX)) {
    const [fullMatch, taskTitle, bucketName, planName] = match;
    try {
      const found = await findPlanByName(planName.trim());
      if (found) {
        const task = await findTaskInPlan(found.plan.id, taskTitle.trim());
        if (task) {
          const buckets = await listBuckets(found.plan.id);
          const bucket = buckets.find(b => b.name.toLowerCase().includes(bucketName.trim().toLowerCase()));
          if (bucket) {
            const freshTask = await getTask(task.id);
            const etag = freshTask["@odata.etag"] || "";
            if (etag) {
              await updateTask(task.id, { bucketId: bucket.id }, etag);
              info("m365", `Planner intent: moved "${task.title}" to ${bucket.name}`);
            }
          }
        }
      }
    } catch (err) {
      logError("m365", `Planner move intent failed: ${err}`);
    }
    result = result.replace(fullMatch, "");
  }

  // Process Planner done tags
  for (const match of response.matchAll(PLANNER_DONE_REGEX)) {
    const [fullMatch, taskTitle, planName] = match;
    try {
      const found = await findPlanByName(planName.trim());
      if (found) {
        const task = await findTaskInPlan(found.plan.id, taskTitle.trim());
        if (task) {
          const freshTask = await getTask(task.id);
          const etag = freshTask["@odata.etag"] || "";
          if (etag) {
            await updateTask(task.id, { percentComplete: 100 }, etag);
            info("m365", `Planner intent: marked "${task.title}" done`);
          }
        }
      }
    } catch (err) {
      logError("m365", `Planner done intent failed: ${err}`);
    }
    result = result.replace(fullMatch, "");
  }

  return result;
}

// ============================================================
// MAIL (Outlook / Exchange Online)
// ============================================================

export interface M365MailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount: number;
  unreadItemCount: number;
  totalItemCount: number;
}

export interface M365EmailAddress {
  name: string;
  address: string;
}

export interface M365Message {
  id: string;
  subject: string;
  bodyPreview: string;
  body?: { content: string; contentType: string };
  from?: { emailAddress: M365EmailAddress };
  toRecipients?: { emailAddress: M365EmailAddress }[];
  ccRecipients?: { emailAddress: M365EmailAddress }[];
  receivedDateTime: string;
  sentDateTime?: string;
  isRead: boolean;
  importance: string;
  hasAttachments: boolean;
  webLink?: string;
  conversationId?: string;
}

/** List mail folders for a user */
export async function listMailFolders(userPrincipalName: string): Promise<M365MailFolder[]> {
  const res = await graphFetch<{ value: M365MailFolder[] }>(
    `/users/${encodeURIComponent(userPrincipalName)}/mailFolders?$top=25`
  );
  return res.value || [];
}

/** List messages from a user's mailbox */
export async function listMessages(
  userPrincipalName: string,
  opts: {
    folderId?: string;
    top?: number;
    filter?: string;
    search?: string;
    select?: string;
  } = {}
): Promise<M365Message[]> {
  const top = opts.top || 10;
  const base = opts.folderId
    ? `/users/${encodeURIComponent(userPrincipalName)}/mailFolders/${opts.folderId}/messages`
    : `/users/${encodeURIComponent(userPrincipalName)}/messages`;

  const params = new URLSearchParams();
  params.set("$top", String(top));
  // Graph API does not support $orderby when $search is used
  if (!opts.search) {
    params.set("$orderby", "receivedDateTime desc");
  }
  if (opts.filter) params.set("$filter", opts.filter);
  if (opts.search) params.set("$search", `"${opts.search}"`);
  if (opts.select) {
    params.set("$select", opts.select);
  } else {
    params.set("$select", "id,subject,bodyPreview,from,toRecipients,receivedDateTime,isRead,importance,hasAttachments");
  }

  const res = await graphFetch<{ value: M365Message[] }>(`${base}?${params.toString()}`);
  return res.value || [];
}

/** Get a single message by ID (includes full body) */
export async function getMessage(
  userPrincipalName: string,
  messageId: string
): Promise<M365Message> {
  return graphFetch<M365Message>(
    `/users/${encodeURIComponent(userPrincipalName)}/messages/${messageId}?$select=id,subject,body,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,importance,hasAttachments,webLink,conversationId`
  );
}

/** List attachments for a message */
export interface M365Attachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentBytes?: string; // base64 encoded for file attachments
}

export async function listAttachments(
  userPrincipalName: string,
  messageId: string
): Promise<M365Attachment[]> {
  const res = await graphFetch<{ value: M365Attachment[] }>(
    `/users/${encodeURIComponent(userPrincipalName)}/messages/${messageId}/attachments`
  );
  return res.value || [];
}

/** Get a single attachment by ID (includes contentBytes) */
export async function getAttachment(
  userPrincipalName: string,
  messageId: string,
  attachmentId: string
): Promise<M365Attachment> {
  return graphFetch<M365Attachment>(
    `/users/${encodeURIComponent(userPrincipalName)}/messages/${messageId}/attachments/${attachmentId}`
  );
}

/** List unread messages for a user (convenience wrapper) */
export async function listUnreadMessages(
  userPrincipalName: string,
  top = 10
): Promise<M365Message[]> {
  return listMessages(userPrincipalName, {
    top,
    filter: "isRead eq false",
  });
}
