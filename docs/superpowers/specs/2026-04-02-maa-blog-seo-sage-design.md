# MAA Blog: SAGE-Driven Topics + SEO Optimization

**Date:** 2026-04-02
**Status:** Approved
**Scope:** `src/maa-blog.ts` in Atlas project

## Problem

The MAA blog auto-publisher generates decent content on a static 40-topic rotation, but:
1. Topics don't reflect what members actually care about right now
2. Posts lack SEO optimization (no focus keyphrase, FAQ section, meta description, tags, optimized slug)
3. No structured data for AI discoverability (Google AI Overviews, Perplexity, ChatGPT search)
4. No internal linking strategy
5. Yoast SEO fields are left blank on every post

## Solution

Two changes to `maa-blog.ts`:
1. **SAGE-driven topic selection** — query the SAGE dashboard API for trending member questions before each publish, use that data to pick topics that address real demand
2. **SEO-optimized output** — upgrade the prompt and WP API call to produce fully optimized posts

## Design

### 1. SAGE-Driven Topic Selection

Before each publish, query the SAGE dashboard API:

```
GET https://medicalaestheticsassociation.com/wp-json/maa/v1/dashboard/sage?period=90d
Authorization: Bearer <MAA_DASHBOARD_TOKEN from .env>
```

**Selection logic (in order):**
1. Pull `top_topics` and `top_questions` from response
2. Filter to topics with 5+ question count (minimum volume threshold)
3. Check each qualifying topic against `sageCooldown` in blog state — skip any topic published within the last 90 days
4. Pick the highest-volume qualifying topic that isn't on cooldown
5. Gather related `top_questions` for that topic — paraphrase into themes for the prompt (never reference SAGE, never quote individual questions verbatim)
6. If no SAGE topic qualifies (all on cooldown or under threshold), fall back to existing pillar rotation

**Failure handling:** If the SAGE API is down, times out, or errors, log a warning and fall back to pillar rotation. SAGE unavailability never blocks publishing.

### 2. Blog State Changes

```typescript
interface MAABlogState {
  // existing
  pillarIndex: number;
  topicIndex: number;
  postsPublished: number;
  lastPublished: string | null;
  recentTitles: string[];
  // new
  sageCooldown: Record<string, string>; // topic theme -> ISO date last published
  lastSageSource: "sage" | "pillar";    // what drove the last post
}
```

### 3. SEO-Upgraded Prompt

The prompt instructs Claude to produce:

```json
{
  "title": "Under 60 chars, includes focus keyphrase naturally",
  "slug": "3-5 word keyword-focused slug",
  "focusKeyphrase": "Primary search term practitioners would Google",
  "metaDescription": "Under 155 chars, includes keyphrase, compelling for SERP click",
  "excerpt": "2-3 sentence summary for social sharing",
  "tags": ["3-5 relevant WordPress tags"],
  "content": "Full HTML blog post with internal links and structured headings",
  "faq": [
    {"question": "...", "answer": "..."}
  ]
}
```

**Prompt rules:**
- When SAGE-inspired: inject trending theme as "Aesthetic practitioners are actively seeking guidance on..." — never mention SAGE, members, or data
- Write for the whole practitioner audience, not one person's question
- 3-4 FAQ items at bottom, framed as "questions practitioners commonly have"
- 2-3 internal links to MAA pages (/join, /resources, /advisor, or previous blog posts)
- Focus keyphrase must appear in: title, first paragraph, one H2, meta description
- H2s should mirror actual search queries people type

### 4. FAQ in HTML

The FAQ array from Claude's output gets appended to content as:

```html
<h2>Frequently Asked Questions</h2>
<h3>Question text here?</h3>
<p>Answer text here.</p>
```

Yoast automatically generates FAQ schema from this H3-based pattern. No additional schema markup needed.

### 5. WP REST API Publishing

Upgraded payload:

```typescript
{
  title,
  content,          // includes FAQ section + branding footer
  excerpt,
  slug,             // short, keyword-focused
  status: "publish",
  categories: [27],
  tags: [resolved tag IDs],

  // Yoast SEO fields
  yoast_wpseo_focuskw: focusKeyphrase,
  yoast_wpseo_metadesc: metaDescription,
}
```

**Tag resolution:** For each tag name from Claude's output:
1. `GET /wp-json/wp/v2/tags?search=tagname` — check if exists
2. If exists, use its ID
3. If not, `POST /wp-json/wp/v2/tags` with the name to create it
4. Collect all IDs into the tags array

### 6. New Environment Variable

```
MAA_DASHBOARD_TOKEN=<bearer token for SAGE dashboard API>
```

Added to Atlas `.env`. Used only for the SAGE API query.

### 7. What Doesn't Change

- Cron schedule (Tuesday + Friday 9 AM MST)
- Auth mechanism (WP Application Password for publishing)
- Error handling pattern (save draft locally on failure)
- Telegram notification on success/failure
- Branding footer appended to every post
- Claude model (Sonnet via `runPrompt`)

## Key Constraint

SAGE data **inspires** topic selection. The blog must read as authoritative industry content for the entire practitioner audience. No references to member questions, SAGE, dashboards, or data sources. The reader should never know the topic was demand-driven.

## Files Modified

- `src/maa-blog.ts` — all changes contained here
- `.env` — add MAA_DASHBOARD_TOKEN
