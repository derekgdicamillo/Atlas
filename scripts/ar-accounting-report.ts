#!/usr/bin/env bun
/**
 * Aesthetic Record -> Accounting Report Generator
 *
 * Stitches together AR's 6 report types into a clean, categorized
 * output for the accountant. Maps AR items to QuickBooks chart of accounts.
 *
 * Usage:
 *   bun run scripts/ar-accounting-report.ts --month 2026-01
 *   bun run scripts/ar-accounting-report.ts --month 2026-02
 *   bun run scripts/ar-accounting-report.ts --all  (processes all available data)
 *
 * Input: CSV/XLS files from C:/Users/Derek DiCamillo/Downloads/
 * Output: data/accounting/YYYY-MM-accounting-report.csv + summary.txt
 */

import XLSX from "xlsx";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const DOWNLOADS = "C:/Users/Derek DiCamillo/Downloads";
const OUTPUT_DIR = "data/accounting";

// QuickBooks classes (must match QB exactly)
// These are the class names from the QB P&L by Class report
const QB_CLASSES = {
  WEIGHT_LOSS: "Weight Loss",
  NEUROTOXIN: "Neurotoxin",
  FILLER: "Filler",
  FACIAL: "Facial",
  MICRONEEDLING: "Microneedling",
  SKIN_PRODUCTS: "Skin Products",
  SKIN_CARE_SERVICE: "Skin Care Service",
  VITAMINS_SUPPLEMENTS: "Vitamins and Supplements",
  MENS_HEALTH: "Mens Health",
  WOMENS_BHRT: "Womens BHRT",
  IV_INFUSION: "IV Infusion",
  GIFT_CARDS: "Gift Cards",
  WATER_BOTTLE: "Water Bottle",
  CC_FEES: "CC Fees",
  REFUND: "Refund",
  LABS: "Labs",
  PDO_THREADS: "PDO Threads",
  PRP: "PRP",
  COLD_JET_PLASMA: "Cold Jet Plasma",
  NOT_SPECIFIED: "Not specified",
} as const;

// Membership tier name -> QB Class mapping
// Determines which class a membership fee belongs to based on the member's tier
function membershipTierToClass(tierName: string): string {
  const t = tierName.toLowerCase();
  if (
    t.includes("platinum") ||
    t.includes("gold") ||
    t.includes("fat burner") ||
    t.includes("weight loss") ||
    t.includes("micro tirz")
  ) {
    return QB_CLASSES.WEIGHT_LOSS;
  }
  if (t.includes("facial") || t.includes("microneedling")) {
    return QB_CLASSES.FACIAL;
  }
  if (t.includes("trt") || t.includes("men's health") || t.includes("mens health")) {
    return QB_CLASSES.MENS_HEALTH;
  }
  if (t.includes("bhrt") || t.includes("women")) {
    return QB_CLASSES.WOMENS_BHRT;
  }
  return QB_CLASSES.NOT_SPECIFIED;
}

// QuickBooks account + class mapping
// Each rule: { match, account, subAccount, qbClass }
// qbClass can be a string (static) or "FROM_MEMBERSHIP" (resolved at runtime)
const ACCOUNT_RULES: Array<{
  match: (item: string, category: string) => boolean;
  account: string;
  subAccount?: string;
  qbClass: string;
}> = [
  // Membership revenue (class determined by patient's tier)
  {
    match: (item) => /membership fee/i.test(item),
    account: "Monthly Reocuring Revenue (MRR)",
    subAccount: "Monthly Membership Fees",
    qbClass: "FROM_MEMBERSHIP", // resolved at runtime from tier lookup
  },
  {
    match: (item) => /one time setup fee/i.test(item),
    account: "Monthly Reocuring Revenue (MRR)",
    subAccount: "Setup Fees",
    qbClass: "FROM_MEMBERSHIP",
  },

  // Weight loss services (non-membership)
  {
    match: (item) =>
      /tirz|weight loss|wt loss/i.test(item) && !/probiotic/i.test(item),
    account: "Non-Reocurring Revenue (NRR)",
    qbClass: QB_CLASSES.WEIGHT_LOSS,
  },

  // Injectable services - neurotoxins
  {
    match: (item, cat) =>
      cat === "Injectables" ||
      /botox|dysport|xeomin|jeuveau|sister emily/i.test(item),
    account: "Non-Reocurring Revenue (NRR)",
    qbClass: QB_CLASSES.NEUROTOXIN,
  },

  // NAD injections -> IV Infusion class
  {
    match: (item) => /nad\s*inj/i.test(item),
    account: "Non-Reocurring Revenue (NRR)",
    qbClass: QB_CLASSES.IV_INFUSION,
  },

  // Filler services
  {
    match: (item, cat) =>
      cat === "Filler" || /versa|filler|dissolve/i.test(item),
    account: "Non-Reocurring Revenue (NRR)",
    qbClass: QB_CLASSES.FILLER,
  },

  // Facial services
  {
    match: (item, cat) =>
      cat === "Facials" || /facial|peel/i.test(item),
    account: "Non-Reocurring Revenue (NRR)",
    qbClass: QB_CLASSES.FACIAL,
  },

  // Microneedling (separate QB class from facials)
  {
    match: (item, cat) =>
      /microneedling/i.test(item) || cat === "Package",
    account: "Non-Reocurring Revenue (NRR)",
    qbClass: QB_CLASSES.MICRONEEDLING,
  },

  // Retail - skincare products
  {
    match: (_item, cat) => cat === "Skin Care Products",
    account: "Retail",
    qbClass: QB_CLASSES.SKIN_PRODUCTS,
  },

  // Retail - supplements
  {
    match: (_item, cat) => cat === "Supplements",
    account: "Retail",
    qbClass: QB_CLASSES.VITAMINS_SUPPLEMENTS,
  },

  // Pharmacy/compound medications -> Weight Loss class (most are GLP-1 related)
  {
    match: (item) =>
      /thyroid|estrad|progesterone/i.test(item),
    account: "Non-Reocurring Revenue (NRR)",
    qbClass: QB_CLASSES.WOMENS_BHRT,
  },
  {
    match: (item) =>
      /ldn|methylene|bioboost|b-12/i.test(item),
    account: "Non-Reocurring Revenue (NRR)",
    qbClass: QB_CLASSES.WEIGHT_LOSS,
  },

  // Deposits
  {
    match: (_item, cat) => cat === "Service Deposit",
    account: "Non-Reocurring Revenue (NRR)",
    qbClass: QB_CLASSES.FILLER, // deposits are typically for filler
  },

  // Tips
  {
    match: (item) => /tip/i.test(item),
    account: "Non-Reocurring Revenue (NRR)",
    qbClass: QB_CLASSES.NOT_SPECIFIED,
  },

  // Water bottle
  {
    match: (item) => /water bottle/i.test(item),
    account: "Retail",
    qbClass: QB_CLASSES.WATER_BOTTLE,
  },

  // Catch-all
  {
    match: () => true,
    account: "Non-Reocurring Revenue (NRR)",
    qbClass: QB_CLASSES.NOT_SPECIFIED,
  },
];

