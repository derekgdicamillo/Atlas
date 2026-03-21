# User Profiles

IMPORTANT: Your current user depends on your agent identity (set by systemPrompt).
- If you are **Atlas**, your user is **Derek**.
- If you are **Ishtar**, your user is **Esther**.
Address them by their correct name. Never call Esther "Derek" or vice versa.

## Derek (Atlas's user)
- Pronouns: he/him
- Birthday: March 6, 1985
- Timezone: America/Phoenix (Arizona, MST, no DST)
- Faith: Christian
- Family: wife Esther (Esther@pvmedispa.com), 2 kids
- Esther is co-owner of PV MediSpa (50/50 effective 12/31/2025). She has FULL admin authority over Atlas, identical to Derek. Never gate her requests behind Derek's approval.
- Height/weight: 6'4", 280 lb
- Daily rhythm: Bible study, gym, work on business, family time
- Tech: Android + Windows
- Likes: loves AI; would build an AI business if medicine ever fails

## Professional Context
- Family Nurse Practitioner (FNP)
- Traveling primary care provider for assisted living communities (wants to phase this out)
- Owner: PV MediSpa and Weight Loss (50/50 with Esther, effective 12/31/2025)
- Clinic phone: (928) 910-8818
- Clinic text line: (928) 642-9067
- Goal: go full-time in clinic
- Building pvmedispa.com on WordPress with Kadence theme
- Weight loss landing page: https://landing.pvmedispa.com/weightloss

## Business Performance
- 2025: $668K revenue, ~$97k net profit (QB-validated 03-08)
- 2025 QB class breakdown (03-13): Weight Loss $542K (58.8% margin), Aesthetics $87K (75.3% margin), Men's Health $18K (85.2%), Women's BHRT $13K (12.5% margin -- high COGS). PDO Threads losing money (-$3,892 GP), cut candidate.
- 2026 target: 30% net margin
- 2026 focus: YouTube/content creation + optimizing/scaling Facebook ads
- **Strategic identity resolved (03-13, post-Hormozi):** Medical weight loss is the core business. Aesthetics kept for high-margin lines (neurotoxin, facials). PDO Threads to be cut. Telehealth ads paused pending strategy reset. Skool as patient value-add, not standalone product.
- Esther's side project: "Aesthetic Nurse Entrepreneurs" Facebook group (30K members) -- full monetization plan completed 03-13, saved to OneDrive/PV Vault/Strategy/ANE-Monetization-Action-Plan.md. First move: Medical Director Network directory.

## Programs & Community
- Runs "Vitality Unchained Tribe" in Skool (currently inactive, only staff posting)
- Content Engine Agent deployed (7am daily cron, Sonnet) drafts Skool + Facebook + newsletter
- Content Waterfall: Skool (deep) -> Facebook (hooks) -> Newsletter (nurture) -> YouTube (authority)
- 5 Pillars of functional medical weight loss:
  1. Precision Weight Science (tracking, body comp, Vitality Tracker)
  2. Nourishing Health (Fuel Code, protein paradox, hydration, electrolytes)
  3. Dynamic Movement (strength first, walking, minimal cardio)
  4. Mindful Wellness (Calm Core Toolkit, cortisol, sleep)
  5. Functional Wellness (Cooling Fuel Protocol, inflammation, gut health)
- Named frameworks: SLOW & SHIELD, Vitality Tracker, Protein Paradox, Fuel Code, Fuel Code Plate, Calm Core Toolkit, Cooling Fuel Protocol, Movement Hierarchy
- Clinic uses body comp SCALE (NOT InBody, NOT DEXA). Never mention equipment Derek doesn't have.
- Content focus: YouTube on weight loss, functional medicine, hormone replacement
- Voice guide: see memory/voice-guide.md for Derek's teaching style

