/**
 * Atlas — Graph Memory Module
 *
 * Entity-relationship graph stored in Supabase (memory_entities + memory_edges).
 * Claude auto-manages the graph via intent tags in its responses:
 *   [ENTITY: name | TYPE: person/org/program/tool/concept/location | DESC: description]
 *   [RELATE: source -> relationship -> target]
 *
 * Augments the existing flat fact store with structured relationships.
 * The relay parses these tags, upserts entities/edges, and strips them
 * from the response before sending to the user.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { warn } from "./logger.ts";

// ============================================================
// TYPES
// ============================================================

export interface Entity {
  id: string;
  name: string;
  entity_type: string;
  description: string | null;
  aliases: string[];
}

export interface EntityNeighbor {
  entity_id: string;
  entity_name: string;
  entity_type: string;
  entity_description: string | null;
  relationship: string;
  related_entity_id: string;
  related_entity_name: string;
  related_entity_type: string;
  direction: "outgoing" | "incoming";
  depth: number;
}

// Valid entity types
const VALID_TYPES = new Set(["person", "org", "program", "tool", "concept", "location"]);

// ============================================================
// INTENT PARSING
// ============================================================

/**
 * Parse ENTITY and RELATE tags from Claude's response.
 * Creates/updates entities and edges, then strips tags from response.
 */
