/**
 * Atlas — Google Gmail & Calendar Integration
 *
 * Two-account setup:
 *   Derek (Derekgdicamillo@gmail.com) — read inbox, create drafts, manage calendar
 *   Atlas (assistant.ai.atlas@gmail.com) — send emails
 *
 * Claude manages Google actions via intent tags:
 *   [DRAFT: to=addr | subject=Subj | body=Body text]
 *   [SEND: to=addr | subject=Subj | body=Body text]
 *   [CAL_ADD: title=Title | date=2025-01-15 | time=14:00 | duration=60 | invite=addr]
 *   [CAL_REMOVE: search text]
 */

import { google, type gmail_v1, type calendar_v3, type people_v1, type drive_v3 } from "googleapis";
import { randomUUID } from "crypto";
import { info, warn, error as logError } from "./logger.ts";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

// ============================================================
// TYPES
// ============================================================

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface EmailDetail extends EmailSummary {
  to: string;
  body: string;
}

export interface CalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  attendees?: string[];
}

export interface CreateEventParams {
  title: string;
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM
  duration?: number;   // minutes, default 60
  invite?: string[];   // email addresses
  location?: string;
  description?: string;
}

// ============================================================
// STATE
// ============================================================

let derekAuth: OAuth2Client | null = null;
let atlasAuth: OAuth2Client | null = null;
let derekGmail: gmail_v1.Gmail | null = null;
let atlasGmail: gmail_v1.Gmail | null = null;
let derekCalendar: calendar_v3.Calendar | null = null;
let derekPeople: people_v1.People | null = null;
let derekDrive: drive_v3.Drive | null = null;
let calendarId = "primary";

const USER_TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";

// ============================================================
// INITIALIZATION
// ============================================================

export function initGoogle(): boolean {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const derekToken = process.env.GOOGLE_REFRESH_TOKEN_DEREK;
  const atlasToken = process.env.GOOGLE_REFRESH_TOKEN_ATLAS;
  calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";

  if (!clientId || !clientSecret) {
    return false;
  }

  // Derek's account (required for core functionality)
  if (derekToken) {
    derekAuth = new google.auth.OAuth2(clientId, clientSecret);
    derekAuth.setCredentials({ refresh_token: derekToken });
    derekGmail = google.gmail({ version: "v1", auth: derekAuth });
    derekCalendar = google.calendar({ version: "v3", auth: derekAuth });
    derekPeople = google.people({ version: "v1", auth: derekAuth });
    derekDrive = google.drive({ version: "v3", auth: derekAuth });
    info("google", "Derek's Gmail + Calendar + Contacts + Drive initialized");
  }

  // Atlas's account (optional, for sending emails)
  if (atlasToken) {
    atlasAuth = new google.auth.OAuth2(clientId, clientSecret);
    atlasAuth.setCredentials({ refresh_token: atlasToken });
    atlasGmail = google.gmail({ version: "v1", auth: atlasAuth });
    info("google", "Atlas's Gmail initialized (send-enabled)");
  }

  return !!derekAuth;
}

export function isGoogleEnabled(): boolean {
  return !!derekAuth;
}

/** Expose Derek's OAuth2 client for GBP/GA4 integrations that share the same credentials. */
export function getDerekAuth(): OAuth2Client | null {
  return derekAuth;
}

// ============================================================
// GMAIL — DEREK'S ACCOUNT (read + draft)
// ============================================================

export async function listUnreadEmails(maxResults = 10): Promise<EmailSummary[]> {
  if (!derekGmail) return [];

  const res = await derekGmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults,
  });

  const messages = res.data.messages || [];
  const results: EmailSummary[] = [];

  for (const msg of messages) {
    try {
      const detail = await derekGmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });

      const headers = detail.data.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

      results.push({
        id: msg.id!,
        from: getHeader("From"),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
        snippet: detail.data.snippet || "",
      });
    } catch (err) {
      warn("google", `Failed to fetch message ${msg.id}: ${err}`);
    }
  }

  return results;
}

