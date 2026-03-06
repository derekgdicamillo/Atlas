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
- 2025: ~$670k revenue, ~$97k net profit
- 2026 target: 30% net margin
- 2026 focus: YouTube/content creation + optimizing/scaling Facebook ads
- Strategic fork: scale local clinic vs telemedicine; Skool group as patient value-add vs standalone product
- Event: Alex Hormozi 2-day workshop, March 11, 2026 (Las Vegas)

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
- Derek is building a second venture: **Be Safe Healthcare** (separate brand from PV MediSpa). Branding assets in OneDrive/Be Safe Healthcare/ and C:/Users/derek/Projects/besafe-website/public/. Logo selection pending as of 2026-02-28.
- Gemini image generation via background code agents reliably fails (timeouts 50-90 min, no output). Use inline bash jobs; do NOT block on TaskOutput waits for image gen.
- Long-running background agents (research tasks, code agents) are lost when Atlas restarts overnight. If a task result is missing after a restart, assume the agent is gone and redo the work inline. Pivot fast, do not wait.
- WP_POST relay tags depend on the live Atlas process having current env vars. When WP credentials change mid-session, bypass relay and post directly via REST API until Atlas restarts. WP_USER must be the username slug (e.g., derekgdicamillo), NOT email format.
- Peptide therapy program planned for PV MediSpa launch July 1, 2026. Full protocol book, pricing, and marketing on OneDrive/Peptide Program/. Core tier: BPC-157, CJC-1295/Ipamorelin, PT-141, Thymosin Alpha-1. Add-on pricing model layered onto existing GLP-1 packages.

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
