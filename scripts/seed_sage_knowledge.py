"""
Seed S.A.G.E. knowledge base with scope_of_practice, delegation_supervision,
and business_entity topics for 15 states.
"""

import json
import urllib.request
import hashlib
import time
import ssl

SUPABASE_URL = "https://ctiknmztlqqjzhgmyfbu.supabase.co"
ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0aWtubXp0bHFxanpoZ215ZmJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5ODEyNTIsImV4cCI6MjA4NjU1NzI1Mn0.mI601PW8FUqQOpJRLdmAgLlfioo4_siftyfWEhTiV-o"

# Allow unverified SSL for edge functions if needed
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def embed_text(text):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/embed",
        data=json.dumps({"text": text[:2000]}).encode(),
        headers={
            "Authorization": f"Bearer {ANON_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, context=ctx) as resp:
        return json.loads(resp.read())["embedding"]


def insert_chunk(state_code, topic, title, content, source_name, source_url):
    embedding = embed_text(f"{title}\n{content}")
    chunk_hash = hashlib.sha256(content.encode()).hexdigest()
    row = {
        "state_code": state_code,
        "topic": topic,
        "title": title,
        "content": content,
        "source_name": source_name,
        "source_url": source_url,
        "embedding": embedding,
        "chunk_hash": chunk_hash,
        "last_verified_at": "2026-03-16T00:00:00Z",
    }
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/maa_knowledge",
        data=json.dumps(row).encode(),
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {ANON_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
    )
    with urllib.request.urlopen(req, context=ctx) as resp:
        return resp.status


# ─── STATE DATA ──────────────────────────────────────────────────────────────

STATE_DATA = {
    "TX": {
        "scope_of_practice": {
            "title": "Texas NP Scope of Practice for Medical Aesthetics",
            "content": (
                "Texas classifies Nurse Practitioners (APRNs) under restricted practice authority. "
                "Per Texas Occupations Code Chapter 157 and Chapter 301, APRNs must maintain a written "
                "prescriptive authority agreement with a delegating physician. Tex. Occ. Code Sec. 157.0512 "
                "governs this relationship.\n\n"
                "Prescribing authority is delegated, not independent. The prescriptive authority agreement must "
                "specify the drugs and devices delegated, all practice site locations, the method of physician "
                "supervision, and the frequency of chart review. Schedule II-V controlled substances may be "
                "prescribed only under this delegation.\n\n"
                "A delegating physician may supervise a maximum of 7 APRNs, with limited exceptions outlined "
                "in 22 TAC Section 185. The physician must be available for consultation at all times during "
                "APRN practice hours.\n\n"
                "For medspa NPs, this means independent clinical decision-making is not permitted. Every "
                "treatment protocol, prescriptive decision, and clinical pathway must trace back to the "
                "delegating physician's oversight. The Texas Board of Nursing (bon.texas.gov) and Texas "
                "Medical Board jointly regulate APRN practice.\n\n"
                "Key statutes: Tex. Occ. Code Ch. 157, Ch. 301, Sec. 157.0512; 22 TAC Sec. 185."
            ),
            "source_url": "https://www.bon.texas.gov/",
        },
        "delegation_supervision": {
            "title": "Texas Delegation and Supervision Rules for Medspas",
            "content": (
                "Texas has specific delegation and supervision rules governing who may perform medical "
                "aesthetic procedures.\n\n"
                "Injectables (Botox, dermal fillers): RNs may administer injectables under physician standing "
                "orders with documented training and competency verification. The delegating physician must "
                "have established written protocols covering patient selection criteria, dosing, adverse event "
                "management, and emergency procedures. Estheticians CANNOT perform injectables under any "
                "circumstances in Texas.\n\n"
                "Laser treatments: Texas requires physician oversight for all Class IV medical lasers per "
                "22 TAC Chapter 217. The physician does not need to be physically present for every treatment "
                "but must have established protocols and be available for immediate consultation. RNs and "
                "APRNs may operate medical lasers under delegation. Estheticians may operate certain "
                "non-medical cosmetic devices but cannot use prescription laser devices.\n\n"
                "Supervision structure: The delegating physician must be available for real-time consultation "
                "at all times. Chart review frequency is specified in the prescriptive authority agreement "
                "per 22 TAC Sec. 185. The Texas Medical Board actively audits medspa delegation practices, "
                "particularly arrangements where the physician has minimal actual involvement.\n\n"
                "Key references: 22 TAC Ch. 217 (lasers), 22 TAC Sec. 185 (delegation), Tex. Occ. Code "
                "Sec. 157.0512 (prescriptive authority agreements)."
            ),
            "source_url": "https://www.bon.texas.gov/",
        },
        "business_entity": {
            "title": "Texas Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "Texas strictly enforces the Corporate Practice of Medicine (CPOM) doctrine. Per Tex. Occ. "
                "Code Sec. 164.052(a)(17), non-physicians cannot own a medical practice or employ physicians "
                "to practice medicine.\n\n"
                "Required structure: A physician must own the professional entity (PLLC) that delivers medical "
                "services. Texas requires a PLLC, not a standard LLC, for professional healthcare services "
                "per Texas Business Organizations Code Chapter 301. The NP owns a separate Management Services "
                "Organization (MSO), structured as a standard LLC, that provides all non-clinical operations: "
                "facility lease, equipment, staffing, marketing, billing, and practice management.\n\n"
                "The MSO and PLLC are connected through a Management Services Agreement (MSA). Typical terms: "
                "management fee of 70-85% of PC revenue flowing to the MSO, 10-20 year term with auto-renewal, "
                "termination protections, and non-compete provisions for the physician.\n\n"
                "The Texas Medical Board actively audits medspa MSO structures. Sham arrangements where the "
                "physician is a name on paper only, never reviews charts, and 100% of revenue flows to the "
                "MSO are enforcement targets. The physician must be genuinely involved in clinical oversight, "
                "protocol development, and chart review.\n\n"
                "Formation: File PLLC with TX Secretary of State (TX Bus. Orgs. Code Ch. 301). File MSO as "
                "standard LLC. Budget $5,000-10,000 for a healthcare attorney to draft the MSA. Do not "
                "attempt a DIY MSO structure in Texas.\n\n"
                "Key statutes: Tex. Occ. Code Sec. 164.052(a)(17), TX Bus. Orgs. Code Ch. 301."
            ),
            "source_url": "https://www.bon.texas.gov/",
        },
    },
    "CA": {
        "scope_of_practice": {
            "title": "California NP Scope of Practice for Medical Aesthetics",
            "content": (
                "California classifies NPs under restricted practice authority, with a transition pathway. "
                "AB 890 (2020, effective 2023) created a route to independent practice after completing "
                "transition-to-practice requirements: 3+ years and 4,600+ hours of clinical experience. "
                "Cal. Bus. & Prof. Code Sec. 2837-2837.105.\n\n"
                "Until the AB 890 transition is complete, NPs must practice under standardized procedures "
                "with a supervising physician per Cal. Bus. & Prof. Code Sec. 2836.1. Standardized Procedure "
                "Agreements (SPAs) must detail each procedure the NP may perform, criteria for physician "
                "consultation, and the defined scope of NP practice. Cal. Code Regs. tit. 16 Sec. 1474.\n\n"
                "Prescriptive authority operates under the SPA framework. NPs may prescribe Schedule II-V "
                "controlled substances only within the scope defined by their standardized procedures and "
                "with appropriate physician oversight.\n\n"
                "For medspa NPs, AB 890 implementation is still evolving. NP practice authority depends on "
                "completing the Section 103 transition-to-practice pathway. The California Board of Registered "
                "Nursing (rn.ca.gov) actively enforces standardized procedure compliance.\n\n"
                "Key statutes: Cal. Bus. & Prof. Code Sec. 2836.1, 2837-2837.105; Cal. Code Regs. tit. 16 "
                "Sec. 1474; AB 890 (2020)."
            ),
            "source_url": "https://www.rn.ca.gov/",
        },
        "delegation_supervision": {
            "title": "California Delegation and Supervision Rules for Medspas",
            "content": (
                "California has strict delegation and supervision rules for medical aesthetic procedures.\n\n"
                "Injectables: RNs may administer Botox and dermal fillers under physician orders with "
                "specific, documented training. The physician must have established protocols and be available "
                "for consultation. Estheticians cannot perform any medical procedures in California, including "
                "injectables.\n\n"
                "Laser and IPL treatments: The California Medical Board has specific guidance on laser/IPL "
                "procedures. Per Bus. & Prof. Code Sec. 2023, these must be performed by or under the direct "
                "supervision of a physician. RNs and NPs may operate medical laser devices under physician "
                "delegation with documented training and competency. Estheticians cannot operate prescription "
                "medical laser devices.\n\n"
                "Standardized Procedure Agreements (SPAs) govern all NP delegation. The SPA must specify "
                "each procedure, the conditions under which the NP must consult the physician, and the "
                "supervision method. SPAs are reviewed and updated annually.\n\n"
                "The California Medical Board and Board of Registered Nursing jointly oversee medspa "
                "delegation practices. California is among the most actively enforced states for delegation "
                "compliance, particularly in cash-pay aesthetic practices.\n\n"
                "Key references: Bus. & Prof. Code Sec. 2023 (laser/IPL), Cal. Code Regs. tit. 16 Sec. 1474 "
                "(standardized procedures), Cal. Bus. & Prof. Code Sec. 2836.1."
            ),
            "source_url": "https://www.rn.ca.gov/",
        },
        "business_entity": {
            "title": "California Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "California strictly enforces the Corporate Practice of Medicine doctrine. Per Cal. Bus. & "
                "Prof. Code Sec. 2052, only licensed physicians may practice medicine or own a medical "
                "corporation.\n\n"
                "Required structure: A physician must own the medical corporation that provides medical "
                "services. Medical corporations are governed by the Moscone-Knox Professional Corporation "
                "Act, Corp. Code Sec. 13400 et seq. The NP owns a separate MSO (standard LLC or corporation) "
                "that handles all non-clinical operations.\n\n"
                "AB 890 introduced a new option: NPs who complete the transition-to-practice pathway may form "
                "an NP Professional Corporation for services within NP scope. However, for services requiring "
                "physician involvement (many medspa treatments), a physician-owned medical corporation is "
                "still required. This often creates a complex dual-entity structure.\n\n"
                "MSO + Medical Corporation structure: The MSO provides management, staffing, marketing, "
                "billing, equipment, and facility. The medical corporation provides all clinical services. "
                "Connected via a Management Services Agreement. The California Medical Board actively audits "
                "these arrangements, particularly in medspa settings.\n\n"
                "Formation: Medical corporation filed with CA Secretary of State under Corp. Code Sec. 13400+. "
                "MSO filed as standard LLC or corporation. Budget $5,000-10,000 for healthcare attorney "
                "specializing in California medical practice formation.\n\n"
                "Key statutes: Cal. Bus. & Prof. Code Sec. 2052; Corp. Code Sec. 13400 et seq.; AB 890."
            ),
            "source_url": "https://www.rn.ca.gov/",
        },
    },
    "FL": {
        "scope_of_practice": {
            "title": "Florida NP Scope of Practice for Medical Aesthetics",
            "content": (
                "Florida grants reduced practice authority for medspa NPs. HB 607 (2020) created autonomous "
                "practice for NPs, but this applies ONLY to primary care: family medicine, general pediatrics, "
                "and general internal medicine. Aesthetic procedures (Botox, fillers, cosmetic lasers) are "
                "explicitly NOT primary care.\n\n"
                "Regardless of autonomous practice registration under Fla. Stat. Sec. 464.0123, medspa NPs "
                "must practice under a supervisory protocol with a physician per Fla. Stat. Sec. 464.012. "
                "This is a common point of confusion. Autonomous status does not cover aesthetic services.\n\n"
                "The supervisory protocol must be maintained on-site and must include: scope of services the "
                "NP may perform, prescribing limits, physician availability requirements, and emergency "
                "procedures. Fla. Admin. Code 64B9-4.010 governs protocol requirements.\n\n"
                "Prescriptive authority: NPs may prescribe within the scope defined by the supervisory "
                "protocol, including controlled substances as delegated by the supervising physician.\n\n"
                "The Florida Board of Nursing (floridasnursing.gov) has issued enforcement actions against "
                "NPs performing aesthetic procedures without a supervisory protocol, mistakenly relying on "
                "autonomous practice status.\n\n"
                "Key statutes: Fla. Stat. Sec. 464.012, 464.0123; Fla. Admin. Code 64B9-4.010; HB 607 (2020)."
            ),
            "source_url": "https://floridasnursing.gov/",
        },
        "delegation_supervision": {
            "title": "Florida Delegation and Supervision Rules for Medspas",
            "content": (
                "Florida has detailed delegation and supervision rules, particularly for laser procedures.\n\n"
                "Injectables: RNs may administer Botox and dermal fillers under physician delegation with "
                "documented training and competency verification. LPNs cannot inject Botox or fillers in "
                "Florida. Estheticians cannot inject or perform any medical procedures.\n\n"
                "Laser treatments: Florida has specific regulations under Fla. Admin. Code 64B8-56 governing "
                "medical lasers. Physician oversight is required. RNs and NPs may operate medical laser "
                "devices under physician delegation with training. Florida is among the most prescriptive "
                "states for laser regulation.\n\n"
                "Supervisory protocol requirements: The supervising physician does not need to be on-site "
                "for every treatment but must be available for consultation. The protocol must define which "
                "procedures may be performed, under what conditions, and the escalation path for complications "
                "or adverse events.\n\n"
                "A physician medical director is required for all medspas providing medical services, even "
                "though Florida does not enforce CPOM. The medical director maintains clinical authority "
                "over protocols, standing orders, and treatment standards.\n\n"
                "Key references: Fla. Admin. Code 64B8-56 (medical lasers), Fla. Admin. Code 64B9-4.010 "
                "(supervisory protocols), Fla. Stat. Sec. 464.012."
            ),
            "source_url": "https://floridasnursing.gov/",
        },
        "business_entity": {
            "title": "Florida Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "Florida does not enforce the Corporate Practice of Medicine doctrine. There is no statutory "
                "prohibition on non-physician ownership of medical practices. This makes Florida one of the "
                "most ownership-friendly states for NPs.\n\n"
                "NPs can own the medspa business entity directly. Form an LLC under Fla. Stat. Sec. 605 or "
                "a PLLC if preferred (PLLC not required in Florida). No MSO structure is needed. The NP is "
                "the business owner and clinical provider.\n\n"
                "However, a licensed physician medical director is required for oversight of medical services "
                "in the medspa. The physician does not need to own any part of the business. The medical "
                "director relationship is clinical, not an ownership arrangement.\n\n"
                "Important: Even though NPs can own the entity, autonomous practice status (HB 607) does NOT "
                "cover aesthetic procedures. A supervisory protocol with a physician is still required for "
                "medspa services regardless of the ownership structure.\n\n"
                "Formation: File LLC or PLLC with FL Division of Corporations. Filing fee approximately $125. "
                "Obtain EIN, business license, and register for FL sales tax (Florida taxes retail product "
                "sales). Budget for physician medical director compensation ($500-3,000/month depending on "
                "involvement level).\n\n"
                "Key statutes: Fla. Stat. Sec. 605 (LLCs), Fla. Stat. Sec. 464.012 (NP practice)."
            ),
            "source_url": "https://floridasnursing.gov/",
        },
    },
    "NY": {
        "scope_of_practice": {
            "title": "New York NP Scope of Practice for Medical Aesthetics",
            "content": (
                "New York grants reduced practice authority to NPs. Per NY Education Law Sec. 6902, NPs must "
                "maintain a collaborative practice agreement with a physician. NPs have prescriptive authority "
                "under this collaborative relationship.\n\n"
                "A 2015 amendment (Educ. Law Sec. 6902(3)(e)) allows NPs with 3,600+ hours of clinical "
                "experience to practice without a written collaborative agreement. However, the collaborative "
                "relationship with a physician must still exist. This is a common misunderstanding: the "
                "written agreement may be waived, but the physician relationship continues.\n\n"
                "For prescribing controlled substances, a collaborative agreement with a physician is required "
                "regardless of experience hours. NPs may prescribe Schedule II-V controlled substances within "
                "the scope of the collaborative agreement.\n\n"
                "In a medspa context, the collaborative physician does not need to be on-site but must be "
                "available for consultation. The scope of aesthetic services the NP may perform is defined "
                "by the collaborative agreement and the NP's certification and training.\n\n"
                "Key statutes: NY Educ. Law Sec. 6902, 6902(3)(e); Board of Nursing at op.nysed.gov."
            ),
            "source_url": "http://www.op.nysed.gov/prof/nurse/",
        },
        "delegation_supervision": {
            "title": "New York Delegation and Supervision Rules for Medspas",
            "content": (
                "New York delegation rules for medical aesthetics are governed by Board guidance and "
                "standard of care rather than highly prescriptive statutes.\n\n"
                "Injectables: RNs may administer Botox and dermal fillers under valid physician or NP "
                "orders. The ordering provider must have established protocols, and the RN must have "
                "documented training and competency. Standing orders for cosmetic injectables should include "
                "patient selection criteria, dosing guidelines, and adverse event management.\n\n"
                "Medical estheticians: Scope is limited to non-medical treatments. Estheticians cannot "
                "perform injectables, operate prescription medical devices, or perform procedures that "
                "penetrate below the epidermis.\n\n"
                "Laser treatments: New York does not have a specific statute on laser operation by "
                "non-physicians. Practice is governed by Board guidance and standard of care. Physician or "
                "NP oversight is expected for medical-grade laser and IPL devices. RNs may operate under "
                "delegation with training.\n\n"
                "PLLC formation requirements affect delegation structure. All owners of a clinical PLLC "
                "must be licensed in the profession, which means delegation and supervision must operate "
                "within the ownership entity's licensed scope.\n\n"
                "Key references: NY Educ. Law Sec. 6902 (NP practice), NY State Education Department "
                "Board guidance, standard of care principles."
            ),
            "source_url": "http://www.op.nysed.gov/prof/nurse/",
        },
        "business_entity": {
            "title": "New York Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "New York enforces the Corporate Practice of Medicine doctrine through Education Law and "
                "case law. Only licensed professionals may own professional entities. NY Bus. Corp. Law "
                "Art. 15 governs Professional Service Corporations and LLC Law Sec. 1207 governs "
                "Professional LLCs.\n\n"
                "NPs can own an NP professional entity (PLLC or PC) for services within NP scope. All "
                "owners of the PLLC must be licensed in the same profession. For medical services requiring "
                "physician involvement, an MSO + physician-owned PC structure is needed.\n\n"
                "Entity requirements are strict. Clinical services must be delivered through a PLLC or PC, "
                "not a standard LLC. Multi-disciplinary practices require careful structuring because each "
                "profession's owners must be licensed in that profession.\n\n"
                "MSO structure option: The NP owns a standard LLC (the MSO) providing management, "
                "staffing, marketing, billing, and facility services. A physician owns the PC providing "
                "medical services. Connected via a Management Services Agreement.\n\n"
                "Formation: File PLLC with NY Department of State. Requires approval from the State "
                "Education Department before filing. Filing fee approximately $200 plus publication "
                "requirements (must publish in two newspapers for 6 weeks, cost $500-2,000+ depending "
                "on county). Budget for healthcare attorney.\n\n"
                "Key statutes: NY Bus. Corp. Law Art. 15, NY LLC Law Sec. 1207, NY Educ. Law Sec. 6902."
            ),
            "source_url": "http://www.op.nysed.gov/prof/nurse/",
        },
    },
    "AZ": {
        "scope_of_practice": {
            "title": "Arizona NP Scope of Practice for Medical Aesthetics",
            "content": (
                "Arizona grants full practice authority to Nurse Practitioners. Per ARS Sec. 32-1601 et seq., "
                "NPs have independent practice authority including diagnosing, treating, and prescribing "
                "Schedule II-V controlled substances without physician supervision. Arizona was an early "
                "adopter of full NP practice authority.\n\n"
                "ARS Sec. 32-1601(16) defines NP scope broadly, encompassing assessment, diagnosis, "
                "treatment, and prescribing. No collaborative agreement, supervisory protocol, or physician "
                "oversight is required for NP clinical practice.\n\n"
                "For medspa NPs, this means full clinical independence. NPs can prescribe, perform "
                "injectable treatments, develop their own protocols, and serve as the primary clinical "
                "decision-maker without any physician involvement in their scope of practice.\n\n"
                "A medical director is still recommended (and often required by malpractice insurance "
                "carriers) for certain treatments such as Class IV lasers, controlled substance protocols, "
                "and complex medical procedures that may extend beyond typical NP training. But this is a "
                "clinical best practice, not a regulatory requirement.\n\n"
                "The Arizona State Board of Nursing (azbn.gov) regulates NP practice. Regulatory risk for "
                "NP-owned medspas is low. The main consideration is ensuring proper protocols for treatments "
                "beyond standard NP scope.\n\n"
                "Key statutes: ARS Sec. 32-1601 et seq., ARS Sec. 32-1601(16)."
            ),
            "source_url": "https://www.azbn.gov/",
        },
        "delegation_supervision": {
            "title": "Arizona Delegation and Supervision Rules for Medspas",
            "content": (
                "Arizona's delegation framework reflects its full practice authority status. NPs operate "
                "independently and can establish their own delegation protocols.\n\n"
                "Injectables: NPs can prescribe and perform injectables independently. NPs may delegate "
                "injectable administration to RNs under their own protocols with documented training and "
                "competency verification. Medical assistants may assist under NP supervision per standard "
                "scope rules.\n\n"
                "Estheticians: Regulated separately by the Arizona State Board of Cosmetology. Estheticians "
                "cannot perform medical procedures including injectables, medical-grade chemical peels, or "
                "procedures penetrating below the epidermis. Their scope is limited to non-medical cosmetic "
                "treatments.\n\n"
                "Laser treatments: NPs can perform medical laser treatments and delegate to qualified staff "
                "under their own protocols. The NP establishes training requirements, competency standards, "
                "and supervision levels for each treatment type. Class IV laser protocols should include "
                "patient selection criteria, treatment parameters, and adverse event management.\n\n"
                "No physician involvement is required in the delegation chain for NP scope. The NP is the "
                "supervising authority. This simplifies medspa staffing and reduces operational costs "
                "compared to states requiring physician-level oversight for delegation.\n\n"
                "Key references: ARS Sec. 32-1601 et seq. (NP practice), Arizona State Board of Cosmetology "
                "regulations (esthetician scope)."
            ),
            "source_url": "https://www.azbn.gov/",
        },
        "business_entity": {
            "title": "Arizona Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "Arizona does not enforce the Corporate Practice of Medicine doctrine for NP-owned practices. "
                "NPs can own and operate medical practices without physician ownership involvement.\n\n"
                "NPs can form a standard LLC under ARS Title 29, Chapter 7. A PLLC is available in Arizona "
                "but not required. The standard LLC provides full liability protection, pass-through taxation, "
                "and operational flexibility. This is the most straightforward state for NP medspa ownership.\n\n"
                "No MSO structure is needed. The NP owns the entity, serves as the clinical decision-maker, "
                "and operates the business directly. Single-entity ownership reduces legal complexity and "
                "ongoing compliance costs compared to CPOM states.\n\n"
                "Formation: File Articles of Organization with the AZ Corporation Commission. Filing fee "
                "approximately $50. Obtain EIN from IRS. Register for AZ Transaction Privilege Tax (sales "
                "tax equivalent) if selling retail products. Obtain city business license.\n\n"
                "While no physician ownership is required, consider a medical director for clinical best "
                "practice and malpractice insurance requirements. This is a contracted relationship, not "
                "an ownership requirement. Typical medical director cost in AZ: $500-2,000/month.\n\n"
                "S-Corp tax election recommended once net income exceeds $40,000/year to reduce "
                "self-employment tax.\n\n"
                "Key statutes: ARS Title 29 Ch. 7 (LLCs), ARS Sec. 32-1601 et seq. (NP practice)."
            ),
            "source_url": "https://www.azbn.gov/",
        },
    },
    "IL": {
        "scope_of_practice": {
            "title": "Illinois NP Scope of Practice for Medical Aesthetics",
            "content": (
                "Illinois grants full practice authority to APRNs after meeting specific requirements. "
                "225 ILCS 65/65-43 provides that APRNs qualify for full practice authority (FPA) after "
                "completing 250 hours of continuing education/training plus 4,000 hours of clinical "
                "experience post-certification.\n\n"
                "Before meeting FPA requirements, a written collaborative agreement with a physician is "
                "required per 225 ILCS 65/65-35. The collaborative agreement must define the scope of "
                "practice, prescriptive authority, and collaboration parameters.\n\n"
                "Once FPA is achieved, APRNs can prescribe independently including Schedule II-V controlled "
                "substances. No physician agreement or supervision is needed. The APRN practices as an "
                "independent provider.\n\n"
                "For medspa NPs, the 4,000-hour threshold is the key milestone. Pre-FPA APRNs must maintain "
                "their collaborative agreement and practice within its defined scope. Post-FPA APRNs have "
                "full clinical independence.\n\n"
                "IDFPR (Illinois Department of Financial and Professional Regulation) issued a Medspa Memo "
                "in December 2024 with specific guidance on APRN practice in medspa settings. This memo "
                "is essential reading for IL medspa NPs.\n\n"
                "Key statutes: 225 ILCS 65/65-43, 225 ILCS 65/65-35; IDFPR at idfpr.illinois.gov."
            ),
            "source_url": "https://idfpr.illinois.gov/profs/nursing.html",
        },
        "delegation_supervision": {
            "title": "Illinois Delegation and Supervision Rules for Medspas",
            "content": (
                "Illinois has specific delegation rules for medical aesthetic procedures, recently updated.\n\n"
                "Injectables and lasers by RNs: Per 225 ILCS 60/54.2, RNs may perform ablative and "
                "non-ablative laser procedures and injections (Botox, fillers) under physician delegation "
                "with documented training. The delegating physician must have established protocols and the "
                "RN must demonstrate competency.\n\n"
                "Recent change (effective January 2025): On-site physician examination is no longer required "
                "before non-ablative laser procedures when the facility follows a documented delegation "
                "protocol. This reduces operational burden for medspa staffing.\n\n"
                "Estheticians: CANNOT administer Botox, dermal fillers, microneedling, or medical lasers "
                "in Illinois. Their scope is limited to non-medical cosmetic treatments. The IDFPR Medspa "
                "Memo (December 2024) reiterated this restriction.\n\n"
                "APRN delegation: Post-FPA APRNs can delegate independently without physician involvement. "
                "Pre-FPA APRNs delegate within the scope of their collaborative agreement. The APRN "
                "establishes protocols, training requirements, and competency standards for delegated staff.\n\n"
                "Entity separation: IDFPR requires that cosmetology/esthetics services cannot be mixed with "
                "medical services in the same entity per 805 ILCS 185/13. Separate entities are required "
                "if offering both.\n\n"
                "Key references: 225 ILCS 60/54.2 (delegation), 805 ILCS 185/13 (entity separation), "
                "IDFPR Medspa Memo (December 2024)."
            ),
            "source_url": "https://idfpr.illinois.gov/profs/nursing.html",
        },
        "business_entity": {
            "title": "Illinois Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "Illinois enforces CPOM through IDFPR regulation. The December 2024 IDFPR Medspa Memo "
                "provides specific guidance: APRNs with FPA may organize under a Professional Service "
                "Corporation (805 ILCS 10) or PLLC (805 ILCS 185).\n\n"
                "All shareholders or members must be APRNs. No non-licensed persons may hold ownership, "
                "officer, director, or manager roles. The PSC or PLLC may only perform one type of "
                "professional service, meaning cosmetology/esthetics services must be in a separate entity "
                "per 805 ILCS 185/13.\n\n"
                "A sole proprietorship medspa must be owned and operated by physician(s) or APRN(s). "
                "Lay ownership is not permitted for entities providing medical services.\n\n"
                "Pre-FPA APRNs: Must practice under collaborative agreement. Entity ownership is more "
                "restricted. Consult IDFPR for current requirements.\n\n"
                "Dual-entity requirement: If offering both medical services and esthetics, you need two "
                "separate entities. The APRN-owned PSC/PLLC provides medical services. A separate entity "
                "provides cosmetology/esthetic services. This is a unique Illinois requirement.\n\n"
                "Formation: File PSC or PLLC with IL Secretary of State. APRN-only ownership verified at "
                "filing. Budget for healthcare attorney familiar with the IDFPR Medspa Memo requirements.\n\n"
                "Key statutes: 805 ILCS 10 (PSC), 805 ILCS 185 (PLLC), 805 ILCS 185/13 (entity "
                "separation); IDFPR Medspa Memo (December 2024)."
            ),
            "source_url": "https://idfpr.illinois.gov/profs/nursing.html",
        },
    },
    "PA": {
        "scope_of_practice": {
            "title": "Pennsylvania NP Scope of Practice for Medical Aesthetics",
            "content": (
                "Pennsylvania classifies NPs (CRNPs) under reduced practice authority. Pennsylvania has not "
                "passed full practice authority legislation. CRNPs require collaborative agreements with "
                "physicians for prescriptive authority.\n\n"
                "The Professional Nursing Law (63 P.S. 211 et seq.) and 49 Pa. Code Chapter 21 govern CRNP "
                "practice. CRNPs practice within the scope defined by their collaborative agreements and "
                "their national certification specialty.\n\n"
                "A distinctive Pennsylvania requirement: CRNPs must maintain collaborative agreements with "
                "TWO physicians per 49 Pa. Code 21.285-21.287. If one collaborating physician leaves the "
                "arrangement, the CRNP must stop seeing patients until a replacement agreement is in place. "
                "Agreements must be filed with the State Board of Nursing.\n\n"
                "Prescriptive authority is granted through the collaborative agreements. CRNPs may prescribe "
                "controlled substances within the scope delegated by their collaborating physicians. Physician "
                "delegation is governed by 49 Pa. Code 18.141-18.148.\n\n"
                "For medspa CRNPs, the two-physician requirement adds complexity and cost but provides "
                "redundancy. Loss of one collaborator does not permanently halt practice, but replacement "
                "must be prompt.\n\n"
                "Key statutes: 63 P.S. 211 et seq., 49 Pa. Code Ch. 21, 49 Pa. Code 21.285-21.287."
            ),
            "source_url": "https://www.pa.gov/agencies/dos/department-and-offices/bpoa/boards-commissions/nursing/acts-laws-and-regulations",
        },
        "delegation_supervision": {
            "title": "Pennsylvania Delegation and Supervision Rules for Medspas",
            "content": (
                "Pennsylvania's delegation rules are defined by statute and Board regulation.\n\n"
                "Injectables: RNs may inject Botox and dermal fillers under physician delegation with "
                "proper physician orders per 49 Pa. Code 18.402. RNs cannot act independently; they must "
                "have a valid order for each patient or a standing order protocol established by the "
                "delegating physician. Documentation of RN training and competency is required.\n\n"
                "Estheticians: CANNOT inject or perform medical procedures in Pennsylvania. Their scope is "
                "limited to non-medical cosmetic services regulated by the State Board of Cosmetology.\n\n"
                "CRNPs/NPs: Perform within the scope of their collaborative agreements. The two-physician "
                "collaborative agreement structure means two physicians have oversight responsibility. "
                "Both must agree on the scope of services the CRNP may provide.\n\n"
                "Physician delegation: Governed by 49 Pa. Code 18.141-18.148. The delegating physician "
                "retains responsibility for the delegated acts. Delegation must be appropriate to the "
                "training and competency of the person receiving the delegation. Physicians may delegate "
                "medical services to qualified healthcare providers under their supervision.\n\n"
                "NPs can own the medspa but cannot serve as medical director. This creates a delegation "
                "chain where the physician medical director oversees clinical protocols even though the "
                "NP owns the business.\n\n"
                "Key references: 49 Pa. Code 18.402 (RN injection), 49 Pa. Code 18.141-18.148 (physician "
                "delegation), 49 Pa. Code 21.285-21.287 (collaborative agreements)."
            ),
            "source_url": "https://www.pa.gov/agencies/dos/department-and-offices/bpoa/boards-commissions/nursing/acts-laws-and-regulations",
        },
        "business_entity": {
            "title": "Pennsylvania Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "Pennsylvania enforces CPOM through statute and case law. Per 49 Pa. Code 25.214, non-physicians "
                "may own a medical practice through a compliant structure, but the physician must maintain "
                "control over all clinical decisions.\n\n"
                "NPs CAN own the business entity (LLC or PLLC) but CANNOT serve as medical director. A "
                "physician medical director is required. The NP owns the business, handles operations, and "
                "contracts with a physician medical director who maintains clinical authority over protocols, "
                "standing orders, and treatment standards.\n\n"
                "This creates a hybrid structure: NP ownership with physician clinical control. It is not "
                "a full MSO arrangement (the NP owns the practice entity directly) but the physician's "
                "clinical authority must be documented and genuine.\n\n"
                "Collaborative agreements with TWO physicians are required per 49 Pa. Code 21.285-21.287. "
                "These agreements must be filed with the State Board of Nursing. Both collaborating "
                "physicians must review the NP's practice scope and prescriptive authority.\n\n"
                "Formation: File LLC or PLLC with PA Department of State. Filing fee approximately $125. "
                "Operating agreement should clearly separate business ownership (NP) from clinical oversight "
                "(physician medical director). Budget for healthcare attorney to structure the physician "
                "relationships.\n\n"
                "Key statutes: 49 Pa. Code 25.214 (corporate practice), 49 Pa. Code 21.285-21.287 "
                "(collaborative agreements), 49 Pa. Code 18.141-18.148 (physician delegation)."
            ),
            "source_url": "https://www.pa.gov/agencies/dos/department-and-offices/bpoa/boards-commissions/nursing/acts-laws-and-regulations",
        },
    },
    "OH": {
        "scope_of_practice": {
            "title": "Ohio NP Scope of Practice for Medical Aesthetics",
            "content": (
                "Ohio grants reduced practice authority to NPs. A Standard Care Arrangement (SCA) with a "
                "collaborating physician is required per ORC Sec. 4723.431 and OAC 4723-8-04. The "
                "collaborating physician must practice in the same or a similar specialty.\n\n"
                "NPs have prescriptive authority under the SCA including Schedule II-V controlled substances. "
                "The SCA defines the scope of NP practice, chart review frequency, and collaboration "
                "parameters.\n\n"
                "The collaborating physician may supervise up to 5 APRNs per ORC Sec. 4731.093. The SCA "
                "must be on file at each practice location. The Board of Nursing must be notified within "
                "30 days of entering a new SCA.\n\n"
                "For medspa NPs, the SCA provides the framework for all clinical services. The collaborating "
                "physician reviews charts, provides consultation on complex cases, and co-signs protocols. "
                "The NP performs aesthetic treatments within the scope defined by the SCA.\n\n"
                "Ohio is ownership-friendly (no CPOM) so the SCA requirement is about clinical oversight, "
                "not business structure. The NP can own the practice while maintaining the SCA for clinical "
                "compliance.\n\n"
                "Key statutes: ORC Sec. 4723.431, OAC 4723-8-04, ORC Sec. 4731.093."
            ),
            "source_url": "https://nursing.ohio.gov/",
        },
        "delegation_supervision": {
            "title": "Ohio Delegation and Supervision Rules for Medspas",
            "content": (
                "Ohio has clear delegation rules for medical aesthetic procedures governed by the Board "
                "of Nursing and Board of Medicine.\n\n"
                "Injectables: RNs and LPNs may inject Botox and dermal fillers under valid physician order "
                "with documented education, training, and competency per OAC 4723-4. This is broader than "
                "many states because Ohio permits LPN injection with proper delegation. The physician order "
                "must be specific and documented.\n\n"
                "NPs: May perform injectables and aesthetic procedures within their SCA scope. The NP does "
                "not need additional physician authorization beyond the SCA for procedures within the "
                "defined scope.\n\n"
                "Estheticians: CANNOT inject, operate medical lasers, or perform any procedure affecting "
                "living tissue. Their scope is limited to non-medical cosmetic treatments. Ohio clearly "
                "separates medical and esthetic scope.\n\n"
                "Laser treatments: Governed by standard of care and Board guidance. Physicians, NPs, and "
                "PAs may perform medical laser treatments. RNs may operate under delegation with documented "
                "training. Class IV medical lasers require physician or NP oversight.\n\n"
                "SCA compliance: The SCA must be physically present at the practice location. ORC 4731.093 "
                "limits each physician to collaborating with 5 APRNs. Chart review frequency is defined "
                "in the SCA. Ohio audits SCA compliance.\n\n"
                "Key references: OAC 4723-4 (RN/LPN delegation), ORC Sec. 4723.431 (SCA requirements), "
                "ORC Sec. 4731.093 (physician APRN cap)."
            ),
            "source_url": "https://nursing.ohio.gov/",
        },
        "business_entity": {
            "title": "Ohio Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "Ohio formally does not enforce CPOM. The State Medical Board of Ohio declared that Ohio law "
                "does not prohibit the corporate practice of medicine. Per ORC Sec. 4731.226, physicians "
                "may render services through corporations, LLCs, partnerships, or professional associations. "
                "By extension, anyone (NP, RN, lay person) can own a medspa in Ohio.\n\n"
                "This makes Ohio one of the most ownership-friendly states. NPs can own their practice "
                "outright with no physician ownership requirement. The collaborating physician (required "
                "for the SCA) is not required to hold any ownership interest.\n\n"
                "Recommended entity: LLC for liability protection and tax flexibility. File Articles of "
                "Organization with the Ohio Secretary of State. Filing fee approximately $99. No PLLC "
                "requirement.\n\n"
                "Even though ownership is unrestricted, the SCA is mandatory for NP clinical practice. "
                "The SCA defines the clinical oversight relationship, separate from the ownership structure. "
                "Budget for a collaborating physician: $500-2,000/month depending on involvement level.\n\n"
                "S-Corp election recommended once net income exceeds $40,000/year. Ohio has Commercial "
                "Activity Tax (CAT) for businesses with gross receipts over $150,000/year.\n\n"
                "Key statutes: ORC Sec. 4731.226 (no CPOM), ORC Sec. 4723.431 (SCA requirement)."
            ),
            "source_url": "https://nursing.ohio.gov/",
        },
    },
    "GA": {
        "scope_of_practice": {
            "title": "Georgia NP Scope of Practice for Medical Aesthetics",
            "content": (
                "Georgia grants reduced practice authority to NPs (APRNs). APRNs operate under a Nurse "
                "Protocol Agreement with a delegating physician per O.C.G.A. Sec. 43-34-25. The protocol "
                "must be filed with the Georgia Composite Medical Board with a $150 fee.\n\n"
                "As of 2024, APRNs may prescribe Schedule II controlled substances, expanding from the "
                "previous limit of Schedule III-V only. This broadens the prescriptive scope for medspa NPs "
                "who may need to prescribe certain controlled medications. Ga. Comp. R. & Regs. 360-32-.02.\n\n"
                "The Nurse Protocol Agreement must include names, addresses, license numbers, DEA numbers "
                "of both the NP and delegating physician, authorized acts, and approved drug lists. The "
                "delegating physician must have an active, unrestricted Georgia license.\n\n"
                "For medspa NPs, the protocol agreement defines all clinical services. The NP performs "
                "aesthetic treatments, prescribes, and manages patients within the scope of the agreement. "
                "The delegating physician provides oversight per the protocol terms.\n\n"
                "Georgia Board of Nursing (sos.ga.gov) regulates APRN practice. The Composite Medical "
                "Board oversees the protocol filing.\n\n"
                "Key statutes: O.C.G.A. Sec. 43-34-25; Ga. Comp. R. & Regs. 360-32-.02."
            ),
            "source_url": "https://sos.ga.gov/georgia-board-nursing",
        },
        "delegation_supervision": {
            "title": "Georgia Delegation and Supervision Rules for Medspas",
            "content": (
                "Georgia has specific and recently updated delegation rules for medical aesthetics.\n\n"
                "RN cosmetic procedures: Per the GA Board of Nursing Position Statement (April 2024), RNs "
                "may perform cosmetic procedures including Botox and filler injections under INDIVIDUALIZED "
                "orders only. Standing orders are NOT acceptable for RN cosmetic procedures in Georgia. "
                "Each patient must have an individualized order from the prescribing provider.\n\n"
                "LPNs: CANNOT perform cosmetic procedures in Georgia. This is clearly stated in the April "
                "2024 position statement. LPN scope does not extend to injectable cosmetic treatments.\n\n"
                "Estheticians: Cannot inject or operate medical lasers. The Cosmetic Laser Services Act "
                "(O.C.G.A. Sec. 43-34-240 through 248) restricts laser device operation to physicians, "
                "NPs, PAs, or RNs only. Estheticians and other non-licensed persons cannot operate cosmetic "
                "laser devices.\n\n"
                "Delegating physician relationship: Per O.C.G.A. Sec. 43-34-25(n), the delegating physician "
                "CANNOT be the NP-owner's employee. This is a critical restriction. If the NP owns the "
                "medspa, the supervising physician must be an independent contractor or operate through a "
                "separate entity. Employing your own supervisor is unlawful.\n\n"
                "Key references: GA Board of Nursing Position Statement (April 2024), O.C.G.A. Sec. "
                "43-34-240-248 (Cosmetic Laser Services Act), O.C.G.A. Sec. 43-34-25(n)."
            ),
            "source_url": "https://sos.ga.gov/georgia-board-nursing",
        },
        "business_entity": {
            "title": "Georgia Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "Georgia does not enforce CPOM. The original CPOM prohibition (former O.C.G.A. 43-34-37) "
                "was repealed in 1982. The Composite Medical Board confirmed in 2011 that it has never "
                "disciplined for CPOM violations. NPs and non-physicians may own medical practices.\n\n"
                "NPs can own their medspa outright. Form an LLC with the Georgia Secretary of State. No "
                "physician ownership required. No MSO structure needed. Standard LLC provides liability "
                "protection and operational flexibility.\n\n"
                "Critical restriction: O.C.G.A. Sec. 43-34-25(n) makes it unlawful for a physician to be "
                "an employee of an APRN if that physician is required to supervise the employing APRN. The "
                "delegating physician CANNOT be the NP-owner's employee. Use an independent contractor "
                "arrangement or a separate entity structure for the physician relationship.\n\n"
                "This means the NP owns the business but must carefully structure the delegating physician "
                "relationship. The physician is typically engaged as an independent contractor with a "
                "professional services agreement, not as a W-2 employee of the NP's entity.\n\n"
                "Formation: File LLC with GA Secretary of State. Filing fee approximately $100. Obtain EIN, "
                "city/county business license. Georgia has state income tax and sales tax on retail products.\n\n"
                "Key statutes: O.C.G.A. Sec. 43-34-25(n) (employer restriction), former O.C.G.A. 43-34-37 "
                "(repealed CPOM)."
            ),
            "source_url": "https://sos.ga.gov/georgia-board-nursing",
        },
    },
    "NC": {
        "scope_of_practice": {
            "title": "North Carolina NP Scope of Practice for Medical Aesthetics",
            "content": (
                "North Carolina classifies NPs under restricted practice authority. NPs must practice under "
                "a collaborative practice agreement (CPA) with a physician per N.C.G.S. 90-18.2. APRN "
                "practice is jointly regulated by the NC Board of Nursing and NC Medical Board via the "
                "Joint Subcommittee.\n\n"
                "The CPA must be signed, maintained at each practice site, and re-signed annually. 21 NCAC "
                "36.0801-0810 governs CPA requirements. The agreement must include drugs, devices, and "
                "treatments the NP may prescribe, plus an emergency services plan.\n\n"
                "Pending legislation: S537 (2025-2026 session) would grant full practice authority to NPs "
                "if enacted. Until then, the CPA requirement remains.\n\n"
                "For medspa NPs, the CPA defines all clinical scope. The collaborating physician reviews "
                "the agreement annually and provides oversight per the defined terms. The Joint Subcommittee "
                "must receive the CPA filing.\n\n"
                "The NC Medical Board has increased enforcement on NPs and PAs operating cash-pay aesthetic "
                "practices, particularly those outside physician-owned structures. This reflects NC's strict "
                "regulatory posture toward medspa practice.\n\n"
                "Key statutes: N.C.G.S. 90-18.2; 21 NCAC 36.0801-0810; 21 NCAC 32M."
            ),
            "source_url": "https://www.ncbon.com/",
        },
        "delegation_supervision": {
            "title": "North Carolina Delegation and Supervision Rules for Medspas",
            "content": (
                "North Carolina has strict delegation rules reflecting its CPOM enforcement posture.\n\n"
                "Injectables: RNs may perform Botox and filler injections under physician orders with "
                "documented training. RNs must operate within a physician-owned practice structure. The "
                "physician (not the NP) establishes delegation protocols for RN injection.\n\n"
                "NPs: Perform within the scope of their CPA. The CPA defines which aesthetic procedures "
                "the NP may perform, prescriptive authority, and consultation requirements. Annual review "
                "with dated signatures is required per 21 NCAC 36.0810.\n\n"
                "Estheticians: Limited to non-medical services. Cannot inject, operate medical lasers, or "
                "perform procedures requiring medical oversight. The NC Medical Board has increased "
                "enforcement on delegation in medspa settings.\n\n"
                "Practice structure impact: Because NPs cannot own alone (must co-own with physician per "
                "N.C.G.S. 55B-14), the delegation chain runs through the physician co-owner. The physician "
                "is not just a collaborator but a practice owner with direct responsibility for delegation "
                "decisions.\n\n"
                "The NC Medical Board actively targets arrangements where physician involvement is nominal. "
                "\"Straw practice\" arrangements (physician in name only) trigger enforcement action.\n\n"
                "Key references: N.C.G.S. 55B-14 (ownership), 21 NCAC 36.0810 (CPA requirements), NC "
                "Medical Board enforcement guidance."
            ),
            "source_url": "https://www.ncbon.com/",
        },
        "business_entity": {
            "title": "North Carolina Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "North Carolina vigorously enforces CPOM. NC Medical Board Position Statement 10.1.2 states "
                "that businesses practicing medicine must be owned entirely by persons holding active NC "
                "medical licenses.\n\n"
                "Per N.C.G.S. 55B-14, permitted ownership of a professional entity providing medical "
                "services is limited to: physicians only, physicians + PAs, or physicians + NPs. A physician "
                "MUST be part of ownership. NPs cannot own a medspa alone.\n\n"
                "This is one of the strictest states for medspa ownership. The NP must co-own with a "
                "physician. RNs cannot own at all (they may own an MSO only). The NC Medical Board actively "
                "targets \"straw practice\" arrangements where physician ownership is nominal.\n\n"
                "Required entity: Professional Corporation (PC) co-owned with a physician. The physician "
                "ownership must be genuine, not a paper arrangement. The NC Medical Board investigates and "
                "prosecutes arrangements where the physician has no meaningful clinical involvement.\n\n"
                "Alternative: NP owns an MSO (standard LLC) that provides management services to a "
                "physician-owned PC. This is the safer structure but requires genuine physician practice "
                "ownership.\n\n"
                "Formation: File PC with NC Secretary of State. Both physician and NP owners listed. "
                "Budget for healthcare attorney experienced with NC Medical Board requirements.\n\n"
                "Key statutes: N.C.G.S. 55B-14, NC Medical Board Position Statement 10.1.2, N.C.G.S. 90-18.2."
            ),
            "source_url": "https://www.ncbon.com/",
        },
    },
    "NJ": {
        "scope_of_practice": {
            "title": "New Jersey NP Scope of Practice for Medical Aesthetics",
            "content": (
                "New Jersey grants full practice authority to NPs after meeting experience requirements. "
                "A944/S1983 (2024) allows Advanced Practice Nurses (APNs) with 24+ months and 2,400+ hours "
                "of clinical experience to practice without a joint protocol. NJSA 45:11-49 through "
                "45:11-52 governs APN practice.\n\n"
                "Until the 2,400-hour threshold is met, a joint protocol with a collaborating physician is "
                "required. The joint protocol defines scope of practice, prescriptive authority, and "
                "collaboration requirements.\n\n"
                "Post-2,400 hours: Independent clinical practice is permitted. NPs can prescribe Schedule "
                "II-V controlled substances, diagnose, and treat without physician involvement in their "
                "clinical scope. This is plenary prescriptive authority.\n\n"
                "However, NJ strictly enforces CPOM. Even with full clinical independence, the practice "
                "entity structure must comply with CPOM requirements. A physician must own or majority-own "
                "the entity providing medical services.\n\n"
                "For medspa NPs, clinical independence (post-2,400 hours) is separate from business "
                "ownership restrictions. The NP can practice independently but cannot own the medical "
                "practice entity outright.\n\n"
                "Key statutes: NJSA 45:11-49 through 45:11-52; A944/S1983 (2024); N.J.A.C. 13:37-7.1."
            ),
            "source_url": "https://www.njconsumeraffairs.gov/nur/Pages/Statutes-and-Regulations.aspx",
        },
        "delegation_supervision": {
            "title": "New Jersey Delegation and Supervision Rules for Medspas",
            "content": (
                "New Jersey's delegation rules operate within its strict CPOM framework.\n\n"
                "Injectables: RNs can perform delegated medical aesthetic procedures including Botox and "
                "filler injections under physician or APN orders. Delegation must include documented training, "
                "competency verification, and established protocols. The delegating provider retains "
                "responsibility for the delegated acts.\n\n"
                "Estheticians: Limited to non-medical cosmetic procedures. Anything penetrating below the "
                "dermis or using prescription devices requires a licensed provider (physician, NP, PA, or "
                "RN under delegation). Estheticians cannot inject, perform microneedling with drug delivery, "
                "or operate prescription laser devices.\n\n"
                "Medical Director requirement: Even with plenary NP practice authority, the physician-owned "
                "PC must have a physician Medical Director who oversees clinical protocols, delegation "
                "decisions, and treatment standards per N.J.A.C. 13:35-6.6.\n\n"
                "Pre-2,400 hours: Joint protocol with physician required. Delegation flows through the "
                "physician collaborator. Post-2,400 hours: NP can delegate independently within scope, "
                "but the entity must still be physician-owned/majority-owned.\n\n"
                "The delegation chain in NJ medspas: Physician (entity owner) establishes protocols. NP "
                "(clinical provider) performs treatments and delegates to RNs. RNs execute under delegation. "
                "Estheticians handle non-medical services only.\n\n"
                "Key references: N.J.A.C. 13:37-7.1 (APN practice), N.J.A.C. 13:35-6.6 (physician "
                "oversight), NJSA 45:11-49-52."
            ),
            "source_url": "https://www.njconsumeraffairs.gov/nur/Pages/Statutes-and-Regulations.aspx",
        },
        "business_entity": {
            "title": "New Jersey Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "New Jersey strictly enforces CPOM through case law and the Professional Corporation Act "
                "(NJSA 14A:17-1 et seq.). Medical services must be delivered through a physician-owned PC "
                "or PLLC. NJ has had more CPOM enforcement actions than most states.\n\n"
                "NPs cannot own a medspa outright. \"Closely allied\" professionals (NPs, PAs, RNs) may hold "
                "a minority ownership share alongside a physician majority owner. The physician must hold "
                "majority ownership and control of the PC providing medical services.\n\n"
                "Standard structure: MSO (NP-owned LLC) + physician-owned PC. The physician owns and "
                "controls the PC. The NP owns the MSO providing management, staffing, marketing, billing, "
                "equipment, and facility services. Connected via a Management Services Agreement.\n\n"
                "Even with plenary prescriptive authority (post-2,400 hours), NP ownership is limited to "
                "minority share in the PC. The clinical independence granted by A944/S1983 does not override "
                "CPOM entity ownership requirements.\n\n"
                "Lay ownership through an MSO is permitted, but the physician must genuinely control the "
                "clinical entity. The NJ Board of Medical Examiners actively investigates arrangements where "
                "physician control is nominal.\n\n"
                "Formation: File PC with NJ Division of Revenue. Physician majority ownership. NP minority "
                "share if desired. Separate MSO as standard LLC. Budget $5,000-10,000 for healthcare "
                "attorney. NJ CPOM compliance is not a DIY project.\n\n"
                "Key statutes: NJSA 14A:17-1 et seq., NJSA 42:2B (LLC Act), N.J.A.C. 13:35-6.6."
            ),
            "source_url": "https://www.njconsumeraffairs.gov/nur/Pages/Statutes-and-Regulations.aspx",
        },
    },
    "CO": {
        "scope_of_practice": {
            "title": "Colorado NP Scope of Practice for Medical Aesthetics",
            "content": (
                "Colorado grants full practice authority to NPs (APRNs). Per CRS Sec. 12-255-104 and "
                "12-255-112, APRNs have independent practice authority including prescribing Schedule II-V "
                "controlled substances after completing 750 mentored hours for prescriptive authority.\n\n"
                "No collaborative agreement is required once fully authorized. NPs diagnose, treat, prescribe, "
                "and manage patients independently under the Nurse Practice Act (CRS 12-255).\n\n"
                "However, Colorado has a regulatory nuance. DORA (Department of Regulatory Agencies) has "
                "stated that NPs are \"not authorized to practice medicine.\" NPs practice under the Nurse "
                "Practice Act (CRS 12-255), not the Medical Practice Act (CRS 12-240). Whether a medspa "
                "constitutes \"practice of medicine\" versus \"nursing practice\" is debatable.\n\n"
                "For medspa NPs, this means full clinical independence for services within NP scope. No "
                "physician supervision, collaborative agreement, or oversight is required for NP clinical "
                "practice. A Medical Director (MD/DO) is recommended for medspa compliance and required by "
                "most malpractice carriers.\n\n"
                "DORA enforcement has increased with targeted medspa investigations since late 2024. Consult "
                "a Colorado healthcare attorney before assuming NP-only medspa ownership is fully compliant.\n\n"
                "Key statutes: CRS Sec. 12-255-104, 12-255-112; CRS 12-240-138."
            ),
            "source_url": "https://dpo.colorado.gov/Nursing/LawsRulesPolicies",
        },
        "delegation_supervision": {
            "title": "Colorado Delegation and Supervision Rules for Medspas",
            "content": (
                "Colorado's delegation rules include recent legislation specifically targeting medspa "
                "practices.\n\n"
                "Delegation to unlicensed persons: Per CRS Sec. 12-240-107(3)(l), delegation of medical "
                "services to unlicensed persons requires direct supervision by the delegating provider. This "
                "means the delegating physician or NP must be on-site when unlicensed staff perform delegated "
                "medical services.\n\n"
                "HB25-1024 (effective August 2025): New requirements specifically for medical-aesthetic "
                "delegation to unlicensed individuals. When delegating medical-aesthetic services to unlicensed "
                "staff, the practice must: post on-site signage with the delegating provider's name and "
                "license type, disclose the same information on the practice website, and obtain signed "
                "informed consent from the patient acknowledging the service is performed by an unlicensed "
                "person under delegation.\n\n"
                "Estheticians and prescription laser devices: Per 3 CCR 713, estheticians using prescription "
                "laser devices require physician supervision. NP supervision may not be sufficient for "
                "esthetician laser use depending on DORA interpretation.\n\n"
                "RNs: May perform delegated medical aesthetic procedures under physician or NP protocols with "
                "documented training and competency.\n\n"
                "NPs with FPA: Can delegate independently and establish their own protocols. The NP is the "
                "supervising authority for RNs and medical assistants within their practice.\n\n"
                "Key references: CRS Sec. 12-240-107(3)(l) (delegation), HB25-1024 (medspa delegation), "
                "3 CCR 713 (esthetician lasers)."
            ),
            "source_url": "https://dpo.colorado.gov/Nursing/LawsRulesPolicies",
        },
        "business_entity": {
            "title": "Colorado Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "Colorado's CPOM status for NP-owned medspas is ambiguous. CRS Sec. 12-240-138 enforces "
                "CPOM for medical Professional Corporations. However, NPs practice under the Nurse Practice "
                "Act (CRS 12-255), not the Medical Practice Act (CRS 12-240).\n\n"
                "DORA has stated NPs are \"not authorized to practice medicine,\" which creates a gap: if NP "
                "medspa services are \"nursing practice\" rather than \"medical practice,\" CPOM may not apply. "
                "If they're considered \"medical practice,\" CPOM restrictions would require physician ownership. "
                "This ambiguity is unresolved.\n\n"
                "Best practice options: (1) NP-owned LLC with a physician Medical Director for maximum "
                "compliance protection, or (2) MSO + physician PC structure for conservative compliance. "
                "Option 1 is simpler and cheaper but carries some regulatory risk. Option 2 is more defensive "
                "but adds complexity and cost.\n\n"
                "DORA enforcement has increased with targeted medspa investigations since late 2024. The "
                "regulatory landscape may clarify through enforcement actions or legislative update.\n\n"
                "Formation: File LLC with CO Secretary of State. Filing fee approximately $50. If using MSO "
                "structure, file separate entities. Strongly recommended: consult a Colorado healthcare "
                "attorney before finalizing entity structure. The DORA ambiguity makes DIY formation risky.\n\n"
                "Key statutes: CRS 12-255 (Nurse Practice Act), CRS 12-240-138 (medical CPOM), DORA "
                "enforcement guidance."
            ),
            "source_url": "https://dpo.colorado.gov/Nursing/LawsRulesPolicies",
        },
    },
    "TN": {
        "scope_of_practice": {
            "title": "Tennessee NP Scope of Practice for Medical Aesthetics",
            "content": (
                "Tennessee classifies NPs under restricted practice authority. NPs must have a collaborative "
                "practice agreement with a physician per TCA Sec. 63-7-123. Tennessee imposes some of the "
                "most detailed supervision requirements in the country.\n\n"
                "The supervising physician must visit the NP's practice site every 30 days and review 20% "
                "of the NP's charts per Tenn. Comp. R. & Regs. 0880-06-.02. This is not optional or "
                "approximated. The 30-day visit cycle and 20% chart review are audited.\n\n"
                "Prescriptive authority is granted through the collaborative practice agreement. The agreement "
                "must include written protocols, specific drug lists, and standard of care expectations. The "
                "NP prescribes within the scope defined by the collaborating physician.\n\n"
                "The Medical Director must be an MD or DO with an active Tennessee license. The Medical "
                "Director's name and certification status must be displayed at the practice per TCA Sec. "
                "63-1-153 (mandatory signage requirement).\n\n"
                "Tennessee also requires mandatory medspa registration with the Board of Medical Examiners "
                "per TCA Sec. 63-6-105 (effective January 2016). All medspas must register and maintain "
                "current registration. Tenn. Comp. R. & Regs. 0880-02-.24.\n\n"
                "Key statutes: TCA Sec. 63-7-123, 63-6-105, 63-1-153; Tenn. Comp. R. & Regs. 0880-06-.02, "
                "0880-02-.24."
            ),
            "source_url": "https://www.tn.gov/health/health-program-areas/health-professional-boards/nursing-board/nursing-board/statutes-and-rules.html",
        },
        "delegation_supervision": {
            "title": "Tennessee Delegation and Supervision Rules for Medspas",
            "content": (
                "Tennessee has strict delegation and supervision rules, with mandatory on-site requirements.\n\n"
                "RN medspa services: When an RN performs medspa services, an MD, PA, or NP must be on-site. "
                "This is more restrictive than most states, which allow remote supervision for RN delegation. "
                "In Tennessee, the supervising provider must be physically present in the facility.\n\n"
                "Estheticians: Limited to non-medical procedures. Cannot inject, operate medical lasers, or "
                "perform procedures requiring medical oversight. Tennessee strictly separates esthetic and "
                "medical scope.\n\n"
                "Physician site visits: The collaborating physician must visit the NP practice site every "
                "30 days per Tenn. Comp. R. & Regs. 0880-06-.02. This visit must be documented. During the "
                "visit, the physician reviews charts (20% minimum), assesses protocols, and evaluates the "
                "NP's practice.\n\n"
                "Mandatory signage: TCA Sec. 63-1-153 requires medspas to display the name and certification "
                "status of the supervising medical director. This must be visible to patients.\n\n"
                "The collaborative practice agreement must be signed by both parties and kept at the practice "
                "site. It must include written protocols for each service offered, specific drug lists, "
                "standard of care expectations, and emergency procedures.\n\n"
                "Key references: Tenn. Comp. R. & Regs. 0880-06-.02 (physician visits/chart review), TCA "
                "Sec. 63-1-153 (signage), TCA Sec. 63-7-123 (collaborative practice)."
            ),
            "source_url": "https://www.tn.gov/health/health-program-areas/health-professional-boards/nursing-board/nursing-board/statutes-and-rules.html",
        },
        "business_entity": {
            "title": "Tennessee Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "Tennessee strictly enforces CPOM. Per TCA Sec. 63-6-204, only physicians (MD/DO) may own "
                "or control medical entities. NPs, PAs, RNs, and lay persons cannot own a medical practice.\n\n"
                "NPs CANNOT own a medspa that provides medical services. The only option is an MSO + "
                "physician-owned entity structure. The physician owns the professional entity (PC or PLLC) "
                "that delivers medical services. The NP owns the MSO (standard LLC) that provides management, "
                "staffing, marketing, billing, and facility services.\n\n"
                "Tennessee also requires mandatory medspa registration. Per TCA Sec. 63-6-105 (effective "
                "January 2016), all medspas must register with the Board of Medical Examiners. Registration "
                "must be maintained and current. The registry includes the Medical Director's information "
                "and practice details. Tenn. Comp. R. & Regs. 0880-02-.24.\n\n"
                "Mandatory signage: The Medical Director's name and certification status must be displayed "
                "at the medspa per TCA Sec. 63-1-153.\n\n"
                "Formation: Physician files PC or PLLC. NP files MSO as standard LLC. Both registered with "
                "TN Secretary of State. Medspa registered with Board of Medical Examiners. Budget for "
                "healthcare attorney. Tennessee's combination of strict CPOM, mandatory registry, mandatory "
                "signage, and mandatory physician site visits makes it one of the most regulated states for "
                "medspa operations.\n\n"
                "Key statutes: TCA Sec. 63-6-204 (physician-only ownership), TCA Sec. 63-6-105 (medspa "
                "registry), TCA Sec. 63-1-153 (signage)."
            ),
            "source_url": "https://www.tn.gov/health/health-program-areas/health-professional-boards/nursing-board/nursing-board/statutes-and-rules.html",
        },
    },
    "VA": {
        "scope_of_practice": {
            "title": "Virginia NP Scope of Practice for Medical Aesthetics",
            "content": (
                "Virginia grants reduced practice authority transitioning to full. NPs with 5,400+ hours "
                "(3+ years full-time) can apply for autonomous practice with physician attestation per "
                "Va. Code Sec. 54.1-2957 and 18 VAC 90-30-86.\n\n"
                "HB 971 and HB 983 (2024) expanded autonomous practice pathways, making it easier for "
                "experienced NPs to achieve independence. Until the 5,400-hour threshold is met, a practice "
                "agreement with a patient care team physician is required.\n\n"
                "Autonomous NPs: No supervision or practice agreement required. Must practice within scope "
                "and maintain referral plans per 18 VAC 90-30-86. Can prescribe independently including "
                "controlled substances.\n\n"
                "Pre-autonomous NPs: Practice agreement with a physician defines scope, prescriptive "
                "authority, and consultation requirements. The physician does not need to be on-site but "
                "must be available for consultation.\n\n"
                "For medspa NPs, achieving autonomous practice status removes all physician oversight "
                "requirements. Virginia is among the more NP-friendly states for those who meet the "
                "5,400-hour threshold. Virginia Board of Medicine Guidance Document 85-12 addresses "
                "practice standards.\n\n"
                "Key statutes: Va. Code Sec. 54.1-2957; 18 VAC 90-30-86; HB 971, HB 983 (2024)."
            ),
            "source_url": "https://www.dhp.virginia.gov/Boards/Nursing/PractitionerResources/LawsRegulations/",
        },
        "delegation_supervision": {
            "title": "Virginia Delegation and Supervision Rules for Medspas",
            "content": (
                "Virginia's delegation rules are governed by Board of Medicine guidance documents.\n\n"
                "RNs: Can perform delegated medical procedures under physician or NP orders. For medical "
                "aesthetic procedures (Botox, fillers, laser treatments), RNs must have documented training "
                "and competency. The delegating provider (physician or NP) establishes protocols and "
                "maintains oversight responsibility.\n\n"
                "Estheticians: Limited to non-medical services. Cannot inject, operate prescription medical "
                "devices, or perform procedures requiring medical licensure. Virginia Board of Medicine "
                "Guidance Document 85-20 addresses supervision and delegation requirements.\n\n"
                "Autonomous NPs: Can delegate independently. No physician involvement needed in the "
                "delegation chain. The autonomous NP establishes protocols, delegates to qualified staff, "
                "and maintains supervisory responsibility.\n\n"
                "Pre-autonomous NPs: Delegation operates within the practice agreement framework. The "
                "patient care team physician has oversight over the NP's practice, including delegation "
                "decisions.\n\n"
                "Medical Director: While no CPOM exists, a Medical Director (MD/DO or autonomous NP) is "
                "still needed for clinical oversight. The Medical Director develops treatment protocols, "
                "reviews adverse events, and establishes standards of care for the practice.\n\n"
                "Virginia is relatively permissive on delegation compared to strict states like Tennessee "
                "or North Carolina. No mandatory on-site requirements for the delegating provider.\n\n"
                "Key references: Virginia Board of Medicine Guidance Documents 85-12 and 85-20, Va. Code "
                "Sec. 54.1-2957, 18 VAC 90-30-86."
            ),
            "source_url": "https://www.dhp.virginia.gov/Boards/Nursing/PractitionerResources/LawsRegulations/",
        },
        "business_entity": {
            "title": "Virginia Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "Virginia does not enforce the Corporate Practice of Medicine doctrine. There is no statutory "
                "prohibition on non-physician ownership of medical practices. Anyone (NP, RN, lay person, "
                "corporation) can own a medspa in Virginia.\n\n"
                "NPs can own their practice entity outright. No MSO structure is needed. Form a standard LLC "
                "under Va. Code Title 13.1. The NP is the business owner and, if autonomously licensed, can "
                "also serve as the clinical lead.\n\n"
                "A Medical Director (MD/DO or autonomous NP) is still required for clinical oversight of the "
                "practice. The Medical Director does not need to own any part of the business. This is a "
                "clinical relationship, not an ownership requirement.\n\n"
                "Virginia is one of the most ownership-friendly states for NP medspas. The combination of "
                "no CPOM and a clear pathway to autonomous practice makes Virginia attractive for NP-owned "
                "medspa formation.\n\n"
                "Formation: File LLC with the Virginia State Corporation Commission. Filing fee approximately "
                "$100. Obtain EIN, local business license (Virginia uses Business, Professional, and "
                "Occupational License tax at the locality level). Virginia has no state-level sales tax "
                "exemption for medical services but taxes retail product sales.\n\n"
                "Key statutes: Va. Code Title 13.1 (LLCs), Va. Code Sec. 54.1-2957 (NP practice)."
            ),
            "source_url": "https://www.dhp.virginia.gov/Boards/Nursing/PractitionerResources/LawsRegulations/",
        },
    },
    "WA": {
        "scope_of_practice": {
            "title": "Washington NP Scope of Practice for Medical Aesthetics",
            "content": (
                "Washington grants full practice authority to NPs (ARNPs). Per RCW 18.79.050 and RCW "
                "18.79.250, ARNPs have independent practice authority including prescribing Schedule II-V "
                "controlled substances. No collaborative agreement or physician supervision is required.\n\n"
                "ARNPs can diagnose, treat, prescribe, and manage patients independently. For medspa NPs, "
                "this means full clinical independence. ARNPs can perform injectable treatments, develop "
                "protocols, prescribe, and serve as their own medical director.\n\n"
                "Washington does not require physician oversight for ARNP clinical practice. The ARNP is "
                "the primary clinical authority within their scope and training. This extends to aesthetic "
                "procedures including injectables, laser treatments, and prescriptive skincare.\n\n"
                "The Washington State Nursing Commission (nursing.wa.gov) regulates ARNP practice. The "
                "Commission has published specific guidance for ARNPs in medspa settings.\n\n"
                "Key consideration: While clinical practice is fully independent, the business entity must "
                "be a Professional Service Corporation (PSC), not a standard LLC, due to Washington's PSC "
                "requirement for healthcare practices. This is a business structure requirement, not a "
                "clinical scope restriction.\n\n"
                "Key statutes: RCW 18.79.050, RCW 18.79.250."
            ),
            "source_url": "https://nursing.wa.gov/practicing-nurses/arnp-guidance",
        },
        "delegation_supervision": {
            "title": "Washington Delegation and Supervision Rules for Medspas",
            "content": (
                "Washington's delegation framework reflects its full practice authority for ARNPs.\n\n"
                "RN delegation: Per WAC 246-840-930, RNs may delegate nursing tasks to competent individuals. "
                "For medical aesthetic procedures, RNs must have documented training and competency. The "
                "delegating ARNP or physician establishes protocols and supervision levels.\n\n"
                "Estheticians and prescription laser devices: Estheticians using prescription laser devices "
                "may only do so under MD/DO supervision per DOH (Department of Health) guidance. ARNP "
                "supervision may not be sufficient for esthetician laser use. This is a notable exception "
                "to Washington's otherwise permissive NP practice framework.\n\n"
                "ARNPs: Practice independently and can serve as the supervising authority for delegation. "
                "ARNPs establish their own protocols, training requirements, and competency standards for "
                "staff performing delegated procedures.\n\n"
                "Washington DOH Medical Spa Work Group: Has published specific guidance on medspa staffing "
                "and delegation. This guidance addresses which treatments require which level of provider, "
                "supervision requirements, and training standards.\n\n"
                "No mandatory on-site requirements for the supervising ARNP beyond what clinical standards "
                "require. Remote supervision is permitted for RN-performed procedures under established "
                "protocols.\n\n"
                "Key references: WAC 246-840-930 (RN delegation), RCW 18.79.050 (ARNP practice), DOH "
                "Medical Spa Work Group guidance, DOH esthetician laser guidance."
            ),
            "source_url": "https://nursing.wa.gov/practicing-nurses/arnp-guidance",
        },
        "business_entity": {
            "title": "Washington Business Entity Requirements for NP-Owned Medspas",
            "content": (
                "Washington enforces CPOM through case law and the Professional Service Corporation Act "
                "(RCW 18.100). Healthcare practices must be organized as Professional Service Corporations "
                "(PSCs), not standard LLCs.\n\n"
                "However, RCW 18.100.050(5)(a) permits multi-discipline ownership among 12 healthcare "
                "professions including nurses. ARNPs CAN form PSCs and own medspas. No physician majority "
                "ownership is required in an ARNP-owned PSC practicing under the Nurse Practice Act.\n\n"
                "Required entity: Professional Service Corporation (PSC). Standard LLCs are NOT permitted "
                "for healthcare practices in Washington. This is a common mistake. Filing as a standard LLC "
                "instead of a PSC creates compliance issues.\n\n"
                "ARNPs can serve as their own medical director within the PSC. No physician involvement "
                "in ownership or clinical oversight is required.\n\n"
                "Pending legislation: SB 5387 (introduced 2025, reintroduced 2026) would tighten CPOM if "
                "enacted, requiring licensed providers to hold majority voting shares and prohibiting dual "
                "MSO ownership. Monitor legislative status. If enacted, this could significantly change the "
                "ownership landscape for NP medspas in Washington.\n\n"
                "Formation: File PSC with WA Secretary of State under RCW 18.100. PSC formation requires "
                "listing the healthcare profession(s) and licensed owner(s). Filing fee approximately $180. "
                "Consult WA healthcare attorney, particularly regarding SB 5387 status.\n\n"
                "Key statutes: RCW 18.100 (PSC Act), RCW 18.100.050(5)(a) (multi-discipline ownership), "
                "RCW 18.79 (Nurse Practice Act)."
            ),
            "source_url": "https://nursing.wa.gov/practicing-nurses/arnp-guidance",
        },
    },
}

