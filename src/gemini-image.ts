/**
 * Gemini Image Generation — Atlas integration
 *
 * Processes [GEMINI_IMAGE: prompt] tags from Claude responses,
 * generates images via Gemini API, saves to data/images/,
 * and returns file paths for Telegram delivery.
 */

import { GoogleGenAI } from "@google/genai";
import { copyFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { info, warn } from "./logger.ts";

// ============================================================
// STATE
// ============================================================

let client: GoogleGenAI | null = null;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash-exp-image-generation";
const IMAGES_DIR = join(process.cwd(), "data", "images");
const ONEDRIVE_AD_IMAGES = "C:\\Users\\derek\\OneDrive - PV MEDISPA LLC\\02_Marketing\\Ad_Creative\\Ad Images";

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

const GEMINI_IMAGE_TAG = /\[GEMINI_IMAGE:\s*([\s\S]+?)\]/gi;

function slugify(text: string, maxLen = 40): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .slice(0, maxLen)
    .replace(/-$/, "");
}

export async function processGeminiIntents(response: string): Promise<GeminiResult> {
  const result: GeminiResult = { cleanedResponse: response, imagePaths: [] };
  if (!client) return result;

  const matches = [...response.matchAll(GEMINI_IMAGE_TAG)];
  if (matches.length === 0) return result;

  await mkdir(IMAGES_DIR, { recursive: true });

  for (const match of matches) {
    const prompt = match[1].trim();
    if (!prompt) continue;

    try {
      info("gemini", `Generating image: "${prompt.slice(0, 80)}..."`);

      const genResponse = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: { responseModalities: ["IMAGE", "TEXT"] },
      });

      if (!genResponse.candidates?.[0]?.content?.parts) {
        warn("gemini", "No candidates returned from Gemini API");
        continue;
      }

      for (const part of genResponse.candidates[0].content.parts) {
        if (part.inlineData?.data) {
          const ext = part.inlineData.mimeType?.includes("jpeg") ? "jpg" : "png";
          const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
          const slug = slugify(prompt);
          const filename = `gemini_${slug}_${timestamp}.${ext}`;
          const filepath = join(IMAGES_DIR, filename);

          const buffer = Buffer.from(part.inlineData.data, "base64");
          await writeFile(filepath, buffer);
          result.imagePaths.push(filepath);
          info("gemini", `Saved: ${filepath}`);

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
      warn("gemini", `Image generation failed for "${prompt.slice(0, 50)}": ${err}`);
    }

    result.cleanedResponse = result.cleanedResponse.replace(match[0], "");
  }

  return result;
}
