/**
 * Atlas Prime — Tag parsing utilities
 *
 * Shared helpers for intent-tag processors (google.ts, ghl.ts) so that
 * illustrative/example tags inside code fences or inline code are NOT
 * treated as live dispatch commands.
 *
 * Without this, Atlas showing a user a syntax example like
 *   `[GHL_WORKFLOW: contact | workflowId | action=add]`
 * would be parsed as a real action request and run through the gate.
 */

export type Range = [number, number];

/**
 * Find all character ranges in `text` that lie inside:
 *   - triple-backtick code fences (```...```)
 *   - single-backtick inline code (`...`)
 *
 * Ranges are [start, end) half-open, character-indexed into `text`.
 */
export function findCodeRanges(text: string): Range[] {
  const ranges: Range[] = [];

  // Triple-backtick fences first (may span lines)
  const tripleRe = /```[\s\S]*?```/g;
  for (const m of text.matchAll(tripleRe)) {
    const start = m.index ?? 0;
    ranges.push([start, start + m[0].length]);
  }

  // Single-backtick inline code — skip if already covered by a triple-fence
  const singleRe = /`[^`\n]+`/g;
  for (const m of text.matchAll(singleRe)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const insideTriple = ranges.some(([rs, re]) => start >= rs && end <= re);
    if (!insideTriple) ranges.push([start, end]);
  }

  return ranges;
}

/**
 * Check if a character position falls within any of the given ranges.
 * Used to decide whether to skip a tag match inside a code block.
 */
export function isInCodeBlock(pos: number, ranges: Range[]): boolean {
  for (const [start, end] of ranges) {
    if (pos >= start && pos < end) return true;
  }
  return false;
}
