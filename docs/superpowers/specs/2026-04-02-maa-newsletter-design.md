# TMAA Newsletter Automation

**Date:** 2026-04-02
**Status:** Approved
**Scope:** New `src/maa-newsletter.ts` module + `tmaa_partners` Supabase table + cron jobs in Atlas

## Problem

TMAA publishes 2 blog posts/week but has no automated way to distribute content to members. Free members and FB leads have no nurture sequence driving them toward paid membership. Paid members get no exclusive content reinforcing the value of their subscription.

## Solution

Two automated newsletter tiers running as Atlas cron jobs, with Brevo as the email delivery platform and a human approval gate before each send.

## Newsletter Tiers

### Free Newsletter ("This Week at TMAA")
- **Audience:** Brevo "FB Group Leads" list
- **Cadence:** Weekly (Saturday 9 AM MST)
- **Tone:** Value + CTA to convert
- **Content:**
  1. Blog recap: Both posts from that week (title, 1-2 sentence excerpt, link)
  2. Trending topic teaser: One SAGE-inspired insight, framed as "What practitioners are asking about this week" (broad, no SAGE reference). Enough to be useful but leaves them wanting more.
  3. CTA: Rotate between "Join TMAA" (/join), "Try S.A.G.E." (/advisor), "Browse Resources" (/resources)

### Paid Newsletter ("TMAA Insider")
- **Audience:** Brevo "TMAA Members" list
- **Cadence:** Biweekly (every other Sunday 9 AM MST)
- **Tone:** Pure value, no selling
- **Content:**
  1. Blog recap: All 4 posts from the past 2 weeks (title, excerpt, link)
  2. SAGE Insights: Top 3-4 trending themes from SAGE dashboard, each with a meaty 2-3 sentence actionable takeaway. This is the exclusive section free members don't get.
  3. Partner spotlight: Rotate through active partners from `tmaa_partners` table — one per edition with discount code and description
  4. Resources reminder: Highlight a Pro PDF or tool available in /resources
  5. No CTA to buy anything.

## Content Generation

Atlas uses Claude (Sonnet) to assemble each newsletter from:
- **Recent blog posts:** Fetched via WP REST API (existing connection via MAA_WP_* creds)
- **SAGE dashboard data:** Fetched via existing SAGE API endpoint (same as maa-blog.ts uses)
- **Partner data:** Queried from `tmaa_partners` Supabase table
- **CTA rotation:** Tracked in newsletter state file

## Approval Flow

### Draft Phase (Wednesday 8 AM MST cron)
1. Atlas assembles newsletter content from data sources
2. Claude (Sonnet) generates the newsletter HTML copy
3. Atlas creates a Brevo campaign draft via API (using existing Brevo templates)
4. Atlas sends test email to derek@pvmedispa.com and esther@pvmedispa.com via Brevo test send
5. Atlas sends Telegram message with summary and instructions:
   - "TMAA Free Newsletter draft ready. Test email sent to you and Esther. Reply `approve free` when ready or send edits."
   - If paid week: same for paid newsletter

### Approval Phase (Telegram)
- Reply `approve free` or `approve paid` — Atlas sets approved flag in state
- Reply with edits — Atlas regenerates, creates new Brevo draft, sends new test email
- No response by Friday night — Atlas sends Telegram reminder

### Send Phase (Saturday/Sunday 9 AM MST cron)
- **Saturday 9 AM:** Check `freeApproved` flag. If true, trigger Brevo campaign send, notify on Telegram. If false, send reminder, skip this week.
- **Sunday 9 AM (every other week):** Same logic with `paidApproved` flag.

Approval unlocks the newsletter for scheduled send. It does NOT trigger immediate send. The Saturday/Sunday cron is what actually sends.

## State Tracking

File: `data/maa-newsletter-state.json`

```json
{
  "freeApproved": false,
  "paidApproved": false,
  "freeCampaignId": null,
  "paidCampaignId": null,
  "lastFreeSent": null,
  "lastPaidSent": null,
  "paidWeekToggle": true,
  "lastPartnerIndex": 0,
  "lastCtaIndex": 0
}
```

