# FB Intake Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Derek/Esther bulk-ingest Facebook group member screenshots through Ishtar and upload the extracted emails to Brevo List 6, with zero screening/deliberation — by stashing screenshots to disk instead of feeding them to the model, then deterministically extracting + uploading on command.

**Architecture:** A new focused module `src/fb-intake-lane.ts` owns all lane logic (per-chat armed state, disk stash, Haiku extraction, flush→upload). `src/relay.ts` gets small hooks only: a `/fbintake` arm command, an `upload`/`/upload` flush trigger, a `/cancel`, and an early branch in the `message:photo` handler that diverts stashed photos away from `handleUserMessage` (so the model never sees them). Extraction is relay-orchestrated via isolated `callClaude` Haiku calls — **no dependency on the model choosing to invoke a skill** — and the existing `scripts/fb-intake-upload.ts` stays the upload backend.

**Tech Stack:** Bun + TypeScript, Grammy (Telegram), `callClaude` CLI spawner (claude.ts), existing Brevo uploader script, `bun test` for unit tests.

## Global Constraints

- **Never screen/gatekeep.** The lane extracts every visible email and uploads it. No judgment, no confirmation gate. (Matches `fb-intake` skill design; Admin Assist handles screening in Facebook.)
- **Intake images must NOT be force-fed to the model.** While a chat's lane is armed, photos bypass `handleUserMessage` entirely.
- **Intake images must NOT be auto-deleted** by the `cleanupFile` path (`relay.ts:5060`) until after a successful flush.
- **Brevo writes only on an explicit trigger.** Idle never auto-uploads — it only nudges. (Respects the "no autonomous Brevo actions" rule.)
- **Upload target is List 6 only**, `SOURCE="ANE Facebook Group"`, dedup vs Lists 4/5/6 — all already enforced by `scripts/fb-intake-upload.ts`. Do not bypass it.
- **First real batch runs `--dry-run`**; flip to live only after Derek confirms extraction quality.
- Resolve project root as `process.env.PROJECT_DIR ?? process.cwd()` (pattern at `relay.ts:1926`).
- Key lanes by `String(ctx.chat?.id)`.

---

## File Structure

- **Create** `src/fb-intake-lane.ts` — all lane state, stash, extraction, flush, report formatting.
- **Create** `src/fb-intake-lane.test.ts` — unit tests for the pure functions (`parseExtraction`, `formatReport`).
- **Modify** `src/relay.ts` — import the module; load state on startup; add `/fbintake`,`/upload`,`/cancel` command cases; add NL "upload" flush when armed; add the intake branch in `message:photo`; add idle-nudge check.
- **Reuse (no change)** `scripts/fb-intake-upload.ts` — the Brevo upload backend.
- **Runtime dirs (auto-created):** `data/fb-intake/inbox/<chatId>/` (stashed jpgs), `tmp/fb-intake/` (merged JSON), `data/intake-sessions.json` (persisted lane state).

---

### Task 1: Lane state + disk stash (`src/fb-intake-lane.ts`)

**Files:**
- Create: `src/fb-intake-lane.ts`
- Test: `src/fb-intake-lane.test.ts`

**Interfaces — Produces:**
```ts
export type LaneState = { armed: boolean; imagePaths: string[]; armedAt: string; lastPhotoAt: string };
export function projectRoot(): string;
export function inboxDir(chatId: string): string;
export async function loadLaneState(): Promise<void>;     // call once on startup
export function isArmed(chatId: string): boolean;
export async function armLane(chatId: string): Promise<void>;
export function stashedCount(chatId: string): number;
export function lastPhotoAt(chatId: string): number;      // epoch ms, 0 if none
export async function stashIntakePhoto(chatId: string, imageBuffer: Buffer): Promise<{ path: string; count: number }>;
export async function cancelLane(chatId: string): Promise<{ count: number }>;
```

- [ ] **Step 1: Write the module skeleton + state**

