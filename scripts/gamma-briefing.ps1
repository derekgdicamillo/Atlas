# Build the JSON body using a temp file approach to handle large content
$inputText = @'
# PV MediSpa -- Hormozi Workshop Briefing Book
## March 11, 2026 | Las Vegas

---

## Business Snapshot

**Revenue & Profitability**
- Revenue: $690K (2025 actual), $732K run rate (2026)
- Net margin: 14.5% (target: 30%)
- MRR: $49,318 (~$592K annualized)

**Patient Base**
- Active patients: 126 (143 membership lines including add-ons)
- Avg patient tenure: 7.2 months (measured)
- Median tenure: 4.9 months

**Acquisition**
- Monthly ad spend: $3,100 (Facebook only)
- Cost per lead: $107 (12-week avg)
- Close rate: 14.3% (lead to patient)
- True CAC: $748

**Lifetime Value**
- LTV: $2,707 (blended, 7.2-month measured tenure)
- LTV:CAC: 3.6x
- Monthly churn: 7.9% (24% of cancellations are tier switches, not exits)

**Team**
- 2.5 FTEs: Derek (FNP), Becca (MA), Esther (ops/co-owner), Morgan (front desk, part-time)

---

## Unit Economics by Tier

| Tier | Monthly Price | Monthly COGS | Monthly Gross Profit | Gross Margin |
|------|--------------|--------------|---------------------|--------------|
| Tier 2 Gold (Program + Semaglutide) | $465 | $203-228 | $237-262 | 51-56% |
| Tier 3 Platinum (Program + Tirzepatide) | $565 | $278-303 | $262-287 | 46-51% |
| Blended (current mix) | $451 | ~$218 | ~$233 | 54.6% |

**Note:** Tier 1 Vitality Program Only ($247/mo) is PLANNED but NOT YET LIVE. Program-only with no medication. 71.7% margin. Regulation-proof (survives any compounding ban). Currently in development.

**Current Patient Mix:** Platinum 50 lines (56% of MRR), Gold 25 lines (23%), Gold Maintenance 19 lines (8%), plus Facial, TRT, BHRT, Fat Burner add-ons.

**Revenue Composition:** Membership 83%, Injectables/fillers 7%, Products/supplements/other 10%. Revenue multiplier: 1.20x total vs membership.

---

## Acquisition Funnel

**The Funnel (Monthly)**
- Ad Spend: $3,100
- Leads Generated: ~29
- Consultations Booked: (subset)
- Patients Closed: ~4/month
- Close Rate on Consults: 100%
- Full Funnel Conversion: 14.3%
- Pre-consult dropout is the problem, not closing

**Key Insight:** Close rate is absurd. Everyone who shows up converts. The bottleneck is getting people to show up, not selling them once they are there. Fix the top of funnel (landing page, ad volume) and revenue scales directly.

---

## Retention and Lifetime Value

**Churn and Tenure**
- Monthly churn: 7.9% true exits
- Average tenure: 7.2 months (measured from active roster)
- Median tenure: 4.9 months
- Note: A theoretical 12.6-month figure can be derived from 1/churn rate, but the 7.2-month measured average is more accurate and what we use for LTV.

**Tenure Distribution**
- 0-3 months: 37%
- 3-6 months: 18%
- 6-12 months: 23%
- 12+ months: 22%

**LTV by Tier (7.2 month tenure)**
- Platinum (Tirzepatide): $3,989 (LTV:CAC 5.3x)
- Gold (Semaglutide): $3,233 (LTV:CAC 4.3x)
- Blended: $2,707 (LTV:CAC 3.6x)

**Key Insight:** Reducing churn by just 3% extends average tenure significantly. Retention is the most profitable lever. 36.5% of patients are in the 0-3 month bucket, so the early experience is where we lose most people.

---

## The 3x Growth Math

- Current: $690K. Target: $2M (3.06x)
- Need: 250-370 active patients (from 126) = +130-250 patients
- Lead volume needed: 3-5x current (29/mo to 60-100+/mo)
- Ad spend required: 3-7x ($3,100/mo to $9,000-$21,700/mo at current CPL)
- Provider capacity: Derek at 90%+ utilization. Cannot scale without hiring NP #2 or implementing scalable clinical workflow.
- Landing page conversion: 2.7% current vs 5-10% benchmark. Fixing this nearly doubles lead volume at same spend.

---

## Top 5 Bottlenecks (Ranked)

**1. Derek IS the business.** One provider at max capacity. Only unlocked by hiring NP #2 or implementing the scalable clinical workflow.

**2. Landing page converts at 2.7%** (benchmark 5-10%). Fixing = free leads. This is the highest-ROI fix available.

**3. One ad channel.** Facebook only at $3,100/mo. No Google, YouTube, referral, or partnership channels.

**4. No YouTube presence.** Zero videos. Derek has the IP and teaching ability to dominate, but nothing is published.

**5. Early churn is the biggest retention gap.** 36.5% of patients are in the 0-3 month bucket. Improving the first 90 days has outsized impact on LTV.

---

## Competitive Moat

What makes PV MediSpa defensible:

