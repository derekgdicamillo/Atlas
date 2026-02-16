/**
 * Atlas — Discover Google Business Profile & GA4 IDs
 *
 * Uses Derek's existing OAuth2 credentials to find:
 *   1. GBP Account ID + Location ID
 *   2. GA4 Property ID
 *
 * Usage: bun run setup/discover-google-ids.ts
 *
 * Outputs the env vars you need to add to .env
 */

import { google } from "googleapis";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

// Load .env manually
async function loadEnv(): Promise<Record<string, string>> {
  const envPath = join(PROJECT_ROOT, ".env");
  try {
    const content = await Bun.file(envPath).text();
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

async function main() {
  console.log("");
  console.log(bold("  Atlas — Discover Google Business Profile & GA4 IDs"));
  console.log("");

  const env = await loadEnv();
  const clientId = env.GOOGLE_CLIENT_ID || "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET || "";
  const derekToken = env.GOOGLE_REFRESH_TOKEN_DEREK || "";

  if (!clientId || !clientSecret || !derekToken) {
    console.log("  Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN_DEREK in .env");
    process.exit(1);
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: derekToken });

  // ── Google Business Profile ──

  console.log(bold("  Google Business Profile:"));
  console.log("");

  try {
    // Try Account Management API first
    const mgmt = google.mybusinessaccountmanagement({ version: "v1", auth });
    const accountsRes = await mgmt.accounts.list();
    const accounts = accountsRes.data.accounts || [];

    if (accounts.length === 0) {
      console.log(yellow("  No GBP accounts found. Make sure the Google account has a Business Profile."));
    } else {
      for (const acct of accounts) {
        const accountId = acct.name?.replace("accounts/", "") || "";
        console.log(`  ${green("Account:")} ${acct.accountName} (ID: ${accountId})`);
        console.log(`    Type: ${acct.type}, Role: ${acct.role}`);

        // List locations for this account
        try {
          const bizInfo = google.mybusinessbusinessinformation({ version: "v1", auth });
          const locationsRes = await bizInfo.accounts.locations.list({
            parent: acct.name || "",
            readMask: "name,title,storefrontAddress",
          });

          const locations = locationsRes.data.locations || [];
          for (const loc of locations) {
            const locationId = loc.name?.replace(`${acct.name}/locations/`, "").replace("locations/", "") || "";
            const addr = loc.storefrontAddress;
            const addrStr = addr
              ? [addr.addressLines?.join(", "), addr.locality, addr.administrativeArea].filter(Boolean).join(", ")
              : "No address";
            console.log(`    ${green("Location:")} ${loc.title} (ID: ${locationId})`);
            console.log(`      Address: ${addrStr}`);
          }

          if (locations.length === 0) {
            console.log(yellow("    No locations found for this account."));
          }
        } catch (err: any) {
          console.log(yellow(`    Could not list locations: ${err.message?.substring(0, 100)}`));
        }
      }
    }
  } catch (err: any) {
    const msg = err.message || "";
    const code = err.code || err.status || 0;
    if (msg.includes("insufficient") || code === 403) {
      console.log(yellow("  GBP access requires business.manage scope."));
      console.log(dim("  Re-run: bun run setup/google-auth.ts --account derek"));
      console.log(dim("  (The updated script now includes business.manage scope)"));
    } else if (msg.includes("not been used") || msg.includes("not enabled") || code === 403) {
      console.log(yellow(`  API not enabled. Enable these in Google Cloud Console:`));
      console.log(dim("  - My Business Account Management API"));
      console.log(dim("  - My Business Business Information API"));
      console.log(dim("  - Business Profile Performance API"));
    }
    console.log(dim(`  Raw error: [${code}] ${msg.substring(0, 300)}`));
  }

  console.log("");

  // ── Google Analytics 4 ──

  console.log(bold("  Google Analytics 4:"));
  console.log("");

  try {
    const admin = google.analyticsadmin({ version: "v1beta", auth });

    // First list accounts
    const accountsRes = await admin.accounts.list();
    const gaAccounts = accountsRes.data.accounts || [];

    if (gaAccounts.length === 0) {
      console.log(yellow("  No GA4 accounts found."));
    } else {
      let foundProperties = false;
      for (const acct of gaAccounts) {
        console.log(`  ${green("Account:")} ${acct.displayName} (${acct.name})`);

        // List properties for this account
        try {
          const propsRes = await admin.properties.list({
            filter: `parent:${acct.name}`,
            showDeleted: false,
          });

          const properties = propsRes.data.properties || [];
          for (const prop of properties) {
            foundProperties = true;
            const propertyId = prop.name?.replace("properties/", "") || "";
            console.log(`    ${green("Property:")} ${prop.displayName} (ID: ${propertyId})`);
            console.log(`      Time zone: ${prop.timeZone}, Currency: ${prop.currencyCode}`);
            console.log(`      Industry: ${prop.industryCategory || "Not set"}`);
          }

          if (properties.length === 0) {
            console.log(dim("    No properties under this account."));
          }
        } catch (propErr: any) {
          console.log(dim(`    Could not list properties: ${propErr.message?.substring(0, 100)}`));
        }
      }

      if (!foundProperties) {
        console.log(yellow("  No GA4 properties found across any account."));
      }
    }
  } catch (err: any) {
    const msg = err.message || "";
    const code = err.code || err.status || 0;
    if (msg.includes("insufficient") || code === 403) {
      console.log(yellow("  GA4 access requires analytics.readonly scope."));
      console.log(dim("  Re-run: bun run setup/google-auth.ts --account derek"));
    } else if (msg.includes("not been used") || msg.includes("not enabled")) {
      console.log(yellow("  API not enabled. Enable these in Google Cloud Console:"));
      console.log(dim("  - Google Analytics Admin API"));
      console.log(dim("  - Google Analytics Data API"));
    }
    console.log(dim(`  Raw error: [${code}] ${msg.substring(0, 300)}`));
  }

  console.log("");
  console.log(bold("  Next steps:"));
  console.log(dim("  1. If you see 'scope' errors, re-run: bun run setup/google-auth.ts --account derek"));
  console.log(dim("  2. Add the IDs to .env:"));
  console.log(dim("     GBP_ACCOUNT_ID=<account id from above>"));
  console.log(dim("     GBP_LOCATION_ID=<location id from above>"));
  console.log(dim("     GA4_PROPERTY_ID=<property id from above>"));
  console.log(dim("  3. Restart Atlas: pm2 restart atlas"));
  console.log("");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
