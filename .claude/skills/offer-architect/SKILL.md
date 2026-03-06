---
name: offer-architect
description: >-
  Build irresistible med spa offers using Hormozi Grand Slam framework, Value
  Equation scoring, CLOSER script, Buffett pricing power, Cunningham unit
  economics, and Walton EDLP principles. Use when Derek says "build an offer",
  "price this", "offer stack", "package pricing", or wants to architect a new
  service package.
allowed-tools:
  - Read
  - Glob
  - Grep
  - WebSearch
  - WebFetch
context: fork
user-invocable: true
argument-hint: "<service or package description>"
---
# Offer Architect

Build irresistible offers for PV Medispa & Weight Loss using cross-referenced business frameworks.

## Handling $ARGUMENTS

- **With args**: Use the service/package description as the offer to architect.
  Examples: "GLP-1 starter package", "6-month weight loss program", "tiered membership model"
- **No args**: Ask Derek what service or package he wants to build/evaluate.
- **"audit" + description**: Evaluate an existing offer against the frameworks.
- **"compare" + two descriptions**: Side-by-side analysis of two offer structures.

## PV MediSpa Context

Always apply these when building offers:
- **Core service**: GLP-1 medical weight loss (semaglutide, tirzepatide)
- **5 Pillars framework**: Precision Weight Science, Nourishing Health, Dynamic Movement, Mindful Wellness, Functional Wellness
- **Named tools**: Vitality Tracker, Fuel Code, Fuel Code Plate, Protein Paradox, Calm Core Toolkit, Cooling Fuel Protocol, Movement Hierarchy, SLOW & SHIELD
- **Tracking**: Body comp SCALE (never mention InBody or DEXA)
- **Community**: Vitality Unchained Tribe (Skool group)
- **2025 revenue**: ~$670k, ~$97k net. 2026 target: 30% net margin.
- **Strategic context**: Local clinic scaling, possible telemedicine expansion, Skool as value-add vs standalone product

## Step 1: Gather Offer Details

From $ARGUMENTS and any existing context, identify:
- Service name and description
- Current pricing (if exists)
- Target patient profile
- Delivery method (in-clinic, virtual, hybrid)
- Duration/frequency
- What's currently included vs what could be added

If details are thin, search memory and project files for existing pricing, programs, or packages:
- Read `memory/` for relevant business context
- Grep `config/` for existing offer or pricing data
- Check GHL products via `/ghl-products list` context if relevant

## Step 2: Grand Slam Offer Analysis (Hormozi)

Evaluate and design along 4 axes. Score each 1-10:

**Dream Outcome** (what they really want)
- Not "lose weight" but "feel confident, fit into old clothes, get off meds, have energy"
- Map to specific PV Pillar outcomes