export async function processGraphIntents(
  supabase: SupabaseClient | null,
  response: string
): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [ENTITY: name | TYPE: person | DESC: optional description]
  // Split on | only when followed by TYPE: or DESC: to avoid pipe-in-name issues
  for (const match of response.matchAll(/\[ENTITY:\s*([\s\S]+?)\]/gi)) {
    const inner = match[1];
    const parts = inner.split(/\s*\|\s*(?=(?:TYPE|DESC)\s*:)/i);

    const name = parts[0].trim();
    let rawType = "concept";
    let description: string | null = null;

    for (let i = 1; i < parts.length; i++) {
      const typeMatch = parts[i].match(/^TYPE\s*:\s*(\S+)/i);
      const descMatch = parts[i].match(/^DESC\s*:\s*([\s\S]*)/i);
      if (typeMatch) rawType = typeMatch[1].trim().toLowerCase();
      else if (descMatch) description = descMatch[1].trim() || null;
    }

    const type = VALID_TYPES.has(rawType) ? rawType : "concept";

    if (name) {
      try {
        await upsertEntity(supabase, { name, type, description });
      } catch (err) {
        console.warn(`[graph] ENTITY upsert failed for "${name}": ${err}`);
      }
    }
    clean = clean.replace(match[0], "");
  }

  // [RELATE: source -> relationship -> target]
  for (const match of response.matchAll(
    /\[RELATE:\s*([\s\S]+?)\s*->\s*([\s\S]+?)\s*->\s*([\s\S]+?)\]/gi
  )) {
    const source = match[1].trim();
    const relationship = match[2].trim().toLowerCase();
    const target = match[3].trim();

    if (source && relationship && target) {
      try {
        await upsertEdge(supabase, { source, target, relationship });
      } catch (err) {
        console.warn(`[graph] RELATE upsert failed "${source} -> ${relationship} -> ${target}": ${err}`);
      }
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

// ============================================================
// ENTITY CRUD
// ============================================================

/**
 * Create or update an entity by canonical name (case-insensitive dedup).
 * If the entity exists, updates description and type if provided.
 */
async function upsertEntity(
  supabase: SupabaseClient,
  entity: { name: string; type: string; description?: string | null }
): Promise<string | null> {
  try {
    const canonicalName = entity.name.trim();

    // Check if entity already exists (case-insensitive)
    const { data: existing } = await supabase
      .from("memory_entities")
      .select("id, name, description")
      .ilike("name", canonicalName)
      .limit(1);

    if (existing?.length) {
      // Update if description is new/better or type changed
      const updates: Record<string, unknown> = {};
      if (entity.description && entity.description !== existing[0].description) {
        updates.description = entity.description;
      }
      if (entity.type) {
        updates.entity_type = entity.type;
      }
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        await supabase
          .from("memory_entities")
          .update(updates)
          .eq("id", existing[0].id);
      }
      return existing[0].id;
    }

    // Create new entity
    const { data, error } = await supabase
      .from("memory_entities")
      .insert({
        name: canonicalName,
        entity_type: entity.type,
        description: entity.description || null,
      })
      .select("id")
      .single();

    if (error) {
      warn("graph", `Failed to create entity "${canonicalName}": ${error.message}`);
      return null;
    }

    return data.id;
  } catch (err) {
    warn("graph", `upsertEntity error: ${err}`);
    return null;
  }
}

/**
 * Create or update an edge between two entities.
 * Auto-creates entities if they don't exist yet.
 */
async function upsertEdge(
  supabase: SupabaseClient,
  edge: { source: string; target: string; relationship: string }
): Promise<void> {
  try {
    const sourceId = await resolveEntityId(supabase, edge.source);
    const targetId = await resolveEntityId(supabase, edge.target);

    if (!sourceId || !targetId) {
      warn("graph", `Could not resolve entities for edge: ${edge.source} -> ${edge.target}`);
      return;
    }

    const { error } = await supabase
      .from("memory_edges")
      .upsert(
        {
          source_entity_id: sourceId,
          target_entity_id: targetId,
          relationship: edge.relationship,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "source_entity_id,target_entity_id,relationship" }
      );

    if (error) {
      warn("graph", `Failed to upsert edge: ${error.message}`);
    }
  } catch (err) {
    warn("graph", `upsertEdge error: ${err}`);
  }
}

/**
 * Find entity by name (case-insensitive) or create a minimal placeholder.
 */
async function resolveEntityId(
  supabase: SupabaseClient,
  name: string
): Promise<string | null> {
  const trimmed = name.trim();

  const { data } = await supabase
    .from("memory_entities")
    .select("id")
    .ilike("name", trimmed)
    .limit(1);

  if (data?.length) return data[0].id;

  // Auto-create minimal entity so the edge can link to it
  const { data: created, error } = await supabase
    .from("memory_entities")
    .insert({ name: trimmed, entity_type: "concept" })
    .select("id")
    .single();

  if (error) {
    warn("graph", `Could not auto-create entity "${trimmed}": ${error.message}`);
    return null;
  }
  return created.id;
}

// ============================================================
// GRAPH QUERIES
// ============================================================

/**
 * Given a query string, find relevant entities via vector search
 * and return them with their 1-hop neighbors.
 * Used for per-message context injection.
 */
export async function getEntityContext(
  supabase: SupabaseClient | null,
  query: string,
  maxEntities = 5
): Promise<string> {
  if (!supabase) return "";

  try {
    // Vector search for relevant entities via the search edge function
    const { data: results, error } = await supabase.functions.invoke("search", {
      body: {
        query,
        table: "memory_entities",
        match_count: maxEntities,
        match_threshold: 0.6,
      },
    });

    if (error || !results?.length) return "";

    // For each matched entity (top 3), get 1-hop neighbors
    const sections: string[] = [];
    for (const entity of results.slice(0, 3)) {
      const { data: neighbors } = await supabase.rpc("get_entity_neighbors", {
        start_entity_id: entity.id,
        max_depth: 1,
      });

      let section = `${entity.name} (${entity.entity_type})`;
      if (entity.description) section += `: ${entity.description}`;

      if (neighbors?.length) {
        const rels = neighbors.map((n: EntityNeighbor) => {
          if (n.direction === "outgoing") {
            return `  ${n.entity_name} ${n.relationship} ${n.related_entity_name}`;
          }
          return `  ${n.related_entity_name} ${n.relationship} ${n.entity_name}`;
        });
        // Deduplicate relationship lines
        const unique = [...new Set(rels)];
        section += "\n" + unique.join("\n");
      }

      sections.push(section);
    }

    return sections.length > 0
      ? "ENTITY GRAPH:\n" + sections.join("\n\n")
      : "";
  } catch (err) {
    warn("graph", `getEntityContext failed: ${err}`);
    return "";
  }
}

/**
 * Get a compact summary of key entities for prompt injection.
 * Called every prompt (when graph feature is enabled).
 * Kept concise to minimize token usage.
 */
export async function getGraphContext(
  supabase: SupabaseClient | null
): Promise<string> {
  if (!supabase) return "";

  try {
    // Get entity count
    const { count } = await supabase
      .from("memory_entities")
      .select("id", { count: "exact", head: true });

    if (!count || count === 0) return "";

    // Get most recently updated entities (top 10)
    const { data: entities } = await supabase
      .from("memory_entities")
      .select("id, name, entity_type, description")
      .order("updated_at", { ascending: false })
      .limit(10);

    if (!entities?.length) return "";

    const lines = entities.map((e: Entity) => {
      const desc = e.description ? `: ${e.description}` : "";
      return `- ${e.name} (${e.entity_type})${desc}`;
    });

    return `KNOWN ENTITIES (${count} total, showing recent):\n${lines.join("\n")}`;
  } catch (err) {
    warn("graph", `getGraphContext failed: ${err}`);
    return "";
  }
}

/**
 * Browse the entity graph. Used by /graph command.
 * Supports filtering by type and name search.
 */
export async function browseGraph(
  supabase: SupabaseClient | null,
  options: { type?: string; search?: string; limit?: number } = {}
): Promise<string> {
  if (!supabase) return "Graph not available (Supabase not configured).";

  const { type, search, limit = 20 } = options;

  try {
    let query = supabase
      .from("memory_entities")
      .select("id, name, entity_type, description, created_at")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (type) query = query.eq("entity_type", type);
    if (search) query = query.ilike("name", `%${search}%`);

    const { data: entities, error } = await query;
    if (error) return `Graph error: ${error.message}`;
    if (!entities?.length) return "No entities in graph.";

    // Get edge counts per entity in a single query
    const entityIds = entities.map((e: Entity) => e.id);
    const { data: edgeCounts } = await supabase
      .from("memory_edges")
      .select("source_entity_id, target_entity_id")
      .or(
        entityIds.map((id: string) => `source_entity_id.eq.${id}`).join(",") +
        "," +
        entityIds.map((id: string) => `target_entity_id.eq.${id}`).join(",")
      );

    // Count connections per entity
    const countMap = new Map<string, number>();
    if (edgeCounts) {
      for (const edge of edgeCounts) {
        countMap.set(edge.source_entity_id, (countMap.get(edge.source_entity_id) || 0) + 1);
        countMap.set(edge.target_entity_id, (countMap.get(edge.target_entity_id) || 0) + 1);
      }
    }

    const lines = entities.map((e: Entity) => {
      const desc = e.description ? ` - ${e.description}` : "";
      const connections = countMap.get(e.id) || 0;
      return `[${e.entity_type.toUpperCase()}] ${e.name}${desc} (${connections} connections)`;
    });

    // Get total count
    const { count: total } = await supabase
      .from("memory_entities")
      .select("id", { count: "exact", head: true });

    return `Entity Graph (${total || entities.length} total):\n${lines.join("\n")}`;
  } catch (err) {
    return `Graph error: ${err}`;
  }
}
