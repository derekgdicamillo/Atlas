---
name: patient-journey
description: >-
  Map and optimize the full patient lifecycle from ad click to long-term retention.
  Identifies drop-off points, diagnoses root causes, designs interventions, and
  calculates revenue impact. Use when Derek says "patient journey", "drop-off",
  "retention problem", "why are patients leaving", "funnel analysis", or wants to
  optimize any stage of the patient lifecycle.
allowed-tools:
  - Read
  - Glob
  - Grep
context: fork
user-invocable: true
argument-hint: "<journey stage or problem area>"
---
# Patient Journey Mapper

Map and optimize PV MediSpa's full patient lifecycle using cross-referenced BI frameworks.

## Handling $ARGUMENTS

- **With stage**: Focus analysis on that stage. Examples: "new lead to consultation", "month 3 drop-off", "onboarding", "referral generation"
- **With problem**: Diagnose the problem area. Examples: "patients ghosting after month 2", "low show rate", "nobody joining Skool"
- **"full"**: Map the entire journey end-to-end with all stages.
- **No args**: Ask Derek which stage or problem to focus on.

## PV MediSpa Context

Always reference when building journey maps:
- **Core service**: GLP-1 medical weight loss (semaglutide, tirzepatide)
- **Pipeline (GHL)**: Lead In > Appointment Scheduled > Appointment Showed > Closed/Won > Active Patient > Retention stages
- **5 Pillars**: Precision Weight Science, Nourishing Health, Dynamic Movement, Mindful Wellness, Functional Wellness
- **Named frameworks**: Vitality Tracker, Fuel Code, Fuel Code Plate, Protein Paradox, Calm Core Toolkit, Cooling Fuel Protocol, Movement Hierarchy, SLOW & SHIELD
- **Tracking**: Body comp SCALE (never InBody or DEXA)
- **Community**: Vitality Unchained Tribe (Skool group)
- **Nurture**: 12-week email series mapping to 5 Pillars (see `12-week-email-series.md`)
- **Financials**: ~$670k rev (2025), 30% net margin target (2026)
- **Content engine**: Skool longform -> Facebook hooks -> newsletter -> YouTube

## The Full Patient Journey (10 Stages)

```
Ad/Content -> Lead Capture -> Speed-to-Lead -> Consultation -> Close
-> Onboarding -> Month 1-3 -> Month 3-6 -> Month 6-12 -> Retention/Referral
```

For each stage, map: touchpoints, owner (front desk/provider/automation), success metric, known drop-off risk, and framework-driven intervention.

## Step 1: Identify the Focus Area

From $ARGUMENTS, determine which stage(s) to analyze. Search project context for relevant data:
- Read `memory/` for business metrics, content performance, competitive intel
- Grep for pipeline data, conversion rates, or patient retention context
- Check `12-week-email-series.md` for nurture sequence alignment

## Step 2: Map Current State

For each stage in scope, document:
- **Touchpoints**: What the patient experiences (ads, calls, emails, visits, Skool posts)
- **Automation**: What GHL workflows/emails/SMS fire at this stage
- **Success metric**: The conversion that moves them to the next stage
- **Current performance**: Use available pipeline/dashboard data context if provided
- **Drop-off signals**: What indicates a patient is slipping (no-show, missed email opens, no body comp check-in)

## Step 3: Diagnose Drop-offs (Dalio 5-Step Process)

For each identified drop-off point, run Dalio's framework:

1. **Goal**: What should happen at this stage? (e.g., 80% show rate for consultations)
2. **Problem**: What's actually happening? (e.g., 60% show rate, 40% ghost after booking)
3. **Diagnosis**: Root cause analysis. Is it: speed-to-lead lag? Weak pre-consult nurture? Price shock at close? No accountability post-onboarding? Pillar fatigue at month 3?
4. **Design**: Specific intervention. Map to the right framework (see Step 4).
5. **Execute**: Concrete implementation steps (GHL workflow, Skool content, email sequence, staff protocol)

## Step 4: Design Interventions (Framework Selection)

Match each drop-off to the right BI framework:

**Hormozi Core Four** (patient acquisition stages):
- Ad/Content -> Lead: Dream outcome messaging, pattern interrupts, proof-first creative
- Lead -> Consultation: Speed-to-lead protocol, value-first outreach, risk reversal in booking confirmation
- Consultation -> Close: CLOSER script, offer stack, objection handling, social proof

**Buffett Moat Building** (retention stages):
- Switching costs: Body comp history only lives here, personalized Fuel Code, provider relationship
- Brand loyalty: 5 Pillars education makes them "know too much to leave," named frameworks create identity
- Network effects: Skool community, patient referral program, group accountability

**Walton Culture Principles** (experience quality):
- Staff greeting protocol, consistent experience, "always the low-cost provider of VALUE"
- Every patient touchpoint reinforces: "this place is different"

**Bezos Flywheel** (system-level optimization):
- Better patient results -> more reviews/referrals -> lower CAC -> more investment in experience -> better results
- Map which stages feed the flywheel and which stages leak energy from it

## Step 5: Calculate Revenue Impact (Cunningham 4 Drivers)

For each intervention, estimate impact on the 4 financial drivers:

1. **Revenue per patient**: Does this increase visit frequency, add services, extend LTV?
2. **Patient count**: Does this improve conversion rate, reduce churn, generate referrals?
3. **COGS**: Does this increase or decrease cost to deliver? (Provider time, medication, tools)
4. **Operating expenses**: What does implementation cost? (Staff time, software, ad spend)

Calculate: If we fix [drop-off] and improve [metric] by [X%], the annual revenue impact is approximately $[Y].

Use PV's baseline: ~$670k revenue, current patient count, average revenue per patient from context.

## Step 6: Map the Flywheel (Bezos)

Show how retained patients compound value:
```
Retained Patient
  -> Body comp results (proof for marketing)
  -> Skool engagement (community value for new patients)
  -> Google/Facebook reviews (lower CAC)
  -> Word-of-mouth referrals (free acquisition)
  -> Higher LTV (more revenue per patient)
  -> Funds better experience (reinvestment)
  -> Loop back to retained patient
```

Identify where the flywheel is broken (which connection is weakest) and prioritize fixing that link.

## Step 7: Output the Journey Map

Format the final output as:

```
PATIENT JOURNEY MAP: [Focus Area]
====================================

STAGE ANALYSIS
  [Stage]: [Current metric] -> [Target metric]
  Drop-off: [description]
  Root cause (Dalio): [diagnosis]
  Intervention: [specific action]
  Framework: [which BI framework and why]

REVENUE IMPACT (Cunningham Drivers)
  [Intervention 1]: +$[X]/yr ([which driver])
  [Intervention 2]: +$[X]/yr ([which driver])
  Total addressable impact: $[X]/yr

FLYWHEEL STATUS
  Strongest link: [description]
  Weakest link: [description]
  Fix priority: [what to fix first and why]

MOAT ASSESSMENT (Buffett)
  Switching costs: [low/med/high] - [why]
  Brand loyalty: [low/med/high] - [why]
  Network effects: [low/med/high] - [why]

IMPLEMENTATION PLAN
  1. [Immediate: this week]
  2. [Short-term: this month]
  3. [Medium-term: this quarter]

  Each step: what to do, who owns it, what GHL/Skool/email automation supports it.
```

## Step 8: Prioritize

Rank all interventions by: (revenue impact x ease of implementation) / cost. The highest-leverage, lowest-effort fix goes first. Always give Derek a clear "do this first" recommendation.
