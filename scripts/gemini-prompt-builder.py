#!/usr/bin/env python3
"""
Gemini Prompt Builder (Nano Banana 2)

Standalone script to build structured JSON prompts for the Atlas Gemini
image generation pipeline. Can be used independently of the Atlas bot.

Usage:
  python scripts/gemini-prompt-builder.py --interactive
  python scripts/gemini-prompt-builder.py --category lifestyle --subject "Woman hiking"
  python scripts/gemini-prompt-builder.py --from-text "Your weight loss journey starts here"
  python scripts/gemini-prompt-builder.py --batch prompts.jsonl --output tags.txt

Output: [GEMINI_IMAGE: {...}] tags ready to paste into Atlas.
"""

import argparse
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from typing import Optional

# ============================================================
# SCHEMA
# ============================================================

CATEGORIES = ["lifestyle", "educational", "authority", "offer", "community"]

CAMERA_ANGLES = [
    "eye-level", "low-angle", "high-angle", "birds-eye", "dutch-angle",
    "over-the-shoulder", "close-up", "extreme-close-up", "wide-shot", "medium-shot",
]

LIGHTING_STYLES = [
    "natural-window", "golden-hour", "soft-diffused", "clinical-bright",
    "warm-ambient", "backlit", "studio-key", "overcast-even", "candlelight",
    "arizona-desert",
]

COMPOSITION_RULES = [
    "rule-of-thirds", "centered", "leading-lines", "negative-space",
    "symmetrical", "frame-within-frame", "diagonal", "golden-ratio",
]

STYLE_PRESETS = [
    "photo-realistic", "editorial", "lifestyle-candid", "clinical-professional",
    "infographic-clean", "warm-portrait", "bold-graphic", "documentary", "aspirational",
]

ASPECT_RATIOS = ["1:1", "9:16", "16:9", "4:5"]

CATEGORY_SUFFIXES = {
    "lifestyle": "warm natural lighting, Arizona setting, authentic candid moment",
    "educational": "clean minimalist infographic style, medical professional, PV teal #6CC3E0 accent",
    "authority": "warm clinical environment, NP provider, approachable medical professional",
    "offer": "bold clean ad graphic, high contrast, mobile-first design",
    "community": "warm community gathering, inclusive diverse group, supportive atmosphere",
}

BANNED_TERMS = {
    "inbody": "body composition scale",
    "dexa": "body composition scale",
    "ozempic": "GLP-1 medication",
    "wegovy": "GLP-1 medication",
    "mounjaro": "GLP-1 medication",
    "zepbound": "GLP-1 medication",
    "syringe": "medical vial",
    "needle": "medical vial",
}

STANDARD_CLOSING = "high quality, professional photography style, no watermarks"

# ============================================================
# DATA CLASS
# ============================================================

