# Search Results: Nico Misla / HRTU BHRT Training Content

**Search completed:** 2026-08-28  
**Status: Partial — materials found on OneDrive, but not extractable from binary files; Supabase ingest status unverifiable without MCP auth**

---

## Summary

The name in Atlas's system is **Nico Misleh, NP** (not "Misla") — confirmed in the TMAA partners database and the MAA newsletter spec. The organization is **HRT University (HRTU)**. The training materials DO exist on OneDrive. They are NOT present as readable text in the local `docs/knowledge/` directory. The Supabase documents table (which may contain prior ingested versions) could not be queried — the supabase MCP plugin requires authentication that is not available in this session.

---

## 1. HRTU / Nico Misleh Identity Confirmed

**Source 1 — `db/migrations/022_tmaa_partners.sql` (verbatim):**
```sql
INSERT INTO tmaa_partners (name, contact_name, description, discount_code, discount_description, url, category) VALUES
  ('HRT University', 'Nico Misleh, NP', 'Comprehensive hormone replacement therapy certification for nurse practitioners and physician assistants. Covers bioidentical hormones, pellet therapy, and practice integration. Ideal for practitioners expanding into HRT services.', 'DEREKMC5', '$200 off certification course', 'https://hrtuniversity.com', 'training'),
```

**Source 2 — `docs/superpowers/plans/2026-04-02-maa-newsletter-automation.md` (verbatim):**
```
| HRT University | Nico Misleh, NP | DEREKMC5 | $200 off certification | training |
```

**Source 3 — `atlas-tier1-fixes.html`** — confirms HRTU content was being ingested (or attempted) into Atlas's knowledge base, but some chunks were being dropped due to a Reader.ts parsing bug being fixed on that date:
> *"7+ knowledge chunks lost today across journal, knowledge-layer, HRTU, Telegram ingest."*

---

## 2. HRTU Files Found on OneDrive

**Location:** `C:\Users\Derek DiCamillo\OneDrive - PV MEDISPA LLC\06_Training\AI_Files\AI Training Files\HRT U\`

| File | Type | Status |
|---|---|---|
| `HRTU_DOSING_GUIDE_2_.pdf` | PDF | Exists, not readable (no poppler) |
| `HRTU_LAB_REFERENCES_1_1_.pdf` | PDF | Exists, not readable |
| `Copy of FEMALE WORKBOOK.pdf` | PDF | Exists, not readable |
| `Copy of MALE WORKBOOK.pdf` | PDF | Exists, not readable |
| `Copy of THYROID WORKBOOK.pdf` | PDF | Exists, not readable |
| `Copy of ADJUNCT WORKBOOK.pdf` | PDF | Exists, not readable |
| `INTRO_HRTU_STUDIES.pdf` | PDF | Exists, not readable |
| `INTRO-_Metabolic_Principles (1).pdf` | PDF | Exists, not readable |
| `MALE_HRTU_STUDIES.pdf` | PDF | Exists, not readable |
| `TROUBLE_SHOOTING_GUIDE.pdf` | PDF | Exists, not readable |
| `HRT_UNIVERSITY_PATIENT_HANDOUT_UNDERSTANDING_BIOIDENTICAL_HORMONE_REPLACEMENT_THERAPY_BHRT_WITH_EVIDENCE-BASED_SUPPORT.pdf` | PDF | Exists, not readable |
| `Womens BHRT Transcript.docx` | DOCX binary | Exists, not readable |
| `Mens HRT.docx` | DOCX binary | Exists, not readable |
| `Intro To BHRT.docx` | DOCX binary | Exists, not readable |
| `Thyroid Transcript.docx` | DOCX binary | Exists, not readable |
| `ADJUNCT_Section_1_Part_1.docx` | DOCX binary | Exists, not readable |

**Separate BHRT Training folder:** `C:\Users\Derek DiCamillo\OneDrive - PV MEDISPA LLC\06_Training\Reference_Library\Business\Guides_Resources\BHRT Training\`

| File | Type |
|---|---|
| `Friday BHRT Part I Nov 2024 (1).pdf` | PDF (3-day event, Nov 8-10 2024) |
| `Saturday BHRT Part I Nov 2024 (2).pdf` | PDF |
| `Sunday BHRT Part I Nov 2024 (2).pdf` | PDF |
| `Policy and Procedure Manual Outline for BHRT (...).docx` | DOCX |
| 20x `.mp4` recordings from 2024-11-08 through 2024-11-10 | Video (not readable) |

Also found: `C:\Users\Derek DiCamillo\OneDrive - PV MEDISPA LLC\07_Personal\Onyx_Notebooks\onyx\NoteAir4C\Notebooks\Women BHRT.pdf`

---

## 3. Local Atlas Knowledge Base — HRTU Content NOT Present

**Checked:** `C:\Users\Derek DiCamillo\Projects\atlas\docs\knowledge\` — all subdirectories  

The `docs/knowledge/bhrt/` directory exists but contains **only a README placeholder with no clinical content:**

```markdown
# BHRT (Bioidentical Hormone Replacement Therapy)
Clinical knowledge base for hormone optimization protocols.

