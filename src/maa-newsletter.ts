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
const BREVO_FREE_LIST_ID = parseInt(process.env.BREVO_FREE_LIST_ID || "0", 10);
const BREVO_PAID_LIST_ID = parseInt(process.env.BREVO_PAID_LIST_ID || "0", 10);
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || "The Medical Aesthetics Association";
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || "theoffice@medicalaestheticsassociation.com";
const BREVO_FREE_TEMPLATE_ID = parseInt(process.env.BREVO_FREE_TEMPLATE_ID || "0", 10);
const BREVO_PAID_TEMPLATE_ID = parseInt(process.env.BREVO_PAID_TEMPLATE_ID || "0", 10);

const DATA_DIR = join(process.env.PROJECT_DIR || process.cwd(), "data");
const STATE_FILE = join(DATA_DIR, "maa-newsletter-state.json");

const APPROVAL_EMAILS = ["derek@pvmedispa.com", "esther@pvmedispa.com"];

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
}

interface WPPost {
  id: number;
  title: { rendered: string };
  excerpt: { rendered: string };
  link: string;
  date: string;
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
      `${WP_API_BASE}/posts?per_page=${count}&orderby=date&order=desc&_fields=id,title,excerpt,link,date`,
      {
        headers: { Authorization: wpAuthHeader() },
        signal: AbortSignal.timeout(API_TIMEOUT),
      }
    );
    if (!res.ok) {
      warn("maa-newsletter", `WP posts API ${res.status}`);
      return [];
    }
    return (await res.json()) as WPPost[];
  } catch (err) {
    warn("maa-newsletter", `Failed to fetch WP posts: ${err}`);
    return [];
  }
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
      headers: { Authorization: `Bearer ${MAA_DASHBOARD_TOKEN}` },
      signal: AbortSignal.timeout(API_TIMEOUT),
    });
    if (!res.ok) {
      warn("maa-newsletter", `SAGE API ${res.status}`);
      return null;
    }
    return (await res.json()) as SageDashboardResponse;
  } catch (err) {
    warn("maa-newsletter", `SAGE API failed: ${err}`);
    return null;
  }
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
  listId: number,
  _templateId: number
): Promise<{ ok: boolean; campaignId?: number; error?: string }> {
  const result = await brevoRequest<BrevoCreateCampaignResponse>("POST", "/emailCampaigns", {
    name: `${subject} — ${new Date().toISOString().split("T")[0]}`,
    subject,
    sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
    htmlContent,
    recipients: { listIds: [listId] },
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

function buildFreePrompt(
  posts: WPPost[],
  sageData: SageDashboardResponse | null,
  cta: { label: string; url: string }
): string {
  const postList = posts
    .map((p) => `- "${stripHtml(p.title.rendered)}" — ${stripHtml(p.excerpt.rendered)} (${p.link})`)
    .join("\n");

  const trendingHint =
    sageData?.available && sageData.top_topics.length > 0
      ? `Trending practitioner topics this week: ${sageData.top_topics
          .slice(0, 3)
          .map((t) => t.topic)
          .join(", ")}`
      : "No trending data available — use a general practice insight.";

  return `You are writing the weekly free newsletter for The Medical Aesthetics Association (TMAA).
Newsletter name: "This Week at TMAA"
Audience: Aesthetic practitioners who are NOT yet TMAA members (FB group leads).
Tone: Warm, professional, genuinely helpful. No hype, no hard sell.

STRUCTURE (follow this exactly):

1. **Opening** (2-3 sentences): Friendly greeting acknowledging the week. Keep it human.

2. **Blog Recap**: Summarize each post in 1-2 engaging sentences with a "Read more →" link.
${postList}

3. **Trending Topic Teaser**: Frame this as "What practitioners are asking about this week."
Write 2-3 sentences of genuinely useful insight that leaves them wanting more depth.
${trendingHint}
Do NOT mention SAGE, AI, dashboards, or data sources. Frame it as community conversation.

4. **CTA**: End with a warm invitation to "${cta.label}" — link: ${cta.url}
Keep it one sentence, not pushy.

OUTPUT: Return ONLY the HTML email body content (no <html>, <head>, or <body> tags — just the inner content that goes inside the Brevo template). Use inline styles. Keep total length under 600 words.`;
}

function buildPaidPrompt(
  posts: WPPost[],
  sageData: SageDashboardResponse | null,
  partner: Partner | null,
  resourceHighlight: string
): string {
  const postList = posts
    .map((p) => `- "${stripHtml(p.title.rendered)}" — ${stripHtml(p.excerpt.rendered)} (${p.link})`)
    .join("\n");

  const sageSection =
    sageData?.available && sageData.top_topics.length > 0
      ? `Top SAGE trending themes (rephrase as member insights, NEVER mention SAGE by name):
${sageData.top_topics
  .slice(0, 4)
  .map((t) => `- ${t.topic} (${t.count} conversations)`)
  .join("\n")}
Top member questions:
${(sageData.top_questions || [])
  .slice(0, 3)
  .map((q) => `- "${q.question}"`)
  .join("\n")}`
      : "No trending data — write 3 general practice optimization insights instead.";

  const partnerSection = partner
    ? `Partner Spotlight:
Name: ${partner.name}
Contact: ${partner.contact_name || "N/A"}
Description: ${partner.description}
Discount: ${partner.discount_code ? `Code "${partner.discount_code}" — ${partner.discount_description}` : "See link for member pricing"}
URL: ${partner.url || "Contact via TMAA"}`
    : "Skip partner spotlight this edition (no active partners).";

  return `You are writing the biweekly paid newsletter for The Medical Aesthetics Association (TMAA).
Newsletter name: "TMAA Insider"
Audience: Paying TMAA members — aesthetic practitioners who value exclusive, actionable content.
Tone: Pure value delivery. No sales, no CTAs to buy anything. These people already paid.

STRUCTURE (follow this exactly):

1. **Opening** (2-3 sentences): Acknowledge the value of their membership. Keep it human, not corporate.

2. **Blog Recap**: All posts from the past 2 weeks. Each gets 1-2 engaging sentences + "Read more →" link.
${postList}

3. **SAGE Insights** (the exclusive section): 3-4 trending themes, each with a meaty 2-3 sentence actionable takeaway. This is what free members DON'T get.
${sageSection}
CRITICAL: Never mention SAGE, AI, algorithms, or data analysis. Frame these as "what your peers are discussing" or "trending in the community."

4. **Partner Spotlight**: Feature this partner warmly. 3-4 sentences about what they offer and why it matters for practitioners. Include discount if available.
${partnerSection}

5. **Resources Reminder**: Highlight: "${resourceHighlight}" — mention it's available in the members-only resources section at ${MAA_SITE_URL}/resources.

OUTPUT: Return ONLY the HTML email body content (no <html>, <head>, or <body> tags). Use inline styles. Keep total length under 900 words. Zero sales language.`;
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
  const posts = await fetchRecentPosts(2);
  if (posts.length === 0) {
    return { success: false, error: "No recent blog posts found" };
  }

  const sageData = await fetchSageData();
  const cta = getNextCta(state);
  const prompt = buildFreePrompt(posts, sageData, cta);
  const htmlContent = await generateFn(prompt);

  const subject = `This Week at TMAA — ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

  const campaign = await createCampaign(subject, htmlContent, BREVO_FREE_LIST_ID, BREVO_FREE_TEMPLATE_ID);
  if (!campaign.ok || !campaign.campaignId) {
    return { success: false, error: `Failed to create campaign: ${campaign.error}` };
  }

  const test = await sendTestEmail(campaign.campaignId);
  if (!test.ok) {
    warn("maa-newsletter", `Test email failed: ${test.error}`);
  }

  state.freeCampaignId = campaign.campaignId;
  state.freeApproved = false;
  state.lastCtaIndex = (state.lastCtaIndex + 1) % CTA_OPTIONS.length;
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
  const htmlContent = await generateFn(prompt);

  const subject = `TMAA Insider — ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

  const campaign = await createCampaign(subject, htmlContent, BREVO_PAID_LIST_ID, BREVO_PAID_TEMPLATE_ID);
  if (!campaign.ok || !campaign.campaignId) {
    return { success: false, error: `Failed to create campaign: ${campaign.error}` };
  }

  const test = await sendTestEmail(campaign.campaignId);
  if (!test.ok) {
    warn("maa-newsletter", `Test email failed: ${test.error}`);
  }

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

export async function sendFreeNewsletter(): Promise<{ success: boolean; error?: string }> {
  const state = loadState();

  if (!state.freeApproved) {
    return { success: false, error: "Free newsletter not approved yet" };
  }
  if (!state.freeCampaignId) {
    return { success: false, error: "No free newsletter campaign ID" };
  }

  const campaignId = state.freeCampaignId;
  const result = await sendCampaign(campaignId);
  if (!result.ok) {
    return { success: false, error: `Send failed: ${result.error}` };
  }

  state.freeApproved = false;
  state.freeCampaignId = null;
  state.lastFreeSent = new Date().toISOString();
  saveState(state);

  info("maa-newsletter", `Free newsletter sent: campaign ${campaignId}`);
  return { success: true };
}

export async function sendPaidNewsletter(): Promise<{ success: boolean; error?: string }> {
  const state = loadState();

  if (!state.paidApproved) {
    return { success: false, error: "Paid newsletter not approved yet" };
  }
  if (!state.paidCampaignId) {
    return { success: false, error: "No paid newsletter campaign ID" };
  }

  const campaignId = state.paidCampaignId;
  const result = await sendCampaign(campaignId);
  if (!result.ok) {
    return { success: false, error: `Send failed: ${result.error}` };
  }

  state.paidApproved = false;
  state.paidCampaignId = null;
  state.lastPaidSent = new Date().toISOString();
  state.paidWeekToggle = !state.paidWeekToggle;
  saveState(state);

  info("maa-newsletter", `Paid newsletter sent: campaign ${campaignId}`);
  return { success: true };
}

export function isPaidWeek(): boolean {
  return loadState().paidWeekToggle;
}
