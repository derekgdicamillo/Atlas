/**
 * Generate all 6 telehealth ad images using the upgraded Nano Banana 2 engine.
 * Run: bun run scripts/generate-ad-images.ts
 */

import { GoogleGenAI } from "@google/genai";
import { writeFile, mkdir, copyFile } from "fs/promises";
import { join } from "path";
import { buildPromptFromJson, type GeminiJsonPrompt } from "../src/gemini-prompt-schema.ts";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY not set");
  process.exit(1);
}

const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-image";
const IMAGES_DIR = join(process.cwd(), "data", "images");
const ONEDRIVE_AD_IMAGES = "C:\\Users\\Derek DiCamillo\\OneDrive - PV MEDISPA LLC\\02_Marketing\\Ad_Creative\\Ad Images";

// ─── The 6 Ad Images ─────────────────────────────────────────

const prompts: { name: string; prompt: GeminiJsonPrompt }[] = [
  {
    name: "01-bold-text-failure-rate",
    prompt: {
      category: "educational",
      subject: "Bold typographic ad on a dark matte background. Large white text reads: 'Eat less. Move more. 95% failure rate.' Below in smaller teal text: 'Maybe the advice was wrong.' Clean editorial layout with generous negative space. No people, no photos, just powerful typography on dark charcoal textured paper background.",
      style: "bold-graphic",
      aspectRatio: "4:5",
      mood: ["provocative", "bold"],
      realism: "standard",
      brandColor: "#6CC3E0",
      avoid: ["stock photo", "generic", "clipart", "gradients"],
    },
  },
  {
    name: "02-ugc-np-hallway",
    prompt: {
      category: "authority",
      subject: "Male nurse practitioner in his early 40s, 6 foot 2, athletic build, short brown hair, wearing navy scrubs with a stethoscope draped around neck. Standing casually in a modern clinic hallway, holding a phone up as if about to record a selfie video. Relaxed genuine half-smile, slight head tilt. One hand in scrub pocket. Natural unflattering fluorescent overhead light mixed with window light from the end of the hallway.",
      setting: "Modern medical clinic hallway with light gray walls, motivational poster slightly crooked on wall behind him, hand sanitizer dispenser visible, scuff marks on vinyl floor tiles, a rolling supply cart in the background slightly out of focus.",
      camera: "medium-shot",
      cameraBody: "iPhone 15 Pro",
      focalLength: "24mm",
      aperture: "f/1.8",
      lighting: "clinical-bright",
      lightDirection: "overhead fluorescent plus window light from hallway end",
      composition: "centered",
      style: "lifestyle-candid",
      filmStock: "superia-400",
      aspectRatio: "4:5",
      mood: ["approachable", "real", "casual"],
      demographics: "white male, early 40s, athletic build, short brown hair",
      realism: "ultra",
      surfaceDetail: [
        "phone screen showing camera app reflection",
        "lanyard badge slightly twisted",
        "wrinkled scrubs at the elbows",
        "scuffed white sneakers",
        "fingerprint smudge on phone screen"
      ],
    },
  },
  {
    name: "03-metabolism-infographic",
    prompt: {
      category: "educational",
      subject: "Clean medical infographic on off-white textured paper background. Two hand-drawn style line graphs: a red downward curve labeled 'Metabolism' and a green upward curve labeled 'Hunger Hormones', showing how dieting sabotages the body. Below the graphs, three simple icons in a row: a medical cross icon labeled 'Provider-Led', a scale icon labeled 'Body Comp Tracked', and a pill capsule icon labeled 'FDA-Approved Therapy'. Minimal clean design, medical illustration style, not corporate. Imperfect hand-drawn line quality as if sketched by a doctor on a notepad.",
      style: "infographic-clean",
      aspectRatio: "4:5",
      mood: ["educational", "clear"],
      brandColor: "#6CC3E0",
      realism: "standard",
      avoid: ["stock photo", "3D render", "glossy", "corporate clipart", "perfect lines"],
    },
  },
  {
    name: "04-clinical-body-comp",
    prompt: {
      category: "authority",
      subject: "A female patient in her late 40s standing on a white body composition scale in a medical exam room. She is wearing athletic shorts and a fitted t-shirt, looking down at the scale display with a mix of curiosity and hope. A male nurse practitioner in navy scrubs stands nearby with a tablet, reviewing results, pointing at something on screen. Natural interaction, not posed. The patient has one hand resting on the exam table for balance.",
      setting: "Clean modern medical exam room with white walls, a padded exam table with paper liner slightly crinkled, anatomical poster on wall, small window with blinds half-open letting in afternoon light, hand sanitizer pump on counter, scattered papers and a coffee cup on the side desk.",
      camera: "medium-shot",
      cameraBody: "Canon EOS R5",
      focalLength: "35mm",
      aperture: "f/2.8",
      lighting: "natural-window",
      lightDirection: "from window camera-left at 45 degrees",
      composition: "rule-of-thirds",
      style: "documentary",
      filmStock: "portra-400",
      aspectRatio: "4:5",
      mood: ["authentic", "clinical", "hopeful"],
      demographics: "white female patient late 40s, fit-average build, ponytail. Male NP early 40s, athletic build",
      realism: "ultra",
      surfaceDetail: [
        "crinkled exam table paper",
        "slight dust on blinds",
        "coffee ring stain on side desk",
        "scuff marks on floor",
        "wrinkled scrubs on the NP",
        "patient's hair pulled back with loose strands"
      ],
    },
  },
  {
    name: "05-golden-hour-trail-walk",
    prompt: {
      category: "lifestyle",
      subject: "Confident woman in her late 40s walking on a paved trail in Arizona high desert during golden hour. Athletic leggings and a fitted quarter-zip pullover. Purposeful relaxed stride, smiling slightly, looking ahead not at camera. Natural wind in hair. Golden light catching fine arm hair and pullover fabric texture. She looks strong and healthy, not model-perfect. Natural body, evidence of weight loss journey but not 'after photo' posed.",
      setting: "Paved walking trail in high desert Arizona, golden hour. Rolling brown hills with scattered juniper and sage in background. Distant Prescott-area granite boulders. Gravel shoulder along trail edge. A single other walker far in the background, slightly out of focus.",
      camera: "medium-shot",
      cameraBody: "Sony A7III",
      focalLength: "85mm",
      aperture: "f/1.8",
      lighting: "golden-hour",
      lightDirection: "from behind-right at 20 degrees above horizon",
      composition: "rule-of-thirds",
      style: "lifestyle-candid",
      filmStock: "gold-200",
      aspectRatio: "4:5",
      mood: ["confident", "free", "hopeful"],
      demographics: "white female, late 40s, fit-average build, shoulder-length brown hair with some gray",
      realism: "ultra",
      surfaceDetail: [
        "fabric texture visible on pullover",
        "slight pilling on leggings at thighs",
        "dusty trail surface with small pebbles",
        "natural arm hair catching golden light",
        "slight sweat on temples",
        "earbuds wire visible"
      ],
    },
  },
  {
    name: "06-kitchen-morning",
    prompt: {
      category: "lifestyle",
      subject: "Woman in her early 50s standing at a kitchen island in morning light, preparing a protein-rich breakfast. She is scooping Greek yogurt into a bowl that already has berries and granola. Wearing a soft oversized henley and joggers, hair loosely clipped up, no makeup. Genuine small smile, focused on the food not camera. One bare foot crossed behind the other ankle. Coffee mug with steam rising nearby.",
      setting: "Lived-in modern farmhouse kitchen with light butcher block countertops, white subway tile backsplash with slightly uneven grout lines, open shelving with mismatched mugs, a small herb plant on the windowsill with one brown leaf, morning light streaming through window over the sink. Crumbs on the counter near a bread bag. Phone plugged in on the counter showing a recipe.",
      camera: "medium-shot",
      cameraBody: "Canon EOS R5",
      focalLength: "50mm",
      aperture: "f/2.0",
      lighting: "natural-window",
      lightDirection: "from kitchen window camera-right, bright morning eastern light",
      composition: "rule-of-thirds",
      style: "lifestyle-candid",
      filmStock: "portra-400",
      aspectRatio: "4:5",
      mood: ["peaceful", "natural", "grounded"],
      demographics: "white female, early 50s, average build, light brown hair with visible gray roots, loosely clipped up",
      realism: "ultra",
      surfaceDetail: [
        "crumbs on countertop",
        "coffee mug with slight lip stain",
        "water droplets on counter near sink",
        "phone screen showing recipe with low brightness",
        "small herb plant with one yellowing leaf",
        "bare feet with chipped toenail polish"
      ],
    },
  },
];