@dataclass
class GeminiPrompt:
    category: str = "lifestyle"
    subject: str = ""
    setting: Optional[str] = None
    camera: Optional[str] = None
    lighting: Optional[str] = None
    composition: Optional[str] = None
    style: Optional[str] = None
    aspectRatio: str = "1:1"
    mood: list = field(default_factory=list)
    brandColor: Optional[str] = None
    props: list = field(default_factory=list)
    demographics: Optional[str] = None
    avoid: list = field(default_factory=list)
    suffixOverride: Optional[str] = None
    textOverlay: Optional[str] = None

    def validate(self):
        errors = []
        if self.category not in CATEGORIES:
            errors.append(f"Invalid category '{self.category}'. Must be one of: {', '.join(CATEGORIES)}")
        if not self.subject or len(self.subject.strip()) < 5:
            errors.append("subject is required and must be at least 5 characters")
        if self.camera and self.camera not in CAMERA_ANGLES:
            errors.append(f"Invalid camera '{self.camera}'. Options: {', '.join(CAMERA_ANGLES)}")
        if self.lighting and self.lighting not in LIGHTING_STYLES:
            errors.append(f"Invalid lighting '{self.lighting}'. Options: {', '.join(LIGHTING_STYLES)}")
        if self.composition and self.composition not in COMPOSITION_RULES:
            errors.append(f"Invalid composition '{self.composition}'. Options: {', '.join(COMPOSITION_RULES)}")
        if self.style and self.style not in STYLE_PRESETS:
            errors.append(f"Invalid style '{self.style}'. Options: {', '.join(STYLE_PRESETS)}")
        if self.aspectRatio not in ASPECT_RATIOS:
            errors.append(f"Invalid aspectRatio '{self.aspectRatio}'. Options: {', '.join(ASPECT_RATIOS)}")
        if len(self.mood) > 4:
            errors.append("mood should have at most 4 keywords")
        if self.textOverlay and len(self.textOverlay.split()) > 5:
            errors.append("textOverlay should be max 5 words")

        # Check banned terms
        lower_subject = self.subject.lower()
        for banned, replacement in BANNED_TERMS.items():
            if banned in lower_subject:
                errors.append(f"Subject contains banned term '{banned}'. Use '{replacement}' instead.")

        return errors

    def to_json(self):
        d = {}
        d["category"] = self.category
        d["subject"] = self.subject
        if self.setting:
            d["setting"] = self.setting
        if self.camera:
            d["camera"] = self.camera
        if self.lighting:
            d["lighting"] = self.lighting
        if self.composition:
            d["composition"] = self.composition
        if self.style:
            d["style"] = self.style
        if self.aspectRatio != "1:1":
            d["aspectRatio"] = self.aspectRatio
        if self.mood:
            d["mood"] = self.mood
        if self.brandColor:
            d["brandColor"] = self.brandColor
        if self.props:
            d["props"] = self.props
        if self.demographics:
            d["demographics"] = self.demographics
        if self.avoid:
            d["avoid"] = self.avoid
        if self.suffixOverride:
            d["suffixOverride"] = self.suffixOverride
        if self.textOverlay:
            d["textOverlay"] = self.textOverlay
        return json.dumps(d)

    def to_flat_prompt(self):
        parts = []
        parts.append(f"{self.category} image.")
        parts.append(f"{self.subject.strip()}.")
        if self.setting:
            parts.append(f"{self.setting.strip()}.")
        if self.demographics:
            parts.append(f"{self.demographics.strip()}.")

        camera_desc = {
            "eye-level": "shot at eye level",
            "low-angle": "shot from a low angle looking up",
            "high-angle": "shot from above looking down",
            "birds-eye": "birds eye view from directly above",
            "dutch-angle": "slightly tilted camera angle",
            "over-the-shoulder": "over the shoulder perspective",
            "close-up": "close-up shot",
            "extreme-close-up": "extreme close-up macro shot",
            "wide-shot": "wide establishing shot",
            "medium-shot": "medium shot from waist up",
        }
        if self.camera and self.camera in camera_desc:
            parts.append(f"{camera_desc[self.camera]}.")

        lighting_desc = {
            "natural-window": "natural window light",
            "golden-hour": "warm golden hour sunlight",
            "soft-diffused": "soft diffused lighting",
            "clinical-bright": "bright clean clinical lighting",
            "warm-ambient": "warm ambient indoor lighting",
            "backlit": "backlit with rim light around subject",
            "studio-key": "studio key light with soft fill",
            "overcast-even": "even overcast natural light",
            "candlelight": "warm candlelight glow",
            "arizona-desert": "warm Arizona desert sunlight",
        }
        if self.lighting and self.lighting in lighting_desc:
            parts.append(f"{lighting_desc[self.lighting]}.")

        comp_desc = {
            "rule-of-thirds": "composed using rule of thirds",
            "centered": "centered symmetrical composition",
            "leading-lines": "composition with leading lines drawing eye to subject",
            "negative-space": "generous negative space around subject",
            "symmetrical": "symmetrical balanced composition",
            "frame-within-frame": "framed within architectural or natural elements",
            "diagonal": "dynamic diagonal composition",
            "golden-ratio": "golden ratio spiral composition",
        }
        if self.composition and self.composition in comp_desc:
            parts.append(f"{comp_desc[self.composition]}.")

        style_desc = {
            "photo-realistic": "photo-realistic style",
            "editorial": "editorial magazine style",
            "lifestyle-candid": "candid lifestyle photography style",
            "clinical-professional": "professional clinical photography",
            "infographic-clean": "clean infographic visual style",
            "warm-portrait": "warm portrait photography",
            "bold-graphic": "bold graphic design style",
            "documentary": "documentary photography style",
            "aspirational": "aspirational lifestyle photography",
        }
        if self.style and self.style in style_desc:
            parts.append(f"{style_desc[self.style]}.")

        if self.mood:
            parts.append(f"Mood: {', '.join(self.mood)}.")
        if self.brandColor:
            parts.append(f"Accent color: {self.brandColor}.")
        if self.props:
            parts.append(f"Include: {', '.join(self.props)}.")
        if self.textOverlay:
            parts.append(f'Text overlay: "{self.textOverlay}".')
        if self.avoid:
            parts.append(f"Avoid: {', '.join(self.avoid)}.")

        suffix = self.suffixOverride or CATEGORY_SUFFIXES.get(self.category, "")
        parts.append(f"{suffix}.")
        parts.append(f"{STANDARD_CLOSING}, {self.aspectRatio}.")

        combined = " ".join(parts)
        # Sanitize banned terms
        for banned, replacement in BANNED_TERMS.items():
            pattern = re.compile(r"\b" + re.escape(banned) + r"\b", re.IGNORECASE)
            combined = pattern.sub(replacement, combined)
        return combined

    def to_tag(self, use_json=True):
        if use_json:
            return f"[GEMINI_IMAGE: {self.to_json()}]"
        else:
            return f"[GEMINI_IMAGE: {self.to_flat_prompt()}]"


