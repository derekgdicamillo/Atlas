import { join, dirname } from "path";
import { PersistentProcess, type PersistentProcessConfig, type ProcessState } from "./persistent-process.ts";
import { sanitizedEnv } from "./claude.ts";
import { MODELS, DEFAULT_MODEL, type ModelTier } from "./constants.ts";
import { info } from "./logger.ts";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_ROOT = dirname(dirname(import.meta.path));
const PROJECT_DIR = process.env.PROJECT_DIR || PROJECT_ROOT;
const MCP_CONFIG_PATH = join(PROJECT_DIR, "mcp-servers", "mcp.json");

class ProcessPool {
  private processes = new Map<string, PersistentProcess>();

  get(agentId: string, modelTier?: ModelTier): PersistentProcess {
    if (this.processes.has(agentId)) return this.processes.get(agentId)!;
    const model = modelTier || DEFAULT_MODEL;
    const config: PersistentProcessConfig = {
      agentId,
      modelId: MODELS[model],
      claudePath: CLAUDE_PATH,
      cwd: PROJECT_DIR,
      env: sanitizedEnv() as Record<string, string | undefined>,
      mcpConfigPath: MCP_CONFIG_PATH,
    };
    const proc = new PersistentProcess(config);
    this.processes.set(agentId, proc);
    info("pool", `Created persistent process entry for ${agentId} (model: ${model})`);
    return proc;
  }

  hasAlive(agentId: string): boolean {
    const proc = this.processes.get(agentId);
    return !!proc && proc.isAlive();
  }

  getStatus(): Record<string, ProcessState> {
    const status: Record<string, ProcessState> = {};
    for (const [key, proc] of this.processes) {
      status[key] = proc.getState();
    }
    return status;
  }

  async shutdownAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [key, proc] of this.processes) {
      info("pool", `Shutting down persistent process for ${key}`);
      promises.push(proc.shutdown());
    }
    await Promise.allSettled(promises);
    this.processes.clear();
  }

  async restartAgent(agentId: string): Promise<boolean> {
    const proc = this.processes.get(agentId);
    if (!proc) return false;
    return proc.restart();
  }
}

export const processPool = new ProcessPool();
