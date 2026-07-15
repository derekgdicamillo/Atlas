# Functional Medicine — Knowledge Base

Derek DiCamillo's functional-medicine clinical reference, built from the **Spring 2026 Joyful Heart Institute Mentorship** (Jenni Gallagher, APRN). This is the knowledge layer behind Atlas Medicine's functional-medicine reasoning: optimal-range lab interpretation, root-cause analysis, and the specific protocols/dosing taught in the course.

> **Provenance & standing.** Content is transcribed from the course slide decks (PDF), reference graphics, and exported lesson notes. Video recordings were not transcribed; their substance is captured via the lesson notes. Numeric targets are preserved verbatim; where sources disagreed, both values are kept and the discrepancy is flagged rather than resolved. Most numeric "optimal" targets are **functional-medicine practitioner consensus**, not guideline-level evidence — see each file's evidence-quality note. Derek (FNP) retains all medical responsibility; this is a reasoning aid, not a directive.

## Topics

| # | Topic | Covers |
|---|---|---|
| [01](01-lab-optimization/) | Lab Optimization | Functional vs. "normal" ranges, interpretation workflow, pre-draw prep |
| [02](02-iron-ferritin/) | Iron & Ferritin | Pathophysiology, Ferosolv protocol, cofactors, 6 worked cases |
| [03](03-inflammation-hashimotos/) | Inflammation & Hashimoto's | Inflammatory markers, autoimmune thyroid antibodies, management |
| [04](04-functional-hypothyroid-mthfr/) | Functional Hypothyroid & MTHFR | Full-panel interpretation, FT3/RT3 model, methylation, questionnaire |
| [05](05-gut-health-healing/) | Gut Health & Healing | Constipation-as-root, dysbiosis, the 7-step gut-healing protocol |
| [06](06-metabolic-syndrome/) | Metabolic Syndrome | Insulin-resistance tree, ATP III criteria, low-carb diet framework |
| [07](07-ckd-nafld-sleep/) | CKD, NAFLD & Sleep | Kidney/liver functional management, sleep-optimization protocol |
| [08](08-methylene-blue-ivm-ldn/) | Methylene Blue, Ivermectin & LDN | Mechanisms, dosing, and the MB+SSRI / G6PD safety gates |
| [09](09-bone-health/) | Bone Health | Systemic bone model, D3/K2/Mg/boron stack, HRT/bone evidence |
| [10](10-supplements-nutrition/) | Supplements & Nutrition | Consolidated ~45-supplement reference, FullScript workflow, diet graphics |

## Training layer — [`atlas-training/`](atlas-training/)

The layer that makes Atlas Medicine *reason* like this course rather than merely recite it:

| File | Purpose |
|---|---|
| [system-prompt.md](atlas-training/system-prompt.md) | Functional-medicine specialist prompt — operating principles, workflow, refusals |
| [lab-reference.md](atlas-training/lab-reference.md) | One-screen optimal-range cheat sheet (full detail in [01](01-lab-optimization/optimal-vs-normal-ranges.md)) |
| [decision-tree.md](atlas-training/decision-tree.md) | Root-cause triage: inflammation → insulin resistance → hormones → thyroid → iron |
| [case-library.md](atlas-training/case-library.md) | Worked case studies as reusable reasoning examples |
| [faq-knowledge.md](atlas-training/faq-knowledge.md) | Distilled recurring Q&A from the course |

## The core mental model

The course teaches one recurring root-cause chain, applied across every topic:

**Inflammation & insulin resistance are upstream.** Hyperinsulinemia drives sex-hormone imbalance, inflammation, fatty liver, hypertension, and metabolic syndrome. Correct insulin and inflammation first; hormone and thyroid corrections follow more easily. Read labs by **optimal** (functional) ranges, not just the lab's "normal" flags — a value inside the reference range can still be far from optimal (e.g., ferritin 12 reads "normal" but causes severe fatigue).

## Source discrepancies

**Resolved:**
- **Ivermectin dose → use 0.4 mg/kg/day.** The source carried 0.4 (Week 9 deck) vs. 4.4 mg/kg/day (Week 7 notes). A multi-source literature review (2026-07-14) confirmed **0.4 mg/kg/day** as the defensible dose (documented safe; corroborated by published integrative parasite protocols; off-label extended, FDA single-dose is 0.2 mg/kg) and rejected **4.4 mg/kg/day** as an unsupportable transcription error (exceeds the highest human-studied dose, 2 mg/kg). See [08/ivermectin.md](08-methylene-blue-ivm-ldn/ivermectin.md) and [05/gut-pathophysiology.md](05-gut-health-healing/gut-pathophysiology.md). *The original OneDrive course notes should be corrected at source.*

**Carried forward (not resolved):**
- **Ferritin "optimal":** 80–100 (quick-ref card) vs. 80–120 (slide). Symptom floor ~65, cardiac-risk floor 20.
- **Vitamin D optimal ceiling:** 80 vs. 100 ng/mL across sources; firm floor 60.
- **Low-carb/keto gram thresholds:** two inconsistent definitions in the Week-6 material, kept side by side.
- **"Bone health and the WHI results.pdf"** is actually a *pre-WHI* 2002 AHRQ evidence review (Nelson), not WHI trial results — flagged in [09/bone-health-whi.md](09-bone-health/bone-health-whi.md).

## PV MediSpa framework cross-reference

The mentorship content complements PV MediSpa's **5 Pillars of Functional Medical Weight Loss** (see USER.md): (1) Precision Weight Science, (2) Nourishing Health / Fuel Code, (3) Dynamic Movement, (4) Mindful Wellness / Calm Core Toolkit, (5) Functional Wellness / Cooling Fuel Protocol.

## Related knowledge bases

- Parasite protocols: [`docs/knowledge/parasite-protocol/`](../parasite-protocol/)
- GLP-1 protocols: [`docs/knowledge/glp1-protocols/`](../glp1-protocols/)
- Peptide therapy: [`docs/knowledge/peptide-therapy/`](../peptide-therapy/)
- BHRT: [`docs/knowledge/bhrt/`](../bhrt/)
