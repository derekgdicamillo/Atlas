# Canonical Business Metrics Rule

**Single source of truth**: `data/business-metrics.json`

Before citing ANY business metric (revenue, churn, CPL, CAC, LTV, close rate, patient count, ad spend, etc.), Atlas MUST:

1. Check `data/business-metrics.json` for the validated number
2. Use that number, not a memorized/hardcoded one
3. If a number in a memory file or prompt doesn't match the canonical file, flag the discrepancy to Derek

## Key metrics (2026-03-08 validation):
- Revenue: $668K (QB)
- Churn: 9.2% monthly / ~70% annual (142 true exits / 129 avg base / 12 mo)
- CPL: $72
- CAC: $447
- LTV: $2,597 (QB gross profit / patient base method)
- LTV:CAC: 5.8x
- Close rate: 19.84% (won/total)
- Active patients: 125 (avg 2025 base: 129)
- Ad spend 2025 avg: $1,978/mo
- True new patients/mo: ~13 (not ~22, which includes tier switches)
- Net growth 2025: +9 patients (123 to 132)

## Tier Pricing (current, as of 2026-03-08):
- Gold (semaglutide): $465/mo
- Platinum (tirzepatide): $565/mo
- Gold Maintenance: $250/mo
- Platinum Maintenance: $325/mo
- Note: Legacy patients pay different rates. Use current prices for new patient calculations.

## Methodology
See `data/metrics-methodology.md` for the full calculation methodology for every metric.
Membership data comes from Aesthetic Record (not GHL).
Every metric has a documented formula, source, and recalculation procedure.

## Monthly Updates
Atlas sends a reminder on the 3rd of each month (cron job "metrics-reminder").
Derek exports: AR membership CSV, AR churn report, pharmacy invoices.
Atlas pulls: Meta Ads, GHL pipeline, QB financials, GA4, GBP automatically.
Monthly snapshots saved to `data/monthly-metrics/YYYY-MM.json`.

## When generating strategic memos, marketing analysis, or any business recommendations:
- Read data/business-metrics.json at runtime when possible
- Never hardcode metrics in prompt templates. Reference the file.
- If a user-facing document cites a number that doesn't match canonical, correct it inline and note the correction.
- Always use the formulas documented in metrics-methodology.md. Never invent alternative calculations.
