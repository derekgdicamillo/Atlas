/**
 * Atlas — DAG Execution Engine
 *
 * Directed Acyclic Graph executor for swarm workflows.
 * Nodes represent tasks, edges represent data dependencies.
 * Independent nodes execute in parallel; blocked nodes wait for upstream completion.
 * Checkpoint system prevents re-running completed nodes on retry.
 *
 * The DAG is the data structure. Orchestrator builds it, this module runs it.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { info, warn, error as logError } from "./logger.ts";
import { registerTask } from "./supervisor.ts";
import { readScratchpad, writeScratchpad } from "./scratchpad.ts";
import { enqueue, dequeueBySwarmId, TaskPriority, SWARM_TTL_MS, type QueuedTask } from "./queue.ts";
import {
  MAX_SWARM_NODES,
  DEFAULT_SWARM_BUDGET_USD,
  DEFAULT_SWARM_WALL_CLOCK_MS,
  type ModelTier,
} from "./constants.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const SWARM_DIR = join(PROJECT_DIR, "data", "swarms");

// ============================================================
// TYPES
// ============================================================

export type SwarmStatus = "planning" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type NodeStatus = "pending" | "ready" | "queued" | "running" | "completed" | "failed" | "skipped";
export type NodeType = "research" | "code" | "synthesize" | "validate";

export interface DAGNode {
  id: string;
  label: string;
  type: NodeType;
  status: NodeStatus;
  taskId: string | null;         // links to SupervisedTask when running
  model: ModelTier | null;       // override; null = let router decide
  prompt: string;
  outputRef: string | null;      // scratchpad key where result lives
  checkpoint: {
    completedAt: string;
    outputHash: string;
  } | null;
  retries: number;
  maxRetries: number;
  timeoutMs: number | null;      // per-node override
  optional: boolean;             // if true, failure doesn't block dependents
  costUsd: number;
}

export interface DAGEdge {
  from: string;                  // source node ID
  to: string;                    // target node ID
  dataFlow: string | null;       // describes what data flows (for documentation)
}

export interface SwarmBudget {
  maxCostUsd: number;
  spentUsd: number;
  maxAgents: number;             // max concurrent for this swarm
  maxNodes: number;
  maxWallClockMs: number;
  startedAt: string | null;
}

export interface SwarmDAG {
  id: string;
  name: string;
  createdAt: string;
  completedAt: string | null;
  status: SwarmStatus;
  nodes: DAGNode[];
  edges: DAGEdge[];
  budget: SwarmBudget;
  result: string | null;         // final synthesized output
  initiatedBy: string;           // userId who triggered it
  error: string | null;
}

// ============================================================
// STATE — all active swarms kept in memory, persisted to disk
// ============================================================

const activeSwarms: Map<string, SwarmDAG> = new Map();

// Callback for notifying user on swarm completion/failure
let notifyCallback: ((swarmId: string, message: string) => Promise<void>) | null = null;

export function registerSwarmNotifyCallback(
  cb: (swarmId: string, message: string) => Promise<void>
): void {
  notifyCallback = cb;
}

// ============================================================
// PERSISTENCE
// ============================================================

async function persistDAG(dag: SwarmDAG): Promise<void> {
  const dir = join(SWARM_DIR, dag.id);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(dir, "dag.json"), JSON.stringify(dag, null, 2));
}

async function loadDAGFromDisk(swarmId: string): Promise<SwarmDAG | null> {
  const dagFile = join(SWARM_DIR, swarmId, "dag.json");
  try {
    const content = await readFile(dagFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Load all active swarms from disk on startup.
 */
export async function loadActiveSwarms(): Promise<void> {
  try {
    if (!existsSync(SWARM_DIR)) return;
    const { readdir } = await import("fs/promises");
    const dirs = await readdir(SWARM_DIR);

    for (const dir of dirs) {
      const dag = await loadDAGFromDisk(dir);
      if (dag && (dag.status === "running" || dag.status === "paused")) {
        activeSwarms.set(dag.id, dag);
        info("dag", `Loaded active swarm: ${dag.id} (${dag.name}) — ${dag.status}`);
      }
    }

    if (activeSwarms.size > 0) {
      info("dag", `Restored ${activeSwarms.size} active swarm(s)`);
    }
  } catch (err) {
    warn("dag", `Failed to load active swarms: ${err}`);
  }
}