Reset after each send: `freeApproved`/`paidApproved` flip back to false, campaign IDs clear.

## Partner Data Model

### Supabase table: `tmaa_partners`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | `gen_random_uuid()` |
| name | TEXT NOT NULL | Partner name (e.g. "HRT University") |
| contact_name | TEXT | Primary contact (e.g. "Nico Misleh, NP") |
| description | TEXT NOT NULL | What they offer, who it's for, why it matters. Rich enough for SAGE to recommend contextually. |
| discount_code | TEXT | e.g. "DEREKMC5" |
| discount_description | TEXT | e.g. "$200 off certification course" |
| url | TEXT | Partner website/landing page |
| category | TEXT | e.g. "training", "pharmacy", "legal", "clinical" |
| active | BOOLEAN DEFAULT true | Whether to include in newsletter rotation |
| created_at | TIMESTAMPTZ DEFAULT now() | Auto |
| updated_at | TIMESTAMPTZ DEFAULT now() | Auto |

### Seed Data (4 current partners)

| Name | Contact | Code | Discount | Category |
|------|---------|------|----------|----------|
| HRT University | Nico Misleh, NP | DEREKMC5 | $200 off certification | training |
| Peptide Prescribing | Ashlee Hess, APRN | PS5 | ~5% off | clinical |
| The Protected Practice | Courtney | DEREK | 5% off | legal |
| Scripts | (pharmacy network) | ANEpharm | Preferred pricing | pharmacy |

### Newsletter Rotation
Each paid edition features one active partner. Atlas cycles through in order, tracking `lastPartnerIndex` in state. New partners added to the table automatically enter the rotation.

### Future: SAGE Training
The `description` field is designed to be rich enough for SAGE's knowledge base. A future task will ingest partner data into SAGE so it can recommend partners contextually during conversations.

## Brevo Integration

### New module: `src/maa-newsletter.ts`

Wraps the Brevo v3 REST API (`api.brevo.com/v3/`). Uses `BREVO_API_KEY` from `.env`.

**Required Brevo API calls:**
- `POST /emailCampaigns` — Create campaign draft with template, subject, HTML content, list recipients
- `POST /emailCampaigns/{id}/sendTest` — Send test email to Derek + Esther
- `POST /emailCampaigns/{id}/sendNow` — Trigger send on approval
- `GET /emailCampaigns/{id}` — Check campaign status

**Templates:** Uses existing Brevo templates (already built). Template IDs stored in `.env` or hardcoded after discovery.

### Relay Integration

The approval commands (`approve free`, `approve paid`) need to be handled by Atlas's relay. When a message matches these patterns in the context of a pending newsletter, Atlas updates the state file.

## Cron Jobs

Added to `src/cron.ts`:

| Cron | Day | Time | Job |
|------|-----|------|-----|
| `0 8 * * 3` | Wednesday | 8 AM | Draft newsletters, send test emails, notify Telegram |
| `0 9 * * 6` | Saturday | 9 AM | Send free newsletter (if approved) |
| `0 9 * * 0` | Sunday | 9 AM | Send paid newsletter (if approved + paid week) |

## Files Created/Modified

- **Create:** `src/maa-newsletter.ts` — Brevo API wrapper, content assembly, draft/send logic
- **Create:** Supabase migration for `tmaa_partners` table
- **Modify:** `src/cron.ts` — Add 3 newsletter cron jobs
- **Modify:** `src/relay.ts` — Handle `approve free` / `approve paid` commands
- **No changes to:** maa-blog.ts, maa-advisor, WordPress

## What Doesn't Change

- Blog publishing (maa-blog.ts) continues independently
- SAGE dashboard API is read-only (newsletter just queries it)
- Brevo template design is managed in Brevo UI, not in code
- Member list management in Brevo continues as-is (Atlas adds contacts ad hoc)

## Key Constraints

- Newsletters never send without explicit Telegram approval from Derek or Esther
- SAGE data inspires content but is never referenced by name
- Paid newsletter is pure value — zero sales language, zero CTAs to buy
- Free newsletter always includes one conversion CTA
- Partner rotation pulls from live Supabase data, not hardcoded lists
