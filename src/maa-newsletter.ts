/**
 * Atlas — TMAA Newsletter Automation
 *
 * Two newsletter tiers distributed via Brevo:
 * - Free ("This Week at TMAA"): Weekly Saturday 9 AM to FB Group Leads
 * - Paid ("TMAA Insider"): Biweekly Sunday 9 AM to TMAA Members
 *
 * Approval flow: Wed draft -> Telegram approval -> Sat/Sun send
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { info, warn, error as logError } from "./logger.ts";
import { getChromeUA } from "./chrome-ua.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// CONFIG
// ============================================================

const MAA_SITE_URL = process.env.MAA_WP_SITE_URL || "https://medicalaestheticsassociation.com";
const MAA_WP_USER = process.env.MAA_WP_USER || "";
const MAA_WP_APP_PASSWORD = process.env.MAA_WP_APP_PASSWORD || "";
const MAA_DASHBOARD_TOKEN = process.env.MAA_DASHBOARD_TOKEN || "";
const SAGE_API_URL = `${MAA_SITE_URL}/wp-json/maa/v1/dashboard/sage`;
const WP_API_BASE = `${MAA_SITE_URL}/wp-json/wp/v2`;
const API_TIMEOUT = 30_000;

const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const BREVO_API_URL = "https://api.brevo.com/v3";
const BREVO_FREE_LIST_IDS = (process.env.BREVO_FREE_LIST_IDS || process.env.BREVO_FREE_LIST_ID || "0")
  .split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
const BREVO_PAID_LIST_ID = parseInt(process.env.BREVO_PAID_LIST_ID || "0", 10);
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || "The Medical Aesthetics Association";
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || "theoffice@medicalaestheticsassociation.com";
const BREVO_FREE_TEMPLATE_ID = parseInt(process.env.BREVO_FREE_TEMPLATE_ID || "0", 10);
const BREVO_PAID_TEMPLATE_ID = parseInt(process.env.BREVO_PAID_TEMPLATE_ID || "0", 10);

const DATA_DIR = join(process.env.PROJECT_DIR || process.cwd(), "data");
const STATE_FILE = join(DATA_DIR, "maa-newsletter-state.json");

const APPROVAL_EMAILS = ["derekgdicamillo@gmail.com", "esther.dicamillo@gmail.com"];

const CTA_OPTIONS = [
  { label: "Join TMAA", url: `${MAA_SITE_URL}/join` },
  { label: "Try S.A.G.E.", url: `${MAA_SITE_URL}/advisor` },
  { label: "Browse Resources", url: `${MAA_SITE_URL}/resources` },
];

// ============================================================
// TYPES
// ============================================================

interface NewsletterState {
  freeApproved: boolean;
  paidApproved: boolean;
  freeCampaignId: number | null;
  paidCampaignId: number | null;
  lastFreeSent: string | null;
  lastPaidSent: string | null;
  paidWeekToggle: boolean;
  lastPartnerIndex: number;
  lastCtaIndex: number;
  recentSageTopics?: string[]; // last 6 weeks of featured SAGE topics for dedup
}

interface WPPost {
  id: number;
  title: { rendered: string };
  excerpt: { rendered: string };
  link: string;
  date: string;
  categories?: number[];
}

interface SageTopic {
  topic: string;
  count: number;
}

interface SageQuestion {
  question: string;
  count: number;
  date: string;
}

interface SageDashboardResponse {
  available: boolean;
  top_topics: SageTopic[];
  top_questions: SageQuestion[];
}

interface Partner {
  id: string;
  name: string;
  contact_name: string | null;
  description: string;
  discount_code: string | null;
  discount_description: string | null;
  url: string | null;
  category: string | null;
  active: boolean;
}

interface BrevoCreateCampaignResponse {
  id: number;
}

interface DraftResult {
  success: boolean;
  campaignId?: number;
  error?: string;
  subject?: string;
}

type GenerateFn = (prompt: string) => Promise<string>;

// ============================================================
// STATE MANAGEMENT
// ============================================================

function loadState(): NewsletterState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (err) {
    warn("maa-newsletter", `Failed to load state: ${err}`);
  }
  return {
    freeApproved: false,
    paidApproved: false,
    freeCampaignId: null,
    paidCampaignId: null,
    lastFreeSent: null,
    lastPaidSent: null,
    paidWeekToggle: true,
    lastPartnerIndex: 0,
    lastCtaIndex: 0,
  };
}

function saveState(state: NewsletterState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// READINESS CHECK
// ============================================================

export function isNewsletterReady(): boolean {
  return !!(BREVO_API_KEY && MAA_WP_USER && MAA_WP_APP_PASSWORD);
}

// ============================================================
// APPROVAL HANDLERS
// ============================================================

export function approveNewsletter(tier: "free" | "paid"): { success: boolean; message: string } {
  const state = loadState();

  if (tier === "free") {
    if (!state.freeCampaignId) {
      return { success: false, message: "No free newsletter draft pending. Draft is created Wednesdays at 8 AM." };
    }
    if (state.freeApproved) {
      return { success: false, message: "Free newsletter already approved. It will send Saturday at 9 AM." };
    }
    state.freeApproved = true;
    saveState(state);
    return { success: true, message: "Free newsletter approved. It will send Saturday at 9 AM MST." };
  } else {
    if (!state.paidCampaignId) {
      return { success: false, message: "No paid newsletter draft pending. Draft is created Wednesdays at 8 AM on paid weeks." };
    }
    if (state.paidApproved) {
      return { success: false, message: "Paid newsletter already approved. It will send Sunday at 9 AM." };
    }
    state.paidApproved = true;
    saveState(state);
    return { success: true, message: "Paid newsletter approved. It will send Sunday at 9 AM MST." };
  }
}

// ============================================================
// WP REST API — Fetch Recent Blog Posts
// ============================================================

function wpAuthHeader(): string {
  return `Basic ${Buffer.from(`${MAA_WP_USER}:${MAA_WP_APP_PASSWORD}`).toString("base64")}`;
}

async function fetchRecentPosts(count: number): Promise<WPPost[]> {
  try {
    const res = await fetch(
      `${WP_API_BASE}/posts?per_page=${count}&orderby=date&order=desc&_fields=id,title,excerpt,link,date,categories`,
      {
        headers: {
          Authorization: wpAuthHeader(),
          "User-Agent": await getChromeUA(),
        },
        signal: AbortSignal.timeout(API_TIMEOUT),
      }
    );
    if (!res.ok) {
      warn("maa-newsletter", `WP posts API ${res.status}`);
      return [];
    }
    // Guard: SiteGround CAPTCHA returns HTTP 202 + text/html (passes res.ok)
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      const body = await res.text().catch(() => "");
      const isCaptcha = body.includes("sgcaptcha") || body.includes("/.well-known/");
      if (isCaptcha) {
        const ipMatch = body.match(/ipc:(\d+\.\d+\.\d+\.\d+)/);
        warn("maa-newsletter", `WP CAPTCHA challenge (HTTP ${res.status}). Whitelist Atlas IP ${ipMatch?.[1] ?? "unknown"} in SiteGround Security.`);
      } else {
        warn("maa-newsletter", `WP posts returned non-JSON (HTTP ${res.status}, ${ct}): ${body.substring(0, 150)}`);
      }
      return [];
    }
    return (await res.json()) as WPPost[];
  } catch (err) {
    warn("maa-newsletter", `Failed to fetch WP posts: ${err}`);
    return [];
  }
}

/**
 * Fetch more posts than needed and pick a diverse set.
 * Uses keyword overlap, WP category diversity, and SAGE topic relevance
 * to avoid near-duplicate topics and prioritize trending content.
 */
