# Be Safe Healthcare Equity Grant — Research Brief

**Prepared for:** Derek DiCamillo, FNP  
**Date:** September 15, 2026  
**Scope:** IRC § 83(b) elections, CPOM in AZ/CO/FL, equity grant demands, consulting/IP risks  
**Disclaimer:** This is informational research, not legal or tax advice. Retain a healthcare attorney licensed in each relevant state and a CPA before acting.

---

## Part 1: Section 83(b) Elections — How They Work for Restricted Stock at $0 Purchase Price

### The Core Problem Section 83 Creates

When you receive restricted stock that vests over time, the IRS treats each vesting event as taxable income. Without an 83(b) election, you pay **ordinary income tax on the fair market value (FMV) of each tranche at the moment it vests** — not when you receive the grant. If the company grows, you pay tax on higher and higher values as they vest, and that income is taxed at your ordinary rate (currently 37% federal top bracket), not at the more favorable long-term capital gains rate (0%, 15%, or 20%).

The Section 83(b) election lets you flip the script: **pay ordinary income tax once, at grant, on the value today** — and then treat all future appreciation as capital gain when you eventually sell.

### The 30-Day Deadline — Byron Is Wrong

The filing deadline for a Section 83(b) election is **30 calendar days from the date of transfer** — the day the stock is actually issued to you, not the board approval date. This is a hard statutory deadline under IRC § 83(b)(2) and Treasury Regulation § 1.83-2. There is **no exception, no extension, no reasonable cause relief**. If you miss day 31, the election is void forever for that grant.

Byron's "60 days" claim is incorrect. There is no 60-day window for 83(b) elections under current law. (The only 60-day IRS provision near this area involves rollover elections and certain deferral elections under § 83(i), which is a separate and inapplicable provision for public company employees.) Verify the grant date, start counting immediately, and file before day 30.

**Mechanics:**
- File with the IRS Service Center where you file your annual return
- Send by certified mail with return receipt requested — the postmark is your proof
- Include a copy with your next tax return (Form 1040)
- Keep a copy permanently
- As of June 2025, the IRS accepts electronic filing for 83(b) elections, but certified mail with return receipt is still the most defensible approach for a startup context

### Spousal Signature: Required in Arizona

Arizona is a **community property state**. Any equity received during your marriage in connection with your work is presumed to be community property, meaning Esther has a half interest by default.

The IRS's instructions for the 83(b) election form state that **when the property subject to the election is community property, the spouse must also sign the election**. Failure to include Esther's signature on an Arizona election where the stock is community property creates a legal vulnerability — the IRS could potentially challenge the election's validity if it is later contested.

**Practical rule:** Have Esther co-sign the 83(b) election. It takes 30 seconds and eliminates this exposure entirely.

---

### Scenario A: FMV at Grant = $0 per Share

This is the ideal scenario for an early-stage, pre-revenue company with no established valuation.

**At grant (83(b) filed within 30 days):**
- Ordinary income recognized = FMV − price paid = $0 − $0 = **$0**
- No tax owed at grant
- Your cost basis in the stock = $0

**At vesting (subsequent years):**
- Because you filed the 83(b) election, vesting is a non-event for tax purposes
- Nothing additional is owed at each vesting date

**At sale:**
- If you hold the shares for more than 12 months from the **grant date** (not vesting date — this is the benefit of the election), 100% of proceeds are **long-term capital gain**
- On a $5M exit with 5% equity and a $0 basis: you owe LTCG tax on $250,000, not ordinary income tax
- At current LTCG rates (20% federal + 3.8% net investment income tax = 23.8% top combined), this is substantially better than ordinary income treatment (37% + state)

**Bottom line at $0 FMV:** The 83(b) costs you nothing at filing. The risk is limited to losing the filing cost if the company fails. File it regardless. Every founder in this situation files a protective 83(b) at $0 FMV — the downside is zero, the upside is years of capital gains treatment.

---

### Scenario B: FMV at Grant = $5 per Share

This scenario applies if the company has had a 409A valuation, a priced funding round, or if the IRS later challenges the $0 FMV position.

**Example: 100,000 shares at $5 FMV, $0 purchase price**