# ============================================================
# CATEGORY INFERENCE
# ============================================================

def infer_category(text):
    lower = text.lower()
    if any(w in lower for w in ["journey", "confidence", "walking", "hiking", "jeans", "mirror", "candid", "lifestyle"]):
        return "lifestyle"
    if any(w in lower for w in ["educational", "infographic", "science", "protein", "macro", "framework", "data"]):
        return "educational"
    if any(w in lower for w in ["authority", "clinical", "provider", "np", "consultation", "credentials"]):
        return "authority"
    if any(w in lower for w in ["offer", "pricing", "deal", "discount", "cta", "book", "special", "package"]):
        return "offer"
    if any(w in lower for w in ["community", "tribe", "group", "support", "gathering", "together"]):
        return "community"
    return "lifestyle"


# ============================================================
# INTERACTIVE MODE
# ============================================================

def choose(prompt_text, options, default=None):
    print(f"\n{prompt_text}")
    for i, opt in enumerate(options, 1):
        marker = " *" if opt == default else ""
        print(f"  {i}. {opt}{marker}")
    if default:
        print(f"  (Enter for default: {default})")
    while True:
        choice = input("> ").strip()
        if not choice and default:
            return default
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(options):
                return options[idx]
        except ValueError:
            if choice in options:
                return choice
        print("Invalid choice, try again.")


def interactive_mode():
    print("=== Gemini Prompt Builder (Nano Banana 2) ===\n")

    p = GeminiPrompt()

    p.category = choose("Category:", CATEGORIES, "lifestyle")
    p.subject = input("\nSubject (describe the core scene): ").strip()
    if not p.subject:
        print("Subject is required.")
        sys.exit(1)

    p.setting = input("Setting/location (optional): ").strip() or None
    p.demographics = input("Demographics (optional, e.g. 'woman mid-40s'): ").strip() or None
    p.camera = choose("Camera angle:", ["skip"] + CAMERA_ANGLES, "skip")
    if p.camera == "skip":
        p.camera = None
    p.lighting = choose("Lighting:", ["skip"] + LIGHTING_STYLES, "skip")
    if p.lighting == "skip":
        p.lighting = None
    p.composition = choose("Composition:", ["skip"] + COMPOSITION_RULES, "skip")
    if p.composition == "skip":
        p.composition = None
    p.style = choose("Style:", ["skip"] + STYLE_PRESETS, "skip")
    if p.style == "skip":
        p.style = None
    p.aspectRatio = choose("Aspect ratio:", ASPECT_RATIOS, "1:1")

    mood_input = input("Mood keywords (comma-separated, max 4, optional): ").strip()
    if mood_input:
        p.mood = [m.strip() for m in mood_input.split(",")][:4]

    use_brand_color = input("Include PV Teal brand color? (y/N): ").strip().lower()
    if use_brand_color == "y":
        p.brandColor = "#6CC3E0"

    props_input = input("Props to include (comma-separated, optional): ").strip()
    if props_input:
        p.props = [pr.strip() for pr in props_input.split(",")]

    avoid_input = input("Things to avoid (comma-separated, optional): ").strip()
    if avoid_input:
        p.avoid = [a.strip() for a in avoid_input.split(",")]

    # Validate
    errors = p.validate()
    if errors:
        print("\nValidation warnings:")
        for e in errors:
            print(f"  - {e}")

    # Output
    print("\n=== JSON Tag ===")
    print(p.to_tag(use_json=True))
    print("\n=== Flat Text Tag ===")
    print(p.to_tag(use_json=False))
    print("\n=== Flat Prompt (for direct API use) ===")
    print(p.to_flat_prompt())


