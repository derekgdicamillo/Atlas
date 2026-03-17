/**
 * Gemini JSON Prompt Schema — "Nano Banana 2" structured prompting
 *
 * Realism-first prompt builder. Uses research-backed techniques from the
 * Nano Banana Prompt Engineering Guide (memory/marketing/nano-banana-prompting-guide.md):
 * - 8-category Master Formula (realism trigger, subject, camera/lens, lighting, texture, color, composition, grain, negatives)
 * - Anti-AI detection defeat (Kellogg Northwestern 5 tells)
 * - Film stock color science for organic texture
 * - Directional lighting with physics
 * - Skin realism auto-injection for people shots
 * - Surface imperfection keywords to break digital smoothness
 */

// ============================================================
// TYPES
// ============================================================

export type ImageCategory = "lifestyle" | "educational" | "authority" | "offer" | "community";

export type AspectRatio = "1:1" | "9:16" | "16:9" | "4:5" | "2:3" | "3:1";

export type CameraAngle =
  | "eye-level"
  | "low-angle"
  | "high-angle"
  | "birds-eye"
  | "dutch-angle"
  | "over-the-shoulder"
  | "close-up"
  | "extreme-close-up"
  | "wide-shot"
  | "medium-shot";

export type LightingStyle =
  | "natural-window"
  | "golden-hour"
  | "soft-diffused"
  | "clinical-bright"
  | "warm-ambient"
  | "backlit"
  | "studio-key"
  | "overcast-even"
  | "candlelight"
  | "arizona-desert"
  | "rembrandt"
  | "butterfly"
  | "rim-light"
  | "side-light";

export type CompositionRule =
  | "rule-of-thirds"
  | "centered"
  | "leading-lines"
  | "negative-space"
  | "symmetrical"
  | "frame-within-frame"
  | "diagonal"
  | "golden-ratio";

export type StylePreset =
  | "photo-realistic"
  | "editorial"
  | "lifestyle-candid"
  | "clinical-professional"
  | "infographic-clean"
  | "warm-portrait"
  | "bold-graphic"
  | "documentary"
  | "aspirational";

export type FilmStock =
  | "portra-400"
  | "portra-800"
  | "gold-200"
  | "ektar-100"
  | "pro-400h"
  | "superia-400"
  | "cinestill-800t"
  | "vision3"
  | "hp5"
  | "tri-x-400";

export type RealismLevel = "standard" | "high" | "ultra";

export interface GeminiJsonPrompt {
  /** Image category for routing and context */
  category: ImageCategory;

  /** Core subject description - MUST be narrative, not keywords */
  subject: string;

  /** Setting/environment description with lived-in details */
  setting?: string;

  /** Camera angle/shot type */
  camera?: CameraAngle;

  /** Specific camera body reference (triggers optical characteristics) */
  cameraBody?: string;

  /** Focal length e.g. "85mm", "35mm", "50mm" */
  focalLength?: string;

  /** Aperture e.g. "f/1.4", "f/2.8", "f/8" */
  aperture?: string;

  /** Lighting style */
  lighting?: LightingStyle;

  /** Light direction e.g. "from camera-left", "45 degrees from above" */
  lightDirection?: string;

  /** Composition rule */
  composition?: CompositionRule;

  /** Visual style preset */
  style?: StylePreset;

  /** Output aspect ratio */
  aspectRatio?: AspectRatio;

  /** Mood/emotion keywords (2-4 words) */
  mood?: string[];

  /** Brand color to emphasize (hex or name) */
  brandColor?: string;

  /** Specific props or objects to include */
  props?: string[];

  /** Subject demographics (age range, gender, build) */
  demographics?: string;

  /** Negative prompt - things to avoid (appended to defaults) */
  avoid?: string[];

  /** Override prompt suffix (replaces auto-generated closing) */
  suffixOverride?: string;

  /** Custom text overlay (max 5 words) */
  textOverlay?: string;

  /** Film stock reference for color science and grain character */
  filmStock?: FilmStock;

  /** Color grading descriptor e.g. "teal-and-amber", "muted warm tones" */
  colorGrade?: string;

  /** Surface detail and imperfection keywords to include */
  surfaceDetail?: string[];

