/**
 * self-regen.ts — Skill regeneration via Opus.
 *
 * Takes a skill's current text + recent invocation history and returns
 * a refined replacement text with a rationale. Uses injected callClaude
 * (Max-plan OAuth CLI) — no @anthropic-ai/sdk imports.
 */

export interface SkillInvocation {
  input: string;
  output: string;
  correction: string | null;
  domain?: string;
}

export interface RegenerateResult {
  v2_text: string;
  rationale: string;
}

const REGEN_SYSTEM = `You refine a skill's text (system prompt, SKILL.md, role-prompt YAML fragment) based on its recent invocation history.

You receive:
- skill_id
- current_text: the existing text
- invocations: up to 30 recent (input, output, correction) tuples — correction is null if Derek didn't correct

Output a strict JSON object:
{
  "v2_text": "<the full refined replacement text>",
  "rationale": "<one paragraph ≤200 words: what failure pattern this addresses and the expected behavior change>"
}

Rules:
- ONE focused change. Do not rewrite from scratch unless the file is <500 chars.
- Preserve YAML / Markdown / TypeScript structure exactly.
- v2_text must be the complete refined content (replaces the file).
- Do not introduce new imports, exports, or dependencies.
- Output ONLY the JSON object. No preamble.`;

export async function regenerate(opts: {
  skill_id: string;
  current_text: string;
  invocations: SkillInvocation[];
  callClaude: (prompt: string, opts?: any) => Promise<string>;
}): Promise<RegenerateResult> {
  const userMessage = JSON.stringify({
    skill_id: opts.skill_id,
    current_text: opts.current_text,
    invocations: opts.invocations.slice(0, 30),
  });
  const prompt = `${REGEN_SYSTEM}\n\n---\n\n${userMessage}`;
  const raw = await opts.callClaude(prompt, { model: "opus", isolated: true, agentId: "self-regen" });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`self-regen: failed to parse regeneration output: ${raw.slice(0, 200)}`);
  }
  if (typeof parsed.v2_text !== "string" || typeof parsed.rationale !== "string") {
    throw new Error("self-regen: missing v2_text or rationale");
  }
  return { v2_text: parsed.v2_text, rationale: parsed.rationale };
}
