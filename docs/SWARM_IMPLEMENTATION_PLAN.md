# Atlas Agent Swarm: Full Implementation Plan

## Design Philosophy

Three principles from the research, applied to Atlas's constraints:

1. **Orchestrator-worker with context sharding** (K2.5's core insight). No peer-to-peer communication between subagents. Atlas (the orchestrator) decomposes, dispatches, aggregates. Subagents work in isolation with independent context windows and return only task-relevant outputs.

2. **Structured topology, not bag-of-agents** (Google/MIT scaling research). Unstructured flat topologies amplify errors 17x. Every agent gets an explicit role, clear task boundaries, and defined output contract. Dynamic role assignment (K2.5-style) but within a structured framework.

3. **Start simple, earn complexity** (Anthropic's guidance). Each layer builds on the previous one. Don't ship Layer 3 until Layer 1 is battle-tested.

---

## Architecture Overview

```
                    Telegram
                       |
                   relay.ts (unchanged message loop)
                       |
                  [SWARM: ...] tag detected
                       |
                  orchestrator.ts (NEW)
                       |
            +---------+---------+
            |         |         |
         queue.ts  dag.ts  router.ts
            |         |         |
            +----+----+----+---+
                 |              |
           supervisor.ts (extended)
                 |
        +--------+--------+
        |        |        |
     agent 1  agent 2  agent 3  ...
     (claude CLI processes)
```

**New modules:**
- `src/orchestrator.ts` - Swarm lifecycle management, task decomposition, result synthesis
- `src/queue.ts` - Priority queue with backpressure
- `src/dag.ts` - Dependency graph, topological execution, checkpoint/resume
- `src/router.ts` - Model selection, cost budgeting, capability matching
- `src/scratchpad.ts` - Shared results store (Supabase-backed)
- `db/migrations/004_swarm.sql` - Schema for swarm state

**Extended modules:**
- `src/supervisor.ts` - New task type "swarm", event-driven completion (not polling)
- `src/relay.ts` - New tags, `/swarm` command, swarm status display
- `src/constants.ts` - Swarm limits, model capability registry

---

## Layer 1: Priority Queue + Backpressure

**Goal:** When all 5 slots are full, new work queues instead of failing. Tasks execute in priority order. Backpressure prevents runaway spawning.

### 1.1 Queue Data Structure

```typescript
// src/queue.ts

interface QueuedTask {
  id: string;
  priority: TaskPriority;
  enqueuedAt: string;          // ISO timestamp
  task: Omit<SupervisedTask, 'status'>;
  swarmId?: string;            // null for standalone tasks
  dagNodeId?: string;          // null for standalone tasks
  ttl: number;                 // max ms in queue before auto-cancel
}

enum TaskPriority {
  CRITICAL = 0,    // user-facing, blocking Telegram response
  HIGH = 1,        // swarm tasks with downstream dependents
  NORMAL = 2,      // standard research/code tasks
  LOW = 3,         // background, heartbeat, summarization
  IDLE = 4,        // speculative prefetch, nice-to-have
}

interface QueueState {
  tasks: QueuedTask[];
  maxConcurrent: number;       // default 5, adjustable
  running: number;             // current active count
  totalEnqueued: number;       // lifetime counter
  totalDropped: number;        // TTL expirations
}
```

### 1.2 Queue Operations

```typescript
// Core operations
enqueue(task: QueuedTask): void
  // Insert sorted by priority, then by enqueuedAt (FIFO within priority)
  // If queue exceeds MAX_QUEUE_SIZE (25), drop lowest priority task
  // Persist to data/queue.json

dequeue(): QueuedTask | null
  // Pop highest priority task
  // Return null if queue empty

tryDispatch(): void
  // Called on: task completion, queue insertion, periodic tick (30s)
  // While running < maxConcurrent AND queue not empty:
  //   task = dequeue()
  //   if task.swarmId, check DAG readiness (Layer 2)
  //   spawnSubagent(task) or spawnCodeAgent(task)
  //   running++

onTaskComplete(taskId: string): void
  // running--
  // tryDispatch()  // immediately fill the slot

expireStaleTasks(): void
  // Called every 60s
  // Remove tasks where now - enqueuedAt > ttl
  // Log dropped tasks for observability
```

### 1.3 Backpressure

```typescript
const MAX_QUEUE_SIZE = 25;
const DEFAULT_TTL_MS = 10 * 60 * 1000;  // 10 min for normal tasks
const SWARM_TTL_MS = 30 * 60 * 1000;    // 30 min for swarm tasks

function canAcceptWork(): boolean {
  return queue.length < MAX_QUEUE_SIZE;
}

function getQueuePressure(): number {
  // 0.0 = empty, 1.0 = full
  return queue.length / MAX_QUEUE_SIZE;
}
```

### 1.4 Integration with supervisor.ts

Change `registerTask()` to enqueue instead of spawn directly:

```typescript
// Before (current):
async function registerTask(task): Promise<void> {
  tasks.push(task);
  await spawnSubagent(task);  // immediate spawn, fails if full
}

// After:
async function registerTask(task): Promise<void> {
  tasks.push(task);
  if (getRunningCount() < MAX_CONCURRENT) {
    await spawnSubagent(task);
  } else {
    enqueue({ ...task, priority: TaskPriority.NORMAL, ttl: DEFAULT_TTL_MS });
  }
}
```

### 1.5 Observability

Extend `/status` command to show queue state:

```
Queue: 3 tasks waiting (2 normal, 1 low)
Running: 5/5 agents (3 research, 2 code)
Pressure: 60% (15/25 slots used)
```

### 1.6 Persistence

Queue state persisted to `data/queue.json`. Loaded on startup. Stale tasks (enqueued before last restart, older than TTL) auto-expired.

### 1.7 Files Changed

| File | Change |
|------|--------|
| `src/queue.ts` | **NEW** - ~200 lines |
| `src/supervisor.ts` | Modify `registerTask()`, add `onTaskComplete()` callback |
| `src/relay.ts` | Extend `/status` with queue display |
| `src/constants.ts` | Queue limits |
| `src/heartbeat.ts` | Add `expireStaleTasks()` to periodic checks |

---

## Layer 2: DAG Orchestrator

**Goal:** Express task dependencies. "Do A, then feed A's output into B and C in parallel, then merge B+C into final output." Checkpoint completed nodes so retries don't re-run finished work.

### 2.1 DAG Data Model

```typescript
// src/dag.ts

interface SwarmDAG {
  id: string;                  // unique swarm ID
  name: string;                // human-readable ("competitor analysis")
  createdAt: string;
  status: 'planning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  nodes: DAGNode[];
  edges: DAGEdge[];
  budget: SwarmBudget;
  result?: string;             // final synthesized output
  initiatedBy: string;         // userId who triggered it
  error?: string;
}

interface DAGNode {
  id: string;
  label: string;               // "Research competitors"
  type: 'research' | 'code' | 'synthesize' | 'validate';
  status: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';
  taskId?: string;             // links to SupervisedTask when running
  model?: ModelTier;           // override from router (Layer 3)
  prompt: string;              // instructions for this node
  outputRef?: string;          // path or scratchpad key where result lives
  checkpoint?: {               // for resume on failure
    completedAt: string;
    outputHash: string;
  };
  retries: number;
  maxRetries: number;          // default 1
  timeoutMs?: number;          // per-node override
}

interface DAGEdge {
  from: string;                // source node ID
  to: string;                  // target node ID
  dataFlow?: string;           // what output from 'from' feeds into 'to'
}

interface SwarmBudget {
  maxCostUsd: number;          // total budget cap
  spentUsd: number;            // accumulated
  maxAgents: number;           // max concurrent for this swarm
  maxNodes: number;            // prevent runaway decomposition
  maxWallClockMs: number;      // total time limit
  startedAt?: string;
}
```

### 2.2 DAG Execution Engine

```typescript
// Core execution loop

function getReadyNodes(dag: SwarmDAG): DAGNode[] {
  // A node is "ready" when:
  // 1. status === 'pending'
  // 2. ALL upstream nodes (edges pointing to it) are 'completed'
  // 3. Swarm budget not exceeded
  return dag.nodes.filter(node => {
    if (node.status !== 'pending') return false;
    const upstreamIds = dag.edges
      .filter(e => e.to === node.id)
      .map(e => e.from);
    return upstreamIds.every(id =>
      dag.nodes.find(n => n.id === id)?.status === 'completed'
    );
  });
}

async function tickDAG(dag: SwarmDAG): Promise<void> {
  // Called by: onTaskComplete, periodic check (30s), initial start

  // 1. Check budget
  if (dag.budget.spentUsd >= dag.budget.maxCostUsd) {
    dag.status = 'failed';
    dag.error = `Budget exceeded: $${dag.budget.spentUsd.toFixed(2)} / $${dag.budget.maxCostUsd}`;
    return;
  }

  // 2. Check wall clock
  if (dag.budget.startedAt) {
    const elapsed = Date.now() - new Date(dag.budget.startedAt).getTime();
    if (elapsed > dag.budget.maxWallClockMs) {
      dag.status = 'failed';
      dag.error = `Wall clock exceeded: ${Math.round(elapsed / 60000)}min`;
      return;
    }
  }

  // 3. Find ready nodes
  const ready = getReadyNodes(dag);

  // 4. Check completion
  if (ready.length === 0) {
    const allDone = dag.nodes.every(n =>
      n.status === 'completed' || n.status === 'skipped'
    );
    const anyFailed = dag.nodes.some(n => n.status === 'failed');

    if (allDone) {
      dag.status = 'completed';
      // Trigger synthesis if there's a synthesize node
    } else if (anyFailed) {
      // Check if failed node is critical (has downstream dependents)
      const failedNodes = dag.nodes.filter(n => n.status === 'failed');
      const canContinue = failedNodes.every(fn => {
        const dependents = dag.edges.filter(e => e.from === fn.id);
        return dependents.length === 0; // leaf node failure is non-critical
      });
      if (!canContinue) {
        dag.status = 'failed';
        dag.error = `Critical node failed: ${failedNodes.map(n => n.label).join(', ')}`;
      }
    }
    return;
  }

  // 5. Dispatch ready nodes (respecting concurrency)
  for (const node of ready) {
    const runningCount = dag.nodes.filter(n => n.status === 'running').length;
    if (runningCount >= dag.budget.maxAgents) break;

    // Build prompt with upstream results injected
    const enrichedPrompt = injectUpstreamResults(dag, node);

    node.status = 'ready';  // mark for dispatch
    enqueue({
      id: node.id,
      priority: TaskPriority.HIGH,
      task: buildTaskFromNode(node, enrichedPrompt),
      swarmId: dag.id,
      dagNodeId: node.id,
      ttl: SWARM_TTL_MS,
    });
  }

  await persistDAG(dag);
}
```

### 2.3 Upstream Result Injection

When a node starts, it receives the outputs of all its upstream dependencies:

```typescript
function injectUpstreamResults(dag: SwarmDAG, node: DAGNode): string {
  const upstreamIds = dag.edges
    .filter(e => e.to === node.id)
    .map(e => e.from);

  const upstreamResults = upstreamIds
    .map(id => dag.nodes.find(n => n.id === id))
    .filter(n => n?.checkpoint)
    .map(n => {
      const output = readScratchpad(n!.outputRef!);
      return `## Input from "${n!.label}":\n${output}`;
    })
    .join('\n\n---\n\n');

  return `${node.prompt}\n\n# Context from previous steps:\n\n${upstreamResults}`;
}
```

### 2.4 Checkpoint System

Completed nodes are checkpointed so retries of the full swarm skip them:

```typescript
async function checkpointNode(dag: SwarmDAG, nodeId: string, output: string): Promise<void> {
  const node = dag.nodes.find(n => n.id === nodeId)!;
  const hash = createHash('sha256').update(output).digest('hex').slice(0, 16);

  node.status = 'completed';
  node.checkpoint = {
    completedAt: new Date().toISOString(),
    outputHash: hash,
  };

  // Write output to scratchpad
  await writeScratchpad(dag.id, nodeId, output);

  await persistDAG(dag);

  // Trigger next wave
  await tickDAG(dag);
}
```

### 2.5 DAG Builder (Programmatic)

Instead of YAML/JSON config files, DAGs are built in code:

```typescript
// Example: competitor analysis swarm

