# PV Newsletter Co-Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a collaborative newsletter creation system in a Telegram topic thread that lets Derek and Atlas co-author the weekly "Derek's Vitality Unchained Newsletter" and push drafts to GHL.

**Architecture:** A new `src/pv-newsletter.ts` module handles state, drafting, and GHL campaign creation. `relay.ts` detects the Newsletter topic thread via `message_thread_id` and routes to the newsletter handler. A Tuesday 7 AM cron job kicks off each week's newsletter in the thread. GHL V2 Campaign API creates draft campaigns.

**Tech Stack:** TypeScript/Bun, Telegram Bot API (grammy), GHL V2 Email Campaign API, WordPress REST API (pvmedispa.com), content-critic.ts (Haiku)

**Spec:** `docs/superpowers/specs/2026-04-03-pv-newsletter-copilot-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/pv-newsletter.ts` | **Create** | Core module: state management, topic suggestion, section drafting, HTML assembly, GHL push |
| `src/ghl.ts` | **Modify** | Add GHL V2 Email Campaign API methods (create, update, schedule) |
| `src/relay.ts` | **Modify** | Add topic thread detection and newsletter message routing |
| `src/cron.ts` | **Modify** | Register Tuesday 7 AM kickoff cron job |
| `src/capability-registry.ts` | **Modify** | Register PV Newsletter capability section |
| `data/pv-newsletter-state.json` | **Create** (at runtime) | Persisted state: pillar rotation, draft sections, topic history |

### Pre-existing files used (read-only references):
- `src/website.ts` — WP REST API client for pvmedispa.com (`listPosts()`)
- `src/content-critic.ts` — Quality gate (`critiqueContent()`, `formatCriticReport()`)
- `src/maa-newsletter.ts` — Pattern reference for newsletter architecture
- `config/agents.json` — Agent config (no changes needed; topic routing is per-message, not per-agent)

### Important discoveries during research:
- **`memory/voice-guide.md` does not exist.** The humanizer skill references it but the file was never created. The plan accounts for this by using inline voice instructions in the drafting prompts based on Derek's known style from SOUL.md and USER.md.
- **The `/humanizer` skill does not exist as a standalone skill.** It's referenced in cron.ts prompts as a convention. The plan uses inline voice-matching instructions in the generation prompts instead.
- **PV MediSpa WordPress credentials are already configured** in `.env` (`WP_SITE_URL`, `WP_USER`, `WP_APP_PASSWORD`) and `src/website.ts` has full CRUD operations.
- **`sendTelegramMessage()` in cron.ts already supports `threadId` parameter.**

---

## Task 1: GHL V2 Email Campaign API Methods

**Files:**
- Modify: `src/ghl.ts` (add new exported functions at end of file)

This task adds the GHL V2 Campaign API methods that `pv-newsletter.ts` will call to create draft campaigns.

- [ ] **Step 1: Add GHL V2 campaign type definitions**

Add these types near the top of `src/ghl.ts`, after the existing type definitions:

```typescript
// ── GHL V2 Email Campaign Types ──────────────────────────────────────
export interface GHLEmailCampaign {
  id: string;
  name: string;
  status: string;
  subject?: string;
}

export interface GHLCreateCampaignParams {
  name: string;
  subject: string;
  htmlContent: string;
  senderEmail: string;
  senderName: string;
  /** GHL contact tag — recipients are contacts with this tag */
  contactTag?: string;
  /** GHL contact list ID — alternative to tag-based targeting */
  contactListId?: string;
}

export interface GHLCreateCampaignResponse {
  campaign?: { id: string };
  id?: string;
}
```

- [ ] **Step 2: Add GHL V2 fetch wrapper**

The V2 API may use a different version header. Add a dedicated wrapper below the existing `ghlFetch` function:

```typescript
/**
 * GHL V2 API fetch — same pattern as ghlFetch but with V2 base path.
 * The V2 email endpoints use /emails/public/v2/ prefix.
 */
async function ghlFetchV2<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  if (!GHL_TOKEN) throw new Error("GHL_API_TOKEN not configured");
  enforceGHLSafety(endpoint, options);
  const url = `${GHL_BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GHL_TOKEN}`,
      Version: GHL_VERSION,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(ghlBreaker.getTimeoutMs()),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GHL V2 ${endpoint} returned ${res.status}: ${body.substring(0, 300)}`);
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 3: Add createEmailCampaign function**

```typescript
/**
 * Create a draft email campaign via GHL V2 API.
 * Campaign is created in DRAFT status — must be scheduled/sent separately.
 */
export async function createEmailCampaign(
  locationId: string,
  params: GHLCreateCampaignParams
): Promise<{ ok: boolean; campaignId?: string; error?: string }> {
  try {
    const body: Record<string, unknown> = {
      name: params.name,
      subject: params.subject,
      htmlContent: params.htmlContent,
      sender: {
        fromName: params.senderName,
        fromEmail: params.senderEmail,
      },
      status: "draft",
    };

    // Tag-based targeting: GHL filters contacts by tag at send time
    if (params.contactTag) {
      body.contactTag = params.contactTag;
    }
    if (params.contactListId) {
      body.contactListId = params.contactListId;
    }

    const result = await ghlFetchV2<GHLCreateCampaignResponse>(
      `/emails/public/v2/locations/${locationId}/campaigns/email-campaign`,
      { method: "POST", body: JSON.stringify(body) }
    );

    const campaignId = result.campaign?.id || result.id;
    if (!campaignId) {
      return { ok: false, error: "Campaign created but no ID returned" };
    }

    return { ok: true, campaignId };
  } catch (err) {
    return { ok: false, error: `createEmailCampaign failed: ${err}` };
  }
}
```

