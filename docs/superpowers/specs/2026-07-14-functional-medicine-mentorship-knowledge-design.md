# Functional-Medicine Mentorship Knowledge Base for Atlas Medicine

**Date:** 2026-07-14
**Author:** Derek DiCamillo + Atlas
**Status:** Approved design, pending implementation plan

## Goal

Ingest the Spring 2026 Mentorship course (Joyful Heart Institute functional-medicine
mentorship) into Atlas so the **Atlas Medicine** bot can reason from it — not just
recite it. "Teach" means two things: (1) author structured knowledge markdown under
`docs/knowledge/functional-medicine/`, and (2) ingest it into the live Supabase RAG
`documents` table so the bot retrieves it at message time.

## Source material

Location: `C:\Users\Derek DiCamillo\OneDrive - PV MEDISPA LLC\Spring2026-Mentorship`

- **18 slide-deck PDFs** — downloaded, fully readable. Primary source.
- **18 graphics** (JPG/PNG) — reference tables (optimal labs, fats/carb/protein charts,
  metabolic-syndrome tree). Read visually and transcribed to markdown so embeddings can
  index them (images are not RAG-searchable).
- **`course_lesson_notes.md`** (51 KB) — already-exported Podia lesson notes that
  summarize each video recording. Provides the video substance.
- **11 video recordings (~3.5 GB)** — OneDrive cloud placeholders, NOT downloaded.
  Out of scope; their content is captured in the lesson notes. (Decision: PDFs + notes.)

## Decisions locked

- **Source depth:** PDFs + lesson notes + transcribed graphics. No video transcription.
- **Structure:** per-topic folders (mirrors existing `parasite-protocol` pattern),
  file count scaled to each topic's actual content — no forced 15-file padding.
- **Retrieval scope:** global (all bots can retrieve, same as parasite-protocol).
  No `src/search.ts` change.

## Runtime mechanism (how "teach" works)

- `ingestDocument()` in `src/search.ts` chunks + embeds markdown into Supabase
  `documents` via the `ingest` edge function; dedups by content hash (safe re-runs).
- At message time the bot does global semantic retrieval across `documents`; ingested
  docs pass a Haiku "reader-gate" (untrusted-source gating) before reaching the planner.
- `scripts/ingest-knowledge-layer.ts` is the existing one-shot ingest walker, but it
  hardcodes `source="pv-knowledge-layer"`. We add a dedicated ingest tagged
  `source="functional-medicine-mentorship"` for identifiability and clean re-ingest.

## Target layout

```
docs/knowledge/functional-medicine/
├── README.md                      # domain index (replaces current stub)
├── atlas-training/
│   ├── system-prompt.md           # functional-medicine specialist prompt
│   ├── lab-reference.md           # optimal vs "normal" ranges cheat sheet (high-value)
│   ├── decision-tree.md           # root-cause triage logic
│   ├── case-library.md            # worked case studies as reasoning examples
│   └── faq-knowledge.md           # distilled Q&A
├── 01-lab-optimization/
├── 02-iron-ferritin/
├── 03-inflammation-hashimotos/
├── 04-functional-hypothyroid-mthfr/
├── 05-gut-health-healing/
├── 06-metabolic-syndrome/
├── 07-ckd-nafld-sleep/
├── 08-methylene-blue-ivm-ldn/
├── 09-bone-health/
└── 10-supplements-nutrition/
```

Each topic folder: `README.md` (overview + key takeaways) plus reference files scaled to
content. Rich topics (02, 04, 05, 08) → 3–4 files
(`pathophysiology`, `treatment-protocol`, `dosing-reference`, `case-studies`).
Lean topics (09) → README + one reference file.

### Topic → source mapping

| # | Folder | Primary sources |
|---|---|---|
| 01 | lab-optimization | Functional vs Normal Lab Results.pdf, lab worksheet.pdf, OPTIMAL LAB RESULTS.jpg |
| 02 | iron-ferritin | Iron n Ferritin Mentorship PPT.pdf, IRON AND FERRITIN.jpg |
| 03 | inflammation-hashimotos | Inlfammation for Mentorship with LDN.pdf, INFLAMATION.JPG |
| 04 | functional-hypothyroid-mthfr | Functional Hypothyroid Management PPT.pdf, thyroid questionnaire JHHC.pdf |
| 05 | gut-health-healing | Gut Health for Mentorship.pdf, gut healing protocol2025.pdf |
| 06 | metabolic-syndrome | Metabolic Syndrom for mentorship.pdf, MET SYNDROME TREE.jpg, carb/fat/protein graphics |
| 07 | ckd-nafld-sleep | CKD for mentorship 2026.pdf, NAFLD for mentorship.pdf, Sleep_Optimization for mentorship 2026.pdf |
| 08 | methylene-blue-ivm-ldn | IVM and MB for Mentorship.pptm, LDN for mentorship.pdf, LDN.JPG |
| 09 | bone-health | bone health and the WHI results.pdf |
| 10 | supplements-nutrition | Supplements for mentorship.pdf, diet graphics (grains, butter, fats, plant protein, crude protein) |

Shared graphics (3-legged stool, Resources, Tips for Beginners, Magnesium, Vitamin D,
Low Carb Definitions) → folded into the most relevant topic README or lab-reference.

## Authoring conventions

- Clean markdown, provider-level clinical language (Derek is an FNP); mirror the tone and
  structure of `docs/knowledge/parasite-protocol/`.
- Preserve specific dosing, product names, lab thresholds, and protocol sequencing exactly
  as taught (e.g. "Ferosolv 45mg BID", "ferritin target 80–100", "recheck at 4 months").
- Label evidence quality where the course does (consensus/functional-med convention vs RCT).
- Each file self-contained enough to make sense as a retrieved chunk.

## Execution

1. **Parallel authoring** — one subagent per topic (10 total, independent). Each reads its
   mapped PDFs/graphics + the relevant `course_lesson_notes.md` section and writes its
   topic folder. Read tool handles PDFs; graphics read visually.
2. **Training layer** — after topics land, author `atlas-training/` (synthesizes across
   topics: system-prompt, lab-reference, decision-tree, case-library, faq) + domain README.
3. **Ingest (production write)** — dedicated ingest tagged
   `source="functional-medicine-mentorship"`. **Pause for Derek's go-ahead before running.**
   Requires `SUPABASE_URL`/`SUPABASE_ANON_KEY` (present in `.env`).
4. **Verify** — post-ingest semantic queries ("optimal ferritin range", "methylene blue
   SSRI interaction", "gut healing protocol phases", "WHI bone health") return the new
   chunks. Confirm retrieval before declaring done.

## Out of scope

- Video download/transcription.
- Per-agent retrieval isolation (global retrieval accepted).
- Changes to `medicine.md` persona (already covers functional-medicine domain; the
  `atlas-training/system-prompt.md` is the deeper, course-specific layer).

## Success criteria

- All 10 topic folders + `atlas-training/` authored with faithful, specific clinical content.
- Graphics' reference tables transcribed to searchable markdown.
- Content ingested into Supabase under `source="functional-medicine-mentorship"`.
- Verification queries retrieve the new content.