  /** Realism level controlling auto-injected boosters. Default: "high" */
  realism?: RealismLevel;
}

// ============================================================
// CONSTANTS
// ============================================================

/** Banned terms that must be caught before sending to API */
export const BANNED_TERMS = [
  "inbody",
  "dexa",
  "ozempic",
  "wegovy",
  "mounjaro",
  "zepbound",
  "syringe",
  "needle",
  "before and after split",
  "istock",
  "shutterstock",
  "stock photo",
  "generic",
];

/** Safe replacements for common banned terms */
export const TERM_REPLACEMENTS: Record<string, string> = {
  inbody: "body composition scale",
  dexa: "body composition scale",
  ozempic: "GLP-1 medication",
  wegovy: "GLP-1 medication",
  mounjaro: "GLP-1 medication",
  zepbound: "GLP-1 medication",
  syringe: "medical vial",
  needle: "medical vial",
};

/** Film stock to prompt description mapping */
const FILM_STOCK_DESCRIPTIONS: Record<FilmStock, string> = {
  "portra-400": "Kodak Portra 400 color science with warm skin tones, soft contrast, muted pastels",
  "portra-800": "Kodak Portra 800 color science with warm tones and slightly visible grain",
  "gold-200": "Kodak Gold 200 color science with saturated warm nostalgic tones",
  "ektar-100": "Kodak Ektar 100 color science with vivid saturated colors and fine grain",
  "pro-400h": "Fujifilm Pro 400H color science with soft delicate pastels and ethereal tones",
  "superia-400": "Fujifilm Superia 400 color science with cool tones and green undertones",
  "cinestill-800t": "Cinestill 800T color science with tungsten white balance and red halation around light sources",
  "vision3": "Kodak Vision3 5219 cinematic film color science with rich deep tones",
  "hp5": "Ilford HP5 black and white with medium grain and classic tonal range",
  "tri-x-400": "Kodak Tri-X 400 black and white with high contrast grain and documentary feel",
};

/** Anti-AI negatives always appended to prompts */
const DEFAULT_NEGATIVES = [
  "No plastic skin",
  "no CGI",
  "no 3D render",
  "no perfect symmetry",
  "no stock photo pose",
  "no oversaturated colors",
  "no cartoon",
  "no illustration style",
  "no airbrushed look",
  "no extra fingers or limbs",
  "no skin smoothing",
  "no beauty filter",
  "no retouching",
  "no digital sharpening artifacts",
];

/** Skin realism keywords (pick 2-4 based on realism level) */
const SKIN_REALISM_KEYWORDS = [
  "visible pores and natural skin texture with imperfections",
  "subtle under-eye circles and natural shadows",
  "natural oil sheen on forehead and nose",
  "slight asymmetrical facial features as in real life",
  "fine peach fuzz on cheeks visible in side light",
  "natural lip texture with slight dryness",
  "realistic iris detail with natural catchlight reflection in eyes",
  "individual hair strands visible with natural flyaways and frizz",
  "faint sun spots or freckles on skin",
  "micro-wrinkles around eyes and mouth from natural expressions",
  "uneven skin tone across face as in unretouched photography",
  "visible veins on hands and forearms",
];

/** Category-specific context (used as fallback when no detailed fields set) */
export const CATEGORY_SUFFIXES: Record<ImageCategory, string> = {
  lifestyle: "warm natural lighting, Arizona setting, authentic candid moment, lived-in environmental details",
  educational: "clean minimalist composition, medical professional context, PV teal #6CC3E0 accent",
  authority: "warm clinical environment, NP provider, approachable medical professional, modern clinic setting",
  offer: "bold clean ad graphic, high contrast, mobile-first design, clear visual hierarchy",
  community: "warm community gathering, inclusive diverse group, supportive atmosphere, natural interaction",
};

