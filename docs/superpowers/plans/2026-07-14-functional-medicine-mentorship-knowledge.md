# Functional-Medicine Mentorship Knowledge Base — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author a structured functional-medicine knowledge base from the Spring 2026 Mentorship course and ingest it into Atlas's Supabase RAG so the Atlas Medicine bot retrieves it at message time.

**Architecture:** Ten independent per-topic markdown folders under `docs/knowledge/functional-medicine/`, authored by parallel subagents from downloaded PDFs + transcribed graphics + the exported lesson notes. A domain-level `atlas-training/` layer synthesizes across topics. A dedicated ingest script pushes everything to Supabase `documents` tagged `source="functional-medicine-mentorship"`; verification queries confirm retrieval.

**Tech Stack:** Bun, TypeScript, Supabase (edge function `ingest` + `documents` table), `src/search.ts` (`ingestDocument`, `search`).

## Global Constraints

- Source root: `C:\Users\Derek DiCamillo\OneDrive - PV MEDISPA LLC\Spring2026-Mentorship`
- Project root: `C:\Users\Derek DiCamillo\Projects\atlas`
- Ingest source tag (exact): `functional-medicine-mentorship`
- Knowledge home (exact): `docs/knowledge/functional-medicine/`
- Provider-level clinical language (Derek is an FNP). Mirror tone/structure of `docs/knowledge/parasite-protocol/`.
- Preserve exact dosing, product names, lab thresholds, protocol sequencing as taught. Never invent numbers not in the source.
- Label evidence quality where the course does (RCT vs consensus/functional-med convention).
- Each markdown file must be self-contained enough to make sense as a single retrieved RAG chunk (lead with a one-line context header naming the topic).
- Videos (~3.5 GB OneDrive placeholders) are OUT of scope; use `course_lesson_notes.md` for their substance.
- Do NOT run the ingest (Task 12) or `git commit` (Task 14) until Derek gives explicit go-ahead — both are gated.

---

## Shared subagent brief (used by Tasks 1–10)

Every topic subagent (general-purpose) receives this brief, with the per-task specifics appended:

> You are authoring one topic of Derek DiCamillo's functional-medicine knowledge base for
> his clinical AI (Atlas Medicine). Derek is an FNP; write at provider level.
>
> 1. Read every source file listed for your topic. PDFs: use the Read tool (it renders PDFs).
>    Graphics (JPG/PNG): use the Read tool (renders images) and transcribe any reference
>    tables/charts into markdown tables — the image itself is NOT searchable, only your text.
> 2. Read the matching section(s) of `course_lesson_notes.md` for the video takeaways.
> 3. Write files into `docs/knowledge/functional-medicine/<NN-topic>/` (create the folder).
>    Always a `README.md` (overview + "Key Takeaways" bullet list + when-to-use). Add the
>    reference files listed for your topic ONLY where the source has the content to fill them.
> 4. Conventions: match the structure of `docs/knowledge/parasite-protocol/` files. Start each
>    file with `# <Topic> — <Subtopic>` then a one-line context sentence. Preserve exact doses,
>    products, lab thresholds, sequencing. Label evidence quality. No filler; no invented facts.
> 5. Return: the list of files you created and, for each, the 3–5 most important clinical facts
>    it captures (doses/thresholds/protocol steps). This return feeds the atlas-training layer.
>
> Do not touch any files outside your topic folder. Do not run git. Do not ingest.

---

### Task 1: Topic 01 — Lab Optimization

**Files:**
- Create: `docs/knowledge/functional-medicine/01-lab-optimization/README.md`
- Create: `docs/knowledge/functional-medicine/01-lab-optimization/optimal-vs-normal-ranges.md`
- Create: `docs/knowledge/functional-medicine/01-lab-optimization/lab-interpretation-workflow.md`

