# Derek's Claude Desktop Usage — Research Report

**Research date:** 2026-09-02  
**Scope:** Evidence-based analysis from AppData session files, claude_desktop_config.json, journal files, and project directories. Supabase semantic search was inaccessible (requires OAuth, unavailable in headless mode).

---

## 3 Findings That Most Affect the Herder-vs-Desktop Decision

### F1 — herdr and Claude Desktop are not competing for the same job
`research-herder-vs-claude-desktop.md` (atlas project root) already concluded this: "herdr and Claude Desktop are not alternatives to each other. Claude Desktop is a conversational AI interface with artifact generation. herdr is a process manager for running multiple coding agents in a terminal."

The practical question is whether Derek regularly runs **2+ parallel Claude Code sessions simultaneously** — which is the only scenario where herdr adds value. The session data shows 5 starred sessions across different worktrees, all active concurrently in the Code tab sidebar. That is exactly the use pattern herdr targets. The existing research summary for a solo operator: "Yes if you regularly run 2+ parallel Claude Code sessions. No if you mostly run one at a time."

**Decision implication:** herdr is worth testing, not choosing over Claude Desktop. The question is whether the worktree-per-feature workflow (5 starred, parallel-active sessions) is blocked often enough that a sidebar state view would save meaningful context-switching overhead.

### F2 — The `visualize` MCP is the only remote integration Derek has wired into Claude Desktop
Every session file across both accounts contains exactly one remote MCP server: `uuid: 6f616b42-0ed8-571e-823f-ee4aca6b7ce9`, named `visualize`, with two tools — `show_widget` (inline SVG/HTML rendering) and `read_me` (theming context loader). No other MCP integrations exist in Claude Desktop.

Source: `AppData\Roaming\Claude\claude-code-sessions\f0dda67a-*\...\local_6ec67d4e-*.json` and `local_17ba2117-*.json`, confirmed across the full session corpus.

Atlas's business integrations (GHL, Meta Ads, QuickBooks, Brevo, GA4, M365, Home Assistant) live entirely in the Atlas Telegram bot. None are wired into Claude Desktop. This means herdr adoption would not disrupt any business-tool workflows.

**Decision implication:** herdr installation risk is near-zero. No MCP configuration to migrate. The `visualize` MCP is remote and session-scoped — it persists whether Derek uses herdr panes or raw terminal windows.

### F3 — Two accounts, zero context overlap: development on Claude Desktop, operations via Atlas
Derek runs two entirely parallel AI surfaces that never share context:

- **Claude Desktop (Code tab)** — software development only. Primary account (`5712d07d`) for Atlas repo, AI YouTube, TMAA, GLP1 CME, buzz. Secondary account (`f0dda67a`) is 100% joy-flow-unfold with worktrees, at `max` effort, with `bypassPermissions` enabled for that folder specifically.
- **Atlas (Telegram bot)** — business operations, clinical work, marketing, content, scheduling, CRM.

The journal entry from 2026-08-25 (`memory/2026-08-25.md`) records the closest Derek has come to discussing the interface choice: "Recommended desktop as the right call, but RDP should be the fallback, not the primary path. Primary paths: Claude Code Remote Control (continue sessions from phone/tablet/browser), Claude Code mobile app (push notifications when Claude needs input)." This was about hardware consolidation (Surface Pro → desktop machine), not software surface preferences.

**Decision implication:** herdr fits cleanly into the Claude Desktop workflow without touching Atlas at all. Adoption is isolated to the development surface.

---

## What Derek Uses Claude Desktop For

### Task types and projects

| Project | Account | Sessions (approx) | Notes |
|---|---|---|---|
| joy-flow-unfold | Secondary (`f0dda67a`) | 40 | 100% of secondary account; 5 starred |
| Atlas | Primary (`5712d07d`) | ~50 | Building/maintaining the Atlas bot |
| AI YouTube | Primary | ~12 | Channel/content work |
| GLP1 CME | Primary | ~5 | CME course development |
| TMAA Refill Tracker | Primary | ~2 | MAA tooling |
| buzz | Primary | ~2 | Appears to be a separate project |