function buildCompetitorAnalysisDAG(competitors: string[]): SwarmDAG {
  const dag = createDAG('competitor-analysis');

  // Phase 1: parallel research (one node per competitor)
  const researchNodes = competitors.map(comp =>
    dag.addNode({
      label: `Research ${comp}`,
      type: 'research',
      prompt: `Research ${comp}'s GLP-1 weight loss program. Find: pricing, services, marketing channels, reviews, unique differentiators. Write a structured report.`,
    })
  );

  // Phase 2: parallel analysis (runs after ALL research completes)
  const pricingNode = dag.addNode({
    label: 'Pricing analysis',
    type: 'research',
    prompt: 'Compare pricing across all competitors. Identify where PV sits in the market. Find gaps and opportunities.',
  });

  const marketingNode = dag.addNode({
    label: 'Marketing channel analysis',
    type: 'research',
    prompt: 'Compare marketing channels and messaging. What are competitors doing that PV is not? What channels are underserved?',
  });

  // Wire dependencies: all research -> both analyses
  researchNodes.forEach(rn => {
    dag.addEdge(rn, pricingNode);
    dag.addEdge(rn, marketingNode);
  });

  // Phase 3: synthesis (runs after both analyses)
  const synthNode = dag.addNode({
    label: 'Executive summary',
    type: 'synthesize',
    prompt: 'Synthesize all research and analysis into a concise executive summary with actionable recommendations for PV Medispa. Include: market position, pricing strategy, marketing gaps, and 3 specific next steps.',
  });

  dag.addEdge(pricingNode, synthNode);
  dag.addEdge(marketingNode, synthNode);

  return dag.build({
    maxCostUsd: 3.00,
    maxAgents: 4,
    maxWallClockMs: 20 * 60 * 1000,  // 20 min
  });
}
```

### 2.6 LLM-Driven Decomposition

For ad-hoc swarm requests (not pre-built DAGs), the orchestrator asks Claude to decompose:

```typescript
// src/orchestrator.ts