**Sources:** `Week 1 Video Recording - Lab Optimization/Functional vs Normal Lab Results.pdf`, `.../lab worksheet.pdf`, `OPTIMAL LAB RESULTS.jpg`, `LAB WORKSHEET.pdf`, lesson-notes "Week 1 / Lab Optimization" section.

- [ ] **Step 1:** Dispatch general-purpose subagent with the shared brief + this task's sources/files.
- [ ] **Step 2 (verify):** Confirm `optimal-vs-normal-ranges.md` contains a markdown table of optimal ranges transcribed from OPTIMAL LAB RESULTS.jpg (e.g. ferritin, TSH, Free T3, fasting insulin, HDL, triglycerides, vitamin D, homocysteine, CRP). Grep: `grep -ci "ferritin\|homocysteine\|free t3" <file>` returns > 0.
- [ ] **Step 3:** Confirm README has a "Key Takeaways" list and a when-to-use line.

---

### Task 2: Topic 02 — Iron & Ferritin

**Files:**
- Create: `docs/knowledge/functional-medicine/02-iron-ferritin/README.md`
- Create: `docs/knowledge/functional-medicine/02-iron-ferritin/pathophysiology.md`
- Create: `docs/knowledge/functional-medicine/02-iron-ferritin/treatment-protocol.md`
- Create: `docs/knowledge/functional-medicine/02-iron-ferritin/case-studies.md`

**Sources:** `Week 2 - Iron & ferritin metabolism/Iron n Ferritin Mentorship PPT.pdf`, `IRON AND FERRITIN.jpg`, lesson-notes "Week 2" section (rich — includes the 41 y/o perimenopausal case).

- [ ] **Step 1:** Dispatch subagent with shared brief + sources/files.
- [ ] **Step 2 (verify):** `treatment-protocol.md` captures the exact taught protocol: Ferosolv (ferrous bisglycinate) 45 mg BID, ≤45 mg/dose (nephrotoxicity ceiling), vitamin C 2–4 g TID/QID to bowel tolerance, vitamin D's role lowering hepcidin, recheck at 4 months (100-day RBC lifecycle). Grep: `grep -ci "ferosolv\|hepcidin\|45mg\|45 mg" <file>` > 0.
- [ ] **Step 3:** `case-studies.md` includes the perimenopausal case (CRP 6.0, ferritin 67, low DHEA-S) as a worked reasoning example.

---

### Task 3: Topic 03 — Inflammation / Immune / Hashimoto's

**Files:**
- Create: `docs/knowledge/functional-medicine/03-inflammation-hashimotos/README.md`
- Create: `docs/knowledge/functional-medicine/03-inflammation-hashimotos/inflammation-drivers.md`
- Create: `docs/knowledge/functional-medicine/03-inflammation-hashimotos/hashimotos-management.md`

**Sources:** `Week 4 - Inflammation-Immune System-Hashimoto's/Inlfammation for Mentorship with LDN.pdf`, `INFLAMATION.JPG`, lesson-notes "Week 4" section. (LDN detail lives in Topic 08; here just cross-reference it.)

- [ ] **Step 1:** Dispatch subagent with shared brief + sources/files.
- [ ] **Step 2 (verify):** Files capture inflammatory markers taught (CRP, homocysteine, WBC), Hashimoto's antibody context (TPO/TG), and the root-cause framing (inflammation → autoimmune thyroid). Grep: `grep -rci "hashimoto\|tpo\|crp\|homocysteine" <folder>` > 0.

---

### Task 4: Topic 04 — Functional Hypothyroid & MTHFR

**Files:**
- Create: `docs/knowledge/functional-medicine/04-functional-hypothyroid-mthfr/README.md`
- Create: `docs/knowledge/functional-medicine/04-functional-hypothyroid-mthfr/thyroid-management.md`
- Create: `docs/knowledge/functional-medicine/04-functional-hypothyroid-mthfr/mthfr-methylation.md`
- Create: `docs/knowledge/functional-medicine/04-functional-hypothyroid-mthfr/thyroid-questionnaire.md`

