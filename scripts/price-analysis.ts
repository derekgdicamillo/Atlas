/**
 * Analyze medication pricing from Partell cumulative report
 * Traces unit prices over time to find any stealth increases
 */
const { PDFParse } = require("pdf-parse");
import { readFileSync, writeFileSync } from "fs";

interface PriceEntry {
  date: string;
  unitPrice: number;
  amount: number;
  qty: number;
  isBulk: boolean;
  patient: string | null;
}

async function main() {
  const buf = readFileSync("data/task-output/partell-sample.pdf");
  const parser = new PDFParse({ data: new Uint8Array(buf), verbosity: 0 });
  const result = await parser.getText();
  const text = result.text;

  const lines = text.split("\n").map((l: string) => l.trim()).filter(Boolean);
  const items: PriceEntry[] = [];
  const dollarRe = /\$([0-9,.]+)/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip headers/footers
    if (
      line.startsWith("Tracking Number") ||
      line.startsWith("National Health") ||
      line.startsWith("Sales Detail") ||
      line.startsWith("Account:") ||
      line.startsWith("Printed On:") ||
      /^-- \d+ of \d+ --$/.test(line)
    ) {
      i++;
      continue;
    }

    // Main data line: date receipt $amount [tracking] rest
    const mainMatch = line.match(
      /^(\d{2}\/\d{2}\/\d{4})\s+(\d+)\s+\$([0-9,.]+)\s*([\w]*)\s*(.*)/
    );

    if (mainMatch) {
      const [, dateStr, receiptId, amountStr, tracking, rest] = mainMatch;
      const amount = parseFloat(amountStr.replace(",", ""));
      const dateParts = dateStr.split("/");
      const isoDate = `${dateParts[2]}-${dateParts[0].padStart(2, "0")}-${dateParts[1].padStart(2, "0")}`;

      // Collect continuation lines
      let fullText = rest || "";
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (
          /^\d{2}\/\d{2}\/\d{4}\s+\d+/.test(next) ||
          next.startsWith("Tracking Number") ||
          next.startsWith("National Health") ||
          /^-- \d+ of \d+ --$/.test(next)
        )
          break;
        fullText += " " + next;
        j++;
      }
      fullText = fullText.trim();

      // Skip non-medication items
      const lower = fullText.toLowerCase();
      if (
        lower.includes("ship") ||
        lower === "shipping" ||
        lower.includes("supplies") ||
        lower.includes("a/r payment") ||
        lower.includes("rx otc")
      ) {
        i = j;
        continue;
      }

      // Extract patient info
      const patientMatch = fullText.match(
        /(\d{8,}-\d{2})\s*-\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/
      );
      const patientName = patientMatch ? patientMatch[2] : null;

      // Extract medication name
      let medication = fullText;
      if (patientMatch) {
        const after = fullText
          .substring(
            fullText.indexOf(patientMatch[0]) + patientMatch[0].length
          )
          .trim();
        medication = after || fullText.replace(patientMatch[0], "").trim();
      }

      // Get quantity
      let qty = 1;
      const qtyMatch =
        medication.match(/\(QTY\s*(\d+)\)/i) ||
        fullText.match(/\(QTY\s*(\d+)\)/i);
      if (qtyMatch) qty = parseInt(qtyMatch[1]);
      medication = medication.replace(/\(QTY\s*\d+\)/gi, "").trim();

      const isBulk = !patientName;
      const unitPrice = qty > 1 ? amount / qty : amount;

      // Normalize medication key
      const medKey = medication
        .toUpperCase()
        .replace(/[^A-Z0-9/.\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (medKey.length >= 3) {
        items.push({
          date: isoDate,
          unitPrice: Math.round(unitPrice * 100) / 100,
          amount,
          qty,
          isBulk,
          patient: patientName,
          medication: medKey,
        } as any);
      }

      i = j;
    } else {
      i++;
    }
  }

  // Group by medication
  const byMed: Record<string, (PriceEntry & { medication: string })[]> = {};
  for (const item of items as any[]) {
    if (!byMed[item.medication]) byMed[item.medication] = [];
    byMed[item.medication].push(item);
  }

  // Analyze each medication for price changes
  console.log("=== MEDICATION PRICE ANALYSIS (Partell/NHRx) ===");
  console.log("Period: May 2025 - March 2026\n");

  const significantChanges: any[] = [];

  for (const [med, entries] of Object.entries(byMed)) {
    const sorted = entries.sort((a, b) => a.date.localeCompare(b.date));

    // Split into bulk (qty > 1, no patient) and patient fills
    const bulk = sorted.filter((e) => e.isBulk || e.qty > 1);
    const patient = sorted.filter((e) => !e.isBulk && e.qty === 1);

    for (const [label, tier] of [
      ["Bulk", bulk],
      ["Patient", patient],
    ] as const) {
      if (tier.length < 2) continue;

      // Track distinct prices chronologically
      let prevPrice = tier[0].unitPrice;
      let prevDate = tier[0].date;

      for (let k = 1; k < tier.length; k++) {
        const cur = tier[k];
        if (cur.unitPrice !== prevPrice) {
          const pctChange =
            ((cur.unitPrice - prevPrice) / prevPrice) * 100;
          significantChanges.push({
            medication: med,
            type: label,
            fromPrice: prevPrice,
            toPrice: cur.unitPrice,
            pctChange: Math.round(pctChange * 10) / 10,
            date: cur.date,
            prevDate,
          });
          prevPrice = cur.unitPrice;
          prevDate = cur.date;
        }
      }
    }
  }

  // Sort by date then by magnitude
  significantChanges.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return Math.abs(b.pctChange) - Math.abs(a.pctChange);
  });

  // Filter to only real price increases (not quantity-driven noise)
  // A real price increase: same medication at a higher per-unit price on a later date
  const realIncreases = significantChanges.filter((c) => c.pctChange > 0);
  const realDecreases = significantChanges.filter((c) => c.pctChange < 0);

  console.log(`Total price movements detected: ${significantChanges.length}`);
  console.log(`  Increases: ${realIncreases.length}`);
  console.log(`  Decreases: ${realDecreases.length}\n`);

  // Show all unique medications with their price history
  console.log("=== PRICE TIMELINE BY MEDICATION ===\n");

  for (const [med, entries] of Object.entries(byMed).sort()) {
    const sorted = entries.sort((a, b) => a.date.localeCompare(b.date));

    // Get distinct price points in order
    const priceTimeline: { date: string; price: number; type: string }[] = [];
    const seenPrices = new Set<string>();

    for (const e of sorted) {
      const type = e.isBulk || e.qty > 1 ? "bulk" : "patient";
      const key = `${e.unitPrice}|${type}`;
      if (!seenPrices.has(key)) {
        seenPrices.add(key);
        priceTimeline.push({ date: e.date, price: e.unitPrice, type });
      }
    }

    // Only show meds with more than one price point
    if (priceTimeline.length > 1) {
      console.log(`${med}:`);
      for (const pt of priceTimeline) {
        console.log(`  ${pt.date}  $${pt.price.toFixed(2)} (${pt.type})`);
      }

      // Check net change from first to last for each type
      const bulkPrices = priceTimeline.filter((p) => p.type === "bulk");
      const patientPrices = priceTimeline.filter((p) => p.type === "patient");

      for (const [label, prices] of [
        ["Bulk", bulkPrices],
        ["Patient", patientPrices],
      ] as const) {
        if (prices.length >= 2) {
          const first = prices[0];
          const last = prices[prices.length - 1];
          const netPct =
            ((last.price - first.price) / first.price) * 100;
          if (Math.abs(netPct) > 1) {
            const dir = netPct > 0 ? "UP" : "DOWN";
            console.log(
              `  >> NET ${label}: $${first.price.toFixed(2)} -> $${last.price.toFixed(2)} (${dir} ${Math.abs(netPct).toFixed(1)}%) from ${first.date} to ${last.date}`
            );
          }
        }
      }
      console.log();
    }
  }

  // Summary: medications that ended higher than they started
  console.log("\n=== MEDICATIONS THAT INCREASED (net) ===\n");

  let foundIncrease = false;
  for (const [med, entries] of Object.entries(byMed).sort()) {
    const sorted = entries.sort((a, b) => a.date.localeCompare(b.date));
    const bulk = sorted.filter((e) => e.isBulk || e.qty > 1);
    const patient = sorted.filter((e) => !e.isBulk && e.qty === 1);

    for (const [label, tier] of [
      ["Bulk", bulk],
      ["Patient", patient],
    ] as const) {
      if (tier.length < 2) continue;
      const first = tier[0];
      const last = tier[tier.length - 1];
      const netPct = ((last.unitPrice - first.unitPrice) / first.unitPrice) * 100;

      if (netPct > 2) {
        // Only flag if price stayed up (not just a one-off)
        foundIncrease = true;
        console.log(
          `${med} (${label}): $${first.unitPrice.toFixed(2)} -> $${last.unitPrice.toFixed(2)} (+${netPct.toFixed(1)}%)  [${first.date} to ${last.date}]`
        );
      }
    }
  }

  if (!foundIncrease) {
    console.log("No net price increases detected across the period.");
  }

  console.log("\n=== MEDICATIONS THAT DECREASED (net) ===\n");

  let foundDecrease = false;
  for (const [med, entries] of Object.entries(byMed).sort()) {
    const sorted = entries.sort((a, b) => a.date.localeCompare(b.date));
    const bulk = sorted.filter((e) => e.isBulk || e.qty > 1);
    const patient = sorted.filter((e) => !e.isBulk && e.qty === 1);

    for (const [label, tier] of [
      ["Bulk", bulk],
      ["Patient", patient],
    ] as const) {
      if (tier.length < 2) continue;
      const first = tier[0];
      const last = tier[tier.length - 1];
      const netPct = ((last.unitPrice - first.unitPrice) / first.unitPrice) * 100;

      if (netPct < -2) {
        foundDecrease = true;
        console.log(
          `${med} (${label}): $${first.unitPrice.toFixed(2)} -> $${last.unitPrice.toFixed(2)} (${netPct.toFixed(1)}%)  [${first.date} to ${last.date}]`
        );
      }
    }
  }

  if (!foundDecrease) {
    console.log("No net price decreases detected across the period.");
  }
}

main().catch(console.error);