```ts
// src/fb-intake-lane.ts
import { join } from "path";
import { mkdir, writeFile, readFile, rm } from "fs/promises";

export type LaneState = { armed: boolean; imagePaths: string[]; armedAt: string; lastPhotoAt: string };

export function projectRoot(): string {
  return process.env.PROJECT_DIR ?? process.cwd();
}
export function inboxDir(chatId: string): string {
  return join(projectRoot(), "data", "fb-intake", "inbox", chatId);
}
const STATE_FILE = () => join(projectRoot(), "data", "intake-sessions.json");

const lanes = new Map<string, LaneState>();

async function persist(): Promise<void> {
  const obj: Record<string, LaneState> = {};
  for (const [k, v] of lanes) obj[k] = v;
  await mkdir(join(projectRoot(), "data"), { recursive: true });
  await writeFile(STATE_FILE(), JSON.stringify(obj, null, 2));
}

export async function loadLaneState(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE(), "utf8")) as Record<string, LaneState>;
    for (const [k, v] of Object.entries(raw)) lanes.set(k, v);
  } catch { /* no state file yet — fine */ }
}

export function isArmed(chatId: string): boolean { return lanes.get(chatId)?.armed === true; }
export function stashedCount(chatId: string): number { return lanes.get(chatId)?.imagePaths.length ?? 0; }
export function lastPhotoAt(chatId: string): number {
  const t = lanes.get(chatId)?.lastPhotoAt; return t ? Date.parse(t) : 0;
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cd "$PROJECT_DIR" && bun build src/fb-intake-lane.ts --target bun > /dev/null && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/fb-intake-lane.ts
git commit -m "feat(fb-intake): lane state + disk stash module"
```

---

### Task 2: Haiku extraction + parse

**Files:**
- Modify: `src/fb-intake-lane.ts`
- Test: `src/fb-intake-lane.test.ts`

**Interfaces — Produces:**
```ts
export type IntakeContact = { name: string; email: string | null; details?: string; sourceImage: string };
export function parseExtraction(raw: string, sourceImage: string): IntakeContact;     // pure
export async function extractContacts(imagePaths: string[]): Promise<IntakeContact[]>;
```
**Consumes:** `callClaude` from `./claude.ts` (signature: `callClaude(prompt, { imageBase64, imageMimeType, model, isolated, lockBehavior })`).

- [ ] **Step 1: Write failing test for `parseExtraction`**

```ts
// src/fb-intake-lane.test.ts
import { test, expect } from "bun:test";
import { parseExtraction, formatReport } from "./fb-intake-lane.ts";

test("parseExtraction reads clean JSON", () => {
  const r = parseExtraction('{"name":"Jane Doe","email":"jane@x.com","details":"RN, AZ"}', "shot-001.jpg");
  expect(r).toEqual({ name: "Jane Doe", email: "jane@x.com", details: "RN, AZ", sourceImage: "shot-001.jpg" });
});
test("parseExtraction strips code fences", () => {
  const r = parseExtraction('```json\n{"name":"Bo","email":"bo@y.com"}\n```', "s2.jpg");
  expect(r.email).toBe("bo@y.com");
});
test("parseExtraction null email on garbage", () => {
  const r = parseExtraction("I can't read this image", "s3.jpg");
  expect(r.email).toBeNull();
  expect(r.sourceImage).toBe("s3.jpg");
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd "$PROJECT_DIR" && bun test src/fb-intake-lane.test.ts`
Expected: FAIL — `parseExtraction`/`formatReport` not exported.

- [ ] **Step 3: Implement `parseExtraction` + `extractContacts`**

