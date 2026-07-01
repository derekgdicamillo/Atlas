import { spawn } from "bun";
import { readFileSync } from "fs";
import { sanitizedEnv } from "../src/claude.ts";

// Build a real blog prompt and call claude -p with raw output capture
import { buildBlogPrompt } from "../src/maa-blog.ts";
const prompt = buildBlogPrompt(
  "Injectables (Botox/Fillers)",
  "Injectables (Botox/Fillers)",
  [],
  { theme: "Injectables (Botox/Fillers)", concerns: ["proper injection technique", "product reconstitution"] }
);
console.log("PROMPT LEN:", prompt.length);

const proc = spawn(["claude", "-p", "--output-format", "json", "--model", "sonnet"], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
  cwd: process.env.PROJECT_DIR || process.cwd(),
  env: sanitizedEnv(),
});
proc.stdin.write(prompt);
proc.stdin.end();
const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const code = await proc.exited;
console.log("EXIT:", code);
console.log("STDERR (first 500):", stderr.slice(0, 500));
console.log("STDOUT length:", stdout.length);
console.log("STDOUT first 300:", stdout.slice(0, 300));
console.log("STDOUT last 500:", stdout.slice(-500));
try {
  const j = JSON.parse(stdout);
  console.log("RESULT field length:", (j.result || "").length);
  console.log("RESULT first 600:", (j.result || "").slice(0, 600));
} catch(e) { console.log("JSON parse err:", e); }