# ============================================================
# FROM-TEXT MODE
# ============================================================

def from_text_mode(text):
    category = infer_category(text)
    p = GeminiPrompt(
        category=category,
        subject=text,
        lighting="golden-hour" if category == "lifestyle" else "natural-window",
        composition="rule-of-thirds",
        style="lifestyle-candid" if category == "lifestyle" else "photo-realistic",
        aspectRatio="1:1",
        mood=["authentic", "warm"],
        avoid=["syringes", "brand drug names", "before and after split"],
    )
    errors = p.validate()
    if errors:
        print("Warnings:", "; ".join(errors), file=sys.stderr)
    print(p.to_tag(use_json=True))


# ============================================================
# BATCH MODE
# ============================================================

def batch_mode(input_file, output_file):
    results = []
    with open(input_file) as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                p = GeminiPrompt(**data)
                errors = p.validate()
                if errors:
                    print(f"Line {line_num} warnings: {'; '.join(errors)}", file=sys.stderr)
                results.append(p.to_tag(use_json=True))
            except (json.JSONDecodeError, TypeError) as e:
                print(f"Line {line_num} error: {e}", file=sys.stderr)

    output = "\n".join(results)
    if output_file:
        with open(output_file, "w") as f:
            f.write(output)
        print(f"Wrote {len(results)} tags to {output_file}")
    else:
        print(output)


# ============================================================
# CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="Gemini Prompt Builder (Nano Banana 2) - Build structured image prompts"
    )
    parser.add_argument("--interactive", "-i", action="store_true", help="Interactive prompt builder")
    parser.add_argument("--from-text", "-t", type=str, help="Auto-generate prompt from plain text description")
    parser.add_argument("--batch", "-b", type=str, help="Process JSONL file of prompts")
    parser.add_argument("--output", "-o", type=str, help="Output file (default: stdout)")
    parser.add_argument("--category", "-c", type=str, choices=CATEGORIES, help="Image category")
    parser.add_argument("--subject", "-s", type=str, help="Subject description")
    parser.add_argument("--camera", type=str, choices=CAMERA_ANGLES, help="Camera angle")
    parser.add_argument("--lighting", type=str, choices=LIGHTING_STYLES, help="Lighting style")
    parser.add_argument("--composition", type=str, choices=COMPOSITION_RULES, help="Composition rule")
    parser.add_argument("--style", type=str, choices=STYLE_PRESETS, help="Style preset")
    parser.add_argument("--ratio", type=str, choices=ASPECT_RATIOS, default="1:1", help="Aspect ratio")
    parser.add_argument("--flat", action="store_true", help="Output flat text tag instead of JSON")
    parser.add_argument("--json-only", action="store_true", help="Output raw JSON (no tag wrapper)")

    args = parser.parse_args()

    if args.interactive:
        interactive_mode()
    elif args.from_text:
        from_text_mode(args.from_text)
    elif args.batch:
        batch_mode(args.batch, args.output)
    elif args.category and args.subject:
        p = GeminiPrompt(
            category=args.category,
            subject=args.subject,
            camera=args.camera,
            lighting=args.lighting,
            composition=args.composition,
            style=args.style,
            aspectRatio=args.ratio,
        )
        errors = p.validate()
        if errors:
            print("Warnings:", "; ".join(errors), file=sys.stderr)
        if args.json_only:
            print(p.to_json())
        else:
            print(p.to_tag(use_json=not args.flat))
    else:
        parser.print_help()
        print("\nExamples:")
        print('  python scripts/gemini-prompt-builder.py -i')
        print('  python scripts/gemini-prompt-builder.py -c lifestyle -s "Woman hiking in desert"')
        print('  python scripts/gemini-prompt-builder.py -t "Your weight loss journey starts here"')
        print('  python scripts/gemini-prompt-builder.py -b prompts.jsonl -o tags.txt')


if __name__ == "__main__":
    main()
