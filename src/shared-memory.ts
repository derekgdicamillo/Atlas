/**
 * Shared Memory — Cross-agent memory visibility
 *
 * Atlas and Ishtar run on the same Supabase backend but maintain
 * separate memory contexts. When a memory entry is marked shared,
 * both agents can see it for cross-agent context.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Mark a memory entry as shared so both agents can see it.
 */
export async function markMemoryShared(
  supabase: SupabaseClient,
  factId: string
): Promise<boolean> {
  const { error } = await supabase
    .from("memory")
    .update({ shared: true })
    .eq("id", factId);

  if (error) {
    console.warn(`[shared-memory] Failed to mark ${factId} as shared: ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Fetch memories marked as shared, for cross-agent context injection.
 * Returns newest first.
 */
export async function getSharedMemories(
  supabase: SupabaseClient,
  limit = 20
): Promise<Array<{ id: string; type: string; content: string; created_at: string }>> {
  const { data, error } = await supabase
    .from("memory")
    .select("id, type, content, created_at")
    .eq("shared", true)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.warn(`[shared-memory] Failed to fetch shared memories: ${error.message}`);
    return [];
  }

  return data ?? [];
}
