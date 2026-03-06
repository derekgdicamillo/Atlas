/**
 * Parse Byron's CCM STUFF files (xlsx, docx, pdf) into readable text.
 * Uses xlsx, mammoth, and pdf-parse libraries.
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, extname } from "path";
import XLSX from "xlsx";
import mammoth from "mammoth";
// pdf-parse has ESM issues, use dynamic require
const pdf = require("pdf-parse");

const ccmDir = join(import.meta.dirname || ".", "..", "data", "ccm-stuff");
const files = readdirSync(ccmDir).filter(f => !f.startsWith("_") && !f.endsWith(".txt") && !f.endsWith(".csv") && !f.endsWith(".md"));

// Get original files by looking at the index
const indexContent = readFileSync(join(ccmDir, "_index.md"), "utf-8");
const originalFiles = indexContent.match(/^- (.+?) \(/gm)?.map(m => m.replace(/^- /, "").replace(/ \($/, "")) || [];

console.log(`Found ${originalFiles.length} original files to parse.\n`);

for (const fileName of originalFiles) {
  const ext = extname(fileName).toLowerCase();
  const safeName = fileName.replace(/[<>:"/\\|?*]/g, "_");

  // Check if we already have a good parse
  const existingTxt = join(ccmDir, safeName + ".txt");
  const existingCsv = join(ccmDir, safeName + ".csv");

  console.log(`Processing: ${fileName} (${ext})`);

  // We need to download the raw file from Drive first
  // The pull script saved markers, not actual content
  // Let's use the Drive API to get raw bytes
}

// Actually, we need to re-download with raw bytes
// Let me use the googleapis directly

import { google } from "googleapis";

const envPath = join(import.meta.dirname || ".", "..", ".env");
const envFile = Bun.file(envPath);
const text = await envFile.text();
const env: Record<string, string> = {};
for (const line of text.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx > 0) {
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[trimmed.slice(0, eqIdx).trim()] = val;
  }
}

const auth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
auth.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN_DEREK });
const drive = google.drive({ version: "v3", auth });

// Get folder contents
const folderRes = await drive.files.list({
  q: "name = 'CCM STUFF' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
  fields: "files(id)",
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
});
const folderId = folderRes.data.files?.[0]?.id;
if (!folderId) { console.error("Folder not found"); process.exit(1); }

const filesRes = await drive.files.list({
  q: `'${folderId}' in parents and trashed = false`,
  fields: "files(id,name,mimeType,size)",
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
});

const driveFiles = filesRes.data.files || [];
console.log(`\nFound ${driveFiles.length} files in Drive. Downloading and parsing...\n`);

for (const file of driveFiles) {
  const name = file.name || "unknown";
  const mimeType = file.mimeType || "";
  const safeName = name.replace(/[<>:"/\\|?*]/g, "_");
  const ext = extname(name).toLowerCase();

  console.log(`\n=== ${name} (${mimeType}) ===`);

  try {
    // Download raw bytes
    const downloadRes = await drive.files.get({
      fileId: file.id!,
      alt: "media",
    }, { responseType: "arraybuffer" });

    const buffer = Buffer.from(downloadRes.data as ArrayBuffer);

    if (ext === ".xlsx" || ext === ".xls") {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      let allText = "";
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        allText += `\n--- Sheet: ${sheetName} ---\n${csv}\n`;
      }
      writeFileSync(join(ccmDir, safeName + ".parsed.txt"), allText.trim());
      console.log(`  -> Parsed ${workbook.SheetNames.length} sheets`);

    } else if (ext === ".docx" || ext === ".doc") {
      const result = await mammoth.extractRawText({ buffer });
      writeFileSync(join(ccmDir, safeName + ".parsed.txt"), result.value);
      console.log(`  -> Extracted ${result.value.length} chars of text`);

    } else if (ext === ".pptx") {
      // mammoth doesn't do pptx, try xlsx for basic extraction
      try {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        let allText = "";
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(sheet);
          if (csv.trim()) allText += `\n--- Slide/Sheet: ${sheetName} ---\n${csv}\n`;
        }
        if (allText.trim()) {
          writeFileSync(join(ccmDir, safeName + ".parsed.txt"), allText.trim());
          console.log(`  -> Extracted text from slides`);
        } else {
          console.log(`  -> No extractable text (likely images/graphics)`);
        }
      } catch {
        console.log(`  -> Could not parse PPTX`);
      }

    } else if (ext === ".pdf") {
      const data = await pdf(buffer);
      writeFileSync(join(ccmDir, safeName + ".parsed.txt"), data.text);
      console.log(`  -> Extracted ${data.text.length} chars, ${data.numpages} pages`);

    } else {
      console.log(`  -> Skipping (unsupported format)`);
    }

  } catch (err: any) {
    console.error(`  -> Error: ${err.message?.substring(0, 200)}`);
  }
}

console.log("\n\nDone! Parsed files saved with .parsed.txt extension.");
