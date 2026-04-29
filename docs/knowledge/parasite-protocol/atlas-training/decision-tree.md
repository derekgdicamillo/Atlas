# Atlas Decision Tree — Protocol Selection Logic

This file is Atlas's algorithmic heart. It walks from intake to a protocol recommendation step by step. Atlas should follow this every time a protocol is requested.

---

## Step 0 — Identify the Requester and Authority

```
Is the user...
├── Derek (clinician, prescriber) → full protocol authority, can recommend Rx
├── Family member with Derek as clinician → full intake, Derek confirms before Rx
├── PV Medispa patient with active care plan → full intake, defer Rx to clinician
├── External user without practitioner relationship → educational only, recommend they find a functional medicine provider
└── Unknown → ask
```

If "External, educational only" — provide framework explanation, not personalized protocol.

---

## Step 1 — Pregnancy / Breastfeeding Screen

```
Is the patient pregnant, possibly pregnant, or breastfeeding?
├── Yes → STOP. Explain: most antiparasitic agents contraindicated. Refer to MFM/ID. Provide only diet, hydration, gentle drainage support that's safe in pregnancy (fiber, water, garlic food doses, probiotics). Do not write a kill protocol.
└── No → Continue
```

---

## Step 2 — Tier Stratification

```
Is the patient...
├── Tier 4: Immunocompromised (HIV CD4<200, transplant, chemo, biologics, high-dose steroids, primary ID)
│   → Defer to ID/specialist. Atlas provides only adjunctive functional support recommendations.
│
├── Tier 4: Confirmed neurocysticercosis, hydatid, severe schistosomiasis, severe babesiosis,
│           ocular toxocariasis, retinal toxoplasmosis, hyperinfection syndrome
│   → Refer immediately. Adjunctive support only.
│
├── Tier 4: Eosinophilia >2000, hemolysis, severe weight loss, organ involvement
│   → Refer for specialty workup before any kill phase.
│
├── Tier 3: Multi-system functional patient (MCAS, mold overlap, Lyme co-infection,
│           autoimmune flare, multiple food sensitivities, MTHFR, hypermobility)
│   → Extended Phase 1 (4-8 weeks). Slow titration. Layer with mold/Lyme as needed.
│   → Methylene blue, lumbrokinase under specialist.
│
├── Tier 2: Symptomatic immunocompetent adult, GI ± skin ± fatigue, no major comorbidity
│   → Standard 4-phase protocol with confirmed organism if testing available.
│
└── Tier 1: Asymptomatic / low-risk household contact / preventive maintenance
    → Short herbal protocol, dietary guidance, 1-week pulse at full moon.
```

---

## Step 3 — Confirmed Organism Pathway

If testing identified a specific organism, route here. If empiric, skip to Step 4.

### 3.1 Pinworm (Enterobius)
- Pyrantel pamoate 11 mg/kg single + repeat in 2 wks (OTC, all household)
- OR albendazole 400 mg / mebendazole 100 mg single + repeat in 2 wks
- Whole household wash + nail trim + morning shower
- Mimosa pudica 6+ months
- Black walnut, clove, garlic adjunct
- Phase 1 minimal; Phase 4 microbiome restoration

### 3.2 Giardia
- Tinidazole 2 g single OR nitazoxanide 500 mg BID x 3 d
- S. boulardii 10 billion BID x 30 d
- Lactase support 30 d
- Phase 4 with pancreatic enzymes if elastase low

### 3.3 Blastocystis (symptomatic)
- Tinidazole 2 g daily x 3 d OR nitazoxanide 500 mg BID x 3 d, repeat at day 21 full moon
- Berberine 500 mg BID x 6 wks
- Bismuth 240 mg BID x 4 wks (biofilm)
- Mimosa pudica, oregano, S. boulardii
- Re-test at week 10

### 3.4 Dientamoeba fragilis
- Metronidazole 500 mg TID x 10 d OR paromomycin 25-35 mg/kg/d divided x 7 d
- Phase 4 microbiome rebuild

### 3.5 Entamoeba histolytica
- Metronidazole or tinidazole (invasive) → followed by paromomycin (luminal)
- ID consult if hepatic abscess
- Phase 4 restoration

### 3.6 Cryptosporidium
- Nitazoxanide 500 mg BID x 3 d (longer if immunocompromised)
- Bovine colostrum 6 g/day x 30 d
- Berberine, mimosa adjunct
- Hydration aggressive

### 3.7 Strongyloides (any positive serology)
- Ivermectin 200 mcg/kg daily x 2 d, repeat in 2 wks — non-negotiable
- Optional albendazole 400 mg BID x 7 d for heavy
- Mimosa pudica 6+ months
- Chart "no steroids without ivermectin"
- Re-test serology 6 and 12 months

### 3.8 Ascaris / Hookworm / Trichuris
- Albendazole 400 mg single (or BID x 3 d for heavy)
- Iron repletion (hookworm)
- Mimosa pudica 90 d
- Black walnut, wormwood, clove

### 3.9 Tapeworm (Taenia, Hymenolepis, Diphyllobothrium)
- Praziquantel weight-based single dose
- Examine stool for scolex
- Pumpkin seed + pomegranate adjunct
- B12 repletion (Diphyllobothrium)
- Re-test 3 months

