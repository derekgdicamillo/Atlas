import { readFileSync } from "fs";
import { join } from "path";

const PROJECT_DIR = process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const TIMEZONE = "America/Phoenix";

function getWeekDates(): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toLocaleDateString("en-CA", { timeZone: TIMEZONE }));
  }
  return dates;
}

console.log("=== DEBUGGING STRATEGIC MEMO DATA AGGREGATION ===\n");

const weekDates = getWeekDates();
console.log("Week dates (getWeekDates()):", weekDates);
console.log("Week dates as Set:", new Set(weekDates));

// Load ad-tracker.json
const trackerPath = join(DATA_DIR, "ad-tracker.json");
const tracker = JSON.parse(readFileSync(trackerPath, "utf-8"));
const snaps = tracker.snapshots || [];
console.log(`\nTotal snapshots in ad-tracker.json: ${snaps.length}`);

// Find snapshots in the week date range
const weekSnaps = snaps.filter((s: any) => weekDates.includes(s.date));
console.log(`Snapshots matching week dates: ${weekSnaps.length}`);

if (weekSnaps.length > 0) {
  console.log("\nFirst few matching snapshots:");
  weekSnaps.slice(0, 3).forEach((s: any) => {
    console.log(`  Date: ${s.date}, Spend: ${s.spend}, Conversions: ${s.conversions}`);
  });
}

const totalSpend = weekSnaps.reduce((sum: number, s: any) => sum + (s.spend || 0), 0);
const totalConversions = weekSnaps.reduce((sum: number, s: any) => sum + (s.conversions || 0), 0);
const weekCPL = totalConversions > 0 ? totalSpend / totalConversions : 0;

console.log(`\nAggregated results:`);
console.log(`  Total spend (7d): $${totalSpend.toFixed(2)}`);
console.log(`  Total conversions (7d): ${totalConversions}`);
console.log(`  CPL: ${weekCPL > 0 ? "$" + weekCPL.toFixed(2) : "no conversions"}`);

// Also check yesterday
const dates = getWeekDates();
const yesterday = dates[dates.length - 2];
const yesterdaySnaps = snaps.filter((s: any) => s.date === yesterday);
const yesterdaySpend = yesterdaySnaps.reduce((sum: number, s: any) => sum + (s.spend || 0), 0);
const yesterdayConversions = yesterdaySnaps.reduce((sum: number, s: any) => sum + (s.conversions || 0), 0);

console.log(`\nYesterday (${yesterday}):`);
console.log(`  Snapshots: ${yesterdaySnaps.length}`);
console.log(`  Spend: $${yesterdaySpend.toFixed(2)}`);
console.log(`  Conversions: ${yesterdayConversions}`);

// Load lead-volume.json
const leadPath = join(DATA_DIR, "lead-volume.json");
const leadData = JSON.parse(readFileSync(leadPath, "utf-8"));
const days = leadData.days || leadData || [];
console.log(`\nLead volume data:`);
console.log(`Total days in lead-volume.json: ${days.length}`);

const weekDatesSet = new Set(weekDates);
const weekDays = days.filter((d: any) => weekDatesSet.has(d.date));
console.log(`Days matching week dates: ${weekDays.length}`);

if (weekDays.length > 0) {
  console.log("\nMatching lead days:");
  weekDays.forEach((d: any) => {
    console.log(`  Date: ${d.date}, Count: ${d.count}`);
  });
}

const totalLeads = weekDays.reduce((sum: number, d: any) => sum + (d.total || d.count || 0), 0);
const avgLeads = weekDays.length > 0 ? totalLeads / weekDays.length : 0;

console.log(`\nLead aggregation:`);
console.log(`  Total leads (7d): ${totalLeads}`);
console.log(`  Average leads/day: ${avgLeads.toFixed(1)}`);

// Check all unique dates in ad-tracker
console.log("\n=== ALL UNIQUE DATES IN AD-TRACKER.JSON ===");
const uniqueDates = Array.from(new Set(snaps.map((s: any) => s.date))).sort();
console.log(`Unique dates: ${uniqueDates.length}`);
console.log("Recent dates:", uniqueDates.slice(-10));
