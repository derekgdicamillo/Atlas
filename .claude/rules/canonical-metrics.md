# Canonical Business Metrics Rule

**Single source of truth**: Supabase `business_scorecard` table

**Access via**: `src/metrics-engine.ts` functions:
- `getLatestMonthly(supabase)` - current validated monthly metrics
- `getDailyHistory(supabase, days)` - daily trend data
- `getScorecard(supabase)` - latest monthly + 90-day daily history

Before citing ANY business metric (revenue, churn, CPL, CAC, LTV, close rate, patient count, ad spend, etc.), Atlas MUST:

1. Query the `business_scorecard` table via metrics-engine.ts
2. Use that number, not a memorized/hardcoded one
3. If a number in a memory file or prompt doesn't match the table, flag the discrepancy to Derek

## Methodology
See `data/metrics-methodology.md` for the full calculation methodology for every metric.
Formulas are also documented in code in `src/metrics-engine.ts` (the code IS the methodology).
Membership data comes from Aesthetic Record (not GHL).

## Daily Updates
Atlas cron `daily-scorecard` runs at 9:15 PM and calls `captureDaily()`.
Captures: leads, ad spend, CPL, CTR, impressions, show rate, close rate, pipeline snapshot.
Sources: Meta Ads API, GHL pipeline API.

## Monthly Updates
Atlas sends a reminder on the 3rd of each month (cron job "metrics-reminder").
Derek exports: AR membership CSV, AR churn report, pharmacy invoices.
Derek uploads to the dashboard, reviews calculated values, confirms.
Atlas calls `captureMonthly()` to write the validated monthly row.

## When generating strategic memos, marketing analysis, or any business recommendations:
- Query the business_scorecard table at runtime. Never hardcode metrics.
- Never cite numbers from memory files or old prompts. Always query the table.
- If a user-facing document cites a number that doesn't match the table, correct it inline and note the correction.
- Always use the formulas documented in metrics-engine.ts. Never invent alternative calculations.