- [ ] **Step 4: Add listEmailCampaigns function**

```typescript
/**
 * List email campaigns for a location. Useful for verifying draft was created.
 */
export async function listEmailCampaigns(
  locationId: string,
  status?: string
): Promise<{ ok: boolean; campaigns?: GHLEmailCampaign[]; error?: string }> {
  try {
    let endpoint = `/emails/public/v2/locations/${locationId}/campaigns/email-campaign`;
    if (status) endpoint += `?status=${status}`;
    const result = await ghlFetchV2<{ campaigns?: GHLEmailCampaign[] }>(endpoint);
    return { ok: true, campaigns: result.campaigns || [] };
  } catch (err) {
    return { ok: false, error: `listEmailCampaigns failed: ${err}` };
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/ghl.ts
git commit -m "feat(ghl): add V2 email campaign API methods (create, list)"
```

---

## Task 2: Newsletter State Management & Core Module

**Files:**
- Create: `src/pv-newsletter.ts`

This task creates the core module with state management, blog fetching, and the topic suggestion engine.

- [ ] **Step 1: Create pv-newsletter.ts with imports and constants**

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { listPosts } from "./website.ts";
import { createEmailCampaign, type GHLCreateCampaignParams } from "./ghl.ts";
import { critiqueContent, formatCriticReport } from "./content-critic.ts";

// ── Constants ────────────────────────────────────────────────────────
const DATA_DIR = join(import.meta.dir, "..", "data");
const STATE_FILE = join(DATA_DIR, "pv-newsletter-state.json");
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "PCdXIc8QjGmy4JmuiMrs";
const GHL_SENDER_EMAIL = process.env.PV_NEWSLETTER_SENDER_EMAIL || "derek@pvmedispa.com";
const GHL_SENDER_NAME = process.env.PV_NEWSLETTER_SENDER_NAME || "Derek DiCamillo, FNP";
const GHL_NEWSLETTER_TAG = process.env.PV_NEWSLETTER_TAG || "newsletter";

const PILLARS = [
  "Precision Weight Science",
  "Nourishing Health",
  "Dynamic Movement",
  "Mindful Wellness",
  "Functional Wellness",
] as const;

type Pillar = (typeof PILLARS)[number];

function log(msg: string): void {
  console.log(`[pv-newsletter] ${msg}`);
}
function warn(msg: string): void {
  console.warn(`[pv-newsletter] ${msg}`);
}
```

- [ ] **Step 2: Add state types and load/save functions**

```typescript
// ── State ────────────────────────────────────────────────────────────
interface NewsletterTopicRecord {
  date: string;
  topic: string;
  pillar: Pillar;
}

interface DraftSections {
  intro: string | null;
  education: string | null;
  patientStory: string | null;
  announcements: string | null;
  references: string[];
}

interface CurrentDraft {
  weekOf: string;
  status: "idle" | "kickoff" | "drafting" | "assembled" | "pushed";
  topic: string | null;
  pillar: Pillar | null;
  subjectLine: string | null;
  sections: DraftSections;
  ghlCampaignId: string | null;
}

interface PVNewsletterState {
  pillarRotationIndex: number;
  lastTopics: NewsletterTopicRecord[];
  currentDraft: CurrentDraft;
}

function defaultDraft(): CurrentDraft {
  return {
    weekOf: new Date().toISOString().split("T")[0],
    status: "idle",
    topic: null,
    pillar: null,
    subjectLine: null,
    sections: { intro: null, education: null, patientStory: null, announcements: null, references: [] },
    ghlCampaignId: null,
  };
}

function defaultState(): PVNewsletterState {
  return {
    pillarRotationIndex: 0,
    lastTopics: [],
    currentDraft: defaultDraft(),
  };
}

export function loadState(): PVNewsletterState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (err) {
    warn(`Failed to load state: ${err}`);
  }
  return defaultState();
}

export function saveState(state: PVNewsletterState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
```

- [ ] **Step 3: Add blog post fetching helper**

```typescript
// ── Blog Post Fetching ───────────────────────────────────────────────
interface BlogPostSummary {
  title: string;
  excerpt: string;
  link: string;
  date: string;
}

export async function getLatestBlogPosts(count = 3): Promise<BlogPostSummary[]> {
  try {
    const result = await listPosts(count);
    if (!result.success || !result.posts) return [];
    return result.posts.map((p: { title: string; excerpt: string; link: string; date: string }) => ({
      title: p.title,
      excerpt: p.excerpt,
      link: p.link,
      date: p.date,
    }));
  } catch (err) {
    warn(`Failed to fetch blog posts: ${err}`);
    return [];
  }
}
```

- [ ] **Step 4: Add pillar rotation and topic dedup logic**

```typescript
// ── Topic Selection ──────────────────────────────────────────────────
export function getNextPillar(state: PVNewsletterState): Pillar {
  return PILLARS[state.pillarRotationIndex % PILLARS.length];
}

export function advancePillar(state: PVNewsletterState): void {
  state.pillarRotationIndex = (state.pillarRotationIndex + 1) % PILLARS.length;
}

export function wasTopicUsedRecently(state: PVNewsletterState, topic: string, weeksBack = 6): boolean {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - weeksBack * 7);
  return state.lastTopics.some(
    (t) => t.topic.toLowerCase() === topic.toLowerCase() && new Date(t.date) > cutoff
  );
}