export async function getEmailById(messageId: string): Promise<EmailDetail | null> {
  if (!derekGmail) return null;

  try {
    const res = await derekGmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const headers = res.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

    // Decode body from base64url
    let body = "";
    const payload = res.data.payload;
    if (payload?.body?.data) {
      body = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    } else if (payload?.parts) {
      const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, "base64url").toString("utf-8");
      }
    }

    return {
      id: messageId,
      from: getHeader("From"),
      to: getHeader("To"),
      subject: getHeader("Subject"),
      date: getHeader("Date"),
      snippet: res.data.snippet || "",
      body,
    };
  } catch (err) {
    logError("google", `Failed to fetch email ${messageId}: ${err}`);
    return null;
  }
}

export async function createDraft(to: string, subject: string, body: string): Promise<string | null> {
  if (!derekGmail) return null;

  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(raw).toString("base64url");

  try {
    const res = await derekGmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: { raw: encoded },
      },
    });
    const draftId = res.data.id || "unknown";
    info("google", `Draft created: ${draftId} (to: ${to}, subject: ${subject})`);
    return draftId;
  } catch (err) {
    logError("google", `Failed to create draft: ${err}`);
    return null;
  }
}

// ============================================================
// GMAIL — ATLAS'S ACCOUNT (send)
// ============================================================

export async function sendEmail(to: string, subject: string, body: string): Promise<string | null> {
  if (!atlasGmail) {
    warn("google", "Atlas Gmail not configured. Cannot send emails.");
    return null;
  }

  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(raw).toString("base64url");

  try {
    const res = await atlasGmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded },
    });
    const msgId = res.data.id || "unknown";
    info("google", `Email sent from Atlas: ${msgId} (to: ${to}, subject: ${subject})`);
    return msgId;
  } catch (err) {
    logError("google", `Failed to send email: ${err}`);
    return null;
  }
}

/**
 * Send a calendar invite email with a proper .ics attachment via Atlas's Gmail.
 * Recipients see a real calendar event they can accept/decline, not just a plain email.
 */
async function sendCalendarInvite(params: {
  to: string[];
  title: string;
  description?: string;
  location?: string;
  startDate: Date;
  endDate: Date;
  organizerEmail: string;
  uid: string;
}): Promise<string | null> {
  if (!atlasGmail) {
    warn("google", "Atlas Gmail not configured. Cannot send calendar invite.");
    return null;
  }

  const { to, title, description, location, startDate, endDate, organizerEmail, uid } = params;

  // Format dates as iCal DTSTART/DTEND (UTC)
  const fmtDate = (d: Date) =>
    d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  const dtStart = fmtDate(startDate);
  const dtEnd = fmtDate(endDate);
  const dtStamp = fmtDate(new Date());

  // Build attendee lines
  const attendeeLines = to
    .map((email) => `ATTENDEE;RSVP=TRUE;CN=${email};PARTSTAT=NEEDS-ACTION:mailto:${email}`)
    .join("\r\n");

  // Build .ics content (RFC 5545)
  const icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Atlas AI//Calendar Invite//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${title}`,
    `ORGANIZER;CN=Atlas AI:mailto:${organizerEmail}`,
    attendeeLines,
    ...(description ? [`DESCRIPTION:${description.replace(/\n/g, "\\n")}`] : []),
    ...(location ? [`LOCATION:${location}`] : []),
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    `BEGIN:VALARM`,
    `TRIGGER:-PT15M`,
    `ACTION:DISPLAY`,
    `DESCRIPTION:Reminder`,
    `END:VALARM`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const icsContent = icsLines.join("\r\n");

  // MIME boundary
  const boundary = `atlas_invite_${randomUUID().replace(/-/g, "")}`;

  // Build multipart/mixed MIME with text/calendar alternative
  const mimeLines = [
    `To: ${to.join(", ")}`,
    `Subject: ${title}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "MIME-Version: 1.0",
    "",
    `--${boundary}`,
    "Content-Type: multipart/alternative; boundary=\"alt_" + boundary + "\"",
    "",
    `--alt_${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    `You've been invited to: ${title}`,
    ...(description ? [`\n${description}`] : []),
    ...(location ? [`\nLocation: ${location}`] : []),
    `\nWhen: ${startDate.toLocaleString("en-US", { timeZone: USER_TIMEZONE, dateStyle: "full", timeStyle: "short" })}`,
    "",
    `--alt_${boundary}`,
    "Content-Type: text/calendar; charset=utf-8; method=REQUEST",
    "",
    icsContent,
    "",
    `--alt_${boundary}--`,
    "",
    `--${boundary}`,
    "Content-Type: application/ics; name=\"invite.ics\"",
    "Content-Disposition: attachment; filename=\"invite.ics\"",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(icsContent).toString("base64"),
    "",
    `--${boundary}--`,
  ];

  const rawMessage = mimeLines.join("\r\n");
  const encoded = Buffer.from(rawMessage).toString("base64url");

  try {
    const res = await atlasGmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded },
    });
    const msgId = res.data.id || "unknown";
    info("google", `Calendar invite sent from Atlas: ${msgId} (to: ${to.join(", ")}, event: ${title})`);
    return msgId;
  } catch (err) {
    logError("google", `Failed to send calendar invite: ${err}`);
    return null;
  }
}

