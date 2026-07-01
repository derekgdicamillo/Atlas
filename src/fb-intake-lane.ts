// FB Intake Lane
// While a chat's lane is "armed" (via /fbintake), incoming photos are stashed to disk
// instead of being fed to the model — so the model never screens/gatekeeps. On flush
// (/upload), each screenshot is extracted (name + email) with an isolated Haiku call and
// handed to scripts/fb-intake-upload.ts, which dedups against Brevo Lists 4/5/6 and uploads
// new contacts to List 6 only. Deterministic — no dependency on the model invoking a skill.
import { join, basename } from "path";
import { mkdir, writeFile, readFile, rm } from "fs/promises";

export type LaneState = { armed: boolean; imagePaths: string[]; armedAt: string; lastPhotoAt: string };
export type IntakeContact = { name: string; email: string | null; details?: string; sourceImage: string };
export type FlushSummary = {
  dryRun: boolean;
  inputCount: number;
  added: number;
  updated: number;
  alreadyOnTarget: number;
  alreadyFreeMember: number;
  alreadyProMember: number;
  dupInBatch: number;
  noEmail: number;
  invalidEmail: number;
  errors: { email?: string; error?: string }[];
  fbGroupLeadsTotal: number | null;
  auditPath?: string;
  contacts: IntakeContact[];
};

export function projectRoot(): string {
  return process.env.PROJECT_DIR ?? process.cwd();
}
export function inboxDir(chatId: string): string {
  return join(projectRoot(), "data", "fb-intake", "inbox", chatId);
}
function stateFile(): string {
  return join(projectRoot(), "data", "intake-sessions.json");
}

const lanes = new Map<string, LaneState>();

async function persist(): Promise<void> {
  const obj: Record<string, LaneState> = {};
  for (const [k, v] of lanes) obj[k] = v;
  await mkdir(join(projectRoot(), "data"), { recursive: true });
  await writeFile(stateFile(), JSON.stringify(obj, null, 2));
}

/** Load persisted lane state on startup so a restart mid-batch doesn't lose stashed shots. */
export async function loadLaneState(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(stateFile(), "utf8")) as Record<string, LaneState>;
    for (const [k, v] of Object.entries(raw)) lanes.set(k, v);
  } catch {
    /* no state file yet — fine */
  }
}

export function isArmed(chatId: string): boolean {
  return lanes.get(chatId)?.armed === true;
}
export function stashedCount(chatId: string): number {
  return lanes.get(chatId)?.imagePaths.length ?? 0;
}
export function lastPhotoAt(chatId: string): number {
  const t = lanes.get(chatId)?.lastPhotoAt;
  return t ? Date.parse(t) : 0;
}

export async function armLane(chatId: string): Promise<void> {
  const now = new Date().toISOString();
  lanes.set(chatId, { armed: true, imagePaths: [], armedAt: now, lastPhotoAt: now });
  await mkdir(inboxDir(chatId), { recursive: true });
  await persist();
}

export async function stashIntakePhoto(chatId: string, imageBuffer: Buffer): Promise<{ path: string; count: number }> {
  const st = lanes.get(chatId);
  if (!st || !st.armed) throw new Error("lane not armed");
  await mkdir(inboxDir(chatId), { recursive: true });
  const n = st.imagePaths.length + 1;
  const path = join(inboxDir(chatId), `shot-${String(n).padStart(3, "0")}.jpg`);
  await writeFile(path, imageBuffer);
  st.imagePaths.push(path);
  st.lastPhotoAt = new Date().toISOString();
  await persist();
  return { path, count: st.imagePaths.length };
}

export async function cancelLane(chatId: string): Promise<{ count: number }> {
  const count = stashedCount(chatId);
  await rm(inboxDir(chatId), { recursive: true, force: true });
  lanes.delete(chatId);
  await persist();
  return { count };
}

const EXTRACT_PROMPT =
  "This is a Facebook group membership-request screenshot. Extract the applicant's full name and email address. " +
  "Transcribe the email EXACTLY character-for-character — never guess, autocomplete, or correct it. " +
  "If no email is clearly and fully visible, use null. " +
  'Respond with ONLY a JSON object, no other text: {"name":"<full name>","email":"<email or null>","details":"<role/location/business if visible, else empty>"}';

