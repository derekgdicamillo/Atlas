# Atlas Intake Template

Atlas runs this intake before generating any protocol. Capture every field. If a field is unknown, mark "unknown" — do not guess.

---

## A. Identification

- Name / patient identifier:
- Date of birth / age:
- Sex assigned at birth:
- Pregnancy / breastfeeding status (if applicable):
- Height / weight / BMI:
- Date of intake:
- Requesting practitioner:

## B. Chief Complaint and Goals

- Why are you here?
- What are your top 3 symptoms in priority order?
- What outcome would you call success?
- What have you already tried? What worked / didn't?

## C. Symptom Inventory by System (rate 0-3)

### GI
- Bloating __ Gas __ Pain __ Reflux __
- Constipation __ Diarrhea __ Mucus __ Undigested food __
- Visible worms / proglottids: Y/N
- Anal itching (especially night): Y/N
- RUQ pain / fat intolerance: Y/N

### Skin
- Eczema __ Hives / urticaria __ Rosacea __ Pruritus __
- Larva currens / migrating tracks: Y/N
- Cyclical worsening with full moon: Y/N

### Neuro / Psych
- Brain fog __ Insomnia __ Anxiety __ Depression __ Bruxism __
- Headache / migraine __ Vertigo __
- Focal neuro / seizures: Y/N (if yes → escalate)

### Immune / allergy
- Eosinophil count if known:
- Total IgE if known:
- New allergies / MCAS-like reactions: Y/N
- Recurrent infections: Y/N

### Constitutional
- Fatigue __ PEM __ Sleep disruption __
- Night sweats __ Air hunger __ Low-grade fevers: Y/N
- Weight change: ___ lb in ___ months
- Cravings (sugar, dirt, raw meat): Y/N specify

### GU
- UTI symptoms without growth: Y/N
- Hematuria: Y/N
- Vaginitis / Trichomonas-like: Y/N

### MSK
- Myalgia, arthralgia, periorbital edema: Y/N

### Cardio-pulm
- Cough during exertion / migration phase: Y/N
- Chest pain, palpitations: Y/N

## D. Exposure History

- Lifetime international travel (countries, dates):
- Born / lived in endemic regions:
- Well water / untreated water exposure:
- Recreational freshwater (lakes, rivers, hot tubs):
- Pet ownership: dogs ___ cats ___ reptiles ___ livestock ___ deworming up to date Y/N
- Occupational: agricultural / vet / daycare / sewage / mining: Y/N
- Diet exposure: sushi / ceviche / raw or rare meat / wild game / raw watercress / raw milk / undercooked pork: list
- Barefoot on soil: Y/N
- Tick exposure / known bites / Lyme history: Y/N
- Camping / caves: Y/N
- Sexual exposures relevant to enteric/protozoa: Y/N

## E. Symptom Timeline

- Onset relative to triggers (travel, illness, antibiotic, stressor):
- Cyclical pattern (full moon, premenstrual, seasonal):
- Worse with sugar, alcohol, after meals: Y/N
- Response to prior antibiotics or empiric metronidazole:

## F. Past Treatments and Reactions

- Prior antiparasitic herbs/drugs and outcome:
- Severe reactions (sulfa, nitroimidazoles, herbs):
- Strong Herxheimer history with prior detox: Y/N

## G. Current Medications and Supplements

- Prescription meds:
- OTC / supplements:
- Herbal products:
- Recreational substances:
- Last antibiotic course (date and reason):
- PPI / acid suppressor use:

## H. Past Medical / Surgical History

- Major diagnoses:
- Surgeries (cholecystectomy, bowel resection, splenectomy):
- Immunosuppression history:
- Cancer / chemo:
- Autoimmune conditions:
- Lyme / mold / MCAS / POTS / EDS overlap:
- Mental health diagnoses:
- Substance use disorder:

## I. Family Screening

- Household members and ages:
- Anyone with similar symptoms: Y/N who:
- Pets with worms / fleas / recent deworming:
- Daycare / school outbreaks:

## J. Functional Review

- Bowel pattern: BM/day __ Bristol type __ Mucus __ Undigested __
- Sleep: hours __ quality 1-10 __ awakenings __ full-moon worsening Y/N
- Mood: 1-10 __ anxiety __ depression __
- Energy: 1-10 __
- Female cycle: regular / irregular / postmeno; PMS severity 0-3:
- Libido: 1-10
- Vagal tone signs: cold extremities, slow HR recovery, GI motility issues
- HPA suspicion: AM cortisol crash, mid-afternoon dip, late-night wired

## K. Diet and Lifestyle Baseline

- Typical diet pattern (SAD / Mediterranean / paleo / keto / vegan / carnivore / other):
- Water intake oz/day:
- Caffeine, alcohol, nicotine:
- Exercise frequency and type:
- Sauna access: Y/N
- Stress level 1-10:
- Sleep schedule:

## L. Lab Results (attach or transcribe)

- CBC with differential (eosinophils):
- CMP:
- Ferritin, iron, TIBC:
- B12, folate, MMA, homocysteine:
- Total IgE:
- Vitamin D:
- TSH, fT3, fT4, TPO:
- hs-CRP, ESR:
- Stool PCR (GI-MAP, Genova GI Effects, Doctor's Data, BioFire):
- Stool O&P x3:
- Strongyloides IgG:
- Toxoplasma IgG/IgM/avidity:
- Babesia panel:
- Schistosoma IgG:
- Other targeted serologies:
- Mycotoxin urine panel:
- Lyme panel:
- Mast cell panel:
- OAT:

## M. Insurance / Cost / Access

- Can patient afford GI-MAP / specialty stool? Y/N
- Insurance covers conventional O&P / serologies? Y/N
- Cost-sensitive plan needed: Y/N
- Compounding pharmacy access: Y/N
- Functional supplement budget per month estimate: $___

## N. Treatment Capacity

- Compliance commitment level 1-10:
- Capable of daily complex regimen: Y/N
- Family/household able to coordinate: Y/N
- Pet care for deworming: Y/N
- Time off work needed: Y/N
- Access to home sauna / castor oil packs / coffee enema setup:

## O. Atlas-Specific Confirmations

- Practitioner of record name and license:
- Pregnancy excluded (if female reproductive age):
- Strongyloides screened (if applicable):
- Patient understands phases and Herx possibility: Y/N
- Stop-conditions reviewed: Y/N
- Emergency contact in place: Y/N

---

## Output

After intake, Atlas summarizes:

```
SUMMARY
- Tier: [1-4]
- Confirmed organisms: [list or empiric]
- Comorbid considerations: [mold, Lyme, MCAS, MTHFR, autoimmune, etc.]
- Drug interactions to manage: [list]
- Household/pet coordination: [yes/no]
- Estimated protocol duration: [weeks]
- Estimated supplement budget: [low/medium/high]
- Practitioner sign-off needed before: [list any items]
```

Then proceed to decision tree (decision-tree.md) for protocol generation.
