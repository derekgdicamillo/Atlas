# TMAA Newsletter Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate two newsletter tiers (free weekly + paid biweekly) for TMAA, with Brevo as the delivery platform and Telegram approval gate before each send.

**Architecture:** New `src/maa-newsletter.ts` module wraps Brevo v3 REST API for campaign creation/test/send. Three cron jobs handle drafting (Wed 8 AM), free send (Sat 9 AM), and paid send (Sun 9 AM). Approval commands (`approve free`/`approve paid`) handled as slash commands in `relay.ts`. Partner data lives in a new `tmaa_partners` Supabase table. State tracked in `data/maa-newsletter-state.json`.

**Tech Stack:** Brevo v3 REST API (no SDK — direct fetch like existing WP/SAGE calls), Supabase (partner table), Claude Sonnet (content generation via `runPrompt`), WP REST API (recent posts), SAGE dashboard API (trending themes).

**Spec:** `docs/superpowers/specs/2026-04-02-maa-newsletter-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `db/migrations/022_tmaa_partners.sql` | Partner table + seed data |
| Create | `src/maa-newsletter.ts` | Brevo API, content assembly, draft/send, state management |
| Modify | `src/cron.ts` | 3 new cron jobs (draft, free send, paid send) |
| Modify | `src/relay.ts` | `/approve free` and `/approve paid` commands |
| Modify | `src/capability-registry.ts` | Register newsletter capability |

---

## Task 1: Supabase Migration — `tmaa_partners` Table

**Files:**
- Create: `db/migrations/022_tmaa_partners.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- ============================================================
-- Atlas TMAA Partners Migration
-- Partner directory for newsletter rotation and SAGE training
-- Run in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- 1. TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS tmaa_partners (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  description TEXT NOT NULL,
  discount_code TEXT,
  discount_description TEXT,
  url TEXT,
  category TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_tmaa_partners_active ON tmaa_partners (active);
CREATE INDEX IF NOT EXISTS idx_tmaa_partners_category ON tmaa_partners (category);

-- ============================================================
-- 3. UPDATED_AT TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION update_tmaa_partners_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tmaa_partners_updated_at ON tmaa_partners;
CREATE TRIGGER trg_tmaa_partners_updated_at
  BEFORE UPDATE ON tmaa_partners
  FOR EACH ROW EXECUTE FUNCTION update_tmaa_partners_updated_at();

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE tmaa_partners ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON tmaa_partners FOR ALL USING (true);

-- ============================================================
-- 5. SEED DATA
-- ============================================================

INSERT INTO tmaa_partners (name, contact_name, description, discount_code, discount_description, url, category) VALUES
  ('HRT University', 'Nico Misleh, NP', 'Comprehensive hormone replacement therapy certification for nurse practitioners and physician assistants. Covers bioidentical hormones, pellet therapy, and practice integration. Ideal for practitioners expanding into HRT services.', 'DEREKMC5', '$200 off certification course', 'https://hrtuniversity.com', 'training'),
  ('Peptide Prescribing', 'Ashlee Hess, APRN', 'Advanced peptide therapy training and prescribing protocols for aesthetic and functional medicine practitioners. Covers BPC-157, CJC-1295/Ipamorelin, thymosin alpha-1, and clinical applications.', 'PS5', '~5% off', 'https://peptideprescribing.com', 'clinical'),
  ('The Protected Practice', 'Courtney', 'Legal compliance, practice protection, and risk management services for medical aesthetics practices. Covers HIPAA, informed consent, scope of practice, and malpractice prevention.', 'DEREK', '5% off', 'https://theprotectedpractice.com', 'legal'),
  ('Scripts', NULL, 'Pharmacy network offering competitive pricing on GLP-1 medications, compounded peptides, and aesthetic injectables. Preferred pricing for TMAA members on all compounded formulations.', 'ANEpharm', 'Preferred pricing', NULL, 'pharmacy');
```

- [ ] **Step 2: Run the migration in Supabase SQL Editor**

Open the Supabase dashboard, navigate to the SQL Editor, paste the migration, and execute. Verify 4 rows in `tmaa_partners`.

- [ ] **Step 3: Commit**

```bash
git add db/migrations/022_tmaa_partners.sql
git commit -m "feat(maa): add tmaa_partners table with seed data"
```

---

## Task 2: Newsletter Module — State & Config

**Files:**
- Create: `src/maa-newsletter.ts` (initial scaffold with types, state management, and config)

- [ ] **Step 1: Create the module with types and state management**

```typescript
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
```

- [ ] **Step 2: Verify file compiles**

Run: `bunx tsc --noEmit src/maa-newsletter.ts`
Expected: No errors (or only import-related warnings that are fine in Bun)

- [ ] **Step 3: Commit**

```bash
git add src/maa-newsletter.ts
git commit -m "feat(maa-newsletter): scaffold module with types, state, config, approval"
```

---

## Task 3: Newsletter Module — Data Fetching (WP Posts, SAGE, Partners)

**Files:**
- Modify: `src/maa-newsletter.ts`

- [ ] **Step 1: Add WP auth header and recent posts fetcher**

Add after the `isNewsletterReady()` function:

```typescript
// ============================================================
// WP REST API — Fetch Recent Blog Posts
// ============================================================

function wpAuthHeader(): string {
  return `Basic ${Buffer.from(`${MAA_WP_USER}:${MAA_WP_APP_PASSWORD}`).toString("base64")}`;
}

/**
 * Fetch the most recent MAA blog posts.
 * @param count Number of posts to fetch (default 2 for free, 4 for paid)
 */
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
```

- [ ] **Step 2: Add SAGE data fetcher**

Add after the posts fetcher:

```typescript
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
```

- [ ] **Step 3: Add partner data fetcher**

Add after the SAGE fetcher. This uses the Supabase client passed in at runtime (same pattern as other modules):

```typescript
// ============================================================
// Partner Data — Supabase
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

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
```

- [ ] **Step 4: Commit**

```bash
git add src/maa-newsletter.ts
git commit -m "feat(maa-newsletter): add WP posts, SAGE, and partner data fetchers"
```

---

## Task 4: Newsletter Module — Brevo API Client

**Files:**
- Modify: `src/maa-newsletter.ts`

- [ ] **Step 1: Add Brevo API helper and campaign creation**

Add after the partner data section:

```typescript
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
    // Some Brevo endpoints return 204 No Content
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
  templateId: number
): Promise<{ ok: boolean; campaignId?: number; error?: string }> {
  const result = await brevoRequest<BrevoCreateCampaignResponse>("POST", "/emailCampaigns", {
    name: `${subject} — ${new Date().toISOString().split("T")[0]}`,
    subject,
    sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
    htmlContent,
    recipients: { listIds: [listId] },
    // If using Brevo templates, pass templateId instead of htmlContent:
    // templateId,
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
```

- [ ] **Step 2: Commit**

```bash
git add src/maa-newsletter.ts
git commit -m "feat(maa-newsletter): add Brevo API client (create, test, send)"
```

---

## Task 5: Newsletter Module — Content Generation Prompts

**Files:**
- Modify: `src/maa-newsletter.ts`

- [ ] **Step 1: Add HTML utility to strip WP tags from excerpts**

Add after the Brevo section:

```typescript
// ============================================================
// CONTENT GENERATION
// ============================================================

/** Strip HTML tags from WP excerpt for plain-text use in prompts. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#8217;/g, "'").replace(/&#8220;|&#8221;/g, '"').replace(/&nbsp;/g, " ").trim();
}
```

- [ ] **Step 2: Add free newsletter prompt builder**

```typescript
function buildFreePrompt(
  posts: WPPost[],
  sageData: SageDashboardResponse | null,
  cta: { label: string; url: string }
): string {
  const postList = posts
    .map((p) => `- "${stripHtml(p.title.rendered)}" — ${stripHtml(p.excerpt.rendered)} (${p.link})`)
    .join("\n");

  const trendingHint = sageData?.available && sageData.top_topics.length > 0
    ? `Trending practitioner topics this week: ${sageData.top_topics.slice(0, 3).map((t) => t.topic).join(", ")}`
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
```

- [ ] **Step 3: Add paid newsletter prompt builder**

```typescript
function buildPaidPrompt(
  posts: WPPost[],
  sageData: SageDashboardResponse | null,
  partner: Partner | null,
  resourceHighlight: string
): string {
  const postList = posts
    .map((p) => `- "${stripHtml(p.title.rendered)}" — ${stripHtml(p.excerpt.rendered)} (${p.link})`)
    .join("\n");

  const sageSection = sageData?.available && sageData.top_topics.length > 0
    ? `Top SAGE trending themes (rephrase as member insights, NEVER mention SAGE by name):
${sageData.top_topics.slice(0, 4).map((t) => `- ${t.topic} (${t.count} conversations)`).join("\n")}
Top member questions:
${(sageData.top_questions || []).slice(0, 3).map((q) => `- "${q.question}"`).join("\n")}`
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
```

- [ ] **Step 4: Commit**

```bash
git add src/maa-newsletter.ts
git commit -m "feat(maa-newsletter): add content generation prompts for free and paid tiers"
```

---

## Task 6: Newsletter Module — Draft & Send Orchestration

**Files:**
- Modify: `src/maa-newsletter.ts`

- [ ] **Step 1: Add the main draft function for the free newsletter**

```typescript
// ============================================================
// ORCHESTRATION — DRAFT
// ============================================================

export async function draftFreeNewsletter(
  generateFn: GenerateFn,
  supabase: SupabaseClient
): Promise<DraftResult> {
  if (!isNewsletterReady()) {
    return { success: false, error: "Newsletter not configured (missing BREVO_API_KEY or WP creds)" };
  }

  const state = loadState();

  // Fetch this week's blog posts (2 most recent)
  const posts = await fetchRecentPosts(2);
  if (posts.length === 0) {
    return { success: false, error: "No recent blog posts found" };
  }

  // Fetch SAGE trending data
  const sageData = await fetchSageData();

  // Get next CTA in rotation
  const cta = getNextCta(state);

  // Generate newsletter content
  const prompt = buildFreePrompt(posts, sageData, cta);
  const htmlContent = await generateFn(prompt);

  const subject = `This Week at TMAA — ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

  // Create Brevo campaign draft
  const campaign = await createCampaign(subject, htmlContent, BREVO_FREE_LIST_ID, BREVO_FREE_TEMPLATE_ID);
  if (!campaign.ok || !campaign.campaignId) {
    return { success: false, error: `Failed to create campaign: ${campaign.error}` };
  }

  // Send test emails
  const test = await sendTestEmail(campaign.campaignId);
  if (!test.ok) {
    warn("maa-newsletter", `Test email failed: ${test.error}`);
    // Non-fatal — campaign is still created
  }

  // Update state
  state.freeCampaignId = campaign.campaignId;
  state.freeApproved = false;
  state.lastCtaIndex = (state.lastCtaIndex + 1) % CTA_OPTIONS.length;
  saveState(state);

  info("maa-newsletter", `Free newsletter draft created: campaign ${campaign.campaignId}`);
  return { success: true, campaignId: campaign.campaignId, subject };
}
```

- [ ] **Step 2: Add the main draft function for the paid newsletter**

```typescript
export async function draftPaidNewsletter(
  generateFn: GenerateFn,
  supabase: SupabaseClient
): Promise<DraftResult> {
  if (!isNewsletterReady()) {
    return { success: false, error: "Newsletter not configured" };
  }

  const state = loadState();

  // Check if this is a paid week
  if (!state.paidWeekToggle) {
    info("maa-newsletter", "Not a paid newsletter week, skipping");
    return { success: false, error: "Not a paid newsletter week" };
  }

  // Fetch past 2 weeks of blog posts (4 most recent)
  const posts = await fetchRecentPosts(4);
  if (posts.length === 0) {
    return { success: false, error: "No recent blog posts found" };
  }

  // Fetch SAGE trending data
  const sageData = await fetchSageData();

  // Get next partner in rotation
  const partners = await fetchActivePartners(supabase);
  const partner = getNextPartner(partners, state);

  // Resource highlight (rotate through a static list or pull dynamically later)
  const resourceHighlights = [
    "Pro Treatment Consent Templates",
    "Practice Financial Dashboard Template",
    "Patient Consultation Checklist",
    "Marketing Compliance Guide",
  ];
  const resourceHighlight = resourceHighlights[state.lastPartnerIndex % resourceHighlights.length];

  // Generate newsletter content
  const prompt = buildPaidPrompt(posts, sageData, partner, resourceHighlight);
  const htmlContent = await generateFn(prompt);

  const subject = `TMAA Insider — ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

  // Create Brevo campaign draft
  const campaign = await createCampaign(subject, htmlContent, BREVO_PAID_LIST_ID, BREVO_PAID_TEMPLATE_ID);
  if (!campaign.ok || !campaign.campaignId) {
    return { success: false, error: `Failed to create campaign: ${campaign.error}` };
  }

  // Send test emails
  const test = await sendTestEmail(campaign.campaignId);
  if (!test.ok) {
    warn("maa-newsletter", `Test email failed: ${test.error}`);
  }

  // Update state
  state.paidCampaignId = campaign.campaignId;
  state.paidApproved = false;
  if (partners.length > 0) {
    state.lastPartnerIndex = (state.lastPartnerIndex + 1) % partners.length;
  }
  saveState(state);

  info("maa-newsletter", `Paid newsletter draft created: campaign ${campaign.campaignId}`);
  return { success: true, campaignId: campaign.campaignId, subject };
}
```

- [ ] **Step 3: Add the send functions**

```typescript
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

  const result = await sendCampaign(state.freeCampaignId);
  if (!result.ok) {
    return { success: false, error: `Send failed: ${result.error}` };
  }

  // Reset state
  state.freeApproved = false;
  state.freeCampaignId = null;
  state.lastFreeSent = new Date().toISOString();
  saveState(state);

  info("maa-newsletter", `Free newsletter sent: campaign ${state.freeCampaignId}`);
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

  const result = await sendCampaign(state.paidCampaignId);
  if (!result.ok) {
    return { success: false, error: `Send failed: ${result.error}` };
  }

  // Reset state and toggle paid week
  state.paidApproved = false;
  state.paidCampaignId = null;
  state.lastPaidSent = new Date().toISOString();
  state.paidWeekToggle = !state.paidWeekToggle;
  saveState(state);

  info("maa-newsletter", `Paid newsletter sent`);
  return { success: true };
}

/** Check if a paid newsletter draft should be created this week. */
export function isPaidWeek(): boolean {
  return loadState().paidWeekToggle;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/maa-newsletter.ts
git commit -m "feat(maa-newsletter): add draft and send orchestration for both tiers"
```

---

## Task 7: Cron Jobs — Wire Up Newsletter Schedule

**Files:**
- Modify: `src/cron.ts`

- [ ] **Step 1: Add import for the newsletter module**

At the top of `src/cron.ts`, add with the other imports:

```typescript
import {
  isNewsletterReady,
  draftFreeNewsletter,
  draftPaidNewsletter,
  sendFreeNewsletter,
  sendPaidNewsletter,
  isPaidWeek,
} from "./maa-newsletter.ts";
```

- [ ] **Step 2: Add the three cron jobs inside `startCronJobs()`**

Find the section where MAA blog cron is registered (around line 2043, inside the `if (isMAABlogReady())` block). Add the newsletter crons nearby, gated on `isNewsletterReady()`:

```typescript
  // ── TMAA Newsletter Automation ──────────────────────────────
  if (isNewsletterReady() && supabase) {
    // Wednesday 8 AM: Draft newsletters and send test emails
    jobs.push(
      CronJob.from({
        cronTime: "0 8 * * 3",
        onTick: safeTick("maa-newsletter-draft", async () => {
          log("maa-newsletter", "Drafting newsletters...");

          // Always draft free newsletter
          const freeResult = await draftFreeNewsletter(
            (prompt) => runPrompt(prompt, MODELS.sonnet),
            supabase!
          );

          let msg = "";
          if (freeResult.success) {
            msg += `**TMAA Free Newsletter** draft ready.\nSubject: "${freeResult.subject}"\nTest email sent to you and Esther.\nReply \`/approve free\` when ready or send edits.`;
          } else {
            msg += `Free newsletter draft failed: ${freeResult.error}`;
          }

          // Draft paid newsletter if it's a paid week
          if (isPaidWeek()) {
            const paidResult = await draftPaidNewsletter(
              (prompt) => runPrompt(prompt, MODELS.sonnet),
              supabase!
            );
            if (paidResult.success) {
              msg += `\n\n**TMAA Paid Newsletter** draft ready.\nSubject: "${paidResult.subject}"\nTest email sent.\nReply \`/approve paid\` when ready.`;
            } else {
              msg += `\n\nPaid newsletter draft failed: ${paidResult.error}`;
            }
          } else {
            msg += "\n\n(Not a paid newsletter week.)";
          }

          await sendTelegramMessage(DEREK_CHAT_ID, msg);
        }),
        timeZone: TIMEZONE,
      })
    );

    // Saturday 9 AM: Send free newsletter (if approved)
    jobs.push(
      CronJob.from({
        cronTime: "0 9 * * 6",
        onTick: safeTick("maa-newsletter-free-send", async () => {
          const result = await sendFreeNewsletter();
          if (result.success) {
            await sendTelegramMessage(DEREK_CHAT_ID, "TMAA free newsletter sent to FB Group Leads list.");
          } else if (result.error?.includes("not approved")) {
            await sendTelegramMessage(
              DEREK_CHAT_ID,
              "TMAA free newsletter NOT sent — still awaiting approval. Reply `/approve free` to approve, or it will be skipped this week."
            );
          } else {
            await sendTelegramMessage(DEREK_CHAT_ID, `TMAA free newsletter send failed: ${result.error}`);
          }
        }),
        timeZone: TIMEZONE,
      })
    );

    // Sunday 9 AM: Send paid newsletter (if approved + paid week)
    jobs.push(
      CronJob.from({
        cronTime: "0 9 * * 0",
        onTick: safeTick("maa-newsletter-paid-send", async () => {
          const result = await sendPaidNewsletter();
          if (result.success) {
            await sendTelegramMessage(DEREK_CHAT_ID, "TMAA Insider (paid newsletter) sent to TMAA Members list.");
          } else if (result.error?.includes("not approved")) {
            await sendTelegramMessage(
              DEREK_CHAT_ID,
              "TMAA Insider NOT sent — still awaiting approval. Reply `/approve paid` to approve."
            );
          }
          // Silently skip if not a paid week or no campaign — that's expected
        }),
        timeZone: TIMEZONE,
      })
    );
  }
```

- [ ] **Step 3: Add job timeout entries**

Find the `JOB_TIMEOUTS_MS` object near the top of `cron.ts` and add:

```typescript
  "maa-newsletter-draft": 10 * 60 * 1000,     // 10 min (LLM generation)
  "maa-newsletter-free-send": 2 * 60 * 1000,  // 2 min (API call)
  "maa-newsletter-paid-send": 2 * 60 * 1000,  // 2 min
```

- [ ] **Step 4: Commit**

```bash
git add src/cron.ts
git commit -m "feat(maa-newsletter): add draft/send cron jobs (Wed/Sat/Sun)"
```

---

## Task 8: Relay — `/approve` Command

**Files:**
- Modify: `src/relay.ts`

- [ ] **Step 1: Add import**

At the top of `src/relay.ts`, add:

```typescript
import { approveNewsletter } from "./maa-newsletter.ts";
```

- [ ] **Step 2: Add `/approve` case to the command switch**

Find the `handleCommand` function's switch statement (around line 1039). Add a new case — a good spot is near other operational commands:

```typescript
    case "/approve": {
      const tier = args[0]?.toLowerCase();
      if (tier !== "free" && tier !== "paid") {
        await ctx.reply("Usage: /approve free  or  /approve paid");
        return true;
      }
      const result = approveNewsletter(tier);
      await ctx.reply(result.message);
      return true;
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/relay.ts
git commit -m "feat(maa-newsletter): add /approve command to relay"
```

---

## Task 9: Capability Registry Update

**Files:**
- Modify: `src/capability-registry.ts`

- [ ] **Step 1: Add newsletter capability entry**

Find the `ALL_CAPABILITIES` array in `src/capability-registry.ts` and add a new entry:

```typescript
  {
    section: "TMAA Newsletter Automation",
    description: "Two-tier newsletter system (free weekly + paid biweekly) via Brevo with Telegram approval gate",
    can: [
      "draft free newsletter ('This Week at TMAA') from recent blog posts + SAGE trending data + rotating CTA",
      "draft paid newsletter ('TMAA Insider') with blog recap, SAGE insights, partner spotlight, resource highlights",
      "create Brevo campaign drafts and send test emails to Derek + Esther",
      "send approved newsletters via Brevo campaign API",
      "rotate partner spotlights from tmaa_partners Supabase table",
      "rotate CTAs (Join TMAA, Try SAGE, Browse Resources) across free editions",
      "handle /approve free and /approve paid commands",
    ],
    cannot: [
      "send newsletters without explicit Telegram approval from Derek or Esther",
      "modify Brevo templates (managed in Brevo UI)",
      "manage Brevo contact lists (managed ad hoc)",
    ],
    module: "src/maa-newsletter.ts",
    commands: ["/approve free", "/approve paid"],
    runs: "maa-newsletter-draft Wed 8AM, maa-newsletter-free-send Sat 9AM, maa-newsletter-paid-send Sun 9AM",
    state: "data/maa-newsletter-state.json (approval flags, campaign IDs, rotation indexes)",
  },
```

- [ ] **Step 2: Commit**

```bash
git add src/capability-registry.ts
git commit -m "feat(maa-newsletter): register capability in registry"
```

---

## Task 10: Environment Variables & Final Wiring

**Files:**
- Modify: `.env` (add Brevo keys — actual values from Brevo dashboard)

- [ ] **Step 1: Add Brevo environment variables to `.env`**

Add to the `.env` file (the actual values need to come from the Brevo dashboard):

```bash
# TMAA Newsletter (Brevo)
BREVO_API_KEY=                      # From Brevo: SMTP & API > API Keys
BREVO_SENDER_NAME=The Medical Aesthetics Association
BREVO_SENDER_EMAIL=theoffice@medicalaestheticsassociation.com
BREVO_FREE_LIST_ID=                 # Brevo list ID for "FB Group Leads"
BREVO_PAID_LIST_ID=                 # Brevo list ID for "TMAA Members"
BREVO_FREE_TEMPLATE_ID=             # Brevo template ID (if using templates)
BREVO_PAID_TEMPLATE_ID=             # Brevo template ID (if using templates)
```

- [ ] **Step 2: Verify the full module compiles with Bun**

Run: `bun build src/maa-newsletter.ts --no-bundle --outdir /tmp/test-build`
Expected: No compilation errors.

- [ ] **Step 3: Test startup with `pm2 restart atlas`**

Run: `pm2 restart atlas && pm2 logs atlas --lines 30`
Expected: See log lines like `maa-newsletter: Newsletter not configured` (since Brevo keys aren't set yet) or `Newsletter crons registered` if keys are present. No crash.

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A
git commit -m "feat(maa-newsletter): add env vars, finalize wiring"
```

---

## Post-Implementation Checklist

After all tasks are complete:

- [ ] Run the Supabase migration (Task 1) and verify 4 partners exist
- [ ] Get `BREVO_API_KEY` from Brevo dashboard and add to `.env`
- [ ] Get Brevo list IDs for "FB Group Leads" and "TMAA Members" lists
- [ ] Optionally get Brevo template IDs if using pre-built templates
- [ ] Restart Atlas: `pm2 restart atlas`
- [ ] Trigger a manual draft test: call `draftFreeNewsletter()` from a code agent or test script
- [ ] Verify test email arrives at derek@pvmedispa.com
- [ ] Test `/approve free` command in Telegram
- [ ] Verify state file updates correctly in `data/maa-newsletter-state.json`
