/**
 * Sprint 5 bootstrap: generate ed25519 keypairs for the 8 hand-curated named seats
 * and publish their pubkeys to the ledger + role_pubkeys table.
 * Idempotent: skips roles that already have keys.
 *
 * DEVIATION FROM PLAN: plan shows writeLedgerEntry() but ledger.ts exports appendEntry(LedgerInput).
 * We call appendEntry() with actor="system" and return entry.entryHash as the ledger ID.
 * The actor union is "atlas" | "ishtar" | "shield" | "system" — "atlas-bootstrap" is not valid.
 */
import { existsSync } from "fs";
import { join } from "path";
import { generateRoleKeypair } from "../src/role-registry";
import { appendEntry } from "../src/ledger";
import { createClient } from "@supabase/supabase-js";

const NAMED_SEATS = [
  "patient-advocate",
  "compliance-lawyer",
  "brand-voice",
  "skeptic",
  "hormozi-analyst",
  "munger-inverter",
  "accountant-conservative",
  "family-calendar-guardian",
  "ishtar-mirror",
];

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  // Prefer service role key for bypassing RLS; fall back to anon key for dev environments
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) must be set");
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  for (const id of NAMED_SEATS) {
    if (existsSync(join("data/roles", id, "key.priv"))) {
      console.log("[bootstrap] " + id + ": keypair exists, skip");
      continue;
    }

    const { publicKey } = await generateRoleKeypair(id);

    const entry = await appendEntry({
      actor: "system",
      action: {
        tool: "role.publish_pubkey",
        args: { role_id: id, pubkey_b64: publicKey.toString("base64") },
      },
      sourceClaims: [],
    });

    const { error } = await supabase.from("role_pubkeys").upsert({
      role_id: id,
      pubkey: publicKey,
      ledger_publication_entry_id: entry.entryHash,
    });

    if (error) {
      throw new Error("[bootstrap] Supabase upsert failed for " + id + ": " + error.message);
    }

    console.log(
      "[bootstrap] " + id + ": keypair generated, pubkey published (ledger=" + entry.entryHash + ")"
    );
  }

  console.log("[bootstrap] done — " + NAMED_SEATS.length + " named seats (including ishtar-mirror)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
