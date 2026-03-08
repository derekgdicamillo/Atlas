/**
 * Atlas -- Supabase-backed Task Persistence
 *
 * Dual-writes task state to both local JSON and Supabase so background
 * agents survive PM2 restarts. On startup, reconciles Supabase records
 * with local state and marks stale "running" tasks as abandoned.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { info, warn, error as logError } from "./logger.ts";
import type { SupervisedTask } from "./supervisor.ts";

// Module-level supabase ref, set by initTaskPersistence()
let supabase: SupabaseClient | null = null;

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// ============================================================
// INIT
// ============================================================

export function initTaskPersistence(client: SupabaseClient | null): void {
  supabase = client;
  if (client) {
    info("task-persistence", "Supabase task persistence initialized");
  } else {
    warn("task-persistence", "No Supabase client, task persistence is local-only");
  }
}

// ============================================================
// WRITE: Upsert task to Supabase on every state change
// ============================================================

export async function persistTask(task: SupervisedTask): Promise<void> {
  if (!supabase) return;

  try {
    const row = taskToRow(task);
    const { error } = await supabase
      .from("agent_tasks")
      .upsert(row, { onConflict: "id" });

    if (error) {
      warn("task-persistence", `Failed to persist task ${task.id}: ${error.message}`);
    }
  } catch (err) {
    // Non-fatal. Local JSON is still the source of truth.
    warn("task-persistence", `persistTask error for ${task.id}: ${err}`);
  }
}

export async function persistTaskBatch(tasks: SupervisedTask[]): Promise<void> {
  if (!supabase || tasks.length === 0) return;

  try {
    const rows = tasks.map(taskToRow);
    const { error } = await supabase
      .from("agent_tasks")
      .upsert(rows, { onConflict: "id" });

    if (error) {
      warn("task-persistence", `Batch persist failed: ${error.message}`);
    }
  } catch (err) {
    warn("task-persistence", `persistTaskBatch error: ${err}`);
  }
}

// ============================================================
// READ: Sync from Supabase on startup
// ============================================================

export interface OrphanedTask {
  id: string;
  type: string;
  description: string;
  status: string;
  model: string;
  prompt: string | null;
  output_file: string | null;
  cost_usd: number;
  started_at: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Called at startup after loadTasks(). Finds tasks in Supabase that are
 * "running" or "pending" but missing from local JSON. Marks anything
 * running for >2 hours as "abandoned".
 *
 * Returns orphaned tasks that were still viable (< 2 hours old) so the
 * supervisor can decide whether to re-register them.
 */
export async function syncTasksFromSupabase(
  localTaskIds: Set<string>,
): Promise<{ abandoned: number; recovered: OrphanedTask[] }> {
  if (!supabase) {
    return { abandoned: 0, recovered: [] };
  }

  try {
    // Fetch all non-terminal tasks from Supabase
    const { data, error } = await supabase
      .from("agent_tasks")
      .select("*")
      .in("status", ["running", "pending"]);

    if (error) {
      warn("task-persistence", `Sync query failed: ${error.message}`);
      return { abandoned: 0, recovered: [] };
    }

    if (!data || data.length === 0) {
      info("task-persistence", "No active tasks in Supabase to reconcile");
      return { abandoned: 0, recovered: [] };
    }

    let abandonedCount = 0;
    const recovered: OrphanedTask[] = [];
    const now = Date.now();

    for (const row of data) {
      const startedAt = row.started_at ? new Date(row.started_at).getTime() : now;
      const age = now - startedAt;

      if (row.status === "running" && age > TWO_HOURS_MS) {
        // Mark as abandoned in Supabase
        await supabase
          .from("agent_tasks")
          .update({
            status: "abandoned",
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            metadata: { ...((row.metadata as Record<string, unknown>) || {}), abandoned_reason: "stale_after_restart", age_ms: age },
          })
          .eq("id", row.id);

        abandonedCount++;
        info("task-persistence", `Abandoned stale task ${row.id}: "${row.description}" (age: ${Math.round(age / 60000)}m)`);
        continue;
      }

      // Task is still viable. If it's not in local JSON, it was lost in a restart.
      if (!localTaskIds.has(row.id)) {
        recovered.push({
          id: row.id,
          type: row.type,
          description: row.description,
          status: row.status,
          model: row.model,
          prompt: row.prompt,
          output_file: row.output_file,
          cost_usd: row.cost_usd || 0,
          started_at: row.started_at,
          metadata: (row.metadata as Record<string, unknown>) || {},
        });
        info("task-persistence", `Found orphaned task ${row.id}: "${row.description}" (was ${row.status})`);
      }
    }

    if (abandonedCount > 0 || recovered.length > 0) {
      info("task-persistence", `Sync complete: ${abandonedCount} abandoned, ${recovered.length} recoverable`);
    } else {
      info("task-persistence", "Sync complete: all Supabase tasks accounted for in local state");
    }

    return { abandoned: abandonedCount, recovered };
  } catch (err) {
    logError("task-persistence", `syncTasksFromSupabase error: ${err}`);
    return { abandoned: 0, recovered: [] };
  }
}

// ============================================================
// HELPERS
// ============================================================

function taskToRow(task: SupervisedTask): Record<string, unknown> {
  // Truncate result/prompt for output_preview (keep DB rows reasonable)
  const preview = task.result
    ? task.result.substring(0, 2000)
    : task.error
      ? task.error.substring(0, 2000)
      : null;

  return {
    id: task.id,
    type: task.taskType || "research",
    description: task.description,
    status: task.status,
    model: task.model || "sonnet",
    prompt: task.prompt ? task.prompt.substring(0, 10000) : null,
    output_file: task.outputFile,
    output_preview: preview,
    cost_usd: task.costUsd || 0,
    started_at: task.startedAt || task.createdAt,
    completed_at: task.completedAt,
    updated_at: new Date().toISOString(),
    created_at: task.createdAt,
    metadata: {
      requested_by: task.requestedBy,
      agent_id: task.agentId,
      tool_call_count: task.toolCallCount,
      retries: task.retries,
      pid: task.pid,
      cwd: task.cwd,
      swarm_id: task._swarmId || null,
      workflow_id: task.workflowId || null,
    },
  };
}
