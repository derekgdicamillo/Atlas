// pv-newsletter.ts — PV MediSpa Vitality Unchained Newsletter Co-Pilot
// Collaborative draft system: Derek provides direction, Atlas drafts sections,
// content critic gates quality, GHL receives the final campaign draft.

// ============================================================
// SECTION 1: IMPORTS AND CONSTANTS
// ============================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { listPosts } from "./website.ts";
import { createEmailCampaign, type GHLCreateCampaignParams } from "./ghl.ts";
import { critiqueContent, formatCriticReport } from "./content-critic.ts";

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

// ============================================================
// SECTION 2: STATE TYPES AND LOAD/SAVE
// ============================================================

interface NewsletterTopicRecord {
  date: string;
  topic: string;
  pillar: Pillar;
}

export interface DraftSections {
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

// ============================================================
// SECTION 3: BLOG POST FETCHING
// ============================================================

interface BlogPostSummary {
  title: string;
  excerpt: string;
  link: string;
  date: string;
}

export async function getLatestBlogPosts(count = 3): Promise<BlogPostSummary[]> {
  try {
    const posts = await listPosts(count);
    if (!posts || posts.length === 0) return [];
    return posts.map((p) => ({
      title: typeof p.title === "object" ? p.title.rendered : String(p.title),
      excerpt: typeof p.excerpt === "object" ? p.excerpt.rendered : String(p.excerpt),
      link: p.link,
      date: p.date,
    }));
  } catch (err) {
    warn(`Failed to fetch blog posts: ${err}`);
    return [];
  }
}

// ============================================================
// SECTION 4: PILLAR ROTATION AND TOPIC DEDUP
// ============================================================

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
  if (state.lastTopics.length > 20) {
    state.lastTopics = state.lastTopics.slice(-20);
  }
}

// ============================================================
// SECTION 5: KICKOFF MESSAGE BUILDER
// ============================================================

