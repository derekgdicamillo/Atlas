import { query } from "@anthropic-ai/claude-agent-sdk";
import type { StreamEvent } from "../claude.ts";
import type { EngineResult } from "./types.ts";
import { mapSdkMessageToEvents } from "./sdk-adapter.ts";
import { loadMcpServersForSdk } from "./mcp-config.ts";

export interface RunViaSdkOptions {
  modelId: string;                 // resolved model string (MODELS[tier])
  resumeSessionId?: string | null; // prior SDK session id, if resuming
  workspaceDir?: string;
  mcpIntentFlags?: Record<string, boolean>;
  inactivityMs: number;
  wallClockMs: number;
}

/**
 * Run one turn through the Claude Agent SDK. Emits the SAME StreamEvents the CLI
 * parser emits (via onEvent) so callClaude's existing wiring is reused verbatim.
 * Auth: inherits the Claude subscription OAuth (no API key), confirmed on Bun.
 */
export async function runViaSdk(
  prompt: string,
  opts: RunViaSdkOptions,
  onEvent: (e: StreamEvent) => void,
): Promise<EngineResult> {
  const controller = new AbortController();
  let lastActivity = Date.now();
  const startedAt = Date.now();

  let text = "";
  let sessionId: string | null = opts.resumeSessionId ?? null;
  let inputTokens = 0, outputTokens = 0, toolCallCount = 0, isError = false;

  // Watchdog: abort on inactivity or wall-clock, same semantics as the CLI path's kill().
  const watchdog = setInterval(() => {
    const idle = Date.now() - lastActivity;
    const wall = Date.now() - startedAt;
    if (idle > opts.inactivityMs || wall > opts.wallClockMs) controller.abort();
  }, 1000);

  try {
    const iterator = query({
      prompt,
      options: {
        model: opts.modelId,
        resume: opts.resumeSessionId || undefined,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        mcpServers: loadMcpServersForSdk(opts.mcpIntentFlags),
        cwd: opts.workspaceDir || process.env.PROJECT_DIR || process.cwd(),
        abortController: controller,
      },
    });

    for await (const msg of iterator) {
      lastActivity = Date.now();
      for (const ev of mapSdkMessageToEvents(msg)) {
        if (ev.type === "assistant" && ev.toolName) toolCallCount++;
        if (ev.type === "text_delta" && ev.textDelta) text += ev.textDelta;
        if (ev.type === "result") {
          if (ev.resultText) text = ev.resultText || text; // prefer final result text
          isError = !!ev.isError;
          inputTokens = ev.inputTokens || inputTokens;
          outputTokens = ev.outputTokens || outputTokens;
        }
        if (ev.sessionId) sessionId = ev.sessionId;
        onEvent(ev);
      }
    }
  } catch (err: any) {
    if (controller.signal.aborted) {
      isError = true;
      onEvent({ type: "result", sessionId: sessionId ?? undefined, resultText: "", isError: true, errorSubtype: "timeout" });
    } else {
      throw err;
    }
  } finally {
    clearInterval(watchdog);
  }

  return { text, sessionId, inputTokens, outputTokens, isError, toolCallCount };
}
