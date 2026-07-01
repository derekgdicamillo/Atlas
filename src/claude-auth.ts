/**
 * Auth helpers for the Claude CLI spawn path.
 *
 * Kept dependency-free on purpose: claude.ts has a heavy import graph and the
 * project .env crashes `bun test` on Windows (Bun 1.3.13 dotenv segfault), so
 * the auth logic that needs unit coverage lives here where it can be imported
 * in isolation.
 */

/**
 * Detects the Claude CLI's authentication-failure output.
 *
 * On a 401 the CLI prints "Failed to authenticate. API Error: 401 Invalid
 * authentication credentials" to stdout and exits non-zero. callClaude must
 * surface this as an error instead of mistaking the 73-char string for a
 * completed answer (the 2026-06-19 silent-masking bug).
 */
export function isAuthFailure(text: string | null | undefined): boolean {
  if (!text) return false;
  return /Failed to authenticate|Invalid authentication credentials/i.test(text);
}

/**
 * Whether a CLAUDE_CODE_OAUTH_TOKEN value should be forwarded to the spawned
 * Claude CLI.
 *
 * A non-empty value is a long-lived `claude setup-token` token and must be
 * forwarded so the CLI authenticates with it directly — no per-spawn refresh,
 * so no refresh-token rotation race. Empty/whitespace/unset means fall back to
 * ~/.claude/.credentials.json.
 */
export function shouldForwardOAuthToken(
  value: string | null | undefined,
): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