- **100% close rate on consults.** Most clinics struggle to close. Everyone who shows up converts.
- **AI-powered operations.** 2.5 FTEs running what takes competitors 5-8 staff. Custom AI assistant handles scheduling, follow-ups, lead enrichment, content, analytics.
- **Proprietary 5-Pillar curriculum.** 8 modules, 13 PDFs, licensable IP: Precision Weight Science, Nourishing Health, Dynamic Movement, Mindful Wellness, Functional Wellness.
- **Tier 1 in development.** $247 program-only tier will be regulation-proof, surviving any compounding ban.
- **Provider continuity.** Same FNP every visit. Chains rotate providers.
- **Named frameworks.** SLOW and SHIELD, Vitality Tracker, Protein Paradox, Fuel Code, Calm Core Toolkit, Cooling Fuel Protocol.
- **Scalable clinical model.** Standing orders + async chart review + patient self-injection = provider not bottlenecked on every visit.

---

## Offer Architecture

**Current 2-Tier Structure (Live):**

- **Tier 2 Vitality + Semaglutide ($465/mo):** Full program + compounded semaglutide. Most popular tier (55% of patients).
- **Tier 3 Vitality + Tirzepatide ($565/mo):** Full program + compounded tirzepatide (dual GIP/GLP-1). Premium tier (25% of patients).
- **Maintenance tiers:** Half-dose options for goal-weight patients. ~$215-300/mo. High margin (65%).

**PLANNED (Not Yet Live):**
- **Tier 1 Vitality Program ($247/mo):** Body comp tracking, nutrition coaching, 5-Pillar curriculum, monthly check-ins. No medication. Pure program value. 71.7% margin. Regulation-proof.

All tiers: month-to-month, no contracts. First visit includes body comp scale, labs review, personalized protocol.

**Value Ladder Opportunity:** Brand-name GLP-1 tier (Ozempic/Wegovy/Mounjaro) at premium pricing. Peptide program launching July 2026 (BPC-157, CJC/Ipa, PT-141, TA-1).

---

## Scalable Clinical Workflow

**Arizona-compliant model designed this week:**

1. **Becca (MA) runs initial visit:** vitals, body comp, intake, teaches patient self-injection technique
2. **Patient education = MA scope** under ARS 32-1456 (no direct supervision needed)
3. **Patient self-administers at home** going forward
4. **Derek does async chart review + progress note** (valid telehealth encounter under ARS 36-3602)
5. **Chart reviews can be batched** (5-10 at end of day)
6. **Standing orders** define dose titration ladder
7. **Flag system:** if patient needs dose change outside standing order parameters, routes to synchronous visit

**Impact:** Becca can see patients back-to-back. Derek reviews charts on his schedule. Provider is no longer the bottleneck on routine GLP-1 follow-ups. This is how you get to 250+ patients without hiring NP #2 immediately.

---

## Questions for Hormozi Team

1. At $3,100/mo ad spend with 3.6x LTV:CAC, how aggressively should we scale? What is the right ramp?

2. We close 100% of consults. Pre-consult dropout is the leak. What is your framework for show rate optimization?

3. Hiring NP #2 is the capacity unlock. How do you evaluate timing on the first non-owner hire?

4. We have 8 modules of licensable IP. Is there a play here beyond the local clinic? (Skool, licensing, courses)

5. YouTube: zero presence but strong teaching ability. What is the minimum viable YouTube strategy for a local med spa?

6. We run the entire operation on 2.5 FTEs with AI automation. Is AI-powered clinic a positioning play or just operational advantage?

7. We are developing a $247 program-only tier with no medication. How do you think about building a regulation-proof base tier alongside premium medication tiers?

---

*PV MediSpa and Weight Loss | Prescott Valley, AZ | (928) 910-8818 | pvmedispa.com*
'@

# Build JSON body using .NET to handle escaping properly
Add-Type -AssemblyName System.Web

$bodyObj = @{
    inputText = $inputText
    textMode = "preserve"
    format = "document"
    numCards = 12
    themeId = "default-dark"
    textOptions = @{
        amount = "detailed"
        tone = "Professional, clean, data-driven"
        audience = "Business workshop team and mentors"
        language = "en"
    }
    imageOptions = @{
        source = "noImages"
    }
}

$jsonBody = $bodyObj | ConvertTo-Json -Depth 5 -Compress
$jsonBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonBody)

Write-Host "JSON length: $($jsonBody.Length) chars, $($jsonBytes.Length) bytes"

# Use HttpWebRequest for better error handling
$request = [System.Net.HttpWebRequest]::Create("https://public-api.gamma.app/v1.0/generations")
$request.Method = "POST"
$request.ContentType = "application/json; charset=utf-8"
$request.Headers.Add("X-API-KEY", $env:GAMMA_API_KEY)
$request.ContentLength = $jsonBytes.Length

$stream = $request.GetRequestStream()
$stream.Write($jsonBytes, 0, $jsonBytes.Length)
$stream.Close()

try {
    $response = $request.GetResponse()
    $responseStream = $response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($responseStream)
    $responseText = $reader.ReadToEnd()
    Write-Host "Success!"
    Write-Host $responseText
} catch [System.Net.WebException] {
    $errorResponse = $_.Exception.Response
    Write-Host "Error: $($errorResponse.StatusCode) ($([int]$errorResponse.StatusCode))"
    if ($errorResponse) {
        $errorStream = $errorResponse.GetResponseStream()
        $errorReader = New-Object System.IO.StreamReader($errorStream)
        $errorText = $errorReader.ReadToEnd()
        Write-Host "Response: $errorText"
    }
}
