/**
 * Atlas — TMAA Google Suite Integration
 *
 * The Medical Aesthetics Association (TMAA) Google Suite
 * Project: iconic-smoke-491800-d6
 *
 * Two-account setup:
 *   theoffice@medicalaestheticsassociation.com — primary (read, draft, send, calendar, drive, sheets, contacts)
 *   derekgdicamillo@gmail.com — secondary (read, draft, calendar)
 *
 * 8 APIs enabled: Gmail, Calendar, Drive, Sheets, Contacts (People API), GA4, YouTube, Google Ads
 *
 * Claude manages TMAA actions via intent tags:
 *   [TMAA_DRAFT: to=addr | subject=Subj | body=Body text]
 *   [TMAA_SEND: to=addr | subject=Subj | body=Body text]
 *   [TMAA_CAL_ADD: title=Title | date=2026-01-15 | time=14:00 | duration=60 | invite=addr]
 *   [TMAA_CAL_REMOVE: search text]
 */

import { google, type gmail_v1, type calendar_v3, type people_v1, type drive_v3, type sheets_v4 } from "googleapis";
import { randomUUID } from "crypto";
import { info, warn, error as logError } from "./logger.ts";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

// ============================================================
// TYPES
// ============================================================

export interface TmaaEmailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface TmaaEmailDetail extends TmaaEmailSummary {
  to: string;
  body: string;
}

export interface TmaaCalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  attendees?: string[];
}

export interface TmaaCreateEventParams {
  title: string;
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM
  duration?: number;   // minutes, default 60
  invite?: string[];   // email addresses
  location?: string;
  description?: string;
}

export interface TmaaDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface TmaaSheetData {
  range: string;
  values: string[][];
}

// ============================================================
// STATE
// ============================================================

let theofficeAuth: OAuth2Client | null = null;
let derekAuth: OAuth2Client | null = null;
let theofficeGmail: gmail_v1.Gmail | null = null;
let derekGmail: gmail_v1.Gmail | null = null;
let theofficeCalendar: calendar_v3.Calendar | null = null;
let derekCalendar: calendar_v3.Calendar | null = null;
let theofficePeople: people_v1.People | null = null;
let theofficeDrive: drive_v3.Drive | null = null;
let theofficeSheets: sheets_v4.Sheets | null = null;

const USER_TIMEZONE = process.env.USER_TIMEZONE || "America/Phoenix";

// ============================================================
// INITIALIZATION
// ============================================================

export function initTMAA(): boolean {
  const clientId = process.env.TMAA_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.TMAA_GOOGLE_CLIENT_SECRET;
  const theofficeToken = process.env.TMAA_GOOGLE_REFRESH_TOKEN_THEOFFICE;
  const derekToken = process.env.TMAA_GOOGLE_REFRESH_TOKEN_DEREK;

  if (!clientId || !clientSecret) {
    return false;
  }

  // theoffice@medicalaestheticsassociation.com (primary — full access)
  if (theofficeToken) {
    theofficeAuth = new google.auth.OAuth2(clientId, clientSecret);
    theofficeAuth.setCredentials({ refresh_token: theofficeToken });
    theofficeGmail = google.gmail({ version: "v1", auth: theofficeAuth });
    theofficeCalendar = google.calendar({ version: "v3", auth: theofficeAuth });
    theofficePeople = google.people({ version: "v1", auth: theofficeAuth });
    theofficeDrive = google.drive({ version: "v3", auth: theofficeAuth });
    theofficeSheets = google.sheets({ version: "v4", auth: theofficeAuth });
    info("tmaa", "theoffice@MAA Gmail + Calendar + Contacts + Drive + Sheets initialized");
  }

  // derekgdicamillo@gmail.com (secondary — read, draft, calendar)
  if (derekToken) {
    derekAuth = new google.auth.OAuth2(clientId, clientSecret);
    derekAuth.setCredentials({ refresh_token: derekToken });
    derekGmail = google.gmail({ version: "v1", auth: derekAuth });
    derekCalendar = google.calendar({ version: "v3", auth: derekAuth });
    info("tmaa", "Derek's TMAA Gmail + Calendar initialized");
  }

  return !!theofficeAuth;
}

