/**
 * Atlas — Swarm Orchestrator
 *
 * High-level swarm lifecycle: decompose user requests into DAGs,
 * synthesize multi-agent results, deliver to Telegram.
 *
 * Three ways to trigger a swarm:
 * 1. /swarm <description> — explicit command
 * 2. [SWARM: ...] tag in Claude's response — intent-based
 * 3. Auto-detection — heuristic match on user message patterns
 *
 * Includes pre-built templates for common PV Medispa workflows.
 */

import { info, warn, error as logError } from "./logger.ts";
import { callClaude } from "./claude.ts";
import { finalizeExplorationLog } from "./exploration.ts";
import {
  createDAG,
  startSwarm,
  getSwarm,
  getActiveSwarms,
  cancelSwarm,
  retrySwarm,
  formatSwarmStatus,
  onSwarmNodeComplete,
  registerSwarmNotifyCallback,
  isDagNodeReady,
  loadActiveSwarms,
  tickAllSwarms,
  type SwarmDAG,
  type DAGBuilder,
} from "./dag.ts";
import { readScratchpad, listScratchpad, cleanOldScratchpads } from "./scratchpad.ts";
import { registerSwarmCompletionCallback, dispatchQueuedTask } from "./supervisor.ts";
import { registerQueueCallbacks, loadQueue } from "./queue.ts";
import {
  MAX_SWARM_NODES,
  DEFAULT_SWARM_BUDGET_USD,
  DEFAULT_SWARM_WALL_CLOCK_MS,
  type ModelTier,
} from "./constants.ts";

// ============================================================
// INITIALIZATION
// ============================================================

/** Completion delivery callback (set by relay.ts) */
let deliverCallback: ((chatId: string, header: string, body: string) => Promise<void>) | null = null;

export function registerDeliveryCallback(
  cb: (chatId: string, header: string, body: string) => Promise<void>
): void {
  deliverCallback = cb;
}

/**
 * Initialize the swarm system. Called once from relay.ts on startup.
 */
export async function initSwarmSystem(): Promise<void> {
  // Load persisted state
  await loadQueue();
  await loadActiveSwarms();

  // Wire callbacks
  registerQueueCallbacks({
    onDispatch: dispatchQueuedTask,
    isDagNodeReady,
  });

  registerSwarmCompletionCallback(onSwarmNodeComplete);

  registerSwarmNotifyCallback(async (swarmId: string, message: string) => {
    const dag = getSwarm(swarmId);
    if (!dag) return;

    if (message === "completed") {
      // Finalize exploration log if this is a convergent exploration swarm
      if (dag.name.startsWith("explore: ")) {
        try {
          await finalizeExplorationLog(swarmId, dag);
        } catch (err) {
          warn("orchestrator", `Exploration log finalization failed: ${err}`);
        }
      }

      // Synthesize results and deliver
      const result = await synthesizeSwarmResults(dag);
      dag.result = result;

      const completed = dag.nodes.filter(n => n.status === "completed").length;
      const header = [
        `Swarm "${dag.name}" completed.`,
        `${completed}/${dag.nodes.length} tasks done.`,
        `Cost: $${dag.budget.spentUsd.toFixed(2)} / $${dag.budget.maxCostUsd.toFixed(2)}`,
      ].join(" ");

      if (deliverCallback) {
        await deliverCallback(dag.initiatedBy, header, result);
      }
    } else {
      // Failure or other notification
      if (deliverCallback) {
        await deliverCallback(dag.initiatedBy, message, "");
      }
    }
  });

  // Resume active swarms
  await tickAllSwarms();

  info("orchestrator", "Swarm system initialized");
}

// ============================================================
// DECOMPOSITION — LLM-based task breakdown
// ============================================================

