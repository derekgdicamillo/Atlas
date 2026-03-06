/**
 * Generate 3 Meta Ad Images for PV MediSpa using Gemini 3 Pro Image Preview
 * No text overlays. 4:5 portrait aspect ratio. Navy/gold/white palette.
 */
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import "dotenv/config";

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("GEMINI_API_KEY not found in environment");
  process.exit(1);
}

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${API_KEY}`;
const OUTPUT_DIR = resolve("data", "task-output", "ad-images");
mkdirSync(OUTPUT_DIR, { recursive: true });

const images = [
  {
    filename: "prescription-vs-program.png",
    prompt: `Generate a photorealistic image in 4:5 portrait aspect ratio (1080x1350 pixels).

SCENE: A friendly, approachable nurse practitioner (male, early 40s, wearing a navy scrub top) sitting at a clean modern desk in a bright medical office. On the desk is a printed body composition analysis report/printout with charts and numbers visible. The provider is looking warmly toward the camera with a confident, caring expression.

ENVIRONMENT: Modern medical clinic with warm ambient lighting. Clean white walls with subtle navy accent panels. A small potted plant in the background. Natural light from a window mixed with warm overhead lighting creating an inviting atmosphere.

COLOR PALETTE: Navy blue (#1B2A4A) dominant in scrubs and accents, warm gold (#C9A84C) in lighting warmth and small accent details, cream/white walls and surfaces.

STYLE: Professional healthcare photography look. Shallow depth of field with the provider and body comp printout in sharp focus. Warm, inviting, trustworthy. No text, no logos, no watermarks, no overlays of any kind. Pure photographic image only.`
  },
  {
    filename: "real-program-includes.png",
    prompt: `Generate a clean infographic-style illustration in 4:5 portrait aspect ratio (1080x1350 pixels).

COMPOSITION: A vertical checklist layout with 6 items arranged neatly. Each item has a simple, modern flat-design icon on the left and empty space to the right (no text, labels, or words anywhere). The icons should be arranged in a clean grid or vertical list format with generous spacing.

THE 6 ICONS (in order, top to bottom):
1. A medication vial/syringe icon (representing GLP-1 medication)
2. A laboratory test tube/blood vial icon (representing lab work)
3. A body silhouette with measurement lines icon (representing body composition scan)
4. A plate with fork and knife icon (representing nutrition planning)
5. A laptop/phone with video call icon (representing telehealth visits)
6. A group of people/community icon (representing support community)

Each icon should have a small circular checkbox or checkmark next to it in gold.

COLOR PALETTE: Navy blue (#1B2A4A) background or navy gradient, white icons, gold (#C9A84C) checkmarks and accent elements. Clean, minimal, modern.

STYLE: Flat design infographic illustration. Sharp vector-style graphics. Professional and polished. Absolutely no text, no words, no letters, no numbers anywhere in the image. Icons only. No watermarks.`
  },
  {
    filename: "telehealth-from-couch.png",
    prompt: `Generate a photorealistic image in 4:5 portrait aspect ratio (1080x1350 pixels).

SCENE: A woman in her late 30s sitting comfortably on a modern couch in her living room, holding a tablet or laptop on her lap. On the screen is visible a video call with a healthcare provider (small figure on screen, not the focus). She is smiling naturally, looking at the screen, relaxed and engaged in the virtual visit.

WOMAN: Casual but put-together look. Comfortable loungewear or casual clothes. Natural hair and makeup. Looks healthy and happy. Diverse representation welcome.

ENVIRONMENT: Cozy, well-decorated modern living room. Soft natural daylight streaming through a nearby window with sheer curtains. A warm throw blanket partially draped on the couch. A coffee mug on the side table. Green houseplant in the background. The space feels warm, lived-in, and comfortable.

COLOR PALETTE: Warm neutral tones (cream, beige, soft white) with touches of sage green from plants, natural wood tones. Warm golden daylight. Soft and inviting.

STYLE: Lifestyle photography look. Natural and authentic, not overly staged. Soft natural lighting with gentle shadows. Shallow depth of field focusing on the woman. No text, no logos, no watermarks, no overlays of any kind. Pure photographic image only.`
  }
];

async function generateImage(config) {
  console.log(`\nGenerating: ${config.filename}...`);

  const body = {
    contents: [
      {
        parts: [{ text: config.prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`API error ${response.status} for ${config.filename}: ${errText.slice(0, 500)}`);
    return false;
  }

  const data = await response.json();
  const candidates = data.candidates;
  if (!candidates || candidates.length === 0) {
    console.error(`No candidates for ${config.filename}`);
    console.error(JSON.stringify(data, null, 2).slice(0, 1000));
    return false;
  }

  const parts = candidates[0].content?.parts;
  if (!parts) {
    console.error(`No parts for ${config.filename}`);
    return false;
  }

  let imageData = null;
  let mimeType = "image/png";
  let textResponse = "";

  for (const part of parts) {
    if (part.inlineData) {
      imageData = part.inlineData.data;
      mimeType = part.inlineData.mimeType || "image/png";
    }
    if (part.text) {
      textResponse += part.text;
    }
  }

  if (!imageData) {
    console.error(`No image data for ${config.filename}. Text: ${textResponse.slice(0, 500)}`);
    return false;
  }

  const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
  const finalFilename = config.filename.replace(/\.png$/, `.${ext}`);
  const outputPath = resolve(OUTPUT_DIR, finalFilename);

  const buffer = Buffer.from(imageData, "base64");
  writeFileSync(outputPath, buffer);

  console.log(`  Saved: ${outputPath}`);
  console.log(`  Size: ${(buffer.length / 1024).toFixed(1)} KB`);
  console.log(`  Format: ${mimeType}`);
  if (textResponse) {
    console.log(`  Model notes: ${textResponse.slice(0, 300)}`);
  }
  return true;
}

async function main() {
  console.log("Generating 3 Meta ad images via Gemini 3 Pro Image Preview...");
  console.log(`Output directory: ${OUTPUT_DIR}`);

  let successes = 0;
  for (const img of images) {
    const ok = await generateImage(img);
    if (ok) successes++;
  }

  console.log(`\nDone. ${successes}/${images.length} images generated successfully.`);
  if (successes < images.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
