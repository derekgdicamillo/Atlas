/**
 * FB Group Leads bulk uploader (fb-intake skill v2 backend)
 *
 * Usage: bun scripts/fb-intake-upload.ts <contacts.json> [--dry-run]
 *
 * Input: JSON array of extracted contacts:
 *   [{ "name": "Jane Doe", "email": "jane@x.com", "details": "RN, Phoenix AZ", "sourceImage": "IMG_001.jpg" }, ...]
 *   (firstName/lastName accepted as an alternative to name)
 *
 * Behavior:
 *   - Pulls membership of Brevo lists 4 (Free), 5 (Pro), 6 (FB Group Leads) with pagination
 *   - Dedups in code: already on 4/5 -> "already a member" (never moved), already on 6 -> skipped
 *   - Uploads new contacts to List 6 ONLY, SOURCE="ANE Facebook Group", updateEnabled=true
 *   - Writes a full audit file to data/fb-intake/audit-<timestamp>.json
 *   - Prints a compact JSON summary to stdout (consumed by the skill)
 *
 * --dry-run: does everything except the POST /contacts calls.
 */

const API = "https://api.brevo.com/v3";
const KEY = process.env.BREVO_API_KEY || "";
const LIST_FREE = 4;
const LIST_PRO = 5;
const LIST_TARGET = 6; // FB Group Leads

type Extracted = {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  details?: string;
  sourceImage?: string;
};

type AuditRow = Extracted & {
  normalizedEmail?: string;
  status:
    | "added"
    | "updated"
    | "skipped_already_on_target"
    | "skipped_member_free"
    | "skipped_member_pro"
    | "skipped_no_email"
    | "skipped_invalid_email"
    | "skipped_dup_in_batch"
    | "error";
  error?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function brevo(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "api-key": KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers || {}),
    },
  });
  if (res.status === 204) return {};
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Brevo ${init?.method || "GET"} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function listEmails(listId: number): Promise<Set<string>> {
  const emails = new Set<string>();
  let offset = 0;
  const limit = 500;
  for (;;) {
    const page = await brevo(`/contacts/lists/${listId}/contacts?limit=${limit}&offset=${offset}`);
    const contacts: any[] = page.contacts || [];
    for (const c of contacts) if (c.email) emails.add(String(c.email).toLowerCase());
    if (contacts.length < limit) break;
    offset += limit;
  }
  return emails;
}

function splitName(c: Extracted): { first: string; last: string } {
  if (c.firstName || c.lastName) return { first: c.firstName || "", last: c.lastName || "" };
  const parts = (c.name || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const inputPath = args.find((a) => !a.startsWith("--"));
  if (!inputPath) fail("Usage: bun scripts/fb-intake-upload.ts <contacts.json> [--dry-run]");
  if (!KEY) fail("BREVO_API_KEY not set");

  const raw = await Bun.file(inputPath).json();
  const input: Extracted[] = Array.isArray(raw) ? raw : raw.contacts || [];
  if (!input.length) fail(`No contacts found in ${inputPath}`);

  const [freeSet, proSet, targetSet] = await Promise.all([
    listEmails(LIST_FREE),
    listEmails(LIST_PRO),
    listEmails(LIST_TARGET),
  ]);

  const audit: AuditRow[] = [];
  const seenInBatch = new Set<string>();
  const toUpload: (Extracted & { normalizedEmail: string })[] = [];

  for (const c of input) {
    const email = (c.email || "").trim().toLowerCase();
    if (!email) {
      audit.push({ ...c, status: "skipped_no_email" });
    } else if (!EMAIL_RE.test(email)) {
      audit.push({ ...c, normalizedEmail: email, status: "skipped_invalid_email" });
    } else if (seenInBatch.has(email)) {
      audit.push({ ...c, normalizedEmail: email, status: "skipped_dup_in_batch" });
    } else if (freeSet.has(email)) {
      seenInBatch.add(email);
      audit.push({ ...c, normalizedEmail: email, status: "skipped_member_free" });
    } else if (proSet.has(email)) {
      seenInBatch.add(email);
      audit.push({ ...c, normalizedEmail: email, status: "skipped_member_pro" });
    } else if (targetSet.has(email)) {
      seenInBatch.add(email);
      audit.push({ ...c, normalizedEmail: email, status: "skipped_already_on_target" });
    } else {
      seenInBatch.add(email);
      toUpload.push({ ...c, normalizedEmail: email });
    }
  }

  let added = 0;
  let updated = 0;
  for (const c of toUpload) {
    const { first, last } = splitName(c);
    if (dryRun) {
      audit.push({ ...c, status: "added" });
      added++;
      continue;
    }
    try {
      const body = {
        email: c.normalizedEmail,
        attributes: { FIRSTNAME: first, LASTNAME: last, SOURCE: "ANE Facebook Group" },
        listIds: [LIST_TARGET],
        updateEnabled: true,
      };
      const res = await brevo("/contacts", { method: "POST", body: JSON.stringify(body) });
      // POST /contacts returns {id} (201) on create, {} (204) when an existing contact was updated
      if (res && res.id !== undefined) {
        audit.push({ ...c, status: "added" });
        added++;
      } else {
        audit.push({ ...c, status: "updated" });
        updated++;
      }
      await new Promise((r) => setTimeout(r, 120)); // stay under Brevo rate limits
    } catch (e: any) {
      audit.push({ ...c, status: "error", error: String(e?.message || e) });
    }
  }

  // Final target list count
  let targetTotal: number | null = null;
  try {
    const info = await brevo(`/contacts/lists/${LIST_TARGET}`);
    targetTotal = info.totalSubscribers ?? info.uniqueSubscribers ?? null;
  } catch {
    /* non-fatal */
  }

  const count = (s: AuditRow["status"]) => audit.filter((r) => r.status === s).length;
  const summary = {
    dryRun,
    inputCount: input.length,
    added,
    updated,
    alreadyOnTarget: count("skipped_already_on_target"),
    alreadyFreeMember: count("skipped_member_free"),
    alreadyProMember: count("skipped_member_pro"),
    dupInBatch: count("skipped_dup_in_batch"),
    noEmail: count("skipped_no_email"),
    invalidEmail: count("skipped_invalid_email"),
    errors: audit.filter((r) => r.status === "error").map((r) => ({ email: r.normalizedEmail, error: r.error })),
    fbGroupLeadsTotal: targetTotal,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const auditPath = `data/fb-intake/audit-${stamp}${dryRun ? "-dryrun" : ""}.json`;
  await Bun.write(auditPath, JSON.stringify({ summary, rows: audit }, null, 2));

  console.log(JSON.stringify({ ...summary, auditPath }, null, 2));
}

main().catch((e) => fail(String(e?.stack || e)));
