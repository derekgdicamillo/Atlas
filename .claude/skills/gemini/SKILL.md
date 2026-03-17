---
name: gemini
description: >-
  Gemini Image Generator & Editor (Nano Banana 2). Generate images using structured
  JSON prompts with realism engine for professional, non-AI-looking results.
  Use when Derek says "generate an image", "make a photo", "gemini this",
  "/gemini", or wants AI-generated visuals for ads, content, or social media.
  Supports both simple text prompts and structured JSON mode for professional results.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
context: fork
user-invocable: true
argument-hint: "[prompt text or JSON]"
metadata:
  author: Atlas
  version: 3.0.0
---

# Gemini Image Generator (Nano Banana 2 + Realism Engine)

Generate photorealistic images via Gemini API. The realism engine auto-injects camera specs, film stock, skin texture, surface imperfections, and anti-AI negatives based on realism level. Default realism: "high".

## Modes

### 1. Simple Text Mode (backward compatible)
If `$ARGUMENTS` is plain text (no JSON), emit:
```
[GEMINI_IMAGE: the prompt text here]
```

### 2. Structured JSON Mode (recommended)
If `$ARGUMENTS` contains JSON or is a topic/concept, build a JSON prompt.

## JSON Prompt Schema

```json
{
  "category": "lifestyle|educational|authority|offer|community",
  "subject": "Narrative scene description (REQUIRED, be specific not generic)",
  "setting": "Environment with lived-in details",
  "camera": "eye-level|low-angle|high-angle|birds-eye|close-up|wide-shot|medium-shot|over-the-shoulder|extreme-close-up|dutch-angle",
  "cameraBody": "Canon EOS R5|Sony A7III|Hasselblad 500C|Canon 5D Mark IV",
  "focalLength": "85mm|50mm|35mm|24mm|100mm macro",
  "aperture": "f/1.4|f/2.0|f/2.8|f/5.6|f/8",
  "lighting": "natural-window|golden-hour|soft-diffused|clinical-bright|warm-ambient|backlit|studio-key|overcast-even|rembrandt|butterfly|rim-light|side-light",
  "lightDirection": "from camera-left|from above|45 degrees from camera-right",
  "composition": "rule-of-thirds|centered|leading-lines|negative-space|symmetrical|frame-within-frame|diagonal|golden-ratio",
  "style": "photo-realistic|editorial|lifestyle-candid|clinical-professional|infographic-clean|warm-portrait|bold-graphic|documentary|aspirational",
  "filmStock": "portra-400|portra-800|gold-200|ektar-100|pro-400h|superia-400|cinestill-800t|vision3|hp5|tri-x-400",
  "colorGrade": "teal-and-amber|muted warm tones|desaturated earth tones",
  "aspectRatio": "1:1|9:16|16:9|4:5|2:3|3:1",
  "mood": ["warm", "confident"],
  "brandColor": "#6CC3E0",
  "props": ["body comp scale", "protein shake"],
  "demographics": "woman in her mid-40s, athletic build, natural appearance",
  "surfaceDetail": ["visible pores", "slight environmental wear", "dust in light"],
  "avoid": ["syringes", "brand drug names"],
  "realism": "standard|high|ultra",
  "textOverlay": "Max 5 words"
}
```

**Required:** `category`, `subject`
**Everything else optional** with smart defaults based on realism level.

### Realism Levels

| Level | Auto-injects | Best for |
|-------|-------------|----------|
| `standard` | Nothing extra, your fields only | Infographics, bold graphics, stylized |
| `high` (default) | Camera body/lens, film stock, skin realism, film grain, anti-AI negatives, surface detail | Most ad creative, lifestyle, portraits |
| `ultra` | Everything in high + sensor noise, lens vignette, chromatic aberration, extra skin detail, environmental imperfections | Hero images, testimonial portraits, authority shots |

### Film Stock Quick Reference

| Stock | Look | Best for |
|-------|------|----------|
| `portra-400` | Warm skin, soft contrast | Portraits, lifestyle (DEFAULT for people) |
| `gold-200` | Saturated, nostalgic | Outdoor lifestyle, community |
| `ektar-100` | Vivid, fine grain | Products, flat lays (DEFAULT for products) |
| `pro-400h` | Soft pastels, ethereal | Beauty, wellness |
| `cinestill-800t` | Tungsten, red halation | Moody, night, urban |
| `vision3` | Rich cinematic | Cinematic hero shots |

## Instructions

### Step 1: Determine Mode
- Empty/no args: ask what to generate
- Plain text: Simple Text Mode
- JSON or structured request: JSON Mode
- Topic/concept: build JSON yourself

