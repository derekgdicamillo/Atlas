/**
 * Care Plan Generator Module
 *
 * Generates 5-pillar care plans for GLP-1 weight loss patients using
 * Vitality Unchained knowledge base, clinical evidence, and adjunct
 * therapy decision logic.
 *
 * Usage: /careplan in Telegram, or Claude self-generates via
 * [CAREPLAN: patient data] intent tag.
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { info, warn, error as logError } from "./logger.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// TYPES
// ============================================================

export interface PatientIntake {
  // Demographics
  name?: string;
  age?: number;
  sex?: "M" | "F";
  height?: string;

  // Current measurements
  weight?: number;
  bmi?: number;
  bodyFatPct?: number;
  muscleMassPct?: number;
  visceralFat?: number;
  waist?: number;
  hips?: number;
  thigh?: number;
  arm?: number;

  // Previous measurements (for comparison)
  prev?: {
    date?: string;
    weight?: number;
    bmi?: number;
    bodyFatPct?: number;
    muscleMassPct?: number;
    visceralFat?: number;
    waist?: number;
    hips?: number;
    thigh?: number;
    arm?: number;
  };

  // Medications
  glp1Med?: string; // semaglutide, tirzepatide, liraglutide
  glp1Dose?: string;
  glp1StartDate?: string;
  otherMeds?: string[];
  supplements?: string[];

  // Labs
  labs?: {
    insulin?: number;
    insulinBaseline?: number;
    a1c?: number;
    protein?: number;
    albumin?: number;
    ast?: number;
    alt?: number;
    astBaseline?: number;
    altBaseline?: number;
    ferritin?: number;
    vitaminD?: number;
    b12?: number;
    tsh?: number;
    testosterone?: number;
    estradiol?: number;
    dheas?: number;
  };

  // History
  comorbidities?: string[];
  weightLossHistory?: string;

  // Lifestyle
  diet?: string;
  proteinIntake?: number; // grams/day estimated
  waterIntake?: number; // oz/day
  exercise?: string;
  sleep?: string;
  stressLevel?: string;

  // Complaints
  complaints?: string[];
  sideEffects?: string[];

  // Provider note (free text)
  providerNote?: string;
}

export interface CarePlanSection {
  pillar: string;
  pillarNumber: number;
  problem: string;
  interventions: string[];
  resources: string[];
  priority: "critical" | "high" | "moderate" | "low";
}

export interface AdjunctRecommendation {
  name: string;
  category: "medication" | "supplement" | "hormone" | "pipeline";
  mechanism: string;
  evidence: string;
  dosing: string;
  contraindications: string;
  patientFit: "high" | "moderate" | "low";
  fitRationale: string;
  monthlyCost?: string;
  availability: "now" | "2026" | "2027+" ;
}

export interface CarePlan {
  generatedAt: string;
  patient: PatientIntake;
  compositionAnalysis: string;
  pillarSections: CarePlanSection[];
  adjunctTherapies: AdjunctRecommendation[];
  sideEffectManagement: string;
  labRecommendations: string[];
  thirtyDayGoals: Record<string, { baseline: string; target: string }>;
  talkingPoints: string[];
  escalationPath: string;
}

// ============================================================
// KNOWLEDGE BASE LOADING
// ============================================================

let knowledgeBase: string = "";
let knowledgeLoaded = false;

async function loadKnowledgeBase(): Promise<void> {
  if (knowledgeLoaded) return;
  try {
    const files = [
      "memory/skool-vitality-unchained.md",
      "memory/skool-video-transcripts.md",
      "memory/skool-pdf-resources.md",
    ];
    const contents = await Promise.all(
      files.map((f) =>
        readFile(join(PROJECT_ROOT, f), "utf-8").catch(() => "")
      )
    );
    knowledgeBase = contents.filter(Boolean).join("\n\n---\n\n");
    knowledgeLoaded = true;
    info("careplan", `Knowledge base loaded: ${(knowledgeBase.length / 1024).toFixed(1)}KB`);
  } catch (err) {
    logError("careplan", `Failed to load knowledge base: ${err}`);
  }
}

// ============================================================
// COMPOSITION ANALYSIS
// ============================================================

function analyzeComposition(patient: PatientIntake): string {
  const lines: string[] = [];

  if (patient.prev) {
    lines.push("BODY COMPOSITION TREND ANALYSIS");
    lines.push("═".repeat(40));

    const metrics = [
      { label: "BMI", curr: patient.bmi, prev: patient.prev.bmi, unit: "", lower_better: true },
      { label: "Body Fat %", curr: patient.bodyFatPct, prev: patient.prev.bodyFatPct, unit: "%", lower_better: true },
      { label: "Muscle Mass %", curr: patient.muscleMassPct, prev: patient.prev.muscleMassPct, unit: "%", lower_better: false },
      { label: "Visceral Fat", curr: patient.visceralFat, prev: patient.prev.visceralFat, unit: "", lower_better: true },
      { label: "Waist", curr: patient.waist, prev: patient.prev.waist, unit: '"', lower_better: true },
      { label: "Hips", curr: patient.hips, prev: patient.prev.hips, unit: '"', lower_better: true },
      { label: "Thigh", curr: patient.thigh, prev: patient.prev.thigh, unit: '"', lower_better: true },
      { label: "Arm", curr: patient.arm, prev: patient.prev.arm, unit: '"', lower_better: true },
    ];

    for (const m of metrics) {
      if (m.curr != null && m.prev != null) {
        const delta = m.curr - m.prev;
        const arrow = delta === 0 ? "→" : delta > 0 ? (m.lower_better ? "▲ CONCERN" : "▲ GOOD") : (m.lower_better ? "▼ GOOD" : "▼ CONCERN");
        lines.push(`${m.label}: ${m.prev}${m.unit} -> ${m.curr}${m.unit} (${delta > 0 ? "+" : ""}${delta.toFixed(1)}) ${arrow}`);
      }
    }
    lines.push("");
  }

  // Flag critical patterns
  const flags: string[] = [];

  if (patient.muscleMassPct != null && patient.prev?.muscleMassPct != null) {
    if (patient.muscleMassPct <= patient.prev.muscleMassPct) {
      flags.push("MUSCLE MASS NOT IMPROVING: Patient is losing weight but muscle % is flat or declining. Indicates lean mass loss proportional to fat loss. Protein and resistance training intervention critical.");
    }
  }

  if (patient.waist != null && patient.prev?.waist != null) {
    if (patient.waist > patient.prev.waist && patient.hips != null && patient.prev?.hips != null && patient.hips < patient.prev.hips) {
      flags.push("CENTRAL ADIPOSITY PATTERN: Waist increased while hips decreased. Pattern consistent with cortisol-driven visceral fat retention or hormonal component. Assess stress management and consider hormone panel.");
    }
  }

  if (patient.visceralFat != null && patient.prev?.visceralFat != null) {
    if (patient.visceralFat >= patient.prev.visceralFat) {
      flags.push("VISCERAL FAT UNCHANGED: Despite overall weight loss, visceral fat has not improved. May indicate insulin resistance persistence, chronic inflammation, or inadequate movement.");
    }
  }

  if (patient.bodyFatPct != null && patient.prev?.bodyFatPct != null) {
    const fatDelta = patient.prev.bodyFatPct - patient.bodyFatPct;
    if (fatDelta < 1.0 && patient.bmi != null && patient.prev?.bmi != null && patient.prev.bmi - patient.bmi > 1.0) {
      flags.push("LOW-QUALITY WEIGHT LOSS: BMI dropped significantly but body fat % barely changed. A meaningful portion of weight lost was NOT fat. Muscle preservation interventions needed urgently.");
    }
  }

  if (flags.length > 0) {
    lines.push("CLINICAL FLAGS");
    lines.push("-".repeat(30));
    flags.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
    lines.push("");
  }

  // Lab analysis
  if (patient.labs) {
    lines.push("LAB TREND ANALYSIS");
    lines.push("-".repeat(30));

    if (patient.labs.insulin != null) {
      const status = patient.labs.insulin < 7 ? "AT GOAL" : patient.labs.insulin < 15 ? "IMPROVING" : "ELEVATED";
      lines.push(`Insulin: ${patient.labs.insulin} (${status}${patient.labs.insulinBaseline ? `, baseline: ${patient.labs.insulinBaseline}` : ""})`);
      if (patient.labs.insulinBaseline && patient.labs.insulin < patient.labs.insulinBaseline) {
        const reduction = ((1 - patient.labs.insulin / patient.labs.insulinBaseline) * 100).toFixed(0);
        lines.push(`  -> ${reduction}% reduction from baseline. ${patient.labs.insulin < 7 ? "Insulin resistance resolving." : "Improving but not yet at goal."}`);
      }
    }

    if (patient.labs.ferritin != null) {
      const status = patient.labs.ferritin < 30 ? "LOW - may explain fatigue, hair loss, brain fog" : patient.labs.ferritin < 50 ? "SUBOPTIMAL" : "ADEQUATE";
      lines.push(`Ferritin: ${patient.labs.ferritin} (${status})`);
    }

    if (patient.labs.vitaminD != null) {
      const status = patient.labs.vitaminD < 30 ? "INSUFFICIENT" : patient.labs.vitaminD < 50 ? "SUBOPTIMAL" : "OPTIMAL";
      lines.push(`Vitamin D: ${patient.labs.vitaminD} (${status}, target 50-70)`);
    }

    if (patient.labs.b12 != null) {
      const status = patient.labs.b12 < 300 ? "BORDERLINE LOW - supplement recommended" : patient.labs.b12 < 500 ? "ADEQUATE" : "OPTIMAL";
      lines.push(`B12: ${patient.labs.b12} (${status})`);
    }

    if (patient.labs.ast != null || patient.labs.alt != null) {
      const ast = patient.labs.ast;
      const alt = patient.labs.alt;
      const prev = patient.labs.astBaseline || patient.labs.altBaseline;
      lines.push(`AST/ALT: ${ast || "N/A"}/${alt || "N/A"} ${prev ? `(baseline: ${prev}, improving)` : ""}`);
    }

    if (patient.labs.tsh != null) {
      const status = patient.labs.tsh > 3.0 ? "SUBOPTIMAL for weight loss (target 1-2)" : patient.labs.tsh < 0.5 ? "LOW - evaluate" : "OPTIMAL RANGE";
      lines.push(`TSH: ${patient.labs.tsh} (${status})`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================
// 5-PILLAR MAPPING
// ============================================================

function mapPillars(patient: PatientIntake): CarePlanSection[] {
  const sections: CarePlanSection[] = [];

  // PILLAR 1: Precision Weight Science
  const p1Interventions: string[] = [];
  const p1Problem: string[] = [];

  if (patient.complaints?.some((c) => /scale|weight|stall|plateau|frustrat/i.test(c))) {
    p1Problem.push("Patient is frustrated with weight loss progress or fixated on scale weight.");
    p1Interventions.push("Introduce GLP-1 Vitality Tracker (7 metrics) to shift from scale-only to comprehensive progress tracking");
    p1Interventions.push("Reframe success: highlight metabolic wins (insulin, liver function, circumference changes) alongside weight");
  }

  if (patient.muscleMassPct != null && patient.prev?.muscleMassPct != null && patient.muscleMassPct <= patient.prev.muscleMassPct) {
    p1Problem.push("Muscle mass percentage has not improved despite weight loss, indicating lean mass loss.");
    p1Interventions.push("Schedule body comp SCALE measurement every 4 weeks to track fat mass vs lean mass in absolute pounds");
    p1Interventions.push("Set composition-based goals: fat loss + muscle preservation, not just total pounds");
  }

  p1Interventions.push("Weekly check-in on all 7 Vitality Tracker metrics, not just weight");

  sections.push({
    pillar: "Precision Weight Science",
    pillarNumber: 1,
    problem: p1Problem.join(" ") || "Establish comprehensive progress tracking beyond the scale.",
    interventions: p1Interventions,
    resources: ["GLP-1 Vitality Tracker (PDF)"],
    priority: patient.complaints?.some((c) => /frustrat|stall|plateau/i.test(c)) ? "high" : "moderate",
  });

  // PILLAR 2: Nourishing Health
  const p2Interventions: string[] = [];
  const p2Problem: string[] = [];
  const p2Resources: string[] = [];

  const estimatedProtein = patient.proteinIntake || 0;
  if (estimatedProtein < 80) {
    p2Problem.push(`Protein intake critically low (~${estimatedProtein}g/day). Target: 0.7-0.9g/lb goal weight.`);
    p2Interventions.push("PRIORITY: Increase protein to minimum 100g/day. 30-40g per meal across 3 meals + 1 snack");
    p2Interventions.push("Protein first at every meal: eat protein before fiber, then everything else");
    p2Interventions.push("Consider whey protein isolate or casein shake to hit targets without volume (Protein Paradox)");
    p2Resources.push("High Protein Foods for GLP-1 (PDF)");
    p2Resources.push("VU Protein Guide (PDF)");
  }

  const estimatedWater = patient.waterIntake || 0;
  if (estimatedWater < 64) {
    p2Problem.push(`Hydration likely inadequate (~${estimatedWater}oz/day). Target: half body weight in ounces.`);
    p2Interventions.push(`Hydration target: ${patient.weight ? Math.round(patient.weight / 2) : 80}+ oz/day. Start with 64oz, increase weekly`);
  }

  p2Interventions.push("Track food intake for 1 week to establish actual baseline (no judgment, just data)");
  p2Interventions.push("Gradually increase fiber to 25-30g/day for satiety, GI regularity, and anti-inflammatory benefit");
  p2Resources.push("Fast Food Survival Guide (PDF)");
  p2Resources.push("NASM Essentials Cookbook (PDF)");

  sections.push({
    pillar: "Nourishing Health (Fuel Code)",
    pillarNumber: 2,
    problem: p2Problem.join(" ") || "Assess and optimize protein, hydration, and fiber intake on GLP-1 therapy.",
    interventions: p2Interventions,
    resources: p2Resources,
    priority: estimatedProtein < 60 ? "critical" : estimatedProtein < 80 ? "high" : "moderate",
  });

  // PILLAR 3: Dynamic Movement
  const p3Interventions: string[] = [];
  const p3Problem: string[] = [];

  const noExercise = !patient.exercise || /none|sedentary|no exercise|no workout/i.test(patient.exercise);

  if (noExercise) {
    p3Problem.push("No structured exercise program. Muscle loss risk is high with GLP-1 therapy without resistance training.");
    p3Interventions.push("START: Beginner At Home Workout Guide, 3x/week (Mon/Wed/Fri). Bodyweight first, 15-20 min sessions");
    p3Interventions.push("Exercise reframe: not burning calories (medication handles deficit). Exercise = metabolic armor, signal to keep muscle");
  } else if (!/resist|strength|weight/i.test(patient.exercise)) {
    p3Problem.push("Exercise present but no resistance training component. Cardio alone does not preserve lean mass on GLP-1.");
    p3Interventions.push("ADD resistance training 3x/week minimum. Even bodyweight exercises count. Prioritize over cardio");
  }

  p3Interventions.push("NEAT targets: assess current daily steps, set initial goal of 5,000/day. Walk after meals");
  p3Interventions.push("Movement hierarchy: Resistance first, Cardio second, NEAT always");

  sections.push({
    pillar: "Dynamic Movement",
    pillarNumber: 3,
    problem: p3Problem.join(" ") || "Optimize exercise for muscle preservation and metabolic health.",
    interventions: p3Interventions,
    resources: ["Beginner At Home Workout Guide (PDF)", "NEAT Movement Guide (PDF)"],
    priority: noExercise ? "critical" : "high",
  });

  // PILLAR 4: Mindful Wellness
  const p4Interventions: string[] = [];
  const p4Problem: string[] = [];

  const poorSleep = patient.sleep && /poor|bad|5|4|3|insomnia|wak/i.test(patient.sleep);

  if (poorSleep) {
    p4Problem.push("Sleep quality or duration is suboptimal. Poor sleep elevates cortisol, drives insulin resistance and belly fat storage.");
    p4Interventions.push("Sleep target: 7+ hours. Start with consistent bedtime (even 15 min earlier per week)");
    p4Interventions.push("Screen cutoff 30 min before bed");
  }

  if (patient.waist != null && patient.prev?.waist != null && patient.waist >= patient.prev.waist) {
    p4Problem.push("Waist increase despite overall weight loss may indicate cortisol-driven central fat retention.");
  }

  p4Interventions.push("Morning light exposure within 30 min of waking (free cortisol reset)");
  p4Interventions.push("Daily 5-minute stress reset: box breathing (4-4-4-4), body scan, or guided meditation");
  p4Interventions.push("Magnesium glycinate before bed (supports calm + sleep + GLP-1 GI management)");

  sections.push({
    pillar: "Mindful Wellness",
    pillarNumber: 4,
    problem: p4Problem.join(" ") || "Support stress management and sleep optimization for metabolic health.",
    interventions: p4Interventions,
    resources: ["Introduction to Meditation (PDF)"],
    priority: poorSleep ? "high" : "moderate",
  });

  // PILLAR 5: Functional Wellness
  const p5Interventions: string[] = [];
  const p5Problem: string[] = [];
  const p5Resources: string[] = [];

  if (patient.labs?.ferritin != null && patient.labs.ferritin < 30) {
    p5Problem.push(`Ferritin ${patient.labs.ferritin} (low). Explains fatigue, hair loss, brain fog.`);
    p5Interventions.push("Iron protocol: Ferrous bisglycinate 45mg 2x/day + Vitamin C 2000mg (enhances absorption)");
    p5Resources.push("Vitality Unchained Iron Protocol (PDF)");
  }

  if (patient.labs?.vitaminD != null && patient.labs.vitaminD < 30) {
    p5Interventions.push(`Vitamin D3 5000 IU + K2 100mcg daily (current level: ${patient.labs.vitaminD}, target: 50-70)`);
  } else if (patient.supplements?.some((s) => /vitamin d|d3/i.test(s))) {
    p5Interventions.push("Continue current Vitamin D3+K2. Check 25-OH-D level at next labs to verify dosing");
  } else {
    p5Interventions.push("Consider Vitamin D3+K2 supplementation. Order 25-OH-D at next labs");
  }

  if (patient.labs?.b12 != null && patient.labs.b12 < 400) {
    p5Interventions.push(`B12 (methylcobalamin) 1000mcg sublingual daily (current: ${patient.labs.b12}). GLP-1s reduce intake via appetite suppression`);
  } else if (!patient.labs?.b12) {
    p5Interventions.push("Add B12 (methylcobalamin) 1000mcg sublingual daily. GLP-1s reduce B12 intake. Order level at next labs");
  }

  p5Interventions.push("Magnesium glycinate 400mg nightly (sleep + GI motility + muscle recovery)");
  p5Interventions.push("Cooling Protocol: pick 3+/day from anti-inflammatory checklist (colorful produce, 25-30g fiber, healthy fats)");
  p5Resources.push("Top 10 Forms of Magnesium (PDF)");
  p5Resources.push("Water Soluble Vitamins List (PDF)");
  p5Resources.push("Fat Soluble Vitamins List (PDF)");

  sections.push({
    pillar: "Functional Wellness (Cooling Protocol)",
    pillarNumber: 5,
    problem: p5Problem.join(" ") || "Optimize micronutrient status and reduce inflammation on GLP-1 therapy.",
    interventions: p5Interventions,
    resources: p5Resources,
    priority: (patient.labs?.ferritin != null && patient.labs.ferritin < 30) ? "high" : "moderate",
  });

  return sections;
}

// ============================================================
// ADJUNCT THERAPY ENGINE
// ============================================================

function recommendAdjuncts(patient: PatientIntake): AdjunctRecommendation[] {
  const recs: AdjunctRecommendation[] = [];

  // 1. Metformin
  const hasInsulinResistance = (patient.labs?.insulin != null && patient.labs.insulin > 7) ||
    (patient.labs?.insulinBaseline != null && patient.labs.insulinBaseline > 15) ||
    patient.comorbidities?.some((c) => /insulin|pre-diabet|pcos|metabolic/i.test(c));

  const waistIncreasing = patient.waist != null && patient.prev?.waist != null && patient.waist >= patient.prev.waist;

  recs.push({
    name: "Metformin",
    category: "medication",
    mechanism: "Sensitizes peripheral tissues to insulin, reduces hepatic glucose output, and increases endogenous GLP-1 secretion. Different pathway than injected GLP-1, additive effect.",
    evidence: "ADA 2026 Standards: GLP-1 + metformin yields 1-2% additional A1c reduction. Combination shows greater fat reduction and weight loss than either alone. Decades of safety data.",
    dosing: "500mg extended-release daily with dinner, titrate by 500mg every 2 weeks to 1500mg target.",
    contraindications: "eGFR <30, acute kidney injury, metabolic acidosis. Use caution with heavy alcohol use.",
    patientFit: hasInsulinResistance || waistIncreasing ? "high" : "moderate",
    fitRationale: hasInsulinResistance
      ? "Documented insulin resistance history. Metformin attacks different receptor pathway than GLP-1. Central adiposity pattern strengthens case."
      : "No documented insulin resistance, but may still benefit from GLP-1 amplification and metabolic support.",
    monthlyCost: "$4-15 generic",
    availability: "now",
  });

  // 2. Phentermine
  const hasHypertension = patient.comorbidities?.some((c) => /hypertension|high blood pressure|htn/i.test(c));

  recs.push({
    name: "Phentermine",
    category: "medication",
    mechanism: "Sympathomimetic amine. Increases norepinephrine release, suppressing appetite through different pathway than GLP-1. Also increases resting metabolic rate.",
    evidence: "Most commonly combined adjunct in obesity medicine practice. Case reports show GLP-1 + phentermine + topiramate + metformin achieving 32.5% TBWL, approaching bariatric surgery. No formal RCTs for this specific pairing.",
    dosing: "15mg or 37.5mg daily in morning. Some providers use 8mg for tolerability. FDA-approved short-term (12 weeks), often used longer with monitoring.",
    contraindications: "Uncontrolled hypertension, cardiovascular disease, hyperthyroidism, glaucoma, MAOIs. Monitor BP weekly first month.",
    patientFit: hasHypertension ? "low" : "moderate",
    fitRationale: hasHypertension
      ? "Patient has hypertension (controlled). Use with caution and close BP monitoring only if other interventions fail."
      : "Reasonable escalation option if lifestyle + metformin don't break plateau within 8 weeks.",
    monthlyCost: "$10-30 generic",
    availability: "now",
  });

  // 3. Contrave (Naltrexone/Bupropion)
  const hasCravings = patient.complaints?.some((c) => /crav|food noise|emotional eat|binge|comfort eat/i.test(c));

  recs.push({
    name: "Naltrexone/Bupropion (Contrave)",
    category: "medication",
    mechanism: "Naltrexone blocks opioid receptors (kills food reward signal). Bupropion increases dopamine/norepinephrine (reduces cravings, lifts mood). Targets hedonic eating that GLP-1s don't fully address.",
    evidence: "Retrospective cohort: addition to GLP-1 associated with 4.0-5.3% additional TBWL. Effective in GLP-1 non-responders. 2025 data: reduces weight without worsening depression.",
    dosing: "Start 8mg/90mg daily, titrate over 4 weeks to 16mg/180mg twice daily.",
    contraindications: "Seizure disorders, eating disorders (bulimia/anorexia), uncontrolled hypertension, opioid use, MAOIs.",
    patientFit: hasCravings ? "high" : "low",
    fitRationale: hasCravings
      ? "Patient reports food noise/cravings/emotional eating. This directly targets the reward pathway GLP-1s miss."
      : "Patient's primary issue appears to be under-fueling, not overconsumption. GLP-1 has appetite suppressed. Contrave more appropriate if food tracking reveals hedonic eating patterns.",
    monthlyCost: "$50-100 generic components; $300+ brand Contrave",
    availability: "now",
  });

  // 4. Low-dose Topiramate
  const hasBrainFog = patient.complaints?.some((c) => /brain fog|cognitive|memory|focus/i.test(c));

  recs.push({
    name: "Low-Dose Topiramate",
    category: "medication",
    mechanism: "Carbonic anhydrase inhibitor with GABA modulation. Suppresses appetite via different brain circuits than GLP-1. Anti-inflammatory properties.",
    evidence: "Phentermine/topiramate (Qsymia) is second most effective AOM after GLP-1s (9.1% avg weight loss). Generic available 2025. Low-dose (25-50mg) used off-label as GLP-1 adjunct.",
    dosing: "25mg nightly, can titrate to 50mg.",
    contraindications: "Glaucoma, hyperthyroidism, kidney stones. Main concern: cognitive dulling (word-finding difficulty, brain fog).",
    patientFit: hasBrainFog ? "low" : "moderate",
    fitRationale: hasBrainFog
      ? "Patient already reports brain fog. Topiramate's most common side effect is cognitive dulling, which would worsen this. Consider only after nutrient deficiencies (iron, B12, D) are corrected."
      : "Second-line option if lifestyle + metformin don't break plateau over 8-12 weeks.",
    monthlyCost: "$10-25 generic",
    availability: "now",
  });

  // 5. SGLT2 Inhibitor
  recs.push({
    name: "SGLT2 Inhibitor (Empagliflozin/Dapagliflozin)",
    category: "medication",
    mechanism: "Blocks glucose reabsorption in kidneys. Patient excretes ~70-80g glucose/day (~280-320 calories). Reduces visceral fat, blood pressure, and has cardio/renal protective effects.",
    evidence: "Additive weight loss of 2-5 kg over GLP-1 alone. Meta-analysis: specifically reduces visceral fat (dose-dependent). Additional BP reduction ~3-5 mmHg systolic.",
    dosing: "Empagliflozin 10-25mg daily or Dapagliflozin 10mg daily.",
    contraindications: "Recurrent UTIs, yeast infections (increased glucose in urine). Type 1 diabetes. Monitor hydration. Off-label for weight loss in non-diabetics.",
    patientFit: waistIncreasing && hasInsulinResistance ? "high" : waistIncreasing ? "moderate" : "low",
    fitRationale: waistIncreasing
      ? "Waist increased despite overall weight loss. SGLT2i specifically targets visceral fat. Caloric excretion provides extra 280+ cal/day deficit without appetite suppression."
      : "May add incremental weight loss and metabolic benefits but not a priority without visceral fat concerns.",
    monthlyCost: "$15-50 GoodRx; $500+ brand",
    availability: "now",
  });

  // 6. Tirzepatide switch
  const onSemaglutide = patient.glp1Med && /semaglutide/i.test(patient.glp1Med);

  if (onSemaglutide) {
    recs.push({
      name: "Switch to Tirzepatide (dual GLP-1/GIP agonist)",
      category: "medication",
      mechanism: "Dual GLP-1 + GIP receptor agonist. GIP activation adds enhanced insulin secretion, improved fat metabolism, and potentially better muscle-sparing properties.",
      evidence: "SURMOUNT-5 head-to-head: tirzepatide 20.2% weight loss vs semaglutide 13.7% at 72 weeks. Greater waist circumference reduction. Consistent superiority in meta-analyses.",
      dosing: "Start 2.5mg weekly, titrate monthly. Max 15mg.",
      contraindications: "Same as semaglutide (MTC/MEN2 history, pancreatitis, severe allergic reaction).",
      patientFit: waistIncreasing ? "high" : "moderate",
      fitRationale: waistIncreasing
        ? "Greater waist circumference reduction vs semaglutide directly addresses this patient's central adiposity pattern. Consider before stacking multiple adjuncts."
        : "More potent than semaglutide across all measures. Simpler than adding multiple adjuncts. Check insurance coverage.",
      monthlyCost: "$1,000+ brand (check insurance)",
      availability: "now",
    });
  }

  // 7. Muscle preservation stack (supplements)
  const losingMuscle = patient.muscleMassPct != null && patient.prev?.muscleMassPct != null && patient.muscleMassPct <= patient.prev.muscleMassPct;
  const armShrinking = patient.arm != null && patient.prev?.arm != null && patient.arm < patient.prev.arm;

  recs.push({
    name: "Creatine Monohydrate",
    category: "supplement",
    mechanism: "Draws water into muscle cells, creating more anabolic environment and reducing catabolism. Most evidence-backed supplement for muscle preservation during weight loss.",
    evidence: "Preserved up to 60% more lean mass vs non-supplemented controls during caloric restriction. Decades of safety data. No interaction with GLP-1 medications.",
    dosing: "3-5g daily with any meal. No loading phase needed.",
    contraindications: "None significant. Safe for long-term use. Stay hydrated.",
    patientFit: losingMuscle || armShrinking ? "high" : "moderate",
    fitRationale: losingMuscle
      ? "Muscle mass flat/declining, limb circumference dropping. Combined with resistance training + adequate protein, this is the triple play for preservation."
      : "Preventive muscle preservation support during GLP-1-induced weight loss.",
    monthlyCost: "$15",
    availability: "now",
  });

  recs.push({
    name: "HMB (Beta-Hydroxy-Beta-Methylbutyrate)",
    category: "supplement",
    mechanism: "Leucine metabolite that directly reduces muscle protein breakdown. Different pathway than creatine (creatine builds, HMB protects).",
    evidence: "2025 meta-analysis: positive effect on appendicular skeletal muscle mass and lean mass, particularly in adults over 50. Most effective in untrained individuals during caloric deficit.",
    dosing: "3g/day divided into 3 doses (1g with each meal). Available as calcium HMB.",
    contraindications: "None significant.",
    patientFit: losingMuscle && noExercise(patient) ? "high" : "moderate",
    fitRationale: losingMuscle
      ? "Complements creatine. Creatine supports building, HMB prevents breakdown. Particularly useful since patient is untrained and in caloric deficit."
      : "Additive muscle preservation benefit. Consider if budget allows.",
    monthlyCost: "$25-30",
    availability: "now",
  });

  recs.push({
    name: "Omega-3 (High-Dose EPA/DHA)",
    category: "supplement",
    mechanism: "Anti-inflammatory via eicosanoid pathways. May enhance lean mass retention through reduced oxidative stress. Complements GLP-1's own anti-inflammatory properties (Cooling Protocol).",
    evidence: "Therapeutic doses (4g/day EPA+DHA) lower triglycerides. Modulates satiety in overweight/obese individuals. Supports the Cooling Protocol from Pillar 5.",
    dosing: "2-4g combined EPA+DHA daily. High-quality fish oil or algae-based.",
    contraindications: "Blood thinners (monitor INR). Fish allergy (use algae-based).",
    patientFit: waistIncreasing ? "high" : "moderate",
    fitRationale: waistIncreasing
      ? "Waist increase despite weight loss signals inflammation. Omega-3 + anti-inflammatory diet is the non-pharmaceutical approach to visceral fat."
      : "General anti-inflammatory and metabolic support during GLP-1 therapy.",
    monthlyCost: "$20",
    availability: "now",
  });

  // 8. Hormone optimization
  const noHormonePanel = !patient.labs?.testosterone && !patient.labs?.estradiol && !patient.labs?.tsh;

  if (noHormonePanel) {
    recs.push({
      name: "Hormone Panel Assessment",
      category: "hormone",
      mechanism: "Declining sex hormones contribute to central fat accumulation, difficulty maintaining muscle, fatigue, and brain fog. Fat loss from GLP-1 can naturally improve hormone levels via reduced aromatase activity.",
      evidence: "GLP-1 medications independently increase testosterone via visceral fat reduction. Combination of GLP-1 + HRT/TRT addresses central adiposity, bone loss, and metabolic slowdown. Guidelines recommend weight loss FIRST, then assess hormones.",
      dosing: "Order: Estradiol, progesterone, total/free testosterone, DHEA-S, TSH, free T3/T4, SHBG. Intervene if suboptimal after 3-4 months on GLP-1.",
      contraindications: "Hormone-sensitive cancers. Individual assessment required.",
      patientFit: losingMuscle || waistIncreasing ? "high" : "moderate",
      fitRationale: "Body composition pattern (central adiposity, muscle loss, limb shrinkage) is consistent with hormonal decline. Cannot determine without labs. Order panel.",
      availability: "now",
    });
  }

  // 9. Pipeline drugs
  recs.push({
    name: "CagriSema (Semaglutide + Cagrilintide)",
    category: "pipeline",
    mechanism: "Fixed-dose semaglutide 2.4mg + cagrilintide 2.4mg (amylin analog). Amylin slows gastric emptying, suppresses glucagon, promotes satiety via different pathways than GLP-1.",
    evidence: "REDEFINE 1: 22.7% weight loss at 68 weeks (vs 16.1% semaglutide alone). 91.9% achieved at least 5% weight reduction. NDA submitted Dec 2025.",
    dosing: "Single weekly subcutaneous injection. Same schedule as current therapy.",
    contraindications: "Expected similar to semaglutide.",
    patientFit: "high",
    fitRationale: "Would replace current semaglutide with more potent single injection. No additional pills, same injection schedule, significantly better outcomes.",
    availability: "2026",
  });

  recs.push({
    name: "Enobosarm (SARM + GLP-1)",
    category: "pipeline",
    mechanism: "Selective androgen receptor modulator for muscle/bone. Sends 'keep muscle' signal without testosterone side effects (no prostate/hair/acne). Designed specifically for GLP-1 co-administration.",
    evidence: "Phase 2b QUALITY: 71% reduction in lean mass loss added to semaglutide. Fat was 99.1% of total weight lost (vs 68% semaglutide alone). 62.4% reduction in stair climb power decline. Phase 3 advancing.",
    dosing: "3mg oral daily alongside GLP-1 injection.",
    contraindications: "TBD from Phase 3. Hormone-sensitive cancers likely.",
    patientFit: losingMuscle ? "high" : "moderate",
    fitRationale: losingMuscle
      ? "Patient's core problem is losing muscle. Enobosarm is the pharmacological solution to exactly this. Watch for Phase 3 results and FDA timeline."
      : "Preventive muscle preservation. Monitor pipeline.",
    availability: "2027+",
  });

  recs.push({
    name: "Retatrutide (Triple GLP-1/GIP/Glucagon Agonist)",
    category: "pipeline",
    mechanism: "GLP-1 = appetite suppression. GIP = enhanced insulin response + fat metabolism. Glucagon = direct fat burning + energy expenditure + hepatic fat targeting. Three pathways simultaneously.",
    evidence: "Phase 3 TRIUMPH-4: up to 28.7% weight loss at 68 weeks (highest of any obesity medication). Glucagon component specifically targets visceral and hepatic fat. Seven Phase 3 trials completing 2026.",
    dosing: "Once-weekly subcutaneous injection. Doses: 4mg, 9mg, 12mg.",
    contraindications: "TBD from Phase 3.",
    patientFit: patient.visceralFat != null && patient.prev?.visceralFat != null && patient.visceralFat >= patient.prev.visceralFat ? "high" : "moderate",
    fitRationale: "28.7% is bariatric surgery territory. Glucagon component targets exactly what's not moving in this patient (visceral fat). Game-changer when it launches.",
    availability: "2027+",
  });

  return recs;
}

function noExercise(patient: PatientIntake): boolean {
  return !patient.exercise || /none|sedentary|no exercise|no workout/i.test(patient.exercise);
}

// ============================================================
// SIDE EFFECT MANAGEMENT
// ============================================================

function buildSideEffectPlan(patient: PatientIntake): string {
  const lines: string[] = [];
  lines.push("SIDE EFFECT MANAGEMENT (SLOW & SHIELD)");
  lines.push("═".repeat(40));

  const effects = patient.sideEffects || [];
  const complaints = patient.complaints || [];
  const allSymptoms = [...effects, ...complaints];

  const hasNausea = allSymptoms.some((s) => /nausea|vomit|sick/i.test(s));
  const hasConstipation = allSymptoms.some((s) => /constipat/i.test(s));
  const hasDiarrhea = allSymptoms.some((s) => /diarrhea|loose/i.test(s));
  const hasFatigue = allSymptoms.some((s) => /fatigu|tired|energy/i.test(s));
  const hasHairLoss = allSymptoms.some((s) => /hair/i.test(s));
  const hasSulfurBurps = allSymptoms.some((s) => /sulfur|burp/i.test(s));
  const appetiteSuppressed = allSymptoms.some((s) => /appetite.*suppress/i.test(s));

  if (hasNausea) {
    lines.push("\nNAUSEA:");
    lines.push("  Tier 1: Small, low-fat meals. Stop eating at 'just full.' Stay upright 30 min after eating.");
    lines.push("  Tier 2: Ginger capsules/tea. Vitamin B6. Acupressure wristbands. Oral rehydration (Liquid IV, Drip Drop).");
    lines.push("  Tier 3 (call provider): Can't keep fluids down >24 hours, dehydration signs (dizziness, dark urine).");
  }

  if (hasConstipation) {
    lines.push("\nCONSTIPATION:");
    lines.push("  Tier 1: Increase water dramatically. Fiber increase (slow, 5g/week increments). Walk after meals.");
    lines.push("  Tier 2: Magnesium glycinate (already in supplement plan, has GI motility benefit). Miralax if needed.");
    lines.push("  Tier 3 (call provider): No BM >5 days, severe bloating/pain, bloody stools.");
  }

  if (hasDiarrhea) {
    lines.push("\nDIARRHEA:");
    lines.push("  Tier 1: Bland foods (BRAT: bananas, rice, applesauce, toast). Avoid sugar alcohols. Hydrate.");
    lines.push("  Tier 2: Imodium. Probiotics. Oral rehydration solution.");
    lines.push("  Tier 3 (call provider): Bloody stools, fever, dehydration, lasts >3 days.");
  }

  if (hasSulfurBurps) {
    lines.push("\nSULFUR BURPS:");
    lines.push("  Prevention: Eat slowly, smaller portions. Limit sulfur-rich foods (eggs, cruciferous veggies, garlic, onions, red meat) during flare-ups.");
    lines.push("  Management: Peppermint tea, activated charcoal, ginger, probiotics.");
    lines.push("  Call provider: Persistent vomiting, severe abdominal pain, fever, bloody stools.");
  }

  if (hasFatigue) {
    lines.push("\nFATIGUE:");
    lines.push("  Check: Ferritin, B12, Vitamin D, thyroid (TSH). Nutritional deficiencies are the most common cause on GLP-1 therapy.");
    lines.push("  Ensure adequate caloric intake (not under-fueling). Hydration. Sleep optimization.");
  }

  if (hasHairLoss) {
    lines.push("\nHAIR THINNING:");
    lines.push("  Most common cause on GLP-1: protein and/or iron deficiency from reduced intake.");
    lines.push("  Check: Ferritin (target >50), protein intake (increase to 100g+), B12, zinc.");
    lines.push("  Usually resolves with nutritional optimization within 3-6 months.");
  }

  if (appetiteSuppressed) {
    lines.push("\nAPPETITE SUPPRESSION (The Protein Paradox):");
    lines.push("  Body needs protein but doesn't want to eat. Solutions:");
    lines.push("  - Protein shakes (whey isolate or casein) to hit targets without volume");
    lines.push("  - Prioritize dense protein sources: Greek yogurt, cottage cheese, eggs");
    lines.push("  - Small frequent meals rather than 1-2 large meals");
  }

  if (!hasNausea && !hasConstipation && !hasDiarrhea && !hasSulfurBurps && !hasFatigue && !hasHairLoss) {
    lines.push("\nNo active GI complaints documented.");
    lines.push("Preventive (SLOW method): Stay on schedule, low-fat meals, water + electrolytes daily.");
    lines.push("Watch for side effects at dose increases.");
  }

  lines.push("\nRED FLAGS (any of these = contact provider immediately):");
  lines.push("  - Bloody stools or vomit");
  lines.push("  - Can't keep fluids down >24 hours");
  lines.push("  - Severe abdominal pain");
  lines.push("  - Fever with GI symptoms");
  lines.push("  - Signs of dehydration (dizziness, dark urine, rapid heartbeat)");

  return lines.join("\n");
}

// ============================================================
// CARE PLAN GENERATOR
// ============================================================

export async function generateCarePlan(patient: PatientIntake): Promise<CarePlan> {
  await loadKnowledgeBase();

  const compositionAnalysis = analyzeComposition(patient);
  const pillarSections = mapPillars(patient);
  const adjunctTherapies = recommendAdjuncts(patient);
  const sideEffectManagement = buildSideEffectPlan(patient);

  // Lab recommendations
  const labRecs: string[] = [];
  if (!patient.labs?.b12) labRecs.push("B12 (methylcobalamin level)");
  if (!patient.labs?.ferritin) labRecs.push("Ferritin + CBC");
  if (!patient.labs?.vitaminD) labRecs.push("25-OH Vitamin D");
  if (!patient.labs?.a1c) labRecs.push("Hemoglobin A1c");
  if (!patient.labs?.testosterone && !patient.labs?.estradiol) {
    labRecs.push("Hormone panel: Estradiol, Progesterone, Total/Free Testosterone, DHEA-S, SHBG");
  }
  if (!patient.labs?.tsh) labRecs.push("Thyroid: TSH, Free T3, Free T4");
  labRecs.push("CMP (comprehensive metabolic panel)");

  // 30-day goals
  const goals: Record<string, { baseline: string; target: string }> = {};
  if (patient.proteinIntake != null) {
    goals["Protein (g/day)"] = { baseline: `${patient.proteinIntake}g`, target: "100g+" };
  }
  if (patient.waterIntake != null) {
    goals["Water (oz/day)"] = { baseline: `${patient.waterIntake}oz`, target: `${patient.weight ? Math.round(patient.weight / 2) : 80}oz+` };
  }
  goals["Resistance training"] = { baseline: noExercise(patient) ? "0x/week" : patient.exercise || "unknown", target: "3x/week" };
  goals["Steps/day"] = { baseline: noExercise(patient) ? "~2,000" : "assess", target: "5,000+" };
  if (patient.sleep && /5|4|3/i.test(patient.sleep)) {
    goals["Sleep"] = { baseline: patient.sleep, target: "7+ hours" };
  }
  goals["Vitality Tracker"] = { baseline: "Not started", target: "Logging daily" };

  // Talking points
  const talkingPoints: string[] = [];

  if (patient.labs?.insulin != null && patient.labs.insulinBaseline != null && patient.labs.insulin < patient.labs.insulinBaseline) {
    const reduction = ((1 - patient.labs.insulin / patient.labs.insulinBaseline) * 100).toFixed(0);
    talkingPoints.push(`Your insulin went from ${patient.labs.insulinBaseline} to ${patient.labs.insulin} - a ${reduction}% improvement. That's your body healing from the inside out. The scale doesn't show that.`);
  }

  if (patient.hips != null && patient.prev?.hips != null && patient.hips < patient.prev.hips) {
    const hipDrop = (patient.prev.hips - patient.hips).toFixed(1);
    talkingPoints.push(`Your hips dropped ${hipDrop} inches. Your body IS changing. The composition data tells a fuller story than the scale.`);
  }

  if (patient.proteinIntake != null && patient.proteinIntake < 80) {
    talkingPoints.push("The reason it feels slow is because we need to protect your muscle. That's what keeps your metabolism running. Protein and resistance training are non-negotiable from here.");
  }

  talkingPoints.push("Track your food this week. No judgment, no restrictions. I just need to see what we're working with.");

  if (patient.complaints?.some((c) => /frustrat|stall|plateau|difficult/i.test(c))) {
    talkingPoints.push("We have additional tools available if needed. But let's get the foundation right first - protein, movement, hydration. These are the biggest levers we haven't pulled yet.");
  }

  // Escalation path
  const escalation = `ESCALATION PATH:
1. Weeks 1-4: Foundation (protein 100g+, resistance training 3x/week, hydration, supplements)
2. Week 4: Body comp SCALE recheck. If muscle % improving and waist trending down, continue course.
3. Weeks 4-8: Add metformin if insulin resistance history. Verify GLP-1 dose optimized.
4. Week 8: Body comp SCALE + labs recheck. Assess hormone panel results.
5. Weeks 8-12: If plateau persists after foundation + metformin, consider:
   - SGLT2 inhibitor (if visceral fat still elevated)
   - Tirzepatide switch (if on semaglutide, check insurance)
   - Contrave (if food noise/cravings present)
   - Topiramate (if no brain fog, as last resort)
6. Month 4+: Reassess full plan. Watch pipeline drugs (CagriSema, enobosarm).`;

  return {
    generatedAt: new Date().toISOString(),
    patient,
    compositionAnalysis,
    pillarSections,
    adjunctTherapies,
    sideEffectManagement,
    labRecommendations: labRecs,
    thirtyDayGoals: goals,
    talkingPoints,
    escalationPath: escalation,
  };
}

// ============================================================
// FORMATTERS
// ============================================================

export function formatCarePlan(plan: CarePlan): string {
  const lines: string[] = [];

  lines.push("CARE PLAN - GLP-1 WEIGHT MANAGEMENT");
  lines.push("═".repeat(40));
  lines.push(`Generated: ${new Date(plan.generatedAt).toLocaleDateString()}`);
  if (plan.patient.name) lines.push(`Patient: ${plan.patient.name}`);
  if (plan.patient.glp1Med) lines.push(`Medication: ${plan.patient.glp1Med} ${plan.patient.glp1Dose || ""}`);
  lines.push("");

  // Composition analysis
  lines.push(plan.compositionAnalysis);
  lines.push("");

  // 5-Pillar sections
  for (const section of plan.pillarSections) {
    const priorityTag = section.priority === "critical" ? " [CRITICAL]" : section.priority === "high" ? " [HIGH]" : "";
    lines.push(`PILLAR ${section.pillarNumber}: ${section.pillar.toUpperCase()}${priorityTag}`);
    lines.push("-".repeat(35));
    lines.push(`Problem: ${section.problem}`);
    lines.push("Interventions:");
    section.interventions.forEach((i) => lines.push(`  - ${i}`));
    if (section.resources.length > 0) {
      lines.push(`Resources: ${section.resources.join(", ")}`);
    }
    lines.push("");
  }

  // Side effects
  lines.push(plan.sideEffectManagement);
  lines.push("");

  // Adjunct therapies (available now only for primary display)
  const nowRecs = plan.adjunctTherapies.filter((r) => r.availability === "now" && r.patientFit !== "low");
  if (nowRecs.length > 0) {
    lines.push("ADJUNCT THERAPY RECOMMENDATIONS");
    lines.push("═".repeat(40));
    for (const rec of nowRecs) {
      const fitTag = rec.patientFit === "high" ? " [STRONG]" : "";
      lines.push(`${rec.name}${fitTag} (${rec.category})`);
      lines.push(`  Mechanism: ${rec.mechanism.substring(0, 120)}...`);
      lines.push(`  Fit: ${rec.fitRationale}`);
      lines.push(`  Dosing: ${rec.dosing}`);
      if (rec.monthlyCost) lines.push(`  Cost: ${rec.monthlyCost}`);
      lines.push("");
    }
  }

  // Pipeline drugs (brief)
  const pipelineRecs = plan.adjunctTherapies.filter((r) => r.availability !== "now" && r.patientFit !== "low");
  if (pipelineRecs.length > 0) {
    lines.push("PIPELINE (COMING SOON)");
    lines.push("-".repeat(30));
    for (const rec of pipelineRecs) {
      lines.push(`- ${rec.name} (${rec.availability}): ${rec.evidence.substring(0, 100)}...`);
    }
    lines.push("");
  }

  // Labs
  if (plan.labRecommendations.length > 0) {
    lines.push("LABS TO ORDER");
    lines.push("-".repeat(30));
    plan.labRecommendations.forEach((l) => lines.push(`  - ${l}`));
    lines.push("");
  }

  // 30-day goals
  lines.push("30-DAY GOALS");
  lines.push("-".repeat(30));
  for (const [metric, { baseline, target }] of Object.entries(plan.thirtyDayGoals)) {
    lines.push(`  ${metric}: ${baseline} -> ${target}`);
  }
  lines.push("");

  // Talking points
  lines.push("PATIENT TALKING POINTS");
  lines.push("-".repeat(30));
  plan.talkingPoints.forEach((t, i) => lines.push(`${i + 1}. "${t}"`));
  lines.push("");

  // Escalation
  lines.push(plan.escalationPath);

  return lines.join("\n");
}

export function formatCarePlanBrief(plan: CarePlan): string {
  const critical = plan.pillarSections.filter((s) => s.priority === "critical" || s.priority === "high");
  const highFit = plan.adjunctTherapies.filter((r) => r.patientFit === "high" && r.availability === "now");

  const lines: string[] = [];
  lines.push("CARE PLAN SUMMARY");
  lines.push("═".repeat(30));

  if (critical.length > 0) {
    lines.push("\nPriority Actions:");
    critical.forEach((s) => {
      lines.push(`  [${s.priority.toUpperCase()}] Pillar ${s.pillarNumber}: ${s.interventions[0]}`);
    });
  }

  if (highFit.length > 0) {
    lines.push("\nStrong Adjunct Candidates:");
    highFit.forEach((r) => lines.push(`  - ${r.name}: ${r.fitRationale.substring(0, 80)}...`));
  }

  lines.push(`\nLabs needed: ${plan.labRecommendations.length} tests recommended`);
  lines.push(`\nUse /careplan full for complete care plan`);

  return lines.join("\n");
}

// ============================================================
// INTENT PARSING
// ============================================================

export function parsePatientFromText(text: string): PatientIntake {
  const patient: PatientIntake = {};

  // Parse measurements with pattern: "Label: value" or "Label value"
  const num = (pattern: RegExp): number | undefined => {
    const match = text.match(pattern);
    return match ? parseFloat(match[1]) : undefined;
  };

  patient.bmi = num(/BMI[:\s]*(\d+\.?\d*)/i);
  patient.bodyFatPct = num(/Body\s*Fat\s*%?[:\s]*(\d+\.?\d*)/i);
  patient.muscleMassPct = num(/Muscle\s*Mass\s*%?[:\s]*(\d+\.?\d*)/i);
  patient.visceralFat = num(/Visceral\s*Fat[:\s]*(\d+\.?\d*)/i);
  patient.waist = num(/Waist[:\s]*(\d+\.?\d*)/i);
  patient.hips = num(/Hips?[:\s]*(\d+\.?\d*)/i);
  patient.thigh = num(/Thigh[:\s]*(\d+\.?\d*)/i);
  patient.arm = num(/Arm[:\s]*(\d+\.?\d*)/i);

  // Parse previous measurements in parentheses
  const prevMatch = (pattern: RegExp): number | undefined => {
    const match = text.match(pattern);
    return match ? parseFloat(match[1]) : undefined;
  };

  const prevBmi = prevMatch(/BMI[:\s]*\d+\.?\d*.*?\((\d+\.?\d*)\)/i);
  const prevBF = prevMatch(/Body\s*Fat\s*%?[:\s]*\d+\.?\d*.*?\((\d+\.?\d*)\)/i);
  const prevMM = prevMatch(/Muscle\s*Mass\s*%?[:\s]*\d+\.?\d*.*?\((\d+\.?\d*)\)/i);
  const prevVF = prevMatch(/Visceral\s*Fat[:\s]*\d+\.?\d*.*?\((\d+\.?\d*)\)/i);
  const prevWaist = prevMatch(/Waist[:\s]*\d+\.?\d*.*?\((\d+\.?\d*)\)/i);
  const prevHips = prevMatch(/Hips?[:\s]*\d+\.?\d*.*?\((\d+\.?\d*)\)/i);
  const prevThigh = prevMatch(/Thigh[:\s]*\d+\.?\d*.*?\((\d+\.?\d*)\)/i);
  const prevArm = prevMatch(/Arm[:\s]*\d+\.?\d*.*?\((\d+\.?\d*)\)/i);

  if (prevBmi || prevBF || prevMM || prevVF || prevWaist || prevHips || prevThigh || prevArm) {
    patient.prev = {
      bmi: prevBmi,
      bodyFatPct: prevBF,
      muscleMassPct: prevMM,
      visceralFat: prevVF,
      waist: prevWaist,
      hips: prevHips,
      thigh: prevThigh,
      arm: prevArm,
    };
  }

  // Parse labs
  const insulin = num(/Insulin[:\s]*(\d+\.?\d*)/i);
  const insulinBaseline = num(/Insulin.*?(?:baseline|down from)[:\s]*(\d+\.?\d*)/i) || prevMatch(/Insulin[:\s]*\d+\.?\d*.*?\(.*?(\d+\.?\d*)\)/i);
  const a1c = num(/A1[cC][:\s]*(\d+\.?\d*)/i);
  const protein = num(/Protein[:\s]*(\d+\.?\d*)/i);
  const albumin = num(/Albumin[:\s]*(\d+\.?\d*)/i);
  const ast = num(/AST[:\s/]*(?:ALT)?[:\s]*(\d+\.?\d*)/i);
  const ferritin = num(/Ferritin[:\s]*(\d+\.?\d*)/i);
  const vitD = num(/(?:Vitamin\s*D|25-OH)[:\s]*(\d+\.?\d*)/i);
  const b12 = num(/B12[:\s]*(\d+\.?\d*)/i);

  if (insulin || a1c || protein || albumin || ast || ferritin || vitD || b12) {
    patient.labs = {
      insulin,
      insulinBaseline,
      a1c,
      protein,
      albumin,
      ast,
      ferritin,
      vitaminD: vitD,
      b12,
    };
  }

  // Parse medication
  if (/semaglutide/i.test(text)) patient.glp1Med = "semaglutide";
  else if (/tirzepatide/i.test(text)) patient.glp1Med = "tirzepatide";
  else if (/liraglutide/i.test(text)) patient.glp1Med = "liraglutide";

  const doseMatch = text.match(/(\d+)\s*(?:units?|mg)/i);
  if (doseMatch) patient.glp1Dose = doseMatch[0];

  // Parse supplements
  const suppMatches = text.match(/(?:taking|supplement|currently)[:\s]*([^.]+)/gi);
  if (suppMatches) {
    patient.supplements = suppMatches.map((s) => s.replace(/^(?:taking|supplement|currently)[:\s]*/i, "").trim());
  }

  // Parse complaints
  const complaintKeywords = ["difficulty", "frustrat", "stall", "plateau", "nausea", "constipat", "fatigue", "hair", "brain fog", "having difficulty"];
  const foundComplaints: string[] = [];
  for (const kw of complaintKeywords) {
    if (text.toLowerCase().includes(kw)) foundComplaints.push(kw);
  }
  if (foundComplaints.length > 0) patient.complaints = foundComplaints;

  // Parse comorbidities
  const comorbidityKeywords = ["insulin resistance", "hypertension", "diabetes", "pre-diabet", "GERD", "sleep apnea", "PCOS"];
  const foundComorb: string[] = [];
  for (const kw of comorbidityKeywords) {
    if (text.toLowerCase().includes(kw.toLowerCase())) foundComorb.push(kw);
  }
  if (foundComorb.length > 0) patient.comorbidities = foundComorb;

  // Side effects
  const seKeywords = ["appetite suppress", "nausea", "constipat", "diarrhea", "vomit", "sulfur burp", "heartburn", "fatigue", "hair loss"];
  const foundSE: string[] = [];
  for (const kw of seKeywords) {
    if (text.toLowerCase().includes(kw.toLowerCase())) foundSE.push(kw);
  }
  if (foundSE.length > 0) patient.sideEffects = foundSE;

  // Store full provider note
  patient.providerNote = text;

  return patient;
}

