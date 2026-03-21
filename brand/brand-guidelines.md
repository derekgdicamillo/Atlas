# PV MediSpa & Weight Loss Brand Guidelines

*Last updated: 2026-02-24*

---

## Brand Identity

**Business Name:** PV MediSpa & Weight Loss
**Location:** Prescott Valley, Arizona
**Industry:** Medical weight loss, functional medicine, medical aesthetics
**Founded by:** Derek (NP, APRN) and Esther
**Certifications:** LegitScript certified (enables direct GLP-1 advertising on Meta)

### Brand Promise
Physician-supervised medical weight loss built on a complete system, not just a prescription. Every patient gets medication, monitoring, a structured 5-Pillar care plan, community support, and a provider who lost 100+ lbs on this exact program.

### Brand Positioning
We are not an online prescription mill. We are a local medical practice that treats weight loss as a clinical discipline, combining GLP-1 therapy with labs, body composition tracking, nutrition science, movement programming, and behavioral support.

---

## Color Palette

### Primary Colors

| Name | Hex | RGB | Use |
|------|-----|-----|-----|
| PV Teal | `#6CC3E0` | 108, 195, 224 | Primary brand color. Buttons, links, accents, CTAs |
| PV Teal Hover | `#08ACF2` | 8, 172, 242 | Interactive/hover states, gradient endpoints |

### Secondary Colors (from Brand Board)

| Name | Hex | RGB | Use |
|------|-----|-----|-----|
| Warm Peach | `#EAC1A6` | 234, 193, 166 | Warm accent, soft highlights, feminine touches |
| Warm Brown | `#725845` | 114, 88, 69 | Earthy accent, grounding tone, secondary text on light backgrounds |

### Neutral Colors

| Name | Hex | RGB | Use |
|------|-----|-----|-----|
| Charcoal | `#3D3D3D` | 61, 61, 61 | Brand board primary dark (print, social graphics) |
| Heading Dark | `#101218` | 16, 18, 24 | Website headings (CSS override, near-black) |
| Body Text | `#4C5253` | 76, 82, 83 | Body copy, paragraphs |
| Muted Text | `#7A7A7A` | 122, 122, 122 | Secondary text, captions, metadata |
| Border / Light Gray | `#E8E7E6` | 232, 231, 230 | Dividers, card borders, separators, brand board neutral |
| Light Background | `#F3F6F6` | 243, 246, 246 | Section backgrounds, alternating rows |
| White | `#FFFFFF` | 255, 255, 255 | Page backgrounds, card fills |

### Transparency Variants

| Name | Value | Use |
|------|-------|-----|
| Teal Light | `rgba(108, 195, 224, 0.08)` | Subtle teal tint backgrounds (quote blocks, highlights) |
| Teal Glow | `rgba(108, 195, 224, 0.3)` | Button glow shadows, focus rings |

### Gradients

- **Teal Gradient:** `linear-gradient(135deg, #6CC3E0, #08ACF2)` -- CTA sections, overlay panels
- **Hero Overlay:** `linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.35) 60%, rgba(0,0,0,0.5))` -- darkens hero images for text readability

