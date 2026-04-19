/**
 * Atlas Prime — Fast Haiku Client
 *
 * Direct @anthropic-ai/sdk wrapper for low-latency classifier calls.
 * Used by Staleness Sentinel (runs every turn) and any future per-turn
 * classifier that can't afford Claude CLI subprocess latency.
 *
 * Exposes cache_control + usage.cache_read_tokens, which the CLI
 * subprocess path does not.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./constants.ts";
import { info, error as logError } from "./logger.ts";

const API_KEY = process.env.ANTHROPIC_API_KEY;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!API_KEY) {
    throw new Error("haiku-client: ANTHROPIC_API_KEY not set");
  }
  if (!client) client = new Anthropic({ apiKey: API_KEY });
  return client;
}

export interface HaikuMessage {
  system: string;
  userMessage: string;
  maxTokens?: number;
  /** Mark the system prompt as cacheable (1h TTL) for repeated classifier use */
  cacheSystem?: boolean;
}

export interface HaikuResult {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export async function callHaiku(params: HaikuMessage): Promise<HaikuResult> {
  const c = getClient();
  const systemBlock = params.cacheSystem
    ? [{
        type: "text" as const,
        text: params.system,
        cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
      }]
    : params.system;

  try {
    const resp = await c.messages.create({
      model: MODELS.haiku,
      max_tokens: params.maxTokens ?? 256,
      system: systemBlock as never,
      messages: [{ role: "user", content: params.userMessage }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    return {
      text,
      usage: {
        input_tokens: resp.usage.input_tokens,
        output_tokens: resp.usage.output_tokens,
        cache_read_input_tokens: (resp.usage as { cache_read_input_tokens?: number })
          .cache_read_input_tokens,
        cache_creation_input_tokens: (resp.usage as { cache_creation_input_tokens?: number })
          .cache_creation_input_tokens,
      },
    };
  } catch (err) {
    logError("haiku-client", `callHaiku failed: ${err}`);
    throw err;
  }
}