### 3.10 Schistosomiasis / fluke
- Praziquantel organism-specific dose
- Triclabendazole if Fasciola
- Repeat in 3-6 months
- Surveillance for fibrosis, malignancy
- Specialist co-management

### 3.11 Babesia
- Atovaquone 750 mg q12h + azithromycin 500-1000 mg/d x 7-10 d (mild) or 6+ wks (severe)
- Cryptolepis + Sida + artemisinin pulses
- Methylene blue under specialist
- Lumbrokinase
- ILADS protocol for Lyme co-infection
- CBC, retic, haptoglobin, LDH monitoring

### 3.12 Toxoplasmosis (chronic, immunocompetent)
- Atovaquone 750 mg/day + azithromycin pulses (functional/specialist)
- Sweet wormwood 100-200 mg BID pulse
- Cat exposure controls
- Specialist for acute or pregnancy

### 3.13 Trichomonas
- Tinidazole 2 g single (treat partner)
- Topical tea tree adjunct
- Microbiome restoration

### 3.14 Chagas (Trypanosoma cruzi)
- Specialist (CDC-supplied benznidazole or nifurtimox)
- Cardiology for cardiomyopathy
- Atlas: adjunct functional support only

---

## Step 4 — Empiric Pathway (no specific organism, strong clinical picture)

```
Run the standard adult Tier 1-2 broad protocol (file 06 §3.1):
- Mimosa Pudica per loading schedule
- Black walnut tincture 2 mL BID
- Wormwood 250 mg BID (4-on/2-off)
- Cloves 500 mg TID
- Berberine 500 mg BID
- Neem 400 mg BID
- Plus full Phase 1, 3, 4 supports
- Duration: 90 days
- Re-test at 12 weeks
```

Add adjustments by symptom cluster:

### GI dominant
- Add S. boulardii, oregano oil, bismuth 4 wks

### Skin / urticaria dominant
- Add quercetin 1 g BID, DAO with meals, low-histamine diet

### Fatigue / brain fog dominant
- Lengthen Phase 1, double down on glutathione, methylene blue under specialist later

### Tick exposure / Lyme overlap
- Add cryptolepis + Sida + Houttuynia + andrographis (Buhner stack)
- Lumbrokinase 20 mg empty stomach BID

### Mold overlap
- Address building exposure first
- Add cholestyramine or BAC + Welchol
- Lengthen drainage
- Use lower-dose, gentler kill phase

### Candida overlap
- Add caprylic acid, oregano, S. boulardii
- Anti-Candida diet stricter

---

## Step 5 — Pediatric Adjustments

If patient is a child:
- Use pediatric dosing table file 12 §1
- No wormwood/mugwort under age 6
- No berberine under age 1
- Use glycerites or open capsules in food
- Treat all household for pinworm
- Pet deworming scheduled
- Pediatrician confirmation for any Rx

---

## Step 6 — Drug Interaction Check

Before finalizing, check current medications:

| Drug class | Conflict |
|------------|----------|
| Anticoagulants (warfarin, DOACs) | Lumbrokinase, nattokinase, serrapeptase, garlic high-dose, vitamin E high-dose, ginkgo, fish oil high-dose |
| Statins, immunosuppressants (cyclosporine, tacrolimus), midazolam | Berberine (potent CYP3A4), oregano, andrographis |
| Antiseizure | Wormwood (thujone), high-dose CBD interaction |
| SSRIs, MAOIs, triptans | Methylene blue (serotonin syndrome) |
| Lithium | Caution with diuretic herbs |
| Diabetes meds | Berberine (additive hypoglycemia) — adjust |
| PPIs | Reduce; reduce oregano oil burn risk; long-term PPI weakens defense |

Flag conflicts and propose alternatives.

---

## Step 7 — Final Output Assembly

Build the protocol document per the system-prompt format:
1. Patient, date, tier, indication
2. Pre-treatment confirmations checklist
3. Phase 1 with specific products, doses, schedules
4. Phase 2 with kill stack and lunar pulsing
5. Phase 3 biofilm + binder schedule
6. Phase 4 restoration stack
7. Monitoring schedule and re-test dates
8. Stop conditions
9. Patient-facing handout

---

## Step 8 — Schedule Follow-up

- Week 2 check-in (symptoms, drainage)
- Week 4 transition check (Phase 1 → 2 readiness)
- Week 6 mid-protocol (labs if Rx)
- Week 12 end of eradication (re-test, transition to Phase 4 emphasis)
- 3-month post (durability check)
- 6-month post (relapse-prone or symptomatic)
- 12-month post (Strongyloides serology if applicable)

---

## Always-Active Safety Triggers

Atlas interrupts any protocol output and recommends emergency care for:

- Severe abdominal pain with rebound tenderness
- Bloody diarrhea with fever, hypotension
- Jaundice or RUQ pain with vomiting
- New rash with mucosal blistering or skin sloughing (SJS, TEN)
- New focal neurologic deficit, severe headache, confusion
- Hemoptysis
- Anaphylaxis signs
- Suicidal ideation
- Pregnancy detected mid-protocol → pause, refer

---

## When the Tree Doesn't Fit

If the patient profile doesn't match a clear branch — unusual presentation, exotic organism, complex polypharmacy — Atlas does NOT improvise a protocol. It says: "I need Derek's review before generating this." And produces a structured summary of the case for clinician decision-making.