const DECOMPOSITION_PROMPT = `You are a task decomposition engine. Given a complex request, break it into a directed acyclic graph (DAG) of subtasks.

Rules:
- Each node is an independent unit of work that one agent can complete in 2-10 minutes
- Nodes that can run in parallel SHOULD run in parallel
- Each node needs: id (n1, n2...), label (short human name), type (research/code/synthesize/validate), and prompt (detailed instructions)
- Always include a final 'synthesize' node that merges all results into a concise deliverable
- Keep the graph under ${MAX_SWARM_NODES} nodes total
- Be specific in prompts. Vague prompts produce vague results. Include output format expectations.
- For research nodes: specify what sources to check, what data to extract, what format to output
- For synthesize nodes: specify the audience, tone, and deliverable format

Output ONLY valid JSON (no markdown fences, no explanation):
{
  "name": "short swarm name",
  "nodes": [
    { "id": "n1", "label": "Short label", "type": "research", "prompt": "Detailed instructions..." },
    { "id": "n2", "label": "Another task", "type": "research", "prompt": "..." },
    { "id": "n3", "label": "Synthesis", "type": "synthesize", "prompt": "..." }
  ],
  "edges": [
    { "from": "n1", "to": "n3" },
    { "from": "n2", "to": "n3" }
  ]
}`;

/**
 * Use Claude to decompose a user request into a DAG.
 */
export async function decomposeRequest(
  userRequest: string,
  userId: string,
  budgetUsd?: number,
): Promise<SwarmDAG> {
  const prompt = `${DECOMPOSITION_PROMPT}\n\nUser request: ${userRequest}`;

  const result = await callClaude(prompt, {
    model: "sonnet",
    skipLock: true,
  });

  // Parse JSON from response (strip markdown fences if present)
  let json = result.trim();
  if (json.startsWith("```")) {
    json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  let parsed: {
    name: string;
    nodes: Array<{ id: string; label: string; type: string; prompt: string; model?: string }>;
    edges: Array<{ from: string; to: string }>;
  };

  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`Failed to parse decomposition JSON: ${err}\n\nRaw response: ${result.slice(0, 500)}`);
  }

  // Validate
  if (!parsed.nodes || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error("Decomposition produced no nodes");
  }
  if (parsed.nodes.length > MAX_SWARM_NODES) {
    throw new Error(`Decomposition produced ${parsed.nodes.length} nodes, max is ${MAX_SWARM_NODES}`);
  }

  // Build DAG
  const builder = createDAG(parsed.name || "swarm");
  const idMap = new Map<string, string>(); // parsed ID -> DAG ID

  for (const node of parsed.nodes) {
    const validType = ["research", "code", "synthesize", "validate"].includes(node.type)
      ? node.type as "research" | "code" | "synthesize" | "validate"
      : "research";

    const dagId = builder.addNode({
      label: node.label,
      type: validType,
      prompt: node.prompt,
      model: node.model as ModelTier | undefined,
    });
    idMap.set(node.id, dagId);
  }

  for (const edge of parsed.edges || []) {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (from && to) {
      builder.addEdge(from, to);
    } else {
      warn("orchestrator", `Skipping edge ${edge.from} -> ${edge.to}: node(s) not found`);
    }
  }

  return builder.build({
    initiatedBy: userId,
    maxCostUsd: budgetUsd ?? DEFAULT_SWARM_BUDGET_USD,
    maxAgents: 4,
    maxWallClockMs: DEFAULT_SWARM_WALL_CLOCK_MS,
  });
}

// ============================================================
// SYNTHESIS — merge multi-agent results
// ============================================================

/**
 * Synthesize all completed node outputs into a single deliverable.
 */
async function synthesizeSwarmResults(dag: SwarmDAG): Promise<string> {
  // If there's a synthesize node that completed, use its output
  const synthNode = dag.nodes.find(n => n.type === "synthesize" && n.status === "completed");
  if (synthNode) {
    const output = await readScratchpad(dag.id, synthNode.id);
    if (output && output.trim().length > 50) {
      return output;
    }
  }

  // Fallback: gather all outputs and ask Claude to synthesize
  const outputs: string[] = [];
  for (const node of dag.nodes.filter(n => n.status === "completed")) {
    const content = await readScratchpad(dag.id, node.id);
    if (content) {
      outputs.push(`## ${node.label}\n\n${content}`);
    }
  }

  if (outputs.length === 0) {
    return "No outputs were produced by the swarm.";
  }

  if (outputs.length === 1) {
    return outputs[0];
  }

  const synthesisPrompt = `You have the results of a multi-agent research swarm called "${dag.name}".

Synthesize these results into a concise, actionable summary. Focus on insights and recommendations, not raw data. Keep it under 2000 characters for Telegram delivery. Use clear headers and bullet points.

${outputs.join("\n\n---\n\n")}`;

  try {
    return await callClaude(synthesisPrompt, {
      model: "sonnet",
      skipLock: true,
    });
  } catch (err) {
    warn("orchestrator", `Synthesis failed: ${err}`);
    return outputs.join("\n\n---\n\n");
  }
}

