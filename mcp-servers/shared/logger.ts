/**
 * MCP Shared -- Stderr Logger
 *
 * MCP uses stdout for JSON-RPC protocol messages, so ALL application
 * logging MUST go to stderr. This module provides simple, dependency-free
 * logging with consistent formatting across all Atlas MCP servers.
 */

function fmt(level: string, server: string, msg: string): string {
  return `${new Date().toISOString()} [mcp:${server}] ${level} ${msg}`;
}

/** Info-level log to stderr. */
export function log(server: string, msg: string): void {
  process.stderr.write(fmt("INFO", server, msg) + "\n");
}

/** Warning-level log to stderr. */
export function warn(server: string, msg: string): void {
  process.stderr.write(fmt("WARN", server, msg) + "\n");
}

/** Error-level log to stderr. */
export function error(server: string, msg: string): void {
  process.stderr.write(fmt("ERROR", server, msg) + "\n");
}