**Sources:** `VIDEO discussion regarding MTHFR and hypothyroidism-/Functional Hypothyroid Management PPT for Mentorship.pdf`, `.../thyroid questionnaire JHHC.pdf`, lesson-notes MTHFR/hypothyroid section.

- [ ] **Step 1:** Dispatch subagent with shared brief + sources/files.
- [ ] **Step 2 (verify):** `thyroid-management.md` captures optimal thyroid targets (TSH, Free T4, Free T3, reverse T3, iodine caution <300 mcg/day) and `mthfr-methylation.md` captures the MTHFR→methylation→homocysteine link + methylfolate/B12 relevance. `thyroid-questionnaire.md` reproduces the questionnaire items. Grep: `grep -rci "free t3\|mthfr\|methylfolate\|reverse t3" <folder>` > 0.

---

### Task 5: Topic 05 — Gut Health & Healing

**Files:**
- Create: `docs/knowledge/functional-medicine/05-gut-health-healing/README.md`
- Create: `docs/knowledge/functional-medicine/05-gut-health-healing/gut-pathophysiology.md`
- Create: `docs/knowledge/functional-medicine/05-gut-health-healing/healing-protocol.md`

**Sources:** `Week 7 - Gut Health & Protocols for Healing/Gut Health for Mentorship.pdf`, `.../gut healing protocol2025.pdf`, `GUT HEALING PROTOCOL.pdf`, `3 LEGGED STOOL.JPG`, lesson-notes "Week 7" section.

- [ ] **Step 1:** Dispatch subagent with shared brief + sources/files.
- [ ] **Step 2 (verify):** `healing-protocol.md` reproduces the gut-healing protocol phases/steps and named supplements exactly as in the PDF (5R-style framework if present, specific products, durations). Grep: `grep -ci "phase\|remove\|replace\|repair\|leaky\|permeab" <file>` > 0.

---

### Task 6: Topic 06 — Metabolic Syndrome

**Files:**
- Create: `docs/knowledge/functional-medicine/06-metabolic-syndrome/README.md`
- Create: `docs/knowledge/functional-medicine/06-metabolic-syndrome/metabolic-syndrome-tree.md`
- Create: `docs/knowledge/functional-medicine/06-metabolic-syndrome/diet-carb-framework.md`

**Sources:** `My Homework Email I send at 1st or 2nd appt-/Metabolic Syndrom for mentorship.pdf`, `MET SYNDROME TREE.jpg`, `CARB RISK.JPG`, `LOW CARB DEFINITIONS.JPG`, `FATS CHART.jpg`, `CRUDE PROTEIN.JPG`, `PLANT PROTEIN.JPG`, `BUTTER.jpg`, `GRAIN LIST.JPG`/`GRAINS.JPG`/`GRAINS 2.JPG`, `TIPS FOR BEGINNERS.JPG`, lesson-notes metabolic-syndrome section.

- [ ] **Step 1:** Dispatch subagent with shared brief + sources/files. Emphasize transcribing the many diet graphics into markdown tables.
- [ ] **Step 2 (verify):** `metabolic-syndrome-tree.md` transcribes the MET SYNDROME TREE branching logic; `diet-carb-framework.md` has the low-carb definitions + carb-risk + fats/protein tables as markdown. Grep: `grep -ci "insulin resist\|triglyceride\|hdl\|low carb\|ketogenic" <folder>/*.md` > 0.

---

### Task 7: Topic 07 — CKD, NAFLD & Sleep

**Files:**
- Create: `docs/knowledge/functional-medicine/07-ckd-nafld-sleep/README.md`
- Create: `docs/knowledge/functional-medicine/07-ckd-nafld-sleep/chronic-kidney-disease.md`
- Create: `docs/knowledge/functional-medicine/07-ckd-nafld-sleep/nafld.md`
- Create: `docs/knowledge/functional-medicine/07-ckd-nafld-sleep/sleep-optimization.md`