```ts
import { callClaude } from "./claude.ts";

export type IntakeContact = { name: string; email: string | null; details?: string; sourceImage: string };

const EXTRACT_PROMPT =
  "This is a Facebook group membership-request screenshot. Extract the applicant's full name and email address. " +
  "Transcribe the email EXACTLY character-for-character — never guess, autocomplete, or correct it. " +
  "If no email is clearly and fully visible, use null. " +
  'Respond with ONLY a JSON object, no other text: {"name":"<full name>","email":"<email or null>","details":"<role/location/business if visible, else empty>"}';

export function parseExtraction(raw: string, sourceImage: string): IntakeContact {
  let s = (raw || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    const o = JSON.parse(s);
    const email = typeof o.email === "string" && o.email.includes("@") ? o.email.trim() : null;
    return { name: String(o.name ?? "").trim(), email, details: String(o.details ?? "").trim() || undefined, sourceImage };
  } catch {
    return { name: "", email: null, details: "unparseable extraction", sourceImage };
  }
}

export async function extractContacts(imagePaths: string[]): Promise<IntakeContact[]> {
  const { readFile } = await import("fs/promises");
  const { basename } = await import("path");
  const out: IntakeContact[] = [];
  const BATCH = 6;
  for (let i = 0; i < imagePaths.length; i += BATCH) {
    const slice = imagePaths.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(async (p) => {
      try {
        const b64 = (await readFile(p)).toString("base64");
        const raw = await callClaude(EXTRACT_PROMPT, {
          imageBase64: b64, imageMimeType: "image/jpeg", model: "haiku",
          isolated: true, lockBehavior: "skip",
        });
        return parseExtraction(raw, basename(p));
      } catch (e) {
        return { name: "", email: null, details: `extract error: ${e}`, sourceImage: basename(p) } as IntakeContact;
      }
    }));
    out.push(...results);
  }
  return out;
}
```

- [ ] **Step 4: Run tests (parse tests pass; `formatReport` still missing — added in Task 3)**

