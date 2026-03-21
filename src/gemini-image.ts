/**
 * Gemini Image Generation — Atlas integration
 *
 * Processes [GEMINI_IMAGE: prompt] and [GEMINI_IMAGE: {...json}] tags from
 * Claude responses, generates images via Gemini API, saves to categorized
 * data/images/ subdirectories, and returns file paths for Telegram delivery.
 *
 * Supports both plain-text prompts (backward compat) and structured JSON
 * prompts ("Nano Banana 2" style) for granular control over camera, lighting,
 * composition, and style.
 */

import { GoogleGenAI } from "@google/genai";
import { copyFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { info, warn } from "./logger.ts";
import {
  type GeminiJsonPrompt,
  type ImageCategory,
  buildPromptFromJson,
  sanitizePrompt,
  tryParseJsonPrompt,
  validatePrompt,
} from "./gemini-prompt-schema.ts";

// ============================================================
// STATE
// ============================================================

let client: GoogleGenAI | null = null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-image";
const IMAGES_DIR = join(process.cwd(), "data", "images");
const PROMPTS_DIR = join(process.cwd(), "data", "prompts", "history");
const ONEDRIVE_AD_IMAGES = "C:\\Users\\Derek DiCamillo\\OneDrive - PV MEDISPA LLC\\02_Marketing\\Ad_Creative\\Ad Images";

/** Valid category subdirectories */
const CATEGORY_DIRS: ImageCategory[] = ["lifestyle", "educational", "authority", "offer", "community"];

// ============================================================
// INIT
// ============================================================

export function initGemini(): boolean {
  if (!GEMINI_API_KEY) {
    warn("gemini", "GEMINI_API_KEY not set, image generation disabled");
    return false;
  }
  client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  info("gemini", `Image generation ready (model: ${GEMINI_MODEL})`);
  return true;
}

export function isGeminiReady(): boolean {
  return !!client;
}

// ============================================================
// TAG PROCESSOR
// ============================================================

export interface GeminiResult {
  cleanedResponse: string;
  imagePaths: string[];
}

/**
 * Extract all GEMINI_IMAGE tag bodies from response text.
 * Handles both plain-text prompts and JSON bodies with nested brackets.
 * Returns array of { fullMatch, body } pairs.
 */
function extractGeminiTags(text: string): Array<{ fullMatch: string; body: string }> {
  const results: Array<{ fullMatch: string; body: string }> = [];
  const prefix = "[GEMINI_IMAGE:";
  let searchStart = 0;

  while (searchStart < text.length) {
    const tagStart = text.indexOf(prefix, searchStart);
    if (tagStart === -1) break;

    const bodyStart = tagStart + prefix.length;
    // Skip whitespace after colon
    let i = bodyStart;
    while (i < text.length && /\s/.test(text[i])) i++;

    if (i >= text.length) break;

    if (text[i] === "{") {
      // JSON body: track bracket nesting
      let depth = 0;
      let inString = false;
      let escaped = false;
      let foundEnd = false;

      for (; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === "{") depth++;
        if (ch === "}") {
          depth--;
          if (depth === 0) {
            // Found end of JSON object, now expect closing ]
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            if (j < text.length && text[j] === "]") {
              const tagEnd = j + 1;
              const body = text.slice(bodyStart, i + 1).trim();
              results.push({ fullMatch: text.slice(tagStart, tagEnd), body });
              searchStart = tagEnd;
              foundEnd = true;
            }
            break;
          }
        }
      }
      if (!foundEnd) searchStart = i + 1;
    } else {
      // Plain-text body: find first closing ]
      const closeBracket = text.indexOf("]", i);
      if (closeBracket === -1) break;
      const plainTagEnd = closeBracket + 1;
      const body = text.slice(bodyStart, closeBracket).trim();
      results.push({ fullMatch: text.slice(tagStart, plainTagEnd), body });
      searchStart = plainTagEnd;
    }
  }

  return results;
}

function slugify(text: string, maxLen = 40): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .slice(0, maxLen)
    .replace(/-$/, "");
}

/**
 * Infer category from plain-text prompt keywords.
 * Used when no JSON structure is provided.
 */
function inferCategory(prompt: string): ImageCategory {
  const lower = prompt.toLowerCase();

  if (/\b(lifestyle|candid|journey|confidence|walking|jogging|active|jeans|mirror)\b/.test(lower)) {
    return "lifestyle";
  }
  if (/\b(educational|infographic|explainer|framework|science|protein|macro|data)\b/.test(lower)) {
    return "educational";
  }
  if (/\b(authority|clinical|provider|np|consultation|medical professional|credentials)\b/.test(lower)) {
    return "authority";
  }
  if (/\b(offer|pricing|deal|discount|cta|book|call|special|package)\b/.test(lower)) {
    return "offer";
  }
  if (/\b(community|tribe|group|support|gathering|inclusive|together)\b/.test(lower)) {
    return "community";
  }

  return "lifestyle"; // default
}