async function decomposeTask(userRequest: string): Promise<SwarmDAG> {
  const decompositionPrompt = `You are a task decomposition engine. Given a complex request, break it into a directed acyclic graph of subtasks.

Rules:
- Each node is an independent unit of work that one agent can complete
- Nodes that can run in parallel SHOULD run in parallel
- Each node needs: a clear label, type (research/code/synthesize/validate), and detailed prompt
- Include a final 'synthesize' node that merges all results
- Keep the graph under 15 nodes total
- Be specific in prompts. Vague prompts produce vague results
- Include the output format each node should produce

Output format (JSON):
{
  "name": "swarm name",
  "nodes": [
    { "id": "n1", "label": "...", "type": "research", "prompt": "..." },
    ...
  ],
  "edges": [
    { "from": "n1", "to": "n3" },
    ...
  ]
}

User request: ${userRequest}`;

  const result = await callClaude(decompositionPrompt, {
    model: 'sonnet',
    skipLock: true,
  });

  return parseDAGFromJSON(result);
}
```

### 2.7 Persistence

```
data/swarms/
  {swarmId}.json         # DAG state
  {swarmId}/
    {nodeId}.md          # node outputs (scratchpad)
    checkpoint.json      # completed node hashes
```

Loaded on startup. Active swarms resume via `tickDAG()`.

### 2.8 Error Propagation

When a node fails:

1. If `retries < maxRetries`: re-enqueue with backoff (2^retry * 5s)
2. If retries exhausted:
   - Check if node has downstream dependents
   - If yes (critical path): fail the swarm, notify user
   - If no (leaf): mark as `failed`, continue other branches
   - If optional (marked `optional: true`): mark as `skipped`, continue

### 2.9 Cancellation

```typescript
async function cancelSwarm(swarmId: string): Promise<void> {
  const dag = loadDAG(swarmId);

  // Kill running tasks
  const runningNodes = dag.nodes.filter(n => n.status === 'running');
  for (const node of runningNodes) {
    if (node.taskId) {
      await killTask(node.taskId);  // supervisor.ts
    }
  }

  // Remove queued tasks
  dequeueBySwarmId(swarmId);

  // Mark all non-completed nodes as cancelled
  dag.nodes.forEach(n => {
    if (n.status !== 'completed') n.status = 'skipped';
  });

  dag.status = 'cancelled';
  await persistDAG(dag);
}
```

### 2.10 Files Changed

| File | Change |
|------|--------|
| `src/dag.ts` | **NEW** - ~400 lines |
| `src/orchestrator.ts` | **NEW** - ~350 lines |
| `src/scratchpad.ts` | **NEW** - ~100 lines |
| `src/supervisor.ts` | Add swarm task type, event-driven completion callback |
| `src/queue.ts` | Add `dequeueBySwarmId()`, DAG readiness check |
| `src/relay.ts` | `/swarm` command, `[SWARM:]` tag processing |

---

## Layer 3: Model Router + Cost Control

**Goal:** Pick the right model per task. Enforce budget across the entire swarm. Track cost in real time.

### 3.1 Capability Registry

```typescript
// src/router.ts

