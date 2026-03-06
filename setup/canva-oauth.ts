/**
 * Atlas — Canva Connect API OAuth2 Setup (PKCE)
 *
 * One-time interactive script to authorize Canva access.
 *
 * Usage:
 *   bun run setup/canva-oauth.ts
 *
 * Prerequisites:
 *   1. Create a Canva integration at https://www.canva.com/developers/
 *   2. Enable MFA on your Canva account
 *   3. Add CANVA_CLIENT_ID and CANVA_CLIENT_SECRET to .env
 *   4. Set redirect URL to http://localhost:3001/callback in the Canva integration config
 *   5. Enable scopes: design:content:read/write, design:meta:read, folder:read, asset:read/write, profile:read
 */

import { createServer, type Server } from "http";
import { join, dirname } from "path";
import { createInterface } from "readline";

const PROJECT_ROOT = dirname(import.meta.dir);
const REDIRECT_PORT = 3001;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

// Colors
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

// PKCE helpers
function generateCodeVerifier(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function main() {
  console.log("");
  console.log(bold("  Atlas — Canva Connect API Setup"));
  console.log("");

  const env = await loadEnv();
  const clientId = env.CANVA_CLIENT_ID || process.env.CANVA_CLIENT_ID || "";
  const clientSecret = env.CANVA_CLIENT_SECRET || process.env.CANVA_CLIENT_SECRET || "";

  if (!clientId || !clientSecret) {
    console.log(`  ${red("Missing Canva credentials in .env")}`);
    console.log("");
    console.log("  Add these to your .env file first:");
    console.log(`    ${dim("CANVA_CLIENT_ID=your_client_id")}`);
    console.log(`    ${dim("CANVA_CLIENT_SECRET=your_client_secret")}`);
    console.log("");
    console.log("  To get these:");
    console.log(`    ${dim("1. Go to https://www.canva.com/developers/")}`);
    console.log(`    ${dim("2. Create an integration")}`);
    console.log(`    ${dim("3. Copy Client ID and generate a Client Secret")}`);
    console.log("");
    process.exit(1);
  }

  // Must match scopes enabled on the Canva integration config page
  const scopes = "design:content:read design:content:write design:permission:read design:permission:write asset:read asset:write folder:read folder:write folder:permission:read folder:permission:write comment:read comment:write app:read app:write";
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const state = crypto.randomUUID();

  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const authUrl = `https://www.canva.com/api/oauth/authorize?${authParams}`;

  console.log(`  Client ID:  ${bold(clientId)}`);
  console.log(`  Redirect:   ${REDIRECT_URI}`);
  console.log(`  Scopes:     ${scopes.split(" ").join(", ")}`);
  console.log("");

  // Wait for OAuth callback
  const code = await new Promise<string>((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${REDIRECT_PORT}`);

      // Only handle the callback path
      if (!url.pathname.startsWith("/callback")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const returnedState = url.searchParams.get("state");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Authorization denied: ${error}</h2><p>You can close this tab.</p></body></html>`);
        server.close();
        reject(new Error(`Authorization denied: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>State mismatch</h2><p>Security check failed. Try again.</p></body></html>`);
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }

      if (authCode) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><h2>Canva authorized!</h2><p>You can close this tab and return to the terminal.</p></body></html>`);
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
      console.log(`  ${yellow("2.")} Sign in to Canva and grant access`);
      console.log(`  ${dim("     The browser will redirect back automatically.")}`);
      console.log("");

      if (process.platform === "win32") {
        Bun.spawn(["powershell", "-Command", `Start-Process '${authUrl}'`], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } else {
        const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
        Bun.spawn([openCmd, authUrl], { stdout: "ignore", stderr: "ignore" });
      }
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for authorization (5 min). Try again."));
    }, 5 * 60 * 1000);
  });

  // Exchange code for tokens (with PKCE verifier)
  try {
    console.log(`  ${dim("Exchanging authorization code for tokens...")}`);

    const tokenRes = await fetch("https://api.canva.com/rest/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      throw new Error(`Token exchange failed (${tokenRes.status}): ${body.substring(0, 300)}`);
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };

    if (!tokens.access_token) {
      throw new Error("No access token returned");
    }

    console.log(`\n  ${green("Authorization successful!")}`);
    console.log("");
    console.log(`  Access token:  ${dim(tokens.access_token.substring(0, 20) + "...")}`);
    console.log(`  Refresh token: ${dim(tokens.refresh_token?.substring(0, 20) + "..." || "none")}`);
    console.log(`  Expires in:    ${tokens.expires_in}s`);
    console.log("");

    // Always save to .env immediately (tokens are precious, don't risk losing them)
    {
      const envPath = join(PROJECT_ROOT, ".env");
      let existing = await Bun.file(envPath).text();

      const tokenVars = {
        CANVA_ACCESS_TOKEN: tokens.access_token,
        CANVA_REFRESH_TOKEN: tokens.refresh_token || "",
      };

      for (const [key, value] of Object.entries(tokenVars)) {
        if (!value) continue;
        if (existing.includes(`${key}=`)) {
          existing = existing.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
        } else {
          existing += `\n${key}=${value}`;
        }
      }

      await Bun.write(envPath, existing);
      console.log(`\n  ${green("Saved")} CANVA_ACCESS_TOKEN and CANVA_REFRESH_TOKEN to .env`);
    }

    console.log("");
    console.log(`  ${dim("Restart Atlas to pick up the new tokens.")}`);
    console.log("");
  } catch (err: any) {
    console.log(`\n  ${red("Token exchange failed:")} ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