**At grant (83(b) filed within 30 days):**
- Ordinary income recognized = (FMV − price paid) × shares = ($5 − $0) × 100,000 = **$500,000 ordinary income**
- Federal tax at 37% top rate: ~$185,000
- Plus applicable state tax (Arizona has a flat 2.5% income tax as of 2023+): ~$12,500
- Total immediate tax bill: approximately **$197,500 in cash owed**, with no cash received from the equity

**At vesting (subsequent years):**
- Again, vesting is a non-event because of the election

**At sale:**
- Basis = $500,000 (the FMV recognized at grant)
- If you sell at $20/share: proceeds = $2,000,000, gain = $1,500,000 treated as LTCG
- Without the election at $5 FMV: you'd pay ordinary income tax as each tranche vests, on whatever the FMV is at vesting — potentially much higher than $5

**Without any 83(b) election at $5 FMV:**
- Year 1 cliff: 25,000 shares vest, perhaps at $8/share → $200,000 ordinary income
- Year 2: 25,000 shares vest at $12/share → $300,000 ordinary income
- Year 3: 25,000 shares vest at $15/share → $375,000 ordinary income
- Year 4: 25,000 shares vest at $20/share → $500,000 ordinary income
- Total ordinary income over 4 years: $1,375,000 vs. $500,000 at grant
- The election saves you roughly $323,750 in federal tax alone (37% × $875,000 differential)

**The critical 83(b) risk at $5 FMV:** You're writing a large check to the IRS today for stock that may be worth nothing. If the company fails before your shares vest, you've already paid tax on income you'll never realize. You can deduct a capital loss when the stock becomes worthless, but capital losses can only offset capital gains plus $3,000/year of ordinary income — the timing mismatch can be costly.

**Practical implication for Be Safe Healthcare:** If the company is truly early-stage and pre-revenue, push hard for a 409A valuation confirming $0 or near-$0 FMV before the grant is issued. This is a defensible position for a startup that has no customers, no revenue, and no assets. Get the 409A in writing before you accept the grant.

---

## Part 2: Corporate Practice of Medicine (CPOM) in Arizona, Colorado, and Florida

### What CPOM Is and Why It Matters

The corporate practice of medicine doctrine holds that only licensed physicians (or in some states, licensed healthcare professionals) may own and control entities that practice medicine. The doctrine exists to prevent non-clinicians from making clinical decisions for profit. The consequence: in many states, a non-physician business entity cannot employ physicians to practice medicine, and a physician cannot split fees with a non-physician entity.

The practical workaround used throughout healthcare private equity and healthcare service companies is the **MSO/Friendly PC structure:**
- A **Management Services Organization (MSO)** is owned by investors (including non-clinicians) and provides all non-clinical services: marketing, billing, HR, facilities, equipment, technology
- A **Professional Corporation (PC)** is owned on paper by a licensed clinician and provides all clinical services
- The two are linked by a long-term **Management Services Agreement (MSA)** under which the MSO captures most of the economics
- The MSO can be owned by holding companies with lay investors — this is where **Derek's equity interest in B Safe Healthcare LLC would live**

This structure is **legal in all three states** if properly structured. The clinician who nominally owns the PC must have genuine control over clinical decisions.

---

### Arizona

**CPOM classification: Lenient (among the least restrictive states)**

Arizona has no explicit statutory CPOM prohibition. The doctrine derives from two older Arizona Supreme Court cases involving optometry (Funk Jewelry, 1935; Sears Roebuck, 1967). The general principle is that only licensed individuals can hold medical licenses — but Arizona has not codified a hard prohibition on corporate employment of physicians.

**Key fact for Derek (FNP):** Arizona is a **full practice authority state** under ARS § 32-1601 et seq. A registered nurse practitioner in Arizona can independently evaluate, diagnose, prescribe, and treat patients — including Schedule II–V controlled substances — with no physician collaborative agreement, no medical director, and no chart review requirement.

**What this means for ownership structure:**
- An Arizona NP can form a PLLC in their own name and own a healthcare practice outright for any service within NP scope — no friendly PC required in Arizona
- Arizona statutes allow professional corporations where non-licensed entities can hold **up to 49% of shares**, provided licensed professionals hold at least 50% of equity and directorships
- **Clinician holding economic interest in a holdco without being PC owner of record:** Legally permissible in Arizona if structured properly. The MSO/holdco can own the economic infrastructure while a separately licensed professional (physician or NP) nominally controls the PC

