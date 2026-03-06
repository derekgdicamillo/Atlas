/**
 * Quick script to pull Byron's "CCM STUFF" folder from Google Drive
 * and save contents locally for analysis.
 */
import { initGoogle, findAndListFolder, downloadDriveFile, listDriveFolder } from "../src/google.ts";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// Load env
const envPath = join(import.meta.dirname || ".", "..", ".env");
const envFile = Bun.file(envPath);
if (await envFile.exists()) {
  const text = await envFile.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

const ok = initGoogle();
if (!ok) {
  console.error("Google init failed. Check .env for GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN_DEREK");
  process.exit(1);
}

console.log("Google initialized. Searching for CCM STUFF folder...");

const result = await findAndListFolder("CCM STUFF");
if (!result) {
  console.error("Could not find 'CCM STUFF' folder. It may not be shared yet or the name is different.");
  process.exit(1);
}

console.log(`Found folder with ${result.files.length} files:`);

const outDir = join(import.meta.dirname || ".", "..", "data", "ccm-stuff");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// Save file listing
const listing = result.files.map((f) => `- ${f.name} (${f.mimeType}) ${f.size ? `[${f.size} bytes]` : ""}`).join("\n");
writeFileSync(join(outDir, "_index.md"), `# CCM STUFF - Google Drive Contents\n\nFolder ID: ${result.folderId}\nPulled: ${new Date().toISOString()}\n\n${listing}\n`);
console.log(listing);

// Download each file
for (const file of result.files) {
  console.log(`\nDownloading: ${file.name} (${file.mimeType})...`);

  // If it's a subfolder, list its contents too
  if (file.mimeType === "application/vnd.google-apps.folder") {
    console.log(`  -> Subfolder, listing contents...`);
    const subFiles = await listDriveFolder(file.id);
    const subDir = join(outDir, file.name.replace(/[<>:"/\\|?*]/g, "_"));
    if (!existsSync(subDir)) mkdirSync(subDir, { recursive: true });

    for (const sub of subFiles) {
      console.log(`  - ${sub.name} (${sub.mimeType})`);
      const content = await downloadDriveFile(sub.id, sub.mimeType);
      if (content) {
        const ext = sub.mimeType.includes("spreadsheet") ? ".csv" : ".txt";
        const safeName = sub.name.replace(/[<>:"/\\|?*]/g, "_");
        writeFileSync(join(subDir, safeName + ext), content);
        console.log(`    -> Saved to ${safeName}${ext}`);
      }
    }
    continue;
  }

  const content = await downloadDriveFile(file.id, file.mimeType);
  if (content) {
    const ext = file.mimeType.includes("spreadsheet") ? ".csv" :
                file.mimeType.includes("document") ? ".txt" :
                file.mimeType.includes("presentation") ? ".txt" : ".txt";
    const safeName = file.name.replace(/[<>:"/\\|?*]/g, "_");
    writeFileSync(join(outDir, safeName + ext), content);
    console.log(`  -> Saved to ${safeName}${ext}`);
  } else {
    console.log(`  -> Could not download (binary or unsupported format)`);
  }
}

console.log(`\nDone! Files saved to: ${outDir}`);