**Perceived Likelihood of Achievement** (do they believe it'll work?)
- What proof elements exist? Body comp data, patient results, clinical evidence
- What guarantees or risk-reversals can we add?

**Time Delay** (how fast do they see results?)
- What quick wins happen in week 1-2? (appetite change, energy, first weigh-in)
- How do we make the timeline feel short?

**Effort & Sacrifice** (how hard is it for them?)
- What do we do FOR them vs ask them to do themselves?
- Where can we reduce friction? (meal plans, pre-built workouts, done-for-you tracking)

**Value Equation**: Value = (Dream Outcome x Perceived Likelihood) / (Time Delay x Effort)
Calculate a composite score. Higher = more irresistible.

## Step 3: Offer Stack Design

Build the "value stack" that makes the price feel trivial:
1. **Core offer**: The primary service/treatment
2. **Bonus 1**: A tool or framework that reduces effort (e.g., Fuel Code meal plan)
3. **Bonus 2**: A community or accountability element (e.g., Skool access, check-in calls)
4. **Bonus 3**: A speed enhancer that reduces time delay (e.g., body comp tracking, weekly provider touchpoints)
5. **Urgency/scarcity element**: Cohort-based, limited slots, seasonal pricing
6. **Risk reversal**: Guarantee structure (satisfaction, progress-based, money-back conditions)

Assign a perceived dollar value to each stack item. Total perceived value should be 5-10x the actual price.

## Step 4: Price Architecture (Buffett + Walton + Cunningham)

**Buffett Pricing Power Test**:
- Can we raise prices 10% without losing patients? Why or why not?
- What moat protects this pricing? (provider expertise, proprietary frameworks, results data)

**Walton EDLP Principles**:
- Is this everyday pricing or promotional? Avoid discount addiction.
- Does the price communicate value or cheapness?

**Cunningham Unit Economics** (4 Financial Drivers):
- **Revenue per patient**: Price x frequency x duration
- **Cost to deliver**: Provider time, medication cost, overhead allocation, tech/tools
- **Gross margin**: Revenue minus direct costs
- **LTV projection**: Average patient lifespan x revenue per visit x referral multiplier

Build 2-3 pricing tiers:
- **Starter/Essential**: Core service, minimal extras. Entry point.
- **Recommended/Growth**: Core + key bonuses. Best margin, best value perception.
- **Premium/VIP**: Everything + concierge touches. Highest LTV.

For each tier, calculate: price, COGS, gross margin %, projected monthly revenue at target volume.

## Step 5: CLOSER Script Outline (Hormozi)

Generate a consultation framework:
- **C**larify: Questions to understand their situation ("Tell me about your weight loss history")
- **L**abel: Name their problem with authority ("What you're describing is metabolic adaptation")
- **O**verview: Paint the solution at 30,000 feet ("Our 5-Pillar approach addresses exactly this")
- **S**ell: Present the offer stack with value anchoring ("Normally the meal planning alone is $X")
- **E**xplain: Handle objections before they arise (cost, time, "I've tried everything")
- **R**einforce: Urgency + next step ("We have 3 spots in the March cohort")

Include 2-3 common objection responses specific to med spa weight loss:
- "It's too expensive" -> reframe cost per day, compare to current spending
- "I've tried everything" -> differentiate medical approach from diet programs
- "What if it doesn't work?" -> risk reversal, clinical evidence, body comp tracking

## Step 6: Output the Blueprint

Format the final output as:

```
OFFER BLUEPRINT: [Service Name]
================================

GRAND SLAM SCORE
  Dream Outcome:        [X]/10 - [brief note]
  Perceived Likelihood: [X]/10 - [brief note]
  Time Delay:           [X]/10 - [brief note]
  Effort & Sacrifice:   [X]/10 - [brief note]
  VALUE EQUATION SCORE: [calculated]

OFFER STACK
  Core: [description] (value: $X)
  Bonus 1: [description] (value: $X)
  Bonus 2: [description] (value: $X)
  Bonus 3: [description] (value: $X)
  Risk Reversal: [description]
  Total Perceived Value: $X
  Asking Price: $X (Tier: [name])

PRICING TIERS
  [Tier table with price, COGS, margin, projected monthly rev]

UNIT ECONOMICS
  Revenue/patient: $X
  Cost to deliver: $X
  Gross margin: X%
  Projected LTV: $X

CLOSER SCRIPT OUTLINE
  [Framework with specific questions and talk tracks]

PRICING POWER NOTES
  [Buffett moat analysis, Walton EDLP check]

RECOMMENDATIONS
  [2-3 specific next steps to implement or test this offer]
```

## Step 7: Apply Humanizer

If any part of this output will be patient-facing (consultation scripts, marketing copy), run /humanizer as final polish. The blueprint itself is internal/strategic, so humanizer applies only to patient-facing sections.

## Competitive Research (Optional)

If Derek asks to benchmark against competitors, use WebSearch to:
- Find local med spa GLP-1 pricing in the Phoenix/Prescott Valley area
- Compare offer structures (what's included at each price point)
- Identify gaps PV can exploit (what competitors don't offer)
