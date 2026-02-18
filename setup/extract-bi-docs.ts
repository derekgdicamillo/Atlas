#!/usr/bin/env bun
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const TASKS_DIR = String.raw`C:\Users\derek\AppData\Local\Temp\claude\C--Users-derek--claude-projects-C--Users-derek-Projects-atlas\tasks`;
const OUTPUT_DIR = String.raw`C:\Users\derek\Projects\atlas\data\training\business-intelligence`;

const FILES: Record<string, string> = {
  "a0599e4.output": "warren-buffett.md",
  "a30cdf1.output": "charlie-munger.md",
  "ac23adc.output": "jeff-bezos.md",
  "ae15746.output": "sam-walton.md",
  "a65279d.output": "alex-hormozi.md",
  "a71770e.output": "tim-cook.md",
  "a412a39.output": "ray-dalio.md",
  "a88e43f.output": "peter-thiel.md",
  "ae113c5.output": "sara-blakely.md",
  "a24eff9.output": "keith-cunningham.md",
};

async function extractLongestText(filePath: string): Promise<string> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.trim().split("\n");
  let longestText = "";
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.message?.role === "assistant" && Array.isArray(obj.message.content)) {
        for (const block of obj.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            if (block.text.length > longestText.length) longestText = block.text;
          }
          if (block.type === "tool_use" && block.input?.content && typeof block.input.content === "string") {
            if (block.input.content.length > longestText.length) longestText = block.input.content;
          }
        }
      }
    } catch { }
  }
  return longestText.trim();
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  let total = 0;
  let errors = 0;
  for (const [inputFile, outputFile] of Object.entries(FILES)) {
    const inputPath = join(TASKS_DIR, inputFile);
    const outputPath = join(OUTPUT_DIR, outputFile);
    try {
      const content = await extractLongestText(inputPath);
      if (!content) { console.error("  ERROR: No text in " + inputFile); errors++; continue; }
      let cleaned = content;
      if (cleaned.startsWith("---\n")) cleaned = cleaned.replace(/^---\n+/, "");
      const cutoff = Math.floor(cleaned.length * 0.9);
      for (const m of ["\n---\n\nNote:", "\nNote: Web search", "\nNote: All web", "\nNote: Both WebSearch", "\nNote: I compiled", "\nNote: This document"]) {
        const idx = cleaned.lastIndexOf(m);
        if (idx > 0 && idx > cutoff) { cleaned = cleaned.substring(0, idx); break; }
      }
      await writeFile(outputPath, cleaned.trim() + "\n", "utf-8");
      console.log("  OK: " + outputFile + " (" + cleaned.trim().length + " chars)");
      total++;
    } catch (err) { console.error("  ERROR " + inputFile + ": " + err); errors++; }
  }
  console.log("\nDone. Extracted: " + total + ", Errors: " + errors);
}
main().catch(console.error);