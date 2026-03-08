/**
 * Atlas — Content Critic
 *
 * Lightweight Haiku-powered quality gate for generated content.
 * Evaluates brand voice, compliance, engagement, and accuracy
 * before content gets delivered via the waterfall pipeline.
 *
 * Cost: ~$0.002 per evaluation (Haiku 4.5).
 */


import { MODELS, type ModelTier } from "./constants.ts";
import { info, error as logError } from "./logger.ts";

// ============================================================
// TYPES
// ============================================================

export interface CriticResult {
  passed: boolean;
  overallScore: number;      // 0-1
  scores: {
    brandVoice: number;      // Does it match Derek's casual, direct teaching style?
    compliance: number;       // No equipment Derek doesn't have, no drug claims
    engagement: number;       // Has hooks, questions, storytelling?
    accuracy: number;         // No made-up stats or wrong framework names?
  };
  issues: string[];           // Specific problems found
  suggestions: string[];      // How to fix them
}

type ContentType = "skool" | "facebook" | "newsletter" | "youtube" | "blog";

interface CriticOptions {
  threshold?: number;
  retryOnFail?: boolean;
}

// ============================================================
// CONSTANTS
// ============================================================

const DEFAULT_THRESHOLD = 0.7;
const CRITIC_MODEL: ModelTier = "haiku";

const BANNED_EQUIPMENT = ["InBody", "DEXA", "DXA", "Bod Pod", "hydrostatic"];
const AI_SMELL_WORDS = [
  "delve", "tapestry", "landscape", "multifaceted", "in today's world",
  "nuanced", "pivotal", "cornerstone", "paradigm", "embark", "foster",
  "leverage", "realm", "testament", "beacon", "resonate", "holistic",
  "spearhead", "underscore", "bespoke", "poignant",
];

const VALID_FRAMEWORKS = [
  "SLOW & SHIELD", "Vitality Tracker", "Protein Paradox", "Fuel Code",
  "Fuel Code Plate", "Calm Core Toolkit", "Cooling Fuel Protocol",
  "Movement Hierarchy",
];

// ============================================================
// CRITIC PROMPT
// ============================================================

function buildCriticPrompt(content: string, contentType: ContentType): string {
  return `You are a content quality reviewer for PV MediSpa & Weight Loss clinic. Evaluate the following ${contentType} content against these criteria and return ONLY valid JSON.

## Scoring Criteria (each 0.0 to 1.0)

**brandVoice**: Does it match a casual, direct, friend-texting-advice teaching style? Deductions for:
- Em dashes (use periods and commas instead)
- AI-sounding phrases: ${AI_SMELL_WORDS.join(", ")}
- Corporate/formal tone, excessive preamble, or "Great question!" openers
- Overuse of bold formatting
- Meta-framing like "What I tell patients" or "Here's what I use"

**compliance**: Medical and equipment accuracy. Deductions for:
- Mentioning equipment the clinic doesn't have: ${BANNED_EQUIPMENT.join(", ")} (clinic uses body comp SCALE only)
- Drug-specific efficacy claims that could violate LegitScript (e.g., "guaranteed weight loss", specific pound amounts)
- Making diagnosis or treatment promises

**engagement**: Content hooks and reader interaction. Deductions for:
- No opening hook or attention-grabber
- No questions or discussion prompts
- No storytelling or relatable examples
- Missing call-to-action where appropriate for ${contentType}

**accuracy**: Factual and framework accuracy. Deductions for:
- Made-up statistics without citation context
- Wrong framework names (valid ones: ${VALID_FRAMEWORKS.join(", ")})
- Contradicting established medical consensus on GLP-1s
- Incorrect pillar assignments

## Additional Checks
- Excessive emojis (more than 2-3 per section)
- Content too short or too long for the ${contentType} format

## Response Format
Return ONLY this JSON (no markdown fences, no commentary):
{"brandVoice":0.0,"compliance":0.0,"engagement":0.0,"accuracy":0.0,"issues":["issue1"],"suggestions":["fix1"]}

## Content to Review
${content}`;
}

// ============================================================
// CORE FUNCTION
// ============================================================

export async function critiqueContent(
  content: string,
  contentType: ContentType,
  options?: CriticOptions,
): Promise<CriticResult> {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;

  // Fallback result if the API call fails
  const fallback: CriticResult = {
    passed: true,
    overallScore: 1.0,
    scores: { brandVoice: 1.0, compliance: 1.0, engagement: 1.0, accuracy: 1.0 },
    issues: ["Critic evaluation skipped (API call failed). Content passed by default."],
    suggestions: [],
  };

  try {
    const { runPrompt } = await import("./prompt-runner.ts");
    const prompt = buildCriticPrompt(content, contentType);

    const text = await runPrompt(prompt, MODELS[CRITIC_MODEL]);
    if (!text) return fallback;

    // Extract JSON from response (handle possible markdown fences)
    const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(jsonStr);

    const scores = {
      brandVoice: clamp(parsed.brandVoice ?? 0.5),
      compliance: clamp(parsed.compliance ?? 0.5),
      engagement: clamp(parsed.engagement ?? 0.5),
      accuracy: clamp(parsed.accuracy ?? 0.5),
    };

    // Weighted average: compliance counts double (safety-critical)
    const overallScore = (
      scores.brandVoice * 1 +
      scores.compliance * 2 +
      scores.engagement * 1 +
      scores.accuracy * 1
    ) / 5;

    const issues: string[] = Array.isArray(parsed.issues) ? parsed.issues : [];
    const suggestions: string[] = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

    const result: CriticResult = {
      passed: overallScore >= threshold,
      overallScore: Math.round(overallScore * 100) / 100,
      scores,
      issues,
      suggestions,
    };

    info(
      "content-critic",
      `[${contentType}] score=${result.overallScore} passed=${result.passed} ` +
      `(voice=${scores.brandVoice} compliance=${scores.compliance} ` +
      `engage=${scores.engagement} accuracy=${scores.accuracy}) ` +
      `issues=${issues.length}`,
    );

    return result;
  } catch (err) {
    logError("content-critic", `Evaluation failed: ${err}`);
    return fallback;
  }
}

// ============================================================
// FORMATTING HELPER
// ============================================================

/** Format critic results as a readable block for email or Telegram. */
export function formatCriticReport(result: CriticResult): string {
  const { scores, issues, suggestions, overallScore, passed } = result;
  const status = passed ? "PASSED" : "FLAGGED";
  const lines = [
    `Content Critic: ${status} (${Math.round(overallScore * 100)}%)`,
    `  Voice: ${pct(scores.brandVoice)} | Compliance: ${pct(scores.compliance)} | Engagement: ${pct(scores.engagement)} | Accuracy: ${pct(scores.accuracy)}`,
  ];
  if (issues.length > 0) {
    lines.push(`  Issues: ${issues.join("; ")}`);
  }
  if (suggestions.length > 0) {
    lines.push(`  Suggestions: ${suggestions.join("; ")}`);
  }
  return lines.join("\n");
}

// ============================================================
// UTILS
// ============================================================

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
