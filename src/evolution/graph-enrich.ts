/**
 * Atlas — Nightly Graph Enrichment
 *
 * Batch entity extraction from the last 24h of messages. Auto-creates
 * entities in the graph and infers co-occurrence relationships when
 * entities appear in the same or adjacent messages.
 *
 * This supplements the real-time [ENTITY:] and [RELATE:] tags with
 * automatic discovery from conversation history.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn } from "../logger.ts";
import { extractEntities, autoCreateEntities } from "../cognitive.ts";
import { invalidateCache } from "../cognitive.ts";

// ============================================================
// TYPES
// ============================================================

export interface GraphEnrichmentResult {
  messagesScanned: number;
  entitiesExtracted: number;
  entitiesCreated: number;
  edgesCreated: number;
  durationMs: number;
}

// ============================================================
// MAIN ENTRY
// ============================================================

/**
 * Run nightly graph enrichment. Scans last 24h of messages for entities
 * and creates relationships based on co-occurrence.
 */
export async function runGraphEnrichment(
  supabase: SupabaseClient,
): Promise<GraphEnrichmentResult> {
  const startTime = Date.now();
  info("evolution:graph-enrich", "Starting graph enrichment...");

  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 24);

  // Fetch recent messages
  const { data: messages, error } = await supabase
    .from("messages")
    .select("id, role, content, created_at")
    .gte("created_at", cutoff.toISOString())
    .order("created_at", { ascending: true })
    .limit(500);

  if (error || !messages?.length) {
    info("evolution:graph-enrich", "No recent messages to scan.");
    return { messagesScanned: 0, entitiesExtracted: 0, entitiesCreated: 0, edgesCreated: 0, durationMs: Date.now() - startTime };
  }

  // Extract entities from all messages
  const allEntities = new Map<string, { name: string; type: string; messageIds: string[] }>();

  for (const msg of messages) {
    const extracted = extractEntities(msg.content);
    for (const entity of extracted) {
      const key = entity.name.toLowerCase();
      const existing = allEntities.get(key);
      if (existing) {
        existing.messageIds.push(msg.id);
      } else {
        allEntities.set(key, {
          name: entity.name,
          type: entity.type,
          messageIds: [msg.id],
        });
      }
    }
  }

  // Create new entities
  const entitiesToCreate = [...allEntities.values()].map((e) => ({
    name: e.name,
    type: e.type,
    confidence: 0.7,
  }));

  let entitiesCreated = 0;
  if (entitiesToCreate.length > 0) {
    entitiesCreated = await autoCreateEntities(supabase, entitiesToCreate);
    if (entitiesCreated > 0) {
      invalidateCache("graph");
    }
  }

  // Infer co-occurrence relationships
  let edgesCreated = 0;
  const entityList = [...allEntities.values()];

  for (let i = 0; i < entityList.length; i++) {
    for (let j = i + 1; j < entityList.length; j++) {
      const a = entityList[i];
      const b = entityList[j];

      // Check if entities co-occur in the same message or adjacent messages
      const sharedMessages = a.messageIds.filter((id) => b.messageIds.includes(id));

      // Also check adjacency (message i and i+1)
      let adjacentCount = 0;
      for (const aId of a.messageIds) {
        const aIdx = messages.findIndex((m) => m.id === aId);
        if (aIdx < 0) continue;
        for (const bId of b.messageIds) {
          const bIdx = messages.findIndex((m) => m.id === bId);
          if (bIdx < 0) continue;
          if (Math.abs(aIdx - bIdx) <= 1) adjacentCount++;
        }
      }

      const coOccurrences = sharedMessages.length + Math.floor(adjacentCount / 2);

      if (coOccurrences >= 2) {
        // Create "co-discussed" edge
        try {
          // Resolve entity IDs
          const { data: sourceEntity } = await supabase
            .from("memory_entities")
            .select("id")
            .ilike("name", a.name)
            .limit(1);
          const { data: targetEntity } = await supabase
            .from("memory_entities")
            .select("id")
            .ilike("name", b.name)
            .limit(1);

          if (sourceEntity?.length && targetEntity?.length) {
            const { error: edgeError } = await supabase
              .from("memory_edges")
              .upsert(
                {
                  source_entity_id: sourceEntity[0].id,
                  target_entity_id: targetEntity[0].id,
                  relationship: "co-discussed",
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "source_entity_id,target_entity_id,relationship" },
              );

            if (!edgeError) {
              edgesCreated++;
            }
          }
        } catch {
          // non-critical, continue
        }
      }
    }
  }

  if (edgesCreated > 0) {
    invalidateCache("graph");
  }

  const durationMs = Date.now() - startTime;
  info("evolution:graph-enrich", `Enrichment complete: ${messages.length} msgs scanned, ${allEntities.size} entities found, ${entitiesCreated} created, ${edgesCreated} edges (${(durationMs / 1000).toFixed(1)}s)`);

  return {
    messagesScanned: messages.length,
    entitiesExtracted: allEntities.size,
    entitiesCreated,
    edgesCreated,
    durationMs,
  };
}
