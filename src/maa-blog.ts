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
import { getChromeUA } from "./chrome-ua.ts";

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

/**
 * Repair malformed JSON from LLM output.
 * Handles: literal newlines/tabs inside string values, unescaped double quotes
 * in HTML attributes (e.g. href="/path"), and other control characters.
 * Uses a state machine to track whether we're inside a JSON string or not.
 */
function repairLlmJson(raw: string): string {
  let result = "";
  let inString = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (inString) {
      if (ch === "\\") {
        // Escape sequence — copy both chars verbatim
        result += ch + (raw[i + 1] || "");
        i += 2;
        continue;
      }
      if (ch === '"') {
        // Is this the end of the string, or an unescaped quote inside content?
        // Look ahead: skip ALL whitespace (incl newlines), check for valid JSON structure
        const rest = raw.substring(i + 1);
        const trimmed = rest.replace(/^\s*/, "");
        const next = trimmed[0];
        if (
          next === "," || next === "}" || next === "]" || next === ":" ||
          next === undefined
        ) {
          // Genuine end of string
          inString = false;
          result += ch;
        } else if (/^\s*"/.test(rest)) {
          // Next non-whitespace is another quote — could be next key. End string.
          inString = false;
          result += ch;
        } else {
          // Unescaped quote inside string content (e.g. HTML href="...")
          result += '\\"';
        }
        i++;
        continue;
      }
      if (ch === "\n") { result += "\\n"; i++; continue; }
      if (ch === "\r") { result += "\\r"; i++; continue; }
      if (ch === "\t") { result += "\\t"; i++; continue; }
      result += ch;
    } else {
      if (ch === '"') inString = true;
      result += ch;
    }
    i++;
  }
  return result;
}

const MAA_DASHBOARD_TOKEN = process.env.MAA_DASHBOARD_TOKEN || "";
const SAGE_API_URL = `${MAA_SITE_URL}/wp-json/maa/v1/dashboard/sage`;
const SAGE_PERIOD = "90d";
const SAGE_MIN_QUESTION_COUNT = 5;
const SAGE_COOLDOWN_DAYS = 90;

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

async function fetchSageData(): Promise<SageDashboardResponse | null> {
  if (!MAA_DASHBOARD_TOKEN) {
    warn("maa-blog", "MAA_DASHBOARD_TOKEN not set, skipping SAGE query");
    return null;
  }

  try {
    const res = await fetch(`${SAGE_API_URL}?period=${SAGE_PERIOD}`, {
      headers: { Authorization: `Bearer ${MAA_DASHBOARD_TOKEN}` },
      signal: AbortSignal.timeout(API_TIMEOUT),
    });

    if (!res.ok) {
      warn("maa-blog", `SAGE API ${res.status}, falling back to pillars`);
      return null;
    }

    const raw = (await res.json()) as any;
    return normalizeSageResponse(raw);
  } catch (err) {
    warn("maa-blog", `SAGE API failed: ${err}, falling back to pillars`);
    return null;
  }
}

/**
 * The SAGE dashboard endpoint dropped `top_questions` in favor of the nested
 * `question_insights: [{ topic, count, intents: [{ questions: [{ text, date }] }] }]`
 * shape. Flatten it back into the legacy `top_questions` array so downstream
 * topic-selection and prompt-building code keeps working.
 */
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
  sageCooldown: Record<string, string>; // topic theme -> ISO date last published
  lastSageSource: "sage" | "pillar";
}