/**
 * Save prompt history for analytics and refinement.
 */
async function savePromptHistory(
  promptText: string,
  category: ImageCategory,
  isJson: boolean,
  jsonPrompt?: GeminiJsonPrompt,
): Promise<void> {
  try {
    await mkdir(PROMPTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    const historyFile = join(PROMPTS_DIR, `prompt_${category}_${timestamp}.json`);

    const record = {
      timestamp: new Date().toISOString(),
      category,
      isStructured: isJson,
      flatPrompt: promptText,
      jsonPrompt: jsonPrompt || null,
    };

    await writeFile(historyFile, JSON.stringify(record, null, 2));
  } catch (err) {
    warn("gemini", `Failed to save prompt history: ${err}`);
  }
}

/**
 * Get the output directory for an image based on its category.
 * Creates the directory if needed.
 */
async function getCategoryDir(category: ImageCategory): Promise<string> {
  const dir = join(IMAGES_DIR, category);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function processGeminiIntents(response: string): Promise<GeminiResult> {
  const result: GeminiResult = { cleanedResponse: response, imagePaths: [] };
  if (!client) return result;

  const tags = extractGeminiTags(response);
  if (tags.length === 0) return result;

  // Ensure base directories exist
  await mkdir(IMAGES_DIR, { recursive: true });
  for (const cat of CATEGORY_DIRS) {
    await mkdir(join(IMAGES_DIR, cat), { recursive: true });
  }

  for (const tag of tags) {
    const tagBody = tag.body;
    if (!tagBody) continue;

    // Try to parse as JSON first, fall back to plain text
    const jsonPrompt = tryParseJsonPrompt(tagBody);
    let finalPrompt: string;
    let category: ImageCategory;

    if (jsonPrompt) {
      // Structured JSON prompt
      const errors = validatePrompt(jsonPrompt);
      if (errors.length > 0) {
        warn("gemini", `JSON prompt validation errors: ${errors.join("; ")}`);
        // Still attempt generation with what we have
      }
      finalPrompt = buildPromptFromJson(jsonPrompt);
      category = jsonPrompt.category;
      info("gemini", `Structured prompt (${category}): "${finalPrompt.slice(0, 80)}..."`);
    } else {
      // Plain-text prompt (backward compatible)
      const { sanitized, replacements } = sanitizePrompt(tagBody);
      finalPrompt = sanitized;
      category = inferCategory(finalPrompt);
      if (replacements.length > 0) {
        info("gemini", `Auto-sanitized: ${replacements.join(", ")}`);
      }
      info("gemini", `Plain prompt (inferred: ${category}): "${finalPrompt.slice(0, 80)}..."`);
    }

    // Save prompt history
    await savePromptHistory(finalPrompt, category, !!jsonPrompt, jsonPrompt || undefined);

    try {
      const genResponse = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: finalPrompt,
        config: { responseModalities: ["IMAGE", "TEXT"] },
      });

      if (!genResponse.candidates?.[0]?.content?.parts) {
        warn("gemini", "No candidates returned from Gemini API");
        continue;
      }

      // Get category-specific output directory
      const outputDir = await getCategoryDir(category);

      for (const part of genResponse.candidates[0].content.parts) {
        if (part.inlineData?.data) {
          const ext = part.inlineData.mimeType?.includes("jpeg") ? "jpg" : "png";
          const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
          const slug = slugify(jsonPrompt?.subject || finalPrompt);
          const filename = `gemini_${category}_${slug}_${timestamp}.${ext}`;

          // Save to category subdirectory
          const filepath = join(outputDir, filename);
          const buffer = Buffer.from(part.inlineData.data, "base64");
          await writeFile(filepath, buffer);
          result.imagePaths.push(filepath);
          info("gemini", `Saved: ${filepath}`);

          // Copy to OneDrive
          try {
            const onedrivePath = join(ONEDRIVE_AD_IMAGES, filename);
            await copyFile(filepath, onedrivePath);
            info("gemini", `Copied to OneDrive: ${onedrivePath}`);
          } catch (copyErr) {
            warn("gemini", `OneDrive copy failed (folder may not exist): ${copyErr}`);
          }
        }
      }
    } catch (err) {
      warn("gemini", `Image generation failed for "${finalPrompt.slice(0, 50)}": ${err}`);
    }

    result.cleanedResponse = result.cleanedResponse.replace(tag.fullMatch, "");
  }

  return result;
}