// ── CSV Parser ────────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuotes = !inQuotes;
    } else if (line[i] === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += line[i];
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(
  filePath: string
): Array<Record<string, string>> {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map((l) => {
    const vals = parseCSVLine(l);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = vals[i] || ""));
    return obj;
  });
}

function parseXLS(
  filePath: string
): Array<Record<string, any>> {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
  if (data.length < 2) return [];
  const headers = data[0].map(String);
  return data.slice(1).filter((r) => r.length > 0 && r[0] != null).map((r) => {
    const obj: Record<string, any> = {};
    headers.forEach((h, i) => (obj[h] = r[i] ?? ""));
    return obj;
  });
}

// ── File Discovery ────────────────────────────────────────────────────────────

function findFiles(
  pattern: RegExp,
  ext: string
): string[] {
  const files = readdirSync(DOWNLOADS);
  return files
    .filter((f) => pattern.test(f) && f.endsWith(ext))
    .map((f) => join(DOWNLOADS, f))
    .sort((a, b) => {
      // Prefer larger files (more data)
      const sizeA = readFileSync(a).length;
      const sizeB = readFileSync(b).length;
      return sizeB - sizeA;
    });
}

// ── Category Mapper ───────────────────────────────────────────────────────────

function categorizeItem(
  item: string,
  arCategory: string
): { account: string; subAccount?: string } {
  for (const rule of ACCOUNT_RULES) {
    if (rule.match(item, arCategory)) {
      return { account: rule.account, subAccount: rule.subAccount };
    }
  }
  return { account: "Revenue:Other Revenue" };
}

// ── Date Helpers ──────────────────────────────────────────────────────────────

function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  // Handle both M/D/YYYY and MM/DD/YYYY
  const parts = dateStr.split("/");
  if (parts.length === 3) {
    return new Date(
      parseInt(parts[2]),
      parseInt(parts[0]) - 1,
      parseInt(parts[1])
    );
  }
  return null;
}

function dateInMonth(dateStr: string, yearMonth: string): boolean {
  const d = parseDate(dateStr);
  if (!d) return false;
  const [year, month] = yearMonth.split("-").map(Number);
  return d.getFullYear() === year && d.getMonth() + 1 === month;
}

// ── Main Pipeline ─────────────────────────────────────────────────────────────

interface CategorizedLine {
  date: string;
  invoiceNumber: string;
  patient: string;
  item: string;
  arCategory: string;
  qbAccount: string;
  qbSubAccount: string;
  qbClass: string;
  membershipTier: string;
  grossAmount: number;
  discount: number;
  collected: number;
  processingFees: number;
  netSale: number;
  tenderType: string;
  employee: string;
  status: string;
  // From reconciliation (if matched)
  payoutAmount?: number;
  payoutDate?: string;
  payoutId?: string;
}