// ============================================================
// CALENDAR — DEREK'S ACCOUNT
// ============================================================

export async function listTodayEvents(): Promise<CalEvent[]> {
  if (!derekCalendar) return [];

  // Build today's date range in user's timezone
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE }); // YYYY-MM-DD
  const timeMin = new Date(`${todayStr}T00:00:00`);
  const timeMax = new Date(`${todayStr}T23:59:59`);

  try {
    const res = await derekCalendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    return (res.data.items || []).map(eventToCalEvent);
  } catch (err) {
    logError("google", `Failed to list calendar events: ${err}`);
    return [];
  }
}

export async function createEvent(params: CreateEventParams): Promise<CalEvent | null> {
  if (!derekCalendar) return null;

  const duration = params.duration || 60;
  const startDateTime = new Date(`${params.date}T${params.time}:00`);
  const endDateTime = new Date(startDateTime.getTime() + duration * 60_000);

  const event: calendar_v3.Schema$Event = {
    summary: params.title,
    start: { dateTime: startDateTime.toISOString(), timeZone: USER_TIMEZONE },
    end: { dateTime: endDateTime.toISOString(), timeZone: USER_TIMEZONE },
  };

  if (params.location) event.location = params.location;
  if (params.description) event.description = params.description;
  if (params.invite?.length) {
    event.attendees = params.invite.map((email) => ({ email: email.trim() }));
  }

  try {
    const res = await derekCalendar.events.insert({
      calendarId,
      requestBody: event,
      sendUpdates: "all",
    });

    const created = eventToCalEvent(res.data);
    info("google", `Calendar event created: ${created.title} at ${created.start}`);

    // Send proper .ics invite email from Atlas so recipients get a real
    // calendar event with accept/decline buttons (not just a notification).
    if (params.invite?.length && atlasGmail) {
      const uid = res.data.iCalUID || `atlas-${randomUUID()}@pvmedispa.com`;
      try {
        await sendCalendarInvite({
          to: params.invite.map((e) => e.trim()),
          title: params.title,
          description: params.description,
          location: params.location,
          startDate: startDateTime,
          endDate: endDateTime,
          organizerEmail: "assistant.ai.atlas@gmail.com",
          uid,
        });
      } catch (invErr) {
        warn("google", `Calendar event created but .ics invite email failed: ${invErr}`);
      }
    }

    return created;
  } catch (err) {
    logError("google", `Failed to create calendar event: ${err}`);
    return null;
  }
}

export async function deleteEvent(searchText: string): Promise<boolean> {
  if (!derekCalendar) return false;

  // Search next 30 days
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60_000);

  try {
    const res = await derekCalendar.events.list({
      calendarId,
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      q: searchText,
    });

    const events = res.data.items || [];
    if (events.length === 0) {
      warn("google", `No calendar event found matching: ${searchText}`);
      return false;
    }

    // Delete first match
    const target = events[0];
    await derekCalendar.events.delete({
      calendarId,
      eventId: target.id!,
      sendUpdates: "all",
    });

    info("google", `Calendar event deleted: ${target.summary} (${target.id})`);
    return true;
  } catch (err) {
    logError("google", `Failed to delete calendar event: ${err}`);
    return false;
  }
}

