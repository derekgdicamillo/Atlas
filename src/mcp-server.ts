/**
 * Atlas -- MCP Server
 *
 * Exposes Atlas's data sources via the Model Context Protocol.
 * Designed to run as a standalone process for Claude Desktop or VS Code.
 *
 * Start: bun run src/mcp-server.ts
 *
 * Configuration for Claude Desktop (~/.claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "atlas": {
 *       "command": "C:\\Users\\Derek DiCamillo\\.bun\\bin\\bun.exe",
 *       "args": ["run", "C:\\Users\\Derek DiCamillo\\Projects\\atlas\\src\\mcp-server.ts"]
 *     }
 *   }
 * }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// SUPABASE INIT (same env vars as relay.ts, bun auto-loads .env)
// ============================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("[atlas-mcp] Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  process.exit(1);
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

// ============================================================
// MCP SERVER
// ============================================================

const server = new McpServer({
  name: "Atlas",
  version: "1.0.0",
});

// ============================================================
// TOOLS
// ============================================================

// 1. search_memory -- Semantic search across memory
server.tool(
  "search_memory",
  "Search Atlas's memory (facts, goals, messages, documents) using semantic similarity. Returns ranked results with similarity scores.",
  {
    query: z.string().describe("Search query"),
    tables: z.array(z.string()).optional().describe("Tables to search: messages, memory, documents, summaries. Defaults to memory + messages."),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ query, tables, limit }) => {
    try {
      const { data, error } = await supabase.functions.invoke("search", {
        body: {
          query,
          mode: "hybrid",
          tables: tables || ["memory", "messages"],
          match_count: limit || 10,
          use_v2: true,
        },
      });
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  }
);

// 2. get_facts -- All active facts and goals
server.tool(
  "get_facts",
  "Get all stored facts and active goals from Atlas's memory. Returns formatted text with FACTS and GOALS sections.",
  {},
  async () => {
    try {
      const { getMemoryContext } = await import("./memory.ts");
      const context = await getMemoryContext(supabase);
      return { content: [{ type: "text" as const, text: context || "No facts or goals stored." }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  }
);

// 3. browse_memory -- Browse with filters
server.tool(
  "browse_memory",
  "Browse stored memories with optional type and search filters. Supports both semantic and text-based search.",
  {
    type: z.string().optional().describe("Filter by type: fact, goal, completed_goal"),
    search: z.string().optional().describe("Text search within memories (uses semantic search when provided)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ type, search, limit }) => {
    try {
      const { browseMemory } = await import("./memory.ts");
      const result = await browseMemory(supabase, {
        type,
        search,
        limit: limit || 20,
        useEnterpriseSearch: !!search,
      });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  }
);

// 4. search_entities -- Graph search with spreading activation
server.tool(
  "search_entities",
  "Search the entity graph using spreading activation (2-hop traversal). Finds related entities, people, tools, concepts, and their relationships.",
  {
    query: z.string().describe("Entity or concept to search for"),
    max_entities: z.number().optional().describe("Max seed entities (default 5)"),
  },
  async ({ query, max_entities }) => {
    try {
      const { getEntityContextSpreading } = await import("./cognitive.ts");
      const context = await getEntityContextSpreading(supabase, query, max_entities || 5);
      return { content: [{ type: "text" as const, text: context || "No matching entities found." }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  }
);

// 5. remember -- Store a fact
server.tool(
  "remember",
  "Store a new fact in Atlas's long-term memory. Uses contradiction detection and salience scoring.",
  {
    fact: z.string().describe("The fact to remember"),
  },
  async ({ fact }) => {
    try {
      const { processMemoryIntents } = await import("./memory.ts");
      await processMemoryIntents(supabase, `[REMEMBER: ${fact}]`);
      return { content: [{ type: "text" as const, text: `Stored: ${fact}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  }
);

// 6. forget -- Soft-delete matching facts
server.tool(
  "forget",
  "Soft-delete facts matching a search query. Marks them as historical rather than permanently deleting.",
  {
    search: z.string().describe("Search text to find facts to forget"),
  },
  async ({ search }) => {
    try {
      const { forgetFacts } = await import("./memory.ts");
      const count = await forgetFacts(supabase, search);
      return { content: [{ type: "text" as const, text: `Forgot ${count} fact(s) matching "${search}"` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  }
);

// 7. get_alerts -- Recent alerts
server.tool(
  "get_alerts",
  "Get recent alerts from the alert pipeline. Includes severity, category, delivery status, and suppression info.",
  {
    hours: z.number().optional().describe("Hours to look back (default 24)"),
  },
  async ({ hours }) => {
    try {
      const { getRecentAlerts } = await import("./alerts.ts");
      const result = await getRecentAlerts(supabase, hours || 24);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  }
);

// 8. browse_graph -- Browse entity graph
server.tool(
  "browse_graph",
  "Browse the entity-relationship graph with optional filters. Shows entities, their types, descriptions, and connection counts.",
  {
    type: z.string().optional().describe("Entity type: person, org, program, tool, concept, location"),
    search: z.string().optional().describe("Search entity names"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ type, search, limit }) => {
    try {
      const { browseGraph } = await import("./graph.ts");
      const result = await browseGraph(supabase, { type, search, limit });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  }
);

// ============================================================
// RESOURCES
// ============================================================

// atlas://memory/facts -- Active facts
server.resource(
  "memory-facts",
  "atlas://memory/facts",
  async (uri: URL) => {
    const { data } = await supabase.rpc("get_facts");
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(data || [], null, 2),
      }],
    };
  }
);

// atlas://memory/goals -- Active goals
server.resource(
  "memory-goals",
  "atlas://memory/goals",
  async (uri: URL) => {
    const { data } = await supabase.rpc("get_active_goals");
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(data || [], null, 2),
      }],
    };
  }
);

// atlas://graph/entities -- All entities
server.resource(
  "graph-entities",
  "atlas://graph/entities",
  async (uri: URL) => {
    const { data } = await supabase
      .from("memory_entities")
      .select("id, name, entity_type, description, aliases")
      .order("updated_at", { ascending: false })
      .limit(100);
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(data || [], null, 2),
      }],
    };
  }
);

// atlas://alerts/recent -- Last 24h alerts
server.resource(
  "alerts-recent",
  "atlas://alerts/recent",
  async (uri: URL) => {
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data } = await supabase
      .from("alerts")
      .select("*")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(50);
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(data || [], null, 2),
      }],
    };
  }
);

// atlas://system/health -- Health status
server.resource(
  "system-health",
  "atlas://system/health",
  async (uri: URL) => {
    const { existsSync, readFileSync } = await import("fs");
    const { join } = await import("path");
    const healthPath = join(
      process.env.PROJECT_DIR || process.cwd(),
      "data",
      "health.json"
    );
    let health: Record<string, unknown> = { status: "unknown" };
    if (existsSync(healthPath)) {
      try {
        health = JSON.parse(readFileSync(healthPath, "utf-8"));
      } catch { /* fallback to unknown */ }
    }
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(health, null, 2),
      }],
    };
  }
);

// ============================================================
// START
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Use stderr for logging since stdout is the MCP protocol channel
  console.error("[atlas-mcp] Server started on stdio");
}

main().catch((err) => {
  console.error("[atlas-mcp] Fatal:", err);
  process.exit(1);
});
