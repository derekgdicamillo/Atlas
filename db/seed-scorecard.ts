/**
 * One-time seed script: populate the first monthly row in business_scorecard
 * from validated business-metrics.json data.
 * Run: bun run db/seed-scorecard.ts
 */

const token = process.env.SUPABASE_ACCESS_TOKEN
  || (await Bun.file(".env").text()).match(/SUPABASE_ACCESS_TOKEN=(.+)/)?.[1]?.trim();

if (!token) {
  console.error("SUPABASE_ACCESS_TOKEN not found");
  process.exit(1);
}

const sql = `
INSERT INTO business_scorecard (
  date, period_type,
  revenue, cogs, gross_margin, net_income, net_margin, cash_on_hand,
  active_patients, mrr, new_patients, cancellations,
  churn_rate, annual_churn, avg_tenure_months, median_tenure_months, ltv,
  leads, ad_spend, cpl, show_rate, close_rate, cac, ltv_cac_ratio,
  pipeline_total, pipeline_open, pipeline_won, pipeline_lost, pipeline_noshow,
  source, validated, notes, metadata
) VALUES (
  '2026-03-01', 'monthly',
  55673, 24835, 55.36, 7803, 14.02, -8902,
  125, 49318, 13, 12,
  9.2, 69.6, 10.87, 4.9, 2597,
  27, 1978, 72.16, 86.51, 36.23, 447, 5.8,
  126, 40, 25, 44, 17,
  'derek', true,
  'Seeded from validated business-metrics.json (2026-03-08 audit). Revenue/margin are 2025 monthly averages. Pipeline is cumulative snapshot.',
  '{"tier_breakdown":{"platinum_current":{"count":39,"price":565},"platinum_legacy":{"count":7,"price":550},"gold_current":{"count":21,"price":465},"gold_legacy":{"count":3,"price":370},"gold_maintenance":{"count":17,"price":250},"platinum_maintenance":{"count":8,"price":325},"micro":{"count":1,"price":145},"fat_burner":{"count":6,"price":59}},"med_costs":{"gold":130,"platinum":292,"gold_maintenance":65,"platinum_maintenance":146},"expense_breakdown":[{"name":"Payroll","amount":124927},{"name":"Selling Expenses","amount":81222},{"name":"Rent & Lease","amount":15120},{"name":"Office Supplies & Software","amount":10161},{"name":"Utilities","amount":9083}],"validation_date":"2026-03-08","source_files":["business-metrics.json","metrics-methodology.md"]}'
) ON CONFLICT (date, period_type) DO UPDATE SET
  revenue = EXCLUDED.revenue,
  cogs = EXCLUDED.cogs,
  gross_margin = EXCLUDED.gross_margin,
  net_income = EXCLUDED.net_income,
  net_margin = EXCLUDED.net_margin,
  cash_on_hand = EXCLUDED.cash_on_hand,
  active_patients = EXCLUDED.active_patients,
  mrr = EXCLUDED.mrr,
  new_patients = EXCLUDED.new_patients,
  cancellations = EXCLUDED.cancellations,
  churn_rate = EXCLUDED.churn_rate,
  annual_churn = EXCLUDED.annual_churn,
  avg_tenure_months = EXCLUDED.avg_tenure_months,
  median_tenure_months = EXCLUDED.median_tenure_months,
  ltv = EXCLUDED.ltv,
  leads = EXCLUDED.leads,
  ad_spend = EXCLUDED.ad_spend,
  cpl = EXCLUDED.cpl,
  show_rate = EXCLUDED.show_rate,
  close_rate = EXCLUDED.close_rate,
  cac = EXCLUDED.cac,
  ltv_cac_ratio = EXCLUDED.ltv_cac_ratio,
  pipeline_total = EXCLUDED.pipeline_total,
  pipeline_open = EXCLUDED.pipeline_open,
  pipeline_won = EXCLUDED.pipeline_won,
  pipeline_lost = EXCLUDED.pipeline_lost,
  pipeline_noshow = EXCLUDED.pipeline_noshow,
  source = EXCLUDED.source,
  validated = EXCLUDED.validated,
  notes = EXCLUDED.notes,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();
`;

const res = await fetch("https://api.supabase.com/v1/projects/ctiknmztlqqjzhgmyfbu/database/query", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: sql }),
});

const text = await res.text();
console.log(`Status: ${res.status}`);
console.log(`Response: ${text}`);

if (res.status === 201) {
  console.log("Monthly scorecard seeded successfully.");
} else {
  console.error("Seed failed.");
  process.exit(1);
}