/** Default camera body by shot type for auto-injection */
function getDefaultCameraSpec(camera?: CameraAngle): { body: string; focal: string; aperture: string } {
  switch (camera) {
    case "close-up":
    case "extreme-close-up":
      return { body: "Canon 5D Mark IV", focal: "100mm macro", aperture: "f/2.8" };
    case "wide-shot":
      return { body: "Sony A7III", focal: "24mm", aperture: "f/5.6" };
    case "birds-eye":
      return { body: "Sony A7III", focal: "35mm", aperture: "f/5.6" };
    case "over-the-shoulder":
      return { body: "Canon EOS R5", focal: "50mm", aperture: "f/2.0" };
    case "medium-shot":
      return { body: "Canon EOS R5", focal: "50mm", aperture: "f/2.0" };
    default:
      return { body: "Canon EOS R5", focal: "85mm", aperture: "f/1.4" };
  }
}

/** Default film stock by category */
function getDefaultFilmStock(category: ImageCategory, hasPeople: boolean): string {
  if (!hasPeople) {
    if (category === "educational" || category === "offer") {
      return "natural color grading with clean neutral tones";
    }
    return "Kodak Ektar 100 color science with vivid saturated colors";
  }
  switch (category) {
    case "authority":
    case "lifestyle":
      return "Kodak Portra 400 color science with warm skin tones and soft contrast";
    case "community":
      return "Kodak Gold 200 color science with warm saturated tones";
    default:
      return "natural color grading with warm balanced tones";
  }
}

// ============================================================
// DESCRIPTION MAPS
// ============================================================

const CAMERA_DESCRIPTIONS: Record<CameraAngle, string> = {
  "eye-level": "eye-level perspective, natural and engaging",
  "low-angle": "low angle looking up, conveying authority and presence",
  "high-angle": "elevated angle looking down, overview perspective",
  "birds-eye": "directly overhead birds-eye view, flat-lay style",
  "dutch-angle": "slightly tilted camera angle for energy and tension",
  "over-the-shoulder": "over-the-shoulder perspective, showing shared viewpoint",
  "close-up": "close-up shot capturing detail and emotion",
  "extreme-close-up": "extreme close-up macro shot revealing surface texture and detail",
  "wide-shot": "wide establishing shot showing full environment and context",
  "medium-shot": "medium shot from waist up showing body language and expression",
};

const LIGHTING_DESCRIPTIONS: Record<LightingStyle, string> = {
  "natural-window": "soft natural window light, diffused and directional, creating gentle shadows",
  "golden-hour": "warm golden hour sunlight with long directional shadows and warm color temperature",
  "soft-diffused": "soft diffused lighting, even and flattering with minimal shadows",
  "clinical-bright": "bright clean clinical lighting from overhead LED panels at 4000K",
  "warm-ambient": "warm ambient indoor lighting with subtle shadows and inviting glow",
  "backlit": "strong backlight creating rim light and warm halo around subject, with subtle fill",
  "studio-key": "studio key light with softbox at 45 degrees and subtle fill from reflector",
  "overcast-even": "even overcast natural daylight, soft illumination with no harsh shadows",
  "candlelight": "warm candlelight glow, intimate and textured with flickering warmth",
  "arizona-desert": "warm Arizona desert sunlight, bright directional light with warm color temperature",
  "rembrandt": "Rembrandt lighting with triangle shadow on cheek, dramatic and dimensional",
  "butterfly": "butterfly lighting with shadow under nose, flattering beauty standard",
  "rim-light": "rim light defining subject edges with separation from background",
  "side-light": "strong side lighting revealing texture and creating dramatic shadows",
};

const COMPOSITION_DESCRIPTIONS: Record<CompositionRule, string> = {
  "rule-of-thirds": "composed using rule of thirds with subject at a power point",
  "centered": "centered composition with strong symmetrical framing",
  "leading-lines": "composition with leading lines drawing the eye toward the subject",
  "negative-space": "generous negative space around subject for text overlay or breathing room",
  "symmetrical": "symmetrical balanced composition conveying stability",
  "frame-within-frame": "framed within architectural or natural elements for depth",
  "diagonal": "dynamic diagonal composition conveying movement and energy",
  "golden-ratio": "golden ratio spiral composition for natural visual flow",
};