export function isTMAAEnabled(): boolean {
  return !!theofficeAuth;
}

/** Expose theoffice OAuth2 client for future GA4/YouTube/Ads integrations. */
export function getTMAAAuth(): OAuth2Client | null {
  return theofficeAuth;
}

// ============================================================
// GMAIL — THEOFFICE ACCOUNT (read + draft + send)
// ============================================================

export async function tmaaListUnreadEmails(maxResults = 10): Promise<TmaaEmailSummary[]> {
  if (!theofficeGmail) return [];

  const res = await theofficeGmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults,
  });

  const messages = res.data.messages || [];
  const results: TmaaEmailSummary[] = [];

  for (const msg of messages) {
    try {
      const detail = await theofficeGmail.users.messages.get({
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
      warn("tmaa", `Failed to fetch message ${msg.id}: ${err}`);
    }
  }

  return results;
}

export async function tmaaGetEmailById(messageId: string): Promise<TmaaEmailDetail | null> {
  if (!theofficeGmail) return null;

  try {
    const res = await theofficeGmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const headers = res.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

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
    logError("tmaa", `Failed to fetch email ${messageId}: ${err}`);
    return null;
  }
}

export async function tmaaCreateDraft(to: string, subject: string, body: string): Promise<string | null> {
  if (!theofficeGmail) return null;

  const raw = [
    `To: ${to}`,
    `From: theoffice@medicalaestheticsassociation.com`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(raw).toString("base64url");

  try {
    const res = await theofficeGmail.users.drafts.create({
      userId: "me",
      requestBody: {
        message: { raw: encoded },
      },
    });
    const draftId = res.data.id || "unknown";
    info("tmaa", `Draft created: ${draftId} (to: ${to}, subject: ${subject})`);
    return draftId;
  } catch (err) {
    logError("tmaa", `Failed to create draft: ${err}`);
    return null;
  }
}

export async function tmaaSendEmail(to: string, subject: string, body: string): Promise<string | null> {
  if (!theofficeGmail) {
    warn("tmaa", "theoffice Gmail not configured. Cannot send emails.");
    return null;
  }

  const raw = [
    `To: ${to}`,
    `From: theoffice@medicalaestheticsassociation.com`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(raw).toString("base64url");

  try {
    const res = await theofficeGmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded },
    });
    const msgId = res.data.id || "unknown";
    info("tmaa", `Email sent from theoffice@MAA: ${msgId} (to: ${to}, subject: ${subject})`);
    return msgId;
  } catch (err) {
    logError("tmaa", `Failed to send email: ${err}`);
    return null;
  }
}

/**
 * Send a calendar invite email with a proper .ics attachment via theoffice Gmail.
 */
async function tmaaSendCalendarInvite(params: {
  to: string[];
  title: string;
  description?: string;
  location?: string;
  startDate: Date;
  endDate: Date;
  uid: string;
}): Promise<string | null> {
  if (!theofficeGmail) {
    warn("tmaa", "theoffice Gmail not configured. Cannot send calendar invite.");
    return null;
  }

  const { to, title, description, location, startDate, endDate, uid } = params;

  const fmtDate = (d: Date) =>
    d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  const dtStart = fmtDate(startDate);
  const dtEnd = fmtDate(endDate);
  const dtStamp = fmtDate(new Date());

  const attendeeLines = to
    .map((email) => `ATTENDEE;RSVP=TRUE;CN=${email};PARTSTAT=NEEDS-ACTION:mailto:${email}`)
    .join("\r\n");

  const icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TMAA//Calendar Invite//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${title}`,
    `ORGANIZER;CN=TMAA:mailto:theoffice@medicalaestheticsassociation.com`,
    attendeeLines,
    ...(description ? [`DESCRIPTION:${description.replace(/\n/g, "\\n")}`] : []),
    ...(location ? [`LOCATION:${location}`] : []),
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const icsContent = icsLines.join("\r\n");

  const boundary = `tmaa_invite_${randomUUID().replace(/-/g, "")}`;

  const mimeLines = [
    `To: ${to.join(", ")}`,
    `Subject: ${title}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "MIME-Version: 1.0",
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="alt_${boundary}"`,
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
    const res = await theofficeGmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded },
    });
    const msgId = res.data.id || "unknown";
    info("tmaa", `Calendar invite sent from theoffice@MAA: ${msgId} (to: ${to.join(", ")}, event: ${title})`);
    return msgId;
  } catch (err) {
    logError("tmaa", `Failed to send calendar invite: ${err}`);
    return null;
  }
}