**Red flags to watch in AZ:**
- If the Be Safe Healthcare PC provides physician-specific services (procedures requiring a physician license), Derek (as an NP) likely cannot be the nominal PC owner — a physician would need to hold that role
- The management agreement must not give the MSO control over clinical decisions — that line, if crossed, invalidates the structure and can trigger state board discipline
- Ensure the PC owner is a real clinician with genuine autonomy, not a "straw man" physician who signs off on everything the MSO tells them — this is a known regulatory target

---

### Colorado

**CPOM classification: Moderate — CPOM doctrine exists but NPs have full practice authority**

Colorado has a formal CPOM doctrine. Under Colorado's professional corporation statutes (CRS § 7-90-series), professional service corporations providing medical services must be owned by licensed professionals. However:

- Colorado is a **full practice authority state** for NPs — they can practice independently, diagnose, prescribe, and own practices within their scope
- Non-physician practitioners including NPs cannot independently own a "medical practice" for physician-scope services, but they can form professional service corporations for nursing/NP-scope services
- The MSO/Friendly PC structure is widely used in Colorado and is legally compliant when properly structured

**2024–2026 trend:** Colorado is among the states adding regulatory scrutiny to private equity healthcare deals and MSO structures. Legislative efforts in 2025 targeted greater transparency in MSO-PC relationships. This does not invalidate the structure but means the management agreement and corporate governance documents need to be tighter.

**What this means for Derek:** Holding economic interest in a Wyoming holdco (B Safe Healthcare LLC) that contracts with a Colorado PC via an MSA is legally permissible. Derek would not appear as an owner of record on the Colorado PC. A Colorado-licensed physician must own the physician-scope PC. NP-scope services could potentially be housed in a separate NP-owned entity.

---

### Florida

**CPOM classification: Restrictive — physician ownership required for clinical entity**

Florida has one of the stricter CPOM regimes. Key statutes: Fla. Stat. § 458.3485 (physician professional corporations) and § 456.054 (prohibition on kickbacks and fee-splitting). Florida requires that the clinical PC be owned by licensed healthcare professionals, and for physician services specifically, physician ownership is required.

**Key constraints in Florida:**
- Physician professional associations must have at least one physician owner
- Non-physician, non-licensed entities cannot own or control a Florida medical practice
- MSO structures are permitted but must be carefully structured to avoid illegal fee-splitting
- Florida has been active in 2025–2026 in tightening oversight of wellness clinics and compounding practices — relevant given Be Safe Healthcare's likely focus areas

**What this means for Derek:** Florida requires the most careful structure of the three states. Derek's economic interest must stay at the holdco/MSO level, with no ownership stake in the Florida PC reflected in any public record. The Florida PC must be owned by a Florida-licensed physician (or appropriate professional for the services offered). NPs have more limited independent practice rights in Florida compared to Arizona and Colorado.

**Fee-splitting risk in FL:** The MSO must charge a management fee that is (a) at arm's length, (b) not contingent on clinical revenue as a percentage (fixed fees or cost-plus are safer than percentage-of-collections arrangements), and (c) documented as fair market value. Percentage-of-revenue management fees in Florida are a known trigger for fee-splitting investigations.

---

### Summary: Can Derek Hold Holdco Equity Without Being PC Owner of Record?

**Yes, in all three states, if structured correctly.** The MSO/Friendly PC structure exists precisely to allow this. Derek's equity in B Safe Healthcare LLC (Wyoming holdco) is economically separate from the state-level PCs. He would not appear on any PC ownership documents.

**The legal risk to watch:** If any state health regulatory authority (medical board, nursing board) finds that Derek or the MSO is exercising control over clinical decisions at the PC — hiring and firing clinical staff, directing diagnosis or treatment protocols, overriding clinician judgment for financial reasons — the entire structure unravels. The clinician who nominally owns the PC must have genuine clinical autonomy.

---

## Part 3: What to Demand in Writing Before Agreeing to the Equity Grant

Do not agree to or accept any equity grant until you have reviewed and received satisfactory answers on all of the following. A verbal offer is not an offer. Everything below should be in executed documents.

### A. Current Cap Table (Fully Diluted)

