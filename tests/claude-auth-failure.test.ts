import { describe, test, expect } from "bun:test";
import { isAuthFailure, shouldForwardOAuthToken } from "../src/claude-auth.ts";

// Regression for 2026-06-19: the Claude CLI prints "Failed to authenticate.
// API Error: 401 Invalid authentication credentials" to stdout and exits 1.
// The completed-with-errors heuristic in claude.ts was treating that 73-char
// string as a real answer. isAuthFailure() lets callClaude surface it as an
// error instead of serving the auth message as Atlas's reply.
describe("isAuthFailure", () => {
  test("detects the Claude CLI 401 auth-failure stdout", () => {
    expect(
      isAuthFailure(
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      ),
    ).toBe(true);
  });

  test("detects a bare 'Invalid authentication credentials'", () => {
    expect(isAuthFailure("Invalid authentication credentials")).toBe(true);
  });

  test("does not flag a normal answer", () => {
    expect(
      isAuthFailure("Booked the 2pm consult and texted the patient."),
    ).toBe(false);
  });

  test("handles empty/null/undefined safely", () => {
    expect(isAuthFailure("")).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });
});

// A long-lived `claude setup-token` token must reach the spawned CLI so it
// authenticates without the racing credentials.json refresh that wiped the
// refresh token on 2026-06-19. An empty/unset value must NOT be forwarded so
// the CLI falls back to credentials.json instead of 401-ing on a blank token.
describe("shouldForwardOAuthToken", () => {
  test("forwards a non-empty long-lived token", () => {
    expect(shouldForwardOAuthToken("sk-ant-oat-test-long-lived")).toBe(true);
  });

  test("does not forward an empty string", () => {
    expect(shouldForwardOAuthToken("")).toBe(false);
  });

  test("does not forward a whitespace-only value", () => {
    expect(shouldForwardOAuthToken("   ")).toBe(false);
  });

  test("does not forward null/undefined", () => {
    expect(shouldForwardOAuthToken(null)).toBe(false);
    expect(shouldForwardOAuthToken(undefined)).toBe(false);
  });
});