const STYLE_DESCRIPTIONS: Record<StylePreset, string> = {
  "photo-realistic": "photorealistic photography style",
  "editorial": "editorial magazine photography style",
  "lifestyle-candid": "candid lifestyle photography, unstaged and authentic",
  "clinical-professional": "professional clinical photography, clean and trustworthy",
  "infographic-clean": "clean infographic visual style with clear hierarchy",
  "warm-portrait": "warm portrait photography with flattering light and connection",
  "bold-graphic": "bold graphic design style with strong visual impact",
  "documentary": "documentary photography style, observational and honest",
  "aspirational": "aspirational lifestyle photography, polished but achievable",
};

// ============================================================
// HELPERS
// ============================================================

/** Detect if the prompt involves people (for skin realism injection) */
function detectPeopleInPrompt(json: GeminiJsonPrompt): boolean {
  if (json.demographics) return true;
  const text = `${json.subject} ${json.setting || ""} ${json.category}`.toLowerCase();
  return /\b(person|people|woman|man|patient|provider|couple|group|portrait|face|smile|conversation|consultation|NP|nurse|doctor|walking|hiking|confident|mid-\d+s|her \d+s|his \d+s)\b/i.test(text);
}

/** Pick n random items from array (deterministic per prompt for consistency) */
function pickItems(arr: string[], n: number, seed: string): string[] {
  // Simple hash-based selection for variety
  const hash = seed.split("").reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
  const shuffled = [...arr].sort((a, b) => {
    const ha = (hash + a.charCodeAt(0)) % arr.length;
    const hb = (hash + b.charCodeAt(0)) % arr.length;
    return ha - hb;
  });
  return shuffled.slice(0, Math.min(n, arr.length));
}

// ============================================================
// PROMPT BUILDER
// ============================================================

/**
 * Sanitize prompt text by replacing banned terms with safe alternatives.
 */
export function sanitizePrompt(text: string): { sanitized: string; replacements: string[] } {
  let sanitized = text;
  const replacements: string[] = [];

  for (const [banned, safe] of Object.entries(TERM_REPLACEMENTS)) {
    const regex = new RegExp(`\\b${banned}\\b`, "gi");
    if (regex.test(sanitized)) {
      sanitized = sanitized.replace(regex, safe);
      replacements.push(`"${banned}" -> "${safe}"`);
    }
  }

  return { sanitized, replacements };
}

/**
 * Build a narrative prompt string from a structured JSON prompt object.
 * Follows the Master Formula: realism trigger + subject + camera/lens +
 * lighting + texture + color + composition + grain + negatives.
 */
