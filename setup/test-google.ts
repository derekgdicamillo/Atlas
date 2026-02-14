/**
 * One-time script: Send intro emails from Atlas + save Esther's contact info to memory.
 * Run: bun run setup/test-google.ts
 */

import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { dirname, join } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);

// Load .env
async function loadEnv(): Promise<void> {
  const content = await Bun.file(join(PROJECT_ROOT, ".env")).text();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

await loadEnv();

// ---- SEND EMAILS FROM ATLAS ----

const atlasAuth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
atlasAuth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN_ATLAS });
const atlasGmail = google.gmail({ version: "v1", auth: atlasAuth });

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  const raw = [
    `To: ${to}`,
    `From: Atlas <assistant.ai.atlas@gmail.com>`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(raw).toString("base64url");
  const res = await atlasGmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });
  console.log(`  Sent to ${to} (${res.data.id})`);
}

const estherBody = `Hi Esther,

This is Atlas, Derek's AI assistant. Derek just set me up with my own email account so I can help out more around here.

My email address is: assistant.ai.atlas@gmail.com

Please add this to your safe senders / contacts so my emails don't end up in spam.

Here's what I can do:
- Read and summarize Derek's inbox, and draft email replies for him
- Send emails on Derek's behalf from this address (mostly to you and Derek)
- Manage Derek's Google Calendar: add appointments, remove them, and send invites to attendees
- Remember important facts and preferences
- Help with daily planning, research, writing, and anything Derek throws my way via Telegram

If you ever get an email from me, it's because Derek asked me to send it. I won't email you out of the blue without his say-so.

Nice to officially meet you!

- Atlas`;

const derekBody = `Hey Derek,

This is Atlas confirming my new email is live. Add assistant.ai.atlas@gmail.com to your safe senders so my emails don't get filtered.

Here's what I can do from this account:
- Send emails to you and Esther (or anyone you ask)
- Read your inbox and draft replies (drafts only, I never send from your account)
- Manage your Google Calendar (add/remove events, send invites)
- All triggered through our Telegram chat

This is a test email to confirm everything's working.

- Atlas`;

console.log("\nSending intro emails from Atlas...\n");

await sendEmail(
  "esther@pvmedispa.com",
  "Hi from Atlas - Derek's AI Assistant (New Email Address)",
  estherBody
);

await sendEmail(
  "derek@pvmedispa.com",
  "Atlas Email Test - Add to Safe Senders",
  derekBody
);

await sendEmail(
  "derekgdicamillo@gmail.com",
  "Atlas Email Test - Add to Safe Senders",
  derekBody
);

console.log("\n  All 3 emails sent.\n");

// ---- SAVE ESTHER'S INFO TO MEMORY ----

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const facts = [
  "Esther DiCamillo is Derek's wife. Work email: esther@pvmedispa.com, Personal email: esther.dicamillo@gmail.com",
  "Atlas's own email address is assistant.ai.atlas@gmail.com (used for sending emails)",
];

console.log("Saving facts to memory...\n");

for (const fact of facts) {
  const { error } = await supabase.from("memory").insert({
    type: "fact",
    content: fact,
  });
  if (error) {
    console.log(`  Error saving: ${error.message}`);
  } else {
    console.log(`  Saved: ${fact.substring(0, 60)}...`);
  }
}

console.log("\nDone!");
