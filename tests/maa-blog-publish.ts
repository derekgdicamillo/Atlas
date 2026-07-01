import { publishMAABlog } from "../src/maa-blog.ts";
import { runPrompt } from "../src/prompt-runner.ts";
import { MODELS } from "../src/constants.ts";

console.log("Triggering MAA blog publish (sonnet)...");
const t0 = Date.now();
const result = await publishMAABlog(async (prompt) => runPrompt(prompt, MODELS.sonnet));
console.log(`Elapsed: ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.success ? 0 : 1);
