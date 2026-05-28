import { readFileSync } from "fs";
import { join } from "path";

/** Same intent->server map used by the CLI path (keep in sync with claude.ts INTENT_TO_MCP_SERVERS). */
const INTENT_TO_MCP_SERVERS: Record<string, string[]> = {
  google:     ["google-suite"],
  pipeline:   ["ghl-crm"],
  financial:  ["pv-dashboard"],
  marketing:  ["pv-dashboard", "ga4-analytics"],
  reputation: ["gbp"],
  analytics:  ["ga4-analytics"],
  coding:     [],   // code tasks go through subagents, not MCP
  browser:    ["playwright"],   // Playwright MCP: navigate, click, fill, screenshot
  todos:      [],
};

/** Pure: given the full server map + intent flags, return the subset (atlas core always included). */
export function filterMcpServers(
  all: Record<string, any>,
  intentFlags?: Record<string, boolean>,
): Record<string, any> {
  const needed = new Set<string>(["atlas"]);
  if (intentFlags) {
    for (const [intent, servers] of Object.entries(INTENT_TO_MCP_SERVERS)) {
      if (intentFlags[intent]) for (const s of servers) needed.add(s);
    }
  }
  const out: Record<string, any> = {};
  for (const name of needed) if (all[name]) out[name] = all[name];
  return out;
}

/** Load mcp-servers/mcp.json and return the SDK-shaped mcpServers object, filtered by intent. */
export function loadMcpServersForSdk(intentFlags?: Record<string, boolean>): Record<string, any> {
  const path = join(process.env.PROJECT_DIR || process.cwd(), "mcp-servers", "mcp.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const all = parsed.mcpServers || parsed;
    return filterMcpServers(all, intentFlags);
  } catch {
    return {};
  }
}
