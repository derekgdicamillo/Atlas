/**
 * Atlas — TMAA Marketing Bridge
 *
 * Schedules and narrates the tmaa-marketing repo (the deterministic
 * "brain" at ~/Projects/tmaa-marketing). Daily pull+verify, weekly board
 * session, brief delivery to Derek, approval handoff, producer run.
 *
 * THE WALL: this module never moves a brief itself. The only promotion
 * path is scripts/approve-brief.mjs in the tmaa repo, and the only
 * automated caller is handleBriefApproval(), which the relay invokes
 * exclusively for Derek's explicit `approve <slug>` message.
 */
import { homedir } from "os";
import { join } from "path";

export const TMAA_DIR =
  process.env.TMAA_MARKETING_DIR || join(homedir(), "Projects", "tmaa-marketing");

/** Files in `after` that were not in `before`. */
export function diffNewBriefs(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return after.filter((f) => !seen.has(f));
}

/** Briefs whose `read_on:` date is exactly today (YYYY-MM-DD). */
export function briefsDueToday(
  briefTexts: Array<{ file: string; text: string }>,
  today: string,
): string[] {
  return briefTexts
    .filter(({ text }) => (text.match(/^read_on:\s*(\S+)/m) || [])[1] === today)
    .map(({ file }) => file);
}

/** Last N lines of a string — for stderr excerpts in alerts. */
export function tail(text: string, lines: number): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}