/** Pure: turn one Haiku response into a contact. Tolerant of code fences / stray prose. */
export function parseExtraction(raw: string, sourceImage: string): IntakeContact {
  let s = (raw || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    const o = JSON.parse(s);
    const email = typeof o.email === "string" && o.email.includes("@") ? o.email.trim() : null;
    return {
      name: String(o.name ?? "").trim(),
      email,
      details: String(o.details ?? "").trim() || undefined,
      sourceImage,
    };
  } catch {
    return { name: "", email: null, details: "unparseable extraction", sourceImage };
  }
}

/** Extract name+email from each stashed screenshot via isolated Haiku vision calls. */
export async function extractContacts(imagePaths: string[]): Promise<IntakeContact[]> {
  const { callClaude } = await import("./claude.ts");
  const out: IntakeContact[] = [];
  // Concurrency is bounded because each call cold-spawns a full Claude CLI
  // process (one-shot, isolated). 3-at-a-time keeps the machine from being
  // hammered by simultaneous spawns while still finishing a 6-shot batch in
  // two quick rounds.
  const BATCH = 3;
  for (let i = 0; i < imagePaths.length; i += BATCH) {
    const slice = imagePaths.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(async (p) => {
        try {
          const b64 = (await readFile(p)).toString("base64");
          const raw = await callClaude(EXTRACT_PROMPT, {
            imageBase64: b64,
            imageMimeType: "image/jpeg",
            model: "haiku",
            isolated: true,
            // CRITICAL: a UNIQUE session key per image. Concurrent calls that
            // share a key contend for one session lock — with lockBehavior:"skip"
            // only the first acquires it and the rest return "" (→ "unparseable
            // extraction", no email). isolated:true does NOT bypass the lock, so
            // the key itself must differ per image. basename is unique within a batch.
            agentId: "fb-intake",
            userId: `intake-${basename(p)}`,
            lockBehavior: "skip",
          });
          return parseExtraction(raw, basename(p));
        } catch (e) {
          return { name: "", email: null, details: `extract error: ${e}`, sourceImage: basename(p) } as IntakeContact;
        }
      })
    );
    out.push(...results);
  }
  return out;
}

async function runUploadScript(jsonPath: string, dryRun: boolean): Promise<any> {
  const args = ["bun", "scripts/fb-intake-upload.ts", jsonPath, ...(dryRun ? ["--dry-run"] : [])];
  const proc = Bun.spawn(args, { cwd: projectRoot(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`upload script failed (${proc.exitCode}): ${err || out}`);
  return JSON.parse(out);
}

/** Extract → write JSON → run the Brevo uploader → clear the lane. Returns null if not armed/empty. */
export async function flushLane(chatId: string, opts: { dryRun: boolean }): Promise<FlushSummary | null> {
  const st = lanes.get(chatId);
  if (!st || !st.armed || st.imagePaths.length === 0) return null;
  const contacts = await extractContacts(st.imagePaths);

  await mkdir(join(projectRoot(), "tmp", "fb-intake"), { recursive: true });
  const jsonPath = join(projectRoot(), "tmp", "fb-intake", `lane-${chatId}.json`);
  await writeFile(jsonPath, JSON.stringify(contacts, null, 1));

  const summary = await runUploadScript(jsonPath, opts.dryRun);

  // success → clear lane + inbox (the script already wrote its own audit file)
  await rm(inboxDir(chatId), { recursive: true, force: true });
  lanes.delete(chatId);
  await persist();

  return { ...summary, contacts };
}

/** Pure: build the Telegram report from a flush summary. */
export function formatReport(s: FlushSummary): string {
  const lines: string[] = [];
  lines.push(`📋 FB intake ${s.dryRun ? "(DRY RUN — nothing written to Brevo)" : "complete"}`);
  lines.push(
    `Added ${s.added} | Updated ${s.updated} | Already on a list ${s.alreadyOnTarget + s.alreadyFreeMember + s.alreadyProMember} | No email ${s.noEmail} | Errors ${s.errors.length}`
  );
  if (s.fbGroupLeadsTotal != null) lines.push(`FB Group Leads total: ${s.fbGroupLeadsTotal}`);
  lines.push("");
  lines.push("Captured:");
  for (const c of s.contacts) lines.push(`• ${c.name || "(no name)"} — ${c.email ?? "⚠️ NO EMAIL"}`);
  if (s.auditPath) lines.push("", `Audit: ${s.auditPath}`);
  return lines.join("\n");
}
