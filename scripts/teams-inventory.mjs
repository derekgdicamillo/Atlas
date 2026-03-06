/**
 * Teams File Inventory Script
 * Queries Microsoft Graph API to inventory all files in TheOffice Teams SharePoint
 * Writes output to teams-file-inventory.md
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load .env manually
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

if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
  const msg = `# Teams File Inventory\n\n**Error:** Azure credentials not configured. Missing AZURE_TENANT_ID, AZURE_CLIENT_ID, or AZURE_CLIENT_SECRET in .env.\n`;
  writeFileSync(join(__dirname, "..", "teams-file-inventory.md"), msg);
  console.error("Azure credentials missing");
  process.exit(1);
}

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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed ${res.status}: ${text.substring(0, 300)}`);
  }

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
    throw new Error(`Graph ${endpoint.substring(0, 60)} => ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
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

function fileType(item) {
  if (item.folder) return "Folder";
  const mime = item.file?.mimeType || "";
  if (mime.includes("word") || item.name.endsWith(".docx") || item.name.endsWith(".doc")) return "Word";
  if (mime.includes("excel") || item.name.endsWith(".xlsx") || item.name.endsWith(".xls")) return "Excel";
  if (mime.includes("powerpoint") || item.name.endsWith(".pptx") || item.name.endsWith(".ppt")) return "PowerPoint";
  if (mime.includes("pdf") || item.name.endsWith(".pdf")) return "PDF";
  if (mime.includes("image") || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(item.name)) return "Image";
  if (mime.includes("video") || /\.(mp4|mov|avi|mkv)$/i.test(item.name)) return "Video";
  if (mime.includes("audio") || /\.(mp3|wav|m4a)$/i.test(item.name)) return "Audio";
  if (item.name.endsWith(".txt")) return "Text";
  if (item.name.endsWith(".csv")) return "CSV";
  if (item.name.endsWith(".zip")) return "ZIP";
  const ext = item.name.split(".").pop() || "";
  return ext ? ext.toUpperCase() : "File";
}

// Generic names to flag
const GENERIC_NAMES = /^(document\d*|doc\d*|file\d*|new\s*document|untitled|copy of|draft\d*|test\d*)$/i;

function isGenericName(name) {
  const nameWithoutExt = name.replace(/\.[^.]+$/, "");
  return GENERIC_NAMES.test(nameWithoutExt.trim());
}

async function getAllChildren(siteId, driveId, folderId, depth = 0) {
  const endpoint = folderId
    ? `/sites/${siteId}/drives/${driveId}/items/${folderId}/children?$top=100&$orderby=name asc`
    : `/sites/${siteId}/drives/${driveId}/root/children?$top=100&$orderby=name asc`;

  const res = await graphGet(endpoint);
  const items = res.value || [];

  // Recursively get folder children (max 2 levels deep)
  const result = [];
  for (const item of items) {
    result.push({ ...item, _depth: depth });
    if (item.folder && depth < 2) {
      try {
        const children = await getAllChildren(siteId, driveId, item.id, depth + 1);
        result.push(...children);
      } catch (e) {
        console.warn(`  Could not list folder ${item.name}: ${e.message}`);
      }
    }
  }
  return result;
}

async function main() {
  const lines = [];
  const issues = [];
  const stats = { channels: 0, totalFiles: 0, totalFolders: 0, totalSize: 0 };

  console.log("Getting access token...");
  try {
    await getToken();
    console.log("Token acquired.");
  } catch (e) {
    const msg = `# Teams File Inventory\n\n**Error getting access token:** ${e.message}\n`;
    writeFileSync(join(__dirname, "..", "teams-file-inventory.md"), msg);
    console.error("Auth failed:", e.message);
    process.exit(1);
  }

  // Step 1: Find TheOffice team
  console.log("Listing teams...");
  const teamsRes = await graphGet("/groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id,displayName,description&$top=50");
  const teams = teamsRes.value || [];
  console.log(`Found ${teams.length} teams:`, teams.map(t => t.displayName).join(", "));

  const officeTeam = teams.find(t => t.displayName.toLowerCase().includes("office") || t.displayName.toLowerCase().includes("theoffice"));
  if (!officeTeam) {
    const msg = `# Teams File Inventory\n\n**Error:** Could not find "TheOffice" team.\n\nAvailable teams:\n${teams.map(t => `- ${t.displayName}`).join("\n")}\n`;
    writeFileSync(join(__dirname, "..", "teams-file-inventory.md"), msg);
    console.error("TheOffice team not found");
    process.exit(1);
  }

  console.log(`Found team: ${officeTeam.displayName} (${officeTeam.id})`);

  // Step 2: Get the SharePoint site for this team
  console.log("Getting team SharePoint site...");
  let site;
  try {
    site = await graphGet(`/groups/${officeTeam.id}/sites/root`);
  } catch (e) {
    // Try via team
    try {
      site = await graphGet(`/teams/${officeTeam.id}/primaryChannel`);
    } catch (e2) {
      const msg = `# Teams File Inventory\n\n**Error getting SharePoint site:** ${e.message}\n`;
      writeFileSync(join(__dirname, "..", "teams-file-inventory.md"), msg);
      process.exit(1);
    }
  }

  console.log(`Site: ${site.displayName || site.name} (${site.id})`);
  console.log(`Site URL: ${site.webUrl}`);

  // Step 3: Get document libraries (drives)
  console.log("Listing drives...");
  const drivesRes = await graphGet(`/sites/${site.id}/drives`);
  const drives = drivesRes.value || [];
  console.log(`Found ${drives.length} drives:`, drives.map(d => d.name).join(", "));

  // Step 4: Get channels
  console.log("Listing channels...");
  const channelsRes = await graphGet(`/teams/${officeTeam.id}/channels`);
  const channels = channelsRes.value || [];
  console.log(`Found ${channels.length} channels:`, channels.map(c => c.displayName).join(", "));

  // The target channels to inventory
  const targetChannels = [
    "Business",
    "Daily Resources",
    "Derek FNP Applications",
    "Invoice Processing",
    "Marketing",
    "Paid Ads",
    "Patient Guides and Resources",
    "Policy and Procedures",
    "Vitality Unchained Course",
  ];

  lines.push("# TheOffice Teams — SharePoint File Inventory");
  lines.push(`\n*Generated: ${new Date().toLocaleString("en-US", { timeZone: "America/Phoenix" })} MST*`);
  lines.push(`*Team: ${officeTeam.displayName}*`);
  lines.push(`*SharePoint Site: ${site.webUrl}*`);
  lines.push(`*Drives found: ${drives.map(d => d.name).join(", ")}*`);
  lines.push("\n---\n");

  // Step 5: For each channel, find its folder in the document library
  // In Teams/SharePoint, each channel has a corresponding folder in the "Documents" library
  // Usually in the root drive under a folder named after the channel

  const primaryDrive = drives.find(d => d.name === "Documents" || d.name === "Shared Documents") || drives[0];

  if (!primaryDrive) {
    lines.push("**Error:** No document library found in the team site.");
    writeFileSync(join(__dirname, "..", "teams-file-inventory.md"), lines.join("\n"));
    process.exit(1);
  }

  console.log(`Using drive: ${primaryDrive.name} (${primaryDrive.id})`);

  // Get root-level folders (should correspond to channels)
  console.log("Getting root drive contents...");
  const rootItems = await getAllChildren(site.id, primaryDrive.id, null, 0);
  const rootFolders = rootItems.filter(item => item.folder && item._depth === 0);
  console.log("Root folders:", rootFolders.map(f => f.name).join(", "));

  // Process each target channel
  for (const channelName of targetChannels) {
    stats.channels++;
    lines.push(`## ${channelName}`);

    // Find matching folder (Teams creates folders with channel name)
    const folder = rootFolders.find(f =>
      f.name.toLowerCase() === channelName.toLowerCase() ||
      f.name.toLowerCase().replace(/\s+/g, "-") === channelName.toLowerCase().replace(/\s+/g, "-") ||
      f.name.toLowerCase().includes(channelName.toLowerCase().substring(0, 10))
    );

    if (!folder) {
      lines.push(`\n*No SharePoint folder found for this channel. (Available folders: ${rootFolders.map(f => f.name).join(", ")})*\n`);
      issues.push(`**${channelName}**: No matching SharePoint folder found.`);
      continue;
    }

    lines.push(`\n*Folder: ${folder.name} | Items: ${folder.folder?.childCount ?? "?"} | Modified: ${shortDate(folder.lastModifiedDateTime)}*`);

    // Get all items in this channel's folder
    let items = [];
    try {
      items = await getAllChildren(site.id, primaryDrive.id, folder.id, 0);
    } catch (e) {
      lines.push(`\n*Error listing files: ${e.message}*\n`);
      issues.push(`**${channelName}**: Error listing files — ${e.message}`);
      continue;
    }

    const files = items.filter(i => !i.folder);
    const subfolders = items.filter(i => i.folder);

    if (items.length === 0) {
      lines.push(`\n*Empty — no files or folders.*\n`);
      issues.push(`**${channelName}**: Empty folder.`);
      continue;
    }

    // Table header
    lines.push(`\n| Filename | Type | Size | Last Modified | Modified By | Notes |`);
    lines.push(`|----------|------|------|---------------|-------------|-------|`);

    const channelNames = new Map(); // track filenames for duplicate detection
    let channelSize = 0;

    for (const item of items) {
      const indent = item._depth > 0 ? `${"&nbsp;&nbsp;&nbsp;&nbsp;".repeat(item._depth)}↳ ` : "";
      const name = item.folder ? `📁 ${indent}${item.name}/` : `${indent}${item.name}`;
      const type = fileType(item);
      const size = item.folder ? `${item.folder.childCount} items` : formatBytes(item.size);
      const modified = shortDate(item.lastModifiedDateTime);
      const modifiedBy = item.lastModifiedBy?.user?.displayName || "N/A";

      const noteFlags = [];

      // Check for generic names
      if (!item.folder && isGenericName(item.name)) {
        noteFlags.push("⚠️ Generic name");
        issues.push(`**${channelName}**: Generic filename — "${item.name}"`);
      }

      // Track duplicates (by name without extension)
      if (!item.folder) {
        const key = item.name.toLowerCase();
        if (channelNames.has(key)) {
          noteFlags.push("⚠️ Duplicate");
          issues.push(`**${channelName}**: Duplicate file — "${item.name}"`);
        } else {
          channelNames.set(key, true);
        }
      }

      // Empty subfolder
      if (item.folder && item.folder.childCount === 0) {
        noteFlags.push("⚠️ Empty folder");
        issues.push(`**${channelName}**: Empty subfolder — "${item.name}/"`);
      }

      // Very old files (older than 2 years)
      if (item.lastModifiedDateTime) {
        const age = Date.now() - new Date(item.lastModifiedDateTime).getTime();
        const years = age / (1000 * 60 * 60 * 24 * 365);
        if (years > 2) {
          noteFlags.push("📅 Old (2+ yrs)");
        }
      }

      if (item.size) channelSize += item.size;

      const notes = noteFlags.join(", ") || "—";
      lines.push(`| ${name} | ${type} | ${size} | ${modified} | ${modifiedBy} | ${notes} |`);

      if (!item.folder) stats.totalFiles++;
      else stats.totalFolders++;
      if (item.size) stats.totalSize += item.size;
    }

    lines.push(`\n**Channel total:** ${files.length} files, ${subfolders.length} subfolders, ${formatBytes(channelSize)}\n`);
  }

  // Also check for any root-level files not in a channel folder
  const rootFiles = rootItems.filter(i => !i.folder && i._depth === 0);
  if (rootFiles.length > 0) {
    lines.push(`## ⚠️ Files in Library Root (Not in a Channel Folder)`);
    lines.push(`\n| Filename | Type | Size | Last Modified |`);
    lines.push(`|----------|------|------|---------------|`);
    for (const item of rootFiles) {
      lines.push(`| ${item.name} | ${fileType(item)} | ${formatBytes(item.size)} | ${shortDate(item.lastModifiedDateTime)} |`);
      issues.push(`Root-level file (not in any channel folder): "${item.name}"`);
    }
    lines.push("");
  }

  // Summary section
  lines.push("---\n");
  lines.push("## Summary\n");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Channels inventoried | ${stats.channels} |`);
  lines.push(`| Total files | ${stats.totalFiles} |`);
  lines.push(`| Total folders | ${stats.totalFolders} |`);
  lines.push(`| Total storage | ${formatBytes(stats.totalSize)} |`);
  lines.push(`| Issues found | ${issues.length} |`);
  lines.push("");

  if (issues.length > 0) {
    lines.push("## Cleanup Recommendations\n");
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  } else {
    lines.push("## Cleanup Recommendations\n");
    lines.push("No major issues detected.\n");
  }

  lines.push("---");
  lines.push(`*Inventory script: \`scripts/teams-inventory.mjs\` | Atlas background research agent*`);

  const output = lines.join("\n");
  const outPath = join(__dirname, "..", "teams-file-inventory.md");
  writeFileSync(outPath, output);
  console.log(`\nInventory written to: ${outPath}`);
  console.log(`Total: ${stats.totalFiles} files, ${stats.totalFolders} folders, ${formatBytes(stats.totalSize)}, ${issues.length} issues`);
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  const { writeFileSync } = await import("fs");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const msg = `# Teams File Inventory\n\n**Error:** ${err.message}\n\nStack:\n\`\`\`\n${err.stack}\n\`\`\`\n`;
  writeFileSync(join(__dirname, "..", "teams-file-inventory.md"), msg);
  process.exit(1);
});
