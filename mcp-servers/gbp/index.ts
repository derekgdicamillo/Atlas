/**
 * Atlas MCP Server -- Google Business Profile
 *
 * Exposes GBP reviews, performance metrics, and search keywords
 * via Model Context Protocol. Delegates to ../../src/gbp.ts.
 *
 * Start: bun run mcp-servers/gbp/index.ts
 *
 * Configuration for Claude Desktop (~/.claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "atlas-gbp": {
 *       "command": "C:\\Users\\derek\\.bun\\bin\\bun.exe",
 *       "args": ["run", "C:\\Users\\derek\\Projects\\atlas\\mcp-servers\\gbp\\index.ts"]
 *     }
 *   }
 * }
 *
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN_DEREK,
 *      GBP_ACCOUNT_ID, GBP_LOCATION_ID
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log, warn, error as logError } from "../shared/logger.js";
import { formatMcpError } from "../shared/errors.js";
import { TTLCache, withCache } from "../shared/cache.js";
import { CircuitBreaker, withBreaker } from "../shared/circuit-breaker.js";
import { getGoogleOAuth2Client } from "../shared/auth.js";

const SERVER = "gbp";

// ============================================================
// INFRA
// ============================================================

const cache = new TTLCache<string>(60_000); // 60s default TTL

const breaker = new CircuitBreaker({
  name: "gbp-api",
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
  const { initGBP } = await import("../../src/gbp.ts");
  const ok = initGBP(oauthClient);
  if (!ok) {
    throw new Error("GBP init failed. Check GBP_ACCOUNT_ID and GBP_LOCATION_ID env vars.");
  }
  initialized = true;
  log(SERVER, "GBP module initialized");
}

// ============================================================
// MCP SERVER
// ============================================================

const server = new McpServer({
  name: "Atlas GBP",
  version: "1.0.0",
});

// ============================================================
// TOOLS
// ============================================================

// 1. getReviewSummary
server.tool(
  "getReviewSummary",
  "Get Google Business Profile review stats: average rating, total count, unreplied count, rating distribution, review velocity, and recent reviews.",
  {},
  async () => {
    try {
      await ensureInit();
      const text = await withBreaker(breaker, () =>
        withCache(cache, "review-summary", async () => {
          const { getReviewSummary, formatReviewSummary } = await import("../../src/gbp.ts");
          const summary = await getReviewSummary();
          return formatReviewSummary(summary);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getReviewSummary failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 2. getPerformanceMetrics
server.tool(
  "getPerformanceMetrics",
  "Get GBP performance metrics (impressions, website clicks, phone calls, direction requests, conversations, bookings) over a time period.",
  {
    days: z.number().min(1).max(90).optional().describe("Number of days to look back (default 7, max 90)"),
  },
  async ({ days }) => {
    try {
      await ensureInit();
      const period = days ?? 7;
      const text = await withBreaker(breaker, () =>
        withCache(cache, `perf-${period}`, async () => {
          const { getPerformanceMetrics, formatPerformanceMetrics } = await import("../../src/gbp.ts");
          const metrics = await getPerformanceMetrics(period);
          return formatPerformanceMetrics(metrics);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getPerformanceMetrics failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// 3. getSearchKeywords
server.tool(
  "getSearchKeywords",
  "Get top search keywords driving traffic to the Google Business Profile listing (latest month).",
  {},
  async () => {
    try {
      await ensureInit();
      const text = await withBreaker(breaker, () =>
        withCache(cache, "search-keywords", async () => {
          const { getSearchKeywords, formatSearchKeywords } = await import("../../src/gbp.ts");
          const keywords = await getSearchKeywords();
          return formatSearchKeywords(keywords);
        })
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logError(SERVER, `getSearchKeywords failed: ${err}`);
      return { content: [formatMcpError(err)], isError: true };
    }
  }
);

// ============================================================
// RESOURCES
// ============================================================

// gbp://reviews/summary -- Current review summary
server.resource(
  "reviews-summary",
  "gbp://reviews/summary",
  async (uri: URL) => {
    try {
      await ensureInit();
      const data = await withBreaker(breaker, async () => {
        const { getReviewSummary } = await import("../../src/gbp.ts");
        return getReviewSummary();
      });
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        }],
      };
    } catch (err) {
      logError(SERVER, `resource reviews/summary failed: ${err}`);
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

// gbp://metrics/30d -- 30-day performance snapshot
server.resource(
  "metrics-30d",
  "gbp://metrics/30d",
  async (uri: URL) => {
    try {
      await ensureInit();
      const data = await withBreaker(breaker, async () => {
        const { getPerformanceMetrics } = await import("../../src/gbp.ts");
        return getPerformanceMetrics(30);
      });
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        }],
      };
    } catch (err) {
      logError(SERVER, `resource metrics/30d failed: ${err}`);
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