Source: session file enumeration in `AppData\Roaming\Claude\claude-code-sessions\`.

### How joy-flow-unfold sessions are structured

The secondary account uses **git worktrees exclusively**. Each starred session is a separate worktree / feature branch:

- `sdoh-wizard-note-generation-a6c6d7` → branch `claude/practice-onboarding-updates-f1185d`, 44 turns, model `claude-fable-5-1`, effort `high`, starred
- `advance-planning-chart-display-d785b5` → branch `claude/bhi-plan-status-9a51f2`, 2 turns, model `claude-fable-5-1`, effort `max`, `bypassPermissions`, starred
- Three additional starred sessions in other worktrees

Source: `local_6ec67d4e-*.json` and `local_17ba2117-*.json`.

Merged PRs tracked within sessions: #188 (feature/provider-wording), #189 (feature/chart-allergies-social), #190 (feature/practice-profile), #191 (feature/chart-surgical-history). Open: #194 (feature/first-visit-walkthrough). All to `psinghny-besafe/joy-flow-unfold`.

Source: `prs` field in `local_6ec67d4e-*.json`.

CLAUDE.md for joy-flow-unfold (`C:\Users\Derek DiCamillo\Projects\joy-flow-unfold\CLAUDE.md`) confirms: HIPAA-bound CCM/BHI platform, React 18 + Vite 5 + TS 5 + Tailwind 3 + shadcn/ui + Supabase + AWS Bedrock. "Not our repo. We have WRITE access."

### Model evolution

Both accounts show clear model evolution across session files:
- Primary: `claude-opus-4-6` → `claude-opus-5` → `claude-fable-5` → `claude-fable-5-1`
- Secondary: `claude-opus-5` → `claude-fable-5` → `claude-fable-5-1`
- Effort: secondary account runs ~80% `max`, primary mixed `xhigh`/`high`/`max`
- Global CCD effort level: `xhigh` (`claude_desktop_config.json`, line 81)

---

## MCP Servers and Integrations

### In Claude Desktop
**One remote MCP server only: `visualize` (UUID `6f616b42-0ed8-571e-823f-ee4aca6b7ce9`)**

Tools:
- `show_widget` — renders SVG or HTML widgets inline in the Code tab (flowcharts, architecture diagrams, mockups, data viz, interactive charts)
- `read_me` — loads theming context (CSS variables, colors, typography) before widget rendering; hidden from chat

This MCP is present in every session across both accounts. It is the only non-default integration.

No Zapier, GHL, Meta, Google, or business-system MCPs exist in Claude Desktop.

### In Atlas (Telegram bot)
~30 subsystems wired: GHL (CRM + social), Meta Ads, QuickBooks, GA4, GBP, Brevo, M365/Planner, WP REST, Home Assistant, OBS, Supabase, Otter.ai — see `capabilities.md` in atlas project for full inventory.

### No overlap
The two surfaces share zero MCP integrations. They are completely isolated.

---

## Pain Points Voiced — Direct Quotes and Dates

No direct quotes about Claude Desktop frustrations were found in Atlas journals. This is expected: Derek interacts with Claude Desktop directly (not through Atlas/Telegram), so Atlas journals do not record those sessions.

The closest relevant signals from journals:

- **2026-08-25** (`memory/2026-08-25.md`): "Derek considering moving all projects from Surface Pro to always-on desktop in home office, using RDP to work remotely. Recommended desktop as the right call, but RDP should be the fallback, not the primary path. Primary paths: Claude Code Remote Control (continue sessions from phone/tablet/browser), Claude Code mobile app (push notifications when Claude needs input), agent view as control panel."  
  *Context: hardware consolidation discussion, not interface preference.*

- **2026-08-22** (`memory/2026-08-22.md`): "Atlas already runs on an always-on desktop PC. The recommendation [for cloud VM + Syncthing] was obsolete."  
  *Context: Atlas infrastructure, not Claude Desktop.*

- **2026-08-28** (`memory/2026-08-28.md`): Documents swarm misuse on Aug 25–27 (Atlas generating full swarms for already-answered questions). This is an Atlas behavioral issue, not a Claude Desktop issue.

**Inaccessible source:** Supabase messages table semantic search (requires OAuth authentication, unavailable in headless subagent mode). If Derek has discussed interface preferences in Telegram conversations with Atlas, those records were not searchable here.

---

## Where Claude Desktop Overlaps with Atlas

| Work type | Claude Desktop | Atlas (Telegram) |
|---|---|---|
| Atlas bot development | Yes — primary account, ~50 sessions | No |
| joy-flow-unfold development | Yes — dedicated secondary account | No |
| AI YouTube | Yes — primary account | No |
| Business operations (GHL, ads, financials) | No | Yes — primary interface |
| Clinical work (lab reads, care plans) | No | Yes |
| Marketing / content | No | Yes |
| Scheduling / CRM | No | Yes |
| Morning brief / overnight work | No | Yes (cron-driven) |

**The only genuine overlap:** Atlas bot development work happens in Claude Desktop (primary account) AND Atlas itself is the bot being developed. Changes to Atlas code are made in Claude Desktop sessions, then Atlas picks up those changes after pm2 restart. There is no real-time shared context — they are sequential, not parallel.

---

## Operational Configuration

From `claude_desktop_config.json`:

| Setting | Value | Implication |
|---|---|---|
| `sidebarMode` | `epitaxy` | Code tab (CCD interface) is the default view |
| `bypassPermissionsModeEnabled` | `true` (both accounts) | Full autonomous operation, no permission dialogs |
| `ccRemoteControlDefaultEnabled` | `true` | Sessions can be picked up remotely (phone, browser) |
| `coworkBrowserToolsEnabled` | `true` | In-app Playwright browser active in all sessions |
| `coworkWebSearchEnabled` | `true` | Web search available in sessions |
| `ccd-effort-level` | `xhigh` | Global default for CCD sessions |
| `remoteToolsDeviceName` | `atlaspc` | Machine is named "AtlasPC" — the always-on desktop |
| `launchPreviewAllowedOrigins` | namecheap.com, cloudflare.com | Domain management in preview browser |
| `fastMode` | `false` | Standard mode (not fast/Opus toggle) |
| 5 pinned sessions | All joy-flow-unfold worktrees | joy-flow-unfold is the primary active project |

---

## Summary for herdr Decision

The existing `research-herder-vs-claude-desktop.md` (atlas project root) covers herdr thoroughly. The usage analysis adds this concrete layer:

Derek has **5 simultaneously active worktree sessions** pinned in the Claude Desktop sidebar — each a different joy-flow-unfold feature branch. This is precisely the multi-session parallel pattern herdr is designed for. Whether those sessions are truly concurrent (all working simultaneously) or sequential (one at a time, just kept open for context) is not determinable from session file metadata alone.

**The experiment worth running:** Install herdr, run it alongside Claude Desktop for one joy-flow-unfold work session with 2+ worktrees open, and evaluate whether the blocked/working/idle state sidebar saves meaningful time. Switching cost is near-zero in both directions per the existing research. Installation risk is nil — herdr wraps the same Claude Code CLI, Max plan billing is unaffected.

**Not worth deciding without testing.** The session data shows the right usage pattern; whether herdr's value-add is felt in practice depends on how often those sessions are blocked and waiting simultaneously.
