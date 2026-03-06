/**
 * Generate Etsy Cover Image for GLP-1 Provider Course
 * Uses Gemini 2.5 Flash native image generation (Nano Banana)
 */
import { writeFileSync } from "fs";
import { resolve } from "path";

// Load env
import "dotenv/config";

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("GEMINI_API_KEY not found in environment");
  process.exit(1);
}

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${API_KEY}`;

const prompt = `Create a professional product mockup image for a digital course listing on Etsy.

The image should show:
- A modern tablet or laptop screen displaying the course title page
- Several module pages fanned out or stacked behind the main screen, suggesting depth and comprehensive content
- Clean, clinical, medical-education aesthetic
- Teal and green color scheme as the dominant palette, with white and subtle gray accents
- The text "GLP-1 Weight Management Provider Course" prominently displayed on the main screen
- The text "12 Comprehensive Modules" as a subtitle or badge element
- Professional, trustworthy, clinical education feel
- Minimalist background, perhaps a clean desk surface or subtle gradient
- No people, no patient photos, no stock photo look
- No CME/CEU references, no specific drug brand names
- Square composition (1:1 aspect ratio)
- High contrast, sharp details suitable for an Etsy listing thumbnail`;

async function generateImage() {
  console.log("Calling Gemini API for image generation...");

  const body = {
    contents: [
      {
        parts: [{ text: prompt }],
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
    console.error(`API error ${response.status}: ${errText}`);
    process.exit(1);
  }

  const data = await response.json();

  // Extract image from response
  const candidates = data.candidates;
  if (!candidates || candidates.length === 0) {
    console.error("No candidates in response");
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const parts = candidates[0].content?.parts;
  if (!parts) {
    console.error("No parts in response");
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
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
    console.error("No image data in response. Text response:");
    console.error(textResponse);
    console.error("Full response:", JSON.stringify(data, null, 2).slice(0, 2000));
    process.exit(1);
  }

  // Determine file extension
  const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
  const outputPath = resolve("data", `etsy-glp1-course-cover.${ext}`);

  // Save image
  const buffer = Buffer.from(imageData, "base64");
  writeFileSync(outputPath, buffer);

  console.log(`Image saved to: ${outputPath}`);
  console.log(`Size: ${(buffer.length / 1024).toFixed(1)} KB`);
  console.log(`Format: ${mimeType}`);
  if (textResponse) {
    console.log(`Model notes: ${textResponse.slice(0, 500)}`);
  }
}

generateImage().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
