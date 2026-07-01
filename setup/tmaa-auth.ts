/**
 * Atlas — TMAA Google OAuth2 Re-Authorization
 *
 * One-time interactive script to re-authorize the TMAA Google Suite.
 * Uses the TMAA-specific GCP project (iconic-smoke-491800-d6).
 *
 * Usage:
 *   bun run setup/tmaa-auth.ts --account theoffice
 *   bun run setup/tmaa-auth.ts --account derek
 *
 * Prerequisites:
 *   TMAA_GOOGLE_CLIENT_ID and TMAA_GOOGLE_CLIENT_SECRET must be in .env
 *   (These are from the TMAA GCP project, NOT the PV MediSpa project)
 *
 * GCP Console: https://console.cloud.google.com/apis/credentials?project=iconic-smoke-491800-d6
 */

import { google } from "googleapis";
import { join, dirname } from "path";
import { createInterface } from "readline";
import { createServer, type Server } from "http";

const PROJECT_ROOT = dirname(import.meta.dir);

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

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

const ACCOUNTS = {
  theoffice: {
    email: "theoffice@medicalaestheticsassociation.com",
    envKey: "TMAA_GOOGLE_REFRESH_TOKEN_THEOFFICE",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  },
  derek: {
    email: "derekgdicamillo@gmail.com",
    envKey: "TMAA_GOOGLE_REFRESH_TOKEN_DEREK",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/calendar",
    ],
  },
};