**Sources:** `Week 8 - Chronic Kidney Disease, NAFLD, & Sleep Optimization/CKD for mentorship 2026.pdf`, `.../NAFLD for mentorship.pdf`, `.../Sleep_Optimization for mentorship 2026.pdf`, lesson-notes "Week 8" section.

- [ ] **Step 1:** Dispatch subagent with shared brief + sources/files (three distinct sub-topics → three reference files).
- [ ] **Step 2 (verify):** Each of the three files has substantive content: CKD staging/eGFR management, NAFLD drivers (fructose/insulin resistance) + reversal, sleep-optimization protocol (specifics taught). Grep each: `grep -ci "egfr\|creatinine" ckd*.md`, `grep -ci "hepatic\|fructose\|steatos" nafld.md`, `grep -ci "melatonin\|circadian\|sleep hygiene" sleep*.md` all > 0.

---

### Task 8: Topic 08 — Methylene Blue, Ivermectin & LDN

**Files:**
- Create: `docs/knowledge/functional-medicine/08-methylene-blue-ivm-ldn/README.md`
- Create: `docs/knowledge/functional-medicine/08-methylene-blue-ivm-ldn/methylene-blue.md`
- Create: `docs/knowledge/functional-medicine/08-methylene-blue-ivm-ldn/ivermectin.md`
- Create: `docs/knowledge/functional-medicine/08-methylene-blue-ivm-ldn/low-dose-naltrexone.md`

**Sources:** `Week 9 - Methylene Blue, Ivermectin, Low Dose Naltrexone/IVM and MB for Mentorship.pptm`, `.../LDN for mentorship.pdf`, `LDN.JPG`, lesson-notes "Week 9" section. NOTE: `.pptm` is PowerPoint — if Read can't render it, note that and extract what the lesson notes + LDN.JPG cover, and flag the gap in the file.

- [ ] **Step 1:** Dispatch subagent with shared brief + sources/files.
- [ ] **Step 2 (verify):** `methylene-blue.md` captures dosing + the **MB + SSRI/SNRI serotonin-syndrome contraindication** (already a soft-caution in `medicine.md`); `low-dose-naltrexone.md` captures LDN dosing (typically 1.5–4.5 mg nightly) + indications. Grep: `grep -ci "ssri\|serotonin\|4.5\|naltrexone" <folder>/*.md` > 0.
- [ ] **Step 3:** If `.pptm` could not be read, the folder README explicitly notes the source gap.

---

### Task 9: Topic 09 — Bone Health

**Files:**
- Create: `docs/knowledge/functional-medicine/09-bone-health/README.md`
- Create: `docs/knowledge/functional-medicine/09-bone-health/bone-health-whi.md`

**Sources:** `Week 10 - Bone Health/bone health and the WHI results.pdf`, `MAGNESIUM.png`, `VITAMIN D.JPG`, lesson-notes "Week 10" section.