Run: `cd "$PROJECT_DIR" && bun test src/fb-intake-lane.test.ts -t parseExtraction`
Expected: 3 `parseExtraction` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fb-intake-lane.ts src/fb-intake-lane.test.ts
git commit -m "feat(fb-intake): haiku extraction + JSON parse"
```

---

### Task 3: Flush → upload + report

**Files:**
- Modify: `src/fb-intake-lane.ts`
- Test: `src/fb-intake-lane.test.ts`

**Interfaces — Produces:**
```ts
export type FlushSummary = {
  dryRun: boolean; inputCount: number; added: number; updated: number;
  alreadyOnTarget: number; alreadyFreeMember: number; alreadyProMember: number;
  dupInBatch: number; noEmail: number; invalidEmail: number;
  errors: { email?: string; error?: string }[]; fbGroupLeadsTotal: number | null;
  auditPath?: string; contacts: IntakeContact[];
};
export async function flushLane(chatId: string, opts: { dryRun: boolean }): Promise<FlushSummary | null>; // null if not armed/empty
export function formatReport(s: FlushSummary): string;   // pure
```

- [ ] **Step 1: Write failing test for `formatReport`**

```ts
test("formatReport lists name->email and totals", () => {
  const msg = formatReport({
    dryRun: true, inputCount: 2, added: 1, updated: 0, alreadyOnTarget: 1,
    alreadyFreeMember: 0, alreadyProMember: 0, dupInBatch: 0, noEmail: 0, invalidEmail: 0,
    errors: [], fbGroupLeadsTotal: 305, auditPath: "data/fb-intake/audit-x.json",
    contacts: [{ name: "Jane Doe", email: "jane@x.com", sourceImage: "shot-001.jpg" }],
  });
  expect(msg).toContain("Added 1");
  expect(msg).toContain("FB Group Leads total: 305");
  expect(msg).toContain("jane@x.com");
  expect(msg.toLowerCase()).toContain("dry");
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd "$PROJECT_DIR" && bun test src/fb-intake-lane.test.ts -t formatReport`
Expected: FAIL — `formatReport` not exported.

- [ ] **Step 3: Implement `runUploadScript`, `flushLane`, `formatReport`**

```ts
async function runUploadScript(jsonPath: string, dryRun: boolean): Promise<any> {
  const args = ["bun", "scripts/fb-intake-upload.ts", jsonPath, ...(dryRun ? ["--dry-run"] : [])];
  const proc = Bun.spawn(args, { cwd: projectRoot(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`upload script failed (${proc.exitCode}): ${err || out}`);
  return JSON.parse(out);
}

export async function flushLane(chatId: string, opts: { dryRun: boolean }): Promise<FlushSummary | null> {
  const st = lanes.get(chatId);
  if (!st || !st.armed || st.imagePaths.length === 0) return null;
  const contacts = await extractContacts(st.imagePaths);

  const { mkdir, writeFile } = await import("fs/promises");
  await mkdir(join(projectRoot(), "tmp", "fb-intake"), { recursive: true });
  const jsonPath = join(projectRoot(), "tmp", "fb-intake", `lane-${chatId}.json`);
  await writeFile(jsonPath, JSON.stringify(contacts, null, 1));

  const summary = await runUploadScript(jsonPath, opts.dryRun);

  // success → clear the lane + inbox (keep audit file written by the script)
  await rm(inboxDir(chatId), { recursive: true, force: true });
  lanes.delete(chatId);
  await persist();

  return { ...summary, contacts };
}

export function formatReport(s: FlushSummary): string {
  const lines: string[] = [];
  lines.push(`📋 FB intake ${s.dryRun ? "(DRY RUN — nothing written to Brevo)" : "complete"}`);
  lines.push(
    `Added ${s.added} | Updated ${s.updated} | Already on a list ${s.alreadyOnTarget + s.alreadyFreeMember + s.alreadyProMember} | No email ${s.noEmail} | Errors ${s.errors.length}`
  );
  if (s.fbGroupLeadsTotal != null) lines.push(`**FB Group Leads total: ${s.fbGroupLeadsTotal}**`);
  lines.push("");
  lines.push("Captured:");
  for (const c of s.contacts) lines.push(`• ${c.name || "(no name)"} — ${c.email ?? "⚠️ NO EMAIL"}`);
  if (s.auditPath) lines.push("", `Audit: ${s.auditPath}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the full unit suite**

Run: `cd "$PROJECT_DIR" && bun test src/fb-intake-lane.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fb-intake-lane.ts src/fb-intake-lane.test.ts
git commit -m "feat(fb-intake): flush -> upload + report formatting"
```

---

### Task 4: Wire into `relay.ts`

**Files:**
- Modify: `src/relay.ts` — import (top, near line 41); startup load (near other startup loads ~line 6045); command cases (switch at ~line 1230); NL flush (in `handleTextMessage`); photo branch (`message:photo` ~line 5322); idle nudge.

**Interfaces — Consumes:** all exports from Task 1–3.

- [ ] **Step 1: Import + startup load**

Add to the import block:
```ts
import * as intake from "./fb-intake-lane.ts";
```
Near startup (after `info("startup", ...)` at ~line 6045):
```ts
await intake.loadLaneState();
info("startup", `FB intake lanes loaded`);
```

- [ ] **Step 2: Add slash-command cases** (in the `switch (cmd)` at ~`relay.ts:1230`, following the existing `case` pattern; `chatId` is `String(ctx.chat?.id || "")`)

```ts
case "/fbintake": {
  await intake.armLane(cmdChatId);
  await ctx.reply("📥 FB intake started — send the screenshots, then say `upload` (or /upload) when done. /cancel to abort.", { parse_mode: "Markdown" });
  return true;
}
case "/upload": {
  if (!intake.isArmed(cmdChatId)) { await ctx.reply("No FB intake batch is active. Start one with /fbintake."); return true; }
  await ctx.replyWithChatAction("typing");
  const FIRST_RUN_DRY = true; // flip to false after first verified batch (see Task 5)
  const summary = await intake.flushLane(cmdChatId, { dryRun: FIRST_RUN_DRY });
  await ctx.reply(summary ? intake.formatReport(summary) : "Nothing stashed to upload.", { parse_mode: "Markdown" });
  return true;
}
case "/cancel": {
  const { count } = await intake.cancelLane(cmdChatId);
  await ctx.reply(`🗑️ FB intake cancelled — discarded ${count} screenshot(s).`);
  return true;
}
```

- [ ] **Step 3: NL flush when armed** (early in `handleTextMessage`, before the non-slash `return false`)

```ts
if (intake.isArmed(cmdChatId) && /^\s*(upload|done|add to brevo|that'?s all|finished)\b/i.test(ctx.message?.text || "")) {
  await ctx.replyWithChatAction("typing");
  const summary = await intake.flushLane(cmdChatId, { dryRun: true }); // mirror /upload's FIRST_RUN_DRY
  await ctx.reply(summary ? intake.formatReport(summary) : "Nothing stashed to upload.", { parse_mode: "Markdown" });
  return true;
}
```

- [ ] **Step 4: Intake branch in `message:photo`** (insert right after `const imageBuffer = Buffer.from(buffer);` at ~`relay.ts:5322`, BEFORE `writeFile(filePath,...)` / `handleUserMessage`)

```ts
const intakeChatId = String(ctx.chat?.id || "");
if (intake.isArmed(intakeChatId)) {
  const { count } = await intake.stashIntakePhoto(intakeChatId, imageBuffer);
  await ctx.react("📥").catch(() => {});
  info("fb-intake", `Stashed screenshot ${count} for chat ${intakeChatId}`);
  await saveLastUpdateId(updateId, botIdFromCtx(ctx));
  return; // do NOT feed to the model, do NOT set cleanupFile
}
```

- [ ] **Step 5: Restart relay and smoke-test the commands**

```bash
cd "$PROJECT_DIR" && pm2 restart ishtar   # or the live process name
```
In Telegram: send `/fbintake` → expect the "📥 FB intake started" ack. Send `/cancel` → expect "discarded 0".
Expected: both replies appear; no errors in logs.

- [ ] **Step 6: Commit**

```bash
git add src/relay.ts
git commit -m "feat(fb-intake): relay hooks — /fbintake, /upload, /cancel, photo stash branch"
```

---

### Task 5: Live verification (dry-run → live)

**Files:** none (operational).

- [ ] **Step 1: Dry-run a real batch**
In Telegram: `/fbintake` → send 3–5 real FB member screenshots (expect a 📥 on each) → `/upload`.
Expected: a report listing each **name → email**, `Added N`, and `(DRY RUN — nothing written to Brevo)`. Confirm the emails are transcribed correctly.

- [ ] **Step 2: Verify the audit file**
Run: `cd "$PROJECT_DIR" && ls -t data/fb-intake/audit-*dryrun.json | head -1 | xargs cat | head -40`
Expected: rows with statuses; emails match the screenshots.

- [ ] **Step 3: Flip to live**
In `relay.ts`, set `FIRST_RUN_DRY = false` (Task 4 Step 2) and the NL-flush `dryRun: false` (Task 4 Step 3). Commit:
```bash
git add src/relay.ts && git commit -m "chore(fb-intake): flip uploads live after verified dry-run"
```
Restart relay. Run one real batch end-to-end; confirm `Added`/`Updated` and the **FB Group Leads total** climbs in Brevo.

- [ ] **Step 4: Idle nudge (optional, only if desired)**
Add a 60s interval that, for any armed lane with `Date.now() - intake.lastPhotoAt(chatId) > 3*60_000` and `stashedCount>0`, sends a one-time nudge "📥 N screenshots stashed — say `upload` when done." (No auto-upload.)

---

## Self-Review

- **Spec coverage:** start (`/fbintake`, Task 4.2) · silent stash + 📥 (Task 4.4) · model never sees intake images (Task 4.4 early return) · flush on `upload`/`/upload` (Task 4.2–4.3) · dedup+List-6 upload (reuses script, Task 3) · name→email report + Brevo total (Task 3 `formatReport`) · dry-run-first rollout (Task 4.2 `FIRST_RUN_DRY`, Task 5) · no auto-delete (Task 4.4 omits `cleanupFile`) · persistence across restart (Task 1 `data/intake-sessions.json`). ✓
- **No autonomous Brevo write:** idle only nudges; upload requires explicit trigger. ✓
- **Type consistency:** `IntakeContact`, `FlushSummary`, `LaneState` names consistent across tasks; `flushLane` returns `FlushSummary | null`; script JSON keys (`added`,`updated`,`fbGroupLeadsTotal`,`auditPath`) match `scripts/fb-intake-upload.ts` output. ✓
- **Anchor-line caveat:** `relay.ts` line numbers are approximate — match on the surrounding code shown, not the number.