interface ModelCapability {
  model: ModelTier;
  strengths: TaskType[];
  costPer1kInput: number;      // USD
  costPer1kOutput: number;
  avgLatencyMs: number;        // typical response time
  contextWindow: number;       // tokens
  reliability: number;         // 0-1, based on observed success rate
}

const MODEL_REGISTRY: ModelCapability[] = [
  {
    model: 'opus',
    strengths: ['code', 'synthesize', 'validate'],
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    avgLatencyMs: 45000,
    contextWindow: 200000,
    reliability: 0.95,
  },
  {
    model: 'sonnet',
    strengths: ['research', 'synthesize', 'validate'],
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    avgLatencyMs: 15000,
    contextWindow: 200000,
    reliability: 0.92,
  },
  {
    model: 'haiku',
    strengths: ['research', 'validate'],
    costPer1kInput: 0.001,
    costPer1kOutput: 0.005,
    avgLatencyMs: 5000,
    contextWindow: 200000,
    reliability: 0.88,
  },
];
```

### 3.2 Routing Logic

```typescript
function selectModel(node: DAGNode, budget: SwarmBudget): ModelTier {
  // 1. If node has explicit model override, use it
  if (node.model) return node.model;

  // 2. Route by task type
  switch (node.type) {
    case 'code':
      return 'opus';       // code changes need precision
    case 'synthesize':
      return 'sonnet';     // synthesis needs quality but not opus cost
    case 'validate':
      return 'haiku';      // validation is yes/no, fast is better
    case 'research':
      // Check budget pressure
      const remaining = budget.maxCostUsd - budget.spentUsd;
      const nodesLeft = countRemainingNodes(budget);
      const avgBudgetPerNode = remaining / Math.max(nodesLeft, 1);

      if (avgBudgetPerNode < 0.10) return 'haiku';    // budget tight
      if (avgBudgetPerNode < 0.50) return 'sonnet';   // normal
      return 'sonnet';                                  // default research model
  }
}
```

### 3.3 Budget Enforcement

```typescript
interface BudgetCheck {
  allowed: boolean;
  reason?: string;
  suggestedModel?: ModelTier;  // cheaper alternative if budget tight
}