async function main() {
  console.log("");
  console.log(bold("  Atlas — TMAA Google OAuth2 Re-Authorization"));
  console.log(dim("  GCP Project: iconic-smoke-491800-d6"));
  console.log("");

  const idx = process.argv.indexOf("--account");
  const account = (idx !== -1 && process.argv[idx + 1]) ? process.argv[idx + 1] as "theoffice" | "derek" : null;

  if (!account || !Object.keys(ACCOUNTS).includes(account)) {
    console.log(`  ${red("Missing or invalid --account flag.")}`);
    console.log("");
    console.log("  Usage:");
    console.log(`    ${dim("bun run setup/tmaa-auth.ts --account theoffice")}  ${dim("(primary — email + calendar + drive)")}`);
    console.log(`    ${dim("bun run setup/tmaa-auth.ts --account derek")}      ${dim("(secondary — read + calendar)")}`);
    console.log("");
    console.log(`  ${yellow("Start with --account theoffice (primary account that's broken).")}`);
    console.log("");
    process.exit(1);
  }

  const env = await loadEnv();
  const clientId = env.TMAA_GOOGLE_CLIENT_ID || process.env.TMAA_GOOGLE_CLIENT_ID || "";
  const clientSecret = env.TMAA_GOOGLE_CLIENT_SECRET || process.env.TMAA_GOOGLE_CLIENT_SECRET || "";

  if (!clientId || !clientSecret) {
    console.log(`  ${red("Missing TMAA Google OAuth credentials in .env")}`);
    console.log("");
    console.log("  These are DIFFERENT from the PV MediSpa Google credentials.");
    console.log("  Find them in the TMAA GCP project:");
    console.log("");
    console.log(`  ${dim("1. Go to: https://console.cloud.google.com/apis/credentials?project=iconic-smoke-491800-d6")}`);
    console.log(`  ${dim("2. Find the OAuth 2.0 Client ID (Desktop app type)")}`);
    console.log(`  ${dim("3. Add to .env:")}`);
    console.log(`     ${dim("TMAA_GOOGLE_CLIENT_ID=<client_id>")}`);
    console.log(`     ${dim("TMAA_GOOGLE_CLIENT_SECRET=<client_secret>")}`);
    console.log("");
    process.exit(1);
  }

  const cfg = ACCOUNTS[account];
  console.log(`  Account:  ${bold(account)} (${cfg.email})`);
  console.log(`  Env key:  ${cfg.envKey}`);
  console.log(`  Scopes:   ${cfg.scopes.map((s) => s.split("/").pop()).join(", ")}`);
  console.log("");
  console.log(`  ${yellow("IMPORTANT:")} Sign in with ${bold(cfg.email)} when the browser opens.`);
  console.log(`  ${dim("Signing in with a different account will fail.")}`);
  console.log("");

  const REDIRECT_PORT = 3848;
  const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: cfg.scopes,
    prompt: "consent",
    redirect_uri: REDIRECT_URI,
    login_hint: cfg.email,
  });

  const code = await new Promise<string>((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${REDIRECT_PORT}`);
      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h2 style="color:red">Authorization denied: ${error}</h2><p>You can close this tab.</p></body></html>`);
        server.close();
        reject(new Error(`Authorization denied: ${error}`));
        return;
      }

      if (authCode) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h2 style="color:green">Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>`);
        server.close();
        resolve(authCode);
        return;
      }

      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing authorization code.");
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`  ${yellow("1.")} Opening browser to authorize ${bold(cfg.email)}...`);
      console.log("");
      console.log(`     If browser doesn't open, manually visit:`);
      console.log(`     ${dim(authUrl)}`);
      console.log("");
      console.log(`  ${yellow("2.")} Sign in with ${bold(cfg.email)}`);
      console.log(`  ${yellow("3.")} Click "Allow" on all permission screens`);
      console.log(`  ${dim("     (Browser will redirect back automatically)")}`);
      console.log("");

      Bun.spawn(["powershell", "-Command", `Start-Process '${authUrl}'`], {
        stdout: "ignore",
        stderr: "ignore",
      });
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Timed out (5 min). Run the script again."));
    }, 5 * 60 * 1000);
  });

  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.log(`\n  ${red("No refresh token returned.")}`);
    console.log("");
    console.log("  This happens when Google thinks the app is already authorized.");
    console.log("  Fix: Revoke Atlas's access first, then re-run this script.");
    console.log("");
    console.log(`  ${yellow("Revoke here:")} https://myaccount.google.com/permissions`);
    console.log(`  ${dim("  Sign in as")} ${cfg.email}`);
    console.log(`  ${dim("  Find the TMAA app entry and click 'Remove Access'")}`);
    console.log(`  ${dim("  Then run this script again.")}`);
    process.exit(1);
  }

  console.log(`\n  ${green("Authorization successful! New refresh token obtained.")}`);
  console.log("");
  console.log(`  Add this to your .env:`);
  console.log("");
  console.log(`  ${bold(`${cfg.envKey}=${tokens.refresh_token}`)}`);
  console.log("");

  const autoAppend = await prompt("  Update .env automatically? (y/n): ");
  if (autoAppend.toLowerCase() === "y") {
    const envPath = join(PROJECT_ROOT, ".env");
    const existing = await Bun.file(envPath).text();

    let updated: string;
    if (existing.includes(cfg.envKey)) {
      updated = existing.replace(
        new RegExp(`^${cfg.envKey}=.*$`, "m"),
        `${cfg.envKey}=${tokens.refresh_token}`
      );
      console.log(`\n  ${green("Updated")} ${cfg.envKey} in .env`);
    } else {
      updated = existing + `\n${cfg.envKey}=${tokens.refresh_token}`;
      console.log(`\n  ${green("Appended")} ${cfg.envKey} to .env`);
    }
    await Bun.write(envPath, updated);
  }

  console.log("");
  if (account === "theoffice") {
    console.log(`  ${yellow("Next steps:")}`);
    console.log(`  ${dim("1. Restart Atlas:  pm2 restart atlas")}`);
    console.log(`  ${dim("2. Test:           /tmaa-test  or try a TMAA calendar command")}`);
    console.log(`  ${dim("3. Optionally run: bun run setup/tmaa-auth.ts --account derek")}`);
  } else {
    console.log(`  ${dim("Done! Restart Atlas to pick up the new token.")}`);
    console.log(`  ${dim("pm2 restart atlas")}`);
  }
  console.log("");
}

main().catch((err: any) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