// ============================================================
// SWARM INTENT DETECTION
// ============================================================

const SWARM_SIGNALS = [
  /research .+ and .+ and/i,
  /compare .+ (?:across|between|vs)/i,
  /comprehensive (?:analysis|report|review|audit)/i,
  /analyze (?:all|every|each|multiple)/i,
  /in parallel/i,
  /swarm this/i,
  /run a swarm/i,
  /multi.?agent/i,
];

/**
 * Heuristic: does this message look like it would benefit from a swarm?
 * Returns true if the message matches swarm-like patterns.
 * This is advisory, not binding. Atlas can still choose to use a swarm or not.
 */
export function detectSwarmIntent(message: string): boolean {
  return SWARM_SIGNALS.some(re => re.test(message));
}

// ============================================================
// TAG PROCESSING
// ============================================================

// [SWARM: name | BUDGET: $X | PROMPT: description]
const SWARM_TAG_REGEX = /\[SWARM:\s*([\s\S]+?)\](?!\()/g;

/**
 * Process [SWARM: ...] tags from Claude's response.
 */
export async function processSwarmIntents(
  response: string,
  userId: string,
): Promise<string> {
  let processed = response;
  let match;

  while ((match = SWARM_TAG_REGEX.exec(response)) !== null) {
    const raw = match[1];
    const fields = parseSwarmFields(raw);

    try {
      const dag = await decomposeRequest(fields.prompt, userId, fields.budget);
      await startSwarm(dag);

      const nodeList = dag.nodes.map(n => `  - ${n.label} (${n.type})`).join("\n");
      processed = processed.replace(
        match[0],
        `Swarm "${dag.name}" started with ${dag.nodes.length} nodes:\n${nodeList}\n\nBudget: $${dag.budget.maxCostUsd.toFixed(2)} | Max agents: ${dag.budget.maxAgents}`
      );

      info("orchestrator", `Swarm started from tag: ${dag.id} (${dag.name})`);
    } catch (err) {
      processed = processed.replace(match[0], `Swarm failed to start: ${err}`);
      warn("orchestrator", `Swarm intent failed: ${err}`);
    }
  }
  SWARM_TAG_REGEX.lastIndex = 0;

  return processed;
}

function parseSwarmFields(raw: string): { name: string; prompt: string; budget: number | undefined } {
  const parts = raw.split(/\s*\|\s*(?=(?:BUDGET|PROMPT)\s*:)/i);

  let name = parts[0].trim();
  let prompt = name; // default: use name as prompt
  let budget: number | undefined;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const budgetMatch = part.match(/^BUDGET\s*:\s*\$?([\d.]+)/i);
    const promptMatch = part.match(/^PROMPT\s*:\s*([\s\S]*)/i);
    if (budgetMatch) budget = parseFloat(budgetMatch[1]);
    if (promptMatch) prompt = promptMatch[1].trim();
  }

  return { name, prompt, budget };
}

// ============================================================
// COMMAND HANDLERS (called from relay.ts)
// ============================================================

/**
 * Handle /swarm command.
 * Usage:
 *   /swarm <description>           Start a new swarm
 *   /swarm status                  Show all active swarms
 *   /swarm status <id>             Show specific swarm
 *   /swarm cancel <id>             Cancel a running swarm
 *   /swarm retry <id>              Retry failed nodes
 *   /swarm list                    List recent swarms
 *   /swarm template <name> <args>  Use a pre-built template
 */