export function recordTopic(state: PVNewsletterState, topic: string, pillar: Pillar): void {
  state.lastTopics.push({ date: new Date().toISOString().split("T")[0], topic, pillar });
  // Keep last 20 entries
  if (state.lastTopics.length > 20) {
    state.lastTopics = state.lastTopics.slice(-20);
  }
}
```

- [ ] **Step 5: Add kickoff prompt builder**

```typescript
// ── Kickoff ──────────────────────────────────────────────────────────

/**
 * Build the Tuesday kickoff message. Called by the cron job.
 * Returns the message text to post in the Newsletter thread.
 */
export async function buildKickoffMessage(): Promise<string> {
  const state = loadState();
  const posts = await getLatestBlogPosts(3);
  const nextPillar = getNextPillar(state);

  let blogContext = "No recent blog posts found.";
  if (posts.length > 0) {
    const latest = posts[0];
    blogContext = `Your latest blog post: "${latest.title}" (${latest.date})`;
  }

  // Update state to kickoff status
  state.currentDraft = defaultDraft();
  state.currentDraft.status = "kickoff";
  state.currentDraft.pillar = nextPillar;
  saveState(state);

  const recentTopicList = state.lastTopics.slice(-4).map((t) => t.topic).join(", ");
  const avoidNote = recentTopicList
    ? `\n(Recent topics to avoid repeating: ${recentTopicList})`
    : "";

  return [
    `**Newsletter time.** ${blogContext} — fits the **${nextPillar}** pillar.`,
    "",
    `What's your angle this week? Got a patient story or personal experience to tie in?`,
    avoidNote,
  ]
    .filter(Boolean)
    .join("\n");
}
```

- [ ] **Step 6: Commit**

```bash
git add src/pv-newsletter.ts
git commit -m "feat(pv-newsletter): core module with state management, blog fetching, kickoff"
```

---

## Task 3: Section Drafting & Voice Matching

**Files:**
- Modify: `src/pv-newsletter.ts` (add drafting functions)

This task adds the functions that generate each newsletter section using Claude, with voice matching and quality gating.

- [ ] **Step 1: Add the voice instruction constant**

Since `memory/voice-guide.md` doesn't exist and the `/humanizer` skill isn't implemented, we embed Derek's voice instructions directly. Add this after the constants section:

```typescript
// ── Voice Guide (inline — no external voice-guide.md exists yet) ─────
const DEREK_VOICE_INSTRUCTIONS = `
Write in Derek DiCamillo's voice. He is a Family Nurse Practitioner who runs a medical weight loss clinic.
His style:
- Conversational and warm, like talking to a friend
- Uses personal stories and real-life examples
- Teaches complex medical concepts in plain English
- Bold key terms when introducing them
- Short paragraphs, easy to scan on mobile
- Occasionally references his own weight loss journey
- Mentions Esther (his wife) naturally when relevant
- Signs off variations of "To Living Life Unchained"
- No corporate speak, no AI-sounding filler
- No em dashes
- Uses "you" and "we" — talks WITH the reader, not AT them
- References his 5 Pillars framework naturally (not forced)
- Encouraging but honest — doesn't sugarcoat the hard parts
`.trim();
```

- [ ] **Step 2: Add the generateFn type and section drafting function**

```typescript
// ── Drafting ─────────────────────────────────────────────────────────
export type GenerateFn = (prompt: string) => Promise<string>;

/**
 * Draft a single newsletter section. Runs content critic and retries once if flagged.
 */
export async function draftSection(
  sectionName: keyof DraftSections,
  context: string,
  generateFn: GenerateFn
): Promise<{ text: string; criticReport: string }> {
  const prompt = buildSectionPrompt(sectionName, context);
  let text = await generateFn(prompt);

  // Quality gate
  const criticResult = await critiqueContent(text, "newsletter");
  const report = formatCriticReport(criticResult);

  if (!criticResult.passed) {
    log(`Section "${sectionName}" flagged by critic. Rewriting...`);
    const retryPrompt = `${prompt}\n\nPREVIOUS DRAFT WAS FLAGGED:\n${criticResult.issues.join("\n")}\n\nRewrite to fix these issues.`;
    text = await generateFn(retryPrompt);
  }

  return { text, criticReport: report };
}

