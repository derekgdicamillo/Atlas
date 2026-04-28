# Functional Medicine Parasite Protocol

A complete clinical system for assessing, treating, and monitoring parasitic infections through a functional medicine lens. Built to be used by Derek, family, and PV Medispa & Weight Loss patients, and to train the Atlas AI assistant for protocol generation.

## Scope

This project covers human parasitology in three categories:
- **Protozoa** (Giardia, Blastocystis, Entamoeba, Cryptosporidium, Dientamoeba, Trichomonas, Babesia, Toxoplasma, Plasmodium, Leishmania, Trypanosoma)
- **Helminths** (nematodes/roundworms, cestodes/tapeworms, trematodes/flukes)
- **Ectoparasites** (scabies, lice, demodex) — referenced briefly; primary focus is enteric and systemic parasites

It synthesizes:
- Conventional CDC/WHO/IDSA guidance
- Functional medicine frameworks (IFM 4R/5R, drainage hierarchy, biofilm disruption)
- Practitioner protocols (Klinghardt, Davidson/Watts, Buhner, Kalcker, Yasko, ILADS for tick-borne overlap)
- Peer-reviewed literature on antiparasitic herbs, pharmaceuticals, and supportive interventions

## File Map

| # | File | Purpose |
|---|------|---------|
| 00 | [README.md](README.md) | Navigation and scope |
| 01 | [01-foundations.md](01-foundations.md) | Biology, taxonomy, life cycles, prevalence, transmission |
| 02 | [02-clinical-presentation.md](02-clinical-presentation.md) | Symptoms by system, red flags, differential diagnosis |
| 03 | [03-assessment-testing.md](03-assessment-testing.md) | Intake, exam, lab testing, comparative analysis of stool tests |
| 04 | [04-protocol-framework.md](04-protocol-framework.md) | The 4-phase functional protocol architecture |
| 05 | [05-phase-1-preparation.md](05-phase-1-preparation.md) | Drainage, terrain, prep (2–4 weeks) |
| 06 | [06-phase-2-eradication.md](06-phase-2-eradication.md) | Active antiparasitic phase (4–12 weeks, lunar-cycled) |
| 07 | [07-phase-3-biofilm-binders.md](07-phase-3-biofilm-binders.md) | Biofilm disruption + toxin binding |
| 08 | [08-phase-4-restoration.md](08-phase-4-restoration.md) | Gut, immune, mitochondrial repair |
| 09 | [09-herbal-materia-medica.md](09-herbal-materia-medica.md) | Each antiparasitic herb: pharmacology, dosing, evidence |
| 10 | [10-pharmaceutical-reference.md](10-pharmaceutical-reference.md) | Rx options, when to use, dosing, interactions |
| 11 | [11-dietary-protocol.md](11-dietary-protocol.md) | Anti-parasitic diet, what to remove/add, timing |
| 12 | [12-population-specific.md](12-population-specific.md) | Pediatric, pregnancy, immunocompromised, Lyme/MCAS overlap |
| 13 | [13-monitoring-herx.md](13-monitoring-herx.md) | Herxheimer management, retreatment criteria |
| 14 | [14-patient-education.md](14-patient-education.md) | Handouts, prevention, FAQs |
| 15 | [15-references-literature.md](15-references-literature.md) | Citations, guidelines, key textbooks |

## Atlas Training Subfolder

| File | Purpose |
|------|---------|
| [atlas-training/system-prompt.md](atlas-training/system-prompt.md) | Atlas role, tone, safety guardrails |
| [atlas-training/decision-tree.md](atlas-training/decision-tree.md) | Algorithmic protocol selection logic |
| [atlas-training/intake-template.md](atlas-training/intake-template.md) | Structured intake Atlas should run before recommending |
| [atlas-training/case-library.md](atlas-training/case-library.md) | Worked examples across populations |
| [atlas-training/faq-knowledge.md](atlas-training/faq-knowledge.md) | Quick-recall facts for patient questions |

## Clinical Disclaimers

1. This system is for licensed practitioner use. Functional medicine protocols can interact with pharmaceuticals, organ insufficiency, and pregnancy.
2. Antiparasitic herbs and drugs require monitoring of LFTs, CBC, and renal function in extended protocols.
3. Empiric treatment should not replace pathogen identification when symptoms are severe, immune status is compromised, or treatment fails.
4. Pediatric and pregnant patients require dose adjustment and many herbs/drugs are contraindicated. See [12-population-specific.md](12-population-specific.md) before prescribing.

## Versioning

- v1.0 — Initial build, 2026-04-28. Authored for Atlas training and PV Medispa clinical reference.
