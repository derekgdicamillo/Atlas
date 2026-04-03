# MAA Blog: SAGE-Driven Topics + SEO Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `maa-blog.ts` to pick topics from real SAGE member demand and publish fully SEO-optimized posts with Yoast metadata, FAQ sections, tags, and optimized slugs.

**Architecture:** Single-file change to `src/maa-blog.ts`. Before each publish, query the SAGE dashboard API for trending topics/questions. If a qualifying SAGE topic exists (5+ questions, not on 90-day cooldown), use it. Otherwise fall back to the existing pillar rotation. The prompt is upgraded to produce SEO fields. The WP API call is upgraded to set Yoast meta, tags, and slug.

**Tech Stack:** Bun + TypeScript, WordPress REST API, Yoast SEO REST fields, SAGE dashboard API

**Spec:** `docs/superpowers/specs/2026-04-02-maa-blog-seo-sage-design.md`

---

### Task 1: Add Environment Variable + SAGE API Fetcher

**Files:**
- Modify: `src/maa-blog.ts:20-30` (config section)
- Modify: `.env` (add MAA_DASHBOARD_TOKEN)

- [ ] **Step 1: Add MAA_DASHBOARD_TOKEN to .env**

Append to the Atlas `.env` file:
```
MAA_DASHBOARD_TOKEN=773ee2f3797e7ab15fd30911b7487b7617fc2e3d60de763c
```

- [ ] **Step 2: Add config constant and types for SAGE data**

Add after the existing config constants (after line 30 in maa-blog.ts):

```typescript
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
```

- [ ] **Step 3: Write the SAGE API fetch function**

Add after the types:

```typescript
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

    return (await res.json()) as SageDashboardResponse;
  } catch (err) {
    warn("maa-blog", `SAGE API failed: ${err}, falling back to pillars`);
    return null;
  }
}
```

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/atlas
git add src/maa-blog.ts .env
git commit -m "feat(maa-blog): add SAGE dashboard API fetcher and config"
```

---

### Task 2: Upgrade Blog State with SAGE Cooldown

**Files:**
- Modify: `src/maa-blog.ts:112-138` (types and state functions)

- [ ] **Step 1: Update MAABlogState interface**

Replace the existing `MAABlogState` interface:

```typescript
interface MAABlogState {
  pillarIndex: number;
  topicIndex: number;
  postsPublished: number;
  lastPublished: string | null;
  recentTitles: string[];
  sageCooldown: Record<string, string>; // topic theme -> ISO date last published
  lastSageSource: "sage" | "pillar";
}
```

- [ ] **Step 2: Update loadState default to include new fields**

Update the default return in `loadState()`:

```typescript
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
```

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/atlas
git add src/maa-blog.ts
git commit -m "feat(maa-blog): add SAGE cooldown tracking to blog state"
```

---

### Task 3: SAGE-Driven Topic Selection Logic

**Files:**
- Modify: `src/maa-blog.ts` (add new function after `advanceTopic`)

- [ ] **Step 1: Write the SAGE topic selection function**

Add after `advanceTopic()`:

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/atlas
git add src/maa-blog.ts
git commit -m "feat(maa-blog): add SAGE topic selection with cooldown and paraphrasing"
```

---

### Task 4: Upgrade Blog Prompt for SEO

**Files:**
- Modify: `src/maa-blog.ts` (replace `buildBlogPrompt` function)

- [ ] **Step 1: Replace buildBlogPrompt with SEO-upgraded version**

Replace the entire `buildBlogPrompt` function:

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/atlas
git add src/maa-blog.ts
git commit -m "feat(maa-blog): upgrade prompt for SEO (keyphrase, FAQ, meta, tags, slug)"
```

---

### Task 5: Tag Resolution + Upgraded Publishing

**Files:**
- Modify: `src/maa-blog.ts` (replace `publishPost`, add `resolveTagIds`)

- [ ] **Step 1: Add tag resolution function**

Add before `publishPost`:

```typescript
async function resolveTagIds(tagNames: string[]): Promise<number[]> {
  const ids: number[] = [];

  for (const name of tagNames.slice(0, 5)) {
    try {
      // Search for existing tag
      const searchRes = await fetch(
        `${API_BASE}/tags?search=${encodeURIComponent(name)}&per_page=5`,
        {
          headers: { Authorization: authHeader() },
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
```

- [ ] **Step 2: Replace publishPost with upgraded version**

Replace the entire `publishPost` function:

```typescript
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
```

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/atlas
git add src/maa-blog.ts
git commit -m "feat(maa-blog): add tag resolution and Yoast meta fields to publish"
```

---

### Task 6: Upgrade publishMAABlog Main Function

**Files:**
- Modify: `src/maa-blog.ts` (replace `publishMAABlog` function)

- [ ] **Step 1: Update the parsed type to include new fields**

Update the type in `publishMAABlog` where we parse Claude's JSON response. Replace the entire `publishMAABlog` function:

```typescript
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
  if (sageData) {
    sageSelection = selectSageTopic(sageData, state);
  }

  if (sageSelection) {
    // SAGE-inspired topic: use the theme as both topic and pillar
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
  let parsed: {
    title: string;
    slug?: string;
    focusKeyphrase?: string;
    metaDescription?: string;
    excerpt: string;
    tags?: string[];
    content: string;
    faq?: { question: string; answer: string }[];
    category?: string;
  };
  try {
    const cleaned = response
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    if (!existsSync(BLOG_DRAFTS_DIR)) mkdirSync(BLOG_DRAFTS_DIR, { recursive: true });
    const debugFile = join(BLOG_DRAFTS_DIR, `failed-${Date.now()}.txt`);
    writeFileSync(debugFile, response);
    return { success: false, error: `JSON parse failed (saved to ${debugFile}): ${err}` };
  }

  if (!parsed.title || !parsed.content) {
    return { success: false, error: "Missing title or content in generated response" };
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
```

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/atlas
git add src/maa-blog.ts
git commit -m "feat(maa-blog): integrate SAGE selection + SEO into publishMAABlog"
```

---

### Task 7: Write Tests

**Files:**
- Create: `tests/maa-blog.test.ts`

- [ ] **Step 1: Write tests for SAGE topic selection and prompt building**

```typescript
import { describe, test, expect } from "bun:test";
import { buildBlogPrompt } from "../src/maa-blog.ts";

describe("buildBlogPrompt", () => {
  test("produces basic prompt without SAGE context", () => {
    const prompt = buildBlogPrompt("Pricing your services", "Business Growth", []);
    expect(prompt).toContain("Pricing your services");
    expect(prompt).toContain("Business Growth");
    expect(prompt).toContain("focusKeyphrase");
    expect(prompt).toContain("metaDescription");
    expect(prompt).toContain("slug");
    expect(prompt).toContain("faq");
    expect(prompt).toContain("tags");
    expect(prompt).not.toContain("actively seeking guidance");
  });

  test("includes SAGE context when provided", () => {
    const prompt = buildBlogPrompt(
      "Hiring & Staffing",
      "Hiring & Staffing",
      ["Previous post title"],
      {
        theme: "Hiring & Staffing",
        concerns: [
          "Compensation structures and fair pay models",
          "Hiring, staffing, and team management",
        ],
      }
    );
    expect(prompt).toContain("actively seeking guidance on hiring & staffing");
    expect(prompt).toContain("Compensation structures and fair pay models");
    expect(prompt).toContain("Previous post title");
    expect(prompt).not.toContain("SAGE");
    expect(prompt).not.toContain("dashboard");
    expect(prompt).not.toContain("member asked");
  });

  test("includes recent titles block", () => {
    const prompt = buildBlogPrompt("Test topic", "Test pillar", [
      "Title One",
      "Title Two",
    ]);
    expect(prompt).toContain("Title One");
    expect(prompt).toContain("Title Two");
    expect(prompt).toContain("avoid duplicating");
  });

  test("requires internal links in prompt", () => {
    const prompt = buildBlogPrompt("Test", "Test", []);
    expect(prompt).toContain("/join");
    expect(prompt).toContain("/resources");
    expect(prompt).toContain("/advisor/");
  });

  test("requires FAQ in prompt", () => {
    const prompt = buildBlogPrompt("Test", "Test", []);
    expect(prompt).toContain("exactly 3 FAQ");
    expect(prompt).toContain("questions practitioners commonly have");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd ~/Projects/atlas
bun test tests/maa-blog.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/atlas
git add tests/maa-blog.test.ts
git commit -m "test(maa-blog): add tests for SEO prompt and SAGE context injection"
```

---

### Task 8: Type Check + Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run TypeScript type check**

```bash
cd ~/Projects/atlas
bunx tsc --noEmit
```

Expected: No errors related to maa-blog.ts changes.

- [ ] **Step 2: Run all tests**

```bash
cd ~/Projects/atlas
bun test
```

Expected: All tests pass, including new maa-blog tests.

- [ ] **Step 3: Verify exports are unchanged**

The cron.ts import `{ isMAABlogReady, publishMAABlog }` must still work. `publishMAABlog` signature is unchanged (takes `generateFn`, returns `Promise<MAABlogResult>`). `isMAABlogReady` is unchanged. No cron.ts modifications needed.

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
cd ~/Projects/atlas
git add -A
git commit -m "fix(maa-blog): address type check or test issues"
```

Only run this step if Steps 1-2 required fixes.