function buildSectionPrompt(section: keyof DraftSections, context: string): string {
  const base = `${DEREK_VOICE_INSTRUCTIONS}\n\nYou are helping draft the "${section}" section of Derek's Vitality Unchained Newsletter.\n\n${context}`;

  switch (section) {
    case "intro":
      return `${base}\n\nWrite the opening section: greeting ("Hi Vitality Unchained Tribe,"), a personal hook that connects to the topic, and a bridge into the educational content. 3-5 short paragraphs. Conversational, warm, draws the reader in.`;

    case "education":
      return `${base}\n\nWrite the educational deep-dive section. Teach the concept clearly with bold key terms. Use analogies and plain English. Include 2-3 key takeaways. If citing studies or data, note the source so we can add references. 4-8 paragraphs.`;

    case "patientStory":
      return `${base}\n\nWrite a patient story section that ties back to the educational topic. Anonymize the patient. Weave the story into the lesson as proof that the approach works. End with an encouraging takeaway. 2-4 paragraphs.`;

    case "announcements":
      return `${base}\n\nWrite a brief announcements section for the newsletter. Keep it concise, 1-3 short items. If no announcements were provided, return an empty string.`;

    default:
      return base;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/pv-newsletter.ts
git commit -m "feat(pv-newsletter): section drafting with voice matching and content critic"
```

---

## Task 4: HTML Assembly & GHL Campaign Push

**Files:**
- Modify: `src/pv-newsletter.ts` (add assembly and push functions)

- [ ] **Step 1: Add HTML template assembly function**

```typescript
// ── HTML Assembly ────────────────────────────────────────────────────

/**
 * Assemble the full newsletter HTML from drafted sections.
 * Static sections (header, CTAs, footer) are hardcoded to match the GHL template.
 */
export function assembleNewsletterHtml(sections: DraftSections, subjectLine: string): string {
  const { intro, education, patientStory, announcements, references } = sections;

  // Convert markdown-style bold (**text**) to HTML <strong>
  const md = (text: string | null): string => {
    if (!text) return "";
    return text
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>");
  };

  const referencesHtml = references.length > 0
    ? `<h2 style="font-size:20px;font-weight:bold;margin:24px 0 12px;">References</h2>
       <p>${references.map((r, i) => `${i + 1}. ${r}`).join("<br>")}</p>`
    : "";

  const announcementsHtml = announcements
    ? `<h2 style="font-size:20px;font-weight:bold;margin:24px 0 12px;">Announcements</h2>
       <p>${md(announcements)}</p>`
    : "";

  return `
<div style="max-width:600px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#333;line-height:1.6;">
  <!-- Header Banner -->
  <div style="background:#2d2d2d;padding:30px 20px;text-align:center;">
    <h1 style="color:#7ec8e3;font-family:'Brush Script MT',cursive;font-size:36px;margin:0;">
      Derek's<br>
      <span style="font-family:Arial;letter-spacing:8px;font-size:14px;color:#fff;">V I T A L I T Y</span><br>
      <span style="color:#7ec8e3;font-size:48px;">Unchained</span><br>
      <span style="font-family:'Brush Script MT',cursive;font-size:24px;color:#ccc;">Newsletter</span>
    </h1>
  </div>

  <!-- Personal Intro -->
  <div style="padding:20px;">
    <p>${md(intro)}</p>
  </div>

  <!-- Educational Deep-Dive -->
  <div style="padding:0 20px;">
    <p>${md(education)}</p>
  </div>

  <!-- Patient Story -->
  ${patientStory ? `<div style="padding:0 20px;"><p>${md(patientStory)}</p></div>` : ""}

  <!-- Announcements -->
  <div style="padding:0 20px;">
    ${announcementsHtml}
  </div>

  <!-- Sign-off -->
  <div style="padding:20px;">
    <p>To Living Life Unchained,</p>
    <p><strong>Derek FNP</strong></p>
  </div>

  <hr style="border:none;border-top:2px solid #7ec8e3;margin:20px;">

  <!-- Referral CTA -->
  <div style="text-align:center;padding:20px;">
    <p>Know someone who would like to join our newsletter?</p>
    <p>Forward this email and they can join by clicking the link below!</p>
    <p>It's totally free!</p>
    <a href="{{link.newsletter_signup}}" style="display:inline-block;background:#7ec8e3;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;margin:10px 0;">
      Join Derek's Vitality Unchained Newsletter
    </a>
  </div>

  <hr style="border:none;border-top:2px solid #7ec8e3;margin:20px;">

  <!-- Service CTAs -->
  <div style="text-align:center;padding:20px;">
    <p>Interested in how we can help your Weight Loss Journey?</p>
    <p>Click below for your FREE GLP-1 Weight Loss Consultation.</p>
    <p>Or shoot us a text and we will get you scheduled. (928) 642-9067</p>
    <a href="https://pvmedispa.com/weight-loss-consultation/" style="display:inline-block;background:#2196F3;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;margin:10px 0;">
      Get My Free Weight Loss Consultation
    </a>
  </div>

  <div style="text-align:center;padding:10px 20px;">
    <p>Interested in seeing if your hormones are holding you back?</p>
    <p>Click below for your FREE Consultation.</p>
    <p>Or shoot us a text and we will get you scheduled. (928) 642-9067</p>
    <a href="https://pvmedispa.com/mens-hormone-replacement/" style="display:inline-block;background:#2196F3;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;margin:8px 4px;">
      Men's Hormone Replacement
    </a>
    <a href="https://pvmedispa.com/womens-hormone-replacement/" style="display:inline-block;background:#2196F3;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:bold;margin:8px 4px;">
      Women's Hormone Replacement
    </a>
  </div>

  <hr style="border:none;border-top:2px solid #7ec8e3;margin:20px;">

  <!-- References -->
  <div style="padding:0 20px;">
    ${referencesHtml}
  </div>

  <!-- Footer -->
  <div style="padding:20px;font-size:12px;color:#999;text-align:center;">
    <p>Copyright &copy; {{right_now.year}} {{location.name}}, All rights reserved.</p>
    <p><strong>Our e-mail address is:</strong><br>{{location.email}}</p>
    <p>You can unsubscribe here {{email.unsubscribe_link}}.</p>
  </div>
</div>`.trim();
}
```

- [ ] **Step 2: Add GHL campaign push function**

```typescript
// ── GHL Push ─────────────────────────────────────────────────────────

export async function pushDraftToGHL(): Promise<{ ok: boolean; campaignId?: string; error?: string }> {
  const state = loadState();
  const draft = state.currentDraft;

  if (!draft.sections.intro || !draft.sections.education) {
    return { ok: false, error: "At least intro and education sections are required" };
  }

  const subject = draft.subjectLine || `Vitality Unchained: ${draft.topic || "This Week's Insight"}`;
  const html = assembleNewsletterHtml(draft.sections, subject);

  const params: GHLCreateCampaignParams = {
    name: `Vitality Unchained — ${draft.weekOf}`,
    subject,
    htmlContent: html,
    senderEmail: GHL_SENDER_EMAIL,
    senderName: GHL_SENDER_NAME,
    contactTag: GHL_NEWSLETTER_TAG,
  };

  log(`Pushing draft to GHL: "${subject}"`);
  const result = await createEmailCampaign(GHL_LOCATION_ID, params);

  if (result.ok && result.campaignId) {
    // Update state
    draft.status = "pushed";
    draft.ghlCampaignId = result.campaignId;
    recordTopic(state, draft.topic || subject, draft.pillar || PILLARS[0]);
    advancePillar(state);
    saveState(state);

    log(`Draft pushed: campaign ${result.campaignId}`);
    return { ok: true, campaignId: result.campaignId };
  }

  return { ok: false, error: result.error };
}
```

- [ ] **Step 3: Add public getters for relay.ts to use**

```typescript
// ── Public API ───────────────────────────────────────────────────────

/** Check if PV Newsletter is configured and ready */
export function isPVNewsletterReady(): boolean {
  return !!(process.env.WP_SITE_URL && process.env.GHL_API_TOKEN);
}

/** Get the current draft status for display */
export function getDraftStatus(): { status: string; topic: string | null; sectionsComplete: string[] } {
  const state = loadState();
  const d = state.currentDraft;
  const complete: string[] = [];
  if (d.sections.intro) complete.push("intro");
  if (d.sections.education) complete.push("education");
  if (d.sections.patientStory) complete.push("patient story");
  if (d.sections.announcements) complete.push("announcements");
  return { status: d.status, topic: d.topic, sectionsComplete: complete };
}

/** Update a specific section in the current draft */
export function updateDraftSection(section: keyof DraftSections, content: string): void {
  const state = loadState();
  if (section === "references") {
    state.currentDraft.sections.references.push(content);
  } else {
    state.currentDraft.sections[section] = content;
  }
  state.currentDraft.status = "drafting";
  saveState(state);
}

/** Set the topic and pillar for the current draft */
export function setDraftTopic(topic: string, pillar?: Pillar): void {
  const state = loadState();
  state.currentDraft.topic = topic;
  if (pillar) state.currentDraft.pillar = pillar;
  state.currentDraft.status = "drafting";
  saveState(state);
}

/** Set the subject line for the current draft */
export function setDraftSubjectLine(subject: string): void {
  const state = loadState();
  state.currentDraft.subjectLine = subject;
  saveState(state);
}

/** Reset the current draft (start over) */
export function resetDraft(): void {
  const state = loadState();
  state.currentDraft = defaultDraft();
  saveState(state);
}

/** Mark the current week as skipped */
export function skipWeek(): void {
  const state = loadState();
  state.currentDraft = defaultDraft();
  state.currentDraft.status = "idle";
  saveState(state);
}

/** Get the full assembled text (plain text, not HTML) for Telegram preview */
export function getAssembledPreview(): string {
  const state = loadState();
  const s = state.currentDraft.sections;
  const parts: string[] = [];
  if (s.intro) parts.push("**Personal Intro:**\n" + s.intro);
  if (s.education) parts.push("**Educational Deep-Dive:**\n" + s.education);
  if (s.patientStory) parts.push("**Patient Story:**\n" + s.patientStory);
  if (s.announcements) parts.push("**Announcements:**\n" + s.announcements);
  if (s.references.length > 0) parts.push("**References:**\n" + s.references.map((r, i) => `${i + 1}. ${r}`).join("\n"));
  return parts.join("\n\n---\n\n") || "(No sections drafted yet)";
}
```

- [ ] **Step 4: Commit**

```bash
git add src/pv-newsletter.ts
git commit -m "feat(pv-newsletter): HTML assembly, GHL campaign push, public API"
```

---

## Task 5: Telegram Topic Thread Routing in relay.ts

**Files:**
- Modify: `src/relay.ts`

This task adds detection of the Newsletter topic thread and routes messages to the newsletter handler in the Claude prompt context.

- [ ] **Step 1: Add env var and import at top of relay.ts**

Near the existing env var declarations (around line 69), add:

```typescript
const PV_NEWSLETTER_TOPIC_ID = process.env.PV_NEWSLETTER_TOPIC_ID
  ? Number(process.env.PV_NEWSLETTER_TOPIC_ID)
  : null;
```

Near the existing imports, add:

```typescript
import {
  isPVNewsletterReady,
  getDraftStatus,
  getAssembledPreview,
  loadState as loadNewsletterState,
} from "./pv-newsletter.ts";
```

- [ ] **Step 2: Add topic thread detection in handleUserMessage**

In the `handleUserMessage` function (around line 2823), after the `chatId` is resolved, add thread detection:

```typescript
  const chatId = String(ctx.chat?.id || "");
  const threadId = ctx.message?.message_thread_id ?? null;
  const isNewsletterThread = PV_NEWSLETTER_TOPIC_ID != null && threadId === PV_NEWSLETTER_TOPIC_ID;
```

- [ ] **Step 3: Inject newsletter mode context into the Claude prompt**

In the section where the system prompt / context is assembled (look for where `modePrompt` or intent context is built, around line 3140-3180), add newsletter mode injection:

```typescript
  // Newsletter mode: inject when message comes from the Newsletter topic thread
  const newsletterContext = isNewsletterThread && isPVNewsletterReady()
    ? buildNewsletterModeContext()
    : "";
```

Add the context builder function elsewhere in relay.ts (near other context builders):

```typescript
function buildNewsletterModeContext(): string {
  const status = getDraftStatus();
  const state = loadNewsletterState();
  const preview = status.sectionsComplete.length > 0 ? getAssembledPreview() : "";

  return `
## NEWSLETTER MODE ACTIVE
You are in the PV Newsletter topic thread. You are collaborating with Derek on this week's "Derek's Vitality Unchained Newsletter."

### Current Draft Status
- Status: ${status.status}
- Topic: ${status.topic || "(not set yet)"}
- Sections complete: ${status.sectionsComplete.length > 0 ? status.sectionsComplete.join(", ") : "none"}
- Pillar: ${state.currentDraft.pillar || "(not set)"}

### Your Role
- You are a collaborative writing partner, not a task assistant
- Help Derek craft the newsletter section by section
- Write in Derek's voice: conversational, warm, educational, no AI filler, no em dashes
- Bold key terms when teaching concepts
- When drafting sections, post them for Derek's feedback
- When Derek says "looks good" or "send to GHL", use the [PV_NEWSLETTER_PUSH] tag to trigger the GHL draft
- When Derek says "start over", use [PV_NEWSLETTER_RESET] tag
- When Derek says "skip this week", use [PV_NEWSLETTER_SKIP] tag

### Draft Commands (emit these tags in your response)
- [PV_NEWSLETTER_TOPIC: topic text | pillar=Pillar Name] — set this week's topic
- [PV_NEWSLETTER_SECTION: section_name | content goes here] — save a drafted section (section_name: intro, education, patientStory, announcements)
- [PV_NEWSLETTER_SUBJECT: subject line text] — set the email subject line
- [PV_NEWSLETTER_PUSH] — push assembled draft to GHL as draft campaign
- [PV_NEWSLETTER_RESET] — clear current draft and start over
- [PV_NEWSLETTER_SKIP] — skip this week's newsletter
- [PV_NEWSLETTER_PREVIEW] — show the full assembled draft in chat

### Newsletter Structure
1. Personal Intro (greeting + personal hook + bridge to topic)
2. Educational Deep-Dive (teaching with bold key terms, data/studies)
3. Patient Story + Takeaway (anonymized example, encouraging close)
4. Announcements (optional — clinic news, community updates)

${preview ? `### Current Draft Preview\n${preview}` : ""}
`.trim();
}
```

- [ ] **Step 4: Include newsletterContext in the prompt assembly**

Find where `modePrompt` is concatenated into the final prompt (around line 3166-3180) and append `newsletterContext`:

```typescript
  // Add to the existing prompt context concatenation:
  // (find the line that builds the final contextual prompt and add newsletterContext)
  const additionalContext = [modePrompt, newsletterContext].filter(Boolean).join("\n\n");
```

The exact insertion point depends on the current prompt assembly structure. The newsletter context should be appended alongside `modePrompt` so Claude sees it in the system context.

- [ ] **Step 5: Add newsletter tag processing**

In the response tag processing section of relay.ts (where `[WP_POST:]`, `[GHL_TAG:]`, etc. are parsed from Claude's response), add handlers for newsletter tags:

```typescript
import {
  setDraftTopic,
  updateDraftSection,
  setDraftSubjectLine,
  pushDraftToGHL,
  resetDraft,
  skipWeek,
  getAssembledPreview,
} from "./pv-newsletter.ts";

// In the tag processing function (processResponseTags or equivalent):

// [PV_NEWSLETTER_TOPIC: topic | pillar=Pillar Name]
const topicMatch = responseText.match(/\[PV_NEWSLETTER_TOPIC:\s*(.+?)(?:\s*\|\s*pillar=(.+?))?\s*\]/i);
if (topicMatch) {
  const topic = topicMatch[1].trim();
  const pillar = topicMatch[2]?.trim() as Pillar | undefined;
  setDraftTopic(topic, pillar);
  log("pv-newsletter", `Topic set: "${topic}" (${pillar || "auto"})`);
}

// [PV_NEWSLETTER_SECTION: section_name | content]
const sectionMatches = responseText.matchAll(/\[PV_NEWSLETTER_SECTION:\s*(\w+)\s*\|\s*([\s\S]*?)\]/gi);
for (const match of sectionMatches) {
  const section = match[1].trim() as keyof import("./pv-newsletter.ts").DraftSections;
  const content = match[2].trim();
  updateDraftSection(section, content);
  log("pv-newsletter", `Section "${section}" saved (${content.length} chars)`);
}

// [PV_NEWSLETTER_SUBJECT: subject line]
const subjectMatch = responseText.match(/\[PV_NEWSLETTER_SUBJECT:\s*(.+?)\s*\]/i);
if (subjectMatch) {
  setDraftSubjectLine(subjectMatch[1].trim());
}

// [PV_NEWSLETTER_PUSH]
if (/\[PV_NEWSLETTER_PUSH\]/i.test(responseText)) {
  const result = await pushDraftToGHL();
  if (result.ok) {
    // Send confirmation to the newsletter thread
    const confirmMsg = `Draft pushed to GHL. Campaign ID: ${result.campaignId}\nReady for your visual check and Thursday send.`;
    await sendTelegramMessage(chatId, confirmMsg, threadId ?? undefined);
  } else {
    await sendTelegramMessage(chatId, `Failed to push to GHL: ${result.error}`, threadId ?? undefined);
  }
}

// [PV_NEWSLETTER_RESET]
if (/\[PV_NEWSLETTER_RESET\]/i.test(responseText)) {
  resetDraft();
}

// [PV_NEWSLETTER_SKIP]
if (/\[PV_NEWSLETTER_SKIP\]/i.test(responseText)) {
  skipWeek();
}
```

- [ ] **Step 6: Ensure replies go to the correct thread**

When replying in the newsletter thread, the bot must include `message_thread_id` in the Telegram API call. In the main response sending logic, pass the `threadId` through:

Find where `ctx.reply()` or `ctx.api.sendMessage()` is called for the response and ensure the `message_thread_id` is included when `isNewsletterThread` is true:

```typescript
// If the response is sent via ctx.reply(), Grammy supports reply_parameters.
// If sent via direct API call, add message_thread_id to the payload.
// The key is: when isNewsletterThread, always pass threadId to the send function.
```

The exact implementation depends on whether responses use `ctx.reply()` (which auto-replies in the same thread) or a custom `sendTelegramMessage()` call. If `ctx.reply()` is used, Grammy handles thread routing automatically. If a custom function is used, pass `threadId` as shown in Step 5.

- [ ] **Step 7: Commit**

```bash
git add src/relay.ts
git commit -m "feat(relay): newsletter topic thread routing and tag processing"
```

---

## Task 6: Tuesday Cron Job Registration

**Files:**
- Modify: `src/cron.ts`

- [ ] **Step 1: Add import**

Near the existing newsletter imports in cron.ts:

```typescript
import { isPVNewsletterReady, buildKickoffMessage } from "./pv-newsletter.ts";
```

- [ ] **Step 2: Register the Tuesday 7 AM cron job**

Inside `startCronJobs()`, near the other newsletter cron jobs (around line 2630), add:

```typescript
  // ── PV Newsletter Kickoff (Tuesday 7 AM) ─────────────────────────
  if (isPVNewsletterReady() && PV_NEWSLETTER_TOPIC_ID) {
    jobs.push(
      CronJob.from({
        cronTime: "0 7 * * 2",  // Tuesday 7:00 AM
        onTick: safeTick("pv-newsletter-kickoff", async () => {
          log("pv-newsletter", "Tuesday kickoff: building topic suggestion...");
          try {
            const message = await buildKickoffMessage();
            await sendTelegramMessage(
              DEREK_CHAT_ID,
              message,
              Number(PV_NEWSLETTER_TOPIC_ID)
            );
            log("pv-newsletter", "Kickoff message sent to Newsletter thread");
          } catch (err) {
            warn("pv-newsletter", `Kickoff failed: ${err}`);
          }
        }),
        timeZone: TIMEZONE,
      })
    );
    log("cron", "Registered: pv-newsletter-kickoff (Tue 7:00 AM)");
  }

  // ── PV Newsletter Wednesday Nudge (Wed 9 AM) ─────────────────────
  if (isPVNewsletterReady() && PV_NEWSLETTER_TOPIC_ID) {
    jobs.push(
      CronJob.from({
        cronTime: "0 9 * * 3",  // Wednesday 9:00 AM
        onTick: safeTick("pv-newsletter-nudge", async () => {
          const { loadState } = await import("./pv-newsletter.ts");
          const state = loadState();
          // Only nudge if kickoff happened but no drafting started
          if (state.currentDraft.status === "kickoff") {
            log("pv-newsletter", "Wednesday nudge: no response to kickoff yet");
            await sendTelegramMessage(
              DEREK_CHAT_ID,
              "Still working on the newsletter? Let me know your angle or I can draft one based on the blog post.",
              Number(PV_NEWSLETTER_TOPIC_ID)
            );
          }
        }),
        timeZone: TIMEZONE,
      })
    );
    log("cron", "Registered: pv-newsletter-nudge (Wed 9:00 AM)");
  }
```

- [ ] **Step 3: Add PV_NEWSLETTER_TOPIC_ID env var reference**

Near the top of cron.ts where env vars are declared:

```typescript
const PV_NEWSLETTER_TOPIC_ID = process.env.PV_NEWSLETTER_TOPIC_ID || "";
```

- [ ] **Step 4: Commit**

```bash
git add src/cron.ts
git commit -m "feat(cron): register PV newsletter Tuesday kickoff and Wednesday nudge"
```

---

## Task 7: Capability Registry Registration

**Files:**
- Modify: `src/capability-registry.ts`

- [ ] **Step 1: Add PV Newsletter capability declaration**

In the `ALL_CAPABILITIES` array, add a new entry:

```typescript
  {
    section: "PV Newsletter Co-Pilot",
    description: "Collaborative weekly newsletter creation via Telegram topic thread with GHL V2 draft push",
    can: [
      "Tuesday 7 AM smart topic suggestion (blog + pillar rotation + trending news)",
      "collaborative section-by-section drafting in Newsletter topic thread",
      "voice-matched content generation (Derek's teaching style)",
      "content critic quality gate on all draft sections",
      "HTML assembly matching GHL template structure",
      "push assembled draft to GHL as draft campaign via V2 Email Campaign API",
      "tag-based recipient targeting (newsletter tag)",
      "pillar rotation tracking across weeks",
      "topic dedup (6-week lookback)",
      "Wednesday morning nudge if no response to kickoff",
      "start over, skip week, subject line override commands",
    ],
    cannot: [
      "send newsletters directly (draft only, Derek sends from GHL)",
      "include images/diagrams (text content only, images added in GHL)",
      "modify GHL email template design (content only)",
    ],
    notes: "Operates in dedicated Telegram topic thread. Env: PV_NEWSLETTER_TOPIC_ID",
    module: "src/pv-newsletter.ts",
    tags: [
      "[PV_NEWSLETTER_TOPIC: topic | pillar=Name]",
      "[PV_NEWSLETTER_SECTION: name | content]",
      "[PV_NEWSLETTER_SUBJECT: subject]",
      "[PV_NEWSLETTER_PUSH]",
      "[PV_NEWSLETTER_RESET]",
      "[PV_NEWSLETTER_SKIP]",
      "[PV_NEWSLETTER_PREVIEW]",
    ],
  },
```

- [ ] **Step 2: Commit**

```bash
git add src/capability-registry.ts
git commit -m "feat(capability-registry): register PV Newsletter Co-Pilot"
```

---

## Task 8: Environment Setup & Manual Testing

**Files:**
- Modify: `.env` (add new env vars — do NOT commit this file)

This task covers the one-time setup Derek needs to do and the manual testing sequence.

- [ ] **Step 1: Enable Topics in the Telegram group**

Derek must do this manually in Telegram:
1. Open the Atlas group chat
2. Tap the group name → Edit → Topics → Enable
3. Create a topic called "Newsletter"
4. Note the topic's `message_thread_id` (Atlas can detect this by looking at the first message sent in the topic)

- [ ] **Step 2: Add env vars to .env**

```bash
# PV Newsletter Co-Pilot
PV_NEWSLETTER_TOPIC_ID=<thread_id_from_step_1>
PV_NEWSLETTER_SENDER_EMAIL=derek@pvmedispa.com
PV_NEWSLETTER_SENDER_NAME=Derek DiCamillo, FNP
PV_NEWSLETTER_TAG=newsletter
```

- [ ] **Step 3: Verify GHL PIT token has email campaign scopes**

Check if the existing PIT token (`GHL_API_TOKEN`) supports the V2 email campaign endpoints. If not, Derek needs to update it in GHL Settings → Integrations → Private Integration Token → add email marketing scopes.

- [ ] **Step 4: Manual test sequence**

Test the full flow:

1. **State test:** Restart Atlas (`pm2 restart atlas`). Check logs for "Registered: pv-newsletter-kickoff" and "Registered: pv-newsletter-nudge".

2. **Kickoff test:** In the Newsletter topic thread, have Atlas trigger a manual kickoff (or wait for Tuesday). Verify the topic suggestion message appears in the correct thread.

3. **Drafting test:** Reply with a topic angle. Verify Atlas enters newsletter mode (the response should be writing-partner style, not task-assistant style). Check that the context includes "NEWSLETTER MODE ACTIVE."

4. **Section save test:** After Atlas drafts a section, verify `data/pv-newsletter-state.json` updates with the section content.

5. **GHL push test:** Say "looks good" or "send to GHL." Verify:
   - GHL campaign created in draft status
   - Confirmation message appears in the thread
   - State file shows `status: "pushed"` and `ghlCampaignId` populated

6. **GHL visual check:** Open GHL, find the draft campaign, verify HTML renders correctly.

- [ ] **Step 5: Commit all remaining changes**

```bash
git add src/pv-newsletter.ts src/ghl.ts src/relay.ts src/cron.ts src/capability-registry.ts
git commit -m "feat(pv-newsletter): complete PV Newsletter Co-Pilot integration"
```

---

## Summary

| Task | Description | Estimated Time |
|------|-------------|----------------|
| 1 | GHL V2 Email Campaign API methods | 10 min |
| 2 | Core module: state, blog fetch, kickoff | 15 min |
| 3 | Section drafting with voice matching | 10 min |
| 4 | HTML assembly & GHL push | 15 min |
| 5 | Telegram topic thread routing | 20 min |
| 6 | Tuesday cron job registration | 5 min |
| 7 | Capability registry entry | 5 min |
| 8 | Env setup & manual testing | 15 min |