// ============================================================
// CALENDAR — THEOFFICE ACCOUNT
// ============================================================

export async function tmaaListTodayEvents(): Promise<TmaaCalEvent[]> {
  if (!theofficeCalendar) return [];

  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
  const timeMin = new Date(`${todayStr}T00:00:00`);
  const timeMax = new Date(`${todayStr}T23:59:59`);

  try {
    const res = await theofficeCalendar.events.list({
      calendarId: "primary",
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    return (res.data.items || []).map(tmaaEventToCalEvent);
  } catch (err) {
    logError("tmaa", `Failed to list calendar events: ${err}`);
    return [];
  }
}

export async function tmaaCreateEvent(params: TmaaCreateEventParams): Promise<TmaaCalEvent | null> {
  if (!theofficeCalendar) return null;

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
    const res = await theofficeCalendar.events.insert({
      calendarId: "primary",
      requestBody: event,
      sendUpdates: "all",
    });

    const created = tmaaEventToCalEvent(res.data);
    info("tmaa", `Calendar event created: ${created.title} at ${created.start}`);

    // Send .ics invite from theoffice
    if (params.invite?.length && theofficeGmail) {
      const uid = res.data.iCalUID || `tmaa-${randomUUID()}@medicalaestheticsassociation.com`;
      try {
        await tmaaSendCalendarInvite({
          to: params.invite.map((e) => e.trim()),
          title: params.title,
          description: params.description,
          location: params.location,
          startDate: startDateTime,
          endDate: endDateTime,
          uid,
        });
      } catch (invErr) {
        warn("tmaa", `Calendar event created but .ics invite email failed: ${invErr}`);
      }
    }

    return created;
  } catch (err) {
    logError("tmaa", `Failed to create calendar event: ${err}`);
    return null;
  }
}

export async function tmaaDeleteEvent(searchText: string): Promise<boolean> {
  if (!theofficeCalendar) return false;

  const now = new Date();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60_000);

  try {
    const res = await theofficeCalendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      q: searchText,
    });

    const events = res.data.items || [];
    if (events.length === 0) {
      warn("tmaa", `No calendar event found matching: ${searchText}`);
      return false;
    }

    const target = events[0];
    await theofficeCalendar.events.delete({
      calendarId: "primary",
      eventId: target.id!,
      sendUpdates: "all",
    });

    info("tmaa", `Calendar event deleted: ${target.summary} (${target.id})`);
    return true;
  } catch (err) {
    logError("tmaa", `Failed to delete calendar event: ${err}`);
    return false;
  }
}

