---
name: landing-page-cro
description: >-
  Audit and optimize landing pages for conversion rate. Scores 8 CRO
  dimensions, identifies conversion killers via Munger inversion, rewrites
  weak sections with BI framework reasoning, and delivers a prioritized
  action plan. Use when Derek says "audit the landing page", "CRO review",
  "why isn't the page converting", or "optimize landing page".
allowed-tools:
  - Read
  - Glob
  - Grep
  - WebFetch
  - WebSearch
context: fork
user-invocable: true
argument-hint: "<url>"
---
# Landing Page CRO Auditor

Audit any landing page for conversion rate optimization using business intelligence frameworks, then deliver scored findings, rewritten copy, and a prioritized action plan.

## PV Context
- Primary landing page: `https://landing.pvmedispa.com/weightloss`
- Focus: GLP-1 weight loss, functional medical weight loss
- 5 Pillars: Precision Weight Science, Nourishing Health, Dynamic Movement, Mindful Wellness, Functional Wellness
- Named frameworks patients see: SLOW & SHIELD, Vitality Tracker, Protein Paradox, Fuel Code, Calm Core Toolkit, Cooling Fuel Protocol
- Competitors: local med spas, national telehealth (Calibrate, Found, Ro Body), bariatric surgeons
- Clinic uses body comp SCALE (never mention InBody or DEXA)

## Input Handling

**If $ARGUMENTS contains a URL:** Use that URL.
**If $ARGUMENTS is empty:** Default to `https://landing.pvmedispa.com/weightloss`.
**If $ARGUMENTS is a keyword** (e.g., "weightloss", "homepage"): Map to known PV page or ask.

## Workflow

### Step 1: Fetch & Parse the Page

Use WebFetch to retrieve the page content. Extract:
- All headings (H1, H2, H3)
- Body copy and section structure
- CTAs (buttons, forms, links)
- Social proof elements (testimonials, reviews, stats, logos)
- Trust signals (certifications, guarantees, provider bios)
- Form fields and friction points
- Image/video references
- Above-the-fold content vs below

### Step 2: Score 8 CRO Dimensions (1-10 each)

Score each dimension. Provide a 1-2 sentence justification per score.

| # | Dimension | What to evaluate |
|---|-----------|-----------------|
| 1 | **Headline Clarity** | Does the H1 pass the 5-second test? Does it state the outcome, not the mechanism? (Hormozi: dream outcome clarity) |
| 2 | **Value Proposition** | Is the offer a Grand Slam? Score using Hormozi Value Equation: Dream Outcome x Perceived Likelihood / Time Delay x Effort & Sacrifice. Does it answer "why here, why now?" |
| 3 | **Social Proof** | Quantity and quality of testimonials, before/afters, review counts, trust badges. Specificity matters (lbs lost, timeframe, name). |
| 4 | **Trust Signals** | Provider credentials, clinic photos, certifications, guarantees, HIPAA mentions, insurance/payment transparency. (Bezos: reduce customer risk) |
| 5 | **CTA Strength** | Is the primary CTA visible, specific, low-friction? Does button copy state the benefit, not the action? Multiple CTAs or one clear path? |
| 6 | **Objection Handling** | Does the page preemptively answer: cost concerns, "will it work for me", side effects, time commitment, "what if I fail again"? (Munger: invert and destroy objections) |
| 7 | **Mobile Experience** | Responsive layout cues, form length, tap target sizing, scroll depth, load indicators. Note: full mobile audit requires browser, so assess from markup/structure. |
| 8 | **Page Speed Indicators** | Image optimization hints, script bloat, render-blocking resources, lazy loading. Note from markup only. Suggest running PageSpeed Insights for full data. |

**Overall CRO Score** = average of 8 dimensions, displayed prominently.

### Step 3: Conversion Killer Analysis (Munger Inversion)

Apply Munger's inversion: "What would guarantee this page does NOT convert?"

Identify the **top 3 conversion killers** by asking:
1. What creates confusion? (unclear offer, competing CTAs, jargon)
2. What creates fear? (hidden costs, no social proof, no guarantee)
3. What creates friction? (long forms, slow load, too many steps)
4. What's missing entirely? (no urgency, no specificity, no differentiation)

For each killer, state:
- **The problem** (what's wrong)
- **The inversion** (what would make it worse, proving this matters)
- **The fix** (specific, actionable change)

### Step 4: Competitive Positioning Check (Thiel)

Apply Thiel's monopoly question: "What can this page claim that NO competitor can?"

Evaluate whether the page communicates:
- A unique mechanism or proprietary framework (e.g., 5-Pillar system)
- A specific result competitors can't match
- A category of one positioning (not "another weight loss clinic")

If weak, suggest positioning language that creates separation.

### Step 5: Revenue Impact Estimate (Cunningham)

Connect CRO to money using Cunningham's financial drivers:
- Estimate current conversion rate range based on page quality
- Model what a 1-2 point CR improvement means for monthly revenue
- Use PV context: average patient value, ad spend, traffic estimates
- Frame recommendations in dollars, not just percentages

### Step 6: Rewrite Weak Sections

For the 3 lowest-scoring dimensions, generate rewritten copy:
- **Headline alternatives** (3 options, ranked)
- **Value proposition rewrite** using Hormozi Value Equation structure
- **CTA rewrites** with benefit-driven button copy
- **Objection-handling section** if missing or weak

For each rewrite, note which framework drives the change and why.

**Apply /humanizer as final step on all rewritten copy.** Remove AI patterns before delivering.

### Step 7: Prioritized Action Plan

Deliver a table of recommended changes, sorted by impact/effort ratio:

| Priority | Change | Dimension | Impact (1-5) | Effort (1-5) | Framework | Notes |
|----------|--------|-----------|--------------|--------------|-----------|-------|
| 1 | ... | ... | ... | ... | ... | ... |

Impact/Effort scoring:
- **Impact 5** = directly increases conversions (headline, CTA, offer)
- **Impact 1** = marginal or indirect improvement
- **Effort 5** = requires dev work, design, or major restructuring
- **Effort 1** = copy change, can be done in 5 minutes

## Output Format

Structure the final output as:

```
## Landing Page CRO Audit: [page title or URL]

### Overall Score: X.X / 10

### Dimension Scores
[table with scores and justifications]

### Top 3 Conversion Killers
[Munger inversion analysis]

### Competitive Positioning
[Thiel monopoly check]

### Revenue Impact
[Cunningham financial driver estimate]

### Rewritten Sections
[framework-backed rewrites, humanized]

### Action Plan
[prioritized table]

### Next Steps
[2-3 concrete next actions Derek should take]
```

## Notes
- If page returns an error or redirect, report the issue and suggest alternatives.
- For full mobile/speed audits, recommend running Google PageSpeed Insights and sharing the results for deeper analysis.
- This skill produces patient-facing copy. Always apply /humanizer before delivering rewrites.
- When auditing competitor pages, skip the PV-specific context and focus on what PV can learn.
