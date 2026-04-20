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

export async function loadDataset(path: string): Promise<ReplayEntry[]> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  // Pass 1: parse all JSON — surface malformed errors first
  const parsed: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      parsed.push(JSON.parse(lines[i]));
    } catch (err) {
      throw new Error(`malformed JSON at ${path}:${i + 1}`);
    }
  }

  // Pass 2: validate required fields
  const out: ReplayEntry[] = [];
  for (const entry of parsed) {
    for (const k of REQUIRED) {
      if (entry[k] === undefined) {
        throw new Error(`entry ${entry.id ?? "?"} missing required field: ${k}`);
      }
    }
    if (!("derekCorrection" in entry)) entry.derekCorrection = null;
    out.push(entry as ReplayEntry);
  }
  return out;
}
