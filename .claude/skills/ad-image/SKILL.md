---
name: ad-image
description: >-
  Internal utility for translating finished ad copy into on-brand Gemini image
  prompts. Called by other skills (ad-creative, content waterfall) to derive
  image prompts from copy. Not user-facing.
allowed-tools:
  - Read
  - Glob
  - Grep
context: fork
user-invocable: false
disable-model-invocation: true
metadata:
  author: Atlas
  version: 2.0.0
---

# Ad Image Prompt Builder (Internal Utility)

Translate finished ad copy or post content into on-brand `[GEMINI_IMAGE:]` tags for PV MediSpa. Every image must derive from actual copy, never the reverse.

## Input

- **Finished ad copy or post text**: the content the image will accompany
- **Image category**: one of lifestyle, educational, authority, offer, community

If no category is provided, infer it from the copy content:
- Weight loss journeys, activity, confidence -> lifestyle
- Explainers, frameworks, science -> educational
- Derek speaking, clinical authority, credentials -> authority
- Pricing, offers, CTAs, booking -> offer
- Community, tribe, group, support -> community

## Instructions

### Step 1: Read Brand Guide

Read `memory/brand-style-guide.md` for the full brand rules. Key constraints:
- Brand colors: PV Teal #6CC3E0, dark variant #2A7A8F, warm neutral #F5F0EB, accent #D4A574
- Photography: warm, natural light, real-looking people ages 35-65, Arizona settings
- Banned: InBody/DEXA machines, brand drug names (Ozempic/Wegovy/Mounjaro/Zepbound), syringes, before/after splits, stock-photo style
- Text in image: max 30% area, clean sans-serif, high contrast

### Step 2: Extract Visual Concept from Copy

Read the ad copy and identify:
- The core subject or scene the copy describes or implies
- The emotional tone (aspirational, educational, urgent, warm)
- Any specific setting, activity, or object referenced
- The target audience demographic cues

Do NOT invent concepts unrelated to the copy. The image must visually reinforce what the words say.

### Step 3: Build the Gemini Prompt

Follow the brand guide's prompt engineering rules. Every prompt must:

1. Start with the image category name
2. Include specific subject and setting description (derived from the copy)
3. Include lighting direction (e.g., "warm natural light", "golden hour Arizona")
4. Include brand color reference when relevant ("accent color PV teal #6CC3E0")
5. End with "high quality, professional photography style, no watermarks"
6. Specify aspect ratio: "square 1:1" (default for Facebook feed)

Category-specific prompt suffixes:

| Category | Prompt Suffix |
|----------|--------------|
| Lifestyle | "warm natural lighting, Arizona setting, authentic candid moment" |
| Educational | "clean minimalist infographic style, medical professional, PV teal #6CC3E0 accent" |
| Authority | "warm clinical environment, NP provider, approachable medical professional" |
| Offer | "bold clean ad graphic, high contrast, mobile-first design" |
| Community | "warm community gathering, inclusive diverse group, supportive atmosphere" |

### Step 4: Validate Against Banned Elements

Before outputting, check the prompt for:
- InBody or DEXA (use "body composition scale" instead)
- Brand drug names: Ozempic, Wegovy, Mounjaro, Zepbound (use "GLP-1 medication" instead)
- Syringes or needles prominently displayed
- Before/after split composition
- Stock-photo descriptors ("iStock", "Shutterstock", "generic")

If any banned element is found, revise the prompt and remove it.

### Step 5: Output the Tag

Output a single `[GEMINI_IMAGE:]` tag:

```
[GEMINI_IMAGE: full detailed prompt here]
```

The relay processes this tag automatically. The image will:
- Save to `data/images/` locally
- Auto-copy to OneDrive at `02_Marketing/Ad_Creative/Ad Images/`
- Send to Telegram for preview

## Examples

### Example: Lifestyle image from weight loss hook post

**Input copy:** "You step on the scale and it says the same thing it said last week. But your jeans fit different. Your energy is up. Your labs improved. That number doesn't tell the whole story..."

**Output:**
```
[GEMINI_IMAGE: Lifestyle aspiration image. A woman in her mid-40s smiling while trying on jeans in a bright bedroom, morning light through window, casual relaxed body language, Arizona home setting with warm desert light, warm natural lighting, Arizona setting, authentic candid moment, high quality, professional photography style, no watermarks, square 1:1]
```

### Example: Educational image from protein content

**Input copy:** "Your appetite tanks on GLP-1 therapy. But your protein needs don't. That's the Protein Paradox..."

**Output:**
```
[GEMINI_IMAGE: Educational informational image. A clean plate with a balanced high-protein meal, colorful vegetables and grilled chicken, on a modern kitchen counter, soft natural lighting, clean composition with space for text overlay, PV teal #6CC3E0 accent on table setting, clean minimalist infographic style, medical professional, PV teal #6CC3E0 accent, high quality, professional photography style, no watermarks, square 1:1]
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| No image generated | GEMINI_API_KEY not set | Check `.env` for GEMINI_API_KEY |
| Tag not processed | Gemini not initialized | Run `/diagnose` to check Gemini status |
| Image has banned elements | Prompt not validated | Re-read banned list in brand guide, revise prompt |
| Text in image is garbled | Gemini text rendering limits | Keep text short (3-5 words max), use Canva for text-heavy graphics |
| Wrong aspect ratio | Missing ratio in prompt | Always specify "square 1:1", "vertical 9:16", or "landscape 16:9" at end |
