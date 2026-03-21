/**
 * Atlas MCP Server -- Google Analytics 4
 *
 * Exposes GA4 reporting data via Model Context Protocol: traffic overview,
 * sources, landing pages, conversions, daily trends, and realtime users.
 * Delegates to ../../src/analytics.ts.
 *
 * Start: bun run mcp-servers/ga4-analytics/index.ts
 *
 * Configuration for Claude Desktop (~/.claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "atlas-ga4": {
 *       "command": "C:\\Users\\Derek DiCamillo\\.bun\\bin\\bun.exe",
 *       "args": ["run", "C:\\Users\\Derek DiCamillo\\Projects\\atlas\\mcp-servers\\ga4-analytics\\index.ts"]
 *     }
 *   }
 * }
 *
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN_DEREK,
 *      GA4_PROPERTY_ID
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log, warn, error as logError } from "../shared/logger.js";
import { formatMcpError } from "../shared/errors.js";
import { TTLCache, withCache } from "../shared/cache.js";
import { CircuitBreaker, withBreaker } from "../shared/circuit-breaker.js";
import { getGoogleOAuth2Client } from "../shared/auth.js";

const SERVER = "ga4";

// ============================================================
// INFRA
// ============================================================

const cache = new TTLCache<string>(60_000); // 60s default TTL

const breaker = new CircuitBreaker({
  name: "ga4-api",
  server: SERVER,
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
});

// ============================================================
// LAZY INIT
// ============================================================

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;

  const oauthClient = await getGoogleOAuth2Client();
  const { initGA4 } = await import("../../src/analytics.ts");
  const ok = initGA4(oauthClient);
  if (!ok) {
    throw new Error("GA4 init failed. Check GA4_PROPERTY_ID env var.");
  }
  initialized = true;
  log(SERVER, "GA4 module initialized");
}

// ============================================================
// MCP SERVER
// ============================================================

const server = new McpServer({
  name: "Atlas GA4",
  version: "1.0.0",
});

// ============================================================
// TOOLS
// ============================================================

// 1. getOverview
server.tool(
  "getOverview",
  "Get website traffic overview: sessions, users, pageviews, engagement rate, bounce rate, conversions over a time period.",
  {
    days: z.number().min(1).max(365).optional().describe("Number of days to look back (default 7)"),
  },
  async ({ days }) => {
    try {
      await ensureInit();
      const period = days ?? 7;
      const text = await withBreaker(breaker, () =>
        withCache(cache, `overview-${period}`, async () => {
          const { getOverview, formatOverview } = await import("../../src/analytics.ts");
          const data = await getOverview(period);
          return formatOverview(data);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getOverview failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 2. getTrafficSources
server.tool(
  "getTrafficSources",
  "Get website traffic broken down by source and medium (e.g. google/organic, facebook/cpc). Includes sessions, users, conversions, engagement rate.",
  {
    days: z.number().min(1).max(365).optional().describe("Number of days to look back (default 7)"),
    limit: z.number().min(1).max(50).optional().describe("Max sources to return (default 10)"),
  },
  async ({ days, limit }) => {
    try {
      await ensureInit();
      const period = days ?? 7;
      const maxRows = limit ?? 10;
      const text = await withBreaker(breaker, () =>
        withCache(cache, `sources-${period}-${maxRows}`, async () => {
          const { getTrafficSources, formatTrafficSources } = await import("../../src/analytics.ts");
          const data = await getTrafficSources(period, maxRows);
          return formatTrafficSources(data);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getTrafficSources failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 3. getLandingPages
server.tool(
  "getLandingPages",
  "Get top landing pages ranked by sessions. Includes bounce rate, session duration, and conversions per page.",
  {
    days: z.number().min(1).max(365).optional().describe("Number of days to look back (default 7)"),
    limit: z.number().min(1).max(50).optional().describe("Max pages to return (default 10)"),
  },
  async ({ days, limit }) => {
    try {
      await ensureInit();
      const period = days ?? 7;
      const maxRows = limit ?? 10;
      const text = await withBreaker(breaker, () =>
        withCache(cache, `landing-${period}-${maxRows}`, async () => {
          const { getLandingPages, formatLandingPages } = await import("../../src/analytics.ts");
          const data = await getLandingPages(period, maxRows);
          return formatLandingPages(data);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getLandingPages failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 4. getConversions
server.tool(
  "getConversions",
  "Get conversion events and their counts (form_submit, generate_lead, purchase, sign_up, contact, schedule_appointment, phone_call, click_to_call).",
  {
    days: z.number().min(1).max(365).optional().describe("Number of days to look back (default 7)"),
  },
  async ({ days }) => {
    try {
      await ensureInit();
      const period = days ?? 7;
      const text = await withBreaker(breaker, () =>
        withCache(cache, `conversions-${period}`, async () => {
          const { getConversions, formatConversions } = await import("../../src/analytics.ts");
          const data = await getConversions(period);
          return formatConversions(data);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getConversions failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 5. getDailyTrend
server.tool(
  "getDailyTrend",
  "Get daily session, user, and conversion trend. Includes week-over-week comparison when period >= 14 days.",
  {
    days: z.number().min(1).max(365).optional().describe("Number of days to look back (default 14)"),
  },
  async ({ days }) => {
    try {
      await ensureInit();
      const period = days ?? 14;
      const text = await withBreaker(breaker, () =>
        withCache(cache, `trend-${period}`, async () => {
          const { getDailyTrend, formatDailyTrend } = await import("../../src/analytics.ts");
          const data = await getDailyTrend(period);
          return formatDailyTrend(data);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getDailyTrend failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 6. getRealtimeUsers
server.tool(
  "getRealtimeUsers",
  "Get the number of currently active users on the website in real time.",
  {},
  async () => {
    try {
      await ensureInit();
      // No cache for realtime - always fresh
      const count = await withBreaker(breaker, async () => {
        const { getRealtimeUsers } = await import("../../src/analytics.ts");
        return getRealtimeUsers();
      });
      return {
        content: [{ type: "text" as const, text: `Active users right now: ${count}` }],
      };
    } catch (err) {
      logError(SERVER, `getRealtimeUsers failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// ============================================================
// RESOURCES
// ============================================================

// ga4://overview/7d -- Last 7 days traffic summary
server.resource(
  "overview-7d",
  "ga4://overview/7d",
  async (uri: URL) => {
    try {
      await ensureInit();
      const data = await withBreaker(breaker, async () => {
        const { getOverview } = await import("../../src/analytics.ts");
        return getOverview(7);
      });
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        }],
      };
    } catch (err) {
      logError(SERVER, `resource overview/7d failed: ${err}`);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ error: String(err) }),
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
  log(SERVER, "MCP server started on stdio");
}

main().catch((err) => {
  logError(SERVER, `Fatal: ${err}`);
  process.exit(1);
});