export function buildPromptFromJson(json: GeminiJsonPrompt): string {
  const parts: string[] = [];
  const realism = json.realism || "high";
  const hasPeople = detectPeopleInPrompt(json);

  // ── 1. Realism trigger ──────────────────────────────────────
  if (realism === "ultra") {
    parts.push("An unedited, unretouched RAW photograph straight from the camera sensor. Ultra-realistic with natural imperfections, exactly as a real camera would capture it.");
  } else if (realism === "high") {
    parts.push("A candid unretouched photograph taken with a real camera. Natural imperfections, no post-processing smoothing.");
  }
  // standard: no trigger, rely on style field

  // ── 2. Subject (narrative, the core of the image) ──────────
  parts.push(json.subject.trim().replace(/\.?$/, "."));

  // ── 3. Setting with environmental context ──────────────────
  if (json.setting) {
    parts.push(json.setting.trim().replace(/\.?$/, "."));
  }

  // ── 4. Demographics ────────────────────────────────────────
  if (json.demographics) {
    parts.push(json.demographics.trim().replace(/\.?$/, "."));
  }

  // ── 5. Camera: body + lens + aperture + DOF + angle ────────
  if (json.cameraBody || json.focalLength || json.aperture) {
    // Explicit camera specs provided
    const camParts: string[] = [];
    if (json.cameraBody) camParts.push(`Shot on ${json.cameraBody}`);
    if (json.focalLength) camParts.push(`with ${json.focalLength} lens`);
    if (json.aperture) {
      camParts.push(`at ${json.aperture}`);
      const fnum = parseFloat(json.aperture.replace("f/", ""));
      if (fnum <= 2.0) camParts.push("creating natural bokeh with shallow depth of field");
      else if (fnum <= 4.0) camParts.push("with moderate background separation");
      else camParts.push("with deep focus throughout");
    }
    parts.push(camParts.join(" ") + ".");
    // Add angle description if also specified
    if (json.camera) {
      parts.push(CAMERA_DESCRIPTIONS[json.camera] + ".");
    }
  } else if (realism !== "standard") {
    // Auto-inject camera specs for realism
    const defaults = getDefaultCameraSpec(json.camera);
    const fnum = parseFloat(defaults.aperture.replace("f/", ""));
    const dofDesc = fnum <= 2.0
      ? "creating natural bokeh with shallow depth of field"
      : fnum <= 4.0
        ? "with moderate background separation"
        : "with deep focus throughout";
    parts.push(`Shot on ${defaults.body} with ${defaults.focal} lens at ${defaults.aperture} ${dofDesc}.`);
    if (json.camera) {
      parts.push(CAMERA_DESCRIPTIONS[json.camera] + ".");
    }
  } else if (json.camera) {
    parts.push(CAMERA_DESCRIPTIONS[json.camera] + ".");
  }

  // ── 6. Lighting with direction and physics ─────────────────
  if (json.lighting) {
    let lightDesc = LIGHTING_DESCRIPTIONS[json.lighting];
    if (json.lightDirection) {
      lightDesc += `, ${json.lightDirection}`;
    }
    parts.push(lightDesc + ".");
  } else if (json.lightDirection) {
    parts.push(`Lighting ${json.lightDirection}.`);
  }

  // ── 7. Composition ─────────────────────────────────────────
  if (json.composition) {
    parts.push(COMPOSITION_DESCRIPTIONS[json.composition] + ".");
  }

  // ── 8. Style ───────────────────────────────────────────────
  if (json.style) {
    parts.push(STYLE_DESCRIPTIONS[json.style] + ".");
  }

  // ── 9. Skin realism (auto for people at high/ultra) ────────
  if (hasPeople && realism !== "standard") {
    const count = realism === "ultra" ? 4 : 3;
    const skinKeywords = pickItems(SKIN_REALISM_KEYWORDS, count, json.subject);
    parts.push(skinKeywords.join(", ") + ".");
  }

  // ── 10. Surface detail / imperfections ─────────────────────
  if (json.surfaceDetail && json.surfaceDetail.length > 0) {
    parts.push(json.surfaceDetail.join(", ") + ".");
  } else if (realism === "ultra") {
    parts.push("Natural environmental details with slight wear, scratches, scuffs, dust particles visible in light, fingerprints on surfaces, fabric wrinkles, uneven paint edges.");
  } else if (realism === "high") {
    parts.push("Natural environmental details: slight dust on surfaces, fabric wrinkles, scuff marks on floors, imperfect edges on objects.");
  }

  // ── 11. Film stock or color grade ──────────────────────────
  if (json.filmStock) {
    parts.push(FILM_STOCK_DESCRIPTIONS[json.filmStock] + ".");
  } else if (json.colorGrade) {
    parts.push(`${json.colorGrade} color grade.`);
  } else if (realism !== "standard") {
    parts.push(getDefaultFilmStock(json.category, hasPeople) + ".");
  }

  // ── 12. Post-processing / grain (realism boosters) ─────────
  if (json.suffixOverride) {
    parts.push(json.suffixOverride + ".");
  } else if (realism === "ultra") {
    parts.push("Visible film grain throughout, sensor noise in shadows, slight lens vignette, chromatic aberration at edges, slight lens distortion at periphery.");
  } else if (realism === "high") {
    parts.push("Visible film grain, slight color noise in shadow areas.");
  }

  // ── 13. Mood ───────────────────────────────────────────────
  if (json.mood && json.mood.length > 0) {
    parts.push(`Mood: ${json.mood.join(", ")}.`);
  }

  // ── 14. Brand color ────────────────────────────────────────
  if (json.brandColor) {
    parts.push(`Accent color: ${json.brandColor}.`);
  }

  // ── 15. Props ──────────────────────────────────────────────
  if (json.props && json.props.length > 0) {
    parts.push(`Include: ${json.props.join(", ")}.`);
  }

  // ── 16. Text overlay ───────────────────────────────────────
  if (json.textOverlay) {
    parts.push(`Text overlay reading "${json.textOverlay}" in bold modern sans-serif font.`);
  }

  // ── 17. Aspect ratio ───────────────────────────────────────
  const ratio = json.aspectRatio || "1:1";
  parts.push(`${ratio} aspect ratio.`);

  // ── 18. Anti-AI negatives (always appended) ────────────────
  const negatives = [...DEFAULT_NEGATIVES];
  if (json.avoid) {
    for (const item of json.avoid) {
      if (!negatives.some(n => n.toLowerCase().includes(item.toLowerCase()))) {
        negatives.push(item);
      }
    }
  }
  parts.push(negatives.join(", ") + ".");

  // Sanitize and return
  const combined = parts.join(" ");
  const { sanitized } = sanitizePrompt(combined);
  return sanitized;
}