async function fetchDiversePosts(targetCount: number, sageTopics?: string[]): Promise<WPPost[]> {
  const pool = await fetchRecentPosts(Math.max(targetCount * 3, 10));
  if (pool.length <= targetCount) return pool;

  const stopWords = new Set(["the", "a", "an", "to", "for", "of", "in", "and", "or", "your", "how", "what", "why", "is", "are", "with", "can", "this", "that"]);

  function titleKeywords(title: string): Set<string> {
    return new Set(
      stripHtml(title).toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !stopWords.has(w))
    );
  }

  function similarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let overlap = 0;
    for (const w of a) if (b.has(w)) overlap++;
    return overlap / Math.min(a.size, b.size);
  }

  // Score posts by SAGE relevance (boost posts matching trending topics)
  function sageRelevance(post: WPPost): number {
    if (!sageTopics || sageTopics.length === 0) return 0;
    const title = stripHtml(post.title.rendered).toLowerCase();
    const excerpt = stripHtml(post.excerpt.rendered).toLowerCase();
    const text = `${title} ${excerpt}`;
    return sageTopics.filter((t) => {
      const words = t.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      return words.some((w) => text.includes(w));
    }).length;
  }

  // Sort pool: SAGE-relevant posts first, then by date
  const scored = pool.map((p) => ({ post: p, sage: sageRelevance(p) }));
  scored.sort((a, b) => b.sage - a.sage || 0); // stable sort preserves date order within ties

  const selected: WPPost[] = [scored[0].post]; // best match or newest
  const selectedKw = [titleKeywords(scored[0].post.title.rendered)];
  const usedCategories = new Set(scored[0].post.categories || []);

  for (const { post } of scored.slice(1)) {
    if (selected.length >= targetCount) break;
    const kw = titleKeywords(post.title.rendered);
    const maxSim = Math.max(...selectedKw.map((s) => similarity(s, kw)));

    // Require low keyword overlap AND prefer different categories
    const postCats = new Set(post.categories || []);
    const categoryOverlap = [...postCats].some((c) => usedCategories.has(c));
    const threshold = categoryOverlap ? 0.35 : 0.5; // stricter if same category

    if (maxSim < threshold) {
      selected.push(post);
      selectedKw.push(kw);
      for (const c of postCats) usedCategories.add(c);
    }
  }

  // Backfill if needed
  if (selected.length < targetCount) {
    for (const { post } of scored) {
      if (selected.length >= targetCount) break;
      if (!selected.some((s) => s.id === post.id)) {
        selected.push(post);
      }
    }
  }

  return selected;
}

