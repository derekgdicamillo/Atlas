/**
 * Atlas Prime — Entropy-Probe (Sprint 7)
 *
 * For ambiguous tool selections (>= 2 candidate tools in a turn), generate
 * 5 samples via Haiku, cluster by semantic equivalence, compute H = -Σ p_k log p_k.
 * High-entropy turns short-circuit to a clarifying question.
 */
import { callHaiku } from "./haiku-client.ts";

// ============================================================
// TYPES
// ============================================================

export interface Sample {
  idx: number;
  tool: string;
  args_canonical: string;
}

export interface Cluster {
  cluster_id: number;
  members: number[];
  representative: Sample;
}

export interface ProbeResult {
  entropy: number;
  clusters: Cluster[];
  samples: Sample[];
  recommendation: "dispatch_consensus" | "clarify" | "manual_review";
  selectedTool?: string;
  selectedArgs?: string;
  reason: string;
}

const SAMPLES_PER_PROBE = Number(process.env.ENTROPY_PROBE_SAMPLES ?? 5);
const ENTROPY_THRESHOLD = Number(process.env.ENTROPY_THRESHOLD ?? 0.8);
const DESTRUCTIVE = new Set([
  "SEND", "TMAA_SEND",
  "GHL_WORKFLOW",
  "CAL_REMOVE", "TMAA_CAL_REMOVE",
  "WP_POST",
  "PLANNER_DONE",
]);

// ============================================================
// CANONICAL ARGS
// ============================================================

export function canonicalArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return JSON.stringify(
    keys.reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = args[k];
      return acc;
    }, {})
  );
}

// ============================================================
// SAMPLE GENERATION
// ============================================================

const SAMPLE_SYSTEM_PROMPT =
  "You decide which tool tag to emit for this user request. " +
  "Output ONLY a JSON object: {\"tool\": \"<TAG_NAME>\", \"args\": {<key>: <value>, ...}}. " +
  "Valid TAG_NAMEs: SEND, DRAFT, CAL_ADD, GHL_NOTE, GHL_TASK, GHL_TAG, GHL_WORKFLOW, " +
  "WP_POST, WP_UPDATE, PLANNER_TASK, REMEMBER, TODO. Pick one; do not narrate.";

function parseSample(text: string, idx: number): Sample | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: any;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj?.tool || typeof obj.tool !== "string") return null;
  const args = (obj.args && typeof obj.args === "object") ? obj.args as Record<string, unknown> : {};
  return { idx, tool: obj.tool.toUpperCase(), args_canonical: canonicalArgs(args) };
}

export async function generateSamples(
  prompt: string,
  contextSystem?: string,
  k?: number
): Promise<Sample[]> {
  const n = k ?? SAMPLES_PER_PROBE;
  const system = contextSystem
    ? `${SAMPLE_SYSTEM_PROMPT}\n\n# Additional context\n${contextSystem}`
    : SAMPLE_SYSTEM_PROMPT;
  const calls: Promise<Sample | null>[] = [];
  for (let i = 0; i < n; i++) {
    calls.push(
      (async () => {
        try {
          const { text } = await callHaiku({
            system,
            userMessage: prompt,
            maxTokens: 200,
            cacheSystem: true,
          });
          return parseSample(text, i);
        } catch {
          return null;
        }
      })()
    );
  }
  const results = await Promise.all(calls);
  const valid: Sample[] = [];
  for (const r of results) if (r) valid.push({ ...r, idx: valid.length });
  return valid;
}

// ============================================================
// CLUSTERING
// ============================================================

const CLUSTER_SYSTEM =
  "Below are tool-choice samples. Cluster them by semantic equivalence (same tool + same effective args). " +
  "Output ONLY a JSON array: [{\"cluster_id\": 0, \"members\": [0,2]}, {\"cluster_id\": 1, \"members\": [1,3,4]}].";