Request a full capitalization table showing:
- All current shareholders, their share counts, share class, and percentage ownership on a **fully diluted basis** (including all options, warrants, convertible notes, SAFEs, and promised-but-unissued shares)
- Your proposed grant as a percentage of fully diluted shares, not just issued shares
- Any options pool (reserved but unissued shares) — these dilute you without your knowledge if not disclosed upfront

If they won't show you the cap table, that is a material red flag. Stop there.

### B. Valuation Methodology / 409A

Request:
- The most recent 409A independent valuation, or a statement of how FMV is being determined for your grant
- If no 409A exists, ask what the basis for $0 FMV is and whether they intend to get one
- The valuation matters for your 83(b) election tax math (see Part 1) and for understanding whether you're getting a fair deal

### C. Shareholder Agreement / Operating Agreement

For an LLC (which B Safe Healthcare appears to be), this is the Operating Agreement. Demand to review the full executed version plus any side letters or amendments. Key provisions to negotiate:

**Vesting schedule:** Standard founder/key employee vesting is 4-year total with a 1-year cliff (25% vests at month 12, then 1/48th per month thereafter). Demand:
- Written vesting schedule in the grant agreement
- What happens to unvested shares if you are terminated — do they expire? Do they get repurchased? At what price?
- What constitutes a "termination for cause" (should be narrowly defined — not a catch-all)

**Acceleration on Change of Control:**
- Single trigger: all shares accelerate upon a sale/merger/acquisition of the company
- Double trigger: shares accelerate only if (1) there is a change of control AND (2) you are terminated or your role is materially diminished within 12 months of the event
- Double trigger is the standard for employees; single trigger is more favorable for you
- At minimum, demand double trigger acceleration for 100% of unvested shares

**Anti-dilution protection:**
- If the company raises a future round at a lower valuation (down round), anti-dilution provisions protect existing preferred shareholders
- As a holder of common or membership units, you may not have anti-dilution rights — clarify what class of equity you're receiving
- Demand a **pro-rata right** (also called preemptive right): the right to participate in future financing rounds to maintain your ownership percentage

**Tag-along rights (also called co-sale rights):**
- If the founders or majority shareholders sell their shares, you have the right to sell your shares under the same terms
- Without this, majority holders can sell to a buyer who has no obligation to buy your shares
- This is non-negotiable for any meaningful equity stake

**Drag-along rights:**
- The majority can vote to sell the company and force minority holders (including you) to sell on the same terms
- This is standard and usually acceptable if it requires a supermajority vote (e.g., 75%+ approval)
- Watch for drag-along provisions that allow a small majority (51%) to force a sale at a price you have no control over

**Information rights:**
- The right to receive annual and quarterly financial statements
- The right to inspect company books and records
- Without this, you are a blind investor with no ability to monitor your investment
- Standard for any equity holder above 1% ownership

**Right of first refusal (ROFR):**
- If another shareholder wants to sell, you have the right to buy those shares first
- Protects against undesirable third parties entering the cap table

**Liquidation preference:**
- Preferred shareholders typically get paid first in a sale or liquidation
- As a common holder or unit holder, understand exactly where you rank in the liquidation waterfall
- A 1x non-participating liquidation preference for preferred investors is standard; anything above that (2x, participating preferred) can wipe out common holders' returns entirely

**Buy-sell provisions:**
- What happens when you leave? Can the company buy back your vested shares? At what price?
- Demand that any buyback of vested shares be at FMV, not book value

### D. Grant Agreement

A separate document (equity grant agreement or unit grant agreement) should specify:
- Exact number of shares/units granted
- Grant date
- Vesting schedule and cliff
- Exercise price if applicable (for options) or purchase price if applicable (for restricted stock)
- Termination provisions
- 83(b) election instructions and deadline reminder

### E. Company Organizational Documents

Request and review:
- Articles of Organization (Wyoming LLC) for the holdco
- Operating agreement for each entity in the structure (holdco, state MSOs, PC)
- Management Services Agreement(s) between MSO and PCs — confirm they are in place and compliant

---

## Part 4: Risks of Equity in Lieu of Cash + Consulting/IP Agreement Provisions

### The Core Risk