function eventToCalEvent(e: calendar_v3.Schema$Event): CalEvent {
  const startRaw = e.start?.dateTime || e.start?.date || "";
  const endRaw = e.end?.dateTime || e.end?.date || "";

  // Format times for display
  const formatTime = (raw: string) => {
    if (!raw) return "";
    try {
      return new Date(raw).toLocaleTimeString("en-US", {
        timeZone: USER_TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
    } catch {
      return raw;
    }
  };

  return {
    id: e.id || "",
    title: e.summary || "(no title)",
    start: formatTime(startRaw),
    end: formatTime(endRaw),
    location: e.location || undefined,
    attendees: e.attendees?.map((a) => a.email || "").filter(Boolean),
  };
}

// ============================================================
// CONTACTS — DEREK'S ACCOUNT (lookup by name)
// ============================================================

/**
 * Search Derek's Google Contacts by name. Returns matching names + emails.
 * Used by Claude to resolve "email Esther" to an actual address.
 */
export async function lookupContact(query: string): Promise<Array<{ name: string; email: string }>> {
  if (!derekPeople) return [];

  try {
    const res = await derekPeople.people.searchContacts({
      query,
      readMask: "names,emailAddresses",
      pageSize: 5,
    });

    const results: Array<{ name: string; email: string }> = [];
    for (const result of res.data.results || []) {
      const person = result.person;
      if (!person) continue;
      const name = person.names?.[0]?.displayName || "";
      const email = person.emailAddresses?.[0]?.value || "";
      if (name && email) {
        results.push({ name, email });
      }
    }
    return results;
  } catch (err) {
    warn("google", `Contact lookup failed for "${query}": ${err}`);
    return [];
  }
}

/**
 * Get a flat list of frequent/all contacts for context injection.
 * Returns up to `max` contacts with name + email.
 */
export async function listContacts(max = 20): Promise<Array<{ name: string; email: string }>> {
  if (!derekPeople) return [];

  try {
    const res = await derekPeople.people.connections.list({
      resourceName: "people/me",
      pageSize: max,
      personFields: "names,emailAddresses",
      sortOrder: "LAST_MODIFIED_DESCENDING",
    });

    const results: Array<{ name: string; email: string }> = [];
    for (const person of res.data.connections || []) {
      const name = person.names?.[0]?.displayName || "";
      const email = person.emailAddresses?.[0]?.value || "";
      if (name && email) {
        results.push({ name, email });
      }
    }
    return results;
  } catch (err) {
    warn("google", `Contact list failed: ${err}`);
    return [];
  }
}

// ============================================================
// GOOGLE DRIVE — DEREK'S ACCOUNT (read shared files/folders)
// ============================================================

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

/**
 * Search for files/folders by name in Derek's Drive (includes shared).
 */
export async function searchDriveFiles(query: string, maxResults = 20): Promise<DriveFile[]> {
  if (!derekDrive) return [];

  try {
    // If the query doesn't look like a Drive API query, wrap it as a name search
    const driveQuery = query.includes("'") || query.includes("in parents") || query.includes("mimeType") || query.includes("contains")
      ? query
      : query.trim() ? `name contains '${query.replace(/'/g, "\\'")}'` : "trashed = false";
    const res = await derekDrive.files.list({
      q: driveQuery,
      pageSize: maxResults,
      fields: "files(id,name,mimeType,size,modifiedTime,webViewLink)",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    return (res.data.files || []).map((f) => ({
      id: f.id || "",
      name: f.name || "",
      mimeType: f.mimeType || "",
      size: f.size || undefined,
      modifiedTime: f.modifiedTime || undefined,
      webViewLink: f.webViewLink || undefined,
    }));
  } catch (err) {
    logError("google", `Drive search failed: ${err}`);
    return [];
  }
}

/**
 * List files inside a Drive folder by folder ID.
 */
export async function listDriveFolder(folderId: string, maxResults = 50): Promise<DriveFile[]> {
  if (!derekDrive) return [];

  try {
    const res = await derekDrive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      pageSize: maxResults,
      fields: "files(id,name,mimeType,size,modifiedTime,webViewLink)",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    return (res.data.files || []).map((f) => ({
      id: f.id || "",
      name: f.name || "",
      mimeType: f.mimeType || "",
      size: f.size || undefined,
      modifiedTime: f.modifiedTime || undefined,
      webViewLink: f.webViewLink || undefined,
    }));
  } catch (err) {
    logError("google", `Drive folder listing failed: ${err}`);
    return [];
  }
}

/**
 * Download a file's content as text. For Google Docs/Sheets, exports as plain text.
 * For regular files (PDF, txt, etc.), downloads raw content.
 * Returns null if file is binary/unsupported.
 */
export async function downloadDriveFile(fileId: string, mimeType: string): Promise<string | null> {
  if (!derekDrive) return null;

  try {
    // Google Workspace files need export
    const exportMap: Record<string, string> = {
      "application/vnd.google-apps.document": "text/plain",
      "application/vnd.google-apps.spreadsheet": "text/csv",
      "application/vnd.google-apps.presentation": "text/plain",
    };

    if (exportMap[mimeType]) {
      const res = await derekDrive.files.export({
        fileId,
        mimeType: exportMap[mimeType],
      }, { responseType: "text" });
      return res.data as string;
    }

    // Regular files: download content
    const textTypes = ["text/", "application/json", "application/xml", "application/csv"];
    const isText = textTypes.some((t) => mimeType.startsWith(t));

    if (isText) {
      const res = await derekDrive.files.get({
        fileId,
        alt: "media",
      }, { responseType: "text" });
      return res.data as string;
    }

    // For PDFs, try to export as text via Google's converter
    if (mimeType === "application/pdf") {
      // Download as bytes, return a note about it being binary
      return `[PDF file - download via webViewLink to read]`;
    }

    return `[Binary file: ${mimeType} - not directly readable as text]`;
  } catch (err) {
    logError("google", `Drive file download failed (${fileId}): ${err}`);
    return null;
  }
}

/**
 * Find a shared folder by name and return its contents.
 * Convenience wrapper: searches for folder, then lists its children.
 */
export async function findAndListFolder(folderName: string): Promise<{ folderId: string; files: DriveFile[] } | null> {
  if (!derekDrive) return null;

  const folders = await searchDriveFiles(
    `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );

  if (folders.length === 0) {
    warn("google", `No folder found matching: ${folderName}`);
    return null;
  }

  const folder = folders[0];
  const files = await listDriveFolder(folder.id);
  info("google", `Found folder "${folderName}" (${folder.id}) with ${files.length} files`);
  return { folderId: folder.id, files };
}

// ============================================================
// CONTEXT BUILDER (injected into Claude's prompt)
// ============================================================

// Contacts cache: 1 hour TTL (contacts rarely change mid-conversation)
let cachedContacts: { data: { name: string; email: string }[]; ts: number } | null = null;
const CONTACTS_CACHE_TTL = 3_600_000; // 1 hour

async function getCachedContacts(count: number): Promise<{ name: string; email: string }[]> {
  const now = Date.now();
  if (cachedContacts && now - cachedContacts.ts < CONTACTS_CACHE_TTL) {
    return cachedContacts.data;
  }
  const contacts = await listContacts(count).catch(() => []);
  cachedContacts = { data: contacts, ts: now };
  return contacts;
}

export async function getGoogleContext(): Promise<string> {
  if (!derekAuth) return "";

  const parts: string[] = [];

  try {
    const [emails, events, contacts] = await Promise.all([
      listUnreadEmails(5).catch(() => []),
      listTodayEvents().catch(() => []),
      getCachedContacts(15),
    ]);

    if (emails.length > 0) {
      const lines = emails.map(
        (e) => `- From: ${e.from} | Subject: ${e.subject} | ${e.date}`
      );
      parts.push(`INBOX (${emails.length} unread):\n${lines.join("\n")}`);
    } else {
      parts.push("INBOX: No unread emails.");
    }

    if (events.length > 0) {
      const lines = events.map((e) => {
        const who = e.attendees?.length ? ` (with: ${e.attendees.join(", ")})` : "";
        const where = e.location ? ` @ ${e.location}` : "";
        return `- ${e.start}-${e.end} ${e.title}${who}${where}`;
      });
      parts.push(`TODAY'S CALENDAR:\n${lines.join("\n")}`);
    } else {
      parts.push("TODAY'S CALENDAR: No events.");
    }

    if (contacts.length > 0) {
      const lines = contacts.map((c) => `- ${c.name}: ${c.email}`);
      parts.push(`CONTACTS:\n${lines.join("\n")}`);
    }
  } catch (err) {
    warn("google", `Context gathering failed: ${err}`);
    return "";
  }

  return parts.join("\n\n");
}

// ============================================================
// INTENT TAG PROCESSOR
// ============================================================

/**
 * Parse and execute Google intent tags from Claude's response.
 * Strips processed tags from the response text.
 *
 * Uses [\s\S]+? (not .+?) so content can span lines and contain brackets.
 */
export async function processGoogleIntents(response: string): Promise<string> {
  let clean = response;

  // [DRAFT: to=addr | subject=Subj | body=Body text]
  for (const match of response.matchAll(/\[DRAFT:\s*([\s\S]+?)\]/gi)) {
    const params = parseTagParams(match[1]);
    if (params.to && params.subject && params.body) {
      try {
        const draftId = await createDraft(params.to, params.subject, params.body);
        if (draftId) {
          info("google", `Intent: Draft created (${draftId})`);
        }
      } catch (err) {
        warn("google", `DRAFT failed: ${err}`);
      }
    } else {
      warn("google", `Malformed DRAFT tag (missing ${!params.to ? "to" : !params.subject ? "subject" : "body"}): ${match[0].substring(0, 100)}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [SEND: to=addr | subject=Subj | body=Body text]
  for (const match of response.matchAll(/\[SEND:\s*([\s\S]+?)\]/gi)) {
    const params = parseTagParams(match[1]);
    if (params.to && params.subject && params.body) {
      try {
        const msgId = await sendEmail(params.to, params.subject, params.body);
        if (msgId) {
          info("google", `Intent: Email sent (${msgId})`);
        }
      } catch (err) {
        warn("google", `SEND failed: ${err}`);
      }
    } else {
      warn("google", `Malformed SEND tag (missing ${!params.to ? "to" : !params.subject ? "subject" : "body"}): ${match[0].substring(0, 100)}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [CAL_ADD: title=Title | date=YYYY-MM-DD | time=HH:MM | duration=60 | invite=email]
  for (const match of response.matchAll(/\[CAL_ADD:\s*([\s\S]+?)\]/gi)) {
    const params = parseTagParams(match[1]);
    if (params.title) {
      try {
        const eventParams: CreateEventParams = {
          title: params.title,
          date: params.date || todayDateStr(),
          time: params.time || "09:00",
          duration: params.duration ? parseInt(params.duration, 10) : 60,
          invite: params.invite ? params.invite.split(",").map((e) => e.trim()) : undefined,
          location: params.location,
          description: params.description,
        };
        const event = await createEvent(eventParams);
        if (event) {
          info("google", `Intent: Calendar event created (${event.title})`);
        }
      } catch (err) {
        warn("google", `CAL_ADD failed: ${err}`);
      }
    } else {
      warn("google", `Malformed CAL_ADD tag (missing title): ${match[0].substring(0, 100)}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [CAL_REMOVE: search text]
  for (const match of response.matchAll(/\[CAL_REMOVE:\s*([\s\S]+?)\]/gi)) {
    const searchText = match[1].trim();
    if (!searchText) {
      warn("google", `Empty CAL_REMOVE tag`);
      clean = clean.replace(match[0], "");
      continue;
    }
    try {
      const deleted = await deleteEvent(searchText);
      if (deleted) {
        info("google", `Intent: Calendar event deleted (${searchText})`);
      }
    } catch (err) {
      warn("google", `CAL_REMOVE failed: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

/**
 * Parse pipe-separated key=value pairs from a tag body.
 * e.g. "to=alice@example.com | subject=Hello | body=Hi there"
 */
function parseTagParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  // Known keys used across all Google intent tags
  const KNOWN_KEYS = "to|subject|body|title|date|time|duration|invite|location|description";
  // Split on | but only when followed by a known key= or key:
  // This prevents splitting on | inside body text
  const parts = raw.split(new RegExp(`\\s*\\|\\s*(?=(?:${KNOWN_KEYS})\\s*[=:])`, "i"));

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    // Find separator (= or : after a known key)
    const sepMatch = part.match(new RegExp(`^(${KNOWN_KEYS})\\s*[=:]\\s*`, "i"));
    if (sepMatch) {
      const key = sepMatch[1].trim().toLowerCase();
      const value = part.slice(sepMatch[0].length).trim();
      params[key] = value;
    } else if (i === 0 && !part.match(new RegExp(`^(?:${KNOWN_KEYS})\\s*[=:]`, "i"))) {
      // First segment with no key= prefix: treat as implicit "title" (for CAL_ADD)
      // or "to" (for SEND/DRAFT) depending on what's present
      const bare = part.trim();
      if (bare && !params.title) {
        params.title = bare;
      }
    }
  }

  return params;
}

function todayDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
}
