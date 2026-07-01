/**
 * FB Intake Skill - Main executor
 * Runs in forked context, orchestrates chunked extraction + upload
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface ChunkJob {
  chunkNum: number;
  imagePaths: string[];
  outputPath: string;
}

/**
 * Parse arguments: can be a folder path or direct image paths
 */
function parseArguments(args: string): { imagePaths: string[] } {
  // Simple heuristic: if single arg ends in *, / or exists as dir, treat as glob
  const trimmed = (args || "").trim();

  if (!trimmed) {
    console.error("No arguments provided. Usage: /fb-intake <folder> or /fb-intake <image> <image> ...");
    process.exit(1);
  }

  let paths: string[] = [];

  // If looks like a folder path
  if (fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory()) {
    // Glob for images
    const glob = new (require("glob")).Glob;
    const pattern = path.join(trimmed, "*.{jpg,jpeg,png,webp}");
    const found = glob.sync(pattern);
    if (found.length === 0) {
      console.error(`No images found in ${trimmed}`);
      process.exit(1);
    }
    paths = found;
  } else {
    // Assume space-separated paths or a single path
    paths = trimmed
      .split(/\s+/)
      .filter((p) => p && (p.endsWith(".jpg") || p.endsWith(".jpeg") || p.endsWith(".png") || p.endsWith(".webp")));
  }

  if (paths.length === 0) {
    console.error("No valid image paths found.");
    process.exit(1);
  }

  return { imagePaths: paths };
}

/**
 * Split images into chunks of 8
 */
function chunkImages(imagePaths: string[]): ChunkJob[] {
  const chunks: ChunkJob[] = [];
  const chunkSize = 8;

  for (let i = 0; i < imagePaths.length; i += chunkSize) {
    const chunkNum = Math.floor(i / chunkSize);
    const batch = imagePaths.slice(i, i + chunkSize);
    const outputPath = `tmp/fb-intake/chunk-${String(chunkNum).padStart(2, "0")}.json`;

    chunks.push({
      chunkNum,
      imagePaths: batch,
      outputPath,
    });
  }

  return chunks;
}

/**
 * Generate subagent prompt for a chunk
 */
function generateSubagentPrompt(chunk: ChunkJob): string {
  const paths = chunk.imagePaths.map((p) => `  - ${p}`).join("\n");

  return `You are extracting Facebook group member information from screenshots.

Read these image files:
${paths}

They are Facebook group member screenshots. Extract EVERY visible member entry.

For each member, extract:
- Full name (exact spelling)
- Email address (transcribe EXACTLY character-for-character; if partially cut off or unreadable, omit it and note in details)
- Details: role/credential (RN, LPN, NP, MD, aesthetician, etc.), location (city/state), business/employer if visible
- Source image filename

Write the results to tmp/fb-intake/chunk-${String(chunk.chunkNum).padStart(2, "0")}.json as a JSON array with this structure:
[
  {"name": "Jane Doe", "email": "jane@example.com", "details": "RN at Phoenix Hospital, Arizona", "sourceImage": "image1.jpg"},
  {"name": "John Smith", "email": "", "details": "aesthetician, Colorado (email not visible)", "sourceImage": "image2.jpg"}
]

Use Bash heredoc (cat > file << 'EOF') to write the file. Do NOT use the Write tool.

CRITICAL INSTRUCTIONS:
- Include entries with no visible email too (set email to empty string)
- Never guess or autocomplete emails
- Transcribe emails character-for-character exactly as shown
- Return ONLY the count of entries extracted in your final message
- Do NOT return the contact data in your message — it goes to disk only`;
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2).join(" ");
  const { imagePaths } = parseArguments(args);

  // Prep directory
  console.log(`Found ${imagePaths.length} screenshots, processing in chunks of 8...`);

  try {
    execSync("mkdir -p tmp/fb-intake && rm -f tmp/fb-intake/chunk-*.json tmp/fb-intake/merged.json", {
      stdio: "ignore",
    });
  } catch {
    // Ignore errors
  }

  const chunks = chunkImages(imagePaths);
  console.log(`Spawning ${chunks.length} parallel extraction agents...`);

  // For each chunk, spawn a subagent
  // This is a simplified implementation — in practice, you'd use the Agent tool
  // within Claude Code to spawn these in parallel.

  // For now, output the chunk metadata so the main skill can dispatch agents
  const jobSpec = {
    totalChunks: chunks.length,
    totalImages: imagePaths.length,
    chunks: chunks.map((c) => ({
      chunkNum: c.chunkNum,
      imagePaths: c.imagePaths,
      outputPath: c.outputPath,
      prompt: generateSubagentPrompt(c),
    })),
  };

  console.log(JSON.stringify(jobSpec, null, 2));
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