function checkBudget(dag: SwarmDAG, node: DAGNode): BudgetCheck {
  const remaining = dag.budget.maxCostUsd - dag.budget.spentUsd;

  // Hard stop: less than $0.05 remaining
  if (remaining < 0.05) {
    return { allowed: false, reason: 'Budget exhausted' };
  }

  // Soft warning: enough for this node but might starve later nodes
  const model = selectModel(node, dag.budget);
  const estimatedCost = estimateNodeCost(node, model);
  const futureNodes = countRemainingNodes(dag.budget) - 1;
  const futureEstimate = futureNodes * 0.15;  // conservative avg

  if (estimatedCost + futureEstimate > remaining) {
    // Downgrade model to stay within budget
    return {
      allowed: true,
      suggestedModel: 'haiku',
      reason: `Budget pressure: downgrading to haiku (${remaining.toFixed(2)} remaining)`,
    };
  }

  return { allowed: true };
}

function estimateNodeCost(node: DAGNode, model: ModelTier): number {
  // Rough estimates based on task type
  const estimates: Record<string, number> = {
    'research:haiku': 0.02,
    'research:sonnet': 0.10,
    'research:opus': 0.50,
    'code:opus': 1.00,
    'synthesize:sonnet': 0.15,
    'validate:haiku': 0.01,
  };
  return estimates[`${node.type}:${model}`] || 0.20;
}
```

### 3.4 Real-Time Cost Tracking

Extend `onTaskComplete` to update swarm budget:

```typescript
async function onSwarmTaskComplete(
  swarmId: string,
  nodeId: string,
  cost: number,
  output: string,
): Promise<void> {
  const dag = loadDAG(swarmId);
  dag.budget.spentUsd += cost;

  await checkpointNode(dag, nodeId, output);
  // tickDAG is called inside checkpointNode
}
```

### 3.5 Files Changed

| File | Change |
|------|--------|
| `src/router.ts` | **NEW** - ~200 lines |
| `src/dag.ts` | Integrate `selectModel()` and `checkBudget()` into `tickDAG()` |
| `src/supervisor.ts` | Pass cost data to `onSwarmTaskComplete()` |
| `src/constants.ts` | Model cost tables, budget defaults |

---

## Layer 4: Scratchpad + Event-Driven Completion

**Goal:** Agents can read intermediate results from other agents. Completion triggers DAG advancement immediately, not on a 5-minute poll.

### 4.1 Scratchpad (Shared Results Store)

```typescript
// src/scratchpad.ts

// File-based for simplicity. Supabase upgrade path exists but not needed yet.

const SCRATCHPAD_DIR = 'data/swarms';

