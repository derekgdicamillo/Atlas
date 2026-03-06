/**
 * Generate Etsy Cover Image for GLP-1 Provider Course (v2 - Higher Quality)
 * Uses Gemini 3 Pro Image Preview for better quality output
 */
import { writeFileSync } from "fs";
import { resolve } from "path";
import "dotenv/config";

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("GEMINI_API_KEY not found in environment");
  process.exit(1);
}

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${API_KEY}`;

const prompt = `Generate a high-quality professional product mockup image for a digital medical education course listing.

COMPOSITION:
- Center of frame: A sleek modern tablet (like an iPad) angled slightly, displaying the course title screen
- Behind the tablet: 3-4 document pages or module covers fanned out, partially visible, suggesting the depth of content
- Background: Clean soft gradient from light teal to white, or a pristine white desk surface with soft shadows

TEXT ON THE MAIN TABLET SCREEN (must be clearly readable):
- Main title in large bold text: "GLP-1 Weight Management Provider Course"
- Below the title: "12 Comprehensive Modules" in a teal badge or banner

DESIGN REQUIREMENTS:
- Color palette: Rich teal (#008080), medical green (#2E8B57), white, light gray
- Typography style: clean sans-serif, professional
- The module pages behind should show hints of medical charts, bullet points, or clinical diagrams
- Overall feel: premium digital product, trustworthy medical education, polished and modern
- Sharp, high resolution details
- No people, no faces, no patient photos
- No CME/CEU text, no drug brand names
- The image should be in a 4:3 landscape aspect ratio`;

async function generateImage() {
  console.log("Calling Gemini 3 Pro Image API...");

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
  const candidates = data.candidates;
  if (!candidates || candidates.length === 0) {
    console.error("No candidates in response");
    console.error(JSON.stringify(data, null, 2).slice(0, 3000));
    process.exit(1);
  }

  const parts = candidates[0].content?.parts;
  if (!parts) {
    console.error("No parts in response");
    console.error(JSON.stringify(data, null, 2).slice(0, 3000));
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
    console.error("No image data in response. Text:", textResponse);
    console.error("Full response:", JSON.stringify(data, null, 2).slice(0, 3000));
    process.exit(1);
  }

  const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
  const outputPath = resolve("data", `etsy-glp1-course-cover-v2.${ext}`);

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