// ============================================================
// STANDARD CLOSING (kept for backward compat with plain-text prompts)
// ============================================================

export const STANDARD_CLOSING = "professional photorealistic photography, subtle film grain, no watermarks, no plastic skin, no CGI";

// ============================================================
// VALIDATION
// ============================================================

const VALID_CATEGORIES: ImageCategory[] = ["lifestyle", "educational", "authority", "offer", "community"];
const VALID_RATIOS: AspectRatio[] = ["1:1", "9:16", "16:9", "4:5", "2:3", "3:1"];
const VALID_FILM_STOCKS: FilmStock[] = [
  "portra-400", "portra-800", "gold-200", "ektar-100",
  "pro-400h", "superia-400", "cinestill-800t",
  "vision3", "hp5", "tri-x-400",
];
const VALID_REALISM: RealismLevel[] = ["standard", "high", "ultra"];

/**
 * Validate a GeminiJsonPrompt object. Returns array of error messages (empty = valid).
 */
export function validatePrompt(json: Partial<GeminiJsonPrompt>): string[] {
  const errors: string[] = [];

  if (!json.category) {
    errors.push("category is required (lifestyle, educational, authority, offer, community)");
  } else if (!VALID_CATEGORIES.includes(json.category)) {
    errors.push(`Invalid category "${json.category}". Must be: ${VALID_CATEGORIES.join(", ")}`);
  }

  if (!json.subject || json.subject.trim().length < 5) {
    errors.push("subject is required and must be at least 5 characters");
  }

  if (json.aspectRatio && !VALID_RATIOS.includes(json.aspectRatio)) {
    errors.push(`Invalid aspectRatio "${json.aspectRatio}". Must be: ${VALID_RATIOS.join(", ")}`);
  }

  if (json.filmStock && !VALID_FILM_STOCKS.includes(json.filmStock)) {
    errors.push(`Invalid filmStock "${json.filmStock}". Must be: ${VALID_FILM_STOCKS.join(", ")}`);
  }

  if (json.realism && !VALID_REALISM.includes(json.realism)) {
    errors.push(`Invalid realism "${json.realism}". Must be: ${VALID_REALISM.join(", ")}`);
  }

  if (json.mood && json.mood.length > 4) {
    errors.push("mood should have at most 4 keywords");
  }

  if (json.textOverlay && json.textOverlay.split(" ").length > 5) {
    errors.push("textOverlay should be max 5 words (Gemini text rendering is limited)");
  }

  // Check for banned terms in subject
  if (json.subject) {
    const lower = json.subject.toLowerCase();
    for (const banned of BANNED_TERMS) {
      if (lower.includes(banned)) {
        const replacement = TERM_REPLACEMENTS[banned];
        errors.push(`Subject contains banned term "${banned}"${replacement ? `. Use "${replacement}" instead` : ""}`);
      }
    }
  }

  return errors;
}

// ============================================================
// PARSER
// ============================================================

/**
 * Attempt to parse a JSON prompt from a tag body.
 * Returns the parsed prompt or null if it's not valid JSON (plain text fallback).
 */
export function tryParseJsonPrompt(tagBody: string): GeminiJsonPrompt | null {
  const trimmed = tagBody.trim();

  // Quick check: does it look like JSON?
  if (!trimmed.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(trimmed);

    // Must have at minimum category and subject
    if (typeof parsed.category === "string" && typeof parsed.subject === "string") {
      return parsed as GeminiJsonPrompt;
    }
    return null;
  } catch {
    return null;
  }
}