// ─── Generate ─────────────────────────────────────────────────

async function generateImage(name: string, jsonPrompt: GeminiJsonPrompt): Promise<string | null> {
  const finalPrompt = buildPromptFromJson(jsonPrompt);
  console.log(`\n🎨 Generating: ${name}`);
  console.log(`   Prompt (first 120 chars): ${finalPrompt.slice(0, 120)}...`);

  try {
    const response = await client.models.generateContent({
      model: MODEL,
      contents: finalPrompt,
      config: { responseModalities: ["IMAGE", "TEXT"] },
    });

    if (!response.candidates?.[0]?.content?.parts) {
      console.error(`   ❌ No candidates for ${name}`);
      return null;
    }

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData?.data) {
        const ext = part.inlineData.mimeType?.includes("jpeg") ? "jpg" : "png";
        const category = jsonPrompt.category;
        const outDir = join(IMAGES_DIR, category);
        await mkdir(outDir, { recursive: true });

        const filename = `gemini_${category}_${name}_${Date.now()}.${ext}`;
        const filepath = join(outDir, filename);
        const buffer = Buffer.from(part.inlineData.data, "base64");
        await writeFile(filepath, buffer);
        console.log(`   ✅ Saved: ${filepath}`);

        // Copy to OneDrive
        try {
          await mkdir(ONEDRIVE_AD_IMAGES, { recursive: true });
          const onedrivePath = join(ONEDRIVE_AD_IMAGES, filename);
          await copyFile(filepath, onedrivePath);
          console.log(`   📁 OneDrive: ${onedrivePath}`);
        } catch (e) {
          console.warn(`   ⚠️ OneDrive copy failed: ${e}`);
        }

        return filepath;
      }
    }

    console.error(`   ❌ No image data in response for ${name}`);
    return null;
  } catch (err) {
    console.error(`   ❌ Failed: ${name}: ${err}`);
    return null;
  }
}

async function main() {
  console.log("=== Telehealth Ad Image Generation ===");
  console.log(`Model: ${MODEL}`);
  console.log(`Images: ${prompts.length}`);
  console.log("");

  // Generate sequentially to avoid rate limits
  const results: { name: string; path: string | null }[] = [];

  for (const { name, prompt } of prompts) {
    const path = await generateImage(name, prompt);
    results.push({ name, path });
    // Small delay between requests
    if (prompts.indexOf({ name, prompt } as any) < prompts.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log("\n=== Results ===");
  for (const { name, path } of results) {
    console.log(`${path ? "✅" : "❌"} ${name}: ${path || "FAILED"}`);
  }
}

main().catch(console.error);
