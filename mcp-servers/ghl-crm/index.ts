/**
 * Atlas MCP Server -- GoHighLevel CRM
 *
 * Exposes GHL contacts, pipeline, conversations, appointments, notes,
 * tasks, tags, and workflows via MCP. PIT token auth.
 *
 * Start: bun run mcp-servers/ghl-crm/index.ts
 *
 * Configuration for Claude Desktop (~/.claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "atlas-ghl": {
 *       "command": "C:\\Users\\derek\\.bun\\bin\\bun.exe",
 *       "args": ["run", "C:\\Users\\derek\\Projects\\atlas\\mcp-servers\\ghl-crm\\index.ts"]
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

const SERVER = "ghl-crm";

// ============================================================
// CIRCUIT BREAKER
// ============================================================

const ghlBreaker = new CircuitBreaker({
  name: "GHL",
  server: SERVER,
  failureThreshold: 3,
  resetTimeoutMs: 45_000,
});

// ============================================================
// CACHE (30s TTL for list ops)
// ============================================================

const listCache = new TTLCache<unknown>(30_000);

// ============================================================
// LAZY MODULE IMPORT
// ============================================================

let _ghl: typeof import("../../src/ghl.ts") | null = null;

async function ghl() {
  if (!_ghl) {
    _ghl = await import("../../src/ghl.ts");
    const ok = _ghl.initGHL();
    if (!ok) {
      logError(SERVER, "GHL init failed. Check GHL_API_TOKEN, GHL_LOCATION_ID.");
    } else {
      log(SERVER, "GHL module initialized");
    }
  }
  return _ghl;
}

// ============================================================
// MCP SERVER
// ============================================================

const server = new McpServer({
  name: "Atlas GHL CRM",
  version: "1.0.0",
});

// ============================================================
// TOOLS (READ)
// ============================================================

// 1. searchContacts
server.tool(
  "searchContacts",
  "Search GHL contacts by name, email, or phone. Returns matching contacts with ID, name, email, phone, tags.",
  {
    query: z.string().describe("Search query (name, email, or phone)"),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ query, limit }) => {
    try {
      const g = await ghl();
      const results = await withBreaker(ghlBreaker, () =>
        withCache(listCache, `search:${query}:${limit || 10}`, () =>
          g.searchContacts(query, limit || 10)
        )
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 2. getContact
server.tool(
  "getContact",
  "Get a GHL contact by ID. Returns full contact details including tags, source, and date added.",
  {
    contactId: z.string().describe("GHL contact ID"),
  },
  async ({ contactId }) => {
    try {
      const g = await ghl();
      const contact = await withBreaker(ghlBreaker, () => g.getContact(contactId));
      if (!contact) {
        return { content: [{ type: "text" as const, text: `Contact not found: ${contactId}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(contact, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 3. resolveContact
server.tool(
  "resolveContact",
  "Resolve a contact by name. Returns the best match and all candidates. Useful for fuzzy name lookups.",
  {
    name: z.string().describe("Contact name to resolve"),
  },
  async ({ name }) => {
    try {
      const g = await ghl();
      const result = await withBreaker(ghlBreaker, () => g.resolveContact(name));
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 4. getRecentLeads
server.tool(
  "getRecentLeads",
  "Get recent leads (new contacts) from the last N days. Returns contacts sorted by most recent.",
  {
    days: z.number().optional().describe("Days to look back (default 7)"),
  },
  async ({ days }) => {
    try {
      const g = await ghl();
      const result = await withBreaker(ghlBreaker, () =>
        withCache(listCache, `leads:${days || 7}`, () => g.getRecentLeads(days || 7))
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 5. searchOpportunities
server.tool(
  "searchOpportunities",
  "Search opportunities in a pipeline. Filter by status (open/won/lost/all), date range, and limit.",
  {
    pipelineId: z.string().describe("Pipeline ID"),
    status: z.string().optional().describe("Filter: open, won, lost, or all (default open)"),
    limit: z.number().optional().describe("Max results (default 100)"),
    startDate: z.string().optional().describe("Start date filter (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
  },
  async ({ pipelineId, status, limit, startDate, endDate }) => {
    try {
      const g = await ghl();
      const result = await withBreaker(ghlBreaker, () =>
        withCache(listCache, `opps:${pipelineId}:${status || "open"}:${limit}:${startDate}:${endDate}`, () =>
          g.searchOpportunities(pipelineId, { status, limit, startDate, endDate })
        )
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 6. getAllOpportunities
server.tool(
  "getAllOpportunities",
  "Get all opportunities in a pipeline with cursor pagination (up to 5000). Optionally filter by status.",
  {
    pipelineId: z.string().describe("Pipeline ID"),
    status: z.string().optional().describe("Filter: open, won, lost (default: all)"),
  },
  async ({ pipelineId, status }) => {
    try {
      const g = await ghl();
      const results = await withBreaker(ghlBreaker, () =>
        withCache(listCache, `all-opps:${pipelineId}:${status || "all"}`, () =>
          g.getAllOpportunities(pipelineId, status)
        )
      );
      return { content: [{ type: "text" as const, text: JSON.stringify({ count: results.length, opportunities: results }, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 7. getConversations
server.tool(
  "getConversations",
  "Get all conversations for a GHL contact. Returns conversation IDs, types, last message info.",
  {
    contactId: z.string().describe("GHL contact ID"),
  },
  async ({ contactId }) => {
    try {
      const g = await ghl();
      const results = await withBreaker(ghlBreaker, () =>
        withCache(listCache, `convos:${contactId}`, () => g.getConversations(contactId))
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 8. getMessages
server.tool(
  "getMessages",
  "Get messages in a GHL conversation. Returns message body, direction (in/out), status, and timestamps.",
  {
    conversationId: z.string().describe("GHL conversation ID"),
    limit: z.number().optional().describe("Max messages (default 20)"),
  },
  async ({ conversationId, limit }) => {
    try {
      const g = await ghl();
      const results = await withBreaker(ghlBreaker, () =>
        withCache(listCache, `msgs:${conversationId}:${limit || 20}`, () =>
          g.getMessages(conversationId, limit || 20)
        )
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 9. getTodayAppointments
server.tool(
  "getTodayAppointments",
  "Get today's appointments from GHL calendar. Returns title, status, start/end times, and notes.",
  {},
  async () => {
    try {
      const g = await ghl();
      const results = await withBreaker(ghlBreaker, () =>
        withCache(listCache, "today-appts", () => g.getTodayAppointments())
      );
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No appointments today." }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 10. getAppointments
server.tool(
  "getAppointments",
  "Search GHL appointments by date range. Returns title, status, start/end times.",
  {
    startDate: z.string().optional().describe("Start date (YYYY-MM-DD, default today)"),
    endDate: z.string().optional().describe("End date (YYYY-MM-DD)"),
    days: z.number().optional().describe("Number of days from start (default 1, used if no endDate)"),
  },
  async ({ startDate, endDate, days }) => {
    try {
      const g = await ghl();
      const results = await withBreaker(ghlBreaker, () =>
        withCache(listCache, `appts:${startDate}:${endDate}:${days}`, () =>
          g.getAppointments({ startDate, endDate, days })
        )
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 11. getContactNotes
server.tool(
  "getContactNotes",
  "Get all notes for a GHL contact. Returns note body, user who added it, and date.",
  {
    contactId: z.string().describe("GHL contact ID"),
  },
  async ({ contactId }) => {
    try {
      const g = await ghl();
      const results = await withBreaker(ghlBreaker, () =>
        withCache(listCache, `notes:${contactId}`, () => g.getContactNotes(contactId))
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 12. getOpsSnapshot
server.tool(
  "getOpsSnapshot",
  "Get a full operational snapshot: pipeline health, stage breakdown, close/show rates, stale leads, recent leads, appointments, no-shows.",
  {},
  async () => {
    try {
      const g = await ghl();
      const snapshot = await withBreaker(ghlBreaker, () =>
        withCache(listCache, "ops-snapshot", () => g.getOpsSnapshot())
      );
      const formatted = g.formatOpsSnapshot(snapshot);
      return { content: [{ type: "text" as const, text: formatted }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// ============================================================
// TOOLS (WRITE)
// ============================================================

// 13. addContactNote
server.tool(
  "addContactNote",
  "Add a note to a GHL contact. Returns the created note.",
  {
    contactId: z.string().describe("GHL contact ID"),
    body: z.string().describe("Note content"),
  },
  async ({ contactId, body }) => {
    try {
      const g = await ghl();
      const note = await withBreaker(ghlBreaker, () => g.addContactNote(contactId, body));
      if (!note) {
        return { content: [{ type: "text" as const, text: "Failed to add note." }], isError: true };
      }
      listCache.delete(`notes:${contactId}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(note, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 14. createContactTask
server.tool(
  "createContactTask",
  "Create a task for a GHL contact. Returns the created task.",
  {
    contactId: z.string().describe("GHL contact ID"),
    title: z.string().describe("Task title"),
    dueDate: z.string().optional().describe("Due date (ISO 8601, default tomorrow)"),
    description: z.string().optional().describe("Task description"),
    assignedTo: z.string().optional().describe("User ID to assign to"),
  },
  async ({ contactId, title, dueDate, description, assignedTo }) => {
    try {
      const g = await ghl();
      const task = await withBreaker(ghlBreaker, () =>
        g.createContactTask(contactId, title, { dueDate, description, assignedTo })
      );
      if (!task) {
        return { content: [{ type: "text" as const, text: "Failed to create task." }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 15. completeContactTask
server.tool(
  "completeContactTask",
  "Mark a GHL contact task as completed.",
  {
    contactId: z.string().describe("GHL contact ID"),
    taskId: z.string().describe("Task ID to complete"),
  },
  async ({ contactId, taskId }) => {
    try {
      const g = await ghl();
      const success = await withBreaker(ghlBreaker, () =>
        g.completeContactTask(contactId, taskId)
      );
      if (!success) {
        return { content: [{ type: "text" as const, text: "Failed to complete task." }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Task ${taskId} completed.` }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 16. manageContactTag
server.tool(
  "manageContactTag",
  "Add or remove a tag from a GHL contact.",
  {
    contactId: z.string().describe("GHL contact ID"),
    tag: z.string().describe("Tag name"),
    action: z.enum(["add", "remove"]).describe("Whether to add or remove the tag"),
  },
  async ({ contactId, tag, action }) => {
    try {
      const g = await ghl();
      let success: boolean;
      if (action === "remove") {
        success = await withBreaker(ghlBreaker, () => g.removeTagFromContact(contactId, tag));
      } else {
        success = await withBreaker(ghlBreaker, () => g.addTagToContact(contactId, tag));
      }
      if (!success) {
        return { content: [{ type: "text" as const, text: `Failed to ${action} tag "${tag}".` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Tag "${tag}" ${action === "add" ? "added to" : "removed from"} contact ${contactId}.` }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 17. manageWorkflow
server.tool(
  "manageWorkflow",
  "Enroll or remove a GHL contact from a workflow.",
  {
    contactId: z.string().describe("GHL contact ID"),
    workflowId: z.string().describe("Workflow ID"),
    action: z.enum(["enroll", "remove"]).describe("Whether to enroll or remove from workflow"),
  },
  async ({ contactId, workflowId, action }) => {
    try {
      const g = await ghl();
      let success: boolean;
      if (action === "remove") {
        success = await withBreaker(ghlBreaker, () =>
          g.removeContactFromWorkflow(contactId, workflowId)
        );
      } else {
        success = await withBreaker(ghlBreaker, () =>
          g.addContactToWorkflow(contactId, workflowId)
        );
      }
      if (!success) {
        return { content: [{ type: "text" as const, text: `Failed to ${action} contact in workflow.` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Contact ${contactId} ${action === "enroll" ? "enrolled in" : "removed from"} workflow ${workflowId}.` }] };
    } catch (err) {
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// ============================================================
// RESOURCES
// ============================================================

// ghl://pipeline/summary - pipeline health summary
server.resource(
  "pipeline-summary",
  "ghl://pipeline/summary",
  async (uri: URL) => {
    try {
      const g = await ghl();
      const snapshot = await withBreaker(ghlBreaker, () => g.getOpsSnapshot());
      const formatted = g.formatOpsSnapshot(snapshot);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: formatted,
        }],
      };
    } catch (err) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }
  }
);

// ghl://leads/recent - last 24h leads
server.resource(
  "leads-recent",
  "ghl://leads/recent",
  async (uri: URL) => {
    try {
      const g = await ghl();
      const result = await withBreaker(ghlBreaker, () => g.getRecentLeads(1));
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
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
