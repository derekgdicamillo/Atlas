import { readFile } from "fs/promises";
import XLSX from "xlsx";

const buffer = await readFile(
  String.raw`C:\Users\Derek DiCamillo\.claude-relay\uploads\0e1f6d7398ffbaac6648e1d8_new_membership_overview_050326121959cb36335ddc4092bd5ad47067`
);

const workbook = XLSX.read(buffer, { type: "buffer" });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(sheet);

console.log("MEMBERSHIP OVERVIEW - ANALYSIS\n");
console.log(`Total Records: ${data.length}\n`);

// Analyze by membership type
const byType = {};
const byStatus = {};
const byLoyalty = {};

data.forEach((row) => {
  const type = row["Membership Name"] || "Unlisted";
  const status = row.Status || "Unknown";
  const loyalty = row["Length of Loyalty"] || "N/A";

  byType[type] = (byType[type] || 0) + 1;
  byStatus[status] = (byStatus[status] || 0) + 1;
  byLoyalty[loyalty] = (byLoyalty[loyalty] || 0) + 1;
});

console.log("TOP MEMBERSHIP PROGRAMS:");
Object.entries(byType)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
  .forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });

console.log("\nSTATUS:");
Object.entries(byStatus).forEach(([status, count]) => {
  console.log(`  ${status || "(blank)"}: ${count}`);
});

console.log("\nLOYALTY BREAKDOWN:");
Object.entries(byLoyalty)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .forEach(([loyalty, count]) => {
    console.log(`  ${loyalty || "(blank)"}: ${count}`);
  });

// Clinic breakdown
const byClinic = {};
data.forEach((row) => {
  const clinic = row.Clinic || "Unassigned";
  byClinic[clinic] = (byClinic[clinic] || 0) + 1;
});

console.log("\nBY CLINIC:");
Object.entries(byClinic).forEach(([clinic, count]) => {
  console.log(`  ${clinic}: ${count}`);
});

// Upcoming appointments
const upcomingCount = data.filter(
  (row) => row["Next Appointment"]
).length;
console.log(`\nScheduled for Next Appointment: ${upcomingCount}`);

// Active vs inactive
const active = byStatus["active"] || 0;
const hold = byStatus["hold"] || 0;
const other = data.length - active - hold;

console.log("\n--- KEY METRICS ---");
console.log(`Active: ${active} (${((active/data.length)*100).toFixed(1)}%)`);
console.log(`On Hold: ${hold} (${((hold/data.length)*100).toFixed(1)}%)`);
console.log(`Other: ${other} (${((other/data.length)*100).toFixed(1)}%)`);
