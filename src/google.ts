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

import { google, type gmail_v1, type calendar_v3, type people_v1 } from "googleapis";
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
    info("google", "Derek's Gmail + Calendar + Contacts initialized");
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
      sendUpdates: "all", // Send invites to attendees
    });

    const created = eventToCalEvent(res.data);
    info("google", `Calendar event created: ${created.title} at ${created.start}`);
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
// CONTEXT BUILDER (injected into Claude's prompt)
// ============================================================

export async function getGoogleContext(): Promise<string> {
  if (!derekAuth) return "";

  const parts: string[] = [];

  try {
    const [emails, events, contacts] = await Promise.all([
      listUnreadEmails(5).catch(() => []),
      listTodayEvents().catch(() => []),
      listContacts(15).catch(() => []),
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
 */
export async function processGoogleIntents(response: string): Promise<string> {
  let clean = response;

  // [DRAFT: to=addr | subject=Subj | body=Body text]
  for (const match of response.matchAll(/\[DRAFT:\s*(.+?)\]/gis)) {
    const params = parseTagParams(match[1]);
    if (params.to && params.subject && params.body) {
      const draftId = await createDraft(params.to, params.subject, params.body);
      if (draftId) {
        info("google", `Intent: Draft created (${draftId})`);
      }
    } else {
      warn("google", `Malformed DRAFT tag: ${match[0].substring(0, 100)}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [SEND: to=addr | subject=Subj | body=Body text]
  for (const match of response.matchAll(/\[SEND:\s*(.+?)\]/gis)) {
    const params = parseTagParams(match[1]);
    if (params.to && params.subject && params.body) {
      const msgId = await sendEmail(params.to, params.subject, params.body);
      if (msgId) {
        info("google", `Intent: Email sent (${msgId})`);
      }
    } else {
      warn("google", `Malformed SEND tag: ${match[0].substring(0, 100)}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [CAL_ADD: title=Title | date=YYYY-MM-DD | time=HH:MM | duration=60 | invite=email]
  for (const match of response.matchAll(/\[CAL_ADD:\s*(.+?)\]/gis)) {
    const params = parseTagParams(match[1]);
    if (params.title) {
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
    } else {
      warn("google", `Malformed CAL_ADD tag: ${match[0].substring(0, 100)}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [CAL_REMOVE: search text]
  for (const match of response.matchAll(/\[CAL_REMOVE:\s*(.+?)\]/gi)) {
    const searchText = match[1].trim();
    const deleted = await deleteEvent(searchText);
    if (deleted) {
      info("google", `Intent: Calendar event deleted (${searchText})`);
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
  // Split on | but only when followed by a known key=
  // This prevents splitting on | inside body text
  const parts = raw.split(/\s*\|\s*(?=(?:to|subject|body|title|date|time|duration|invite|location|description)=)/i);

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    params[key] = value;
  }

  return params;
}

function todayDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
}