You are being asked to perform work (likely product development, clinical protocol design, content creation, practice building) in exchange for future, uncertain, illiquid equity. The equity has no guaranteed value, cannot be easily sold, and is subject to dilution, board decisions, and company performance that you do not control. Meanwhile, you are providing real, present value: your clinical expertise, your credibility, your time, and your intellectual property.

The biggest mistakes clinicians make in this situation:

1. **Starting work before documents are signed.** Once you've contributed work, your leverage to negotiate the equity terms drops dramatically. Do not contribute anything of value until the grant agreement, operating agreement, and any consulting/employment agreement are fully executed.

2. **Failing to document their contributions.** If the company later claims your work was a "volunteer effort" or disputes the value of your contribution, you need contemporaneous records (emails, meeting notes, deliverable logs) to defend your position.

3. **Not reading the IP assignment clause.** Most consulting agreements contain a "work for hire" or IP assignment clause that automatically assigns all work product to the company. Without this, you own what you create. With it, you give it away. You need to read this clause carefully and negotiate if necessary.

---

### What Your Consulting Agreement or Employment Agreement Should Contain

**1. Scope of Services (Narrow and Specific)**
- Define exactly what you're being asked to do — clinical protocol development, product design, licensure consultation, specific deliverables
- Do not sign a broad "any services as directed" scope; you will end up performing unlimited uncompensated work

**2. Compensation (Even at $0 Cash, Document It)**
- State clearly that compensation is the equity grant described in the Grant Agreement
- Reference the Grant Agreement by name and date
- If there is any cash compensation, document it
- If there is truly no cash, state "In consideration of services rendered, Company shall issue [X] equity units under the Grant Agreement dated [date]"

**3. IP Ownership — The Critical Clause**

This is the most negotiated and most important provision for your situation.

Standard company position: "All work product, inventions, discoveries, and improvements created by Consultant in connection with services shall be the sole property of Company."

What you should push for:
- **Carve-out for pre-existing IP**: "Consultant retains all rights to any work, methods, protocols, or intellectual property developed prior to the effective date of this Agreement, including but not limited to [list specific things you already own — e.g., your existing clinical protocols, your patient intake processes, your educational materials]"
- **License-back if IP is assigned:** If you do assign IP to the company, negotiate a license back — if the company is ever sold or this relationship terminates, you can still use your own clinical methods in your own practice
- **Definition of "connection with services" should be narrow** — should not capture your independent work at PV MediSpa or any work unrelated to Be Safe Healthcare's specific business

**4. Vesting as Consideration**

The agreement should state that equity vests only while you are actively providing services, and that termination of the consulting agreement triggers the treatment specified in the Grant Agreement. If you are terminated without cause, unvested shares should accelerate on the schedule you negotiated.

**5. Non-Compete and Non-Solicitation**