async function writeScratchpad(
  swarmId: string,
  nodeId: string,
  content: string,
): Promise<string> {
  const dir = path.join(SCRATCHPAD_DIR, swarmId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${nodeId}.md`);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function readScratchpad(
  swarmId: string,
  nodeId: string,
): Promise<string | null> {
  const filePath = path.join(SCRATCHPAD_DIR, swarmId, `${nodeId}.md`);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function listScratchpad(swarmId: string): Promise<string[]> {
  // List all completed node outputs for this swarm
  const dir = path.join(SCRATCHPAD_DIR, swarmId);
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }
}
```

### 4.2 Event-Driven Completion

Replace 5-minute polling with immediate callbacks:

```typescript
// In supervisor.ts, modify spawnSubagent/spawnCodeAgent

// Current: check every 5 min via heartbeat
// New: watch output file + process exit

function watchForCompletion(task: SupervisedTask): void {
  const proc = getProcess(task.pid!);

  proc.on('exit', async (code) => {
    if (task.taskType === 'research' && task.outputFile) {
      // Read output file
      const output = await fs.readFile(task.outputFile, 'utf-8').catch(() => '');

      if (output.length > 0) {
        task.status = 'completed';
        task.outcome = { status: 'ok', summary: output.slice(0, 200), durationMs: elapsed() };
      } else {
        task.status = 'failed';
        task.outcome = { status: 'error', message: `Exit code ${code}, no output`, durationMs: elapsed() };
      }
    }

    // Notify queue + DAG
    await onTaskComplete(task.id);

    // If this is a swarm task, advance the DAG
    if (task.swarmId) {
      const cost = task.costUsd || 0;
      const output = await readScratchpad(task.swarmId, task.dagNodeId!) || '';
      await onSwarmTaskComplete(task.swarmId, task.dagNodeId!, cost, output);
    }

    await saveTasks();
  });
}
```

### 4.3 Heartbeat Integration

Keep 5-minute check as a safety net (catches orphans where event was missed):

```typescript
// In heartbeat.ts checkTasks()
// Existing orphan detection stays
// Add: re-tick any swarms with running nodes (in case event was lost)
for (const dag of getActiveSwarms()) {
  await tickDAG(dag);
}
```

### 4.4 Files Changed

| File | Change |
|------|--------|
| `src/scratchpad.ts` | **NEW** - ~80 lines |
| `src/supervisor.ts` | Add `watchForCompletion()`, process exit handler |
| `src/heartbeat.ts` | Add swarm re-tick as safety net |

---

## Layer 5: Orchestrator Intelligence

**Goal:** Atlas can decompose complex requests into swarms automatically, synthesize multi-agent results, and deliver concise outputs via Telegram.

### 5.1 Swarm Intent Detection

```typescript
// In relay.ts, extend intent processing

// Explicit trigger:
// [SWARM: name | BUDGET: $X | NODES: { json DAG definition }]
// or: /swarm <description>

// Auto-detection (orchestrator decides if swarm is warranted):
async function shouldSwarm(userMessage: string): Promise<boolean> {
  // Heuristics (no LLM call needed):
  // 1. Message contains "research X and Y and Z" (3+ distinct targets)
  // 2. Message contains "compare", "analyze across", "comprehensive"
  // 3. Message explicitly asks for parallel work
  // 4. Estimated single-agent time > 10 minutes

  const parallelSignals = [
    /research .+ and .+ and/i,
    /compare .+ (across|between|vs)/i,
    /comprehensive (analysis|report|review)/i,
    /analyze (all|every|each|multiple)/i,
    /in parallel/i,
    /swarm/i,
  ];

  return parallelSignals.some(re => re.test(userMessage));
}
```

### 5.2 Result Synthesis

When a swarm completes, the orchestrator synthesizes all node outputs into a single deliverable:

```typescript
async function synthesizeSwarmResults(dag: SwarmDAG): Promise<string> {
  // Collect all completed node outputs
  const outputs: string[] = [];
  for (const node of dag.nodes.filter(n => n.status === 'completed')) {
    const content = await readScratchpad(dag.id, node.id);
    if (content) {
      outputs.push(`## ${node.label}\n\n${content}`);
    }
  }

  // If there's a synthesize node, its output IS the result
  const synthNode = dag.nodes.find(n => n.type === 'synthesize' && n.status === 'completed');
  if (synthNode) {
    return await readScratchpad(dag.id, synthNode.id) || outputs.join('\n\n---\n\n');
  }

  // Otherwise, ask Claude to synthesize
  const synthesisPrompt = `You have the results of a multi-agent research swarm called "${dag.name}".

Synthesize these results into a concise, actionable summary suitable for Telegram delivery. Focus on insights and recommendations, not raw data.

${outputs.join('\n\n---\n\n')}`;

  return await callClaude(synthesisPrompt, {
    model: 'sonnet',
    skipLock: true,
  });
}
```

### 5.3 Telegram Delivery

```typescript
async function deliverSwarmResult(
  chatId: number,
  dag: SwarmDAG,
  result: string,
): Promise<void> {
  const header = `Swarm "${dag.name}" completed.\n` +
    `${dag.nodes.filter(n => n.status === 'completed').length}/${dag.nodes.length} tasks done. ` +
    `Cost: $${dag.budget.spentUsd.toFixed(2)} / $${dag.budget.maxCostUsd.toFixed(2)}`;

  // Send header
  await bot.api.sendMessage(chatId, header);

  // Send result (chunked if needed)
  await sendLongMessage(chatId, result);

  // Add to conversation ring buffer so Atlas has context
  addEntry(sessionKey, {
    role: 'assistant',
    content: `[Swarm result: ${dag.name}]\n${result.slice(0, 500)}`,
    timestamp: new Date().toISOString(),
    type: 'text',
  });
}
```

### 5.4 Swarm Commands

```
/swarm <description>           Start a new swarm from natural language
/swarm status                  Show all active swarms
/swarm status <id>             Show specific swarm DAG with node statuses
/swarm cancel <id>             Cancel a running swarm
/swarm retry <id>              Retry failed nodes in a swarm
/swarm list                    List recent swarms (last 24h)
```

### 5.5 Pre-Built Swarm Templates

For common PV Medispa workflows:

```typescript
// src/orchestrator.ts

