import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReplayEntry } from "./replay-dataset.ts";

const TAG_RE = /\[LABEL_(GOOD|BAD)(?::\s*([^\]]+))?\]/i;

export function parseLabelTag(text: string): { label: "good" | "bad"; reason: string | null } | null {
  const m = text.match(TAG_RE);
  if (!m) return null;
  return {
    label: m[1].toLowerCase() === "good" ? "good" : "bad",
    reason: m[2]?.trim() || null,
  };
}

export interface LabelTagInput {
  tagText: string;
  prevUserTurn: string | null;
  prevAtlasResponse: string | null;
  agent: "atlas" | "ishtar";
  contextSummary?: string;
  datasetPath?: string;
}

export async function processLabelTag(
  input: LabelTagInput
): Promise<{ written: boolean; reason?: string }> {
  const parsed = parseLabelTag(input.tagText);
  if (!parsed) return { written: false, reason: "not a label tag" };
  if (!input.prevUserTurn || !input.prevAtlasResponse) {
    return { written: false, reason: "no previous turn available" };
  }
  const path = input.datasetPath ?? "data/replay-dataset.jsonl";
  const now = new Date();
  const entry: ReplayEntry = {
    id: `${now.toISOString().slice(0, 10)}-labeled-${now.getTime()}`,
    capturedAt: now.toISOString(),
    agent: input.agent,
    userTurn: input.prevUserTurn.slice(0, 4000),
    contextSummary: input.contextSummary ?? "",
    atlasResponse: input.prevAtlasResponse.slice(0, 4000),
    derekCorrection: parsed.reason,
    label: parsed.label,
    tags: ["in-conversation-label"],
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  return { written: true };
}
