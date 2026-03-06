/**
 * Atlas MCP Server -- PV Dashboard
 *
 * Exposes PV Dashboard financials, pipeline, attribution, speed-to-lead,
 * and combined overview via Model Context Protocol.
 * Delegates to ../../src/dashboard.ts.
 *
 * Start: bun run mcp-servers/pv-dashboard/index.ts
 *
 * Configuration for Claude Desktop (~/.claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "atlas-dashboard": {
 *       "command": "C:\\Users\\derek\\.bun\\bin\\bun.exe",
 *       "args": ["run", "C:\\Users\\derek\\Projects\\atlas\\mcp-servers\\pv-dashboard\\index.ts"]
 *     }
 *   }
 * }
 *
 * Env: DASHBOARD_API_TOKEN, DASHBOARD_URL (optional, defaults to Vercel)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log, warn, error as logError } from "../shared/logger.js";
import { formatMcpError } from "../shared/errors.js";
import { TTLCache, withCache } from "../shared/cache.js";
import { CircuitBreaker, withBreaker } from "../shared/circuit-breaker.js";

const SERVER = "dashboard";

// ============================================================
// INFRA
// ============================================================

const cache = new TTLCache<string>(60_000); // 60s default TTL

const breaker = new CircuitBreaker({
  name: "dashboard-api",
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

  const { initDashboard, isDashboardReady } = await import("../../src/dashboard.ts");
  const ok = initDashboard();
  if (!ok || !isDashboardReady()) {
    throw new Error("Dashboard init failed. Check DASHBOARD_API_TOKEN env var.");
  }
  initialized = true;
  log(SERVER, "Dashboard module initialized");
}

// ============================================================
// PERIOD SCHEMA (reused across tools)
// ============================================================

const periodSchema = z.enum(["week", "month", "quarter", "year"]).optional()
  .describe("Time period: week, month (default), quarter, or year");

// ============================================================
// MCP SERVER
// ============================================================

const server = new McpServer({
  name: "Atlas Dashboard",
  version: "1.0.0",
});

// ============================================================
// TOOLS
// ============================================================

// 1. getFinancials
server.tool(
  "getFinancials",
  "Get financial overview: revenue, COGS, expenses, net income, profit margin, balance sheet, unit economics, and monthly trend.",
  {
    period: periodSchema,
  },
  async ({ period }) => {
    try {
      await ensureInit();
      const p = period ?? "month";
      const text = await withBreaker(breaker, () =>
        withCache(cache, `financials-${p}`, async () => {
          const { getFinancials, formatFinancials } = await import("../../src/dashboard.ts");
          const data = await getFinancials(p);
          return formatFinancials(data);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getFinancials failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 2. getDeepFinancials
server.tool(
  "getDeepFinancials",
  "Get detailed financial breakdown: P&L, balance sheet, revenue/expense by category, month-over-month comparison, YTD, unit economics, and anomaly alerts.",
  {},
  async () => {
    try {
      await ensureInit();
      const text = await withBreaker(breaker, () =>
        withCache(cache, "deep-financials", async () => {
          const { getDeepFinancials } = await import("../../src/dashboard.ts");
          return getDeepFinancials();
        }, 120_000) // 2 min cache for deep financials (expensive call)
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getDeepFinancials failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 3. getPipeline
server.tool(
  "getPipeline",
  "Get pipeline/funnel metrics: stage breakdown, win/loss counts, close rate, show rate, stale leads, avg deal value.",
  {
    period: periodSchema,
  },
  async ({ period }) => {
    try {
      await ensureInit();
      const p = period ?? "month";
      const text = await withBreaker(breaker, () =>
        withCache(cache, `pipeline-${p}`, async () => {
          const { getPipeline, formatPipeline } = await import("../../src/dashboard.ts");
          const data = await getPipeline(p);
          return formatPipeline(data);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getPipeline failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 4. getOverview
server.tool(
  "getOverview",
  "Get combined business overview: leads, ad spend, CPL, cost per won, consults, no-shows, show rate, close rate.",
  {
    period: periodSchema,
  },
  async ({ period }) => {
    try {
      await ensureInit();
      const p = period ?? "month";
      const text = await withBreaker(breaker, () =>
        withCache(cache, `overview-${p}`, async () => {
          const { getOverview, formatOverview } = await import("../../src/dashboard.ts");
          const data = await getOverview(p);
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

// 5. getSpeedToLead
server.tool(
  "getSpeedToLead",
  "Get speed-to-lead metrics: average/median response time, percentage under 5/30/60 min, won vs lost response times.",
  {
    period: periodSchema,
  },
  async ({ period }) => {
    try {
      await ensureInit();
      const p = period ?? "month";
      const text = await withBreaker(breaker, () =>
        withCache(cache, `stl-${p}`, async () => {
          const { getSpeedToLead, formatSpeedToLead } = await import("../../src/dashboard.ts");
          const data = await getSpeedToLead(p);
          return formatSpeedToLead(data);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getSpeedToLead failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 6. getAttribution
server.tool(
  "getAttribution",
  "Get marketing attribution by source: lead counts, win/loss per source, close rates, total value, and stage aging.",
  {
    period: periodSchema,
  },
  async ({ period }) => {
    try {
      await ensureInit();
      const p = period ?? "month";
      const text = await withBreaker(breaker, () =>
        withCache(cache, `attribution-${p}`, async () => {
          const { getAttribution, formatAttribution } = await import("../../src/dashboard.ts");
          const data = await getAttribution(p);
          return formatAttribution(data);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getAttribution failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// ============================================================
// RESOURCES
// ============================================================

// dashboard://financials/month -- Current month financials
server.resource(
  "financials-month",
  "dashboard://financials/month",
  async (uri: URL) => {
    try {
      await ensureInit();
      const data = await withBreaker(breaker, async () => {
        const { getFinancials } = await import("../../src/dashboard.ts");
        return getFinancials("month");
      });
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        }],
      };
    } catch (err) {
      logError(SERVER, `resource financials/month failed: ${err}`);
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

// dashboard://pipeline/current -- Current pipeline state
server.resource(
  "pipeline-current",
  "dashboard://pipeline/current",
  async (uri: URL) => {
    try {
      await ensureInit();
      const data = await withBreaker(breaker, async () => {
        const { getPipeline } = await import("../../src/dashboard.ts");
        return getPipeline("month");
      });
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        }],
      };
    } catch (err) {
      logError(SERVER, `resource pipeline/current failed: ${err}`);
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