// ============================================================
// DAG BUILDER (fluent API)
// ============================================================

export class DAGBuilder {
  private nodes: DAGNode[] = [];
  private edges: DAGEdge[] = [];
  private name: string;
  private nodeCounter = 0;

  constructor(name: string) {
    this.name = name;
  }

  addNode(opts: {
    label: string;
    type: NodeType;
    prompt: string;
    model?: ModelTier;
    optional?: boolean;
    maxRetries?: number;
    timeoutMs?: number;
  }): string {
    const id = `n${++this.nodeCounter}`;
    this.nodes.push({
      id,
      label: opts.label,
      type: opts.type,
      status: "pending",
      taskId: null,
      model: opts.model || null,
      prompt: opts.prompt,
      outputRef: null,
      checkpoint: null,
      retries: 0,
      maxRetries: opts.maxRetries ?? 1,
      timeoutMs: opts.timeoutMs || null,
      optional: opts.optional ?? false,
      costUsd: 0,
    });
    return id;
  }

  addEdge(from: string, to: string, dataFlow?: string): void {
    // Validate nodes exist
    if (!this.nodes.find(n => n.id === from)) {
      throw new Error(`Edge source node "${from}" not found`);
    }
    if (!this.nodes.find(n => n.id === to)) {
      throw new Error(`Edge target node "${to}" not found`);
    }
    this.edges.push({ from, to, dataFlow: dataFlow || null });
  }

  build(opts: {
    initiatedBy: string;
    maxCostUsd?: number;
    maxAgents?: number;
    maxWallClockMs?: number;
  }): SwarmDAG {
    // Validate: no cycles
    this.validateNoCycles();

    // Validate: max nodes
    if (this.nodes.length > MAX_SWARM_NODES) {
      throw new Error(`DAG has ${this.nodes.length} nodes, max is ${MAX_SWARM_NODES}`);
    }

    const id = "swarm_" + Date.now().toString(36) + "_" + Math.random().toString(36).substr(2, 5);

    return {
      id,
      name: this.name,
      createdAt: new Date().toISOString(),
      completedAt: null,
      status: "planning",
      nodes: this.nodes,
      edges: this.edges,
      budget: {
        maxCostUsd: opts.maxCostUsd ?? DEFAULT_SWARM_BUDGET_USD,
        spentUsd: 0,
        maxAgents: opts.maxAgents ?? 4,
        maxNodes: this.nodes.length,
        maxWallClockMs: opts.maxWallClockMs ?? DEFAULT_SWARM_WALL_CLOCK_MS,
        startedAt: null,
      },
      result: null,
      initiatedBy: opts.initiatedBy,
      error: null,
    };
  }

  private validateNoCycles(): void {
    // Kahn's algorithm for topological sort (detects cycles)
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    for (const node of this.nodes) {
      inDegree.set(node.id, 0);
      adjList.set(node.id, []);
    }

    for (const edge of this.edges) {
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
      adjList.get(edge.from)!.push(edge.to);
    }

    const queue = [...inDegree.entries()]
      .filter(([_, deg]) => deg === 0)
      .map(([id]) => id);

    let visited = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      visited++;
      for (const neighbor of adjList.get(node) || []) {
        const deg = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, deg);
        if (deg === 0) queue.push(neighbor);
      }
    }

    if (visited !== this.nodes.length) {
      throw new Error("DAG contains a cycle. Swarm workflows must be acyclic.");
    }
  }
}

/**
 * Helper to create a DAG builder.
 */
export function createDAG(name: string): DAGBuilder {
  return new DAGBuilder(name);
}

// ============================================================
// DAG EXECUTION
// ============================================================

/**
 * Start executing a DAG.
 */
export async function startSwarm(dag: SwarmDAG): Promise<void> {
  dag.status = "running";
  dag.budget.startedAt = new Date().toISOString();
  activeSwarms.set(dag.id, dag);
  await persistDAG(dag);
  info("dag", `Started swarm: ${dag.id} (${dag.name}) — ${dag.nodes.length} nodes`);

  // Kick off the first tick
  await tickDAG(dag.id);
}

/**
 * Get ready nodes: pending nodes whose upstream dependencies are all completed.
 */