### What to Avoid
- Never use teal as a background color for large areas (it's an accent, not a fill)
- Never pair teal text on light teal backgrounds (contrast fails WCAG)
- The palette is predominantly cool-toned. The peach and brown are intentional warm accents from the original brand board, not dominant colors.

---

## Typography

### Font Stack (Website, current)

| Role | Font | Fallback | Weight(s) |
|------|------|----------|-----------|
| Headings (h1-h6) | Playfair Display | Georgia, serif | 400, 700 |
| Body, navigation, buttons | Raleway | sans-serif | 400, 500, 600 |
| Testimonials, quotes | Bahamas | Georgia, serif | 300, 400, 700 |

### Font Stack (Brand Board, original)

The original brand board specifies a slightly different stack. The website CSS has evolved from this, but these remain the canonical brand fonts for print, social graphics, and non-web use.

| Role | Font | Notes |
|------|------|-------|
| Titles | Raleway Heavy | Bold/Heavy weight |
| Subheadings | Raleway Heavy | All-caps, wide letter-spacing |
| Body copy | Arimo | Google Font, clean sans-serif. Website uses Raleway instead. |
| Accent / script | Breathing | Decorative script for logos, social graphics, special callouts |

### Custom Font Files

**Bahamas** (testimonial/quote font):
- `BAHAMASN.TTF` (400 normal)
- `BAHAMALN.TTF` (300 light)
- `BAHAMAHN.TTF` (700 bold)
- Location: `brand/assets/fonts/` and WP theme `assets/fonts/bahamas/`

**Breathing** (script accent font):
- Used in sub-logo and brand board accent text
- Source files: TO LOCATE (check original designer deliverables)

### Type Scale (Desktop)

| Element | Size | Weight | Font |
|---------|------|--------|------|
| h1 | Theme default | 700 | Playfair Display |
| h2 | Theme default | 700 | Playfair Display |
| h3 | Theme default | 600 | Playfair Display |
| Body | 17px (blog) | 400 | Raleway |
| Navigation | Default | 500, letter-spacing 0.5px | Raleway |
| Buttons | Default | 600, letter-spacing 0.5px | Raleway |
| Eyebrow labels | 14px | 600, letter-spacing 2.5px, uppercase | Raleway |
| Quote text | 1.15em | 400 | Bahamas |
| Quote citation | Default | 600 | Raleway (teal color) |

### Responsive Type Scale

| Breakpoint | h1 | h2 | h3 |
|------------|----|----|-----|
| Desktop (>1024px) | Theme default | Theme default | Theme default |
| Tablet (<=1024px) | 36px | 30px | Theme default |
| Small tablet (<=768px) | 32px | 26px | 22px |
| Mobile (<=480px) | 28px | 24px | 20px |

### Line Height
- Body copy: 1.8 (blog content)
- Quote text: 1.7

---

## Spacing and Layout

### Design Tokens

| Token | Value | Use |
|-------|-------|-----|
| Section padding | 80px vertical (desktop) | `.pv-section` utility |
| Section padding (tablet) | 60px | <=1024px |
| Section padding (small tablet) | 48px | <=768px |
| Section padding (mobile) | 36px | <=480px |
| Border radius (sm) | 6px | Buttons, small elements |
| Border radius (md) | 12px | Cards, panels, images |
| Border radius (lg) | 20px | Large containers, modals |

### Shadows

| Level | Value | Use |
|-------|-------|-----|
| Small | `0 2px 8px rgba(0,0,0,0.04)` | Headers, subtle depth |
| Medium | `0 4px 16px rgba(0,0,0,0.06)` | Sticky header, submenus |
| Large | `0 8px 30px rgba(0,0,0,0.08)` | Modals, elevated sections |
| Teal | `0 4px 16px rgba(108,195,224,0.25)` | CTA buttons on hover |
| Elevated card | Three-layer stack (see CSS) | Premium card components |

### Transitions
- Standard: `0.3s cubic-bezier(0.4, 0, 0.2, 1)`
- Slow: `0.5s cubic-bezier(0.4, 0, 0.2, 1)`

---

## UI Patterns

### Buttons
- Primary: teal background, white text, 6px radius, 600 weight
- Hover: shift to teal-hover color, teal glow shadow, translateY(-2px) lift
- Outline: 2px border, teal tint background on hover
- Mobile: full-width, minimum 48px tap target

### Cards
- 12px border radius, hover lifts translateY(-4px) with shadow-lg
- Touch devices: hover effects disabled (prevents sticky states on tap)

### Quotes/Testimonials
- 4px teal left border
- Light teal background (`rgba(108,195,224,0.08)`)
- Bahamas font for quote text
- Raleway for citation, teal color

### Eyebrow Labels
- All caps, 2.5px letter spacing, 14px, 600 weight
- Teal color
- Used above section headings for category labels

### Hero Sections
- Dark gradient overlay for text readability
- Mobile: `background-attachment: scroll` (fixes iOS)
- Mobile: reduced min-height, 80px top / 60px bottom padding

### Glassmorphism (`.pv-glass`)
- White at 70% opacity, 12px backdrop blur, subtle white border
- Use sparingly for floating panels over imagery

---

## Voice and Tone

> Full reference: `memory/voice-guide.md`

### Summary
- **Formality:** 6/10. Professional but warm. Not corporate.
- **Directness:** 8/10. Gets to the point without being cold.
- **Humor:** Dry wit, not slapstick. Natural, never forced.
- **Default register:** Confident optimism.

### Sentence Structure
- Average 18 words per sentence (range 12-25)
- Short paragraphs, 1-2 sentences. Reads like a text thread, not an essay.
- Sentence fragments for emphasis: "Not because the medication raised testosterone. But because fat tissue contains aromatase."
- Questions to engage: "What are your thoughts on this?"

### Teaching Style
- Misconception > data/study > mechanism > "this is why" > named framework > engagement question
- Feedback loops to explain biology (A causes B which causes more A)
- Cites specific data inline, conversationally. No academic citations.
- Personal anecdotes and patient scenarios to illustrate.

### What Derek's Voice Is NOT
- Not corporate or stiff
- Not condescending or preachy
- Not overly cautious or hedge-everything
- Not emotionally flat
- Not "content creator" voice (no forced hooks, no bold-everything)

---

## Patient-Facing Language

### Required
- Person-first: "people with obesity" not "obese people"
- Preferred terms: "weight," "unhealthy weight," "excess weight"
- Frame medication as legitimate medical tool, not shortcut
- "Healthy eating" not "diet." "Physical activity" not "exercise regimen."
- Collaborative tone: "we'll work together" not "you should do X"
- Celebrate non-scale victories alongside scale progress.

### Prohibited
- "Fat," "fatness," "chubby," "morbidly obese"
- Scare tactics, shame, guilt
- Brand drug names in marketing: Ozempic, Wegovy, Mounjaro, Zepbound
- Equipment we don't have: InBody, DEXA (use "body comp SCALE")

### Approved Medication Language
- "GLP-1 therapy," "GLP-1 weight loss medication"
- "Compounded semaglutide," "compounded tirzepatide"
- "Medical weight loss injections"
- "Physician-supervised," "FDA-approved active ingredients"
- "Compounded at licensed pharmacies"

---

## Content Framework

> Full reference: `memory/content-engine.md`

### Named Frameworks (always use these exact names)
- **SLOW & SHIELD** -- side effect management protocol
- **Vitality Tracker** -- patient progress tracking
- **Protein Paradox** -- protein intake education
- **Fuel Code** -- nutrition system
- **Fuel Code Plate** -- meal composition visual
- **Calm Core Toolkit** -- stress/cortisol management
- **Cooling Fuel Protocol** -- anti-inflammatory nutrition
- **Movement Hierarchy** -- exercise prioritization (strength > walking > cardio)

### 5 Pillars (weekly rotation)
1. **Precision Weight Science** -- tracking, body comp SCALE, data
2. **Nourishing Health** -- Fuel Code, Protein Paradox, hydration
3. **Dynamic Movement** -- strength first, walking, Movement Hierarchy
4. **Mindful Wellness** -- Calm Core Toolkit, cortisol, sleep, stress
5. **Functional Wellness** -- Cooling Fuel Protocol, inflammation, gut health

### Content Waterfall
Skool post (500-800 words) > 3 Facebook hooks (100-200 words each) > email newsletter (300-500 words) > YouTube outline

### Posting Cadence
- Skool: 3-5x/week
- Facebook: daily
- Newsletter: 1x/week (Thursday or Friday)
- YouTube: 1x/week

### Hook Formulas
- Problem-aware: "If you've tried every diet and nothing stuck..."
- Curiosity gap: "There's one thing most weight loss programs get wrong..."
- Transformation: "She lost 47 pounds. But that's not the best part..."
- Myth-bust: "You don't need to eat 1200 calories. Here's why."
- Question: "What if the problem isn't your willpower?"

---

## Marketing and Compliance

> Full reference: `config/modes/marketing.md`

### LegitScript Certified
We can directly market GLP-1 therapy on Meta. No hedging required on medication mentions.

### Compliance Rules
- No guaranteed results ("You WILL lose 30 lbs")
- No before/after implying typical results without disclaimers
- Include "Results may vary" where appropriate
- Frame as "physician-supervised medical program"
- No brand drug names in ad copy or organic content

### Ad Copy Structure
Hook-Story-Offer (Brunson framework). Lead with empathy, not features. "You" focused. Short paragraphs. One CTA per ad. Always apply /humanizer.

### Value Ladder
```
FREE:    Social content, Skool community, educational videos
LOW $:   Vitality Unchained (paid Skool), free consultation
CORE $$: GLP-1 weight loss program (monthly patient)
HIGH $$$: Comprehensive functional medicine + HRT + weight loss
RECURRING: Monthly medication, follow-ups, ongoing monitoring
```

### Current Pricing
- Semaglutide program: $465/month
- Tirzepatide program: $565/month
- Enrollment fee: $199 one-time (onboarding, body comp baseline, labs)

---

## Audience

### Primary Persona
- Women 35-54 who have struggled with weight for years
- 80% female GLP-1 user base
- Pain points: past diet failures, medication guilt, fear of judgment, side effects, cost, weight regain
- They want: lasting results, improved energy, supportive community, evidence-based guidance
- Geographic target: Prescott Valley, expanding statewide Arizona

---

## Logo Suite

Complete logo package with every variant in PNG, SVG, and PDF. Master files in AI/EPS.

### Logo Types

| Type | Variants | Use |
|------|----------|-----|
| **Full Lock Up** | Color, Black, White, BlueWhite | Primary logo. Website header, print, signage. |
| **Full Lock Up - Round** | Color, Black, White | Social profile images, badges, circular placements |
| **Full Lock Up - Pursue Vitality** | Blue, BlueWhite, White, White_1 | Tagline version for marketing materials |
| **Iconic Mark** | Blue, Black, White | Standalone floral woman silhouette. Favicons, app icons, watermarks. |
| **WordMark** | Blue, Black, White | Text-only "PV MediSpa & Weight Loss". Minimalist contexts. |
| **Favicon** | Blue (PNG) | Browser tab icon |
| **Master File** | .ai, .eps | Source files for designer edits |

### Usage Rules
- **Primary:** Full Lock Up (Color) on white/light backgrounds
- **Dark backgrounds:** Full Lock Up (White) or (BlueWhite)
- **Social profiles:** Full Lock Up - Round (Color)
- **Small spaces:** Iconic Mark (Blue) or Favicon
- **Text-heavy layouts:** WordMark (Blue or Black)
- Never stretch, rotate, recolor, or add effects to the logo
- Maintain clear space around logo equal to the height of the iconic mark

## Assets Directory

```
brand/
  brand-guidelines.md                            <-- this file
  Brand - Aesthetic Brand Board Kit.pdf           <-- original designer brand board
  Brand - Mission Statement and Core Values.docx
  Brand - Target Patient Avatar.docx
  assets/
    logos/                                        <-- complete logo suite (55 files)
      Favicon/PNG/                                   Favicon-Blue.png
      Full Lock Up/{PDF,PNG,SVG}/                    Color, Black, White, BlueWhite
      Full Lock Up - Pursue Vitality/{PDF,PNG,SVG}/  Blue, BlueWhite, White
      Full Lock Up - Round/{PDF,PNG,SVG}/            Color, Black, White
      Iconic Mark/{PDF,PNG,SVG}/                     Blue, Black, White
      WordMark/{PDF,PNG,SVG}/                        Blue, Black, White
      Master FIle/                                   .ai, .eps source files
    fonts/                                        <-- Bahamas custom font (3 weights)
      BAHAMAHN.TTF, BAHAMALN.TTF, BAHAMASN.TTF
    photography/                                  <-- 2025 owner photos + 2022 clinic selects
      Derek.jpg, Esther.jpg, Derek & Esther.jpg, Group.jpg
      clinic-selects/                              <-- 22 files: curated pro photos + designed graphics
    icons/                                        <-- favicon source
      Favicon-Blue.png
    social-templates/                             <-- empty, needs creation
```

### Still Needed
- [x] Curated clinic/environment photos (selects from 2022 photoshoot)
- [ ] Body comp SCALE device photo (needs to be taken)
- [ ] LegitScript certification badge (dynamically rendered, needs manual screenshot from portal)
- [ ] Breathing script font source file (not found on system, check with original designer)
- [ ] Social media cover images (Facebook, Instagram, YouTube)
- [ ] Canva or Figma social post templates
- [ ] Email header/footer graphics

---

## Technical Reference

### CSS Custom Properties
All design tokens are defined as CSS custom properties in `custom-pvmedispa.css` on the Kadence theme. The source of truth for visual styling lives there.

**File location:** `C:\Users\Derek DiCamillo\Local Sites\pv-medispa-weight-loss\app\public\wp-content\themes\kadence\custom-pvmedispa.css`

### WordPress Stack
- Theme: Kadence (direct, no child theme)
- Custom CSS file: `custom-pvmedispa.css`
- Hosting: WP Engine (production), Local by Flywheel (dev)
- Deploy: WP Engine Git Push

### Source Files Cross-Reference
| What | Location |
|------|----------|
| Visual design (CSS) | `custom-pvmedispa.css` (Kadence theme) |
| Voice and tone | `memory/voice-guide.md` |
| Content engine | `memory/content-engine.md` |
| Marketing mode | `config/modes/marketing.md` |
| Social mode | `config/modes/social.md` |
| Medication pricing | `memory/medication-pricing.md` |
