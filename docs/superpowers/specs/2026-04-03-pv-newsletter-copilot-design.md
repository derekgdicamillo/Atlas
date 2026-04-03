# PV Newsletter Co-Pilot — Design Spec

**Date:** 2026-04-03
**Author:** Atlas + Derek
**Status:** Approved

## Overview

A collaborative newsletter creation system for PV MediSpa's "Derek's Vitality Unchained Newsletter." Atlas acts as a writing partner inside a dedicated Telegram topic thread, handling research, drafting, and GHL campaign creation while Derek provides the personal touch that makes the newsletter authentic.

**Goal:** Consistent weekly Thursday newsletter with ~15 minutes of Derek's time across Tuesday-Wednesday.

## Architecture

### Telegram Topic Thread

The existing Atlas Telegram group gets Topics (Forum mode) enabled. A "Newsletter" topic thread is created where Atlas operates in newsletter mode automatically.

- **Topic detection:** `relay.ts` checks incoming message `thread_id` against env var `PV_NEWSLETTER_TOPIC_ID`
- **Mode activation:** When a message arrives in the Newsletter topic, Atlas enters newsletter mode with:
  - Writing partner personality (collaborative, not task-assistant)
  - Auto-loaded context: latest PV blog posts, pillar rotation state, trending topics
  - Voice enforcement: all drafts pass through `/humanizer` skill with `memory/voice-guide.md`
- **Pattern:** Same as ToxTray's `groupChatEnv` routing, but keyed on topic thread ID instead of group chat ID

### Weekly Flow

```
Tuesday 7 AM  →  Cron fires, Atlas posts smart topic suggestion in Newsletter thread
Tuesday-Wed   →  Derek and Atlas collaborate on content in the thread
"Looks good"  →  Atlas pushes draft to GHL via V2 Campaign API
Thursday      →  Derek opens GHL, visual check, hits send
```

## Component 1: Tuesday Kickoff (Cron Job)

**Cron name:** `pv-newsletter-kickoff`
**Schedule:** Tuesday 7:00 AM MST
**Action:** Post a smart topic suggestion to the Newsletter thread

### Topic Selection Logic

Atlas builds its suggestion from four sources, prioritized:

1. **Latest PV blog post** — Fetch from pvmedispa.com via WP REST API (`GET /wp-json/wp/v2/posts?per_page=3&orderby=date&order=desc`). Pull title, excerpt, key teaching points.
2. **Pillar rotation** — Track which of the 5 Pillars was covered last. Suggest the next one in rotation:
   - Precision Weight Science
   - Nourishing Health
   - Dynamic Movement
   - Mindful Wellness
   - Functional Wellness
3. **Trending topics** — Quick web search for GLP-1/weight loss/med spa news that week
4. **Topic dedup** — Check last 6 weeks of newsletter topics from state file. Avoid repeats.

### Tuesday Message Format

```
Newsletter time. Your latest blog post covers [topic] — fits the [Pillar] pillar.
Also trending this week: [news item].

I'm thinking we lead with [angle] and weave in [connection].

What's your angle? Got a patient story or personal experience to tie in?
```

### State File

`data/pv-newsletter-state.json`:
```json
{
  "pillarRotationIndex": 0,
  "lastTopics": [
    { "date": "2026-03-27", "topic": "Protein timing on GLP-1s", "pillar": "Nourishing Health" }
  ],
  "currentDraft": {
    "weekOf": "2026-04-07",
    "status": "drafting",
    "topic": null,
    "pillar": null,
    "sections": {
      "intro": null,
      "education": null,
      "patientStory": null,
      "announcements": null,
      "references": []
    },
    "ghlCampaignId": null
  },
  "history": []
}
```

## Component 2: Collaborative Drafting

When Derek responds in the Newsletter thread, Atlas builds the newsletter iteratively:

### Round 1 — Personal Intro
- Atlas drafts the greeting ("Hi Vitality Unchained Tribe,") and personal hook based on Derek's input
- Bridges from personal story to the educational topic
- Posts in thread for feedback