function getReadyNodes(dag: SwarmDAG): DAGNode[] {
  return dag.nodes.filter(node => {
    if (node.status !== "pending") return false;

    // Get all upstream node IDs (edges pointing TO this node)
    const upstreamIds = dag.edges
      .filter(e => e.to === node.id)
      .map(e => e.from);

    // All upstreams must be completed (or skipped if optional)
    return upstreamIds.every(id => {
      const upstream = dag.nodes.find(n => n.id === id);
      if (!upstream) return true; // edge to nonexistent node, treat as satisfied
      return upstream.status === "completed" || upstream.status === "skipped";
    });
  });
}

/**
 * Build a node's prompt with upstream results injected.
 */
async function buildNodePrompt(dag: SwarmDAG, node: DAGNode): Promise<string> {
  const upstreamIds = dag.edges
    .filter(e => e.to === node.id)
    .map(e => e.from);

  if (upstreamIds.length === 0) {
    return node.prompt;
  }

  const upstreamResults: string[] = [];
  for (const id of upstreamIds) {
    const upstream = dag.nodes.find(n => n.id === id);
    if (!upstream || upstream.status !== "completed") continue;

    const output = await readScratchpad(dag.id, upstream.id);
    if (output) {
      upstreamResults.push(`## Input from "${upstream.label}":\n\n${output}`);
    }
  }

  if (upstreamResults.length === 0) {
    return node.prompt;
  }

  return `${node.prompt}\n\n---\n\n# Context from previous steps:\n\n${upstreamResults.join("\n\n---\n\n")}`;
}

/**
 * Core DAG tick: check budget/time, dispatch ready nodes, detect completion/failure.
 */
