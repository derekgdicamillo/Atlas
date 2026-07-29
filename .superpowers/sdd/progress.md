# Progress Ledger — Functional-Medicine Mentorship Knowledge Base
Plan: docs/superpowers/plans/2026-07-14-functional-medicine-mentorship-knowledge.md

- [x] Task 1: 01-lab-optimization — 3 files, verified (ferritin/thyroid/inflammation ranges)
- [x] Task 2: 02-iron-ferritin — 4 files, verified (Ferosolv/hepcidin/4mo recheck + 6 cases)
- [x] Task 3: 03-inflammation-hashimotos — 3 files, verified (TPO/CRP, T3 ferritin gate)
- [x] Task 4: 04-functional-hypothyroid-mthfr — 4 files, verified (FT3/RT3 targets, ferritin>45 gate, methylation, questionnaire)
- [x] Task 5: 05-gut-health-healing — 3 files, verified (7-step protocol, products/doses). NOTE: IVM dose discrepancy 0.4 vs 4.4 mg/kg/day flagged in doc.
- [x] Task 6: 06-metabolic-syndrome — 3 files, verified (MET tree, ATP III, berberine)
- [x] Task 7: 07-ckd-nafld-sleep — 4 files, verified (eGFR/uric acid, NAFLD carb-load, sleep protocol)
- [x] Task 8: 08-methylene-blue-ivm-ldn — 4 files, verified (.pptm unzipped/parsed; MB+SSRI + G6PD; 2 LDN protocols). IVM 0.4-vs-4.4 discrepancy cross-confirmed.
- [x] Task 9: 09-bone-health — 2 files, verified. NOTE: "WHI results.pdf" is actually a pre-WHI 2002 AHRQ review; flagged in doc.
- [x] Task 10: 10-supplements-nutrition — 3 files, verified (~45 supplements, FullScript, graphics). ALL 10 TOPICS DONE: 33 files, ~50k words.
- [x] Task 11: atlas-training (5 files) + domain README — verified. KB total: 39 files, ~54k words.
- [x] Task 12: ingest-mentorship.ts — created, TYPECHECK_OK
- [x] Task 13: ingest run — DONE (Derek approved). 39 files, 0 errors, 262 chunks in Supabase source="functional-medicine-mentorship".
- [x] Task 14: verify — DONE. All 8 retrieval queries returned correct mentorship chunks (incl. ferritin>45 T3 gate, MB+SSRI). Verify script removed. COMMIT still gated on Derek.

## Follow-on: ivermectin dose correction (Derek requested research)
- [x] Deep-research (100-agent workflow): 0.4 mg/kg/day defensible (NEJM head-lice RCT + IMCWC integrative protocol); 4.4 mg/kg/day = transcription error, exceeds highest human-studied dose (2 mg/kg, Guzzo 2002). Resolved toward 0.4.
- [x] Corrected 7 KB files (08/ivermectin.md, 08/README, 05/gut-pathophysiology, README, decision-tree, faq, system-prompt) + re-ingested.
- [x] DISCOVERED: ingest edge fn dedups by hash but never deletes superseded chunks → orphaned stale chunks retrievable.
- [x] FIXED (durable, Derek chose B): patched supabase/functions/ingest/index.ts to delete prior (source,source_path) chunks with different hash. Deployed via CLI (SUPABASE_ACCESS_TOKEN, --project-ref ctiknmztlqqjzhgmyfbu; no Docker/browser).
- [x] Re-ingested (self-heal) + verified: 0 stale ivermectin chunks remain; corrected 0.4 mg/kg content intact.
- [ ] GIT COMMIT — still gated on Derek. Also: original OneDrive course notes still have 4.4 (Derek to fix at source).
