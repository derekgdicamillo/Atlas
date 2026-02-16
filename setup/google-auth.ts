/**
 * Atlas — Google OAuth2 Setup
 *
 * One-time interactive script to authorize Gmail + Calendar access.
 * Run twice: once for Derek's personal account, once for Atlas's account.
 *
 * Usage:
 *   bun run setup/google-auth.ts --account derek
 *   bun run setup/google-auth.ts --account atlas
 *
 * Prerequisites:
 *   1. Create a Google Cloud project at https://console.cloud.google.com
 *   2. Enable Gmail API and Google Calendar API
 *   3. Create OAuth 2.0 credentials (Desktop app type)
 *   4. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env
 */

import { google } from "googleapis";
import { join, dirname } from "path";
import { createInterface } from "readline";
import { createServer, type Server } from "http";

const PROJECT_ROOT = dirname(import.meta.dir);

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

// Load .env manually (same pattern as other setup scripts)
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

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Scopes per account type
const SCOPES = {
  derek: [
    "https://www.googleapis.com/auth/gmail.readonly",   // Read inbox
    "https://www.googleapis.com/auth/gmail.compose",     // Create drafts
    "https://www.googleapis.com/auth/calendar",          // Calendar CRUD + invites
    "https://www.googleapis.com/auth/contacts.readonly", // Lookup contacts by name
    "https://www.googleapis.com/auth/business.manage",   // Google Business Profile
    "https://www.googleapis.com/auth/analytics.readonly", // Google Analytics 4
  ],
  atlas: [
    "https://www.googleapis.com/auth/gmail.readonly",    // Read own inbox
    "https://www.googleapis.com/auth/gmail.compose",     // Create drafts
    "https://www.googleapis.com/auth/gmail.send",        // Send emails
  ],
};