export async function tickDAG(swarmId: string): Promise<void> {
  const dag = activeSwarms.get(swarmId);
  if (!dag || dag.status !== "running") return;

  // 1. Check budget
  if (dag.budget.spentUsd >= dag.budget.maxCostUsd) {
    dag.status = "failed";
    dag.error = `Budget exceeded: $${dag.budget.spentUsd.toFixed(2)} / $${dag.budget.maxCostUsd.toFixed(2)}`;
    dag.completedAt = new Date().toISOString();
    await persistDAG(dag);
    logError("dag", `Swarm ${dag.id} failed: ${dag.error}`);
    if (notifyCallback) await notifyCallback(dag.id, `Swarm "${dag.name}" failed: ${dag.error}`);
    return;
  }

  // 2. Check wall clock
  if (dag.budget.startedAt) {
    const elapsed = Date.now() - new Date(dag.budget.startedAt).getTime();
    if (elapsed > dag.budget.maxWallClockMs) {
      dag.status = "failed";
      dag.error = `Wall clock exceeded: ${Math.round(elapsed / 60000)}min / ${Math.round(dag.budget.maxWallClockMs / 60000)}min`;
      dag.completedAt = new Date().toISOString();
      await persistDAG(dag);
      logError("dag", `Swarm ${dag.id} failed: ${dag.error}`);
      if (notifyCallback) await notifyCallback(dag.id, `Swarm "${dag.name}" failed: ${dag.error}`);
      return;
    }
  }

  // 3. Find ready nodes
  const ready = getReadyNodes(dag);

  // 4. Check for completion or failure
  if (ready.length === 0) {
    const running = dag.nodes.filter(n =>
      n.status === "running" || n.status === "queued" || n.status === "ready"
    );

    if (running.length > 0) {
      // Still have running nodes, wait
      return;
    }

    const allDone = dag.nodes.every(n =>
      n.status === "completed" || n.status === "skipped"
    );

    if (allDone) {
      dag.status = "completed";
      dag.completedAt = new Date().toISOString();
      await persistDAG(dag);
      info("dag", `Swarm ${dag.id} (${dag.name}) completed! ${dag.nodes.length} nodes, $${dag.budget.spentUsd.toFixed(2)}`);
      if (notifyCallback) await notifyCallback(dag.id, "completed");
      return;
    }

    // Check for critical failures (failed node with downstream dependents)
    const failedNodes = dag.nodes.filter(n => n.status === "failed");
    if (failedNodes.length > 0) {
      const hasCriticalFailure = failedNodes.some(fn => {
        if (fn.optional) return false;
        const dependents = dag.edges.filter(e => e.from === fn.id);
        return dependents.length > 0; // has downstream work that can't proceed
      });

      if (hasCriticalFailure) {
        dag.status = "failed";
        dag.error = `Critical node(s) failed: ${failedNodes.filter(n => !n.optional).map(n => n.label).join(", ")}`;
        dag.completedAt = new Date().toISOString();
        await persistDAG(dag);
        logError("dag", `Swarm ${dag.id} failed: ${dag.error}`);
        if (notifyCallback) await notifyCallback(dag.id, `Swarm "${dag.name}" failed: ${dag.error}`);
        return;
      }

      // All failures are optional/leaf nodes. Mark their dependents as skipped.
      for (const fn of failedNodes) {
        markDownstreamSkipped(dag, fn.id);
      }

      // Re-check completion
      const allDoneNow = dag.nodes.every(n =>
        n.status === "completed" || n.status === "skipped" || n.status === "failed"
      );
      if (allDoneNow) {
        dag.status = "completed";
        dag.completedAt = new Date().toISOString();
        await persistDAG(dag);
        info("dag", `Swarm ${dag.id} (${dag.name}) completed with failures. $${dag.budget.spentUsd.toFixed(2)}`);
        if (notifyCallback) await notifyCallback(dag.id, "completed");
        return;
      }
    }

    return;
  }

  // 5. Dispatch ready nodes (respecting per-swarm concurrency)
  const currentRunning = dag.nodes.filter(n =>
    n.status === "running" || n.status === "queued"
  ).length;

  for (const node of ready) {
    if (currentRunning + ready.indexOf(node) >= dag.budget.maxAgents) {
      break; // Respect per-swarm concurrency limit
    }

    // Skip if already checkpointed (resume scenario)
    if (node.checkpoint) {
      node.status = "completed";
      info("dag", `Skipping checkpointed node ${node.id} (${node.label})`);
      continue;
    }

    // Build prompt with upstream results
    const enrichedPrompt = await buildNodePrompt(dag, node);

    // Determine model (Layer 3 router integration point)
    const model = node.model || getDefaultModel(node.type);

    // Generate output file path for research/synthesize/validate tasks
    const outputFile = node.type === "code"
      ? null
      : join("data", "swarms", dag.id, `${node.id}.md`);

    node.status = "queued";
    info("dag", `Dispatching node ${node.id} (${node.label}) as ${model}`);

    try {
      const taskId = await registerTask({
        description: `[${dag.name}] ${node.label}`,
        prompt: enrichedPrompt,
        outputFile: outputFile || undefined,
        model,
        timeoutMs: node.timeoutMs || 10 * 60 * 1000,
        maxRetries: node.maxRetries,
        requestedBy: dag.initiatedBy,
        priority: TaskPriority.HIGH,
        swarmId: dag.id,
        dagNodeId: node.id,
      });

      node.taskId = taskId;
      node.status = "running";
    } catch (err) {
      warn("dag", `Failed to dispatch node ${node.id}: ${err}`);
      node.status = "failed";
      node.retries++;
    }
  }

  await persistDAG(dag);
}

/**
 * Mark all nodes downstream of a failed node as skipped.
 */
function markDownstreamSkipped(dag: SwarmDAG, failedNodeId: string): void {
  const directDependents = dag.edges
    .filter(e => e.from === failedNodeId)
    .map(e => e.to);

  for (const depId of directDependents) {
    const dep = dag.nodes.find(n => n.id === depId);
    if (dep && dep.status === "pending") {
      dep.status = "skipped";
      info("dag", `Skipping node ${dep.id} (${dep.label}) due to upstream failure`);
      markDownstreamSkipped(dag, dep.id); // recursive
    }
  }
}

/**
 * Default model per task type (simple routing, Layer 3 overrides this).
 */
function getDefaultModel(type: NodeType): ModelTier {
  switch (type) {
    case "code": return "opus";
    case "synthesize": return "sonnet";
    case "validate": return "haiku";
    case "research": return "sonnet";
    default: return "sonnet";
  }
}

// ============================================================
// NODE COMPLETION (called by supervisor via callback)
// ============================================================

/**
 * Handle a swarm node completing (called by supervisor's onTaskFinished).
 */
