/**
 * Atlas — MAA Blog Auto-Publisher
 *
 * Generates and publishes blog posts on medicalaestheticsassociation.com
 * twice weekly (Tuesdays & Fridays). Uses Claude to write SEO-optimized
 * content for aesthetic practitioners.
 *
 * Auth: WP Application Password (Basic Auth over HTTPS).
 * Site: medicalaestheticsassociation.com
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { info, warn, error as logError } from "./logger.ts";

// ============================================================
// CONFIG
// ============================================================

const MAA_SITE_URL = process.env.MAA_WP_SITE_URL || "https://medicalaestheticsassociation.com";
const MAA_WP_USER = process.env.MAA_WP_USER || "";
const MAA_WP_APP_PASSWORD = process.env.MAA_WP_APP_PASSWORD || "";

const API_BASE = `${MAA_SITE_URL}/wp-json/wp/v2`;
const API_TIMEOUT = 30_000;

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const BLOG_STATE_FILE = join(DATA_DIR, "maa-blog-state.json");
const BLOG_DRAFTS_DIR = join(DATA_DIR, "maa-blog-drafts");

// Blog category IDs on MAA site
const CATEGORIES = {
  blog: 27,
  healthAndWeightLoss: 25,
  skin: 8,
};

// Topic rotation - cycles through these categories of content
const TOPIC_PILLARS = [
  {
    name: "Practice Launch",
    topics: [
      "Steps to launching your first aesthetics practice",
      "How to choose the right business entity for your medspa",
      "Lease negotiation tips for new aesthetic practices",
      "First 90 days after opening your aesthetics practice",
      "Equipment and supply essentials for a new medspa",
      "Hiring your first employee for your aesthetics practice",
      "Setting up EHR and practice management systems",
      "Creating your patient intake and consent process",
    ],
  },
  {
    name: "Regulatory & Compliance",
    topics: [
      "Understanding CPOM laws and how they affect your practice",
      "Medical director agreements: what to include and what to avoid",
      "Scope of practice for NPs in aesthetics by state type",
      "HIPAA compliance essentials for small aesthetic practices",
      "Insurance requirements every new medspa owner needs",
      "Navigating OSHA regulations for aesthetic practices",
      "How to handle adverse events and documentation requirements",
      "State board reporting requirements for aesthetic procedures",
    ],
  },
  {
    name: "Business Growth",
    topics: [
      "How to price aesthetic treatments for profitability",
      "Building a membership model for your aesthetics practice",
      "Social media marketing strategies that actually work for medspas",
      "Google Business Profile optimization for aesthetic practices",
      "Patient retention strategies beyond discounting",
      "When and how to add new services to your practice",
      "Building referral systems that generate consistent new patients",
      "Managing cash flow in a seasonal aesthetics business",
    ],
  },
  {
    name: "Clinical Business",
    topics: [
      "Training and certification pathways for aesthetic procedures",
      "How to build efficient treatment protocols that scale",
      "Managing patient expectations in aesthetic medicine",
      "Before and after photography best practices for compliance",
      "Combining weight loss services with aesthetics",
      "Peptide therapy as a practice revenue stream",
      "Building hormone optimization services alongside aesthetics",
      "Creating treatment packages that increase average ticket",
    ],
  },
  {
    name: "Operations & Scaling",
    topics: [
      "Systems every aesthetics practice needs to run without you",
      "KPIs every medspa owner should track weekly",
      "How to delegate effectively as a nurse practitioner owner",
      "Building SOPs that keep your practice consistent",
      "When to hire a practice manager vs doing it yourself",
      "Inventory management strategies for aesthetic practices",
      "Managing multiple locations and scaling your medspa brand",
      "Exit strategies and building a sellable aesthetics practice",
    ],
  },
];

// ============================================================
// TYPES & STATE
// ============================================================

interface MAABlogState {
  pillarIndex: number;
  topicIndex: number;
  postsPublished: number;
  lastPublished: string | null;
  recentTitles: string[];
}

function loadState(): MAABlogState {
  try {
    if (existsSync(BLOG_STATE_FILE)) {
      return JSON.parse(readFileSync(BLOG_STATE_FILE, "utf-8"));
    }
  } catch {}
  return {
    pillarIndex: 0,
    topicIndex: 0,
    postsPublished: 0,
    lastPublished: null,
    recentTitles: [],
  };
}

function saveState(state: MAABlogState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BLOG_STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// WP API
// ============================================================

function authHeader(): string {
  const encoded = Buffer.from(`${MAA_WP_USER}:${MAA_WP_APP_PASSWORD}`).toString("base64");
  return `Basic ${encoded}`;
}

export function isMAABlogReady(): boolean {
  return !!(MAA_WP_USER && MAA_WP_APP_PASSWORD);
}

async function publishPost(
  title: string,
  content: string,
  excerpt: string,
  categories: number[] = [CATEGORIES.blog]
): Promise<{ id: number; link: string } | null> {
  try {
    const res = await fetch(`${API_BASE}/posts`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        content,
        excerpt,
        status: "publish",
        categories,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logError("maa-blog", `WP API ${res.status}: ${body.substring(0, 300)}`);
      return null;
    }

    const post = (await res.json()) as { id: number; link: string };
    info("maa-blog", `Published: "${title}" (ID ${post.id}) at ${post.link}`);
    return post;
  } catch (err) {
    logError("maa-blog", `Failed to publish: ${err}`);
    return null;
  }
}

// ============================================================
// BLOG GENERATION
// ============================================================

function getNextTopic(state: MAABlogState): { pillar: string; topic: string } {
  const pillar = TOPIC_PILLARS[state.pillarIndex % TOPIC_PILLARS.length];
  const topic = pillar.topics[state.topicIndex % pillar.topics.length];
  return { pillar: pillar.name, topic };
}

function advanceTopic(state: MAABlogState): void {
  const pillar = TOPIC_PILLARS[state.pillarIndex % TOPIC_PILLARS.length];
  state.topicIndex++;
  if (state.topicIndex >= pillar.topics.length) {
    state.topicIndex = 0;
    state.pillarIndex = (state.pillarIndex + 1) % TOPIC_PILLARS.length;
  }
}

export function buildBlogPrompt(topic: string, pillar: string, recentTitles: string[]): string {
  const recentBlock =
    recentTitles.length > 0
      ? `\nRecent posts (avoid duplicating these angles):\n${recentTitles.map((t) => `- ${t}`).join("\n")}\n`
      : "";

  return `You are a blog writer for The Medical Aesthetics Association (TMAA), a professional organization for aesthetic practitioners (NPs, RNs, PAs, estheticians) who are starting or growing their own aesthetics practices.

Write a blog post on this topic: "${topic}"
Category: ${pillar}
${recentBlock}
GUIDELINES:
- Write for practitioners who are either planning to launch or actively running an aesthetics practice
- Be practical and specific. Include actionable steps, not theory.
- Write from the perspective of practice owners who have done this (first-person plural "we" is fine)
- Length: 1200-1800 words
- Tone: Professional but approachable. Direct. No fluff. No corporate speak.
- Do NOT use em dashes. Use periods and commas instead.
- Avoid AI-sounding phrases: "landscape", "navigate", "leverage", "delve", "game-changer", "holistic approach", "it's important to note"
- Use real-world examples when possible
- Include at least one specific number, stat, or dollar figure where relevant
- End with a clear next step or takeaway

FORMAT YOUR RESPONSE AS JSON with these exact keys:
{
  "title": "Blog post title (compelling, under 70 chars, no clickbait)",
  "excerpt": "2-3 sentence summary for search results and social sharing",
  "content": "Full HTML blog post content. Use <h2>, <h3>, <p>, <ul>/<li>, <strong> tags. No inline styles. No <h1> (WordPress adds that from the title).",
  "category": "blog"
}

Return ONLY the JSON. No markdown code fences. No explanation.`;
}

// ============================================================
// MAIN EXPORT
// ============================================================

export interface MAABlogResult {
  success: boolean;
  title?: string;
  link?: string;
  error?: string;
}

/**
 * Generate and publish a blog post on the MAA site.
 * Called by cron (Tuesdays & Fridays).
 *
 * @param generateFn - function that takes a prompt and returns Claude's response
 */
