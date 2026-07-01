/**
 * FB Intake Skill v2 — Main Implementation
 *
 * This is the orchestrator that:
 * 1. Collects image paths (from folder glob or direct paths)
 * 2. Chunks images into groups of 8
 * 3. Spawns parallel extraction agents
 * 4. Merges results
 * 5. Uploads to Brevo
 * 6. Reports summary
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

interface ChunkJob {
  chunkNum: number;
  imagePaths: string[];
  outputPath: string;
}

interface UploadSummary {
  dryRun?: boolean;
  inputCount: number;
  added: number;
  updated: number;
  alreadyOnTarget: number;
  alreadyFreeMember: number;
  alreadyProMember: number;
  dupInBatch: number;
  noEmail: number;
  invalidEmail: number;
  errors: Array<{ email: string; error: string }>;
  fbGroupLeadsTotal: number | null;
  auditPath: string;
}

/**
 * Parse arguments: can be a folder path or direct image paths
 */
export function parseArguments(args: string): { imagePaths: string[] } {
  const trimmed = (args || "").trim();

  if (!trimmed) {
    throw new Error("No arguments provided. Usage: /fb-intake <folder> or /fb-intake <image> <image> ...");
  }

  let paths: string[] = [];

  // If looks like a folder path
  if (existsSync(trimmed) && require("fs").statSync(trimmed).isDirectory()) {
    // Use Glob to find images
    const glob = require("glob");
    const pattern = join(trimmed, "**/*.{jpg,jpeg,png,webp}");
    try {
      paths = glob.sync(pattern, { nodir: true });
    } catch {
      throw new Error(`Failed to glob ${pattern}`);
    }

    if (paths.length === 0) {
      throw new Error(`No images found in ${trimmed}`);
    }
  } else {
    // Assume space-separated paths or a single path
    paths = trimmed
      .split(/\s+/)
      .filter((p) => p && /\.(jpg|jpeg|png|webp)$/i.test(p))
      .filter((p) => existsSync(p));

    if (paths.length === 0) {
      throw new Error("No valid image paths found.");
    }
  }

  return { imagePaths: paths };
}

/**
 * Split images into chunks of 8
 */
export function chunkImages(imagePaths: string[]): ChunkJob[] {
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
export function generateSubagentPrompt(chunk: ChunkJob): string {
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
 * Main skill execution
 */
export async function runFBIntakeSkill(args: string): Promise<string> {
  try {
    // Step 1: Parse arguments and collect images
    const { imagePaths } = parseArguments(args);
    const imageCount = imagePaths.length;
    const chunks = chunkImages(imagePaths);
    const chunkCount = chunks.length;

    console.log(`Found ${imageCount} screenshots, processing in ${chunkCount} chunks...`);

    // Prep directory
    execSync("mkdir -p tmp/fb-intake && rm -f tmp/fb-intake/chunk-*.json tmp/fb-intake/merged.json", {
      stdio: "pipe",
    });

    // Step 2: Spawn parallel extraction agents
    // Note: This would normally use the Agent tool from Claude Code
    // For now, we return the job spec that the main skill handler will dispatch
    const jobSpec = {
      totalChunks: chunkCount,
      totalImages: imageCount,
      chunks: chunks.map((c) => ({
        chunkNum: c.chunkNum,
        imagePaths: c.imagePaths,
        outputPath: c.outputPath,
        prompt: generateSubagentPrompt(c),
      })),
    };

    return JSON.stringify(jobSpec);
  } catch (err) {
    throw new Error(`FB Intake failed: ${err}`);
  }
}