export async function onSwarmNodeComplete(
  taskId: string,
  swarmId: string,
  dagNodeId: string,
  costUsd: number,
): Promise<void> {
  const dag = activeSwarms.get(swarmId);
  if (!dag) {
    warn("dag", `onSwarmNodeComplete: swarm ${swarmId} not found`);
    return;
  }

  const node = dag.nodes.find(n => n.id === dagNodeId);
  if (!node) {
    warn("dag", `onSwarmNodeComplete: node ${dagNodeId} not found in swarm ${swarmId}`);
    return;
  }

  // Read the task output to determine success/failure
  const { getTask } = await import("./supervisor.ts");
  const task = getTask(taskId);

  if (task && (task.status === "completed")) {
    // Read output from scratchpad (supervisor writes output file, which IS the scratchpad for swarm tasks)
    const output = await readScratchpad(swarmId, dagNodeId);
    const hash = output
      ? createHash("sha256").update(output).digest("hex").slice(0, 16)
      : "empty";

    node.status = "completed";
    node.costUsd = costUsd;
    node.checkpoint = {
      completedAt: new Date().toISOString(),
      outputHash: hash,
    };
    dag.budget.spentUsd += costUsd;

    info("dag", `Node ${dagNodeId} (${node.label}) completed. Swarm cost: $${dag.budget.spentUsd.toFixed(2)}`);
  } else {
    // Task failed
    if (node.retries < node.maxRetries) {
      node.retries++;
      node.status = "pending"; // will be re-dispatched on next tick
      node.taskId = null;
      info("dag", `Node ${dagNodeId} (${node.label}) failed, retrying (${node.retries}/${node.maxRetries})`);
    } else {
      node.status = "failed";
      dag.budget.spentUsd += costUsd;
      warn("dag", `Node ${dagNodeId} (${node.label}) failed permanently after ${node.retries} retries`);
    }
  }

  await persistDAG(dag);

  // Advance the DAG
  await tickDAG(swarmId);
}

// ============================================================
// SWARM CONTROL
// ============================================================

/**
 * Cancel a running swarm.
 */
export async function cancelSwarm(swarmId: string): Promise<boolean> {
  const dag = activeSwarms.get(swarmId);
  if (!dag) return false;

  // Remove queued tasks for this swarm
  await dequeueBySwarmId(swarmId);

  // Kill running tasks
  const { cancelTask } = await import("./supervisor.ts");
  for (const node of dag.nodes.filter(n => n.status === "running" && n.taskId)) {
    await cancelTask(node.taskId!, `Swarm "${dag.name}" cancelled`);
  }

  // Mark all non-completed nodes as skipped
  for (const node of dag.nodes) {
    if (node.status !== "completed") {
      node.status = "skipped";
    }
  }

  dag.status = "cancelled";
  dag.completedAt = new Date().toISOString();
  activeSwarms.delete(swarmId);
  await persistDAG(dag);

  info("dag", `Cancelled swarm: ${swarmId} (${dag.name})`);
  return true;
}

/**
 * Pause a running swarm (stops dispatching new nodes, running nodes finish).
 */
export async function pauseSwarm(swarmId: string): Promise<boolean> {
  const dag = activeSwarms.get(swarmId);
  if (!dag || dag.status !== "running") return false;

  dag.status = "paused";
  await persistDAG(dag);
  info("dag", `Paused swarm: ${swarmId} (${dag.name})`);
  return true;
}

/**
 * Resume a paused swarm.
 */
export async function resumeSwarm(swarmId: string): Promise<boolean> {
  const dag = activeSwarms.get(swarmId);
  if (!dag || dag.status !== "paused") return false;

  dag.status = "running";
  await persistDAG(dag);
  info("dag", `Resumed swarm: ${swarmId} (${dag.name})`);
  await tickDAG(swarmId);
  return true;
}

/**
 * Retry failed nodes in a swarm.
 */
export async function retrySwarm(swarmId: string): Promise<number> {
  const dag = activeSwarms.get(swarmId);
  if (!dag) return 0;

  let retried = 0;
  for (const node of dag.nodes) {
    if (node.status === "failed") {
      node.status = "pending";
      node.retries = 0;
      node.taskId = null;
      retried++;
    }
    if (node.status === "skipped") {
      node.status = "pending";
      retried++;
    }
  }

  if (retried > 0) {
    dag.status = "running";
    dag.error = null;
    dag.completedAt = null;
    activeSwarms.set(dag.id, dag);
    await persistDAG(dag);
    await tickDAG(swarmId);
    info("dag", `Retrying ${retried} nodes in swarm ${swarmId}`);
  }

  return retried;
}

