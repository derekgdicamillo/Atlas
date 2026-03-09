---
name: ad-creative
description: >-
  Generate high-converting Facebook/Meta ad copy for PV MediSpa using Hormozi
  Core Four, marketing psychology hooks, Blakely scrappy testing, and Thiel
  contrarian positioning. Use when Derek says "ad copy", "Facebook ad",
  "Meta ad", "ad creative", or wants ad variations for a campaign.
allowed-tools:
  - Read
  - Glob
  - Grep
context: fork
user-invocable: true
argument-hint: <campaign goal or offer>
---
# Ad Creative Engine

## Input Handling

**With $ARGUMENTS:** Use the campaign goal or offer provided (e.g., "semaglutide launch", "$199 first month", "free body comp consult").
**Without $ARGUMENTS:** Default to the clinic's core offer: medical weight loss with GLP-1 therapy (semaglutide/tirzepatide) at PV MediSpa & Weight Loss, Scottsdale/Phoenix area.

## PV MediSpa Context

- **Services:** GLP-1 medical weight loss (semaglutide, tirzepatide), body composition tracking, functional wellness
- **Market:** Scottsdale/Phoenix, AZ. Competitive med spa landscape.
- **Differentiators:** NP-led, 5-Pillar framework (not just injections), body comp scale tracking, personalized care plans, Vitality Unchained Tribe community
- **Named frameworks:** SLOW & SHIELD, Vitality Tracker, Protein Paradox, Fuel Code, Calm Core Toolkit, Cooling Fuel Protocol, Movement Hierarchy
- **Tracking:** Body comp SCALE. Never mention InBody or DEXA.
- **Landing page:** https://landing.pvmedispa.com/weightloss
- **Tone:** Warm, clinical authority without being clinical. Friend who happens to be a medical provider.

## Step 1: Strategic Framework Selection

Apply these BI frameworks to the campaign goal:

- **Hormozi Core Four:** Determine which channel applies (paid ads primary, but consider warm outreach angles for retargeting and content angles for organic amplification)
- **Hormozi Value Equation:** Maximize dream outcome + perceived likelihood of achievement, minimize time delay + effort/sacrifice. Every ad must communicate at least 2 of these.
- **Thiel Contrarian Positioning:** What does PV believe that most weight loss clinics don't? (e.g., "medication alone isn't enough," "body comp matters more than scale weight," "NP-led beats algorithm-driven telehealth")
- **Blakely Scrappy Execution:** Design for low-budget creative testing. No expensive production needed. UGC-style, talking head, or simple graphic formats.

## Step 2: Generate 5 Hook Variations

Write 5 opening hooks (1-2 sentences each) using different psychological triggers:

1. **Pattern Interrupt** - Contradicts what they expect to see in their feed
2. **Curiosity Gap** - Opens a loop they need closed
3. **Social Proof** - References results, community, or authority
4. **Loss Aversion** - What they're losing by NOT acting
5. **Urgency/Scarcity** - Time-bound or limited availability (only if real, never fabricated)

Each hook must work as a standalone scroll-stopper in the first 1-2 lines of a Facebook ad.

## Step 3: Generate 3 Ad Copy Variants

Write 3 complete ad copy variants using the best hooks from Step 2:

### Variant A: Short (50-80 words)
- Single hook + benefit + CTA
- Best for: retargeting warm audiences, simple offers
- Format: direct response, minimal storytelling

### Variant B: Medium (120-180 words)
- Hook + problem agitation + solution + proof element + CTA
- Best for: cold audiences, education-first approach
- Format: PAS (Problem-Agitate-Solve) or AIDA

### Variant C: Long (250-350 words)
- Hook + story/transformation + multiple benefits + objection handling + CTA
- Best for: cold audiences, complex offers, building trust
- Format: storytelling with embedded social proof

**For all variants:**
- Write in second person ("you") with warm authority
- Include specific details (Scottsdale, NP-led, body comp tracking) over generic claims
- End with clear CTA pointing to landing page or booking
- No hype language. No "amazing results" or "life-changing." Be specific instead.

## Step 4: Visual Direction & CTA Options

Suggest 3 visual directions:
1. **UGC/talking head** - Description of what Derek or a team member says on camera (Blakely low-budget approach)
2. **Before/after or transformation** - How to frame without violating platform policies
3. **Educational graphic** - Text overlay concept for static image ad

Suggest 3 CTA options ranked by friction level:
- Low friction (learn more, watch video)
- Medium friction (book free consult, take the quiz)
- High friction (schedule appointment, call now)

## Step 4b: Image Generation