export async function publishMAABlog(
  generateFn: (prompt: string) => Promise<string>
): Promise<MAABlogResult> {
  if (!isMAABlogReady()) {
    return { success: false, error: "MAA WP credentials not configured" };
  }

  const state = loadState();
  const { pillar, topic } = getNextTopic(state);
  const prompt = buildBlogPrompt(topic, pillar, state.recentTitles);

  info("maa-blog", `Generating post: "${topic}" (${pillar})`);

  let response: string;
  try {
    response = await generateFn(prompt);
  } catch (err) {
    return { success: false, error: `Generation failed: ${err}` };
  }

  // Parse JSON response
  let parsed: { title: string; excerpt: string; content: string; category?: string };
  try {
    // Strip markdown code fences if present
    const cleaned = response
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Save raw output for debugging
    if (!existsSync(BLOG_DRAFTS_DIR)) mkdirSync(BLOG_DRAFTS_DIR, { recursive: true });
    const debugFile = join(BLOG_DRAFTS_DIR, `failed-${Date.now()}.txt`);
    writeFileSync(debugFile, response);
    return { success: false, error: `JSON parse failed (saved to ${debugFile}): ${err}` };
  }

  if (!parsed.title || !parsed.content) {
    return { success: false, error: "Missing title or content in generated response" };
  }

  // Add TMAA branding footer
  const brandedContent =
    parsed.content +
    `\n\n<hr />\n<p><em>The Medical Aesthetics Association provides tools, resources, and community for aesthetic practitioners building their own practices. <a href="/join">Become a member</a> or try <a href="/advisor/">S.A.G.E., our AI practice advisor</a>.</em></p>`;

  // Publish
  const categories = [CATEGORIES.blog];
  const post = await publishPost(parsed.title, brandedContent, parsed.excerpt, categories);

  if (!post) {
    // Save draft locally
    if (!existsSync(BLOG_DRAFTS_DIR)) mkdirSync(BLOG_DRAFTS_DIR, { recursive: true });
    const draftFile = join(BLOG_DRAFTS_DIR, `draft-${Date.now()}.json`);
    writeFileSync(draftFile, JSON.stringify(parsed, null, 2));
    return { success: false, error: `Publish failed (draft saved to ${draftFile})` };
  }

  // Update state
  advanceTopic(state);
  state.postsPublished++;
  state.lastPublished = new Date().toISOString();
  state.recentTitles.push(parsed.title);
  if (state.recentTitles.length > 10) {
    state.recentTitles = state.recentTitles.slice(-10);
  }
  saveState(state);

  return { success: true, title: parsed.title, link: post.link };
}