Healthcare consulting agreements routinely include non-compete clauses. Arizona significantly restricted non-competes for healthcare workers (ARS § 23-1501, and the FTC's 2024 non-compete rule banning most non-competes for employees — though this is still in litigation as of 2026 and the final status may have changed). Regardless:
- Push for a narrow geographic scope (specific markets, not nationwide)
- Push for a short duration (6–12 months post-termination, not 2–3 years)
- Push for a carve-out allowing you to continue operating PV MediSpa and your existing practices
- Do not sign a broad non-compete that blocks you from practicing medicine or operating your existing business

**6. Termination Without Cause**

Protect yourself from being removed before your equity vests:
- "Without cause" termination should trigger accelerated vesting (or at minimum, some acceleration provision)
- Define "cause" narrowly — not a catch-all for any business reason
- Include a severance period or notice requirement

**7. Indemnification**

The company should indemnify you for actions you take in good faith within the scope of your services. Do not expose yourself to personal liability for decisions made at the company's direction.

**8. Governing Law and Dispute Resolution**

If the company is Wyoming-domiciled, they will want Wyoming law. You want Arizona law or at minimum a neutral forum. Arbitration clauses are common — confirm they're not one-sided.

---

### Additional Risks to Flag

**Dilution without notice:** Future funding rounds will dilute your ownership. Without pro-rata rights, you could go from 5% to 1% in two rounds without being asked. Confirm your anti-dilution and preemptive rights.

**Vesting cliff risk:** If the company terminates you at month 11 (one month before the 1-year cliff), you receive nothing. Common in deals where founders have second thoughts. Negotiate for the cliff to be reduced or eliminated if termination is without cause.

**The "friendly" valuation problem:** If FMV at grant is set at $5/share but the 409A was done by an appraiser hired and paid by the company with incentive to set a high value (because high FMV attracts employees who think they're getting a lot), you may face a large 83(b) tax bill for an asset with no real market value. Demand an independent 409A from a firm you have input on.

**State securities laws:** Accepting an equity grant in a private company is a securities transaction. The company is required to comply with SEC Regulation D (or an applicable exemption) and applicable state blue sky laws. Wyoming, Arizona, Colorado, and Florida all have their own securities filings requirements for private placements. This is the company's responsibility, but confirm they're in compliance.

**HIPAA and state privacy laws:** If you are involved in product development that involves patient data, ensure the consulting agreement has a Business Associate Agreement (BAA) and that your role with patient data is clearly scoped and compliant.

---

## Summary Action Items

Before signing anything:

| # | Action | Priority |
|---|--------|----------|
| 1 | Get fully diluted cap table | Critical |
| 2 | Get or commission a 409A valuation | Critical |
| 3 | Confirm 83(b) election deadline in writing with the grant date | Critical |
| 4 | Have an AZ/WY healthcare attorney review all documents | Critical |
| 5 | Confirm Esther's name needs to be on the 83(b) (AZ community property) | Critical |
| 6 | Review operating agreement for tag-along, anti-dilution, info rights | High |
| 7 | Review/negotiate IP carve-out in consulting agreement | High |
| 8 | Confirm non-compete scope excludes PV MediSpa | High |
| 9 | Review Management Services Agreement for each PC state | High |
| 10 | Confirm the PC owner in each state (AZ, CO, FL) is a licensed professional — and is NOT Derek if it's a physician-scope PC | High |
| 11 | Demand double-trigger acceleration on change of control | Medium |
| 12 | Demand written termination-without-cause acceleration or protection | Medium |

---

## Sources

- [Section 83(b) Elections: Cooley GO](https://www.cooleygo.com/what-is-a-section-83b-election/)
- [83(b) Election Guide — Carta](https://carta.com/learn/equity/stock-options/taxes/83b-election/)
- [The Official 83(b) Election 30-Day Deadline & Mailing Rules — VestingStrategy](https://www.vestingstrategy.com/guides/irs-83b-election-30-day-deadline-mailing-rules)
- [83(b) Election Deadline: 30 Days — Chesapeake Financial Planners](https://chesapeakefp.com/83b-election-deadline/)
- [Arizona Corporate Practice of Medicine CPOM Guide — Permit Health](https://www.permithealth.com/post/arizona-corporate-practice-of-medicine-cpom-guide)
- [CPOM Explained: NPs and Ownership Compliance — CMF Group](https://www.cmfgroup.com/blog/nurse-practitioners/cpom-explained-how-nurse-practitioners-can-protect-ownership-and-stay-compliant/)
- [CPOM Overview and Guide — Guardian Medical Direction](https://guardianmedicaldirection.com/news/overview-and-guide-for-corporate-practice-of-medicine-cpom-laws-pc-mso-models-and-state-rules/)
- [Corporate Practice of Medicine in Colorado — Maureen West Law](https://maureenwestlaw.com/corporate-practice-of-medicine-in-colorado/)
- [CPOM 50-State Guide — MedPath Compliance](https://www.medpathcompliance.com/post/corporate-practice-of-medicine-cpom-50-state-guide/)
- [Can a Nurse Practitioner Own a Medical Spa — Wellness MD Group](https://wellnessmdgroup.com/blog/can-a-nurse-practitioner-own-a-medical-spa-state-guide)
- [Consulting for Equity: Risks and Best Practices — UpCounsel](https://www.upcounsel.com/consulting-for-equity-agreement)
- [Consulting Agreements and IP Ownership — Jones Spross](https://www.jonesspross.com/consulting-agreements-ip-ownership/)
- [Founder Equity and Vesting — CakeEquity](https://www.cakeequity.com/guides/founder-equity)
- [NP-Owned Med Spa Playbook 2026 — MedSpa Standards](https://medspastandards.com/blog/nurse-practitioner-med-spa-ownership-2026)
