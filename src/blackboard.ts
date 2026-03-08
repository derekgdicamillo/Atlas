/**
 * Blackboard — Shared scratchpad for swarm agents
 *
 * Agents in a swarm post findings to the blackboard (keyed by swarm_id).
 * Other agents in the same swarm read findings to avoid duplicate work
 * and build on each other's results.
 *
 * Uses upsert on (swarm_id, key) so agents can update their findings.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface BlackboardEntry {
  id: string;
  swarm_id: string;
  agent_id: string;
  key: string;
  value: unknown;
  created_at: string;
}

/**
 * Write (upsert) a finding to the blackboard.
 * If the key already exists for this swarm, it gets overwritten.
 */
export async function writeToBlackboard(
  supabase: SupabaseClient,
  swarmId: string,
  agentId: string,
  key: string,
  value: unknown
): Promise<boolean> {
  const { error } = await supabase
    .from("agent_blackboard")
    .upsert(
      { swarm_id: swarmId, agent_id: agentId, key, value },
      { onConflict: "swarm_id,key" }
    );

  if (error) {
    console.warn(`[blackboard] Write failed (swarm=${swarmId}, key=${key}): ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Read from the blackboard. If key is provided, returns that single entry.
 * If no key, returns all entries for the swarm.
 */
export async function readBlackboard(
  supabase: SupabaseClient,
  swarmId: string,
  key?: string
): Promise<BlackboardEntry[]> {
  let query = supabase
    .from("agent_blackboard")
    .select("id, swarm_id, agent_id, key, value, created_at")
    .eq("swarm_id", swarmId)
    .order("created_at", { ascending: true });

  if (key) {
    query = query.eq("key", key);
  }

  const { data, error } = await query;

  if (error) {
    console.warn(`[blackboard] Read failed (swarm=${swarmId}): ${error.message}`);
    return [];
  }

  return (data ?? []) as BlackboardEntry[];
}

/**
 * Clear all blackboard entries for a completed swarm.
 */
export async function clearBlackboard(
  supabase: SupabaseClient,
  swarmId: string
): Promise<boolean> {
  const { error } = await supabase
    .from("agent_blackboard")
    .delete()
    .eq("swarm_id", swarmId);

  if (error) {
    console.warn(`[blackboard] Clear failed (swarm=${swarmId}): ${error.message}`);
    return false;
  }
  return true;
}
