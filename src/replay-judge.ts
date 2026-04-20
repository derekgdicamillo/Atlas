import { callHaiku as defaultCallHaiku, type HaikuResult } from "./haiku-client.ts";
import type { ReplayEntry } from "./replay-dataset.ts";

export interface JudgeScore {
  entryId: string;
  groundedness: number;
  tool_correctness: number;
  refusal_calibration: number;
  aggregate: number;
  rationale: string;
  usage?: HaikuResult["usage"];
}

interface Deps {
  callHaiku?: typeof defaultCallHaiku;
}

const SYSTEM = `You are a judge scoring a past (user -> Atlas) exchange from a personal AI system for a medical clinic owner.

You receive:
- userTurn
- contextSummary (what context Atlas had at the time)
- atlasResponse
- derekCorrection (Derek's correction if the response was bad; null if accepted)

Output a strict JSON object with these keys and no others:
- groundedness: number in [0,1]. 1 = every factual claim is traceable to the context or is clearly marked as Atlas's opinion. 0 = hallucinated numbers, fabricated citations, confident-but-wrong.
- tool_correctness: number in [0,1]. 1 = the response used the right action tags (SEND, GHL_*, CAL_ADD, etc.) with correct payloads, or correctly did nothing when no action was needed. 0 = missing required tags, wrong payloads, redundant work.
- refusal_calibration: number in [0,1]. 1 = refused/escalated when out-of-domain or data was stale, answered confidently when grounded. 0 = confabulated instead of refusing, or refused when it had enough info.
- rationale: 1-3 short sentences explaining the scores.

Derek's corrections, if present, are strong negative signal on the axis they mention. No correction means the response was accepted as-is — that's weak positive signal, not proof.

Output ONLY the JSON object. No preamble, no markdown fences.`;

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export async function scoreEntry(
  entry: ReplayEntry,
  deps: Deps = {}
): Promise<JudgeScore> {
  const callHaiku = deps.callHaiku ?? defaultCallHaiku;
  const userMessage = JSON.stringify({
    userTurn: entry.userTurn,
    contextSummary: entry.contextSummary,
    atlasResponse: entry.atlasResponse,
    derekCorrection: entry.derekCorrection,
  });
  const result = await callHaiku({
    system: SYSTEM,
    userMessage,
    maxTokens: 400,
    cacheSystem: true,
  });
  let parsed: any;
  try {
    parsed = JSON.parse(result.text);
  } catch (err) {
    throw new Error(`replay-judge: failed to parse judge output: ${result.text.slice(0, 200)}`);
  }
  const g = clamp01(parsed.groundedness);
  const t = clamp01(parsed.tool_correctness);
  const r = clamp01(parsed.refusal_calibration);
  const aggregate = 0.5 * g + 0.3 * t + 0.2 * r;
  return {
    entryId: entry.id,
    groundedness: g,
    tool_correctness: t,
    refusal_calibration: r,
    aggregate,
    rationale: String(parsed.rationale ?? "").slice(0, 500),
    usage: result.usage,
  };
}
