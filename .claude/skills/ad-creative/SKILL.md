---
name: ad-creative
description: >-
  Generate high-converting Facebook/Meta ad creative for PV MediSpa. Combines
  Hormozi Value Equation, Brunson Hook-Story-Offer, Andromeda Entity ID diversity,
  UGC-first strategy, and Gemini realism engine for image generation. Use when
  Derek says "ad copy", "Facebook ad", "Meta ad", "ad creative", "new ads",
  or wants ad variations. Also invoked by Midas marketing intelligence for
  content hooks and creative generation.
allowed-tools:
  - Read
  - Glob
  - Grep
context: fork
user-invocable: true
argument-hint: <campaign goal or offer>
metadata:
  author: Atlas
  version: 4.0.0
---
# Ad Creative Engine v4.0

## References
- `references/facebook-ad-creative-trends.md` - Full Facebook ad trends research, UGC data, Hims case study, Entity ID mechanics, PV creative playbook
- `references/nano-banana-prompting-guide.md` - Gemini prompt engineering: Master Formula, camera language, film stocks, skin realism, anti-AI detection, JSON structured prompting

## Input Handling

**With $ARGUMENTS:** Use the campaign goal or offer provided.
**Without $ARGUMENTS:** Default to core offer: medical weight loss with GLP-1 therapy at PV MediSpa & Weight Loss, Prescott Valley AZ.

## PV MediSpa Context

- **Services:** GLP-1 medical weight loss (semaglutide, tirzepatide), body comp tracking, functional wellness
- **Market:** Prescott Valley, AZ (expanding statewide). Competitive with telehealth giants (Hims, Ro, Found).
- **Key differentiator:** Provider-as-brand. Derek's face and story (400 lbs to 137 lb loss) is the #1 creative asset. Telehealth has logos. PV has a face people trust.
- **Named frameworks:** SLOW & SHIELD, Vitality Tracker, Protein Paradox, Fuel Code, Calm Core Toolkit, Cooling Fuel Protocol, Movement Hierarchy
- **Tracking:** Body comp SCALE. Never mention InBody or DEXA.
- **Landing page:** https://landing.pvmedispa.com/weightloss
- **Tone:** Warm clinical authority. Friend who happens to be a medical provider.

## The #1 Rule: Creative Diversity (Entity IDs)

Meta's Andromeda clusters visually similar ads into a single Entity ID. Creative Similarity Score >60% = suppression. 5 similar-looking ads = 1 auction ticket. 5 genuinely different concepts = 5 tickets.

**Every ad set MUST have visual diversity across these dimensions:**
- Format: mix of static, carousel, video thumbnail, infographic, text-only
- Setting: different environments (clinic, outdoors, kitchen, gym, studio)
- Color palette: vary backgrounds, lighting temperatures
- Subject framing: different camera angles, distances, compositions
- Style: UGC vs editorial vs bold graphic vs data-forward

## Step 1: Strategic Framework

1. **Hormozi Value Equation:** Each ad must communicate at least 2 of: dream outcome, perceived likelihood, reduced time delay, reduced effort/sacrifice
2. **Brunson Hook-Story-Offer:** Every ad follows this structure. Hook stops the scroll. Story builds connection. Offer converts.
3. **UGC-First (70/30 Rule):** 70% of creative should look authentic/UGC. 30% polished brand content. UGC delivers 4x higher CTR, 50% lower CPC, 29% higher conversions. The "ugly ad" phenomenon is real. Raw, native-looking content outperforms studio work.
4. **Provider-as-Brand:** Derek-to-camera talking head videos will outperform every AI image. When generating static ads, design them to look like they belong in a feed next to organic content, not polished advertising.

## Step 2: Generate 5 Hook Variations

Write 5 opening hooks using different psychological triggers:
1. **Pattern Interrupt** - Contradicts what they expect
2. **Curiosity Gap** - Opens a loop they need closed
3. **Social Proof** - References results, community, or authority
4. **Loss Aversion** - What they're losing by NOT acting
5. **Urgency/Scarcity** - Time-bound or limited (only if real)

Each hook must work as a standalone scroll-stopper in the first 1-2 lines.

## Step 3: Generate 3 Ad Copy Variants

### Variant A: Short (50-80 words)
- Hook + benefit + CTA. Best for retargeting warm audiences.

### Variant B: Medium (120-180 words)
- Hook + problem agitation + solution + proof + CTA. PAS or AIDA format.

### Variant C: Long (250-350 words)
- Hook + story/transformation + benefits + objection handling + CTA. Storytelling with social proof.

**Copy rules:**
- Second person ("you"), warm authority
- Specific details (Prescott Valley, NP-led, body comp tracking) over generic claims
- No hype. No "amazing results." Be specific.
- NEVER use brand drug names (Ozempic, Wegovy, Mounjaro, Zepbound)
- Use: "physician-supervised," "medical weight loss," "GLP-1 therapy"

## Step 4: Visual Direction (Entity ID Diverse)

For each variant, assign a DIFFERENT visual format. Each must produce a distinct Entity ID:

| Variant | Recommended Format | Visual Strategy |
|---------|-------------------|-----------------|
| A (short/retargeting) | UGC-style video thumbnail or bold text-only | Dark bg, bold type, minimal imagery. OR phone-shot selfie style. |
| B (cold/education) | Infographic static or data-forward | Navy/dark bg with teal (#6CC3E0) + orange accents. Stats, numbers, clinical credibility. |
| C (long/trust) | Lifestyle photo or carousel | Warm, natural, authentic-looking. Real settings, real lighting. |

Always suggest at least one format that is NOT a static image (carousel or video direction).

## Step 4b: Image Generation (Gemini Realism Engine)

Generate a matching image for each variant using the Gemini JSON structured prompt system. The realism engine auto-injects camera specs, film stock, skin texture, and anti-AI negatives.

**For each image:**
1. Set `realism` based on purpose: "standard" for bold graphics/infographics, "high" for lifestyle/candid, "ultra" for hero/authority shots
2. Write `subject` as a narrative (brief a photographer, don't list keywords)
3. Choose `filmStock` for color science: `portra-400` for people, `ektar-100` for products, `gold-200` for outdoor lifestyle, `cinestill-800t` for moody/dramatic
4. Include `lightDirection` always (e.g., "from camera-left", "45 degrees from above")
5. Set distinct `camera`, `composition`, and `setting` per variant to ensure Entity ID diversity
6. Add `surfaceDetail` for realism (visible pores, dust in light, fabric texture, water condensation)
7. Check banned elements: no InBody/DEXA (use "body comp scale"), no brand drug names, no syringes, no stock-photo style

**Image tag format:**
```
[GEMINI_IMAGE: {"category":"lifestyle","subject":"narrative description","setting":"specific environment","camera":"medium-shot","lighting":"golden-hour","lightDirection":"from camera-left","composition":"rule-of-thirds","style":"lifestyle-candid","filmStock":"portra-400","aspectRatio":"4:5","mood":["confident","authentic"],"demographics":"specific person description","realism":"high"}]
```

**Aspect ratios:** 4:5 for feed (primary), 9:16 for Reels/Stories, 1:1 for carousel cards.

## Step 5: A/B Testing Plan

For each variant:
- **Hypothesis:** "If we [change], then [outcome] because [reasoning]"
- **Primary metric:** CTR for hooks, CPL for full creative, conversion rate for landing page
- **Test order:** Hook first (cheapest), then body copy, then CTA, then visual
- **Kill criteria:** <0.8% CTR after $50 spend = kill. CPL >$65 after 7 days = pause.
- **Refresh cadence:** 1-3 weeks per creative. Frequency >3.0 = warning, >4.0 = replace immediately.

**Performance thresholds (Andromeda era, healthcare):**
- CTR: >1.6% good, >2.5% excellent
- CPC: <$2.50 target
- CPL: <$35 great, <$50 acceptable, >$65 flag
- Frequency: <3.0 healthy, 3.0-4.0 warning, >4.0 danger
- LP CVR: >5% minimum, >8% good

## Step 6: Compliance

- **FTC:** No income/results guarantees. "Results may vary" near outcome claims.
- **Meta:** No before/after implying guaranteed results. No personal attribute targeting. No health claims implying diagnosis. No "you" + negative body reference together.
- **GLP-1 specific:** Frame as "medical weight management program." NEVER use "FDA" or "FDA-approved" in any ad copy, headlines, or descriptions. Say "provider-supervised" or "prescribed by licensed NP" instead. Results include lifestyle modifications. Focus on program experience, not the drug. Medical supervision angle.
- **Health/wellness category:** Websites classified as health lose bottom-of-funnel tracking. Use generic event names. Upper-funnel optimization preferred.
- **LegitScript:** If scaling to Google Ads, LegitScript certification required for GLP-1/weight loss.

Flag any line in generated copy that needs review before publishing.

## Step 7: Apply /humanizer

Final polish on all copy:
- Remove AI vocabulary (delve, tapestry, landscape, leverage, realm, testament, beacon, holistic, underscore, embark, foster, pivotal, cornerstone, paradigm, resonate, bespoke, nuanced)
- No em dashes (use periods and commas)
- Remove "not just X but Y" patterns
- Remove "Moreover," "Furthermore," "Additionally" openers
- No formulaic rule-of-three
- Output reads like a human marketer, not AI

## Output Format

```
AD CREATIVE ENGINE - [Campaign Goal]
=====================================

ENTITY ID STRATEGY
------------------
[1-2 sentences on how the 3 variants create visual diversity]

HOOKS (5 variations)
--------------------
1. [Pattern Interrupt]: ...
2. [Curiosity Gap]: ...
3. [Social Proof]: ...
4. [Loss Aversion]: ...
5. [Urgency/Scarcity]: ...

VARIANT A - SHORT [format type]
-------------------------------
[Copy]
CTA: [action]
[GEMINI_IMAGE: {full JSON prompt}]

VARIANT B - MEDIUM [format type]
---------------------------------
[Copy]
CTA: [action]
[GEMINI_IMAGE: {full JSON prompt}]

VARIANT C - LONG [format type]
-------------------------------
[Copy]
CTA: [action]
[GEMINI_IMAGE: {full JSON prompt}]

UGC DIRECTION
-------------
[Specific talking head / phone-shot video direction for Derek]

A/B TESTING PLAN
-----------------
[Hypotheses and metrics per variant]

COMPLIANCE CHECKLIST
--------------------
[Flags and required disclaimers]
=====================================
```