function tmaaEventToCalEvent(e: calendar_v3.Schema$Event): TmaaCalEvent {
  const startRaw = e.start?.dateTime || e.start?.date || "";
  const endRaw = e.end?.dateTime || e.end?.date || "";

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
// CONTACTS — THEOFFICE ACCOUNT
// ============================================================

export async function tmaaLookupContact(query: string): Promise<Array<{ name: string; email: string }>> {
  if (!theofficePeople) return [];

  try {
    const res = await theofficePeople.people.searchContacts({
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
    warn("tmaa", `Contact lookup failed for "${query}": ${err}`);
    return [];
  }
}

export async function tmaaListContacts(max = 20): Promise<Array<{ name: string; email: string }>> {
  if (!theofficePeople) return [];

  try {
    const res = await theofficePeople.people.connections.list({
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
    warn("tmaa", `Contact list failed: ${err}`);
    return [];
  }
}

// ============================================================
// GOOGLE DRIVE — THEOFFICE ACCOUNT
// ============================================================

export async function tmaaSearchDriveFiles(query: string, maxResults = 20): Promise<TmaaDriveFile[]> {
  if (!theofficeDrive) return [];

  try {
    const driveQuery = query.includes("'") || query.includes("in parents") || query.includes("mimeType") || query.includes("contains")
      ? query
      : query.trim() ? `name contains '${query.replace(/'/g, "\\'")}'` : "trashed = false";
    const res = await theofficeDrive.files.list({
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
    logError("tmaa", `Drive search failed: ${err}`);
    return [];
  }
}

export async function tmaaListDriveFolder(folderId: string, maxResults = 50): Promise<TmaaDriveFile[]> {
  if (!theofficeDrive) return [];

  try {
    const res = await theofficeDrive.files.list({
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
    logError("tmaa", `Drive folder listing failed: ${err}`);
    return [];
  }
}

export async function tmaaDownloadDriveFile(fileId: string, mimeType: string): Promise<string | null> {
  if (!theofficeDrive) return null;

  try {
    const exportMap: Record<string, string> = {
      "application/vnd.google-apps.document": "text/plain",
      "application/vnd.google-apps.spreadsheet": "text/csv",
      "application/vnd.google-apps.presentation": "text/plain",
    };

    if (exportMap[mimeType]) {
      const res = await theofficeDrive.files.export({
        fileId,
        mimeType: exportMap[mimeType],
      }, { responseType: "text" });
      return res.data as string;
    }

    const textTypes = ["text/", "application/json", "application/xml", "application/csv"];
    const isText = textTypes.some((t) => mimeType.startsWith(t));

    if (isText) {
      const res = await theofficeDrive.files.get({
        fileId,
        alt: "media",
      }, { responseType: "text" });
      return res.data as string;
    }

    if (mimeType === "application/pdf") {
      return `[PDF file - download via webViewLink to read]`;
    }

    return `[Binary file: ${mimeType} - not directly readable as text]`;
  } catch (err) {
    logError("tmaa", `Drive file download failed (${fileId}): ${err}`);
    return null;
  }
}

// ============================================================
// GOOGLE SHEETS — THEOFFICE ACCOUNT
// ============================================================

/**
 * Read data from a Google Sheet.
 * @param spreadsheetId The ID of the spreadsheet
 * @param range A1 notation range, e.g. "Sheet1!A1:D10"
 */
export async function tmaaReadSheet(spreadsheetId: string, range: string): Promise<TmaaSheetData | null> {
  if (!theofficeSheets) return null;

  try {
    const res = await theofficeSheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    return {
      range: res.data.range || range,
      values: (res.data.values || []) as string[][],
    };
  } catch (err) {
    logError("tmaa", `Sheet read failed (${spreadsheetId}, ${range}): ${err}`);
    return null;
  }
}

/**
 * Write data to a Google Sheet.
 * @param spreadsheetId The ID of the spreadsheet
 * @param range A1 notation range, e.g. "Sheet1!A1"
 * @param values 2D array of values to write
 */
export async function tmaaWriteSheet(
  spreadsheetId: string,
  range: string,
  values: string[][]
): Promise<boolean> {
  if (!theofficeSheets) return false;

  try {
    await theofficeSheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });
    info("tmaa", `Sheet updated: ${spreadsheetId} range ${range} (${values.length} rows)`);
    return true;
  } catch (err) {
    logError("tmaa", `Sheet write failed (${spreadsheetId}, ${range}): ${err}`);
    return false;
  }
}

/**
 * Append rows to the end of a Google Sheet.
 */
export async function tmaaAppendSheet(
  spreadsheetId: string,
  range: string,
  values: string[][]
): Promise<boolean> {
  if (!theofficeSheets) return false;

  try {
    await theofficeSheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
    info("tmaa", `Sheet appended: ${spreadsheetId} range ${range} (${values.length} rows)`);
    return true;
  } catch (err) {
    logError("tmaa", `Sheet append failed (${spreadsheetId}, ${range}): ${err}`);
    return false;
  }
}

/**
 * List all sheets (tabs) in a spreadsheet.
 */
export async function tmaaListSheets(spreadsheetId: string): Promise<Array<{ title: string; sheetId: number }>> {
  if (!theofficeSheets) return [];

  try {
    const res = await theofficeSheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties",
    });

    return (res.data.sheets || []).map((s) => ({
      title: s.properties?.title || "",
      sheetId: s.properties?.sheetId || 0,
    }));
  } catch (err) {
    logError("tmaa", `Sheet list failed (${spreadsheetId}): ${err}`);
    return [];
  }
}

// ============================================================
// CONTEXT BUILDER (injected into Claude's prompt)
// ============================================================

let cachedTmaaContacts: { data: { name: string; email: string }[]; ts: number } | null = null;
const TMAA_CONTACTS_CACHE_TTL = 3_600_000; // 1 hour

async function getCachedTmaaContacts(count: number): Promise<{ name: string; email: string }[]> {
  const now = Date.now();
  if (cachedTmaaContacts && now - cachedTmaaContacts.ts < TMAA_CONTACTS_CACHE_TTL) {
    return cachedTmaaContacts.data;
  }
  const contacts = await tmaaListContacts(count).catch(() => []);
  cachedTmaaContacts = { data: contacts, ts: now };
  return contacts;
}

export async function getTMAAContext(): Promise<string> {
  if (!theofficeAuth) return "";

  const parts: string[] = [];
  parts.push("=== TMAA (The Medical Aesthetics Association) ===");
  parts.push("Account: theoffice@medicalaestheticsassociation.com");

  try {
    const [emails, events, contacts] = await Promise.all([
      tmaaListUnreadEmails(5).catch(() => []),
      tmaaListTodayEvents().catch(() => []),
      getCachedTmaaContacts(10),
    ]);

    if (emails.length > 0) {
      const lines = emails.map(
        (e) => `- From: ${e.from} | Subject: ${e.subject} | ${e.date}`
      );
      parts.push(`TMAA INBOX (${emails.length} unread):\n${lines.join("\n")}`);
    } else {
      parts.push("TMAA INBOX: No unread emails.");
    }

    if (events.length > 0) {
      const lines = events.map((e) => {
        const who = e.attendees?.length ? ` (with: ${e.attendees.join(", ")})` : "";
        const where = e.location ? ` @ ${e.location}` : "";
        return `- ${e.start}-${e.end} ${e.title}${who}${where}`;
      });
      parts.push(`TMAA CALENDAR:\n${lines.join("\n")}`);
    } else {
      parts.push("TMAA CALENDAR: No events today.");
    }

    if (contacts.length > 0) {
      const lines = contacts.map((c) => `- ${c.name}: ${c.email}`);
      parts.push(`TMAA CONTACTS:\n${lines.join("\n")}`);
    }
  } catch (err) {
    warn("tmaa", `Context gathering failed: ${err}`);
    return "";
  }

  return parts.join("\n\n");
}

// ============================================================
// INTENT TAG PROCESSOR
// ============================================================

/**
 * Parse and execute TMAA intent tags from Claude's response.
 * Strips processed tags from the response text.
 */
export async function processTMAAIntents(response: string): Promise<string> {
  let clean = response;

  // [TMAA_DRAFT: to=addr | subject=Subj | body=Body text]
  for (const match of response.matchAll(/\[TMAA_DRAFT:\s*([\s\S]+?)\]/gi)) {
    const params = parseTmaaTagParams(match[1]);
    if (params.to && params.subject && params.body) {
      try {
        const draftId = await tmaaCreateDraft(params.to, params.subject, params.body);
        if (draftId) {
          info("tmaa", `Intent: Draft created (${draftId})`);
        }
      } catch (err) {
        warn("tmaa", `TMAA_DRAFT failed: ${err}`);
      }
    } else {
      warn("tmaa", `Malformed TMAA_DRAFT tag (missing ${!params.to ? "to" : !params.subject ? "subject" : "body"}): ${match[0].substring(0, 100)}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [TMAA_SEND: to=addr | subject=Subj | body=Body text]
  for (const match of response.matchAll(/\[TMAA_SEND:\s*([\s\S]+?)\]/gi)) {
    const params = parseTmaaTagParams(match[1]);
    if (params.to && params.subject && params.body) {
      try {
        const msgId = await tmaaSendEmail(params.to, params.subject, params.body);
        if (msgId) {
          info("tmaa", `Intent: Email sent (${msgId})`);
        }
      } catch (err) {
        warn("tmaa", `TMAA_SEND failed: ${err}`);
      }
    } else {
      warn("tmaa", `Malformed TMAA_SEND tag (missing ${!params.to ? "to" : !params.subject ? "subject" : "body"}): ${match[0].substring(0, 100)}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [TMAA_CAL_ADD: title=Title | date=YYYY-MM-DD | time=HH:MM | duration=60 | invite=email]
  for (const match of response.matchAll(/\[TMAA_CAL_ADD:\s*([\s\S]+?)\]/gi)) {
    const params = parseTmaaTagParams(match[1]);
    if (params.title) {
      try {
        const eventParams: TmaaCreateEventParams = {
          title: params.title,
          date: params.date || tmaaTodayDateStr(),
          time: params.time || "09:00",
          duration: params.duration ? parseInt(params.duration, 10) : 60,
          invite: params.invite ? params.invite.split(",").map((e) => e.trim()) : undefined,
          location: params.location,
          description: params.description,
        };
        const event = await tmaaCreateEvent(eventParams);
        if (event) {
          info("tmaa", `Intent: Calendar event created (${event.title})`);
        }
      } catch (err) {
        warn("tmaa", `TMAA_CAL_ADD failed: ${err}`);
      }
    } else {
      warn("tmaa", `Malformed TMAA_CAL_ADD tag (missing title): ${match[0].substring(0, 100)}`);
    }
    clean = clean.replace(match[0], "");
  }

  // [TMAA_CAL_REMOVE: search text]
  for (const match of response.matchAll(/\[TMAA_CAL_REMOVE:\s*([\s\S]+?)\]/gi)) {
    const searchText = match[1].trim();
    if (!searchText) {
      warn("tmaa", `Empty TMAA_CAL_REMOVE tag`);
      clean = clean.replace(match[0], "");
      continue;
    }
    try {
      const deleted = await tmaaDeleteEvent(searchText);
      if (deleted) {
        info("tmaa", `Intent: Calendar event deleted (${searchText})`);
      }
    } catch (err) {
      warn("tmaa", `TMAA_CAL_REMOVE failed: ${err}`);
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

/**
 * Parse pipe-separated key=value pairs from a TMAA tag body.
 */
function parseTmaaTagParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  const KNOWN_KEYS = "to|subject|body|title|date|time|duration|invite|location|description";
  const parts = raw.split(new RegExp(`\\s*\\|\\s*(?=(?:${KNOWN_KEYS})\\s*[=:])`, "i"));

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    const sepMatch = part.match(new RegExp(`^(${KNOWN_KEYS})\\s*[=:]\\s*`, "i"));
    if (sepMatch) {
      const key = sepMatch[1].trim().toLowerCase();
      const value = part.slice(sepMatch[0].length).trim();
      params[key] = value;
    } else if (i === 0 && !part.match(new RegExp(`^(?:${KNOWN_KEYS})\\s*[=:]`, "i"))) {
      const bare = part.trim();
      if (bare && !params.title) {
        params.title = bare;
      }
    }
  }

  return params;
}

function tmaaTodayDateStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
}