// ============================================================
// SAGE Dashboard — Trending Themes
// ============================================================

async function fetchSageData(): Promise<SageDashboardResponse | null> {
  if (!MAA_DASHBOARD_TOKEN) {
    warn("maa-newsletter", "MAA_DASHBOARD_TOKEN not set, skipping SAGE data");
    return null;
  }
  try {
    const res = await fetch(`${SAGE_API_URL}?period=30d`, {
      headers: {
        Authorization: `Bearer ${MAA_DASHBOARD_TOKEN}`,
        "User-Agent": await getChromeUA(),
      },
      signal: AbortSignal.timeout(API_TIMEOUT),
    });
    if (!res.ok) {
      warn("maa-newsletter", `SAGE API ${res.status}`);
      return null;
    }
    const raw = (await res.json()) as any;
    return normalizeSageResponse(raw);
  } catch (err) {
    warn("maa-newsletter", `SAGE API failed: ${err}`);
    return null;
  }
}

function normalizeSageResponse(raw: any): SageDashboardResponse {
  if (Array.isArray(raw?.top_questions)) {
    return raw as SageDashboardResponse;
  }
  const flat: SageQuestion[] = [];
  if (Array.isArray(raw?.question_insights)) {
    for (const topic of raw.question_insights) {
      const intents = Array.isArray(topic?.intents) ? topic.intents : [];
      for (const intent of intents) {
        const questions = Array.isArray(intent?.questions) ? intent.questions : [];
        for (const q of questions) {
          if (typeof q?.text === "string" && q.text.trim().length > 0) {
            flat.push({
              question: q.text,
              count: typeof intent?.count === "number" ? intent.count : 1,
              date: typeof q?.date === "string" ? q.date : "",
            });
          }
        }
      }
    }
  }
  return {
    available: raw?.available !== false,
    top_topics: Array.isArray(raw?.top_topics) ? raw.top_topics : [],
    top_questions: flat,
  };
}

// ============================================================
// Partner Data — Supabase
// ============================================================

async function fetchActivePartners(supabase: SupabaseClient): Promise<Partner[]> {
  try {
    const { data, error } = await supabase
      .from("tmaa_partners")
      .select("id, name, contact_name, description, discount_code, discount_description, url, category, active")
      .eq("active", true)
      .order("created_at", { ascending: true });

    if (error) {
      logError("maa-newsletter", `Supabase partner query failed: ${error.message}`);
      return [];
    }
    return (data || []) as Partner[];
  } catch (err) {
    logError("maa-newsletter", `Partner fetch failed: ${err}`);
    return [];
  }
}

function getNextPartner(partners: Partner[], state: NewsletterState): Partner | null {
  if (partners.length === 0) return null;
  const idx = state.lastPartnerIndex % partners.length;
  return partners[idx];
}

function getNextCta(state: NewsletterState): { label: string; url: string } {
  const idx = state.lastCtaIndex % CTA_OPTIONS.length;
  return CTA_OPTIONS[idx];
}

// ============================================================
// BREVO API CLIENT
// ============================================================

async function brevoRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${BREVO_API_URL}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": BREVO_API_KEY,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(API_TIMEOUT),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Brevo ${res.status}: ${text.substring(0, 300)}` };
    }
    if (res.status === 204) return { ok: true };
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: `Brevo request failed: ${err}` };
  }
}