const SWARM_TEMPLATES: Record<string, (args: string) => SwarmDAG> = {
  'competitor-analysis': buildCompetitorAnalysisDAG,
  'content-waterfall': buildContentWaterfallDAG,
  'market-research': buildMarketResearchDAG,
  'seo-audit': buildSEOAuditDAG,
  'weekly-report': buildWeeklyReportDAG,
};

// Usage: /swarm template competitor-analysis "CoolSculpting NYC, Sono Bello, BodySquad"
```

Example: **Content Waterfall Swarm**

```
[research topic + audience]
    → [write Skool longform] + [outline YouTube script]
    → [extract 3 Facebook hooks from Skool post] + [draft email newsletter from Skool post]
    → [validate all content against brand voice]
```

Example: **Weekly Report Swarm**

```
[fetch financial data] + [fetch pipeline data] + [fetch ads data] + [fetch GA4 data] + [fetch GBP data]
    → [cross-source analysis + anomaly detection]
    → [executive summary with recommendations]
```

### 5.6 Files Changed

| File | Change |
|------|--------|
| `src/orchestrator.ts` | Add `shouldSwarm()`, `synthesizeSwarmResults()`, `deliverSwarmResult()`, templates |
| `src/relay.ts` | `/swarm` command handler, auto-detection in message flow |
| `src/conversation.ts` | Swarm results added to ring buffer |

---

## Layer 6: Observability + Resilience

**Goal:** Full visibility into swarm execution. Graceful handling of partial failures. Clean shutdown.

### 6.1 Swarm Status Display

```
Swarm: "competitor-analysis" (running, 3m22s)
Budget: $0.85 / $3.00 (28%)

[OK] Research CoolSculpting NYC    sonnet  $0.12  45s
[OK] Research Sono Bello           sonnet  $0.18  62s
[..] Research BodySquad            sonnet  $0.09  running (28s)
[--] Pricing analysis              sonnet  --     waiting (depends: research x3)
[--] Marketing channel analysis    sonnet  --     waiting (depends: research x3)
[--] Executive summary             sonnet  --     waiting (depends: pricing, marketing)

Queue: 0 waiting | Running: 3/4 agents
```

### 6.2 Circuit Breaker

```typescript
interface CircuitBreaker {
  failures: number;
  lastFailure: string;
  state: 'closed' | 'open' | 'half-open';
  threshold: number;           // failures before opening (default 3)
  resetMs: number;             // time before half-open (default 5 min)
}

function checkCircuitBreaker(swarmId: string): boolean {
  const cb = getCircuitBreaker(swarmId);

  if (cb.state === 'open') {
    const elapsed = Date.now() - new Date(cb.lastFailure).getTime();
    if (elapsed > cb.resetMs) {
      cb.state = 'half-open';  // allow one retry
      return true;
    }
    return false;  // still open, block spawning
  }

  return true;  // closed or half-open, allow
}

function recordFailure(swarmId: string): void {
  const cb = getCircuitBreaker(swarmId);
  cb.failures++;
  cb.lastFailure = new Date().toISOString();

  if (cb.failures >= cb.threshold) {
    cb.state = 'open';
    // Notify user
    notifyUser(`Swarm "${swarmId}" circuit breaker opened after ${cb.failures} consecutive failures. Pausing new tasks for ${cb.resetMs / 60000} minutes.`);
  }
}
```

### 6.3 Graceful Shutdown Integration

```typescript
// In relay.ts gracefulShutdown()