export async function handleSwarmCommand(
  args: string[],
  userId: string,
): Promise<string> {
  if (args.length === 0) {
    return [
      "Usage:",
      "  /swarm <description> - Start a new swarm from description",
      "  /swarm status - Show active swarms",
      "  /swarm status <id> - Show specific swarm",
      "  /swarm cancel <id> - Cancel a swarm",
      "  /swarm retry <id> - Retry failed nodes",
      "  /swarm template <name> - Use a template",
      "",
      "Templates: competitor-analysis, content-waterfall, weekly-report",
    ].join("\n");
  }

  const subcommand = args[0].toLowerCase();

  switch (subcommand) {
    case "status": {
      if (args[1]) {
        // Specific swarm
        const dag = getSwarm(args[1]) || findSwarmByPrefix(args[1]);
        if (!dag) return `Swarm "${args[1]}" not found.`;
        return formatSwarmStatus(dag);
      }
      // All active swarms
      const swarms = getActiveSwarms();
      if (swarms.length === 0) return "No active swarms.";
      return swarms.map(d => formatSwarmStatus(d)).join("\n\n");
    }

    case "cancel": {
      if (!args[1]) return "Usage: /swarm cancel <id>";
      const dag = getSwarm(args[1]) || findSwarmByPrefix(args[1]);
      if (!dag) return `Swarm "${args[1]}" not found.`;
      const ok = await cancelSwarm(dag.id);
      return ok ? `Swarm "${dag.name}" cancelled.` : `Failed to cancel swarm.`;
    }

    case "retry": {
      if (!args[1]) return "Usage: /swarm retry <id>";
      const dag = getSwarm(args[1]) || findSwarmByPrefix(args[1]);
      if (!dag) return `Swarm "${args[1]}" not found.`;
      const count = await retrySwarm(dag.id);
      return count > 0
        ? `Retrying ${count} nodes in swarm "${dag.name}".`
        : `No failed nodes to retry.`;
    }

    case "list": {
      const swarms = getActiveSwarms();
      if (swarms.length === 0) return "No active swarms.";
      return swarms.map(d => {
        const completed = d.nodes.filter(n => n.status === "completed").length;
        return `${d.id.slice(0, 12)} | "${d.name}" | ${d.status} | ${completed}/${d.nodes.length} done | $${d.budget.spentUsd.toFixed(2)}`;
      }).join("\n");
    }

    case "template": {
      const templateName = args[1];
      const templateArgs = args.slice(2).join(" ");
      if (!templateName) {
        return "Templates: competitor-analysis, content-waterfall, weekly-report";
      }
      return await runTemplate(templateName, templateArgs, userId);
    }

    default: {
      // Treat as description for a new swarm
      const description = args.join(" ");
      try {
        const dag = await decomposeRequest(description, userId);
        await startSwarm(dag);

        const nodeList = dag.nodes.map(n => `  ${n.label} (${n.type})`).join("\n");
        return [
          `Swarm "${dag.name}" started.`,
          `${dag.nodes.length} nodes, budget $${dag.budget.maxCostUsd.toFixed(2)}`,
          "",
          nodeList,
        ].join("\n");
      } catch (err) {
        return `Failed to start swarm: ${err}`;
      }
    }
  }
}

function findSwarmByPrefix(prefix: string): SwarmDAG | null {
  for (const dag of getActiveSwarms()) {
    if (dag.id.startsWith(prefix) || dag.name.toLowerCase().includes(prefix.toLowerCase())) {
      return dag;
    }
  }
  return null;
}

// ============================================================
// PRE-BUILT TEMPLATES
// ============================================================

async function runTemplate(
  name: string,
  args: string,
  userId: string,
): Promise<string> {
  const templateFn = TEMPLATES[name.toLowerCase()];
  if (!templateFn) {
    return `Unknown template "${name}". Available: ${Object.keys(TEMPLATES).join(", ")}`;
  }

  try {
    const dag = templateFn(args, userId);
    await startSwarm(dag);
    const nodeList = dag.nodes.map(n => `  ${n.label} (${n.type})`).join("\n");
    return [
      `Template "${name}" started as swarm "${dag.name}".`,
      `${dag.nodes.length} nodes, budget $${dag.budget.maxCostUsd.toFixed(2)}`,
      "",
      nodeList,
    ].join("\n");
  } catch (err) {
    return `Template failed: ${err}`;
  }
}

const TEMPLATES: Record<string, (args: string, userId: string) => SwarmDAG> = {
  "competitor-analysis": buildCompetitorAnalysisDAG,
  "content-waterfall": buildContentWaterfallDAG,
  "weekly-report": buildWeeklyReportDAG,
};