- [ ] **Step 1:** Dispatch subagent with shared brief + sources/files.
- [ ] **Step 2 (verify):** `bone-health-whi.md` captures the WHI (Women's Health Initiative) findings as taught + the bone-support stack (D3/K2/Mg/boron — "Osteopiex" appears in lesson notes). Grep: `grep -ci "whi\|women's health initiative\|osteo\|boron\|k2" <file>` > 0.

---

### Task 10: Topic 10 — Supplements & Nutrition

**Files:**
- Create: `docs/knowledge/functional-medicine/10-supplements-nutrition/README.md`
- Create: `docs/knowledge/functional-medicine/10-supplements-nutrition/supplement-reference.md`
- Create: `docs/knowledge/functional-medicine/10-supplements-nutrition/fullscript-and-resources.md`

**Sources:** `Week 5 - Buiness Mgmt & FullScript Use/Supplements for mentorship.pdf`, `RESOURCES.jpg`, `LDN.JPG` (product context), diet graphics not consumed by Topic 06, lesson-notes "Week 5" section. NOTE: business-management content is out of clinical scope — capture the FullScript/dispensary workflow briefly but focus on the supplement reference.

- [ ] **Step 1:** Dispatch subagent with shared brief + sources/files.
- [ ] **Step 2 (verify):** `supplement-reference.md` is a consolidated table of named supplements taught across the course with doses/indications (Ferosolv, Osteopiex, berberine/dihydroberberine, vitamin C, D3/K2, iodine, DHEA, progesterone, methylfolate, etc.). Grep: `grep -ci "berberine\|osteopiex\|dhea\|dose" <file>` > 0.

---

### Task 11: Domain training layer + index README

**Files:**
- Create: `docs/knowledge/functional-medicine/atlas-training/system-prompt.md`
- Create: `docs/knowledge/functional-medicine/atlas-training/lab-reference.md`
- Create: `docs/knowledge/functional-medicine/atlas-training/decision-tree.md`
- Create: `docs/knowledge/functional-medicine/atlas-training/case-library.md`
- Create: `docs/knowledge/functional-medicine/atlas-training/faq-knowledge.md`
- Modify: `docs/knowledge/functional-medicine/README.md` (replace the 2 KB stub with a real domain index linking all 10 topics + the training layer)

**Interfaces:**
- Consumes: the returned "most important facts" summaries from Tasks 1–10.
- Reference model: `docs/knowledge/parasite-protocol/atlas-training/system-prompt.md` (mirror its structure) and the existing `config/personas/medicine.md` (reuse its hard-refusals/soft-cautions verbatim so they don't drift).

- [ ] **Step 1:** Author `system-prompt.md` — functional-medicine specialist prompt: identity (trained on this mentorship), root-cause operating principles (the recurring inflammation→insulin-resistance→hormones→thyroid→iron logic), evidence weighting, workflow (intake → optimal-range interpretation → root-cause → protocol), and the hard-refusals/soft-cautions copied from `medicine.md`.
- [ ] **Step 2:** Author `lab-reference.md` — single consolidated optimal-vs-normal ranges cheat sheet (pull from Task 1's `optimal-vs-normal-ranges.md`; this is the highest-value RAG target — make it a clean markdown table).
- [ ] **Step 3:** Author `decision-tree.md` — the root-cause triage decision tree used across the case studies.
- [ ] **Step 4:** Author `case-library.md` — the worked cases (perimenopausal case from Task 2 + any others in the notes) as reusable reasoning examples.
- [ ] **Step 5:** Author `faq-knowledge.md` — Q&A distilled from the course's recurring questions.
- [ ] **Step 6:** Rewrite `README.md` as the domain index (table of the 10 topics with one-line descriptions + links, and a pointer to `atlas-training/`).
- [ ] **Step 7 (verify):** `grep -rL "Key Takeaways\|^# " docs/knowledge/functional-medicine/**/README.md` returns nothing (every README is real). `ls docs/knowledge/functional-medicine/atlas-training/` shows all 5 files.

---

### Task 12: Create the dedicated ingest script

**Files:**
- Create: `scripts/ingest-mentorship.ts` (adapted copy of `scripts/ingest-knowledge-layer.ts`)

- [ ] **Step 1:** Copy `scripts/ingest-knowledge-layer.ts` to `scripts/ingest-mentorship.ts`. Change: `DEFAULT_PATH` → `"C:\\Users\\Derek DiCamillo\\Projects\\atlas\\docs\\knowledge\\functional-medicine"`; the `ingestDocument` call `source:` → `"functional-medicine-mentorship"` and `metadata` → `{ rootDir: knowledgePath, originalPath: filePath, course: "Spring2026-Mentorship" }`; the startup log line to match.
- [ ] **Step 2 (dry check, no writes):** `cd "C:/Users/Derek DiCamillo/Projects/atlas" && bun build scripts/ingest-mentorship.ts --target=bun > /dev/null && echo TYPECHECK_OK` — expect `TYPECHECK_OK` (confirms it compiles without running/ingesting).
- [ ] **Step 3:** Confirm the file walker still filters to `.md/.markdown/.txt` and skips dotfiles/node_modules (unchanged from the original).

---

### Task 13: Ingest into Supabase — GATED on Derek's go-ahead

**Preconditions:** Derek explicitly approves. `.env` has `SUPABASE_URL` + `SUPABASE_ANON_KEY` (confirmed present).

- [ ] **Step 1:** Pause and get Derek's explicit "run it." (Production write.)
- [ ] **Step 2:** Run: `cd "C:/Users/Derek DiCamillo/Projects/atlas" && bun run scripts/ingest-mentorship.ts`
- [ ] **Step 3 (verify):** Output reports `files processed` ≈ total markdown file count and `total chunks` > 0, `files errored: 0`. If errors, read the "First errors" list and fix, then re-run (content-hash dedup makes re-runs safe — unchanged files skip).

---

### Task 14: Verify retrieval + commit — GATED

**Files:**
- Create: `scripts/verify-mentorship-retrieval.ts` (throwaway verification script)

- [ ] **Step 1:** Write `scripts/verify-mentorship-retrieval.ts`:

```ts
#!/usr/bin/env bun
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { search } from "../src/search.ts";
config({ override: true });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const queries = [
  "optimal ferritin range",
  "methylene blue SSRI serotonin syndrome interaction",
  "gut healing protocol phases",
  "WHI bone health results",
  "functional vs normal TSH free T3 range",
  "low dose naltrexone dosing",
];
for (const q of queries) {
  const res = await search(supabase, q, { tables: ["documents"], matchCount: 3, matchThreshold: 0.3 });
  console.log(`\n=== ${q} ===`);
  for (const r of res) console.log(`  [${(r as any).similarity?.toFixed?.(2) ?? "?"}] ${String((r as any).content).slice(0, 120).replace(/\n/g, " ")}`);
  if (res.length === 0) console.log("  (no results)");
}
```

- [ ] **Step 2:** Run: `cd "C:/Users/Derek DiCamillo/Projects/atlas" && bun run scripts/verify-mentorship-retrieval.ts`
- [ ] **Step 3 (verify):** Each query returns ≥1 chunk that is visibly from the mentorship content (ferritin query → iron-ferritin material, etc.). If a query returns nothing, lower `matchThreshold` to confirm ingest vs. retrieval-tuning, and check the chunk actually ingested.
- [ ] **Step 4:** Delete `scripts/verify-mentorship-retrieval.ts` (throwaway).
- [ ] **Step 5 (GATED on Derek):** With approval, commit:

```bash
cd "C:/Users/Derek DiCamillo/Projects/atlas"
git add docs/knowledge/functional-medicine scripts/ingest-mentorship.ts docs/superpowers
git commit -m "feat(knowledge): add Spring 2026 functional-medicine mentorship knowledge base + ingest"
```

---

## Self-Review

**Spec coverage:**
- 10 topic folders → Tasks 1–10 ✓
- atlas-training layer (system-prompt, lab-reference, decision-tree, case-library, faq) + domain README → Task 11 ✓
- Graphics transcribed to markdown → baked into shared brief + Tasks 1, 6, 9 verify steps ✓
- Dedicated ingest tagged `functional-medicine-mentorship` → Task 12 ✓
- Production-write gate → Task 13 Step 1 ✓
- Verification queries → Task 14 ✓
- No `medicine.md` change (out of scope) → respected; system-prompt reuses its refusals ✓

**Placeholder scan:** No TBD/TODO; each task has explicit files, sources, and grep-based verify checks. Ingest/verify tasks have real, complete code.

**Type consistency:** `ingestDocument(supabase, content, {source, sourcePath, title, metadata})` and `search(supabase, query, {tables, matchCount, matchThreshold})` match `src/search.ts` exports verbatim.

**Gates:** Ingest (Task 13) and commit (Task 14 Step 5) both explicitly gated on Derek per his standing rule.