// ============================================================
// QUERY
// ============================================================

export function getActiveSwarms(): SwarmDAG[] {
  return [...activeSwarms.values()];
}

export function getSwarm(swarmId: string): SwarmDAG | null {
  return activeSwarms.get(swarmId) || null;
}

/**
 * Get a specific task by ID (exported for onSwarmNodeComplete).
 * This is added to supervisor.ts exports separately.
 */

/**
 * Check if a DAG node is ready to execute (for queue integration).
 */
export function isDagNodeReady(swarmId: string, nodeId: string): boolean {
  const dag = activeSwarms.get(swarmId);
  if (!dag || dag.status !== "running") return false;

  const node = dag.nodes.find(n => n.id === nodeId);
  if (!node || node.status !== "pending") return false;

  const upstreamIds = dag.edges
    .filter(e => e.to === nodeId)
    .map(e => e.from);

  return upstreamIds.every(id => {
    const upstream = dag.nodes.find(n => n.id === id);
    return upstream && (upstream.status === "completed" || upstream.status === "skipped");
  });
}

/**
 * Format swarm status for display.
 */
export function formatSwarmStatus(dag: SwarmDAG): string {
  const elapsed = dag.budget.startedAt
    ? Math.round((Date.now() - new Date(dag.budget.startedAt).getTime()) / 1000)
    : 0;
  const elapsedStr = elapsed > 60 ? `${Math.round(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;

  const lines: string[] = [
    `Swarm: "${dag.name}" (${dag.status}, ${elapsedStr})`,
    `Budget: $${dag.budget.spentUsd.toFixed(2)} / $${dag.budget.maxCostUsd.toFixed(2)} (${Math.round(dag.budget.spentUsd / dag.budget.maxCostUsd * 100)}%)`,
    "",
  ];

  for (const node of dag.nodes) {
    let icon = "--";
    switch (node.status) {
      case "completed": icon = "OK"; break;
      case "running": icon = ".."; break;
      case "queued": icon = ">>"; break;
      case "failed": icon = "XX"; break;
      case "skipped": icon = "//"; break;
      case "pending": icon = "--"; break;
    }

    const model = node.model || getDefaultModel(node.type);
    let detail = "";

    if (node.status === "completed" && node.checkpoint) {
      detail = `$${node.costUsd.toFixed(2)}`;
    } else if (node.status === "running") {
      detail = "running";
    } else if (node.status === "failed") {
      detail = `failed (${node.retries} retries)`;
    } else {
      // Show what this node is waiting for
      const waitingOn = dag.edges
        .filter(e => e.to === node.id)
        .map(e => {
          const src = dag.nodes.find(n => n.id === e.from);
          return src ? src.label : e.from;
        });
      if (waitingOn.length > 0) {
        detail = `waiting (${waitingOn.join(", ")})`;
      }
    }

    lines.push(`[${icon}] ${node.label.padEnd(35)} ${model.padEnd(8)} ${detail}`);
  }

  return lines.join("\n");
}

/**
 * Get all swarm context for /status display.
 */
export function getSwarmContext(): string {
  if (activeSwarms.size === 0) return "";

  const lines: string[] = [`Active swarms: ${activeSwarms.size}`];
  for (const dag of activeSwarms.values()) {
    const completed = dag.nodes.filter(n => n.status === "completed").length;
    const total = dag.nodes.length;
    const running = dag.nodes.filter(n => n.status === "running" || n.status === "queued").length;
    lines.push(`  "${dag.name}": ${completed}/${total} done, ${running} running, $${dag.budget.spentUsd.toFixed(2)}`);
  }
  return lines.join("\n");
}

// ============================================================
// RE-TICK ALL (safety net, called by heartbeat)
// ============================================================

/**
 * Re-tick all active swarms. Called periodically as a safety net
 * in case event-driven completion missed something.
 */
export async function tickAllSwarms(): Promise<void> {
  for (const [swarmId, dag] of activeSwarms) {
    if (dag.status === "running") {
      await tickDAG(swarmId);
    }
  }
}