function buildCompetitorAnalysisDAG(args: string, userId: string): SwarmDAG {
  const competitors = args
    ? args.split(",").map(c => c.trim()).filter(Boolean)
    : ["CoolSculpting NYC", "Sono Bello", "BodySquad"];

  const builder = createDAG("competitor-analysis");

  // Phase 1: parallel research
  const researchIds: string[] = [];
  for (const comp of competitors) {
    const id = builder.addNode({
      label: `Research ${comp}`,
      type: "research",
      prompt: `Research "${comp}" as a competitor in the GLP-1 / medical weight loss space. Find and report:\n` +
        `1. Pricing structure (consults, monthly programs, packages)\n` +
        `2. Services offered (GLP-1 specific: semaglutide, tirzepatide, etc.)\n` +
        `3. Marketing channels (social media, Google Ads, content, referral)\n` +
        `4. Online reviews (Google, Yelp, RealSelf - average rating, volume, key themes)\n` +
        `5. Unique differentiators (what makes them stand out)\n` +
        `6. Weaknesses or gaps you can identify\n\n` +
        `Format as a structured report with clear sections and bullet points.`,
    });
    researchIds.push(id);
  }

  // Phase 2: parallel analysis
  const pricingId = builder.addNode({
    label: "Pricing comparison",
    type: "research",
    prompt: "Compare pricing across all competitors provided in the context below. " +
      "Create a pricing matrix showing each competitor's rates. " +
      "Identify where PV Medispa & Weight Loss sits in the market. " +
      "Find pricing gaps and opportunities for competitive positioning.",
  });

  const marketingId = builder.addNode({
    label: "Marketing analysis",
    type: "research",
    prompt: "Compare marketing channels and messaging across all competitors. " +
      "What channels are each competitor using? What's working for them? " +
      "What channels are underserved? What messaging themes resonate? " +
      "Identify specific opportunities for PV Medispa & Weight Loss to differentiate.",
  });

  for (const rId of researchIds) {
    builder.addEdge(rId, pricingId);
    builder.addEdge(rId, marketingId);
  }

  // Phase 3: synthesis
  const synthId = builder.addNode({
    label: "Executive summary",
    type: "synthesize",
    prompt: "Synthesize all research and analysis into a concise executive summary for Derek (owner of PV Medispa & Weight Loss). Include:\n" +
      "1. Market position: where PV sits relative to competitors\n" +
      "2. Pricing strategy: specific recommendations\n" +
      "3. Marketing gaps: what PV should start/stop doing\n" +
      "4. Top 3 actionable next steps\n\n" +
      "Keep it under 1500 characters. Be direct and specific.",
  });

  builder.addEdge(pricingId, synthId);
  builder.addEdge(marketingId, synthId);

  return builder.build({
    initiatedBy: userId,
    maxCostUsd: 3.00,
    maxAgents: 4,
    maxWallClockMs: 20 * 60 * 1000,
  });
}

function buildContentWaterfallDAG(args: string, userId: string): SwarmDAG {
  const topic = args || "GLP-1 weight loss and body composition tracking";
  const builder = createDAG("content-waterfall");

  // Phase 1: research
  const researchId = builder.addNode({
    label: "Topic research",
    type: "research",
    prompt: `Research the topic "${topic}" for PV Medispa's Vitality Unchained Skool community.\n` +
      "Find: current trends, patient questions, myths to debunk, actionable tips.\n" +
      "Consider the 5 pillars: Precision Weight Science, Nourishing Health, Dynamic Movement, Mindful Wellness, Functional Wellness.\n" +
      "Output: structured research notes with key points, statistics, and angles.",
  });

  // Phase 2: parallel content creation
  const skoolId = builder.addNode({
    label: "Skool longform post",
    type: "research",
    prompt: "Write a Skool community post (500-800 words) for Vitality Unchained based on the research provided.\n" +
      "Use Derek's teaching voice: direct, empathetic, evidence-based, no fluff.\n" +
      "Include: hook, educational content, actionable takeaway, engagement question.\n" +
      "Reference the body comp SCALE (never InBody or DEXA).",
  });

  const youtubeId = builder.addNode({
    label: "YouTube outline",
    type: "research",
    prompt: "Create a YouTube video outline (5-8 min video) based on the research provided.\n" +
      "Include: hook (first 15s), intro, 3-5 key points, call to action.\n" +
      "Optimize title and description for SEO. Include suggested thumbnail concept.",
  });

  builder.addEdge(researchId, skoolId);
  builder.addEdge(researchId, youtubeId);

  // Phase 3: derivative content from Skool post
  const facebookId = builder.addNode({
    label: "3 Facebook hooks",
    type: "research",
    prompt: "Extract 3 Facebook hook posts from the Skool longform post provided.\n" +
      "Each hook: 2-3 sentences max, pattern-interrupt style, drives curiosity.\n" +
      "Include a CTA pointing to the full Skool post or community.\n" +
      "Vary the angles: story-based, question-based, stat-based.",
  });

  const emailId = builder.addNode({
    label: "Email newsletter draft",
    type: "research",
    prompt: "Draft an email newsletter based on the Skool longform post.\n" +
      "Subject line options (3), preview text, body (300-400 words), CTA.\n" +
      "Tone: warm, knowledgeable, like a trusted advisor.\n" +
      "Include: educational value + clear next step.",
  });

  builder.addEdge(skoolId, facebookId);
  builder.addEdge(skoolId, emailId);

  // Phase 4: synthesis
  const synthId = builder.addNode({
    label: "Content package",
    type: "synthesize",
    prompt: "Compile all content pieces into a clean, organized package.\n" +
      "Order: Skool post, 3 Facebook hooks, email newsletter, YouTube outline.\n" +
      "Add a publishing schedule recommendation (which piece when).\n" +
      "Keep formatting clean for Telegram delivery.",
  });

  builder.addEdge(facebookId, synthId);
  builder.addEdge(emailId, synthId);
  builder.addEdge(youtubeId, synthId);

  return builder.build({
    initiatedBy: userId,
    maxCostUsd: 2.00,
    maxAgents: 3,
    maxWallClockMs: 15 * 60 * 1000,
  });
}

