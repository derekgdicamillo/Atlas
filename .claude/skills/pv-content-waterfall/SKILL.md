---
name: pv-content-waterfall
description: >-
  Generate a content waterfall for PV Medispa. Skool longform -> 3 Facebook
  hook posts -> email newsletter draft -> YouTube outline. Rotates through
  all 5 Pillars with variety.
allowed-tools:
  - Read
  - Write
  - Glob
context: fork
user-invocable: true
---
# PV Content Waterfall

## CRITICAL: Fully Autonomous Execution

This skill runs non-interactively via cron (`claude -p`). There is no human on the other end to answer questions.

**Rules:**
- DO NOT use the AskUserQuestion tool. It will break the pipeline.
- DO NOT ask for confirmation, preferences, or input of any kind.
- DO NOT output questions, menus, or options for the user to choose from.
- Auto-select ALL parameters (pillar, subtopic, format, audience) using the rotation state and the rules below.
- Your ONLY output must be the finished content waterfall text. Nothing else.
- If any data is missing or a file doesn't exist, use sensible defaults and proceed. Never stop to ask.
- NEVER fabricate specific patient stories with invented details (age, weight numbers, timelines, specific outcomes). General clinical observations are OK ("I see this three times a week," "patients often tell me"). If a real patient story is needed, Derek will provide it. Fabricated anecdotes erode trust and read as fake.

## Task

Generate a full content waterfall for PV Medispa & Weight Loss. The output flows from a deep Skool post down to Facebook hooks, a newsletter draft, and a YouTube outline.

## Step 1: Read Rotation State

Read `memory/content-rotation.json`. This file tracks:
- `lastPillar`: number (1-5) of the last pillar used
- `lastSubtopic`: the subtopic string last used
- `lastFormat`: the content format last used
- `lastDate`: ISO date of last run
- `recentTopics`: array of the last 10 `{ pillar, subtopic, format, date }` entries

If the file doesn't exist or is empty, treat `lastPillar` as 0 and `recentTopics` as empty.

## Step 2: Auto-Select Next Pillar

Advance to the next pillar in strict rotation order. The next pillar number is `(lastPillar % 5) + 1`, wrapping from 5 back to 1.

The 5 Pillars:
1. **Precision Weight Science** - tracking, body comp, metabolic science, GLP-1 mechanism
2. **Nourishing Health** - nutrition, protein, hydration, meal strategies
3. **Dynamic Movement** - strength training, walking, exercise programming
4. **Mindful Wellness** - stress, sleep, emotional health, cortisol
5. **Functional Wellness** - inflammation, gut health, hormones, supplements

## Step 3: Auto-Select Subtopic

You MUST pick a subtopic yourself from the selected pillar's bank below. Do NOT pick any subtopic that appears in `recentTopics` from the last 5 entries. Pick the one that provides the most variety compared to recent content. Make this decision autonomously.

### Pillar 1 - Precision Weight Science
- Body composition vs scale weight (why the number lies)
- Metabolic rate explained (BMR, TDEE, adaptive thermogenesis)
- GLP-1 mechanism of action (how the medication actually works)
- Realistic weight loss timelines (what to expect month by month)
- Vitality Tracker deep dive (tracking beyond just weight)
- Set point theory and metabolic adaptation
- Why weight loss isn't linear (plateaus are normal)
- Body recomposition on GLP-1 (losing fat, keeping muscle)
- Lab markers that actually matter for metabolic health
- Understanding insulin resistance and how GLP-1s address it

### Pillar 2 - Nourishing Health
- Protein Paradox (eating enough when appetite is gone)
- Fuel Code basics (building your nutrition framework)
- Fuel Code Plate (visual meal composition)
- Hydration and electrolytes on GLP-1s
- Meal prep strategies for low appetite days
- Eating out while on GLP-1 therapy
- Micronutrient deficiencies to watch for
- The role of fiber in GLP-1 success
- Nausea management through food choices
- Intermittent fasting: helpful or harmful on GLP-1s?