async function gracefulShutdown(exitCode: number): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Existing cleanup...
  stopCronJobs();

  // NEW: Pause all swarms (don't kill running tasks, just stop dispatching)
  for (const dag of getActiveSwarms()) {
    dag.status = 'paused';
    await persistDAG(dag);
  }

  // Existing: save queue state
  await persistQueue();

  // Existing cleanup...
  await saveDedupCache();
  await bot.stop();
  releaseLock();
}
```

On restart, paused swarms resume automatically via `tickDAG()` on startup.

### 6.4 Cost Logging

All swarm costs logged to existing Supabase `logs` table:

```typescript
await logToSupabase({
  type: 'swarm',
  swarmId: dag.id,
  swarmName: dag.name,
  totalCost: dag.budget.spentUsd,
  nodesCompleted: dag.nodes.filter(n => n.status === 'completed').length,
  nodesTotal: dag.nodes.length,
  wallClockMs: elapsed,
  userId: dag.initiatedBy,
});
```

### 6.5 Files Changed

| File | Change |
|------|--------|
| `src/orchestrator.ts` | Circuit breaker, status display |
| `src/relay.ts` | Swarm pause in graceful shutdown, swarm resume on startup |
| `src/queue.ts` | `persistQueue()`, `loadQueue()` |
| `src/heartbeat.ts` | Swarm health in periodic checks |

---

## Implementation Order

### Phase 1: Foundation (Layer 1)
**Estimated scope: ~300 lines new code, ~50 lines modified**

1. Build `src/queue.ts` with priority queue, backpressure, persistence
2. Modify `supervisor.ts` to enqueue instead of fail on full slots
3. Add queue status to `/status` command
4. Add TTL expiration to heartbeat checks
5. Test with existing research + code tasks

### Phase 2: DAG Engine (Layer 2)
**Estimated scope: ~800 lines new code, ~100 lines modified**

1. Build `src/dag.ts` with DAG data model, execution engine, ready-node detection
2. Build `src/scratchpad.ts` for inter-node result passing
3. Build `src/orchestrator.ts` with LLM decomposition + programmatic DAG builder
4. Wire event-driven completion in `supervisor.ts`
5. Add `[SWARM:]` tag processing to `relay.ts`
6. Test with a simple 3-node linear DAG
7. Test with a fan-out/fan-in DAG (research -> analyze -> synthesize)

### Phase 3: Intelligence (Layers 3 + 5)
**Estimated scope: ~400 lines new code, ~80 lines modified**

1. Build `src/router.ts` with model capability registry and routing logic
2. Add budget enforcement to DAG engine
3. Build pre-built swarm templates (competitor analysis, content waterfall, weekly report)
4. Add `/swarm` command suite
5. Add auto-detection heuristics for swarm-worthy requests
6. Test end-to-end: user message -> decomposition -> execution -> synthesis -> Telegram delivery

### Phase 4: Hardening (Layers 4 + 6)
**Estimated scope: ~200 lines new code, ~100 lines modified**

1. Add circuit breaker to orchestrator
2. Integrate swarm pause/resume into graceful shutdown
3. Add comprehensive status display
4. Add cost logging to Supabase
5. Add swarm context to heartbeat health checks
6. Stress test: 15-node DAG, budget constraints, node failures, cancellation

---

## What This Gets You

When all layers are done, Atlas can handle requests like:

> "Research our top 5 competitors in the GLP-1 weight loss space in NYC, compare their pricing and marketing, and give me an executive summary with recommendations"

Atlas will:
1. Decompose into 5 parallel research tasks + 2 analysis tasks + 1 synthesis task (8 nodes)
2. Queue and dispatch the 5 research tasks with sonnet (respecting 5-agent limit)
3. As each research task completes, check if analysis tasks are unblocked
4. When all 5 research tasks finish, dispatch both analysis tasks in parallel
5. When both analyses finish, dispatch synthesis with all upstream results
6. Deliver a concise executive summary to Telegram
7. Total cost: ~$1.50, total time: ~5-8 minutes (vs ~20-30 minutes sequential)

That's the 80% of K2.5's practical value running locally on your Windows box. The remaining 20% (learned decomposition via RL, elastic cloud scaling) requires infrastructure you don't need for a single-user system.

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Runaway cost | Per-swarm budget cap, per-node cost estimates, automatic model downgrade |
| Orphaned processes | Event-driven completion + 5-min heartbeat safety net + graceful shutdown |
| Context window bloat | Scratchpad (disk), not prompt injection. Only upstream results injected per-node |
| Bad decomposition | LLM decomposition validated (max 15 nodes), pre-built templates for common tasks |
| Serial collapse | DAG engine naturally parallelizes ready nodes. No single bottleneck |
| Complexity debt | Each layer is independently useful. Can ship Layer 1 alone and get value |

---

## Constants Summary

```typescript
// Swarm limits
MAX_QUEUE_SIZE = 25;
MAX_SWARM_NODES = 15;
DEFAULT_SWARM_BUDGET_USD = 3.00;
MAX_SWARM_BUDGET_USD = 10.00;
DEFAULT_SWARM_WALL_CLOCK_MS = 30 * 60 * 1000;   // 30 min
SWARM_TTL_MS = 30 * 60 * 1000;                   // queue TTL
CIRCUIT_BREAKER_THRESHOLD = 3;
CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000;        // 5 min

// Model routing defaults
RESEARCH_DEFAULT_MODEL = 'sonnet';
CODE_DEFAULT_MODEL = 'opus';
SYNTHESIZE_DEFAULT_MODEL = 'sonnet';
VALIDATE_DEFAULT_MODEL = 'haiku';
BUDGET_PRESSURE_THRESHOLD = 0.10;                 // $/node triggers haiku
```
