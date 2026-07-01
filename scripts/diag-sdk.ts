// Diagnostic: isolate why SDK tool-turns error. Harmless (Bash echo only; no MCP tool invoked).
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadMcpServersForSdk } from "../src/engine/mcp-config.ts";
import { MODELS } from "../src/constants.ts";

const PROMPT = "Use the Bash tool to run `echo diagA`, then in a SEPARATE tool call run `echo diagB`, then tell me what both printed.";

async function run(label: string, mcpServers: Record<string, any>) {
  const names = Object.keys(mcpServers);
  console.log(`\n========== ${label} (mcp: ${names.length ? names.join(",") : "NONE"}) ==========`);
  if (names.length) console.log(`  sample mcp entry [${names[0]}]:`, JSON.stringify((mcpServers as any)[names[0]]));
  let n = 0, tools = 0, errReason = "", errDetail = "", text = "";
  const t0 = Date.now();
  try {
    for await (const msg of query({
      prompt: PROMPT,
      options: {
        model: MODELS.haiku,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [], // don't inherit host ~/.claude MCP/plugins — only use what we pass
        mcpServers,
        cwd: process.env.PROJECT_DIR || process.cwd(),
      } as any,
    })) {
      n++;
      const m: any = msg;
      if (m.type === "assistant") {
        if (m.error) { errDetail ||= `assistant.error=${m.error}`; console.log(`  [assistant.error] ${m.error}`); }
        for (const b of m.message?.content ?? []) {
          if (b.type === "tool_use") { tools++; console.log(`  [tool_use] ${b.name}`); }
          if (b.type === "text" && b.text) text += b.text;
        }
      }
      if (m.type === "system") console.log(`  [system] subtype=${m.subtype} mcp_servers=${JSON.stringify(m.mcp_servers ?? null)}`);
      if (m.type === "result") {
        console.log(`  [result] subtype=${m.subtype} is_error=${m.is_error} errors=${JSON.stringify(m.errors ?? null)} api_error_status=${m.api_error_status ?? null}`);
        if (m.is_error) errReason ||= `result:${m.subtype}`;
      }
    }
    console.log(`  -> ${Date.now()-t0}ms msgs=${n} tools=${tools} errReason=${errReason||"none"} errDetail=${errDetail||"none"} textLen=${text.length}`);
    console.log(`  -> TEXT: ${JSON.stringify(text.slice(0,140))}`);
  } catch (e: any) {
    console.log(`  THREW after ${Date.now()-t0}ms: ${e?.constructor?.name}: ${e?.message}`);
    console.log(`  STACK:\n${(e?.stack || "").split("\n").slice(0, 14).map((l: string) => "    " + l).join("\n")}`);
  }
}

await run("Variant A: NO MCP", {});
await run("Variant B: FULL MCP (production-like)", loadMcpServersForSdk());
console.log("\n[diag done]");
