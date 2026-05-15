import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReplayEntry } from "./replay-dataset.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  turn_id?: string;
  supabase?: SupabaseClient;
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

  // Atlas Prime Sprint 3: fire cortex failure signal for BAD labels.
  if (parsed.label === "bad" && input.turn_id && input.supabase) {
    try {
      const { recordFailure } = await import("./cortex.ts");
      await recordFailure(input.supabase, {
        turn_id: input.turn_id,
        source: "derek-correction",
        reason: parsed.reason ?? "label_bad",
      });
    } catch (err) {
      console.error("[label-tag] cortex.recordFailure failed:", err);
    }
  }

  // Atlas Prime Sprint 6: capture as soft-DPO pair for nightly digest + per-turn injection.
  if (parsed.label === "bad" && input.supabase) {
    try {
      const { capturePair, embedTextOpenAI } = await import("./soft-dpo.ts");
      await capturePair(
        input.supabase,
        {
          source: "label_bad",
          turn_id: input.turn_id,
          user_id: input.agent === "ishtar" ? "esther" : "derek",
          agent: input.agent,
          user_turn: input.prevUserTurn.slice(0, 4000),
          atlas_original: input.prevAtlasResponse.slice(0, 4000),
          derek_corrected: parsed.reason ?? "[LABEL_BAD without specific correction]",
          domain: undefined,
          reason: parsed.reason ?? undefined,
        },
        { embedText: embedTextOpenAI }
      );
    } catch (err) {
      console.error("[label-tag] soft-dpo capture failed:", err);
    }
  }

  return { written: true };
}
