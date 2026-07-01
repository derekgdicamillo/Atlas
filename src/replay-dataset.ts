import { readFile } from "node:fs/promises";

export type ReplayLabel = "good" | "bad" | "mixed";

export interface ReplayEntry {
  id: string;
  capturedAt: string;
  agent: "atlas" | "ishtar";
  userTurn: string;
  contextSummary: string;
  atlasResponse: string;
  derekCorrection: string | null;
  label: ReplayLabel;
  tags: string[];
}

const REQUIRED: (keyof ReplayEntry)[] = [
  "id", "capturedAt", "agent", "userTurn", "contextSummary",
  "atlasResponse", "label", "tags",
];

/**
 * The 2026-06-28 night-shift seeding wrote a "labeler" schema
 * (turn_id / user_message / atlas_response / reason / source / source_date)
 * instead of the canonical ReplayEntry shape, which crashed replay-nightly on
 * load. Map seeded entries to the canonical shape so both coexist in one file.
 * Canonical entries pass through untouched and keep full strict validation.
 */
function normalizeEntry(raw: any): any {
  const seeded =
    raw?.turn_id !== undefined ||
    raw?.user_message !== undefined ||
    raw?.atlas_response !== undefined;
  if (!seeded) return raw;

  const e = { ...raw };
  if (e.id === undefined && typeof e.turn_id === "string") e.id = e.turn_id;
  if (e.userTurn === undefined && typeof e.user_message === "string") e.userTurn = e.user_message;
  if (e.atlasResponse === undefined && typeof e.atlas_response === "string") e.atlasResponse = e.atlas_response;
  if (e.capturedAt === undefined && typeof e.source_date === "string") e.capturedAt = e.source_date;
  if (e.contextSummary === undefined) {
    e.contextSummary = typeof e.source === "string" ? `captured from ${e.source}` : "";
  }
  if (e.tags === undefined) e.tags = ["seeded"];
  if (e.derekCorrection === undefined) {
    e.derekCorrection = e.label === "bad" && typeof e.reason === "string" ? e.reason : null;
  }
  return e;
}

export interface LoadDatasetOptions {
  /**
   * strict=true (default): throw on the first malformed line or invalid entry.
   * strict=false: skip bad lines/entries with a console warning so one bad row
   * can't take down a whole nightly run (replay-nightly 2026-07-01 crash).
   */
  strict?: boolean;
}

export async function loadDataset(
  path: string,
  opts?: LoadDatasetOptions
): Promise<ReplayEntry[]> {
  const strict = opts?.strict !== false;
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  // Pass 1: parse all JSON — surface malformed errors first
  const parsed: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      parsed.push(JSON.parse(lines[i]));
    } catch (err) {
      if (strict) throw new Error(`malformed JSON at ${path}:${i + 1}`);
      console.warn(`[replay-dataset] skipping malformed JSON at ${path}:${i + 1}`);
    }
  }

  // Pass 2: normalize legacy/seeded shapes, then validate required fields
  const out: ReplayEntry[] = [];
  let skipped = 0;
  for (const rawEntry of parsed) {
    const entry = normalizeEntry(rawEntry);
    let invalidField: string | null = null;
    for (const k of REQUIRED) {
      if (entry[k] === undefined) {
        invalidField = k;
        break;
      }
    }
    if (invalidField) {
      if (strict) {
        throw new Error(`entry ${entry.id ?? "?"} missing required field: ${invalidField}`);
      }
      skipped++;
      console.warn(
        `[replay-dataset] skipping entry ${entry.id ?? "?"} (missing ${invalidField})`
      );
      continue;
    }
    if (!("derekCorrection" in entry)) entry.derekCorrection = null;
    out.push(entry as ReplayEntry);
  }
  if (skipped > 0) {
    console.warn(`[replay-dataset] ${skipped} invalid entr${skipped === 1 ? "y" : "ies"} skipped from ${path}`);
  }
  return out;
}