export async function buildKickoffMessage(): Promise<string> {
  const state = loadState();
  const posts = await getLatestBlogPosts(3);
  const nextPillar = getNextPillar(state);

  let blogContext = "No recent blog posts found.";
  if (posts.length > 0) {
    const latest = posts[0];
    blogContext = `Your latest blog post: "${latest.title}" (${latest.date})`;
  }

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

// ============================================================
// SECTION 6: VOICE INSTRUCTIONS
// ============================================================

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

// ============================================================
// SECTION 7: SECTION DRAFTING
// ============================================================

export type GenerateFn = (prompt: string) => Promise<string>;

export async function draftSection(
  sectionName: keyof DraftSections,
  context: string,
  generateFn: GenerateFn
): Promise<{ text: string; criticReport: string }> {
  const prompt = buildSectionPrompt(sectionName, context);
  let text = await generateFn(prompt);

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

// ============================================================
// SECTION 8: HTML ASSEMBLY
// ============================================================

/** Convert basic markdown-style formatting to HTML paragraphs */
function md(text: string): string {
  if (!text) return "";
  // Bold: **text** -> <strong>text</strong>
  let html = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Double newlines -> paragraph breaks
  html = html
    .split(/\n\n+/)
    .map((para) => `<p style="margin:0 0 14px 0;">${para.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return html;
}

export function assembleNewsletterHtml(sections: DraftSections, subjectLine: string): string {
  const teal = "#7ec8e3";
  const dark = "#2d2d2d";
  const blue = "#2196F3";
  const lightGray = "#f5f5f5";
  const bodyFont = "Arial, Helvetica, sans-serif";

  const divider = `<hr style="border:none;border-top:2px solid ${teal};margin:24px 0;">`;

  const ctaButton = (label: string, url: string, color: string) =>
    `<a href="${url}" style="display:inline-block;background-color:${color};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:4px;font-family:${bodyFont};font-size:15px;font-weight:bold;margin:8px 4px 8px 0;">${label}</a>`;

  const sectionHtml = (content: string | null) =>
    content ? `\n${md(content)}\n` : "";

  const refsHtml =
    sections.references && sections.references.length > 0
      ? `${divider}
<h3 style="font-family:${bodyFont};color:${dark};font-size:16px;margin:0 0 10px 0;">References</h3>
<ol style="font-family:${bodyFont};font-size:13px;color:#555555;margin:0;padding-left:20px;">
${sections.references.map((r) => `  <li style="margin-bottom:6px;">${r}</li>`).join("\n")}
</ol>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subjectLine}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f0f0;font-family:${bodyFont};">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f0f0;">
    <tr>
      <td align="center" style="padding:20px 10px;">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:6px;overflow:hidden;">

          <!-- HEADER -->
          <tr>
            <td style="background-color:${dark};padding:28px 32px;text-align:center;">
              <h1 style="margin:0;font-family:${bodyFont};font-size:22px;color:${teal};letter-spacing:0.5px;">Derek's Vitality Unchained Newsletter</h1>
              <p style="margin:6px 0 0 0;font-family:${bodyFont};font-size:13px;color:#aaaaaa;">${subjectLine}</p>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="padding:32px 36px;color:${dark};font-family:${bodyFont};font-size:16px;line-height:1.6;">

              <!-- INTRO -->
              ${sectionHtml(sections.intro)}

              ${divider}

              <!-- EDUCATION -->
              ${sectionHtml(sections.education)}

              ${sections.patientStory ? divider : ""}

              <!-- PATIENT STORY -->
              ${sectionHtml(sections.patientStory)}

              ${sections.announcements ? divider : ""}

              <!-- ANNOUNCEMENTS -->
              ${sections.announcements ? `<h3 style="font-family:${bodyFont};color:${dark};font-size:17px;margin:0 0 12px 0;">Clinic News &amp; Announcements</h3>\n${sectionHtml(sections.announcements)}` : ""}

              ${divider}

              <!-- SIGN-OFF -->
              <p style="margin:0 0 6px 0;">To Living Life Unchained,</p>
              <p style="margin:0;font-weight:bold;">Derek DiCamillo, FNP</p>
              <p style="margin:4px 0 0 0;font-size:14px;color:#666666;">PV MediSpa &amp; Weight Loss</p>

              ${divider}

              <!-- CTAs -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="margin:0 0 12px 0;font-size:15px;font-weight:bold;color:${dark};">Ready to take the next step?</p>

                    <p style="margin:0 0 8px 0;font-size:14px;color:#555555;">Book a Weight Loss Consultation:</p>
                    ${ctaButton("Book My Consultation", "https://landing.pvmedispa.com/weightloss", blue)}

                    <p style="margin:16px 0 8px 0;font-size:14px;color:#555555;">Hormone Replacement Therapy:</p>
                    ${ctaButton("Men's HRT", "https://pvmedispa.com/mens-health", blue)}
                    ${ctaButton("Women's HRT", "https://pvmedispa.com/womens-health", blue)}

                    <p style="margin:16px 0 8px 0;font-size:14px;color:#555555;">Know someone who could use this?</p>
                    ${ctaButton("Share with a Friend", "{{email.share_link}}", teal)}
                  </td>
                </tr>
              </table>

              ${refsHtml}

            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background-color:${lightGray};padding:20px 36px;text-align:center;font-family:${bodyFont};font-size:12px;color:#888888;border-top:1px solid #dddddd;">
              <p style="margin:0 0 6px 0;">&copy; {{right_now.year}} {{location.name}}</p>
              <p style="margin:0 0 6px 0;">{{location.email}}</p>
              <p style="margin:0;">
                <a href="{{email.unsubscribe_link}}" style="color:#888888;text-decoration:underline;">Unsubscribe</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ============================================================
// SECTION 9: GHL PUSH
// ============================================================

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

// ============================================================
// SECTION 10: PUBLIC API FUNCTIONS
// ============================================================

/** Check whether the newsletter module has the minimum env vars it needs */
export function isPVNewsletterReady(): boolean {
  return !!(process.env.WP_SITE_URL && process.env.GHL_API_TOKEN);
}

/** Returns a quick summary of the current draft status for display in Telegram */
export function getDraftStatus(): {
  status: CurrentDraft["status"];
  topic: string | null;
  pillar: Pillar | null;
  weekOf: string;
  sectionsComplete: string[];
  ghlCampaignId: string | null;
} {
  const { currentDraft } = loadState();
  const sectionsComplete: string[] = [];
  if (currentDraft.sections.intro) sectionsComplete.push("intro");
  if (currentDraft.sections.education) sectionsComplete.push("education");
  if (currentDraft.sections.patientStory) sectionsComplete.push("patientStory");
  if (currentDraft.sections.announcements) sectionsComplete.push("announcements");

  return {
    status: currentDraft.status,
    topic: currentDraft.topic,
    pillar: currentDraft.pillar,
    weekOf: currentDraft.weekOf,
    sectionsComplete,
    ghlCampaignId: currentDraft.ghlCampaignId,
  };
}

/** Save a single drafted section to state */
export function updateDraftSection(
  section: keyof DraftSections,
  content: string
): void {
  const state = loadState();
  if (section === "references") {
    // references is string[], accept newline-delimited or JSON array
    try {
      state.currentDraft.sections.references = JSON.parse(content);
    } catch {
      state.currentDraft.sections.references = content
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } else {
    (state.currentDraft.sections as Record<string, string | null>)[section] = content;
  }
  if (state.currentDraft.status === "kickoff" || state.currentDraft.status === "idle") {
    state.currentDraft.status = "drafting";
  }
  saveState(state);
  log(`Section "${section}" updated (${typeof content === "string" ? content.length : 0} chars)`);
}

/** Set the topic and optionally the pillar for this week's draft */
export function setDraftTopic(topic: string, pillar?: Pillar): void {
  const state = loadState();
  state.currentDraft.topic = topic;
  if (pillar) state.currentDraft.pillar = pillar;
  if (state.currentDraft.status === "kickoff" || state.currentDraft.status === "idle") {
    state.currentDraft.status = "drafting";
  }
  saveState(state);
  log(`Draft topic set: "${topic}" (pillar: ${state.currentDraft.pillar ?? "unchanged"})`);
}

/** Set the email subject line for this week's draft */
export function setDraftSubjectLine(subject: string): void {
  const state = loadState();
  state.currentDraft.subjectLine = subject;
  saveState(state);
  log(`Subject line set: "${subject}"`);
}

/** Reset the current draft to idle, preserving rotation and topic history */
export function resetDraft(): void {
  const state = loadState();
  state.currentDraft = defaultDraft();
  saveState(state);
  log("Draft reset to idle");
}

/** Mark this week as skipped without advancing the pillar or recording a topic */
export function skipWeek(): void {
  const state = loadState();
  state.currentDraft = defaultDraft();
  state.currentDraft.status = "idle";
  saveState(state);
  log("Week skipped — draft cleared, pillar not advanced");
}

/** Build a plain-text preview of the assembled newsletter for Telegram review */
export function getAssembledPreview(): string {
  const state = loadState();
  const { sections, topic, subjectLine, weekOf, status } = state.currentDraft;

  if (status === "idle" || status === "kickoff") {
    return "No draft in progress. Use the kickoff command to start.";
  }

  const lines: string[] = [
    `**Week of:** ${weekOf}`,
    `**Subject:** ${subjectLine || "(not set)"}`,
    `**Topic:** ${topic || "(not set)"}`,
    "",
  ];

  if (sections.intro) {
    lines.push("**--- INTRO ---**");
    lines.push(sections.intro.substring(0, 300) + (sections.intro.length > 300 ? "..." : ""));
    lines.push("");
  }
  if (sections.education) {
    lines.push("**--- EDUCATION ---**");
    lines.push(sections.education.substring(0, 300) + (sections.education.length > 300 ? "..." : ""));
    lines.push("");
  }
  if (sections.patientStory) {
    lines.push("**--- PATIENT STORY ---**");
    lines.push(sections.patientStory.substring(0, 200) + (sections.patientStory.length > 200 ? "..." : ""));
    lines.push("");
  }
  if (sections.announcements) {
    lines.push("**--- ANNOUNCEMENTS ---**");
    lines.push(sections.announcements.substring(0, 200) + (sections.announcements.length > 200 ? "..." : ""));
    lines.push("");
  }
  if (sections.references.length > 0) {
    lines.push(`**References:** ${sections.references.length} listed`);
  }

  const complete = [
    sections.intro ? "intro" : null,
    sections.education ? "education" : null,
    sections.patientStory ? "patient story" : null,
    sections.announcements ? "announcements" : null,
  ]
    .filter(Boolean)
    .join(", ");

  lines.push("");
  lines.push(`**Sections complete:** ${complete || "none"}`);
  lines.push(`**Status:** ${status}`);

  return lines.join("\n");
}