SOURCE_NAME = "MAA Advisor Regulatory Database"

# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    states = ["TX", "CA", "FL", "NY", "AZ", "IL", "PA", "OH", "GA", "NC", "NJ", "CO", "TN", "VA", "WA"]
    topics = ["scope_of_practice", "delegation_supervision", "business_entity"]

    total = len(states) * len(topics)
    done = 0
    errors = 0

    print(f"Seeding {total} entries across {len(states)} states x {len(topics)} topics...")
    print("=" * 60)

    for state in states:
        for topic in topics:
            done += 1
            data = STATE_DATA[state][topic]
            title = data["title"]
            content = data["content"]
            source_url = data["source_url"]

            try:
                status = insert_chunk(
                    state_code=state,
                    topic=topic,
                    title=title,
                    content=content,
                    source_name=SOURCE_NAME,
                    source_url=source_url,
                )
                print(f"[{done}/{total}] {state} / {topic} -> {status}")
            except Exception as e:
                errors += 1
                print(f"[{done}/{total}] {state} / {topic} -> ERROR: {e}")

            # Rate limit: 1s pause every 3 insertions
            if done % 3 == 0 and done < total:
                time.sleep(1)

    print("=" * 60)
    print(f"Done. {done - errors} succeeded, {errors} failed out of {total} total.")


if __name__ == "__main__":
    main()