async function main() {
  console.log("");
  console.log(bold("  Atlas — Google OAuth2 Setup"));
  console.log("");

  // Parse --account flag
  const accountArg = process.argv.find((a) => a.startsWith("--account"));
  let account: "derek" | "atlas" | null = null;

  if (accountArg) {
    const parts = accountArg.split("=");
    if (parts.length === 2) {
      account = parts[1] as "derek" | "atlas";
    }
  }
  // Also check positional: --account derek
  const idx = process.argv.indexOf("--account");
  if (idx !== -1 && process.argv[idx + 1]) {
    account = process.argv[idx + 1] as "derek" | "atlas";
  }

  if (!account || !["derek", "atlas"].includes(account)) {
    console.log(`  ${red("Missing --account flag.")}`);
    console.log("");
    console.log("  Usage:");
    console.log(`    ${dim("bun run setup/google-auth.ts --account derek")}  ${dim("(personal Gmail + Calendar)")}`);
    console.log(`    ${dim("bun run setup/google-auth.ts --account atlas")}  ${dim("(Atlas's Gmail, can send)")}`);
    console.log("");
    process.exit(1);
  }

  const env = await loadEnv();
  const clientId = env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "";

  if (!clientId || !clientSecret) {
    console.log(`  ${red("Missing Google OAuth credentials in .env")}`);
    console.log("");
    console.log("  Add these to your .env file first:");
    console.log(`    ${dim("GOOGLE_CLIENT_ID=your_client_id")}`);
    console.log(`    ${dim("GOOGLE_CLIENT_SECRET=your_client_secret")}`);
    console.log("");
    console.log("  To get these:");
    console.log(`    ${dim("1. Go to https://console.cloud.google.com")}`);
    console.log(`    ${dim("2. Create a project (or select existing)")}`);
    console.log(`    ${dim("3. Enable Gmail API and Google Calendar API")}`);
    console.log(`    ${dim("4. Go to Credentials > Create Credentials > OAuth client ID")}`);
    console.log(`    ${dim('5. Choose "Desktop app" as application type')}`);
    console.log(`    ${dim("6. Copy Client ID and Client Secret to .env")}`);
    console.log("");
    process.exit(1);
  }

  const scopes = SCOPES[account];
  const envKey = account === "derek" ? "GOOGLE_REFRESH_TOKEN_DEREK" : "GOOGLE_REFRESH_TOKEN_ATLAS";
  const accountEmail = account === "derek" ? "Derekgdicamillo@gmail.com" : "assistant.ai.atlas@gmail.com";

  console.log(`  Account:  ${bold(account)} (${accountEmail})`);
  console.log(`  Scopes:   ${scopes.map((s) => s.split("/").pop()).join(", ")}`);
  console.log(`  Env key:  ${envKey}`);
  console.log("");

  // Create OAuth2 client with localhost redirect (OOB is deprecated)
  const REDIRECT_PORT = 3847;
  const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    REDIRECT_URI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent", // Force refresh token generation
    redirect_uri: REDIRECT_URI,
  });

  // Wait for the OAuth callback on a temporary local server
  const code = await new Promise<string>((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${REDIRECT_PORT}`);
      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Authorization denied: ${error}</h2><p>You can close this tab.</p></body></html>`);
        server.close();
        reject(new Error(`Authorization denied: ${error}`));
        return;
      }

      if (authCode) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>`);
        server.close();
        resolve(authCode);
        return;
      }

      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing authorization code.");
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`  ${yellow("1.")} Opening this URL in your browser:`);
      console.log("");
      console.log(`  ${dim(authUrl)}`);
      console.log("");
      console.log(`  ${yellow("2.")} Sign in with ${bold(accountEmail)}`);
      console.log(`  ${yellow("3.")} Grant the requested permissions`);
      console.log(`  ${dim("     The browser will redirect back automatically.")}`);
      console.log("");

      // Try to open the URL in the default browser
      if (process.platform === "win32") {
        // On Windows, cmd /c start mangles URLs with & characters.
        // Use PowerShell's Start-Process instead.
        Bun.spawn(["powershell", "-Command", `Start-Process '${authUrl}'`], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } else {
        const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
        Bun.spawn([openCmd, authUrl], { stdout: "ignore", stderr: "ignore" });
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for authorization (5 min). Try again."));
    }, 5 * 60 * 1000);
  });

  try {
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.log(`\n  ${red("No refresh token returned.")}`);
      console.log(`  ${dim("This can happen if the account was already authorized.")}`);
      console.log(`  ${dim("Try revoking access at https://myaccount.google.com/permissions")}`);
      console.log(`  ${dim("then run this script again.")}`);
      process.exit(1);
    }

    console.log(`\n  ${green("Authorization successful!")}`);
    console.log("");
    console.log(`  Add this to your .env file:`);
    console.log("");
    console.log(`  ${bold(`${envKey}=${tokens.refresh_token}`)}`);
    console.log("");

    // Offer to auto-append
    const autoAppend = await prompt("  Append to .env automatically? (y/n): ");
    if (autoAppend.toLowerCase() === "y") {
      const envPath = join(PROJECT_ROOT, ".env");
      const existing = await Bun.file(envPath).text();
      const newLine = `\n${envKey}=${tokens.refresh_token}`;

      if (existing.includes(envKey)) {
        // Replace existing value
        const updated = existing.replace(
          new RegExp(`^${envKey}=.*$`, "m"),
          `${envKey}=${tokens.refresh_token}`
        );
        await Bun.write(envPath, updated);
        console.log(`\n  ${green("Updated")} ${envKey} in .env`);
      } else {
        await Bun.write(envPath, existing + newLine);
        console.log(`\n  ${green("Appended")} ${envKey} to .env`);
      }
    }

    console.log("");
    if (account === "derek") {
      console.log(`  ${dim("Next: run with --account atlas to set up Atlas's Gmail")}`);
    } else {
      console.log(`  ${dim("Done! Both accounts are configured.")}`);
      console.log(`  ${dim("Restart Atlas to pick up the new tokens.")}`);
    }
    console.log("");
  } catch (err: any) {
    console.log(`\n  ${red("Token exchange failed:")} ${err.message}`);
    console.log(`  ${dim("Make sure you copied the full authorization code.")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
