/**
 * Atlas MCP Server -- Google Suite
 *
 * Exposes Gmail, Calendar, and Contacts via MCP.
 * Two-account model: Derek (read/draft/calendar/contacts), Atlas (send).
 *
 * Start: bun run mcp-servers/google-suite/index.ts
 *
 * Configuration for Claude Desktop (~/.claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "atlas-google": {
 *       "command": "C:\\Users\\derek\\.bun\\bin\\bun.exe",
 *       "args": ["run", "C:\\Users\\derek\\Projects\\atlas\\mcp-servers\\google-suite\\index.ts"]
 *     }
 *   }
 * }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { log, warn, error as logError } from "../shared/logger.js";
import { TTLCache, withCache } from "../shared/cache.js";
import { CircuitBreaker, withBreaker } from "../shared/circuit-breaker.js";
import { formatMcpError } from "../shared/errors.js";

const SERVER = "google-suite";

// ============================================================
// CIRCUIT BREAKERS
// ============================================================

const gmailBreaker = new CircuitBreaker({
  name: "Gmail",
  server: SERVER,
  failureThreshold: 4,
  resetTimeoutMs: 60_000,
});

const calendarBreaker = new CircuitBreaker({
  name: "Calendar",
  server: SERVER,
  failureThreshold: 4,
  resetTimeoutMs: 60_000,
});

const contactsBreaker = new CircuitBreaker({
  name: "Contacts",
  server: SERVER,
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
});

// ============================================================
// CACHE (30s TTL for list ops)
// ============================================================

const listCache = new TTLCache<unknown>(30_000);

// ============================================================
// LAZY MODULE IMPORT
// ============================================================

let _google: typeof import("../../src/google.ts") | null = null;

async function google() {
  if (!_google) {
    _google = await import("../../src/google.ts");
    const ok = _google.initGoogle();
    if (!ok) {
      logError(SERVER, "Google init failed. Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN_DEREK.");
    } else {
      log(SERVER, "Google module initialized");
    }
  }
  return _google;
}

// ============================================================
// MCP SERVER
// ============================================================

const server = new McpServer({
  name: "Atlas Google Suite",
  version: "1.0.0",
});

// ============================================================
// TOOLS
// ============================================================

// 1. listUnreadEmails
server.tool(
  "listUnreadEmails",
  "List unread emails from Derek's inbox. Returns sender, subject, date, and snippet for each.",
  {
    limit: z.number().optional().describe("Max emails to return (default 10)"),
    query: z.string().optional().describe("Gmail search query to filter (e.g. 'from:someone')"),
  },
  async ({ limit, query }) => {
    try {
      const g = await google();
      const results = await withBreaker(gmailBreaker, () =>
        withCache(listCache, `unread:${limit || 10}:${query || ""}`, () =>
          g.listUnreadEmails(limit || 10)
        )
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 2. getEmail
server.tool(
  "getEmail",
  "Get full email content by message ID. Returns headers, body text, and metadata.",
  {
    messageId: z.string().describe("Gmail message ID"),
  },
  async ({ messageId }) => {
    try {
      const g = await google();
      const result = await withBreaker(gmailBreaker, () => g.getEmailById(messageId));
      if (!result) {
        return { content: [{ type: "text" as const, text: `Email not found: ${messageId}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 3. createDraft
server.tool(
  "createDraft",
  "Create an email draft in Derek's Gmail. Returns the draft ID.",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body text"),
  },
  async ({ to, subject, body }) => {
    try {
      const g = await google();
      const draftId = await withBreaker(gmailBreaker, () => g.createDraft(to, subject, body));
      if (!draftId) {
        return { content: [{ type: "text" as const, text: "Failed to create draft. Gmail may not be configured." }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Draft created: ${draftId}` }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 4. sendEmail
server.tool(
  "sendEmail",
  "Send an email via Atlas's Gmail account (assistant.ai.atlas@gmail.com). Returns the message ID.",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body text"),
  },
  async ({ to, subject, body }) => {
    try {
      const g = await google();
      const msgId = await withBreaker(gmailBreaker, () => g.sendEmail(to, subject, body));
      if (!msgId) {
        return { content: [{ type: "text" as const, text: "Failed to send email. Atlas Gmail may not be configured." }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Email sent: ${msgId}` }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 5. listTodayEvents
server.tool(
  "listTodayEvents",
  "List today's calendar events from Derek's Google Calendar. Returns title, start/end times, location, and attendees.",
  {},
  async () => {
    try {
      const g = await google();
      const events = await withBreaker(calendarBreaker, () =>
        withCache(listCache, "today-events", () => g.listTodayEvents())
      );
      if (events.length === 0) {
        return { content: [{ type: "text" as const, text: "No events today." }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(events, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 6. createCalendarEvent
server.tool(
  "createCalendarEvent",
  "Create a calendar event on Derek's Google Calendar. Returns the created event.",
  {
    title: z.string().describe("Event title"),
    date: z.string().describe("Event date (YYYY-MM-DD)"),
    time: z.string().describe("Start time (HH:MM, 24-hour)"),
    duration: z.number().optional().describe("Duration in minutes (default 60)"),
    description: z.string().optional().describe("Event description"),
    location: z.string().optional().describe("Event location"),
  },
  async ({ title, date, time, duration, description, location }) => {
    try {
      const g = await google();
      const event = await withBreaker(calendarBreaker, () =>
        g.createEvent({ title, date, time, duration, description, location })
      );
      if (!event) {
        return { content: [{ type: "text" as const, text: "Failed to create event. Calendar may not be configured." }], isError: true };
      }
      listCache.delete("today-events");
      return { content: [{ type: "text" as const, text: JSON.stringify(event, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 7. deleteCalendarEvent
server.tool(
  "deleteCalendarEvent",
  "Delete a calendar event by searching for it by name. Deletes the first match in the next 30 days.",
  {
    searchText: z.string().describe("Text to search for in event titles"),
  },
  async ({ searchText }) => {
    try {
      const g = await google();
      const deleted = await withBreaker(calendarBreaker, () => g.deleteEvent(searchText));
      listCache.delete("today-events");
      if (deleted) {
        return { content: [{ type: "text" as const, text: `Deleted event matching: "${searchText}"` }] };
      }
      return { content: [{ type: "text" as const, text: `No event found matching: "${searchText}"` }], isError: true };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 8. sendCalendarInvite
server.tool(
  "sendCalendarInvite",
  "Create a calendar event and send .ics invite emails to attendees via Atlas's Gmail.",
  {
    title: z.string().describe("Event title"),
    date: z.string().describe("Event date (YYYY-MM-DD)"),
    time: z.string().describe("Start time (HH:MM, 24-hour)"),
    duration: z.number().optional().describe("Duration in minutes (default 60)"),
    attendees: z.array(z.string()).describe("Email addresses of attendees"),
    description: z.string().optional().describe("Event description"),
    location: z.string().optional().describe("Event location"),
  },
  async ({ title, date, time, duration, attendees, description, location }) => {
    try {
      const g = await google();
      const event = await withBreaker(calendarBreaker, () =>
        g.createEvent({
          title,
          date,
          time,
          duration,
          invite: attendees,
          description,
          location,
        })
      );
      if (!event) {
        return { content: [{ type: "text" as const, text: "Failed to create event with invite." }], isError: true };
      }
      listCache.delete("today-events");
      return { content: [{ type: "text" as const, text: `Event created with invite sent to ${attendees.join(", ")}:\n${JSON.stringify(event, null, 2)}` }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 9. lookupContact
server.tool(
  "lookupContact",
  "Search Derek's Google Contacts by name or email. Returns matching names and email addresses.",
  {
    query: z.string().describe("Name or email to search for"),
  },
  async ({ query }) => {
    try {
      const g = await google();
      const results = await withBreaker(contactsBreaker, () =>
        withCache(listCache, `contact:${query}`, () => g.lookupContact(query))
      );
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No contacts found for: "${query}"` }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 10. listContacts
server.tool(
  "listContacts",
  "List Derek's Google Contacts, sorted by most recently modified. Returns names and email addresses.",
  {
    limit: z.number().optional().describe("Max contacts to return (default 20)"),
  },
  async ({ limit }) => {
    try {
      const g = await google();
      const results = await withBreaker(contactsBreaker, () =>
        withCache(listCache, `contacts:${limit || 20}`, () => g.listContacts(limit || 20))
      );
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No contacts found." }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// ============================================================
// RESOURCES
// ============================================================

// google://inbox/unread - current unread count + recent subjects
server.resource(
  "inbox-unread",
  "google://inbox/unread",
  async (uri: URL) => {
    try {
      const g = await google();
      const emails = await withBreaker(gmailBreaker, () => g.listUnreadEmails(5));
      const summary = {
        unreadCount: emails.length,
        recent: emails.map((e) => ({
          from: e.from,
          subject: e.subject,
          date: e.date,
        })),
      };
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(summary, null, 2),
        }],
      };
    } catch (err) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: `Error fetching inbox: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  }
);

// google://calendar/today - today's events
server.resource(
  "calendar-today",
  "google://calendar/today",
  async (uri: URL) => {
    try {
      const g = await google();
      const events = await withBreaker(calendarBreaker, () => g.listTodayEvents());
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(events, null, 2),
        }],
      };
    } catch (err) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: `Error fetching calendar: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  }
);

// ============================================================
// START
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(SERVER, "Server started on stdio");
}

main().catch((err) => {
  logError(SERVER, `Fatal: ${err}`);
  process.exit(1);
});
