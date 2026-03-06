/**
 * MCP Shared -- Structured Error Types
 *
 * Consistent error types for MCP tool responses. Includes error factories
 * for common failure modes and a formatter that produces MCP-compatible
 * text content blocks.
 */

// ============================================================
// BASE ERROR
// ============================================================

export class McpToolError extends Error {
  /** Machine-readable error code (e.g. "NOT_FOUND", "RATE_LIMITED") */
  public readonly code: string;
  /** Optional structured details for debugging */
  public readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.details = details;
  }
}

// ============================================================
// ERROR FACTORIES
// ============================================================

/** Resource not found (404-equivalent). */
export function notFound(msg: string): McpToolError {
  return new McpToolError(msg, "NOT_FOUND");
}

/** Authentication or authorization failure (401/403-equivalent). */
export function unauthorized(msg: string): McpToolError {
  return new McpToolError(msg, "UNAUTHORIZED");
}

/** Rate limited by upstream API (429-equivalent). */
export function rateLimited(msg: string, retryAfter?: number): McpToolError {
  return new McpToolError(msg, "RATE_LIMITED", retryAfter != null ? { retryAfter } : undefined);
}

/** Generic upstream API error with optional status code. */
export function apiError(service: string, msg: string, statusCode?: number): McpToolError {
  return new McpToolError(
    `${service}: ${msg}`,
    "API_ERROR",
    statusCode != null ? { service, statusCode } : { service },
  );
}

/** Input validation failure. */
export function validationError(msg: string): McpToolError {
  return new McpToolError(msg, "VALIDATION_ERROR");
}

// ============================================================
// FORMATTER
// ============================================================

/**
 * Format any error into an MCP tool response content block.
 * Extracts structured info from McpToolError, falls back to .message or String().
 */
export function formatMcpError(err: unknown): { type: "text"; text: string } {
  if (err instanceof McpToolError) {
    let text = `Error [${err.code}]: ${err.message}`;
    if (err.details) {
      text += `\n${JSON.stringify(err.details)}`;
    }
    return { type: "text", text };
  }

  if (err instanceof Error) {
    return { type: "text", text: `Error: ${err.message}` };
  }

  return { type: "text", text: `Error: ${String(err)}` };
}
