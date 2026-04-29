/**
 * reranker.ts — Cross-encoder reranking via Transformers.js ONNX models.
 *
 * Primary model : zeta-alpha-ai/zerank-1-small  (gated; requires HF_TOKEN)
 * Fallback model: Xenova/bge-reranker-base       (public, quantized)
 *
 * Uses AutoTokenizer + AutoModelForSequenceClassification directly so we can
 * read raw logits before sigmoid — the pipeline() wrapper saturates scores to
 * {0,1} and loses ranking signal.
 */

import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  env,
} from "@xenova/transformers";

// Allow HF_TOKEN injection for gated models
if (process.env.HF_TOKEN) {
  env.authToken = process.env.HF_TOKEN;
}

const PRIMARY_MODEL_ID = "zeta-alpha-ai/zerank-1-small";
const FALLBACK_MODEL_ID = "Xenova/bge-reranker-base";

let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let model: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>> | null = null;
let activeModelId: string = process.env.RERANKER_MODEL_ID ?? PRIMARY_MODEL_ID;

export function getActiveModelId(): string {
  return activeModelId;
}

async function loadModel(): Promise<void> {
  if (tokenizer && model) return;

  const requested = process.env.RERANKER_MODEL_ID ?? PRIMARY_MODEL_ID;

  try {
    tokenizer = await AutoTokenizer.from_pretrained(requested);
    model = await AutoModelForSequenceClassification.from_pretrained(requested, {
      quantized: true,
    });
    activeModelId = requested;
  } catch (err) {
    console.warn(
      `[reranker] ${requested} unavailable (${(err as Error).message}); ` +
        `falling back to ${FALLBACK_MODEL_ID}`
    );
    tokenizer = await AutoTokenizer.from_pretrained(FALLBACK_MODEL_ID);
    model = await AutoModelForSequenceClassification.from_pretrained(FALLBACK_MODEL_ID, {
      quantized: true,
    });
    activeModelId = FALLBACK_MODEL_ID;
  }
}

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult extends RerankCandidate {
  /** Raw logit score (higher = more relevant). NOT sigmoid-normalised. */
  rerank_score: number;
}

/**
 * Rerank `candidates` against `query` and return the top-K results sorted
 * by descending relevance score.
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[],
  topK = 8
): Promise<RerankResult[]> {
  if (!candidates.length) return [];

  await loadModel();

  const scored: RerankResult[] = [];

  for (const candidate of candidates) {
    try {
      // Tokenize as a sentence pair
      const inputs = (tokenizer as NonNullable<typeof tokenizer>)(query, {
        text_pair: candidate.text,
        padding: true,
        truncation: true,
      });

      // Raw logit — positive means relevant, negative means not
      const { logits } = await (model as NonNullable<typeof model>)(inputs);
      const score = Number(logits.data[0]);

      scored.push({
        ...candidate,
        rerank_score: Number.isFinite(score) ? score : 0,
      });
    } catch (err) {
      console.error(`[reranker] inference failed for candidate "${candidate.id}":`, err);
      scored.push({ ...candidate, rerank_score: 0 });
    }
  }

  return scored.sort((a, b) => b.rerank_score - a.rerank_score).slice(0, topK);
}

/** Pre-warm the model so the first real call is fast. */
export async function preWarm(): Promise<void> {
  await rerank("warm-up query", [{ id: "warm", text: "warm-up document" }], 1);
}