### Step 2: Build the Prompt

1. **Write subject as narrative** - describe the scene like briefing a photographer, not listing keywords
2. **Set category** based on purpose (lifestyle, educational, authority, offer, community)
3. **Choose realism level** - "high" for most ads, "ultra" for hero images
4. **Pick camera/lens** if you want specific look (or let defaults handle it)
5. **Set lighting with direction** - always include where light comes from
6. **Pick film stock** for color science (or let defaults pick based on category)
7. **Check banned elements**: InBody/DEXA (use "body comp scale"), brand drug names (use "GLP-1 medication"), syringes
8. **Anti-AI negatives auto-append** - no need to add "no plastic skin" manually

### Step 3: Emit the Tag

```
[GEMINI_IMAGE: {"category":"lifestyle","subject":"A confident woman in her late 40s walking through a sunlit Arizona park, moving with natural athletic ease, genuine relaxed smile","setting":"Prescott area park with desert landscaping and warm sandstone pathways, morning light","camera":"medium-shot","lighting":"golden-hour","lightDirection":"from camera-left","composition":"rule-of-thirds","style":"lifestyle-candid","filmStock":"portra-400","aspectRatio":"4:5","mood":["confident","authentic"],"demographics":"woman late 40s, healthy and active, natural appearance","realism":"high"}]
```

## Examples

### Lifestyle ad (weight loss)
```
[GEMINI_IMAGE: {"category":"lifestyle","subject":"A real-looking woman in her 30s standing in a sunlit park wearing comfortable athletic wear, holding a reusable water bottle at her side, confident relaxed posture with genuine soft smile looking slightly past camera","setting":"Arizona park with blurred trees and walking path, other people visible as soft shapes in background","camera":"medium-shot","lighting":"golden-hour","lightDirection":"from camera-left creating warm rim light on hair","composition":"negative-space","style":"lifestyle-candid","filmStock":"gold-200","aspectRatio":"4:5","mood":["confident","authentic","empowered"],"demographics":"woman mid-30s, healthy build, natural makeup, wind-tousled hair with flyaways","realism":"high"}]
```

### Authority shot (consultation)
```
[GEMINI_IMAGE: {"category":"authority","subject":"A male nurse practitioner in a modern clinic reviewing health data on a tablet with a patient across a contemporary desk, mid-explanation with confident empathetic expression","setting":"Bright modern medical office with warm wood accents, potted plants, clean organized desk, natural window light","camera":"over-the-shoulder","cameraBody":"Canon EOS R5","focalLength":"35mm","aperture":"f/2.0","lighting":"natural-window","lightDirection":"from camera-right","composition":"leading-lines","style":"clinical-professional","filmStock":"portra-400","aspectRatio":"16:9","mood":["trustworthy","professional","warm"],"demographics":"male provider early 40s, female patient visible from behind slightly out of focus","realism":"ultra"}]
```

### Product flat lay
```
[GEMINI_IMAGE: {"category":"educational","subject":"Overhead flat-lay of a body composition scale on white marble surface surrounded by a loosely coiled measuring tape, glass of water with lemon, and small wellness journal","camera":"birds-eye","cameraBody":"Hasselblad 500C","focalLength":"80mm","aperture":"f/5.6","lighting":"soft-diffused","lightDirection":"from directly above","composition":"centered","style":"editorial","filmStock":"ektar-100","aspectRatio":"1:1","mood":["clean","clinical","educational"],"surfaceDetail":["subtle marble veining","slight water condensation on glass","natural fabric texture on linen underneath"],"realism":"high"}]
```

### Bold offer graphic
```
[GEMINI_IMAGE: {"category":"offer","subject":"Clean modern graphic with bold typography showing a weight loss program offer, deep navy background with teal accent elements","style":"bold-graphic","aspectRatio":"4:5","mood":["bold","premium","urgent"],"brandColor":"#6CC3E0","realism":"standard","textOverlay":"START TODAY"}]
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Plastic/waxy skin | Missing skin realism | Set realism to "high" or "ultra" (default is high) |
| Stock photo feel | Generic subject, no film stock | Write narrative subject, add filmStock |
| Flat lighting | No direction specified | Add lightDirection field |
| AI-looking overall | Standard realism + no details | Use "high" realism (auto-injects everything) |
| Too many details fighting | Ultra realism + lots of manual fields | Use "high" for most shots, "ultra" for heroes only |
| Wrong colors | No film stock or color grade | Set filmStock explicitly |
| Generic composition | No camera specs | Set cameraBody + focalLength + aperture |
