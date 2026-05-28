import { callClaude } from "../src/claude.ts";

// Force the SDK engine for this run only.
process.env.ATLAS_ENGINE = "sdk";

const prompt = process.argv[2] || "Reply with exactly: PONG";
const text = await callClaude(prompt, { model: "haiku", isolated: true, agentId: "smoke", userId: "smoke" });
console.log("─".repeat(40));
console.log("RESULT:", JSON.stringify(text));
console.log("OK:", text.trim().length > 0);
