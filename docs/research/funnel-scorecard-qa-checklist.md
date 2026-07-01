# Funnel Scorecard QA Checklist
**Date:** 2026-05-31  
**Branch:** funnel-scorecard  
**Dashboard URL:** https://pv-dashboard-ten.vercel.app  
**Goal:** Confirm ROAS/Sales band data flow before marking the metrics work complete.

---

## How to Use This Checklist

1. Open the dashboard in a browser. Log in if prompted.
2. Click **"Sync today"** button (top-right of the Funnel Scorecard page) to trigger a fresh data pull.
3. Work through each item below. Mark PASS / FAIL / SKIP (if source data is unavailable today).
4. If any item FAILs, jump to "What Would Indicate a Problem" at the bottom.

---

## Item 1 — ROAS Calculation Visible with Daily Trend

**What to check:** The ROAS band (emerald/green left border) at the bottom-right of the 2×2 grid shows a "Cash ROAS" metric with a sparkline.

**Where to find it:** Bottom of the page, emerald-bordered card labeled **"ROAS"**. Single metric row: "Cash ROAS".

**Expected behavior:**
- Large bold number format: `3.20x` (or `—` if Cash Collected hasn't populated from QB yet today).
- Small text below the label shows **"Today: X.XXx"** for today's raw value.
- A miniature sparkline (30 tiny data points) appears in the middle column on desktop, showing the daily trend over the window.

**Formula being tested:** `cash_roas = cash_collected / ad_spend`  
Both inputs come from separate sources: `cash_collected` from QB Cash P&L, `ad_spend` from Meta Ads API.

**Pass:** ROAS band renders, large number is a ratio (e.g., `2.50x`) or `—`, sparkline is visible on desktop.  
**Fail:** Band is missing, number shows `0x`, or page throws a JS error.

---

## Item 2 — Sales Band Data Populated from QB

**What to check:** The **Sales band** (blue left border) shows "Cash Collected" and "Revenue (Contract Value)" with real numbers, not `—` or `0`.

**Where to find it:** Bottom-left card labeled **"Sales"** (blue border). Look for:
- **Cash Collected** — labeled `manual` badge in the UI but now auto-fills from QB Cash P&L
- **Revenue (Contract Value)** — fills from QB Accrual P&L

**Expected behavior:**
- "Cash Collected" 30-day aggregate shows a dollar amount (e.g., `$14,200`). If QB auth is good, this auto-populates from QuickBooks — NOT from GHL contract estimates.
- "Revenue (Contract Value)" shows the accrual-basis total.
- **Note on color coding:** The current UI uses band-category colors (purple/rose/blue/emerald) — there is no threshold-based green/yellow/red coloring implemented yet. If you expected red = bad ROAS and green = good ROAS, that feature is not yet in the code. The "Sales" band header has a blue/slate tint regardless of performance. This is a gap to address post-launch if needed.

**Pass:** Both "Cash Collected" and "Revenue" show dollar values (not `—`) for the 30-day aggregate, and the data source in the tooltip or footnote is QB (not GHL).  
**Fail:** Both remain `—` after syncing, which means QB is not authenticated or the token expired.

---

## Item 3 — Attribution Bucketing Uses Stage-Change Dates

**What to check:** The Sales band metrics (Booked Calls, Show Rate, Closed Deals, Close Rate) show plausible daily activity — NOT near-zero values with a spike on Day 1.

**Background:** The original bug bucketed all pipeline activity by creation date (when the lead entered the system), making every historical metric show `0` except for the day leads were created. The fix (commit `42dcf64`) now attributes by:
- **Booked** = `lastStageChangeAt` when moved to Consult Scheduled, No Show, Undecided, or Won
- **Shown** = `lastStageChangeAt` when moved to Undecided or Won (made it to the call)
- **Won/Lost** = `lastStatusChangeAt` (or fallback to `lastStageChangeAt`)

**Where to check:** Sales band sparklines for "Booked Calls", "Total Shown Calls", and "Closed Deals". Open your browser console to `/api/funnel` (or open DevTools Network tab → reload page → click the `/api/funnel` request → Preview) and scan the `rows` array.

**Expected behavior:**
- Booked Calls sparkline shows variation over 30 days — some days 0, some days 2–8. NOT flat-zero with one spike.
- Close Rate aggregate is a percentage (e.g., `38.5%`), not `0%` or `100%`.
- In the raw API response, different dates have different non-zero values for `booked_calls`, `shown_calls`, `closed_deals`.

**Pass:** Sparklines show a distributed trend across days; close rate is a realistic percentage.  
**Fail:** All rows in `/api/funnel` show `booked_calls: 0` or `closed_deals: 0` for every day — attribution is still broken.

**Quick API check:**
```
GET https://pv-dashboard-ten.vercel.app/api/funnel
```
Scan `rows[*].booked_calls` — values should be spread across different dates, not all zero.

---

## Item 4 — QB Cash-Basis Revenue Matches Today's P&L

**What to check:** The "Cash Collected" value for today in the Sales band (small "Today: $X" under the label) matches what's recorded in QuickBooks for today's cash income.

**Where to find it:** Sales band → "Cash Collected" row → small text **"Today: $X,XXX"**.

**How to verify:**
1. Note the "Cash Collected - Today" value on the dashboard.
2. In QuickBooks: Run a **Profit & Loss report** → date range = today only → accounting method = **Cash**. Look at Total Income.
3. The two numbers should match (or be within cents due to rounding).

**Expected formula:** `cash_collected = QB ProfitAndLoss(startDate=today, endDate=today, accounting_method='Cash').totalRevenue`

**Pass:** Dashboard "Today" value for Cash Collected matches QB Cash P&L to within $1.  
**Fail:** Dashboard shows `—` when QB has income today, or shows a number wildly different from QB (this would indicate QB API auth failure or a revenue field mapping issue).

**If QB shows no income today:** That's expected — QB data only flows in for days with actual posted transactions. Mark this SKIP and verify against a recent date that had transactions.

---

## Item 5 — Performance Snapshots Save and Display Without Errors

**What to check:** Clicking "Sync today" completes without an error banner, and the data refreshes.

**Where to find it:** "Sync today" button top-right of page. Also test the manual input form at the bottom.

**Expected behavior:**
- "Sync today" button shows "Syncing…" briefly, then returns to normal — no red error banner.
- After sync, the "Today" values in the metric rows update.
- Manual input form: enter a value in "Qualified Shown Calls" → click Save → see "Saved" in green. Refresh the page and the value persists.

**Under the hood:** Sync calls `POST /api/sync/funnel` → runs `captureFunnelDay(today)` → upserts one row into `funnel_daily` table in Supabase. The upsert preserves `qualified_shown_calls` (manual) even on re-sync.

**Pass:** Sync completes silently, data refreshes, manual saves persist through page reload.  
**Fail:** Red error banner appears, network tab shows 502 from `/api/sync/funnel`, or saved values reset on reload.

**Quick API check for sync:**
```
POST https://pv-dashboard-ten.vercel.app/api/sync/funnel
```
Response should be `{ "success": true, "metaOk": true, "ghlOk": true, "qbOk": true }` (or `qbOk: false` if QB token expired — that's a separate issue from the sync working).

---

## Item 6 — ROAS Formula Is Auditable in the UI

**What to check:** You can manually verify the ROAS figure by looking at the two component inputs on the same page.

**Where to find it:** No separate "formula breakdown" panel exists in the current UI, but the components are visible:
- **Ad Spend (numerator denominator):** Traffic band → "Ad Spend" row → 30-day aggregate
- **Cash Collected (numerator):** Sales band → "Cash Collected" row → 30-day aggregate
- **ROAS:** ROAS band → "Cash ROAS" → should equal Cash Collected ÷ Ad Spend

**Manual spot-check:**
1. Note **30-day Ad Spend** from Traffic band (e.g., `$8,400`).
2. Note **30-day Cash Collected** from Sales band (e.g., `$24,500`).
3. Calculate: `24,500 / 8,400 = 2.92x`.
4. Confirm ROAS band shows `2.92x` (within rounding tolerance of ±0.02x).

**Pass:** Manual division of visible Cash Collected ÷ Ad Spend matches the ROAS figure displayed.  
**Fail:** Numbers don't reconcile, or ROAS shows a value when Cash Collected shows `—` (would indicate a stale/incorrect value in the DB not overwritten by the latest sync).

---

## What Would Indicate a Problem

| Symptom | Likely Cause | Fix Path |
|---|---|---|
| ROAS shows `—` after sync | QB not authenticated or token expired | Go to `/qb/auth` to re-authenticate; check `/api/qb/token-status` |
| All `booked_calls` are 0 in every row | Attribution bug reintroduced, or no opps in GHL weight-loss pipeline | Check `/api/sync/funnel` response for `ghlOk: false`; check GHL pipeline ID |
| "Cash Collected" today doesn't match QB | QB pulling wrong company (EdenSkinNBody vs another) or accounting method mismatch | Verify `QB_REALM_ID` env var = `9130351690226406`; verify report is Cash not Accrual |
| Red banner "Both Meta and GHL fetches failed" | Meta token expired or GHL PIT token expired | Rotate the relevant API tokens in Vercel env vars |
| Manual save shows error | Supabase connection issue or auth middleware rejecting | Check Vercel function logs; verify `SUPABASE_SERVICE_ROLE_KEY` env var |
| ROAS doesn't reconcile to Cash/Spend | Stale row in DB from before the QB revenue bug fix (commit 42dcf64) | Run a backfill: `POST /api/sync/funnel?date=YYYY-MM-DD` for each affected date |
| Booked/shown counts look too high | Opp cache serving stale 5-min data on backfill; milestones double-counted | Clear cache by waiting 5 min or redeploying; verify opp is only counted once per day |
| Revenue (Contract Value) differs from Cash Collected significantly | Expected — accrual vs cash timing difference. A delta up to 30% is normal. | Only a problem if they're identical (would suggest one source is broken) |

---

## Quick-Reference API Endpoints

All require the `Authorization: Bearer <API_TOKEN>` header (same as dashboard login).

| Purpose | Method | Path |
|---|---|---|
| Read 30-day funnel data | GET | `/api/funnel` |
| Sync today's data | POST | `/api/sync/funnel` |
| Sync specific date | GET | `/api/sync/funnel?date=YYYY-MM-DD` |
| QB token status | GET | `/api/qb/token-status` |
| Re-authenticate QB | GET | `/api/qb/auth` |

---

## Key Takeaways

- **ROAS and Cash Collected are QB-sourced, not GHL-sourced.** GHL contract estimates (`monetaryValue`) are no longer used for any revenue field. If these show `—`, QB token is the first thing to check.
- **Attribution is stage-change-based, not creation-date-based.** Sparklines should show distributed daily activity. Flat-zero bars mean the attribution bug regressed.
- **There is no threshold-based green/yellow/red color coding in the current build.** The band colors (purple/rose/blue/emerald) are category indicators, not performance flags. If you wanted ROAS health indicators (>3x green, 1.5-3x yellow, <1.5x red), that's a separate feature to add post-launch.
- **ROAS is manually auditable** by dividing Cash Collected ÷ Ad Spend from the same page. No separate breakdown panel needed — the components are already visible.
- **Manual saves (Qualified Shown Calls) survive re-syncs.** The sync preserves that field. Only QB-sourced fields (cash_collected, revenue) get overwritten on each sync — and only when QB is authenticated.
