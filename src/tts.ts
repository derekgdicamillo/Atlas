/**
 * Text-to-Speech Module
 *
 * Uses Microsoft Edge TTS (free, no API key) to convert text to audio.
 * Returns an MP3 buffer suitable for Telegram sendVoice.
 */

import { EdgeTTS } from "node-edge-tts";
import { readFile, unlink } from "fs/promises";
import { join } from "path";

const TTS_VOICE = process.env.TTS_VOICE || "en-US-GuyNeural";

/**
 * Convert text to an MP3 audio buffer.
 * Returns null if TTS fails or text is empty.
 */
export async function textToSpeech(text: string): Promise<Buffer | null> {
  if (!text || text.trim().length === 0) return null;

  // Strip markdown formatting that would sound weird spoken aloud
  const cleanText = text
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

  if (cleanText.length === 0) return null;

  // Truncate very long responses (Edge TTS has practical limits)
  const maxChars = 5000;
  const truncated = cleanText.length > maxChars
    ? cleanText.substring(0, maxChars) + "... Message truncated for voice."
    : cleanText;

  const tmpPath = join(
    process.env.TMPDIR || process.env.TEMP || "C:\\Windows\\Temp",
    `tts_${Date.now()}.mp3`
  );

  try {
    const tts = new EdgeTTS({
      voice: TTS_VOICE,
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
    });

    await tts.ttsPromise(truncated, tmpPath);
    const buffer = await readFile(tmpPath);
    return buffer;
  } catch (err) {
    console.error(`[tts] Failed: ${err}`);
    return null;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