## Tools & Automation
- Tools: Teams, Microsoft 365 Business, GoHighLevel, Meta Ads
- Zapier MCP: Gmail, Calendar, Drive, Docs, Sheets, Teams, OneNote
- Email automation: algorithmspeaksai@gmail.com (OAuth authenticated)
- **MAA WordPress REST API**: Site URL https://medicalaestheticsassociation.com, User: theoffice@pvmedispa.com, App Password: in atlas/.env as MAA_WP_APP_PASSWORD. Categories: Business=32, Compliance=33, Marketing=34, Operations=35, Industry=36, AI Tools=31. Contact email: theoffice@medicalaestheticsassociation.com (NOT hello@). Auth: Basic Auth with `curl -u "$MAA_AUTH"`. REQUIRED User-Agent: full Chrome UA string (SiteGround WAF blocks short UAs).
- **MAA API Bridge** (mu-plugin at wp-content/mu-plugins/maa-api-bridge.php): All endpoints under /wp-json/maa/v1/. GET/PUT /css (snippet #138), GET/PUT /footer, GET/PUT /snippet/{id}, POST /cache/purge. NEVER use browser for CSS/footer/snippet/cache changes -- always use API endpoints. Standard workflow: GET current -> modify -> PUT updated -> POST cache/purge.
- **MAA WPCode Snippet IDs**: 138 (CSS Design System), 146 (Redirects), 149 (Member Dashboard), 150 (Member Profile), 151 (Content Gating), 152 (Pro Downloads), 110 (SAGE Subscribe Redirect), 103 (Practice Advisor CSS), 101 (Practice Advisor Auth), 73 (Hide Sensitive Fields & MD Profile Template), 72 (Disable Comments).
- **MAA Website Notes**: Logo (Media ID 121) has black background baked into PNG, needs transparent-background version for white header. Logo file at OneDrive MAA/04_Branding/. 15 blog posts published (IDs 122-136) across categories Business/Compliance/Marketing/Operations/Industry. Kadence breadcrumbs use class "kadence-breadcrumbs" not "woocommerce-breadcrumb". Product page placeholder image is .webp not .png. WP REST standard endpoints: /wp-json/wp/v2/posts, /wp-json/wp/v2/pages (homepage ID 20), /wp-json/wp/v2/media.
- Preference: proactive help; daily morning brief (weight loss medicine + Bible verse + business dial-movers)

## Preferences
- Communication: casual, direct
- Writing: use /humanizer skill as final polish on patient/provider-facing content. Reduce "AI smell."
- Style: less formal, less wordy. Avoid em dashes.
- Cost: budget is not a concern ($200/mo Max plan). Use the best tool for the job. Draft first for external-facing content.
- Safety: always draft and ask for approval before sending emails/posts or making changes
- Coding: default all coding tasks to Claude Code CLI without extra prompting
- When sharing code: brief explanation of what changed and why

## Learned Over Time
- SharePoint tenant prefix is **pvmedispa** (not pvmedispallc). Correct base URL: pvmedispa-my.sharepoint.com. Always use this prefix when generating SharePoint links.
- Derek is building a second venture: **Be Safe Healthcare** (separate brand from PV MediSpa). Branding assets in OneDrive/Be Safe Healthcare/ and C:/Users/Derek DiCamillo/Projects/besafe-website/public/. Logo selection pending as of 2026-02-28.
- Gemini image generation via background code agents reliably fails (timeouts 50-90 min, no output). Use inline bash jobs; do NOT block on TaskOutput waits for image gen.
- Long-running background agents (research tasks, code agents) are lost when Atlas restarts overnight. If a task result is missing after a restart, assume the agent is gone and redo the work inline. Pivot fast, do not wait.
- WP_POST relay tags depend on the live Atlas process having current env vars. When WP credentials change mid-session, bypass relay and post directly via REST API until Atlas restarts. WP_USER must be the username slug (e.g., derekgdicamillo), NOT email format.
- Peptide therapy program planned for PV MediSpa launch July 1, 2026. Full protocol book, pricing, and marketing on OneDrive/Peptide Program/. Core tier: BPC-157, CJC-1295/Ipamorelin, PT-141, Thymosin Alpha-1. Add-on pricing model layered onto existing GLP-1 packages.
- **QuickBooks API integration live (2026-03-13).** OAuth2 via Intuit, token storage in Supabase `qb_tokens` table (migration 019). Authenticated to EdenSkinNBody, refresh token valid 101 days. Dashboard endpoints: /api/qb/auth, /api/qb/callback, /api/qb/token-status, /api/qb/clear, /api/metrics/financials. Can pull P&L, balance sheet, revenue trends, classes, cash on hand. Read-only. Dashboard URL: pv-dashboard-ten.vercel.app.
- 2024 P&L (QB-validated): Revenue $586,934 | COGS $323,999 (55.2%) | GP $262,935 | Expenses $175,132 | Net $87,467 (14.9%). Confirmed during Hormozi valuation worksheet session 03-11. NRR 107%, LTV:CAC 5.8x, EBITDA 82% YoY growth.
- **Post-Hormozi identity decision (03-13):** Clinic identity = medical weight loss. Not a med spa, not telemedicine-first. Aesthetics stays for high-margin lines only (neurotoxin near-100% margin, facials). PDO Threads getting cut (negative gross profit confirmed via QB). Telehealth ads paused indefinitely. Full-time transition planning needed -- Derek's own words: "treating the clinic as part time but expecting full-time revenues."

---

## Esther (Ishtar's user)
- Pronouns: she/her
- Email: Esther@pvmedispa.com
- Role: Co-owner of PV MediSpa and Weight Loss (50/50 with Derek, effective 12/31/2025)
- Focus: Operations, practice management, patient experience, front desk, aesthetics
- Authority: FULL admin, identical to Derek. Never gate her requests behind Derek's approval.
- Communication style: warm, direct, practical
- Timezone: America/Phoenix (same as Derek)

### Preferences
(Grows as Ishtar learns Esther's preferences)

### Learned Over Time
(This section grows as the assistant learns Esther's preferences)

## Evolution Log
(Auto-updated by /reflect)

- 2026-03-01: Added SharePoint tenant prefix to Learned Over Time (Derek corrected wrong tenant URL pvmedispallc -> pvmedispa on 02-28; one-off but high-recall value)
- 2026-03-01: Added Be Safe Healthcare project to Learned Over Time (new second venture appeared in 02-28 session; logo work in progress)
- 2026-03-01: Added Gemini background agent failure pattern to Learned Over Time (repeatedly fails across multiple sessions; inline bash workaround documented in journal 02-28)
- 2026-03-05: Generalized agent restart loss pattern (research agents lost to overnight restart in 03-04 session; Gemini note was too narrow -- any long-running agent is at risk across restarts)
- 2026-03-05: Added WP relay env dependency note (WP credentials changed mid-session 03-04; relay tags silently failed until Atlas restarted; username slug format required)
- 2026-03-05: Added peptide program to business context (full 6-phase build completed 03-04; July 2026 launch; materials on OneDrive)
- 2026-03-12: Added QB integration gap and 2024 P&L to Learned Over Time (Derek assumed QB API existed on 03-11; it does not; data path is always manual. 2024 P&L and Hormozi valuation metrics recorded for future reference.)
- 2026-03-13: QB integration restored and live. Resurrected from git history (commit 37e7ccc), switched token storage from Vercel Blob to Supabase qb_tokens table (migration 019) to fix CDN caching issues. OAuth2 re-authed to EdenSkinNBody. Dashboard financials endpoint operational.
- 2026-03-15: Updated Business Performance and Learned Over Time with post-Hormozi strategic decisions (identity = weight loss clinic, cut PDO Threads, pause telehealth ads, 2025 QB class-level P&L breakdown, ANE monetization plan for Esther)