## Content to populate
[placeholder lists for Men's Health, Women's Health, General]
```

No HRTU protocols, no Nico Misleh clinical content, no female testosterone dosing from HRTU is present in the local knowledge directory.

**Checked:** `C:\Users\Derek DiCamillo\Projects\atlas\data\training\` — directory does not exist.

---

## 4. Supabase Ingest Status — Cannot Verify

The `atlas-tier1-fixes.html` confirms HRTU content was being ingested into Supabase. Whether the ingest succeeded (after the Reader.ts fix) is unknown — the Supabase MCP plugin requires OAuth authentication not available in this headless session.

**The only way to verify this:** run `/ingest status` or query `SELECT source, count(*) FROM documents WHERE source ILIKE '%HRTU%' OR source ILIKE '%HRT%' GROUP BY source` directly from an Atlas session with Supabase access.

---

## 5. What IS in the Knowledge Base (Hormone-Adjacent, Different Source)

The **Joyful Heart Institute Spring 2026 mentorship** (Jenni Gallagher, APRN) material IS ingested and readable in `docs/knowledge/functional-medicine/01-lab-optimization/`. It contains limited hormone reference ranges, but this is NOT HRTU content:

**From `docs/knowledge/functional-medicine/01-lab-optimization/optimal-vs-normal-ranges.md`:**

| Lab | Optimal/Functional Target | Source |
|---|---|---|
| Total testosterone | Mid-range or higher | Course notes |
| Free testosterone | Upper 1/3 of range | Course notes |
| DHEA-S | Mid-range (age/sex-dependent) | Course notes |
| Estradiol (E2) | Closer to 100 pg/mL | Course notes |
| Estrone (E1) | As low as possible; E1 < E2 | Course notes |

**From the video transcript (`01-lab-optimization.transcript.txt`) — verbatim quotes from Jenni Gallagher:**

> "[60:40] Ideally for total testosterone for men and women, we want it mid-range or higher. [60:46] The women level is beginning to change a little bit. [60:50] We're wanting more testosterone for women to feel better [60:55] and we're starting to see some of those levels go [60:58] above range, free testosterone. [61:02] We want to be the upper third of the range."

> "[61:10] So if you have a total testosterone on a female [61:14] who is running a 50-ish, 45 or 50 for her total T, [61:19] we should expect most women at certain points of their cycle [61:27] to run an estradiol level around that 50 [61:33] and the estradiol level pretty close together and not far apart. [61:39] If their estradiol level is 320 [61:43] and their testosterone is 10, [61:45] they have some severe insulin resistance [61:48] and estrogen dominance going on."

Note: This course frames hormone imbalances as downstream of insulin resistance — correcting insulin is upstream of sex hormone correction. This is the **Joyful Heart Institute functional medicine framework**, not HRTU.

**Attribution:** Jenni Gallagher, APRN — Joyful Heart Institute Spring 2026 mentorship. Evidence label: functional-medicine practitioner consensus. No HRTU attribution.

---

## 6. Answer to Each Requested Item (HRTU-specific)

| Question | Finding |
|---|---|
| Female testosterone dosing recommendations | **NOT FOUND** in readable form — HRTU Dosing Guide exists on OneDrive but is a PDF that cannot be extracted in this environment |
| Target lab ranges for total T and free T in women | **NOT FOUND** from HRTU — only Joyful Heart Institute consensus (above) |
| Preferred routes of administration | **NOT FOUND** from HRTU |
| Stated indications for testosterone in women | **NOT FOUND** from HRTU |
| Monitoring schedule | **NOT FOUND** from HRTU |
| SHBG position | **NOT FOUND** from HRTU |

---

## 7. What Atlas Needs to Answer Derek's Question

To actually compare against Nico Misleh / HRTU protocols, one of these must happen:

**Option A (fastest):** Ingest the OneDrive HRTU files. Run:
```
[INGEST_FOLDER: path=C:\Users\Derek DiCamillo\OneDrive - PV MEDISPA LLC\06_Training\AI_Files\AI Training Files\HRT U | SOURCE: HRTU | QUERY: female testosterone dosing pellet cream injectable lab targets monitoring SHBG]
```

**Option B:** If HRTU was already ingested into Supabase (pre-Reader.ts fix), run a semantic search from Atlas directly:
```
/memory search "female testosterone dosing HRTU"
```

**Option C:** Read the `Womens BHRT Transcript.docx` file directly — it's a DOCX which could be extracted with a Python/PowerShell script if run from Derek's machine.

---

## 8. Context Atlas Gave Derek (Without HRTU Content)

Before dispatching this agent, Atlas gave Derek a conservative evidence-based comparison from the Global Consensus Position Statement (2019). The key likely divergences between that and HRTU are, per Atlas's own assessment:

1. **Target levels:** Consensus = 15–70 ng/dL (premenopausal physiologic). Optimization-oriented BHRT training (including HRTU) often targets 70–150+ ng/dL.
2. **Indication breadth:** Consensus = HSDD in postmenopausal women only. BHRT training = energy, mood, body composition, bone, cognition.
3. **Route preference:** Consensus = transdermal preferred, pellets not endorsed. Most BHRT training = pellet-forward.
4. **Free T weighting:** Optimization protocols often titrate to free T + symptoms rather than total T alone.

This comparison was generated from Atlas's general knowledge of the practice landscape, NOT from confirmed HRTU training content.

---

**Bottom line:** HRTU materials exist on Derek's OneDrive but are not in an ingested/readable state within Atlas's knowledge base as text. The Supabase database may or may not contain prior ingest attempts. To provide a genuine HRTU-vs-guidelines comparison, the materials need to be ingested first. The `HRTU_DOSING_GUIDE_2_.pdf` and `Womens BHRT Transcript.docx` are the highest-priority files for answering Derek's specific question about female testosterone dosing.
