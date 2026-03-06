/**
 * Text-to-Speech Module
 *
 * Uses OpenAI tts-1 for natural-sounding voice replies.
 * ~$15/million chars. Returns OGG/Opus buffer for Telegram sendVoice.
 */

import { spawn } from "child_process";
import { sanitizedEnv } from "./claude.ts";

const VALID_VOICES = ["nova", "shimmer", "echo", "onyx", "fable", "alloy", "ash", "sage", "coral"] as const;
type Voice = typeof VALID_VOICES[number];
const envVoice = (process.env.TTS_VOICE || "onyx").toLowerCase().trim();
const TTS_VOICE: Voice = VALID_VOICES.includes(envVoice as Voice) ? (envVoice as Voice) : "onyx";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log(`[tts] Initialized: voice=${TTS_VOICE} (env=${process.env.TTS_VOICE || "unset"})`);

// Preflight: verify ffmpeg is available. Log a clear warning at startup if missing.
// This prevents confusing runtime failures when TTS appears to work but OGG conversion silently fails.
import { execSync } from "child_process";
try {
  execSync("ffmpeg -version", { stdio: "pipe", timeout: 5000, env: sanitizedEnv() as NodeJS.ProcessEnv });
} catch {
  console.warn("[tts] WARNING: ffmpeg not found in PATH. TTS OGG/Opus conversion will fail. Install ffmpeg or add it to PATH.");
}

/**
 * Strip markdown formatting that would sound weird spoken aloud.
 */
function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "") // remove code blocks
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1)) // unwrap inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/__([^_]+)__/g, "$1") // bold alt
    .replace(/_([^_]+)_/g, "$1") // italic alt
    .replace(/#+\s*/g, "") // headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links -> just text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "") // images -> remove
    .replace(/^[-*]\s+/gm, "") // bullet points
    .replace(/^\d+\.\s+/gm, "") // numbered lists
    .replace(/\n{3,}/g, "\n\n") // collapse whitespace
    .trim();
}

/**
 * Convert MP3 buffer to OGG/Opus using ffmpeg.
 * Telegram sendVoice requires OGG/Opus format.
 */
function mp3ToOggOpus(mp3Buffer: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", "pipe:0",      // read from stdin
      "-c:a", "libopus",   // encode as Opus
      "-b:a", "64k",       // 64kbps bitrate (good for voice)
      "-vn",               // no video
      "-f", "ogg",         // OGG container
      "pipe:1",            // write to stdout
    ], { stdio: ["pipe", "pipe", "pipe"], env: sanitizedEnv() as NodeJS.ProcessEnv });

    const chunks: Buffer[] = [];
    let stderr = "";

    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        console.error(`[tts] ffmpeg conversion failed (code ${code}): ${stderr.slice(-200)}`);
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    ffmpeg.on("error", (err) => {
      console.error(`[tts] ffmpeg spawn failed: ${err}`);
      resolve(null);
    });

    ffmpeg.stdin.write(mp3Buffer);
    ffmpeg.stdin.end();
  });
}

/**
 * Convert text to an OGG/Opus audio buffer via OpenAI tts-1 + ffmpeg.
 * Returns null if TTS fails or text is empty.
 */
export async function textToSpeech(text: string): Promise<Buffer | null> {
  if (!text || text.trim().length === 0) return null;

  const cleanText = cleanForSpeech(text);
  if (cleanText.length === 0) return null;

  // OpenAI tts-1 supports up to 4096 chars per request
  const maxChars = 4096;
  const truncated = cleanText.length > maxChars
    ? cleanText.substring(0, maxChars) + "... Message truncated for voice."
    : cleanText;

  if (!OPENAI_API_KEY) {
    console.warn("[tts] OPENAI_API_KEY not set, skipping TTS");
    return null;
  }

  try {
    console.log(`[tts] Requesting: voice=${TTS_VOICE}, chars=${truncated.length}`);
    // 15s timeout prevents hanging on slow/dead OpenAI connections
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          input: truncated,
          voice: TTS_VOICE,
          response_format: "mp3",
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`[tts] OpenAI API error ${res.status}: ${errBody}`);
      return null;
    }

    const mp3Buffer = Buffer.from(await res.arrayBuffer());
    console.log(`[tts] Got MP3: ${mp3Buffer.length} bytes, converting to OGG/Opus`);

    // Convert to OGG/Opus for Telegram sendVoice
    const oggBuffer = await mp3ToOggOpus(mp3Buffer);
    if (!oggBuffer) {
      console.error("[tts] OGG conversion failed, falling back to MP3");
      return mp3Buffer; // fallback: send MP3 anyway (may show as audio instead of voice)
    }

    console.log(`[tts] OGG/Opus ready: ${oggBuffer.length} bytes`);
    return oggBuffer;
  } catch (err) {
    console.error(`[tts] Failed: ${err}`);
    return null;
  }
}
