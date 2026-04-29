import type { SupabaseClient } from "@supabase/supabase-js";

export interface SalienceWeights {
  access: number;
  trust: number;
  incident: number;
  demotion: number;
}

export const DEFAULT_SALIENCE_WEIGHTS: SalienceWeights = {
  access: 0.3,
  trust: 0.3,
  incident: 0.2,
  demotion: 0.2,
};

export interface SalienceResult {
  memoryId: string;
  score: number;
  components: { access: number; trust: number; incident: number; demotion: number };
}

const INCIDENT_TAGS = new Set(["decision", "incident", "regret", "surprise", "correction"]);

export async function computeSalience(
  supabase: SupabaseClient,
  memoryId: string,
  weights: SalienceWeights = DEFAULT_SALIENCE_WEIGHTS
): Promise<SalienceResult> {
  const { data: row } = await supabase
    .from("memory")
    .select("id, access_count_since_rewrite, demotion_pressure, tags")
    .eq("id", memoryId)
    .single();

  if (!row) {
    return {
      memoryId,
      score: 0,
      components: { access: 0, trust: 0, incident: 0, demotion: 0 },
    };
  }

  const r = row as any;

  // Access component: capped at 1 (saturates at 10 accesses)
  const accessRaw = Number(r.access_count_since_rewrite ?? 0);
  const access = Math.min(accessRaw / 10, 1);

  // Incident component: 1 if any incident-class tag is present
  const tags: string[] = Array.isArray(r.tags) ? r.tags : [];
  const incident = tags.some((t) => INCIDENT_TAGS.has(t)) ? 1 : 0;

  // Demotion component: scales linearly 0-1 over pressure range [0, 3]
  const demotionPressure = Number(r.demotion_pressure ?? 0);
  const demotion = Math.min(demotionPressure, 3) / 3;

  // Trust component: 1.0 if any trust-negative event in last 7d shares a turn_id
  // with this memory via attribution_log
  let trust = 0;
  try {
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: attrTurns } = await supabase
      .from("attribution_log")
      .select("turn_id")
      .eq("memory_id", memoryId)
      .gte("created_at", cutoff);

    const turnIds = new Set((attrTurns ?? []).map((a: any) => a.turn_id));
    if (turnIds.size > 0) {
      const { readFile } = await import("node:fs/promises");
      try {
        const raw = await readFile("data/trust-snapshots.jsonl", "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.delta === -1 && ev.turn_id && turnIds.has(ev.turn_id)) {
              trust = 1;
              break;
            }
          } catch {
            // skip malformed lines
          }
        }
      } catch {
        // file may not exist yet
      }
    }
  } catch (err) {
    console.error("[dream-engine] trust component lookup failed:", err);
  }

  const score =
    weights.access * access +
    weights.trust * trust +
    weights.incident * incident +
    weights.demotion * demotion;

  return { memoryId, score, components: { access, trust, incident, demotion } };
}

/**
 * Return the top-k most salient memories updated within the last `hoursBack` hours.
 * Excludes demoted memories. Used by SWS + REM consolidation stages.
 */
export async function topSalient(
  supabase: SupabaseClient,
  hoursBack = 24,
  k = 10,
  weights: SalienceWeights = DEFAULT_SALIENCE_WEIGHTS
): Promise<SalienceResult[]> {
  const cutoff = new Date(Date.now() - hoursBack * 3_600_000).toISOString();
  const { data: rows } = await supabase
    .from("memory")
    .select("id")
    .gte("updated_at", cutoff)
    .neq("class", "demoted")
    .limit(200);

  const ids = (rows ?? []).map((r: any) => r.id);
  const out: SalienceResult[] = [];
  for (const id of ids) {
    out.push(await computeSalience(supabase, id, weights));
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}