### Round 2 — Educational Deep-Dive
- Atlas researches the topic: blog post content, supporting studies/data, relevant framework mapping
- Writes teaching section with bold key terms, clear explanations
- Suggests relevant image/diagram if applicable
- Posts in thread for feedback

### Round 3 — Patient Story + Takeaway
- Atlas prompts: "Got a patient example for this one?"
- Derek gives quick description (or skips)
- Atlas writes anonymized patient story woven into the narrative
- Adds motivational close/takeaway
- Posts in thread for feedback

### Round 4 — Announcements
- Atlas asks: "Any announcements this week?"
- Derek responds or says "nothing this week"
- Atlas writes announcement section or omits

### Round 5 — Final Assembly
- Atlas stitches all approved sections together
- Runs `/humanizer` skill with `memory/voice-guide.md` for final voice polish
- Runs content critic quality gate (brandVoice, compliance, engagement, accuracy)
- Posts complete newsletter in thread for final review
- Auto-generates subject line (Derek can override)

### Thread Commands
- **"looks good"** or **"send to GHL"** — triggers GHL draft push
- **"start over"** — wipes current draft sections, Atlas re-suggests topic
- **"skip this week"** — marks week as skipped, no further prompts until next Tuesday

### Drafting Rules
- Rounds are a guideline, not rigid. Atlas leads with Round 1 but Derek can jump ahead ("here's the whole story, just polish it") or skip rounds ("no patient story this week"). Atlas adapts.
- Each round is posted as a separate message in the thread
- Derek can respond to any round with feedback, additions, or "good"
- Atlas tracks which sections are approved in state file
- If Derek goes silent after Tuesday kickoff, Atlas sends one gentle nudge Wednesday morning: "Still working on the newsletter? Let me know your angle or I can draft one based on the blog post."
- No second nudge. If no response by Wednesday 5 PM, mark week as skipped.

## Component 3: Voice & Quality Gate