function loadState(): MAABlogState {
  try {
    if (existsSync(BLOG_STATE_FILE)) {
      const raw = JSON.parse(readFileSync(BLOG_STATE_FILE, "utf-8"));
      return {
        sageCooldown: {},
        lastSageSource: "pillar",
        ...raw,
      };
    }
  } catch {}
  return {
    pillarIndex: 0,
    topicIndex: 0,
    postsPublished: 0,
    lastPublished: null,
    recentTitles: [],
    sageCooldown: {},
    lastSageSource: "pillar",
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

async function resolveTagIds(tagNames: string[]): Promise<number[]> {
  const ids: number[] = [];

  for (const name of tagNames.slice(0, 5)) {
    try {
      // Search for existing tag
      const searchRes = await fetch(
        `${API_BASE}/tags?search=${encodeURIComponent(name)}&per_page=5`,
        {
          headers: { Authorization: authHeader(), "User-Agent": await getChromeUA() },
          signal: AbortSignal.timeout(API_TIMEOUT),
        }
      );

      if (searchRes.ok) {
        const tags = (await searchRes.json()) as { id: number; name: string }[];
        const exact = tags.find(
          (t) => t.name.toLowerCase() === name.toLowerCase()
        );
        if (exact) {
          ids.push(exact.id);
          continue;
        }
      }

      // Create new tag
      const createRes = await fetch(`${API_BASE}/tags`, {
        method: "POST",
        headers: {
          Authorization: authHeader(),
          "Content-Type": "application/json",
          "User-Agent": await getChromeUA(),
        },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(API_TIMEOUT),
      });

      if (createRes.ok) {
        const created = (await createRes.json()) as { id: number };
        ids.push(created.id);
      } else {
        warn("maa-blog", `Failed to create tag "${name}": ${createRes.status}`);
      }
    } catch (err) {
      warn("maa-blog", `Tag resolution failed for "${name}": ${err}`);
    }
  }

  return ids;
}

async function publishPost(
  title: string,
  content: string,
  excerpt: string,
  categories: number[] = [CATEGORIES.blog],
  slug?: string,
  tagIds?: number[],
  focusKeyphrase?: string,
  metaDescription?: string
): Promise<{ id: number; link: string } | null> {
  try {
    const body: Record<string, unknown> = {
      title,
      content,
      excerpt,
      status: "publish",
      categories,
    };

    if (slug) body.slug = slug;
    if (tagIds && tagIds.length > 0) body.tags = tagIds;
    if (focusKeyphrase) body.yoast_wpseo_focuskw = focusKeyphrase;
    if (metaDescription) body.yoast_wpseo_metadesc = metaDescription;

    const res = await fetch(`${API_BASE}/posts`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
        "User-Agent": await getChromeUA(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logError("maa-blog", `WP API ${res.status}: ${text.substring(0, 300)}`);
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

interface SageTopicSelection {
  theme: string;
  memberConcerns: string[]; // paraphrased themes, not raw questions
}

function selectSageTopic(
  sage: SageDashboardResponse,
  state: MAABlogState
): SageTopicSelection | null {
  const now = Date.now();
  const cooldownMs = SAGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

  // Filter topics by minimum count and cooldown
  const qualifying = sage.top_topics
    .filter((t) => t.count >= SAGE_MIN_QUESTION_COUNT)
    .filter((t) => {
      const lastPublished = state.sageCooldown[t.topic];
      if (!lastPublished) return true;
      return now - new Date(lastPublished).getTime() > cooldownMs;
    })
    .sort((a, b) => b.count - a.count);

  if (qualifying.length === 0) return null;

  const chosen = qualifying[0];

  // Map topic names to related keywords for matching questions
  const topicKeywords: Record<string, string[]> = {
    "Training & CE": ["training", "certification", "course", "class", "learn", "CE"],
    "Injectables (Botox/Fillers)": ["botox", "filler", "inject", "toxin", "reconstitut", "dilution", "units"],
    "Medical Director Requirements": ["medical director", "MD", "supervision", "collaborative", "CPOM"],
    "Equipment & Supplies": ["equipment", "supply", "device", "laser", "machine", "purchase"],
    "Pricing Strategy": ["price", "pricing", "charge", "cost", "fee", "rate", "commission"],
    "Hiring & Staffing": ["hire", "hiring", "staff", "employee", "pay", "salary", "commission", "RN", "esthetician"],
    "Licensing & Compliance": ["license", "compliance", "legal", "regulation", "scope", "board"],
    "Business Formation": ["LLC", "PLLC", "S-Corp", "EIN", "entity", "formation", "incorporate"],
    "Billing & Coding": ["billing", "coding", "insurance", "claim", "reimburse", "CPT"],
    "GLP-1 / Weight Loss": ["GLP-1", "semaglutide", "tirzepatide", "weight loss", "weight management"],
    "Marketing": ["marketing", "social media", "advertising", "SEO", "Google", "Instagram"],
    "Practice Management": ["management", "operations", "systems", "SOPs", "workflow"],
    "Patient Acquisition": ["patient", "client", "acquisition", "lead", "referral", "retention"],
    "Insurance & Liability": ["insurance", "liability", "malpractice", "coverage"],
  };

  const keywords = topicKeywords[chosen.topic] || [chosen.topic.toLowerCase()];

  // Find related questions and paraphrase into broad themes
  const relatedQuestions = sage.top_questions.filter((q) =>
    keywords.some((kw) => q.question.toLowerCase().includes(kw.toLowerCase()))
  );

  // Paraphrase questions into broad member concerns (no direct quotes)
  const concerns = relatedQuestions
    .slice(0, 6)
    .map((q) => paraphraseConcern(q.question));

  // Deduplicate similar concerns
  const uniqueConcerns = [...new Set(concerns)].slice(0, 4);

  return {
    theme: chosen.topic,
    memberConcerns: uniqueConcerns.length > 0
      ? uniqueConcerns
      : [`General guidance on ${chosen.topic.toLowerCase()} for aesthetic practices`],
  };
}

function paraphraseConcern(question: string): string {
  // Strip personal details and generalize into broad practitioner concerns
  const q = question.toLowerCase();

  if (q.includes("state") || q.includes("texas") || q.includes("florida") || q.includes("georgia") || q.includes("arizona") || q.includes("carolina"))
    return "State-specific regulatory requirements and compliance";
  if (q.includes("medical director") || q.includes("cpom") || q.includes("supervision"))
    return "Medical director and supervision requirements";
  if (q.includes("commission") || q.includes("pay") || q.includes("salary") || q.includes("split"))
    return "Compensation structures and fair pay models";
  if (q.includes("llc") || q.includes("pllc") || q.includes("entity") || q.includes("s-corp"))
    return "Choosing the right business entity and legal structure";
  if (q.includes("client") || q.includes("patient") || q.includes("market") || q.includes("small town"))
    return "Patient acquisition and marketing strategies";
  if (q.includes("price") || q.includes("pricing") || q.includes("charge") || q.includes("cost"))
    return "Pricing strategies and profitability";
  if (q.includes("hire") || q.includes("employee") || q.includes("handbook") || q.includes("staff"))
    return "Hiring, staffing, and team management";
  if (q.includes("own") || q.includes("open") || q.includes("start") || q.includes("launch"))
    return "Starting and owning an aesthetics practice";
  if (q.includes("inject") || q.includes("botox") || q.includes("filler") || q.includes("reconstitut"))
    return "Injectable technique and product knowledge";
  if (q.includes("billing") || q.includes("coding") || q.includes("insurance"))
    return "Billing, coding, and reimbursement practices";

  return "Building and growing a successful aesthetics practice";
}

export function buildBlogPrompt(
  topic: string,
  pillar: string,
  recentTitles: string[],
  sageContext?: { theme: string; concerns: string[] }
): string {
  const recentBlock =
    recentTitles.length > 0
      ? `\nRecent posts (avoid duplicating these angles):\n${recentTitles.map((t) => `- ${t}`).join("\n")}\n`
      : "";

  const sageBlock = sageContext
    ? `\nAesthetic practitioners are actively seeking guidance on ${sageContext.theme.toLowerCase()}. Key areas of interest include:\n${sageContext.concerns.map((c) => `- ${c}`).join("\n")}\nWrite content that addresses these themes broadly for all practitioners, not as answers to individual questions.\n`
    : "";

  return `You are a blog writer for The Medical Aesthetics Association (TMAA), a professional organization for aesthetic practitioners (NPs, RNs, PAs, estheticians) who are starting or growing their own aesthetics practices.

Write a blog post on this topic: "${topic}"
Category: ${pillar}
${recentBlock}${sageBlock}
CONTENT GUIDELINES:
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

SEO GUIDELINES:
- The focus keyphrase must appear naturally in: the title, the first paragraph, at least one H2 heading, and the meta description
- H2 headings should mirror actual search queries practitioners would type into Google
- Include 2-3 internal links using these URLs where relevant:
  - /join (for membership references)
  - /resources (for tools/downloads references)
  - /advisor/ (for AI practice advisor references)
  Format as relative URLs: <a href="/join">become a TMAA member</a>

FAQ SECTION:
- Include exactly 3 FAQ items at the bottom of the content
- Frame as "questions practitioners commonly have" (NOT "questions our members asked")
- Each Q should be a natural search query someone would type into Google
- Each A should be 2-3 sentences, direct and authoritative

FORMAT YOUR RESPONSE AS JSON with these exact keys:
{
  "title": "Blog post title (compelling, under 60 chars, includes focus keyphrase)",
  "slug": "3-5 word keyword slug (e.g. medspa-commission-structure)",
  "focusKeyphrase": "Primary 2-4 word search term (e.g. medspa commission structure)",
  "metaDescription": "Under 155 chars, includes focus keyphrase, compelling for SERP click",
  "excerpt": "2-3 sentence summary for social sharing",
  "tags": ["3-5 relevant tags, e.g. medspa, compliance, business formation"],
  "content": "Full HTML blog post content. Use <h2>, <h3>, <p>, <ul>/<li>, <strong> tags. No inline styles. No <h1>. Include internal links and FAQ section at the end.",
  "faq": [
    {"question": "Natural search query?", "answer": "Direct 2-3 sentence answer."},
    {"question": "Natural search query?", "answer": "Direct 2-3 sentence answer."},
    {"question": "Natural search query?", "answer": "Direct 2-3 sentence answer."}
  ]
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

  // Try SAGE-driven topic selection first
  let sageSelection: SageTopicSelection | null = null;
  let topic: string;
  let pillar: string;

  const sageData = await fetchSageData();
  if (sageData?.available) {
    sageSelection = selectSageTopic(sageData, state);
  }

  if (sageSelection) {
    // SAGE-driven: use the trending theme as the topic
    topic = sageSelection.theme;
    pillar = sageSelection.theme;
    info("maa-blog", `SAGE-driven topic: "${topic}" (demand-based)`);
  } else {
    // Fall back to pillar rotation
    const next = getNextTopic(state);
    topic = next.topic;
    pillar = next.pillar;
    info("maa-blog", `Pillar topic: "${topic}" (${pillar})`);
  }

  const prompt = buildBlogPrompt(
    topic,
    pillar,
    state.recentTitles,
    sageSelection
      ? { theme: sageSelection.theme, concerns: sageSelection.memberConcerns }
      : undefined
  );

  let response: string;
  try {
    response = await generateFn(prompt);
  } catch (err) {
    return { success: false, error: `Generation failed: ${err}` };
  }

  // Parse JSON response
  let parsed: { title: string; excerpt: string; content: string; category?: string; slug?: string; focusKeyphrase?: string; metaDescription?: string; tags?: string[]; faq?: Array<{ question: string; answer: string }> };
  try {
    // Strip markdown code fences if present
    let cleaned = response
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    // Try direct parse first, fall back to repair
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      cleaned = repairLlmJson(cleaned);
      parsed = JSON.parse(cleaned);
    }
  } catch (err) {
    // Save raw output for debugging
    if (!existsSync(BLOG_DRAFTS_DIR)) mkdirSync(BLOG_DRAFTS_DIR, { recursive: true });
    const debugFile = join(BLOG_DRAFTS_DIR, `failed-${Date.now()}.txt`);
    writeFileSync(debugFile, response);
    return { success: false, error: `JSON parse failed (saved to ${debugFile}): ${err}` };
  }

  if (!parsed.title || !parsed.content) {
    if (!existsSync(BLOG_DRAFTS_DIR)) mkdirSync(BLOG_DRAFTS_DIR, { recursive: true });
    const debugFile = join(BLOG_DRAFTS_DIR, `missing-fields-${Date.now()}.json`);
    writeFileSync(debugFile, JSON.stringify({ rawResponse: response, parsed }, null, 2));
    return { success: false, error: `Missing title or content in generated response (saved to ${debugFile})` };
  }

  // Build FAQ HTML section if present
  let faqHtml = "";
  if (parsed.faq && parsed.faq.length > 0) {
    faqHtml =
      `\n\n<h2>Frequently Asked Questions</h2>\n` +
      parsed.faq
        .map((f) => `<h3>${f.question}</h3>\n<p>${f.answer}</p>`)
        .join("\n");
  }

  // Assemble final content: post body + FAQ + branding footer
  const brandedContent =
    parsed.content +
    faqHtml +
    `\n\n<hr />\n<p><em>The Medical Aesthetics Association provides tools, resources, and community for aesthetic practitioners building their own practices. <a href="/join">Become a member</a> or try <a href="/advisor/">S.A.G.E., our AI practice advisor</a>.</em></p>`;

  // Resolve tags
  const tagIds = parsed.tags && parsed.tags.length > 0
    ? await resolveTagIds(parsed.tags)
    : [];

  // Publish
  const categories = [CATEGORIES.blog];
  const post = await publishPost(
    parsed.title,
    brandedContent,
    parsed.excerpt,
    categories,
    parsed.slug,
    tagIds,
    parsed.focusKeyphrase,
    parsed.metaDescription
  );

  if (!post) {
    if (!existsSync(BLOG_DRAFTS_DIR)) mkdirSync(BLOG_DRAFTS_DIR, { recursive: true });
    const draftFile = join(BLOG_DRAFTS_DIR, `draft-${Date.now()}.json`);
    writeFileSync(draftFile, JSON.stringify(parsed, null, 2));
    return { success: false, error: `Publish failed (draft saved to ${draftFile})` };
  }

  // Update state
  if (sageSelection) {
    // Record SAGE cooldown
    state.sageCooldown[sageSelection.theme] = new Date().toISOString();
    state.lastSageSource = "sage";
  } else {
    // Advance pillar rotation
    advanceTopic(state);
    state.lastSageSource = "pillar";
  }
  state.postsPublished++;
  state.lastPublished = new Date().toISOString();
  state.recentTitles.push(parsed.title);
  if (state.recentTitles.length > 10) {
    state.recentTitles = state.recentTitles.slice(-10);
  }
  saveState(state);

  return { success: true, title: parsed.title, link: post.link };
}