// ============================================================
// BUILD PROMPT FOR CLAUDE (care plan context for AI enhancement)
// ============================================================

export function buildCarePlanPrompt(patient: PatientIntake, plan: CarePlan): string {
  const kbSummary = knowledgeBase.substring(0, 6000); // trim for prompt budget

  return `You are generating a clinical care plan for a GLP-1 weight loss patient using the Vitality Unchained 5-Pillar framework.

KNOWLEDGE BASE (abbreviated):
${kbSummary}

PATIENT DATA:
${JSON.stringify(patient, null, 2)}

SYSTEM-GENERATED ANALYSIS:
${plan.compositionAnalysis}

SYSTEM-GENERATED PILLAR MAPPING:
${plan.pillarSections.map((s) => `Pillar ${s.pillarNumber} [${s.priority}]: ${s.problem}`).join("\n")}

ADJUNCT THERAPY RECOMMENDATIONS:
${plan.adjunctTherapies.filter((r) => r.patientFit !== "low").map((r) => `- ${r.name} [${r.patientFit}]: ${r.fitRationale}`).join("\n")}

Using this analysis as your foundation, generate a comprehensive, personalized care plan. Include:
1. What the composition data actually reveals (interpret the trends)
2. Specific 5-pillar interventions with clinical rationale
3. Adjunct therapy recommendations ranked by priority for THIS patient
4. Side effect management plan
5. 30-day goals with measurable targets
6. Talking points the provider can use with the patient
7. Clear escalation pathway if interventions don't move the needle

Be specific, evidence-based, and actionable. This is a draft for provider review, not patient-facing content.`;
}

// ============================================================
// EXPORTS
// ============================================================

export function isCarePlanReady(): boolean {
  return true; // No external dependencies needed, just knowledge base files
}

export async function initCarePlan(): Promise<boolean> {
  try {
    await loadKnowledgeBase();
    info("careplan", "Care plan module initialized");
    return true;
  } catch (err) {
    logError("careplan", `Init failed: ${err}`);
    return false;
  }
}
