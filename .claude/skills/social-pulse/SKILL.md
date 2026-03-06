---
name: social-pulse
description: >-
  Scan X (Twitter) and Reddit for trending GLP-1, weight loss, and medical
  weight loss conversations. Use when Derek says "social pulse", "what's
  trending", "X trends", "reddit trends", "pulse", or wants content ideas
  based on real-time social media discussions.
user-invocable: true
argument-hint: "[keywords]"
allowed-tools:
  - WebSearch
  - WebFetch
  - Read
  - Write
  - Glob
  - Grep
context: fork
metadata:
  author: Atlas
  version: 1.0.0
---

# Social Pulse: X + Reddit Trend Scanner

Scan X and Reddit for trending conversations about GLP-1, weight loss, and medical weight loss. Deliver a structured report with content hook ideas.

## Instructions

### Step 1: Determine Search Keywords
Default keywords (always include):
- GLP-1, semaglutide, tirzepatide, weight loss clinic, medical weight loss
- compounded semaglutide, weight loss medication, telehealth weight loss
- weight loss injections, obesity medicine

If $ARGUMENTS provided, add those as additional keywords.

### Step 2: Search X (Twitter)
Run WebSearch queries targeting X/Twitter:
- `site:x.com GLP-1 weight loss` (last 7 days)
- `site:x.com semaglutide side effects`
- `site:x.com medical weight loss clinic`
- `site:x.com compounded semaglutide`
- `site:x.com tirzepatide weight loss`
- `site:x.com "weight loss medication" 2026`

For each result, note: topic, sentiment (positive/negative/neutral), engagement level, key quotes.

### Step 3: Search Reddit
Run WebSearch queries targeting Reddit:
- `site:reddit.com/r/GLP1_Medicines` (recent)
- `site:reddit.com/r/Semaglutide` (recent)
- `site:reddit.com/r/loseit GLP-1`
- `site:reddit.com/r/WeightLossAdvice medication`
- `site:reddit.com/r/Tirzepatide`
- `site:reddit.com weight loss clinic experience 2026`

Use WebFetch on the top 3-5 most relevant Reddit threads to get full context.

### Step 4: Compile Report
Write the report to `data/social-pulse/YYYY-MM-DD.md` with today's date.

Report structure:

```markdown
# Social Pulse: [DATE]

## Trending Topics
Top 5 topics being discussed across X and Reddit. Each with:
- Topic name
- Platform(s) where it's trending
- Brief summary (2-3 sentences)
- Sentiment: positive / negative / mixed

## Patient Sentiment
Common themes from real patient discussions:
- Complaints (side effects, cost, access)
- Questions patients are asking
- Fears and objections
- Wins and positive experiences

## Myth-Busting Opportunities
Misinformation or misconceptions circulating that Derek can correct:
- The myth
- Where it's spreading
- The truth (with evidence framing)
- Suggested post angle

## Competitor Intel
What other clinics, telehealth companies, and weight loss providers are saying:
- Messaging themes
- Offers being promoted
- Gaps in their messaging (our opportunity)

## Content Hook Ideas
5 ready-to-use post hooks based on what's trending:
1. [Hook text] -- Platform: FB/X/Both -- Pillar: [1-5]
2. ...

## Breaking News
FDA updates, drug pricing changes, regulatory news, study results.
Only include if something genuinely new surfaced.
```

### Step 5: Deliver Summary
After saving the file, provide a concise Telegram-friendly summary:
- Top 3 trending topics (one line each)
- Top 3 content hooks (ready to use)
- Any breaking news worth knowing

Do NOT dump the full report into Telegram. Keep the summary under 500 words.

## Examples

**User says:** `/pulse`
**Action:** Run full scan with default keywords, save report, deliver summary.

**User says:** `/pulse peptides`
**Action:** Run full scan with default keywords PLUS "peptides" as additional keyword.

**User says:** "what's trending in weight loss right now?"
**Action:** Run full scan, deliver summary.

## Troubleshooting

**WebSearch returns no X results:**
X results may be sparse via search. Fall back to searching for "twitter.com" instead of "x.com" in queries. Also try without site: prefix using "GLP-1 twitter discussion" style queries.

**Reddit threads are too old:**
Add "2026" to search queries to filter for recent content. If still stale, note in report that Reddit activity was low this week.

**Rate limiting on WebFetch:**
If a URL fails, skip it and note in report. Prioritize Reddit threads over X since Reddit has richer discussion content.