Generate a matching ad image for each ad copy variant (A, B, C). Read `memory/brand-style-guide.md` for brand rules and prompt structure. The image prompt must be derived from each variant's specific copy content and visual direction.

For each variant:

1. Classify the image into one of the 5 brand categories (lifestyle, educational, authority, offer, community) based on what the ad copy describes
2. Build a Gemini-optimized prompt following the brand guide's prompt engineering rules:
   - Start with the image category
   - Include specific subject, setting, and lighting direction derived from the ad copy
   - Reference brand colors when relevant (PV teal #6CC3E0)
   - End with "high quality, professional photography style, no watermarks"
   - Specify aspect ratio (square 1:1 for feed, vertical 9:16 for Stories)
3. Validate against banned elements (no InBody/DEXA, no brand drug names like Ozempic/Wegovy/Mounjaro/Zepbound, no before/after splits, no syringes, no stock-photo style)
4. Output the prompt as a `[GEMINI_IMAGE:]` tag immediately after the variant's copy

Images auto-save to `data/images/` and copy to OneDrive (`02_Marketing/Ad_Creative/Ad Images/`). They also send to Telegram for preview.

## Step 5: A/B Testing Plan

For each of the 3 ad copy variants, provide:
- **Hypothesis:** "If we [change], then [expected outcome] because [reasoning]"
- **Primary metric:** (CTR, CPL, conversion rate, etc.)
- **Test duration:** Minimum sample size or budget before calling a winner
- **Kill criteria:** When to stop a losing variant

Structure the test as: Hook test first (cheapest variable to test), then body copy, then CTA, then visual.

## Step 6: Compliance Notes

Include a compliance checklist for each ad:
- **FTC:** No income/results guarantees. "Results may vary" or "Individual results depend on..." required near any outcome claims. Testimonials need "results not typical" if using specific numbers.
- **Meta Ads Policy:** No before/after images that imply guaranteed results. No personal attributes targeting ("Are you overweight?"). No health claims that imply diagnosis. Avoid "you" + negative body reference in same sentence.
- **Weight loss specific:** Frame as "medical weight management program" not "weight loss cure." Medication is FDA-approved, prescribed by licensed NP. Always mention that results include lifestyle modifications, not medication alone.
- **Arizona:** No state-specific advertising restrictions beyond federal, but include clinic license/NPI if required by platform.

Flag any line in the generated copy that needs review before publishing.

## Step 7: Apply /humanizer

As final step, clean all ad copy output:
- Remove inflated symbolism and promotional language
- No em dashes (use periods and commas)
- Replace AI vocabulary (delve, tapestry, landscape, multifaceted, leverage, realm, testament, beacon, holistic, spearhead, underscore, embark, foster, pivotal, cornerstone, paradigm, resonate, bespoke, poignant, nuanced) with plain words
- Remove "not just X but Y" patterns
- Remove "Moreover," "Furthermore," "Additionally" openers
- No rule-of-three where it feels formulaic
- Output should read like a human marketer wrote it, not AI

## Output Format

```
AD CREATIVE ENGINE - [Campaign Goal]
=====================================

HOOKS (5 variations)
--------------------
1. [Pattern Interrupt]: ...
2. [Curiosity Gap]: ...
3. [Social Proof]: ...
4. [Loss Aversion]: ...
5. [Urgency/Scarcity]: ...

VARIANT A - SHORT (retargeting/warm)
-------------------------------------
[Copy]
CTA: [action]
[GEMINI_IMAGE: category + subject/setting derived from this variant's copy + lighting + brand color ref + "high quality, professional photography style, no watermarks, square 1:1"]

VARIANT B - MEDIUM (cold/education)
------------------------------------
[Copy]
CTA: [action]
[GEMINI_IMAGE: category + subject/setting derived from this variant's copy + lighting + brand color ref + "high quality, professional photography style, no watermarks, square 1:1"]

VARIANT C - LONG (cold/trust-building)
---------------------------------------
[Copy]
CTA: [action]
[GEMINI_IMAGE: category + subject/setting derived from this variant's copy + lighting + brand color ref + "high quality, professional photography style, no watermarks, square 1:1"]

VISUAL DIRECTION
----------------
1. UGC: [description]
2. Transformation: [description]
3. Educational: [description]

CTA OPTIONS (low -> high friction)
----------------------------------
1. [low]
2. [medium]
3. [high]

A/B TESTING PLAN
-----------------
[Hypothesis and metrics for each variant]

COMPLIANCE CHECKLIST
--------------------
[Flags and required disclaimers]
=====================================
```
