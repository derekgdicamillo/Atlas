# Nano Banana / Gemini Image Generation: Definitive Prompt Engineering Reference

Last updated: 2026-03-15
Sources: Google Developers Blog, Google Cloud Vertex AI docs, Max Woolf (minimaxir), DEV.to Google AI, Kellogg Northwestern, AI SuperHub, Strataigize, Typeface, promptaa.com, AI Video Bootcamp, community research.

---

## Table of Contents

1. [Architecture and How It Works](#1-architecture-and-how-it-works)
2. [Core Prompting Principles](#2-core-prompting-principles)
3. [The Master Prompt Formula](#3-the-master-prompt-formula)
4. [Camera and Lens Language](#4-camera-and-lens-language)
5. [Lighting Techniques](#5-lighting-techniques)
6. [Composition and Framing](#6-composition-and-framing)
7. [Color Grading and Film Emulation](#7-color-grading-and-film-emulation)
8. [Texture, Materials, and Surface Detail](#8-texture-materials-and-surface-detail)
9. [Skin and Human Realism](#9-skin-and-human-realism)
10. [Anti-AI Detection: Making Images Look Real](#10-anti-ai-detection-making-images-look-real)
11. [The 5 Tells of AI Images (and How to Defeat Each)](#11-the-5-tells-of-ai-images-and-how-to-defeat-each)
12. [JSON/Structured Prompting](#12-jsonstructured-prompting)
13. [Marketing-Specific Applications](#13-marketing-specific-applications)
14. [Text Rendering](#14-text-rendering)
15. [Multi-Image and Editing Workflows](#15-multi-image-and-editing-workflows)
16. [Anti-Patterns: What to Avoid](#16-anti-patterns-what-to-avoid)
17. [Platform-Specific Dimensions](#17-platform-specific-dimensions)
18. [Complete Prompt Templates](#18-complete-prompt-templates)
19. [Quick Reference Cheat Sheet](#19-quick-reference-cheat-sheet)

---

## 1. Architecture and How It Works

Nano Banana is built on Gemini's autoregressive architecture, not diffusion. This matters:

- **32,768-token context window** for prompts (vs. CLIP's 77 or T5's 512 in diffusion models). You can write extremely detailed prompts and the model will process them.
- **"Thinking" model**: It doesn't just match keywords. It understands intent, physics, and composition. It generates interim thought images before the final output.
- **Conversational editing**: The model excels at understanding follow-up requests. If an image is 80% right, don't regenerate from scratch. Ask for the specific change.
- **Style and subject parsed separately**: Nano Banana separates content tokens from form tokens, giving finer control over each.
- **Up to 14 reference images** can be input (6 with high fidelity preservation).

### Model Versions
- **Nano Banana** (Gemini 2.5 Flash): Fast, good quality, free tier available
- **Nano Banana Pro** (Gemini 3 Pro Image): Best quality, state-of-the-art text rendering, advanced multi-image composition

---

## 2. Core Prompting Principles

### Describe Scenes, Don't List Keywords
The single most important rule. Nano Banana responds to narrative descriptions, not keyword soup.

**Bad**: `dog, park, 4k, realistic, beautiful, HDR, masterpiece`
**Good**: `A golden retriever bounding through an autumn park at golden hour, leaves swirling behind it, shot with a 50mm lens at f/2.8, warm diffused sunlight filtering through the canopy`

### Be Specific About What Matters
More details = more control. Replace vague descriptors with precise ones.

**Bad**: `fantasy armor`
**Good**: `Ornate elven plate armor, etched with silver leaf patterns, with a high collar and pauldrons shaped like falcon wings, weathered bronze finish with verdigris patina`

### Use Natural Language
Brief the model like you're directing a human photographer or artist. Full sentences work better than fragments.

### State Intent and Context
Tell the model WHY you need the image. Context shapes output quality.

**Good**: `Create a hero image for a premium skincare brand's landing page. The image needs to convey luxury, purity, and clinical efficacy.`

### ALL CAPS for Critical Requirements
Using CAPS for must-have elements improves adherence.

**Example**: `The logo text MUST read "PV MediSpa" exactly. The background MUST be pure white.`

### Use Semantic Negatives
Describe desired absence positively rather than using "no" statements (though explicit exclusions also work).

**Better**: `An empty, deserted street with no signs of traffic`
**Also works**: `Do not include any text, watermarks, or line overlays`

### Iterate, Don't Regenerate
Gemini is conversational. Start broad, then refine:
1. Generate base image
2. "Make the lighting warmer and more golden"
3. "Move the subject slightly to the left, add more negative space on the right"
4. "Add subtle film grain and reduce saturation by 15%"

---

## 3. The Master Prompt Formula

### 8-Category Framework for Photorealism

```
[Realism trigger] + [Subject] + [Camera/lens] + [Lighting] + [Texture/materials] + [Color/tone] + [Composition] + [Film grain/quality] + [Negative instructions]
```

### Example Using the Formula

```
Ultra-realistic cinematic photography of a 35-year-old woman in a modern medical spa consultation room, shot on Canon EOS R5 with 85mm f/1.4 lens creating natural bokeh, soft diffused natural window light from camera-left with subtle warm fill from LED panels, visible skin pores and natural makeup texture with slight under-eye shadows, muted warm tones with teal-and-amber color grade, rule of thirds composition with subject at left power point and negative space right, subtle Kodak Portra 400 film grain with sharp focus on eyes. No cartoon, no plastic skin, no CGI, no 3D render, no perfect symmetry.
```

### Simplified Formula for Quick Use

```
[Image type] of [subject with specific details], [camera/lens], [lighting], [composition], [mood/style]. [Exclusions].
```

---

## 4. Camera and Lens Language

Camera language is one of the strongest control mechanisms. The model has learned what different lenses and cameras produce.

### Lens Focal Lengths

| Focal Length | Effect | Best For |
|---|---|---|
| 14-24mm | Extreme wide, dramatic distortion | Architecture, landscapes, environmental |
| 24-35mm | Wide angle, natural perspective | Environmental portraits, interiors |
| 35mm | Most natural realism, documentary feel | Street photography, lifestyle |
| 50mm | Human eye perspective, neutral | General purpose, natural look |
| 85mm | Classic portrait compression, beautiful bokeh | Headshots, beauty, product hero |
| 100-200mm | Telephoto compression, flat background | Product detail, compressed scenes |
| Macro | Extreme close-up, surface detail | Product texture, ingredient shots |

### Camera References That Work

- `shot on Canon EOS R5 with 85mm f/1.4 lens` - clean, sharp, modern
- `shot on Hasselblad 500C` - medium format, ultra-detailed, editorial
- `shot on Leica M6 with 35mm Summicron` - street photography character
- `shot on iPhone 15 Pro` - casual, authentic UGC aesthetic
- `Canon 5D Mark IV with 85mm f/1.4 lens` - classic portrait
- `Sony A7III with 24-70mm f/2.8` - versatile, modern

### Aperture and Depth of Field

- `f/1.4` or `f/1.8` - extremely shallow DOF, heavy bokeh, subject isolation
- `f/2.8` - moderate bokeh, good subject separation
- `f/5.6` - balanced, some background detail
- `f/8-f/11` - deep focus, everything sharp (product, architecture)
- `shallow depth of field with natural bokeh` - when you want blur without specifying exact f-stop

### Shot Types

- `extreme close-up` / `macro shot` - surface detail, texture
- `close-up` - face, product hero
- `medium shot` - waist up, product in context
- `full body shot` - complete figure, fashion
- `wide shot` / `establishing shot` - environment, scene-setting
- `overhead shot` / `top-down` / `bird's eye` - flat lays, food
- `low-angle shot` / `worm's eye` - power, authority, dramatic
- `Dutch angle` / `tilted frame` - tension, energy, creative
- `over-the-shoulder` - perspective, context
- `45-degree elevated angle` - product photography standard

---

## 5. Lighting Techniques

Lighting is the single strongest signal for realism. Without clear lighting instructions, images look flat or unnatural.

### Natural Light

| Term | Effect | When to Use |
|---|---|---|
| `golden hour sunlight` | Warm, directional, long shadows | Lifestyle, portrait, outdoor |
| `soft natural window light` | Diffused, flattering, directional | Interior, portrait, product |
| `overcast daylight` | Even, soft, no harsh shadows | Product, editorial |
| `pre-dawn violet light` | Cool, moody, atmospheric | Mood pieces, cinematic |
| `dappled sunlight through leaves` | Organic, natural, dynamic | Outdoor lifestyle |
| `harsh midday sun` | High contrast, defined shadows | Dramatic, fashion |
| `backlit with sun flare` | Ethereal, dreamy, halo effect | Beauty, aspirational |

### Studio Light

| Term | Effect | When to Use |
|---|---|---|
| `three-point softbox lighting` | Professional, even, controlled | Product, headshot |
| `Rembrandt lighting` | Triangle shadow on cheek, dramatic | Portrait, clinical authority |
| `butterfly lighting` | Shadow under nose, beauty standard | Beauty, cosmetic |
| `rim light` / `edge light` | Subject separation, dimension | Product hero, portrait |
| `soft 45-degree key light` | Flattering, dimensional, natural | General portrait |
| `studio softbox with subtle rim light` | Clean, professional | Product, clinical |
| `ring light` | Even face lighting, catchlights | Beauty, selfie-style |
| `side lighting with soft shadows` | Texture revelation, dimension | Product detail |

### Mood Lighting

| Term | Effect | When to Use |
|---|---|---|
| `moody shadows` | Dark, atmospheric, dramatic | Cinematic, editorial |
| `dramatic backlighting` | Silhouette, separation | Creative, mood |
| `warm LED panels` | Modern interior, clinical warmth | Med spa, clinic |
| `neon ambiance` | Urban, energetic, nightlife | Social media, youth |
| `candlelight` | Intimate, warm, textured | Wellness, relaxation |
| `diffuse 3PM lighting` | Neutral, realistic, documentary | Authentic lifestyle |

### Lighting Physics for Realism

Always specify:
1. **Direction**: Where light comes from (`from camera-left`, `from above`, `backlighting`)
2. **Quality**: Hard or soft (`diffused`, `direct`, `soft`)
3. **Color temperature**: Warm or cool (`3200K warm`, `5600K daylight`, `cool blue`)
4. **Intensity**: Bright or subdued (`subtle`, `dramatic`, `bright`)
5. **Secondary light**: Fill, bounce, ambient (`with warm fill from a reflector`)

---

## 6. Composition and Framing

### Composition Rules to Reference

- `rule of thirds` - subject at intersection points
- `centered composition` - symmetrical, powerful
- `negative space on the right for text overlay` - marketing layouts
- `leading lines` - draw eye to subject
- `framing within frame` - doorways, windows, arches
- `foreground and background separation` - depth, dimension
- `symmetrical composition` - formal, authoritative
- `diagonal composition` - energy, movement

### Marketing-Specific Composition

- `wide, breathable composition with strong focal subject on one side and empty space on the other` - landing page hero
- `bold central subject breaking the frame, partially cropped as if mid-motion` - scroll-stopping social
- `clean, professional scene with negative space for text, single symbolic object aligned left, calm gradients` - B2B LinkedIn
- `product positioned bottom-right with vast empty space above` - ad with headline space

### Aspect Ratios

Always specify. Default aspect ratios cause cropping problems on platforms.

- `1:1` - Instagram feed, Facebook feed
- `4:5` - Instagram feed (preferred), Facebook feed
- `9:16` - Stories, Reels, TikTok
- `16:9` - YouTube thumbnails, website hero
- `2.39:1` - Cinematic widescreen
- `3:4` - Pinterest
- When editing, the output generally preserves the input image's ratio
- For new images, provide a reference image with correct dimensions as an alternative to prompting the ratio

---

## 7. Color Grading and Film Emulation

### Film Stock References

The model has learned to associate film stocks with specific color palettes, contrast levels, and grain structures.

| Film Stock | Look | Best For |
|---|---|---|
| `Kodak Portra 400` | Warm skin tones, soft contrast, muted pastels | Portraits, lifestyle, beauty |
| `Kodak Portra 800` | Slightly more grain, warm, versatile | Indoor lifestyle, events |
| `Kodak Gold 200` | Saturated, warm, nostalgic | Lifestyle, outdoor, casual |
| `Fujifilm Superia 400` | Cooler tones, greens pop, everyday feel | Casual, documentary |
| `Fujifilm Pro 400H` | Soft pastels, delicate, ethereal | Weddings, beauty, soft lifestyle |
| `Cinestill 800T` | Tungsten balance, red halation around lights | Night scenes, moody, urban |
| `Kodak Ektar 100` | Vivid, saturated, fine grain | Product, landscape, punchy |
| `Ilford HP5` | Black and white, medium grain, versatile | Editorial, dramatic |
| `Kodak Tri-X 400` | Black and white, classic grain, high contrast | Documentary, street |
| `Kodak 5219 (Vision3)` | Cinema film, rich, cinematic | Cinematic look, narrative |

### Color Grade Descriptors

- `teal-and-amber color grade` - cinematic, modern
- `muted warm tones` - editorial, refined
- `pastel color palette` - soft, feminine, beauty
- `high-contrast noir look` - dramatic, editorial
- `bleach bypass` - desaturated, high contrast, gritty
- `cross-processed` - unexpected color shifts, creative
- `natural color grading` - realistic, unprocessed look
- `soft highlights and deep shadows` - cinematic depth
- `desaturated earth tones` - organic, natural, grounded
- `cool blue shadows with warm highlights` - split-tone look

### Hex Color Codes

Use specific hex values for precise color control: `#9F2B68` is more accurate than "dark pink."

---

## 8. Texture, Materials, and Surface Detail

### Material Descriptors for Realism

**Skin**: `visible pores`, `natural skin texture`, `subtle freckles`, `slight blemishes`, `natural oil sheen`, `micro-expressions`

**Fabric**: `visible thread count`, `natural drape with gravity`, `faded patches`, `frayed edges`, `cotton-silk blend texture`, `linen wrinkles`

**Leather**: `full-grain leather with visible grain`, `weathered patina`, `cracked aging`, `stitching detail`, `natural wear patterns`

**Metal**: `brushed stainless steel`, `tarnished brass`, `oxidation rust streaks`, `polished chrome reflection`, `matte aluminum finish`

**Wood**: `natural oak grain with knots`, `weathered driftwood texture`, `lacquered mahogany`, `raw pine with visible rings`

**Glass**: `subtle fingerprints on glass`, `light refraction`, `condensation droplets`, `frosted glass diffusion`

**Stone**: `marble veining`, `rough granite texture`, `smooth river stone`, `concrete with aggregate visible`

### Surface Imperfections (Critical for Realism)

This is arguably the single highest-impact technique for defeating the AI look:

- `slight scratches and wear marks`
- `dust particles visible in light`
- `fingerprints on surfaces`
- `natural aging and patina`
- `paint chips and weathering`
- `water stains and mineral deposits`
- `irregular surfaces, not perfectly smooth`

---

## 9. Skin and Human Realism

The biggest giveaway of AI-generated faces is skin. It defaults to too-perfect, too-smooth, waxy texture.

### Skin Realism Keywords

**Must include** (pick 3-5 per prompt):
- `visible pores`
- `natural skin texture with micro-details`
- `subtle freckles` or `slight blemishes`
- `natural oil sheen` (not matte, not glossy)
- `under-eye shadows` or `natural under-eye circles`
- `slight skin redness` or `natural blush`
- `fine facial hair` or `peach fuzz`
- `natural lip texture with slight chapping`
- `realistic facial proportions`
- `asymmetrical features` (real faces are never perfectly symmetrical)

### What to Avoid in Skin Rendering

- `perfect porcelain skin` - looks like a mannequin
- `airbrushed` - defeats realism
- `flawless complexion` - triggers the AI smoothing
- `ultra-smooth skin` - plastic look
- No skin descriptors at all (defaults to waxy)

### Eyes

Eyes are the hardest to get right and the first thing people notice:
- `natural catchlight reflection in eyes` - looks alive
- `round pupils with realistic iris detail`
- `slight redness in sclera` - life sign
- `natural eye moisture and reflection`
- Avoid: hollow gaze, misaligned pupils, glass-like eyes

### Hands

Still the most notorious AI weakness:
- `anatomically correct hands with five fingers`
- `natural hand pose with realistic finger proportions`
- `visible knuckle detail and nail texture`
- When possible, compose shots to minimize hand visibility or use natural obscuring (holding objects, pockets, crossed)

### Hair

- `individual hair strands visible`
- `natural hair texture with flyaways`
- `realistic hair shine and shadow`
- Avoid: hair that looks like a solid mass or helmet

---

## 10. Anti-AI Detection: Making Images Look Real

### The 7 Keywords for Defeating AI Tells

Based on promptaa.com research, these 7 categories make the biggest difference:

#### 1. Photographic Style Keywords
Specify actual cameras and lenses. The model replicates their optical characteristics.
```
shot on Canon EOS R5 with 85mm f/1.4 lens, natural bokeh
```

#### 2. Negative Prompts for Artificial Elements
Explicitly exclude AI artifacts:
```
No plastic skin, no glossy surfaces, no artificial lighting, no extra limbs, no 3D render, no oversaturated colors, no unnatural symmetry
```

#### 3. Natural Imperfection Keywords
Real world is never perfect. Request flaws:
```
weathered face, slight asymmetry, natural skin texture, chipped paint, cracked pavement, overgrown plants, dust on surfaces
```

#### 4. Environmental Context Integration
Ground subjects in richly described, cohesive settings:
```
dusty windows, steam rising from a coffee cup, mismatched decor items, golden hour shadows falling across the desk, scuff marks on hardwood floor
```

#### 5. Material and Texture Specificity
Precise material properties trigger realistic rendering:
```
full-grain leather with visible grain, brushed stainless steel, sun-bleached cotton, tarnished brass hardware, satin sheen fabric
```

#### 6. Candid Moment and Expression Keywords
Override AI's tendency toward idealized, posed subjects:
```
caught mid-stride, genuine laughter, natural expression, unaware of camera, candid conversation, looking away from camera
```

#### 7. Film Photography and Analog References
Introduce organic texture that breaks the digital smoothness:
```
Kodak Portra 400, 35mm film, subtle high grain, light leak on right edge, medium-format Hasselblad look
```

### Post-Processing Descriptors for Realism

Adding analog post-processing cues removes the digital perfection:

- `subtle film grain` - breaks up smooth gradients
- `sensor noise in shadows` - realistic camera behavior
- `slight lens vignette` - natural optical falloff
- `chromatic aberration at edges` - real lens artifact
- `slight motion blur on extremities` - life, movement
- `natural lens flare from backlight` - optical realism
- `soft halation around highlights` - film characteristic
- `slight barrel distortion` - wide-angle lens reality
- `color fringing on high-contrast edges` - real optics

---

## 11. The 5 Tells of AI Images (and How to Defeat Each)

Based on Kellogg Northwestern research:

### Tell 1: Anatomical Implausibilities
**What detectors look for**: Extra/missing fingers, asymmetrical teeth, distorted eyes, unnaturally long necks, merged body parts.
**How to defeat**: Include `anatomically correct` descriptors. Specify `five fingers on each hand`, `natural body proportions`. Review output and use iterative editing to fix. Hide hands when possible.

### Tell 2: Stylistic Artifacts
**What detectors look for**: Waxy skin, over-perfection, lighting mismatch between foreground and background, smudgy patches, backgrounds assembled from different scenes.
**How to defeat**: Use film stock references for organic texture. Include `visible pores`, `natural imperfections`, `consistent lighting across entire scene`. Specify `unified light source` and `coherent background`.

### Tell 3: Functional Implausibilities
**What detectors look for**: Objects that don't work realistically. Text errors, impossible object interactions (hands inside objects), defying physics (stiff fabrics, floating objects).
**How to defeat**: Describe functional relationships explicitly. `Hand wrapped around the coffee cup handle`, not just `holding a cup`. Verify text rendering. Use multi-turn editing to fix functional errors.

### Tell 4: Violations of Physics
**What detectors look for**: Shadows at impossible angles, reflections showing wrong content, impossible perspectives, floating elements.
**How to defeat**: Specify light direction and shadow behavior. `Single light source from upper-left, consistent shadows falling to lower-right`. Include `physically accurate reflections` and `gravity-correct draping`.

### Tell 5: Sociocultural Implausibilities
**What detectors look for**: Culturally incorrect gestures, anachronistic elements, unlikely scenarios.
**How to defeat**: Be culturally specific in prompts. Include time period, location, and cultural context details.

### Technical Detection Markers
AI forensics tools also look for:
- **Frequency domain artifacts**: AI images have unnaturally perfect high-frequency patterns. Film grain disrupts this.
- **Noise distribution**: Real cameras have sensor noise that follows specific patterns. Adding `sensor noise in shadows` helps.
- **Metadata**: AI images lack EXIF data. If posting, consider adding post-processing steps that add metadata.

---

## 12. JSON/Structured Prompting

JSON prompting improves task accuracy by 60-80% for complex multi-detail requests. Use it when you need precision and repeatability.

### Basic JSON Schema

```json
{
  "task": "generate_image",
  "style": {
    "primary": "photorealistic",
    "rendering_quality": "8K ultra-detailed"
  },
  "technical": {
    "camera": {
      "model": "Canon EOS R5",
      "focal_length": "85mm",
      "aperture": "f/1.4",
      "depth_of_field": "shallow with natural bokeh"
    },
    "resolution": "8K",
    "color_depth": "10-bit HDR"
  },
  "material": {
    "skin": {
      "details": ["visible pores", "natural oil sheen", "subtle freckles"],
      "condition": "healthy with slight natural blush"
    }
  },
  "environment": {
    "atmosphere": "soft morning light",
    "lighting": {
      "type": "natural window light",
      "direction": "45-degree from camera-left",
      "color_temperature": "warm golden"
    },
    "particles": "dust motes visible in light beam"
  },
  "composition": {
    "framing": "rule of thirds",
    "angle": "eye level",
    "negative_space": "right side for text overlay"
  },
  "quality": {
    "include": ["natural lighting", "photographic depth", "authentic textures"],
    "avoid": ["plastic skin", "oversaturated colors", "3D render look", "perfect symmetry"]
  }
}
```

### Full Schema Dimensions

The open-source Gemini Image Prompting Handbook (github.com/pauhu/gemini-image-prompting-handbook) organizes prompts across 7 schema categories:

1. **Core**: Task type, subject, basic parameters
2. **Style**: Aesthetic direction, rendering quality, medium
3. **Technical**: Camera, resolution, color depth, rendering settings
4. **Materials**: Surface textures, skin, fabric, metal, glass properties
5. **Environment**: Atmosphere, temporal setting, particles, weather
6. **Composition**: Framing, spatial arrangement, aspect ratio
7. **Quality**: Positive inclusions and negative exclusions

### Lighting Object (JSON)

```json
"lighting": {
  "type": "soft natural daylight with diffused clouds",
  "direction": "side-lit 45 degrees from camera-left",
  "mood": "warm, inviting",
  "time_of_day": "golden hour",
  "intensity": 0.7,
  "color_temperature": "3800K warm"
}
```

### Skin Definition (JSON)

```json
"skin": {
  "details": [
    "visible pores at 0.1mm scale",
    "natural oil sheen with 5% gloss",
    "subtle freckles 2-3mm scattered",
    "slight under-eye shadows",
    "fine peach fuzz on cheeks"
  ],
  "condition": "healthy with natural blush",
  "avoid": ["plastic smoothness", "airbrushed perfection", "waxy texture"]
}
```

### When to Use JSON vs. Natural Language

| Scenario | Use |
|---|---|
| Brainstorming, experimenting | Natural language |
| Multiple precise details needed | JSON |
| Repeatability across variations | JSON |
| Quick one-off generation | Natural language |
| A/B test variations with one variable changed | JSON |
| Character consistency across images | JSON |
| Production pipeline automation | JSON |

### Best Practices for JSON Prompting

- Maximum 5 levels of nesting (deeper risks token overflow and drift)
- Keep keys descriptive and clear (vague keys cause drift)
- Validate JSON before sending (JSONLint, VS Code, Python json module)
- Start in natural language to find what works, then convert to JSON for production
- 1280 tokens per output maximum

---

## 13. Marketing-Specific Applications

### Ad Creative (Facebook/Instagram)

**Scroll-stopping feed ad**:
```
A confident woman in her 40s walking out of a modern medical spa with a genuine smile, natural posture, shot candidly from across the street with a 50mm lens, soft afternoon sunlight, visible skin texture with slight laugh lines, wearing casual-elegant athleisure, muted warm earth tones, slight film grain, 4:5 aspect ratio with negative space at top for headline text. No posed model look, no plastic skin, no stock photo feel.
```

**Product hero for weight loss ad**:
```
Overhead flat-lay photograph of a body composition scale on white marble surface, surrounded by a measuring tape loosely coiled, a glass of water with lemon, and a small notebook, soft natural window light from camera-left, clean minimalist composition, negative space at bottom for CTA, sharp focus with shallow depth of field on the scale display, Kodak Ektar 100 color science. 1:1 aspect ratio.
```

**Before/After split concept**:
```
A single scene split vertically down the center. Left side: a tired-looking person in dim, gray-toned lighting, slouched posture, muted desaturated colors. Right side: the same person energized, standing tall, warm golden-hour lighting, vibrant but natural colors, genuine confident smile. Both sides shot with same 85mm lens perspective, consistent background. Clean divide line. No text. 4:5 aspect ratio.
```

**Important legal note**: AI before/after images require disclosure. Use "AI-enhanced visualization" or "Digitally created representation." Never pass off AI images as real patient results.

### Landing Page Hero Images

```
Wide-angle interior photograph of a modern, warm medical spa reception area, natural light flooding through floor-to-ceiling windows, clean contemporary furniture in warm neutrals, a single orchid on the reception desk, no people, soft focus on background with sharp foreground detail, shot on Sony A7III with 24mm lens at f/8, warm ambient lighting complementing natural light, breathable composition with strong focal point left and open space right for text overlay. 16:9 aspect ratio.
```

### Social Media Lifestyle

```
Candid lifestyle photograph of a woman in her 30s checking her phone with a satisfied expression while walking past a modern wellness clinic, natural street lighting, captured mid-stride with slight motion blur on her hair, 35mm documentary style, Kodak Portra 400 warm skin tones, environmental context including blurred clinic signage, genuine unstaged moment feel. 1:1 aspect ratio.
```

### Product Photography

**Clinical/Clean style**:
```
Studio product photograph of three medical-grade skincare bottles arranged in descending height order on a clean white surface, three-point softbox lighting with subtle rim light defining the bottle edges, 45-degree elevated camera angle, shot on Canon 5D Mark IV with 100mm macro lens at f/8 for full sharpness, subtle reflection on surface, ultra-clean white background, no shadows, professional e-commerce photography style. 1:1 aspect ratio.
```

**Lifestyle product style**:
```
A GLP-1 injection pen resting naturally on a bathroom counter next to a coffee mug and a journal, soft morning window light from camera-right creating gentle shadows, shallow depth of field with the pen in sharp focus, warm residential interior, lived-in authentic environment with slight clutter, Fujifilm Pro 400H color palette, 4:5 aspect ratio.
```

### Flat Lay Photography

```
Overhead flat-lay photograph of a wellness routine arrangement on natural linen fabric: a small amber supplement bottle, a measuring tape loosely coiled, a green smoothie in a clear glass, a pen and journal, and fresh berries scattered naturally. Soft diffused natural daylight from above, slight shadows for depth, warm earthy color palette, editorial styling with intentional but relaxed placement, shot on Hasselblad with 80mm lens. 1:1 aspect ratio.
```

### Email Campaign Headers

```
A minimalist composition featuring a single dropper bottle of serum on a marble surface, positioned in the lower-left third, vast clean white space occupying the upper-right two-thirds for text placement, soft side lighting creating a gentle shadow, sharp product focus, premium feel, understated luxury. 3:1 wide banner aspect ratio.
```

### Testimonial/Social Proof Visual

```
Close-up portrait photograph of a real-looking woman in her 50s with natural silver-streaked hair, genuine warm smile with visible laugh lines, natural skin texture with visible pores and slight sun spots, soft Rembrandt lighting from camera-left, warm neutral background with slight bokeh, shot on 85mm portrait lens at f/2.0, Kodak Portra 400 skin tones, candid expression as if caught mid-conversation. No retouching look, no stock photo perfection. 1:1 aspect ratio.
```

---

## 14. Text Rendering

Nano Banana Pro has state-of-the-art text rendering. Key techniques:

### Best Practices
- **Quote the exact text** you want rendered in the prompt
- **Specify font style**: serif, sans-serif, script, bold, etc.
- **Describe placement**: centered, upper-left, along bottom edge
- **Define size relationship**: large headline, small tagline
- **Specify color and contrast**: white text on dark background

### Example
```
A minimalist poster design with the text "TRANSFORM YOUR HEALTH" in bold, modern sans-serif font centered on a gradient background transitioning from deep navy to warm gold, with smaller text "PV MediSpa" in elegant thin serif font below. Clean typography, no other elements.
```

### Limitations
- Small text and fine detail text may still have errors
- Always verify text accuracy before publishing
- Multi-line text works but verify each line
- Non-English text may have grammar/cultural issues

---

## 15. Multi-Image and Editing Workflows

### Character Consistency Across Images

1. Use explicit character descriptions repeated across prompts
2. Upload a reference headshot and specify `keep facial features identical to the reference image`
3. Describe distinctive features (face shape, eye color, hairstyle) consistently
4. Use the same lighting and color grade for series cohesion

### Style Transfer

```
Transform this photograph into the style of [artist/movement] while preserving the exact composition, subject positioning, and spatial relationships
```

### Adding/Removing Elements

```
Add a potted succulent plant on the right side of the desk, matching the existing lighting direction and color temperature of the scene
```

### Inpainting (Targeted Edits)

```
Replace only the background behind the person with a modern office interior, keeping the subject and their lighting completely unchanged
```

### Multi-Image Composition

Nano Banana Pro supports up to 14 input images. Use cases:
- Combine product + lifestyle background
- Place person into new environment
- Merge brand elements with scene

### Editing Workflow Best Practice

1. Generate base image with core requirements
2. Review for major issues (composition, subject, lighting)
3. Make specific conversational edits: "make the background slightly out of focus"
4. Address details: "add visible skin texture, reduce the artificial smoothness"
5. Final polish: "add subtle film grain, slight lens vignette"

---

## 16. Anti-Patterns: What to Avoid

### Prompt Anti-Patterns

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Keyword soup | `beautiful, 8k, HDR, masterpiece, best quality, ultra detailed` | Describe the scene narratively |
| Contradictory styles | `photorealistic watercolor painting` | Choose one primary style |
| Too many competing elements | 15+ subjects in one scene | Focus on 1-3 key elements |
| Vague composition | No spatial guidance | Specify rule of thirds, negative space, etc. |
| Missing lighting | No light direction/quality | Always specify light source and quality |
| Oversaturated color requests | `vibrant neon hyper-saturated` | Use `natural`, `muted`, or film stock reference |
| Perfect everything | `flawless, perfect, ideal` | Add imperfections for realism |
| Prompt copying from internet | Long "prompt salad" pasted from forums | Write your own specific description |
| Too many modifiers | Redundant quality words stacked up | Focus on 3 core elements |
| Missing aspect ratio | Default ratio causes cropping | Always specify ratio for platform |

### Image Quality Anti-Patterns

| Problem | Cause | Fix |
|---|---|---|
| Plastic/waxy skin | No skin texture descriptors | Add `visible pores`, `natural skin texture` |
| Uncanny valley eyes | No eye detail specification | Add `natural catchlight`, `round pupils` |
| Stock photo feeling | Generic pose + perfect lighting | Use `candid`, `mid-conversation`, film stock |
| Flat lighting | No light direction specified | Add directional lighting with shadows |
| Over-sharpened | Excessive quality keywords | Use `natural`, remove redundant quality terms |
| AI-smooth gradients | No texture interruption | Add `film grain`, `sensor noise in shadows` |
| Impossible shadows | No light source consistency | Specify single unified light source |
| Fantasy/illustration drift | Vague or flowery language | Use photographic terminology throughout |
| Too-perfect symmetry | Default AI tendency | Specify `natural asymmetry`, `candid positioning` |
| Floating objects | No physics grounding | Describe physical relationships to surfaces |

### Common Mistakes by Frequency

1. **55.7% of users** have aspect ratio problems (specify every time)
2. **73.4% of failed images** come from style inconsistency (pick one direction)
3. **41% first-try failure rate** from prompt ambiguity (be specific)
4. **39% of attempts** retain unwanted elements because of missing negative prompts

---

## 17. Platform-Specific Dimensions

### Social Media Formats

| Platform | Format | Aspect Ratio | Prompt Addition |
|---|---|---|---|
| Instagram Feed | Square/Portrait | 1:1 or 4:5 | `4:5 vertical aspect ratio` |
| Instagram Stories/Reels | Vertical | 9:16 | `9:16 vertical full-screen` |
| Facebook Feed | Landscape/Square | 16:9 or 1:1 | `1:1 square aspect ratio` |
| Facebook Ad | Portrait preferred | 4:5 | `4:5 portrait aspect ratio` |
| YouTube Thumbnail | Landscape | 16:9 | `16:9 wide landscape` |
| TikTok | Vertical | 9:16 | `9:16 vertical mobile` |
| LinkedIn | Landscape | 1.91:1 | `1.91:1 wide landscape` |
| Pinterest | Tall portrait | 2:3 | `2:3 tall portrait` |
| Website Hero | Wide | 16:9 or 3:1 | `16:9 wide hero banner` |
| Email Header | Wide banner | 3:1 or 2:1 | `3:1 wide banner` |
| Google Ads Display | Various | 1.91:1 | `landscape 1.91:1` |

---

## 18. Complete Prompt Templates

### Template 1: Clinical Authority Shot
```
Professional photograph of a medical provider in a white coat consulting with a patient across a modern desk in a bright, contemporary clinic. Natural window light from camera-right, supplemented by warm overhead LED panels. Provider is mid-explanation with a confident, empathetic expression. Patient shown from behind, slightly out of focus. Shot on Canon EOS R5 with 35mm f/2.0 lens. Visible skin texture on provider's face, natural under-eye shadows, slight asymmetry in facial features. Clean, organized clinic with potted plants and modern decor visible in background bokeh. Warm, professional color palette. Subtle Kodak Portra 400 film characteristics. 16:9 aspect ratio. No stock photo perfection, no plastic skin, no posed model stance.
```

### Template 2: Weight Loss Transformation Concept
```
Split-screen lifestyle photograph showing the same woman in two scenes divided by a clean vertical line. Left: sitting on a couch in dim, cool-toned lighting, wearing oversized loungewear, low-energy posture, cluttered coffee table. Right: the same woman outdoors in morning golden hour light, wearing fitted activewear, mid-stride on a walking path, energized expression, vibrant but natural warm colors. Both sides shot with consistent 50mm perspective. Natural skin texture on both sides. Real, authentic feel, not fitness model perfection. 4:5 aspect ratio. No CGI, no 3D render, no stock photo.
```
*Disclosure required: "AI-generated visualization. Individual results may vary."*

### Template 3: Product Flat Lay
```
Overhead flat-lay photograph on a light grey linen surface. Center: a sleek white supplement bottle with clean label design. Surrounding: loose measuring tape, a small ceramic bowl of mixed berries, two capsules placed casually, a sprig of fresh rosemary, and a glass of water with a lemon slice. Soft, diffused natural daylight from directly above with subtle shadows. Clean, editorial styling with intentional asymmetry in placement. Shot on Hasselblad 500C with 80mm lens at f/5.6. Warm, muted color palette with pops of berry red and herb green. Negative space in upper-right for text. 1:1 aspect ratio.
```

### Template 4: Testimonial Portrait
```
Natural portrait photograph of a genuinely smiling woman in her mid-40s with shoulder-length brown hair, wearing a simple v-neck top, photographed in a bright, modern space. Soft Rembrandt lighting from camera-left window, creating a gentle triangle shadow on the right cheek. Visible crow's feet and laugh lines around eyes. Natural skin with pores visible, slight forehead lines, no makeup or very light natural makeup. Eyes with natural catchlight and genuine warmth. Background: bright, blurred interior with warm tones. Shot on 85mm f/1.8 lens. Kodak Portra 400 color science. Candid, mid-laugh expression. 1:1 aspect ratio. No retouching, no airbrushing, no plastic skin, no perfect symmetry.
```

### Template 5: Clinic Interior for Website
```
Interior architecture photograph of a modern medical spa waiting area. Clean lines, warm wood accents, white walls with subtle texture, comfortable modern seating in neutral fabrics, a live-edge wooden reception desk, soft indirect lighting from recessed panels and natural window light, a few green plants, calming artwork on walls. No people. Shot on Sony A7III with 16-35mm f/4 lens at 24mm, eye-level perspective, leading lines from reception desk drawing eye into the space. Warm, inviting color temperature around 4000K. Clean and clinical but not sterile. Magazine-quality interior photography. 16:9 aspect ratio.
```

### Template 6: Social Media Story (Vertical)
```
Vertical lifestyle photograph of a person's hand holding a green smoothie in a clear glass, with a modern kitchen counter visible in the background. Soft morning window light creating gentle shadows. Shallow depth of field with smoothie in sharp focus and background blurred. Natural hand with visible knuckles and realistic skin texture. Condensation droplets on the glass. Warm, inviting tones with green and neutral palette. Shot from slightly above with iPhone-like perspective. Authentic, unstaged feel. 9:16 vertical aspect ratio.
```

### Template 7: Facebook Ad (Weight Loss)
```
Environmental portrait of a real-looking woman in her 30s standing in a sunlit park, wearing comfortable athletic wear, holding a reusable water bottle at her side. Natural golden hour backlight creating a warm rim light around her hair. Confident, relaxed posture, genuine soft smile, looking slightly past camera. Natural skin with visible texture, slight sun-kissed coloring, wind-tousled hair with flyaways. Background: blurred trees and walking path with other people visible as soft shapes. 50mm lens perspective with f/2.8 aperture. Kodak Gold 200 warm color science. Documentary lifestyle feel, not fitness advertisement. 4:5 aspect ratio with negative space above for headline. No stock photo pose, no plastic skin, no gym setting.
```

---

## 19. Quick Reference Cheat Sheet

### Realism Boosters (add 3-5 per prompt)
- `visible pores and natural skin texture`
- `slight imperfections and asymmetry`
- `Kodak Portra 400` (or other film stock)
- `subtle film grain`
- `sensor noise in shadows`
- `candid, natural expression`
- `shot on [specific camera] with [specific lens]`
- `natural environmental context with lived-in details`

### Realism Killers (exclude explicitly)
- `No plastic skin, no airbrushed look`
- `No CGI, no 3D render`
- `No perfect symmetry`
- `No oversaturated colors`
- `No stock photo pose`
- `No cartoon or illustration style`
- `No artificial lighting patterns`
- `No extra fingers or limbs`

### Prompt Structure Reminder
1. Image type and realism trigger
2. Subject with specific details
3. Camera and lens
4. Lighting (direction, quality, color temp)
5. Texture and material details
6. Color grading or film stock
7. Composition and framing
8. Film grain and post-processing
9. Aspect ratio
10. Negative exclusions

### Quick Lighting Presets
- **Warm clinical**: `soft LED panel lighting at 4000K with natural window light fill`
- **Golden hour portrait**: `low-angle golden hour sunlight from camera-left, warm fill from reflector`
- **Clean product**: `three-point softbox lighting with subtle rim light on edges`
- **Moody editorial**: `single dramatic side light with deep shadows, warm 3200K`
- **Bright lifestyle**: `overcast daylight, soft even illumination, no harsh shadows`

### Quick Style Presets
- **Editorial clean**: `Fujifilm Pro 400H, muted tones, minimal post-processing`
- **Warm authentic**: `Kodak Portra 400, warm skin tones, slight grain`
- **Cinematic**: `teal-and-amber grade, Kodak 5219, subtle lens flare`
- **Clinical premium**: `neutral daylight, clean whites, minimal grain, sharp throughout`
- **Nostalgic lifestyle**: `Kodak Gold 200, warm saturated, visible film grain, light leak`

---

## Appendix A: Useful Resources

- **Open-source JSON Schema**: github.com/pauhu/gemini-image-prompting-handbook
- **Google Official Guide**: developers.googleblog.com (Gemini 2.5 Flash image generation)
- **Google Cloud Vertex AI**: cloud.google.com/vertex-ai/generative-ai/docs/image/img-gen-prompt-guide
- **Max Woolf's Research**: minimaxir.com/2025/11/nano-banana-prompts/
- **Nano Banana Pro Tips**: blog.google/products/gemini/prompting-tips-nano-banana-pro/

## Appendix B: PV MediSpa Prompt Library

Use these as starting points, customize per campaign need. Always verify text rendering, check hands, and review skin texture before publishing.

### Brand Constants
- **Clinic name**: PV MediSpa and Weight Loss (or PV MediSpa)
- **Color palette**: Warm neutrals, deep teal accents, gold/amber touches
- **Mood**: Clinical authority meets warm approachability
- **Target demo**: Women 30-55, health-conscious, results-driven
- **Avoid**: Generic stock photo feel, overly clinical/sterile, fitness bro aesthetic
- **Disclosure**: All AI-generated patient-facing images require "AI-generated visualization" disclosure

### Rotation Ideas by Content Pillar
1. **Precision Weight Science**: Scale close-ups, body comp visuals, progress tracking flat lays
2. **Nourishing Health**: Food flat lays, hydration lifestyle, supplement product shots
3. **Dynamic Movement**: Outdoor walking/movement, gym-free exercise, active lifestyle
4. **Mindful Wellness**: Calm spaces, meditation corners, stress-relief visuals
5. **Functional Wellness**: Clinical authority shots, lab/science aesthetic, ingredient close-ups