function buildWeeklyReportDAG(args: string, userId: string): SwarmDAG {
  const builder = createDAG("weekly-report");

  // Phase 1: parallel data gathering (these will get business context injected by Atlas)
  const financialId = builder.addNode({
    label: "Financial snapshot",
    type: "research",
    prompt: "Pull the latest financial data for PV Medispa from the dashboard context.\n" +
      "Include: weekly revenue, expenses, profit margin, ROAS, CAC, outstanding invoices.\n" +
      "Compare week-over-week. Flag any anomalies (>15% change).",
  });

  const pipelineId = builder.addNode({
    label: "Pipeline review",
    type: "research",
    prompt: "Review the current GHL pipeline status.\n" +
      "Include: leads by stage, conversion rates, stale leads (>7 days), no-shows.\n" +
      "Speed-to-lead metrics. Appointment completion rate.",
  });

  const marketingId = builder.addNode({
    label: "Marketing performance",
    type: "research",
    prompt: "Review Meta Ads, Google Ads, GA4, and GBP performance for the past week.\n" +
      "Include: ad spend, CPL, CTR, website traffic, top landing pages, top search keywords.\n" +
      "Compare to previous week. Flag any underperforming campaigns.",
  });

  // Phase 2: cross-source analysis
  const analysisId = builder.addNode({
    label: "Cross-source analysis",
    type: "synthesize",
    prompt: "Analyze all data sources together for cross-cutting insights.\n" +
      "Look for: funnel leakage points, attribution gaps, ROI by channel.\n" +
      "Identify the single biggest opportunity and biggest risk.\n" +
      "Be specific with numbers and recommendations.",
  });

  builder.addEdge(financialId, analysisId);
  builder.addEdge(pipelineId, analysisId);
  builder.addEdge(marketingId, analysisId);

  // Phase 3: executive summary
  const synthId = builder.addNode({
    label: "Executive summary",
    type: "synthesize",
    prompt: "Create a weekly executive summary for Derek.\n" +
      "Format: 5 bullet points max, each with a specific metric and action item.\n" +
      "Lead with the most important finding. End with 'This week focus on: [one thing]'.\n" +
      "Keep under 1000 characters.",
  });

  builder.addEdge(analysisId, synthId);

  return builder.build({
    initiatedBy: userId,
    maxCostUsd: 2.00,
    maxAgents: 3,
    maxWallClockMs: 15 * 60 * 1000,
  });
}

// ============================================================
// MAINTENANCE
// ============================================================

/**
 * Clean up old scratchpad directories.
 * Called from heartbeat or cron.
 */
export async function cleanupSwarms(): Promise<void> {
  const cleaned = await cleanOldScratchpads(24 * 60 * 60 * 1000);
  if (cleaned > 0) {
    info("orchestrator", `Cleaned ${cleaned} old swarm scratchpads`);
  }
}