### Pillar 3 - Dynamic Movement
- Movement Hierarchy (strength > walking > cardio)
- Why strength training is non-negotiable on GLP-1s
- Progressive overload for absolute beginners
- Step count strategies (10k steps without a gym)
- Exercise modifications for different fitness levels
- The Strength & Movement Blueprint walkthrough
- Muscle preservation during rapid weight loss
- Recovery and rest days (why more isn't always better)
- Home vs gym workouts for weight loss patients
- How exercise affects GLP-1 efficacy

### Pillar 4 - Mindful Wellness
- Calm Core Toolkit introduction
- Cortisol and weight loss resistance
- Sleep optimization (the most underrated weight loss tool)
- Emotional eating: patterns and alternatives
- Stress management that doesn't feel woo-woo
- The gut-brain connection and food cravings
- Building body image during transformation
- Social pressure and identity shift during weight loss
- Mindfulness practices for busy people
- How to handle unsolicited comments about your weight loss

### Pillar 5 - Functional Wellness
- Cooling Fuel Protocol (anti-inflammatory nutrition)
- Gut health and the microbiome in weight management
- Inflammation markers: CRP, ESR, what they mean
- Thyroid function and weight loss
- Hormone balance (estrogen, testosterone, cortisol)
- Evidence-based supplement guide (Vitamin D, magnesium, omega-3, B12)
- The inflammation-obesity cycle
- Gut permeability and metabolic endotoxemia
- Functional lab panels: what to ask your provider
- Detox pathways and liver support (evidence-based, not woo)

## Step 4: Auto-Select Content Format

You MUST pick the format yourself. Rotate the format so it differs from the last 2 entries in `recentTopics`. Choose from:

1. **Educational deep dive** (primary format, 500-800 words) - thorough explanation of the concept
2. **Myth-buster** (200-300 words) - "Myth: X. Reality: Y" structure with evidence
3. **Transformation / clinical observation** - general patterns Derek sees in clinic (e.g. "I hear this from patients," "I see this three times a week"). NEVER fabricate specific patient anecdotes with invented details (age, weight numbers, timelines, outcomes). Those read as fake and erode trust.
4. **Challenge post** (7-day action challenge) - daily micro-actions readers can follow
5. **Weekly check-in / engagement prompt** - open-ended question that invites sharing
6. **Research breakdown** (cite a recent study) - accessible summary of clinical evidence

## Step 5: Read Voice Guide

Read `memory/voice-guide.md` and apply ALL rules throughout the content. Key rules:

- **No** "Let's be real" or "Let's talk about" openers. Just start.
- **No** meta-framing ("What I tell patients," "Here's what I use," "I use a three-tier approach")
- Minimal bold formatting. Let the words carry weight.
- Tone is friend-texting-advice, not provider-writing-content.
- Ellipsis (...) for natural pauses and transitions.
- Include the scientific reasoning behind outcomes.
- Person-first language always ("people with obesity" not "obese people").
- Frame medication as legitimate medical tool, not shortcut.
- "Healthy eating" not "diet." "Physical activity" not "exercise regimen."
- No scare tactics, shame, or guilt.
- Collaborative tone: "we'll work together" not "you should do X."
- Personal anecdotes use complete first-person sentences, not fragments.
- Celebrate non-scale victories alongside scale progress.
- **Patient stories rule**: General clinical observations are OK ("I hear this from patients," "I see this probably three times a week"). NEVER fabricate specific patient anecdotes with invented details (age, weight numbers, timelines, outcomes). If citing a real patient story, Derek will provide it.

## Step 6: Generate the Waterfall

Produce ALL of the following sections in a single output. Use the selected pillar, subtopic, and format.

### 6a. Skool Post (Longform)

- 500-800 words (adjust based on format type, myth-busters are shorter)
- Teaches the subtopic concept thoroughly
- Ends with a discussion question to drive comments
- Uses Derek's voice from the voice guide
- References named frameworks by exact name when relevant: SLOW & SHIELD, Vitality Tracker, Protein Paradox, Fuel Code, Fuel Code Plate, Calm Core Toolkit, Cooling Fuel Protocol, Movement Hierarchy
- Clinic uses body comp SCALE. Never mention InBody or DEXA.
- No forced CTAs. Discussion question should feel natural.

### 6b. Facebook Posts (3 separate posts)

Each post is 100-200 words with a different hook style:

1. **Pain point hook** - Opens with the frustration or struggle the audience feels
2. **Curiosity hook** - Opens with a surprising fact or counterintuitive insight
3. **Transformation hook** - Opens with a before/after contrast or result

Each Facebook post should:
- Stand alone (don't assume reader saw the Skool post)
- End with a soft CTA (comment, share, or visit link)
- Include an **X (Twitter) version**: condensed to under 280 characters. Same core message, punchy and direct. No hashtags needed.
- Output a `[GEMINI_IMAGE:]` tag AFTER the post copy. The image prompt must be DERIVED from the hook's specific content (not generic). Read `memory/brand-style-guide.md` for image prompt engineering rules and banned elements. Each prompt must:
  1. Start with the image category (lifestyle, educational, authority, offer, community). Infer from the hook content.
  2. Include specific subject and setting description drawn from what the hook talks about.
  3. Include lighting direction ("warm natural light", "golden hour Arizona", etc.)
  4. Include brand color reference when relevant ("accent color PV teal #6CC3E0")
  5. End with "high quality, professional photography style, no watermarks, square 1:1"
  6. Validate against banned elements: no InBody/DEXA (use "body comp scale"), no brand drug names (Ozempic/Wegovy/Mounjaro/Zepbound), no syringes, no before/after splits, no stock-photo style

### 6c. Email Newsletter

- 300-500 words
- Personal and story-driven (first-person from Derek)
- Opens with a relatable anecdote or observation
- Teaches 1-2 key takeaways from the pillar/subtopic
- Links to the Skool community for deeper discussion
- Subject line included (compelling, not clickbait)
- Preview text included (first line that shows in inbox)

### 6d. YouTube Outline

- **Title**: searchable, benefit-driven (under 60 chars)
- **Hook** (first 30 seconds): what the viewer will learn and why it matters
- **Key Points** (3-5): the main teaching segments with time estimates
- **CTA**: subscribe, comment, link to clinic
- **Thumbnail concept**: text overlay + visual description for Derek or designer
- **Description draft**: 2-3 sentences + relevant links

## Step 7: Update Rotation State

After generating content, write the updated state to `memory/content-rotation.json`:

```json
{
  "lastPillar": <pillar number used (1-5)>,
  "lastSubtopic": "<subtopic string used>",
  "lastFormat": "<format name used>",
  "lastDate": "<today's ISO date>",
  "recentTopics": [
    ...previous entries (keep last 9),
    {
      "pillar": <number>,
      "subtopic": "<string>",
      "format": "<string>",
      "date": "<ISO date>"
    }
  ]
}
```

Keep only the last 10 entries in `recentTopics`. Drop the oldest if there are more.

## Step 8: Apply Humanizer

As the final step before outputting the content, apply these rules to all generated text:
- Remove inflated symbolism and promotional language
- Remove superficial "-ing" analyses and vague attributions
- Avoid em dashes (use periods and commas instead)
- Remove rule of three patterns where they feel formulaic
- Replace AI vocabulary words (delve, tapestry, landscape, multifaceted, nuanced, pivotal, cornerstone, paradigm, embark, foster, leverage, realm, testament, beacon, resonate, holistic, spearhead, underscore, bespoke, poignant) with plain alternatives
- Remove negative parallelisms ("not just X but Y")
- Remove excessive conjunctive phrases ("Moreover," "Furthermore," "Additionally")
- Content should read like a human wrote it, not like AI polished it

## Step 9: Output Format

Your output MUST be the finished waterfall content below. No preamble, no questions, no commentary. Just the waterfall.

```
CONTENT WATERFALL - [Date]
Pillar: [Name] | Subtopic: [Name] | Format: [Type]
========================================

SKOOL POST
----------
[Title]

[Content]

X VERSION (SKOOL TEASER): [under 280 chars, teases the Skool post topic]

FACEBOOK POST 1 - Pain Point Hook
----------------------------------
[Content]
X VERSION: [under 280 chars]
[GEMINI_IMAGE: category + subject/setting derived from this hook's content + lighting + brand color ref + "high quality, professional photography style, no watermarks, square 1:1"]

FACEBOOK POST 2 - Curiosity Hook
---------------------------------
[Content]
X VERSION: [under 280 chars]
[GEMINI_IMAGE: category + subject/setting derived from this hook's content + lighting + brand color ref + "high quality, professional photography style, no watermarks, square 1:1"]

FACEBOOK POST 3 - Transformation Hook
--------------------------------------
[Content]
X VERSION: [under 280 chars]
[GEMINI_IMAGE: category + subject/setting derived from this hook's content + lighting + brand color ref + "high quality, professional photography style, no watermarks, square 1:1"]

EMAIL NEWSLETTER
----------------
Subject: [subject line]
Preview: [preview text]

[Content]

YOUTUBE OUTLINE
---------------
Title: [title]
Hook: [first 30 seconds script]
Key Points:
1. [point] (~X min)
2. [point] (~X min)
3. [point] (~X min)
CTA: [call to action]
Thumbnail: [concept]
Description: [draft]

========================================
Rotation updated: Pillar [N] -> next will be Pillar [N+1]
```