function run(targetMonth?: string) {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("AR Accounting Report Generator");
  console.log("=".repeat(60));

  // 1. Find and load invoice files (the primary data source)
  console.log("\n1. Loading invoice data...");

  // Try the big "invoices 2026.csv" first, then individual month exports
  let allInvoices: Array<Record<string, string>> = [];
  const bigFile = join(DOWNLOADS, "invoices 2026.csv");
  if (existsSync(bigFile)) {
    allInvoices = parseCSV(bigFile);
    console.log(`   Loaded ${allInvoices.length} lines from invoices 2026.csv`);
  }
  // Also try "invoices 2025.csv" for older data
  const bigFile25 = join(DOWNLOADS, "invoices 2025.csv");
  if (existsSync(bigFile25)) {
    const inv25 = parseCSV(bigFile25);
    allInvoices = allInvoices.concat(inv25);
    console.log(`   Loaded ${inv25.length} lines from invoices 2025.csv`);
  }
  // Also load today's individual exports as fallback
  const todayExports = findFiles(/^invoices-03082/, ".csv");
  if (todayExports.length > 0 && allInvoices.length === 0) {
    allInvoices = parseCSV(todayExports[0]);
    console.log(
      `   Loaded ${allInvoices.length} lines from ${todayExports[0].split("/").pop()}`
    );
  }

  if (allInvoices.length === 0) {
    console.error("No invoice data found! Export invoices from AR first.");
    process.exit(1);
  }

  // 2. Load reconciliation data (for payout matching)
  console.log("\n2. Loading reconciliation data...");
  const reconFiles = findFiles(/^reconciliation_report/, ".xls");
  const reconMap = new Map<
    string,
    { payoutAmount: number; payoutDate: string; payoutId: string }
  >();
  for (const f of reconFiles) {
    const rows = parseXLS(f);
    for (const r of rows) {
      if (r.Invoice && !reconMap.has(String(r.Invoice))) {
        reconMap.set(String(r.Invoice), {
          payoutAmount: parseFloat(r["Payout Amount"]) || 0,
          payoutDate: String(r["Payout Date"] || ""),
          payoutId: String(r["Payout ID"] || ""),
        });
      }
    }
  }
  console.log(`   Loaded ${reconMap.size} reconciliation records`);

  // 3. Load membership data (for tier -> class mapping)
  console.log("\n3. Loading membership data...");
  const memberFiles = findFiles(/^new_membership_overview/, ".xls");
  // Also try CSV membership files
  const memberCSVFiles = findFiles(/membership/, ".csv");
  const memberMap = new Map<
    string,
    { tier: string; fee: number; status: string; drawDay: string }
  >();
  for (const f of memberFiles) {
    const rows = parseXLS(f);
    for (const r of rows) {
      const name = String(r["Patient Name"] || "").trim();
      if (name && !memberMap.has(name)) {
        memberMap.set(name, {
          tier: String(r["Membership Name"] || ""),
          fee: parseFloat(r["Membership Fee"]) || 0,
          status: String(r.Status || ""),
          drawDay: String(r["Draw Day"] || ""),
        });
      }
    }
  }
  for (const f of memberCSVFiles) {
    try {
      const rows = parseCSV(f);
      for (const r of rows) {
        const name = (r["Patient Name"] || "").trim();
        if (name && !memberMap.has(name)) {
          memberMap.set(name, {
            tier: r["Membership Name"] || "",
            fee: parseFloat(r["Membership Fee"]) || 0,
            status: r.Status || "",
            drawDay: r["Draw Day"] || "",
          });
        }
      }
    } catch { /* skip non-membership CSVs */ }
  }
  console.log(`   Loaded ${memberMap.size} membership records`);

  // 3b. Load churn data (for tier lookup on churned members)
  console.log("\n3b. Loading churn data...");
  const churnFiles = findFiles(/churn/i, ".csv");
  const churnXLSFiles = findFiles(/churn/i, ".xls");
  const churnMap = new Map<
    string,
    { tier: string; amount: number; churnDate: string }
  >();
  for (const f of churnFiles) {
    try {
      const rows = parseCSV(f);
      for (const r of rows) {
        const name = (r["Patient Name"] || "").trim();
        if (name && !churnMap.has(name)) {
          churnMap.set(name, {
            tier: r["Membership Name"] || "",
            amount: parseFloat(r.Amount) || 0,
            churnDate: r["Churned on"] || "",
          });
        }
      }
    } catch { /* skip */ }
  }
  for (const f of churnXLSFiles) {
    try {
      const rows = parseXLS(f);
      for (const r of rows) {
        const name = String(r["Patient Name"] || "").trim();
        if (name && !churnMap.has(name)) {
          churnMap.set(name, {
            tier: String(r["Membership Name"] || ""),
            amount: parseFloat(r.Amount) || 0,
            churnDate: String(r["Churned on"] || ""),
          });
        }
      }
    } catch { /* skip */ }
  }
  console.log(`   Loaded ${churnMap.size} churn records`);

  // 4. Process invoices
  console.log("\n4. Categorizing transactions...");
  const categorized: CategorizedLine[] = [];
  let skipped = 0;

  let tierMissCount = 0;
  const tierMissNames = new Set<string>();

  for (const inv of allInvoices) {
    const date = inv.Date;

    // Filter by month if specified
    if (targetMonth && !dateInMonth(date, targetMonth)) {
      skipped++;
      continue;
    }

    const item = inv.Item || "";
    const arCat = inv.Category || "";
    const patient = (inv.Patient || "").trim();
    const invoiceNum = inv["Invoice Number"] || "";
    const recon = reconMap.get(invoiceNum);

    // Find matching rule
    let matchedRule = ACCOUNT_RULES.find((r) => r.match(item, arCat));
    if (!matchedRule) matchedRule = ACCOUNT_RULES[ACCOUNT_RULES.length - 1];

    // Resolve QB Class
    let qbClass = matchedRule.qbClass;
    let membershipTier = "";

    if (qbClass === "FROM_MEMBERSHIP") {
      // Look up patient's membership tier
      const member = memberMap.get(patient);
      const churned = churnMap.get(patient);

      if (member) {
        membershipTier = member.tier;
        qbClass = membershipTierToClass(member.tier);
      } else if (churned) {
        membershipTier = churned.tier + " (churned)";
        qbClass = membershipTierToClass(churned.tier);
      } else {
        // Can't determine tier - flag it
        membershipTier = "UNKNOWN";
        qbClass = QB_CLASSES.NOT_SPECIFIED;
        tierMissCount++;
        tierMissNames.add(patient);
      }
    }

    categorized.push({
      date,
      invoiceNumber: invoiceNum,
      patient,
      item,
      arCategory: arCat || "(none)",
      qbAccount: matchedRule.account,
      qbSubAccount: matchedRule.subAccount || "",
      qbClass,
      membershipTier,
      grossAmount: parseFloat(inv["Gross Total"]) || 0,
      discount: parseFloat(inv["Discount & Complimentary"]) || 0,
      collected: parseFloat(inv["Item Total Collected"] || inv["Total Collected"]) || 0,
      processingFees:
        parseFloat(inv["Processing & Business Fees"]) || 0,
      netSale: parseFloat(inv["Net Sale"]) || 0,
      tenderType: inv["Tender Type"] || "",
      employee: inv.Employee || "",
      status: inv["Invoice Status"] || "",
      payoutAmount: recon?.payoutAmount,
      payoutDate: recon?.payoutDate,
      payoutId: recon?.payoutId,
    });
  }

  if (tierMissCount > 0) {
    console.log(
      `   WARNING: ${tierMissCount} membership lines couldn't be matched to a tier (${tierMissNames.size} unique patients)`
    );
    console.log(`   Unmatched: ${[...tierMissNames].slice(0, 10).join(", ")}${tierMissNames.size > 10 ? "..." : ""}`);
  }

  console.log(
    `   Categorized: ${categorized.length} lines (skipped ${skipped} outside target month)`
  );

  // 5. Generate summary
  console.log("\n5. Generating summary...");

  // By QB Class (what the accountant needs most)
  const classTotals: Record<
    string,
    { collected: number; gross: number; discount: number; count: number }
  > = {};
  // By QB Class + Account (detailed)
  const classAccountTotals: Record<
    string,
    { collected: number; gross: number; discount: number; count: number }
  > = {};

  for (const line of categorized) {
    // Class-level totals
    if (!classTotals[line.qbClass]) {
      classTotals[line.qbClass] = { collected: 0, gross: 0, discount: 0, count: 0 };
    }
    classTotals[line.qbClass].collected += line.collected;
    classTotals[line.qbClass].gross += line.grossAmount;
    classTotals[line.qbClass].discount += line.discount;
    classTotals[line.qbClass].count++;

    // Class + Account detail
    const detailKey = `${line.qbClass} > ${line.qbAccount}`;
    if (!classAccountTotals[detailKey]) {
      classAccountTotals[detailKey] = { collected: 0, gross: 0, discount: 0, count: 0 };
    }
    classAccountTotals[detailKey].collected += line.collected;
    classAccountTotals[detailKey].gross += line.grossAmount;
    classAccountTotals[detailKey].discount += line.discount;
    classAccountTotals[detailKey].count++;
  }

  // 6. Write CSV output
  const monthLabel = targetMonth || "all";
  const csvPath = join(OUTPUT_DIR, `${monthLabel}-categorized-transactions.csv`);

  const csvHeaders = [
    "Date",
    "Invoice Number",
    "Patient",
    "Item",
    "AR Category",
    "QB Class",
    "QB Account",
    "Membership Tier",
    "Gross Amount",
    "Discount",
    "Collected",
    "Processing Fees",
    "Net Sale",
    "Tender Type",
    "Employee",
    "Status",
    "Payout Amount",
    "Payout Date",
  ];

  const csvLines = [csvHeaders.join(",")];
  for (const line of categorized) {
    csvLines.push(
      [
        line.date,
        line.invoiceNumber,
        `"${line.patient}"`,
        `"${line.item}"`,
        `"${line.arCategory}"`,
        `"${line.qbClass}"`,
        `"${line.qbAccount}"`,
        `"${line.membershipTier}"`,
        line.grossAmount,
        line.discount,
        line.collected,
        line.processingFees,
        line.netSale,
        line.tenderType,
        `"${line.employee}"`,
        line.status,
        line.payoutAmount ?? "",
        line.payoutDate ?? "",
      ].join(",")
    );
  }

  writeFileSync(csvPath, csvLines.join("\n"));
  console.log(`   Wrote: ${csvPath}`);

  // 7. Write summary
  const summaryPath = join(OUTPUT_DIR, `${monthLabel}-summary.txt`);
  const summaryLines: string[] = [];
  summaryLines.push(`AESTHETIC RECORD ACCOUNTING SUMMARY`);
  summaryLines.push(`Period: ${targetMonth || "All Available Data"}`);
  summaryLines.push(`Generated: ${new Date().toISOString().split("T")[0]}`);
  summaryLines.push(`Source: Aesthetic Record exports`);
  summaryLines.push(`${"=".repeat(70)}`);
  summaryLines.push("");

  let totalCollected = 0;
  let totalGross = 0;
  let totalDiscount = 0;

  // Class-level summary (matches QB P&L by Class)
  summaryLines.push(
    `${"QB Class".padEnd(30)} ${"Collected".padStart(12)} ${"Gross".padStart(12)} ${"Discount".padStart(12)} ${"Count".padStart(6)}`
  );
  summaryLines.push("-".repeat(75));

  const sortedClasses = Object.entries(classTotals).sort((a, b) => b[1].collected - a[1].collected);
  for (const [cls, data] of sortedClasses) {
    summaryLines.push(
      `${cls.padEnd(30)} $${data.collected.toFixed(2).padStart(11)} $${data.gross.toFixed(2).padStart(11)} $${data.discount.toFixed(2).padStart(11)} ${String(data.count).padStart(6)}`
    );
    totalCollected += data.collected;
    totalGross += data.gross;
    totalDiscount += data.discount;
  }

  summaryLines.push("-".repeat(75));
  summaryLines.push(
    `${"TOTAL".padEnd(30)} $${totalCollected.toFixed(2).padStart(11)} $${totalGross.toFixed(2).padStart(11)} $${totalDiscount.toFixed(2).padStart(11)}`
  );

  // Detailed breakdown: Class > Account
  summaryLines.push("");
  summaryLines.push("DETAILED BREAKDOWN (Class > Account)");
  summaryLines.push("-".repeat(75));
  const sortedDetail = Object.entries(classAccountTotals).sort((a, b) => b[1].collected - a[1].collected);
  for (const [key, data] of sortedDetail) {
    if (data.collected !== 0) {
      summaryLines.push(
        `  ${key.padEnd(45)} $${data.collected.toFixed(2).padStart(11)} ${String(data.count).padStart(6)}`
      );
    }
  }

  summaryLines.push("");
  summaryLines.push(`Gross Revenue: $${totalGross.toFixed(2)}`);
  summaryLines.push(`Total Discounts: $${totalDiscount.toFixed(2)}`);
  summaryLines.push(`Total Collected: $${totalCollected.toFixed(2)}`);

  // Membership enrichment
  summaryLines.push("");
  summaryLines.push("MEMBERSHIP SNAPSHOT");
  summaryLines.push("-".repeat(70));
  const activeMemberships = [...memberMap.values()].filter(
    (m) => m.status === "active"
  );
  const tierCounts: Record<string, number> = {};
  for (const m of activeMemberships) {
    tierCounts[m.tier] = (tierCounts[m.tier] || 0) + 1;
  }
  summaryLines.push(`Active Members: ${activeMemberships.length}`);
  for (const [tier, count] of Object.entries(tierCounts).sort(
    (a, b) => b[1] - a[1]
  )) {
    summaryLines.push(`  ${tier}: ${count}`);
  }

  // Payment method breakdown
  summaryLines.push("");
  summaryLines.push("PAYMENT METHOD BREAKDOWN");
  summaryLines.push("-".repeat(70));
  const tenderTotals: Record<string, number> = {};
  for (const line of categorized) {
    if (line.tenderType) {
      tenderTotals[line.tenderType] =
        (tenderTotals[line.tenderType] || 0) + line.collected;
    }
  }
  for (const [tender, total] of Object.entries(tenderTotals).sort(
    (a, b) => b[1] - a[1]
  )) {
    summaryLines.push(`  ${tender}: $${total.toFixed(2)}`);
  }

  // Employee breakdown
  summaryLines.push("");
  summaryLines.push("EMPLOYEE REVENUE ATTRIBUTION");
  summaryLines.push("-".repeat(70));
  const empTotals: Record<string, number> = {};
  for (const line of categorized) {
    if (line.employee) {
      empTotals[line.employee] =
        (empTotals[line.employee] || 0) + line.collected;
    }
  }
  for (const [emp, total] of Object.entries(empTotals).sort(
    (a, b) => b[1] - a[1]
  )) {
    summaryLines.push(`  ${emp}: $${total.toFixed(2)}`);
  }

  // 7b. Load Transaction Sales data (for refund reconciliation)
  console.log("\n7b. Loading Transaction Sales data...");
  const txnSalesFiles = findFiles(/^transaction_sales/, ".csv");
  interface TxnSale {
    invoiceNumber: string;
    type: string; // "Payment" or "Refund"
    amount: number;
    paymentMode: string;
    refundType: string;
    created: string; // "MM/DD/YYYY HH:MM AM/PM"
  }
  const txnSales: TxnSale[] = [];
  for (const f of txnSalesFiles) {
    try {
      const rows = parseCSV(f);
      for (const r of rows) {
        txnSales.push({
          invoiceNumber: r["Invoice Number"] || "",
          type: r["Transaction Type"] || "",
          amount: parseFloat(r["Amount In($)"]) || 0,
          paymentMode: r["Payment Mode"] || "",
          refundType: r["Refund Type"] || "",
          created: r["Created"] || "",
        });
      }
    } catch { /* skip */ }
  }
  console.log(`   Loaded ${txnSales.length} transaction sales records`);

  // 8. Validate against Daily Sales Report
  console.log("\n8. Validating against Daily Sales Report...");
  const dailySalesFiles = findFiles(/^daily_sales_report/, ".xls");
  let walletCreditsFromDS = 0; // hoisted for use in validation checks

  // Parse a dollar amount from Daily Sales (may be string like "52,026.00" or number)
  function parseDollar(val: any): number {
    if (typeof val === "number") return val;
    if (typeof val === "string") return parseFloat(val.replace(/,/g, "")) || 0;
    return 0;
  }

  // Find the Daily Sales file matching our target month
  // Daily Sales XLS has a special structure: row 0 is ["Date", "MM/DD/YYYY - MM/DD/YYYY"]
  // Subsequent rows are ["Label", "Value"] pairs. We read raw to avoid header confusion.
  let dailySalesMatch: Record<string, number> | null = null;
  for (const f of dailySalesFiles) {
    const wb = XLSX.readFile(f);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
    if (rawData.length < 2) continue;

    // Row 0: ["Date", "01/01/2026 - 01/31/2026"]
    const dateRange = String(rawData[0][1] || "");
    if (!dateRange) continue;

    // Extract start month from date range
    const match = dateRange.match(/(\d{2})\/\d{2}\/(\d{4})/);
    if (!match) continue;
    const fileMonth = `${match[2]}-${match[1]}`;
    if (targetMonth && fileMonth !== targetMonth) continue;

    // Extract all label -> value pairs
    const totals: Record<string, number> = {};
    for (const row of rawData) {
      if (row.length >= 2 && row[0] != null) {
        const label = String(row[0]).trim();
        totals[label] = parseDollar(row[1]);
      }
    }

    dailySalesMatch = totals;
    break;
  }

  if (dailySalesMatch) {
    const arProcedures = dailySalesMatch["Sales from Procedures Performed & Retail"] || 0;
    const arMembership = dailySalesMatch["Membership Revenue"] || 0;
    const arWalletCredits = dailySalesMatch["Wallet Credits"] || 0;
    walletCreditsFromDS = arWalletCredits;
    const arNetSales = dailySalesMatch["Total Net Sales"] || 0;
    // Daily Sales labels have leading spaces like " - Refunds (Total)"
    // Helper to find value by partial key match
    const findVal = (partial: string): number => {
      for (const [k, v] of Object.entries(dailySalesMatch!)) {
        if (k.includes(partial)) return v;
      }
      return 0;
    };
    const arRefunds = findVal("Refunds (Total)") || findVal("Refunds");
    const arProcessingFees = findVal("Processing & Business Fees");
    const arTips = findVal("Tips") && !findVal("Tips Adjustments") ? findVal("Tips") : (dailySalesMatch["- Tips"] || findVal("- Tips"));
    const arTax = findVal("- Tax");
    const arDiscounts = findVal("Discount & Complimentary");
    const arCoupons = findVal("Membership Coupons");

    // Our script sums "Item Total Collected" which is the amount after discounts
    // AR "Procedures + Membership" is pre-discount gross
    // AR "Net Sales" = gross - refunds - tips - tax - fees - discounts - coupons
    // Best comparison: Script Gross vs AR (Procedures + Membership)
    // The delta should equal Wallet Credits (which appear in Daily Sales but not Invoice gross)
    const arGrossTotal = arProcedures + arMembership;
    const grossDelta = totalGross - arGrossTotal;
    const expectedDelta = arWalletCredits; // wallet credits explain the difference

    summaryLines.push("");
    summaryLines.push("VALIDATION vs DAILY SALES REPORT");
    summaryLines.push("-".repeat(70));
    summaryLines.push(`  AR Procedures + Retail:    $${arProcedures.toFixed(2)}`);
    summaryLines.push(`  AR Membership Revenue:     $${arMembership.toFixed(2)}`);
    summaryLines.push(`  AR Gross Total:            $${arGrossTotal.toFixed(2)}`);
    summaryLines.push(`  Script Gross Revenue:      $${totalGross.toFixed(2)}`);
    summaryLines.push(`  Delta:                     $${grossDelta.toFixed(2)} (Wallet Credits: $${expectedDelta.toFixed(2)})`);

    const tolerance = 1.0; // $1 tolerance for rounding
    if (Math.abs(grossDelta - expectedDelta) <= tolerance) {
      summaryLines.push(`  STATUS: VALIDATED ✓ (delta matches wallet credits)`);
      console.log(`   VALIDATED ✓ - Script gross matches AR after wallet credit adjustment`);
    } else {
      summaryLines.push(`  STATUS: MISMATCH ⚠ (unexplained delta: $${(grossDelta - expectedDelta).toFixed(2)})`);
      console.log(`   MISMATCH ⚠ - Unexplained delta: $${(grossDelta - expectedDelta).toFixed(2)}`);
    }

    // Also show the AR deductions for reference
    summaryLines.push("");
    summaryLines.push("  AR Deductions:");
    summaryLines.push(`    Refunds:           $${arRefunds.toFixed(2)}`);
    summaryLines.push(`    Processing Fees:   $${arProcessingFees.toFixed(2)}`);
    summaryLines.push(`    Tips:              $${arTips.toFixed(2)}`);
    summaryLines.push(`    Tax:               $${arTax.toFixed(2)}`);
    summaryLines.push(`    Discounts:         $${arDiscounts.toFixed(2)}`);
    summaryLines.push(`    Membership Coupons:$${arCoupons.toFixed(2)}`);
    summaryLines.push(`    AR Net Sales:      $${arNetSales.toFixed(2)}`);
  } else {
    summaryLines.push("");
    summaryLines.push("VALIDATION: No matching Daily Sales Report found for this period.");
    summaryLines.push("Export the Daily Sales Report from AR to enable cross-validation.");
    console.log("   No matching Daily Sales Report found for validation");
  }

  // ── VALIDATION REPORT (7 additional checks) ──────────────────────────────

  console.log("\n9. Running validation checks...");
  summaryLines.push("");
  summaryLines.push("=".repeat(70));
  summaryLines.push("VALIDATION REPORT");
  summaryLines.push("=".repeat(70));

  interface ValidationResult {
    name: string;
    status: "PASS" | "WARN" | "FAIL";
    detail: string;
    extras?: string[];
  }
  const validationResults: ValidationResult[] = [];

  // ── CHECK 1: Refund Reconciliation ──────────────────────────────────────
  // Cross-check Transaction Sales refunds against Invoice CSV "Refunds" column
  // Transaction Sales Created format: "MM/DD/YYYY HH:MM AM/PM"
  {
    // Helper: check if a Transaction Sales "Created" timestamp falls in target month
    const txnInMonth = (created: string): boolean => {
      if (!targetMonth) return true;
      const m = created.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (!m) return false;
      const txnMonth = `${m[3]}-${m[1].padStart(2, "0")}`;
      return txnMonth === targetMonth;
    };

    const monthTxnRefunds = txnSales.filter(
      (t) => t.type === "Refund" && txnInMonth(t.created)
    );
    const txnRefundTotal = monthTxnRefunds.reduce(
      (sum, t) => sum + Math.abs(t.amount), 0
    );
    const txnRefundCount = monthTxnRefunds.length;

    // Sum the Refunds column from raw invoice data for this month
    const rawRefundCol = allInvoices
      .filter((inv) => !targetMonth || dateInMonth(inv.Date, targetMonth))
      .reduce((sum, inv) => sum + (parseFloat(inv.Refunds) || 0), 0);

    // Also count refunded invoices in categorized data
    const refundedInvoices = categorized.filter((l) => l.status === "Refunded");

    const delta = Math.abs(txnRefundTotal - rawRefundCol);

    let status: "PASS" | "WARN" | "FAIL" = "PASS";
    let detail = "";
    const extras: string[] = [];

    if (txnSales.length === 0) {
      status = "WARN";
      detail = `No Transaction Sales data loaded. Export transaction_sales CSV to enable this check.`;
    } else if (txnRefundCount === 0 && rawRefundCol === 0) {
      detail = `No refunds in either source for this period.`;
    } else if (txnRefundCount === 0 && rawRefundCol > 0) {
      status = "WARN";
      detail = `Transaction Sales has no refunds for ${targetMonth || "this period"} (data may not cover this month). Invoice refunds column: $${rawRefundCol.toFixed(2)}. Export Transaction Sales for the matching period.`;
    } else if (delta <= 1.0) {
      detail = `Transaction Sales refunds: $${txnRefundTotal.toFixed(2)} (${txnRefundCount} txns) | Invoice refunds column: $${rawRefundCol.toFixed(2)} | Delta: $${delta.toFixed(2)}`;
    } else {
      status = "FAIL";
      detail = `MISMATCH: Txn Sales refunds $${txnRefundTotal.toFixed(2)} (${txnRefundCount} txns) vs Invoice refunds $${rawRefundCol.toFixed(2)} | Delta: $${delta.toFixed(2)}`;
    }

    if (refundedInvoices.length > 0) {
      extras.push(`  Refunded invoices in period: ${refundedInvoices.length} totaling $${refundedInvoices.reduce((s, l) => s + l.grossAmount, 0).toFixed(2)} gross`);
    }

    validationResults.push({ name: "1. Refund Reconciliation", status, detail, extras });
  }

  // ── CHECK 2: Duplicate Invoice Detection ────────────────────────────────
  // Deduplicate by Invoice Number + Item to prevent double-counting
  {
    const seen = new Map<string, number>();
    const dupes: Array<{ key: string; count: number; amount: number }> = [];

    for (const line of categorized) {
      const key = `${line.invoiceNumber}|${line.item}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }

    let dupeCount = 0;
    let dupeRevenue = 0;
    for (const [key, count] of seen) {
      if (count > 1) {
        dupeCount += count - 1;
        // Find the amount for this duplicate
        const match = categorized.find(
          (l) => `${l.invoiceNumber}|${l.item}` === key
        );
        const amt = match ? match.collected * (count - 1) : 0;
        dupeRevenue += amt;
        dupes.push({ key, count, amount: amt });
      }
    }

    let status: "PASS" | "WARN" | "FAIL" = "PASS";
    let detail = "";
    const extras: string[] = [];

    if (dupeCount === 0) {
      detail = `No duplicate Invoice Number + Item combinations found. ${categorized.length} lines all unique.`;
    } else {
      status = "WARN";
      detail = `Found ${dupeCount} duplicate line(s) totaling $${dupeRevenue.toFixed(2)} in potential double-counted revenue.`;
      for (const d of dupes.slice(0, 5)) {
        extras.push(`  Dupe: ${d.key} (${d.count}x, $${d.amount.toFixed(2)})`);
      }
      if (dupes.length > 5) extras.push(`  ... and ${dupes.length - 5} more`);
    }

    validationResults.push({ name: "2. Duplicate Invoice Detection", status, detail, extras });
  }

  // ── CHECK 3: Membership Fee vs Tier Price Mismatch ──────────────────────
  // Flag when a membership fee line item doesn't match the expected tier price
  {
    const mismatches: Array<{ patient: string; tier: string; expected: number; actual: number }> = [];

    for (const line of categorized) {
      if (!/membership fee/i.test(line.item)) continue;
      if (line.membershipTier === "UNKNOWN" || !line.membershipTier) continue;

      const tierName = line.membershipTier.replace(" (churned)", "");
      // Look up expected fee from membership data
      const member = memberMap.get(line.patient);
      const churned = churnMap.get(line.patient);
      const expectedFee = member?.fee || churned?.amount || 0;

      if (expectedFee > 0 && Math.abs(line.grossAmount - expectedFee) > 1.0) {
        mismatches.push({
          patient: line.patient,
          tier: tierName,
          expected: expectedFee,
          actual: line.grossAmount,
        });
      }
    }

    let status: "PASS" | "WARN" | "FAIL" = "PASS";
    let detail = "";
    const extras: string[] = [];

    if (mismatches.length === 0) {
      detail = `All membership fees match expected tier prices.`;
    } else {
      status = "WARN";
      detail = `${mismatches.length} membership fee(s) don't match expected tier price. May indicate prorated charges, mid-month tier changes, or billing errors.`;
      for (const m of mismatches.slice(0, 5)) {
        extras.push(`  ${m.patient}: ${m.tier} expected $${m.expected.toFixed(2)}, got $${m.actual.toFixed(2)}`);
      }
      if (mismatches.length > 5) extras.push(`  ... and ${mismatches.length - 5} more`);
    }

    validationResults.push({ name: "3. Membership Fee vs Tier Price", status, detail, extras });
  }

  // ── CHECK 4: Missing Patients in Membership Lookup ──────────────────────
  // Surface % of membership revenue that couldn't be tied to a tier
  {
    const membershipLines = categorized.filter((l) => /membership fee|setup fee/i.test(l.item));
    const totalMembershipRevenue = membershipLines.reduce((s, l) => s + l.grossAmount, 0);
    const unknownLines = membershipLines.filter((l) => l.membershipTier === "UNKNOWN");
    const unknownRevenue = unknownLines.reduce((s, l) => s + l.grossAmount, 0);
    const pct = totalMembershipRevenue > 0 ? (unknownRevenue / totalMembershipRevenue) * 100 : 0;

    let status: "PASS" | "WARN" | "FAIL" = "PASS";
    let detail = `${unknownLines.length} of ${membershipLines.length} membership lines unresolved ($${unknownRevenue.toFixed(2)} of $${totalMembershipRevenue.toFixed(2)}, ${pct.toFixed(1)}%)`;
    const extras: string[] = [];

    if (pct > 10) {
      status = "FAIL";
      detail += ` - HIGH: >10% unresolved. Check membership export completeness.`;
    } else if (pct > 5) {
      status = "WARN";
      detail += ` - Moderate: 5-10% unresolved.`;
    }

    if (tierMissNames.size > 0) {
      extras.push(`  Unmatched patients: ${[...tierMissNames].slice(0, 8).join(", ")}${tierMissNames.size > 8 ? "..." : ""}`);
    }

    validationResults.push({ name: "4. Membership Tier Coverage", status, detail, extras });
  }

  // ── CHECK 5: Processing Fee Reconciliation ──────────────────────────────
  // Compare Invoice processing fees vs Reconciliation (CC Amount - Payout Amount = fees)
  {
    const invoiceFees = categorized.reduce((s, l) => s + l.processingFees, 0);

    // Calculate implied fees from reconciliation: CC Amount Collected - Payout Amount
    let reconFees = 0;
    let reconMatchCount = 0;
    for (const line of categorized) {
      const recon = reconMap.get(line.invoiceNumber);
      if (recon) {
        // CC Amount is what was charged; Payout is what was deposited
        // The difference = processing fees for that transaction
        reconMatchCount++;
      }
    }
    // Sum from recon directly
    let reconCCTotal = 0;
    let reconPayoutTotal = 0;
    for (const [, data] of reconMap) {
      reconCCTotal += parseFloat(String(data.payoutAmount)) || 0; // payoutAmount is what we stored
    }
    // We need CC Amount - we only stored payoutAmount. Recalculate from raw recon data.
    let reconImpliedFees = 0;
    for (const f of reconFiles) {
      const rows = parseXLS(f);
      for (const r of rows) {
        const invoiceNum = String(r.Invoice || "");
        // Only include invoices in our categorized set
        if (categorized.some((c) => c.invoiceNumber === invoiceNum)) {
          const ccAmt = parseFloat(r["CC Amount Collected"]) || 0;
          const payoutAmt = parseFloat(r["Payout Amount"]) || 0;
          reconImpliedFees += ccAmt - payoutAmt;
        }
      }
    }

    const delta = Math.abs(invoiceFees - reconImpliedFees);

    let status: "PASS" | "WARN" | "FAIL" = "PASS";
    let detail = "";

    if (reconFiles.length === 0) {
      status = "WARN";
      detail = `No Reconciliation data loaded. Export reconciliation_report XLS to enable this check.`;
    } else if (delta <= 5.0) {
      detail = `Invoice processing fees: $${invoiceFees.toFixed(2)} | Recon implied fees (CC - Payout): $${reconImpliedFees.toFixed(2)} | Delta: $${delta.toFixed(2)}`;
    } else {
      status = delta > 50 ? "FAIL" : "WARN";
      detail = `Invoice fees $${invoiceFees.toFixed(2)} vs Recon implied $${reconImpliedFees.toFixed(2)} | Delta: $${delta.toFixed(2)}`;
    }

    validationResults.push({ name: "5. Processing Fee Reconciliation", status, detail });
  }

  // ── CHECK 6: MoM Membership Revenue Sanity Check ────────────────────────
  // Flag >15% drops between months (requires looking at other month files)
  {
    let status: "PASS" | "WARN" | "FAIL" = "PASS";
    let detail = "";

    if (!targetMonth) {
      detail = "Skipped (no target month specified for MoM comparison)";
      status = "WARN";
    } else {
      const [year, monthNum] = targetMonth.split("-").map(Number);
      // Calculate previous month
      const prevMonth = monthNum === 1
        ? `${year - 1}-12`
        : `${year}-${String(monthNum - 1).padStart(2, "0")}`;

      // Get current month membership revenue
      const currentMRR = categorized
        .filter((l) => /membership fee/i.test(l.item))
        .reduce((s, l) => s + l.grossAmount, 0);

      // Try to read previous month's summary to get MRR
      const prevSummaryPath = join(OUTPUT_DIR, `${prevMonth}-summary.txt`);
      let prevMRR = 0;
      let prevFound = false;

      if (existsSync(prevSummaryPath)) {
        const prevSummary = readFileSync(prevSummaryPath, "utf-8");
        // Look for MRR in the QB Class breakdown (Weight Loss class from membership)
        // Or calculate from previous run's CSV
        const prevCSV = join(OUTPUT_DIR, `${prevMonth}-categorized-transactions.csv`);
        if (existsSync(prevCSV)) {
          const prevData = parseCSV(prevCSV);
          prevMRR = prevData
            .filter((r) => /membership fee/i.test(r.Item || ""))
            .reduce((s, r) => s + (parseFloat(r["Gross Amount"]) || 0), 0);
          prevFound = true;
        }
      }

      if (!prevFound) {
        // Try calculating from raw invoice data for previous month
        const prevInvoices = allInvoices.filter(
          (inv) => dateInMonth(inv.Date, prevMonth) && /membership fee/i.test(inv.Item || "")
        );
        if (prevInvoices.length > 0) {
          prevMRR = prevInvoices.reduce(
            (s, inv) => s + (parseFloat(inv["Gross Total"]) || 0), 0
          );
          prevFound = true;
        }
      }

      if (!prevFound) {
        detail = `No previous month (${prevMonth}) data available for comparison. Current MRR: $${currentMRR.toFixed(2)}`;
      } else if (prevMRR === 0) {
        detail = `Previous month (${prevMonth}) MRR was $0. Current: $${currentMRR.toFixed(2)}. May be missing data.`;
        status = "WARN";
      } else {
        const changePct = ((currentMRR - prevMRR) / prevMRR) * 100;
        detail = `${prevMonth} MRR: $${prevMRR.toFixed(2)} -> ${targetMonth} MRR: $${currentMRR.toFixed(2)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}%)`;

        if (changePct < -15) {
          status = "FAIL";
          detail += ` DROP >15%. Check for missing data or significant churn event.`;
        } else if (changePct < -5) {
          status = "WARN";
          detail += ` Moderate decline.`;
        }
      }
    }

    validationResults.push({ name: "6. MoM Membership Revenue", status, detail });
  }

  // ── CHECK 7: Cash vs Credit Tender Validation ───────────────────────────
  // Cross-check payment method totals against Daily Sales Payment Method Report
  {
    let status: "PASS" | "WARN" | "FAIL" = "PASS";
    let detail = "";
    const extras: string[] = [];

    if (!dailySalesMatch) {
      status = "WARN";
      detail = "No Daily Sales Report loaded. Cannot validate payment methods.";
    } else {
      // Extract payment method section from Daily Sales raw data
      // We already have dailySalesMatch which contains all label->value pairs
      // Payment Method Report labels: Cash, Check, Credit, Cherry, Greensky, Care Credit, etc.
      const dsPaymentMethods: Record<string, number> = {};
      for (const [k, v] of Object.entries(dailySalesMatch)) {
        // Payment method keys are simple single-word labels after "Payment Method Report" header
        if (["Cash", "Check", "Credit", "Cherry", "Greensky", "Care Credit",
             "Aspire Coupons", "Evolus Rewards", "Allē Rewards", "Xperience Rewards",
             "Link", "Klarna"].includes(k.trim())) {
          dsPaymentMethods[k.trim()] = v;
        }
      }

      // Our script tender type totals
      const scriptTender: Record<string, number> = {};
      for (const line of categorized) {
        if (line.tenderType) {
          scriptTender[line.tenderType] =
            (scriptTender[line.tenderType] || 0) + line.collected;
        }
      }

      // Map script tender types to Daily Sales categories
      // Script uses: "Credit Card", "Cash", "Link (Pay-by-link)", "Gift Card, Credit Card", etc.
      // Daily Sales uses: "Credit", "Cash", "Check", "Link", "Care Credit", etc.
      // Combo tender types like "Gift Card, Credit Card" split across categories
      const tenderToDS: Record<string, string[]> = {
        "Credit Card": ["Credit"],
        "Cash": ["Cash"],
        "Check": ["Check"],
        "Link (Pay-by-link)": ["Link"],
        "Link": ["Link"],
        "Care Credit": ["Care Credit"],
        "Cherry": ["Cherry"],
        "Greensky": ["Greensky"],
        "Klarna": ["Klarna"],
        // Combo tenders: AR records "Gift Card, Credit Card" as one tender
        // but Daily Sales counts the CC portion under "Credit" and gift portion separately
        "Gift Card, Credit Card": ["Credit"],
        "Gift Card": ["Credit"], // gift card redemptions show up in Credit total
      };

      // Consolidate script tenders: merge combo types into their primary category
      const consolidatedScript: Record<string, number> = {};
      for (const [scriptName, scriptAmt] of Object.entries(scriptTender)) {
        const dsCategories = tenderToDS[scriptName];
        if (dsCategories && dsCategories.length > 0) {
          const primary = dsCategories[0];
          consolidatedScript[primary] = (consolidatedScript[primary] || 0) + scriptAmt;
        } else {
          // Unknown tender type, keep as-is
          consolidatedScript[scriptName] = (consolidatedScript[scriptName] || 0) + scriptAmt;
        }
      }

      // Structural differences between Invoice "Item Total Collected" and DS "Payment Method":
      // 1. DS Payment Method = NET of refunds (actual payments - refunds returned)
      //    Invoice CSV shows original collected amount even on refunded invoices
      // 2. Invoice "collected" may include amounts offset by membership coupons, discounts,
      //    and reward programs (Aspire, Alle, etc.) that aren't real payment tenders
      // 3. Wallet Credits appear in DS totals but not as an invoice tender type
      const walletCreditsApplied = walletCreditsFromDS;

      // Known non-tender adjustments from Daily Sales (items that inflate invoice "collected"
      // but aren't actual payment method transactions)
      let nonTenderAdjustments = 0;
      if (dailySalesMatch) {
        // These are amounts in invoices that aren't paid via a real tender method
        const findDSVal = (partial: string): number => {
          for (const [k, v] of Object.entries(dailySalesMatch!)) {
            if (k.includes(partial)) return v;
          }
          return 0;
        };
        nonTenderAdjustments += findDSVal("Membership Coupons");
        nonTenderAdjustments += findDSVal("Aspire Coupons");
        nonTenderAdjustments += findDSVal("Allē Rewards") || findDSVal("Alle Rewards");
        nonTenderAdjustments += findDSVal("Xperience Rewards");
        nonTenderAdjustments += findDSVal("eGift Cards Redemption");
        nonTenderAdjustments += findDSVal("RepeatMD Transfer");
        nonTenderAdjustments += findDSVal("Joya Transfer");
      }

      // Sum refunds by tender type (refunded invoices still have collected > 0 in our data)
      const refundsByTender: Record<string, number> = {};
      for (const line of categorized) {
        if (line.status === "Refunded" && line.tenderType && line.collected > 0) {
          const dsCategories = tenderToDS[line.tenderType];
          const primary = dsCategories?.[0] || line.tenderType;
          refundsByTender[primary] = (refundsByTender[primary] || 0) + line.collected;
        }
      }
      const totalRefundAdjustment = Object.values(refundsByTender).reduce((s, v) => s + v, 0);

      let totalDelta = 0;
      const comparisons: Array<{ method: string; scriptGross: number; refundAdj: number; scriptNet: number; ds: number; delta: number }> = [];

      for (const [dsName, dsAmt] of Object.entries(dsPaymentMethods)) {
        const scriptGross = consolidatedScript[dsName] || 0;
        const refundAdj = refundsByTender[dsName] || 0;
        const scriptNet = scriptGross - refundAdj; // subtract refunds to match DS net payments
        const delta = scriptNet - dsAmt;
        if (scriptGross > 0 || dsAmt > 0) {
          comparisons.push({ method: dsName, scriptGross, refundAdj, scriptNet, ds: dsAmt, delta });
          totalDelta += Math.abs(delta);
        }
        delete consolidatedScript[dsName];
      }

      // Script entries not in DS
      for (const [name, amt] of Object.entries(consolidatedScript)) {
        if (amt > 0) {
          const refAdj = refundsByTender[name] || 0;
          comparisons.push({ method: name + " (script only)", scriptGross: amt, refundAdj: refAdj, scriptNet: amt - refAdj, ds: 0, delta: amt - refAdj });
          totalDelta += Math.abs(amt - refAdj);
        }
      }

      if (Object.keys(dsPaymentMethods).length === 0) {
        status = "WARN";
        detail = "Payment Method Report section not found in Daily Sales data.";
      } else {
        // Total known adjustments: refunds + wallet credits + non-tender (coupons/rewards)
        const totalKnownAdj = walletCreditsApplied + nonTenderAdjustments;
        const adjustedDelta = Math.abs(totalDelta - totalKnownAdj);
        const adjBreakdown = `Refund adj: $${totalRefundAdjustment.toFixed(2)}, Wallet: $${walletCreditsApplied.toFixed(2)}, Coupons/Rewards: $${nonTenderAdjustments.toFixed(2)}`;
        // Use percentage threshold: DS Total Payments as denominator
        const dsTotalPayments = Object.values(dsPaymentMethods).reduce((s, v) => s + v, 0);
        const unexplainedPct = dsTotalPayments > 0 ? (adjustedDelta / dsTotalPayments) * 100 : 0;

        if (unexplainedPct <= 2) {
          detail = `Payment methods reconciled. ${adjBreakdown}. Unexplained: $${adjustedDelta.toFixed(2)} (${unexplainedPct.toFixed(1)}% of $${dsTotalPayments.toFixed(2)})`;
        } else if (unexplainedPct <= 5) {
          status = "WARN";
          detail = `Payment method delta: ${adjBreakdown}. Unexplained: $${adjustedDelta.toFixed(2)} (${unexplainedPct.toFixed(1)}%)`;
        } else {
          status = "FAIL";
          detail = `Payment method delta: ${adjBreakdown}. Unexplained: $${adjustedDelta.toFixed(2)} (${unexplainedPct.toFixed(1)}%)`;
        }
      }

      for (const c of comparisons) {
        if (Math.abs(c.delta) > 1) {
          const refNote = c.refundAdj > 0 ? ` [refund adj: -$${c.refundAdj.toFixed(2)}]` : "";
          extras.push(`  ${c.method}: Script $${c.scriptNet.toFixed(2)}${refNote} vs DS $${c.ds.toFixed(2)} (Δ $${c.delta.toFixed(2)})`);
        }
      }
    }

    validationResults.push({ name: "7. Cash vs Credit Tender", status, detail, extras });
  }

  // ── Write Validation Report ─────────────────────────────────────────────
  for (const v of validationResults) {
    const icon = v.status === "PASS" ? "✓" : v.status === "WARN" ? "⚠" : "✗";
    summaryLines.push("");
    summaryLines.push(`${icon} ${v.name}: ${v.status}`);
    summaryLines.push(`  ${v.detail}`);
    if (v.extras) {
      for (const e of v.extras) summaryLines.push(e);
    }
  }

  const passCount = validationResults.filter((v) => v.status === "PASS").length;
  const warnCount = validationResults.filter((v) => v.status === "WARN").length;
  const failCount = validationResults.filter((v) => v.status === "FAIL").length;
  summaryLines.push("");
  summaryLines.push("-".repeat(70));
  summaryLines.push(
    `VALIDATION SUMMARY: ${passCount} passed, ${warnCount} warnings, ${failCount} failures (of ${validationResults.length} checks)`
  );

  console.log(`   Validation: ${passCount} pass, ${warnCount} warn, ${failCount} fail`);

  writeFileSync(summaryPath, summaryLines.join("\n"));
  console.log(`   Wrote: ${summaryPath}`);

  // Print summary to console
  console.log("\n" + summaryLines.join("\n"));
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let targetMonth: string | undefined;

if (args.includes("--all")) {
  targetMonth = undefined;
} else if (args.includes("--month")) {
  const idx = args.indexOf("--month");
  targetMonth = args[idx + 1];
  if (!targetMonth || !/^\d{4}-\d{2}$/.test(targetMonth)) {
    console.error("Usage: --month YYYY-MM (e.g., --month 2026-01)");
    process.exit(1);
  }
} else {
  // Default to current month
  const now = new Date();
  targetMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

run(targetMonth);