export async function clusterSamples(samples: Sample[]): Promise<Cluster[]> {
  // Deterministic path: identical (tool, args_canonical) clusters together.
  const keyOf = (s: Sample) => `${s.tool}::${s.args_canonical}`;
  const byKey = new Map<string, number[]>();
  for (const s of samples) {
    const k = keyOf(s);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(s.idx);
  }
  if (byKey.size <= 1 || byKey.size === samples.length) {
    return Array.from(byKey.values()).map((members, i) => ({
      cluster_id: i,
      members,
      representative: samples[members[0]],
    }));
  }

  const userMsg = "Samples:\n" + samples.map((s) => `[${s.idx}] tool=${s.tool} args=${s.args_canonical}`).join("\n");
  try {
    const { text } = await callHaiku({
      system: CLUSTER_SYSTEM,
      userMessage: userMsg,
      maxTokens: 400,
      cacheSystem: true,
    });
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("no JSON array");
    const arr: { cluster_id: number; members: number[] }[] = JSON.parse(m[0]);
    return arr.map((c) => ({
      cluster_id: c.cluster_id,
      members: c.members,
      representative: samples[c.members[0]],
    }));
  } catch {
    return Array.from(byKey.values()).map((members, i) => ({
      cluster_id: i,
      members,
      representative: samples[members[0]],
    }));
  }
}

// ============================================================
// ENTROPY
// ============================================================

export function entropyOf(clusters: Cluster[], total: number): number {
  if (total <= 0) return 0;
  let H = 0;
  for (const c of clusters) {
    const p = c.members.length / total;
    if (p > 0) H -= p * Math.log(p);
  }
  return H;
}

// ============================================================
// RECOMMENDATION
// ============================================================

export function recommend(
  entropy: number,
  clusters: Cluster[],
  samples: Sample[]
): ProbeResult {
  const toolsSeen = new Set(samples.map((s) => s.tool));
  let hasDestructive = false;
  let hasNonDestructive = false;
  for (const t of toolsSeen) {
    if (DESTRUCTIVE.has(t)) hasDestructive = true;
    else hasNonDestructive = true;
  }
  if (hasDestructive && hasNonDestructive) {
    return {
      entropy,
      clusters,
      samples,
      recommendation: "clarify",
      reason: "destructive-asymmetry: destructive tool proposed alongside non-destructive alternative",
    };
  }

  const sorted = [...clusters].sort((a, b) => b.members.length - a.members.length);
  const top = sorted[0];

  // Resolve the representative sample from the samples array if possible,
  // falling back to the cluster's stored representative (handles test fixtures).
  const resolveRep = (cluster: Cluster): Sample => {
    const fromSamples = samples.find((s) => s.idx === cluster.representative.idx);
    return fromSamples ?? cluster.representative;
  };

  if (entropy <= 0.2 && top && top.members.length >= Math.max(4, samples.length - 1)) {
    const rep = resolveRep(top);
    return {
      entropy,
      clusters,
      samples,
      recommendation: "dispatch_consensus",
      selectedTool: rep.tool,
      selectedArgs: rep.args_canonical,
      reason: "unanimous or near-unanimous cluster",
    };
  }
  if (entropy <= ENTROPY_THRESHOLD && top && top.members.length >= 3) {
    const rep = resolveRep(top);
    return {
      entropy,
      clusters,
      samples,
      recommendation: "dispatch_consensus",
      selectedTool: rep.tool,
      selectedArgs: rep.args_canonical,
      reason: "below-threshold entropy with majority cluster",
    };
  }
  return {
    entropy,
    clusters,
    samples,
    recommendation: "clarify",
    reason: `entropy ${entropy.toFixed(3)} > threshold ${ENTROPY_THRESHOLD} or no majority cluster`,
  };
}

// ============================================================
// FULL PROBE
// ============================================================

export async function probe(prompt: string, contextSystem?: string): Promise<ProbeResult> {
  const samples = await generateSamples(prompt, contextSystem);
  if (samples.length === 0) {
    return {
      entropy: 0,
      clusters: [],
      samples: [],
      recommendation: "manual_review",
      reason: "no samples generated",
    };
  }
  const clusters = await clusterSamples(samples);
  const H = entropyOf(clusters, samples.length);
  return recommend(H, clusters, samples);
}
