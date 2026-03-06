/**
 * Teams File Inventory V2 — Supplemental
 * Fix: Invoice Processing pagination, find Business/Paid Ads channel folders
 */

import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");

try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch (e) {
  console.error("Could not read .env:", e.message);
}

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function graphGet(endpoint) {
  const token = await getToken();
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

async function getAllPages(endpoint) {
  const items = [];
  let url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE}${endpoint}`;

  while (url) {
    const data = await graphGet(url);
    if (data.value) items.push(...data.value);
    url = data["@odata.nextLink"] || null;
  }
  return items;
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "N/A";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function shortDate(iso) {
  if (!iso) return "N/A";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function main() {
  await getToken();
  console.log("Token acquired.\n");

  // Get team and site
  const teamsRes = await graphGet("/groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id,displayName&$top=50");
  const officeTeam = teamsRes.value.find(t => t.displayName.toLowerCase().includes("office") || t.displayName.toLowerCase().includes("theoffice"));
  console.log("Team:", officeTeam.displayName, officeTeam.id);

  const site = await graphGet(`/groups/${officeTeam.id}/sites/root`);
  console.log("Site:", site.displayName, site.id);

  const drivesRes = await graphGet(`/sites/${site.id}/drives`);
  const primaryDrive = drivesRes.value.find(d => d.name === "Documents" || d.name === "Shared Documents") || drivesRes.value[0];
  console.log("Drive:", primaryDrive.name, primaryDrive.id);

  // --- 1. INVOICE PROCESSING: count all pages ---
  console.log("\n=== Invoice Processing (full count) ===");

  // Get root items to find Invoice Processing folder
  const rootRes = await graphGet(`/sites/${site.id}/drives/${primaryDrive.id}/root/children?$top=100&$orderby=name asc`);
  const rootFolders = rootRes.value.filter(i => i.folder);
  console.log("Root folders:", rootFolders.map(f => f.name).join(", "));

  const invoiceFolder = rootFolders.find(f => f.name.toLowerCase().includes("invoice"));
  if (invoiceFolder) {
    const allInvoiceItems = await getAllPages(
      `/sites/${site.id}/drives/${primaryDrive.id}/items/${invoiceFolder.id}/children?$top=100&$orderby=name asc`
    );
    console.log(`Invoice Processing: ${allInvoiceItems.length} total items`);
    const invoiceFiles = allInvoiceItems.filter(i => !i.folder);
    const invoiceFolders = allInvoiceItems.filter(i => i.folder);
    const totalSize = invoiceFiles.reduce((sum, f) => sum + (f.size || 0), 0);
    console.log(`  Files: ${invoiceFiles.length}, Folders: ${invoiceFolders.length}, Size: ${formatBytes(totalSize)}`);

    // Show any non-PDF/hash-named files
    const interestingFiles = invoiceFiles.filter(f => !f.name.match(/^[a-f0-9]{32}\.pdf$/i));
    console.log(`  Non-hash-named files: ${interestingFiles.length}`);
    interestingFiles.forEach(f => console.log(`    - ${f.name} (${formatBytes(f.size)}) ${shortDate(f.lastModifiedDateTime)}`));
  }

  // --- 2. Look for Business / Paid Ads folders ---
  console.log("\n=== Looking for Business and Paid Ads folders ===");

  // Check if there's a "General" folder or something similar
  console.log("All root items:");
  for (const item of rootRes.value) {
    const type = item.folder ? `[FOLDER, ${item.folder.childCount} items]` : `[FILE, ${formatBytes(item.size)}]`;
    console.log(`  ${item.name} ${type}`);
  }

  // Try to find a "Business" or "General" folder anywhere
  console.log("\nSearching for 'Business' folder...");
  try {
    const bizSearch = await graphGet(`/sites/${site.id}/drive/root/search(q='Business')?$top=10`);
    console.log("Business search results:", bizSearch.value?.map(i => `${i.name} (${i.parentReference?.path})`).join(", "));
  } catch (e) {
    console.log("Search error:", e.message);
  }

  // Check if Business and Paid Ads channels have SharePoint folder tabs
  // They might just be channels without file tabs (or with empty/unlinked folders)
  const channelsRes = await graphGet(`/teams/${officeTeam.id}/channels`);
  console.log("\nAll channels with IDs:");
  for (const ch of channelsRes.value) {
    console.log(`  ${ch.displayName} (${ch.id})`);
    // Try to get the channel's file folder via Graph
    try {
      const filesFolder = await graphGet(`/teams/${officeTeam.id}/channels/${ch.id}/filesFolder`);
      console.log(`    -> SharePoint folder: ${filesFolder.name} (webUrl: ${filesFolder.webUrl})`);
    } catch (e) {
      console.log(`    -> filesFolder error: ${e.message.substring(0, 80)}`);
    }
  }

  // --- 3. Check "Daily Use" folder (found in root but not a channel name) ---
  console.log("\n=== Daily Use folder contents ===");
  const dailyUseFolder = rootFolders.find(f => f.name.toLowerCase().includes("daily use"));
  if (dailyUseFolder) {
    const items = await getAllPages(
      `/sites/${site.id}/drives/${primaryDrive.id}/items/${dailyUseFolder.id}/children?$top=100`
    );
    console.log(`Daily Use: ${items.length} items`);
    items.slice(0, 20).forEach(i => console.log(`  - ${i.name} (${i.folder ? '[folder]' : formatBytes(i.size)})`));
  }

  console.log("\nDone.");
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