### Humanizer Integration
Every draft section runs through `/humanizer` skill before being posted in the thread:
- Input: raw draft text
- Reference: `memory/voice-guide.md` (Derek's teaching style)
- Output: polished text matching Derek's conversational, educational voice
- Removes: AI patterns, corporate speak, filler phrases, em dashes

### Content Critic
Same quality gate as the overnight content waterfall (`src/content-critic.ts`):
- **Brand voice** (0-1): Does it sound like Derek?
- **Compliance** (0-1, 2x weight): No banned equipment, no overclaiming
- **Engagement** (0-1): Would a patient actually read this?
- **Accuracy** (0-1): Framework names correct, no fabricated stats
- **Threshold:** 0.7 per dimension
- If below threshold: Atlas rewrites before posting. Derek never sees the bad version.

### References
When the educational section cites studies or data, Atlas auto-populates the References section at the bottom of the newsletter. Keeps credibility high.

## Component 4: GHL V2 Campaign API Integration

### Trigger
Derek says "looks good" or "send to GHL" in the Newsletter thread.

### Campaign Creation Flow

1. **Assemble HTML** — Map newsletter content into the template structure:
   - Header banner: static (Derek's Vitality Unchained Newsletter branding)
   - Personal intro section: from Round 1
   - Educational deep-dive: from Round 2
   - Patient story + takeaway: from Round 3
   - Announcements: from Round 4 (or omitted)
   - Sign-off: static ("To Living Life Unchained, Derek FNP")
   - Referral CTA: static (Join newsletter button)
   - Service CTAs: static (Weight loss, Men's HRT, Women's HRT buttons)
   - References: auto-generated
   - Footer: static (copyright, unsubscribe with GHL merge fields)

2. **Create GHL campaign** via V2 API:
   ```
   POST /emails/public/v2/locations/{locationId}/campaigns/email-campaign
   ```
   - Status: `draft`
   - Subject line: auto-generated (Derek can override)
   - Sender: derek@pvmedispa.com
   - Recipients: contacts with `newsletter` tag
   - Content: assembled HTML

3. **Confirm in thread:**
   ```
   Draft pushed to GHL. Subject: "[subject line]"
   Open it here: [GHL campaign link]
   Ready to send Thursday.
   ```

### GHL Configuration Required (One-Time Setup)
- GHL Location ID: `PCdXIc8QjGmy4JmuiMrs` (already known)
- Newsletter Template ID: extract from GHL (ID `688fcbbdfb7a744ecc4b807f` from the URL)
- GHL V2 API email campaign scopes: may need PIT token update
- Verify whether V2 API supports template-based campaign creation or requires full HTML

### Recipient Targeting
Tag-based: all contacts with the `newsletter` tag in GHL. Self-maintaining — new patients get the tag, they're automatically included.

## Component 5: New Module — `src/pv-newsletter.ts`

### Exports
- `kickoffNewsletter()` — Tuesday cron handler. Builds topic suggestion, posts to thread.
- `handleNewsletterMessage(message)` — Router for messages in the Newsletter thread. Detects intent (feedback, approval, command) and responds.
- `draftSection(section, context)` — Generates a specific section draft with humanizer + critic.
- `assembleNewsletter(state)` — Stitches all sections into final HTML.
- `pushToGHL(html, subject)` — Creates draft campaign via V2 API.
- `getLatestBlogPosts()` — Fetches recent posts from pvmedispa.com.
- `getNewsletterState() / saveNewsletterState()` — State file CRUD.

### Dependencies
- `src/ghl.ts` — GHL API client (needs V2 email campaign methods added)
- `memory/voice-guide.md` — Derek's voice reference
- `src/content-critic.ts` — Quality gate
- `/humanizer` skill — Voice polish
- WP REST API — pvmedispa.com blog post fetching

### Registration
- Add to `src/capability-registry.ts`
- Add cron job to `src/cron.ts`
- Add topic routing to `src/relay.ts`

## Template Structure Reference

From the GHL template (observed 2026-04-03):

| Section | Type | Content |
|---------|------|---------|
| Header | Static | Dark banner with "Derek's Vitality Unchained Newsletter" branding |
| Greeting | Dynamic | "Hi Vitality Unchained Tribe," |
| Personal Intro | Dynamic | Conversational hook, personal story |
| Educational Body | Dynamic | Teaching with bold key terms, diagrams/images |
| Patient Story | Dynamic | Anonymized patient example woven into narrative |
| Encouragement | Dynamic | Motivational takeaway |
| Announcements | Dynamic | Clinic news, community updates (optional) |
| Sign-off | Static | "To Living Life Unchained, Derek FNP" |
| Divider | Static | Teal line |
| Referral CTA | Static | "Join Derek's Vitality Unchained Newsletter" button |
| Weight Loss CTA | Static | "Get My Free Weight Loss Consultation" button |
| HRT CTAs | Static | Men's + Women's Hormone Replacement buttons |
| References | Dynamic | Auto-populated citations |
| Footer | Static | Copyright, email, unsubscribe (GHL merge fields) |

## Open Questions for Implementation

1. **GHL V2 API template support:** Does the create campaign endpoint accept a template ID and inject content into it, or do we need to send complete HTML? This determines whether we build the full email HTML or just the content sections.
2. **Image/diagram handling:** How to include images (like the Transition Curve diagram) in the educational section. Options: host on pvmedispa.com and reference by URL, or use GHL's media library.
3. **PV blog WP credentials:** Need WordPress REST API access for pvmedispa.com (separate from MAA site). May already exist via `WP_USER`/`WP_APP_PASSWORD` env vars — need to verify these point to pvmedispa.com.

## Success Criteria

- Derek spends ≤15 minutes per week on newsletter creation
- Newsletter goes out every Thursday consistently
- Content matches Derek's voice (passes humanizer + critic gate)
- Draft lands in GHL ready for visual check and send
- Pillar rotation ensures topic variety across weeks