async function createCampaign(
  subject: string,
  htmlContent: string,
  listIds: number[],
  _templateId: number
): Promise<{ ok: boolean; campaignId?: number; error?: string }> {
  const result = await brevoRequest<BrevoCreateCampaignResponse>("POST", "/emailCampaigns", {
    name: `${subject} — ${new Date().toISOString().split("T")[0]}`,
    subject,
    sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
    htmlContent,
    recipients: { listIds },
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, campaignId: result.data?.id };
}

async function sendTestEmail(campaignId: number): Promise<{ ok: boolean; error?: string }> {
  return brevoRequest("POST", `/emailCampaigns/${campaignId}/sendTest`, {
    emailTo: APPROVAL_EMAILS,
  });
}

async function sendCampaign(campaignId: number): Promise<{ ok: boolean; error?: string }> {
  return brevoRequest("POST", `/emailCampaigns/${campaignId}/sendNow`);
}

// ============================================================
// CONTENT GENERATION
// ============================================================

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&nbsp;/g, " ")
    .trim();
}

function extractHtmlContent(raw: string): string {
  const fenced = raw.match(/```html\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();
  const tableMatch = raw.match(/(<table[\s\S]*<\/table>)/i);
  if (tableMatch) return tableMatch[1].trim();
  return raw.trim();
}

function pickSageTopics(
  sageData: SageDashboardResponse | null,
  posts: WPPost[],
  recentTopics: string[]
): { lessonTopic: SageTopic | null; winTopic: SageTopic | null; peerQuestions: SageQuestion[] } {
  if (!sageData?.available || sageData.top_topics.length === 0) {
    return { lessonTopic: null, winTopic: null, peerQuestions: [] };
  }

  const postTitles = posts.map((p) => stripHtml(p.title.rendered).toLowerCase()).join(" ");
  const recentLower = recentTopics.map((t) => t.toLowerCase());

  // Filter out topics covered by blog posts AND recently featured
  const fresh = sageData.top_topics.filter((t) => {
    const tLow = t.topic.toLowerCase();
    const coveredByPost = postTitles.includes(tLow.split(" ")[0]);
    const recentlyFeatured = recentLower.some((r) => r === tLow);
    return !coveredByPost && !recentlyFeatured;
  });

  const pool = fresh.length >= 2 ? fresh : sageData.top_topics;
  const lessonTopic = pool[0] || null;
  const winTopic = pool.find((t) => t !== lessonTopic) || pool[1] || null;

  // Gather real peer questions (prefer ones related to lesson topic)
  const genericPatterns = /^(hello|hi |hey |i'm ready|help me with|what can you)/i;
  const allQs = (sageData.top_questions || []).filter(
    (q) => q.question.length > 30 && q.question.length < 300 && !genericPatterns.test(q.question.trim())
  );
  const lessonWords = lessonTopic ? lessonTopic.topic.toLowerCase().split(/\W+/).filter((w) => w.length > 3) : [];
  const related = allQs.filter((q) => lessonWords.some((w) => q.question.toLowerCase().includes(w)));
  const peerQuestions = related.length >= 2 ? related.slice(0, 3) : allQs.slice(0, 3);

  return { lessonTopic, winTopic, peerQuestions };
}

function buildFreePrompt(
  posts: WPPost[],
  sageData: SageDashboardResponse | null,
  cta: { label: string; url: string },
  recentSageTopics: string[]
): string {
  const postList = posts
    .map((p) => `- "${stripHtml(p.title.rendered)}" — ${stripHtml(p.excerpt.rendered)} (${p.link})`)
    .join("\n");

  const { lessonTopic, winTopic, peerQuestions } = pickSageTopics(sageData, posts, recentSageTopics);

  // Build educational blocks
  let lessonBlock: string;
  let peerQuestionsBlock: string;
  let quickWinBlock: string;

  if (lessonTopic) {
    const questionContext = peerQuestions.length > 0
      ? `Real questions practitioners are asking about this:\n${peerQuestions.map((q) => `- "${q.question}"`).join("\n")}\nAddress the core concern behind these questions.`
      : `"${lessonTopic.topic}" has ${lessonTopic.count} conversations this month. Write about the most common misconception or mistake practitioners make here.`;

    lessonBlock = `TOPIC: "${lessonTopic.topic}" (${lessonTopic.count} community conversations this month)
${questionContext}
Write as a standalone mini-article: problem → insight → takeaway. Use a real-world example or benchmark number. 250-300 words.`;

    peerQuestionsBlock = peerQuestions.length >= 2
      ? `Use these real practitioner questions (reworded naturally) as section headers or callout boxes:\n${peerQuestions.map((q) => `- "${q.question}"`).join("\n")}`
      : "";

    const winQs = winTopic ? (sageData?.top_questions || [])
      .filter((q) => winTopic.topic.toLowerCase().split(/\W+/).some((w) => w.length > 3 && q.question.toLowerCase().includes(w)))
      .slice(0, 1) : [];
    quickWinBlock = winQs.length > 0
      ? `A practitioner recently asked: "${winQs[0].question}" — build your quick win around answering this with a specific, implementable action step (include exact steps, not vague advice).`
      : winTopic
        ? `Topic: "${winTopic.topic}" — give one specific, implementable 15-minute action step with exact steps.`
        : "Give one specific 15-minute action step to audit service pricing against local competitors. Include the exact steps.";
  } else {
    lessonBlock = "TOPIC: Write about a common mistake new aesthetic practitioners make with treatment pricing — undercharging relative to market, not accounting for consumable costs, or discounting too aggressively. Use a specific dollar example. 250-300 words.";
    peerQuestionsBlock = "";
    quickWinBlock = "Give one specific 15-minute action step a practitioner can take this week to audit their service pricing against local competitors. Include exact steps.";
  }

  return `You are writing the weekly free newsletter for The Medical Aesthetics Association (TMAA).
Newsletter name: "This Week at TMAA"
Audience: Aesthetic practitioners (NPs, RNs, PAs, estheticians) who are NOT yet TMAA members.
Tone: Warm, knowledgeable, genuinely helpful. Like a trusted colleague sharing what they've learned. No hype, no hard sell.

THIS IS AN EDUCATION-FIRST NEWSLETTER. The primary value is teaching, not linking. Blog posts support the education — they are not the centerpiece.

STRUCTURE (follow this exactly):

1. **Opening Hook** (2-3 sentences): Lead with a specific, surprising insight or counterintuitive truth related to this week's main topic. Make readers think "wait, really?" Avoid generic greetings.

2. **The Practitioner's Edge** (THIS IS THE CENTERPIECE — 250-300 words): A standalone educational mini-article that teaches something practitioners can use immediately. Structure:
   - **Bold claim or question as headline** (pull from the peer questions below if available)
   - **The problem/misconception** (2-3 sentences): What most practitioners get wrong and why it costs them
   - **The insight** (3-4 sentences): What the data/experience actually shows. Include a specific number, benchmark, or case example. Reference one of the blog posts below if it supports the point (with link).
   - **The takeaway** (2-3 sentences): What to do differently starting this week — specific enough to act on
${lessonBlock}
${peerQuestionsBlock}
Do NOT mention SAGE, AI, dashboards, or data sources. Frame insights as community wisdom, peer patterns, or your own expertise.

3. **What Your Peers Are Asking** (2-3 real questions): Present these as a callout/highlight box. Each question gets a 1-2 sentence answer that's genuinely useful (not a teaser). This shows the value of community — peers are solving real problems together.
${peerQuestions.length > 0
    ? peerQuestions.map((q) => `- "${q.question}"`).join("\n")
    : "Use 2-3 common aesthetic practice questions (pricing strategy, patient retention, treatment protocols)."}

4. **Further Reading** (3 posts, compact): Each post gets ONE sentence that names the specific problem it solves + "Read more →" link. These support the education above, not replace it.
${postList}

5. **Quick Win of the Week** (4-5 sentences): One concrete action step with enough detail to execute in under 15 minutes. Include the EXACT steps — not "review your pricing" but "pull up your top 3 services, compare your price to the top Google result in your zip code, and adjust any service where you're more than 20% below market."
${quickWinBlock}

6. **CTA**: One warm sentence inviting them to "${cta.label}" — link: ${cta.url}. Frame it as what they'll GET, not what they should DO.

QUALITY RULES:
- Every section must teach or inform. Zero filler.
- Use "you" language, not "practitioners should."
- Include at least 3 specific numbers, percentages, or benchmarks.
- The Practitioner's Edge section is 40% of the newsletter's value — invest the most effort here.
- No sign-off signature block (the Brevo template handles that).
- Do NOT end with "Live Life Unchained" or any sign-off — the template adds that.

OUTPUT: Return ONLY the HTML email body content (no <html>, <head>, or <body> tags — just the inner content that goes inside the Brevo template). Use inline styles. Keep total length under 1000 words.`;
}

function buildPaidPrompt(
  posts: WPPost[],
  sageData: SageDashboardResponse | null,
  partner: Partner | null,
  _resourceHighlight: string
): string {
  const postList = posts
    .map((p) => `- "${stripHtml(p.title.rendered)}" — ${stripHtml(p.excerpt.rendered)} (${p.link})`)
    .join("\n");

  const sageSection =
    sageData?.available && sageData.top_topics.length > 0
      ? `Trending community data (use as fuel for the Deep Dive and Community sections — NEVER mention SAGE, AI, dashboards, or algorithms by name):
Topics:
${sageData.top_topics
  .slice(0, 5)
  .map((t) => `- ${t.topic} (${t.count} conversations)`)
  .join("\n")}
Questions members are asking:
${(sageData.top_questions || [])
  .slice(0, 5)
  .map((q) => `- "${q.question}"`)
  .join("\n")}`
      : "No trending data available. Write the Deep Dive about a concrete, timely challenge aesthetic practices face right now (staffing, pricing compression, patient retention, insurance reimbursement changes, or supplier cost increases). Use specific numbers or benchmarks.";

  const partnerBlock = partner
    ? `**Partner Spotlight** — Feature this partner like a recommendation to a friend, not an ad:
Name: ${partner.name}
What they do: ${partner.description}
${partner.discount_code ? `Member discount: Code "${partner.discount_code}" — ${partner.discount_description}` : "Member pricing available — see link"}
${partner.url ? `Link: ${partner.url}` : "Contact via TMAA"}
Write 3-4 sentences. Who is this for, what problem does it solve, why should they care.`
    : `**Tool of the Week** — Recommend one specific tool, resource, or vendor that solves a real practice problem. Be specific about what it does, who it's for, and why it's worth trying. 3-4 sentences. Write it like a recommendation to a friend.`;

  const questionsBlock = (sageData?.top_questions || [])
    .filter((q) => q.question.length > 30 && q.question.length < 300)
    .slice(0, 3)
    .map((q) => `- "${q.question}"`)
    .join("\n");

  return `You are writing the biweekly paid newsletter for The Medical Aesthetics Association (TMAA).

Newsletter name: "TMAA Insider"
Audience: Paying TMAA members — aesthetic practitioners (NPs, RNs, PAs, MDs, estheticians) running or growing their own practices. They paid for access. They expect content they cannot get anywhere else.
Tone: Sharp, direct, collegial. Like a text from a colleague who just figured something out and is sharing it before anyone else catches on. No corporate warmth. No "we value your membership." They know they are members — prove it was worth it.

THIS NEWSLETTER EXISTS TO MAKE MEMBERS SMARTER THAN NON-MEMBERS. Every section must contain information, analysis, or a framework they cannot get from the free newsletter, a blog post, or a Google search.

STRUCTURE (follow exactly):

1. **The Lead** (3-4 sentences): Open with a specific, timely insight about the aesthetics industry right now. A regulatory shift, a pricing trend, a supplier change, a reimbursement update, a competitive pattern — something that affects how they run their practice THIS month. No greeting. No "welcome back." Start with the insight.

2. **Deep Dive** (350-400 words — THIS IS THE CENTERPIECE):
   Pick the most consequential topic from the trending community data below. Write a mini-briefing that a practice owner would forward to their business partner. Structure:
   - **What is happening** (2-3 sentences): The trend, shift, or problem stated plainly
   - **Why it matters for your practice** (3-4 sentences): Connect it to revenue, patient retention, compliance, or competitive positioning. Use specific numbers or benchmarks where possible.
   - **What the smart practices are doing** (3-4 sentences): Concrete actions, not theory. "Practices seeing the best retention are..." not "you should consider..."
   - **The move to make this week** (2-3 sentences): One specific action with enough detail to execute
${sageSection}

3. **From the Community** (2-3 real questions with real answers):
   These are actual questions practitioners are asking. Each gets a 3-4 sentence answer that is genuinely useful — a complete thought, not a teaser. Frame as: "A member asked: [question]" then answer directly.
${questionsBlock || "Use 2-3 realistic practitioner questions about scaling, pricing, or patient retention."}
   CRITICAL: Never mention SAGE, AI, dashboards, or algorithms. These are "questions from the community" or "what members are asking."

4. **What We Published** (blog posts, compact):
   Each post gets ONE sentence naming the specific problem it solves + "Read more" link. Not a recap — a reason to click.
${postList}

5. ${partnerBlock}

6. **One Thing to Try Before Next Issue**:
   A single, specific challenge or experiment. Not "review your pricing" but "Pull your top 5 services by revenue. For each one, search '[service name] + [your city]' and screenshot the top 3 competitor prices. Time it — this takes 12 minutes." Give them something concrete to execute and come back with results.

QUALITY RULES:
- Zero filler. If a sentence does not teach, inform, or provoke thought, cut it.
- "You" language throughout. Never "practitioners should" or "one might consider."
- Minimum 3 specific numbers, percentages, or benchmarks across the newsletter.
- The Deep Dive is 50% of this newsletter's value — invest accordingly.
- No sign-off or signature block (Brevo template handles that).
- Do NOT end with "Live Life Unchained" or any closing — template adds it.
- Never use "here is what most programs/practices never check/tell you/consider" — that pattern is banned.
- No em dashes. Use commas, periods, or colons instead.

OUTPUT: Return ONLY the HTML email body content (no <html>, <head>, or <body> tags — just inner content for the Brevo template). Use inline styles. Target 800-1100 words. Zero sales language — these people already paid.`;
}

// ============================================================
// ORCHESTRATION — DRAFT
// ============================================================

export async function draftFreeNewsletter(
  generateFn: GenerateFn,
  _supabase: SupabaseClient
): Promise<DraftResult> {
  if (!isNewsletterReady()) {
    return { success: false, error: "Newsletter not configured (missing BREVO_API_KEY or WP creds)" };
  }

  const state = loadState();
  const sageData = await fetchSageData();

  // Pass SAGE topics so post selection prioritizes trending content
  const sageTopicNames = sageData?.available
    ? sageData.top_topics.slice(0, 5).map((t) => t.topic)
    : undefined;
  const posts = await fetchDiversePosts(3, sageTopicNames);
  if (posts.length === 0) {
    return { success: false, error: "No recent blog posts found" };
  }

  const cta = getNextCta(state);
  const recentSageTopics = state.recentSageTopics || [];
  const prompt = buildFreePrompt(posts, sageData, cta, recentSageTopics);
  const rawContent = await generateFn(prompt);
  const htmlContent = extractHtmlContent(rawContent);

  const subject = `This Week at TMAA — ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

  const campaign = await createCampaign(subject, htmlContent, BREVO_FREE_LIST_IDS, BREVO_FREE_TEMPLATE_ID);
  if (!campaign.ok || !campaign.campaignId) {
    return { success: false, error: `Failed to create campaign: ${campaign.error}` };
  }

  // DISABLED: Derek sends via Brevo UI directly. Atlas only drafts.
  // const test = await sendTestEmail(campaign.campaignId);

  state.freeCampaignId = campaign.campaignId;
  state.freeApproved = false;
  state.lastCtaIndex = (state.lastCtaIndex + 1) % CTA_OPTIONS.length;

  // Track featured SAGE topics for 6-week dedup
  if (sageData?.available && sageData.top_topics.length > 0) {
    const { lessonTopic } = pickSageTopics(sageData, posts, recentSageTopics);
    if (lessonTopic) {
      const recent = state.recentSageTopics || [];
      recent.push(lessonTopic.topic);
      state.recentSageTopics = recent.slice(-6); // keep last 6 weeks
    }
  }
  saveState(state);

  info("maa-newsletter", `Free newsletter draft created: campaign ${campaign.campaignId}`);
  return { success: true, campaignId: campaign.campaignId, subject };
}

export async function draftPaidNewsletter(
  generateFn: GenerateFn,
  supabase: SupabaseClient
): Promise<DraftResult> {
  if (!isNewsletterReady()) {
    return { success: false, error: "Newsletter not configured" };
  }

  const state = loadState();
  if (!state.paidWeekToggle) {
    info("maa-newsletter", "Not a paid newsletter week, skipping");
    return { success: false, error: "Not a paid newsletter week" };
  }

  const posts = await fetchRecentPosts(4);
  if (posts.length === 0) {
    return { success: false, error: "No recent blog posts found" };
  }

  const sageData = await fetchSageData();
  const partners = await fetchActivePartners(supabase);
  const partner = getNextPartner(partners, state);

  const resourceHighlights = [
    "Pro Treatment Consent Templates",
    "Practice Financial Dashboard Template",
    "Patient Consultation Checklist",
    "Marketing Compliance Guide",
  ];
  const resourceHighlight = resourceHighlights[state.lastPartnerIndex % resourceHighlights.length];

  const prompt = buildPaidPrompt(posts, sageData, partner, resourceHighlight);
  const rawContent = await generateFn(prompt);
  const htmlContent = extractHtmlContent(rawContent);

  const subject = `TMAA Insider — ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

  const campaign = await createCampaign(subject, htmlContent, [BREVO_PAID_LIST_ID], BREVO_PAID_TEMPLATE_ID);
  if (!campaign.ok || !campaign.campaignId) {
    return { success: false, error: `Failed to create campaign: ${campaign.error}` };
  }

  // DISABLED: Derek sends via Brevo UI directly. Atlas only drafts.
  // const test = await sendTestEmail(campaign.campaignId);

  state.paidCampaignId = campaign.campaignId;
  state.paidApproved = false;
  if (partners.length > 0) {
    state.lastPartnerIndex = (state.lastPartnerIndex + 1) % partners.length;
  }
  saveState(state);

  info("maa-newsletter", `Paid newsletter draft created: campaign ${campaign.campaignId}`);
  return { success: true, campaignId: campaign.campaignId, subject };
}

// ============================================================
// ORCHESTRATION — SEND
// ============================================================

export async function sendFreeNewsletter(
  supabase?: import("@supabase/supabase-js").SupabaseClient | null
): Promise<{ success: boolean; error?: string }> {
  const state = loadState();

  if (!state.freeApproved) {
    return { success: false, error: "Free newsletter not approved yet" };
  }
  if (!state.freeCampaignId) {
    return { success: false, error: "No free newsletter campaign ID" };
  }

  const campaignId = state.freeCampaignId;

  // Atlas Prime Sprint 5: council review for maa-newsletter.send (newsletter_push surface)
  if (supabase) {
    const action = { tool: "maa-newsletter.send", args: { campaignId, type: "free" } };
    const council = await import("./shadow-council.ts");
    let councilResult: import("./shadow-council.ts").CouncilReviewResult;
    try {
      councilResult = await council.review(supabase, action);
    } catch (e) {
      warn("maa-newsletter", `council.review failed (fail-open): ${(e as Error).message}`);
      councilResult = { allowed: true, vetoes: [], votes: [], weightedScore: 0, threshold: 0, deliberationBranch: "", mode: "shadow" as const, actionId: "" };
    }
    if (!councilResult.allowed) {
      const vetoMsg = councilResult.vetoes.map((v) => `${v.role_id}: ${v.reason}`).join("; ");
      warn("maa-newsletter", `Free newsletter held by council (live mode). action_id=${councilResult.actionId} vetoes=${vetoMsg}`);
      return { success: false, error: `Held by council: ${vetoMsg}` };
    }
  }

  // DISABLED: Derek sends via Brevo UI directly. Atlas only drafts.
  warn("maa-newsletter", `Free newsletter campaign ${campaignId} ready in Brevo. Derek will send manually.`);
  return { success: false, error: "Brevo sends disabled. Derek sends via Brevo UI." };
}

export async function sendPaidNewsletter(
  supabase?: import("@supabase/supabase-js").SupabaseClient | null
): Promise<{ success: boolean; error?: string }> {
  const state = loadState();

  if (!state.paidApproved) {
    return { success: false, error: "Paid newsletter not approved yet" };
  }
  if (!state.paidCampaignId) {
    return { success: false, error: "No paid newsletter campaign ID" };
  }

  const campaignId = state.paidCampaignId;

  // Atlas Prime Sprint 5: council review for maa-newsletter.send (newsletter_push surface)
  if (supabase) {
    const action = { tool: "maa-newsletter.send", args: { campaignId, type: "paid" } };
    const council = await import("./shadow-council.ts");
    let councilResult: import("./shadow-council.ts").CouncilReviewResult;
    try {
      councilResult = await council.review(supabase, action);
    } catch (e) {
      warn("maa-newsletter", `council.review failed (fail-open): ${(e as Error).message}`);
      councilResult = { allowed: true, vetoes: [], votes: [], weightedScore: 0, threshold: 0, deliberationBranch: "", mode: "shadow" as const, actionId: "" };
    }
    if (!councilResult.allowed) {
      const vetoMsg = councilResult.vetoes.map((v) => `${v.role_id}: ${v.reason}`).join("; ");
      warn("maa-newsletter", `Paid newsletter held by council (live mode). action_id=${councilResult.actionId} vetoes=${vetoMsg}`);
      return { success: false, error: `Held by council: ${vetoMsg}` };
    }
  }

  // DISABLED: Derek sends via Brevo UI directly. Atlas only drafts.
  warn("maa-newsletter", `Paid newsletter campaign ${campaignId} ready in Brevo. Derek will send manually.`);
  return { success: false, error: "Brevo sends disabled. Derek sends via Brevo UI." };
}

export function isPaidWeek(): boolean {
  return loadState().paidWeekToggle;
}
