---
name: pv-dashboard
description: >-
  Fix, update, or add features to the PV MediSpa Dashboard (Next.js/Vercel).
  Use when Derek says "fix the dashboard", "update pipeline page", "add a chart",
  "dashboard bug", "dashboard deploy", "fix financials", "STL page", or any
  pv-dashboard code change. Also triggered by /pv-dashboard or /dashboard.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - WebFetch
context: fork
user-invocable: true
argument-hint: "<bug description, feature request, or page/component name>"
---
# PV Dashboard Developer Skill

Fix bugs, add features, and deploy the PV MediSpa executive dashboard.

## Project Location & Git

- **Repo:** C:\Users\derek\Projects\pv-dashboard
- **Remote:** https://github.com/derekgdicamillo/pv-dashboard.git
- **Deploy:** Vercel auto-deploys on push to main. No manual deploy step needed.
- **Live URL:** https://pv-dashboard-ten.vercel.app

```bash
cd "C:/Users/derek/Projects/pv-dashboard"
git status
```

## Tech Stack

- **Framework:** Next.js 14.2.35 (App Router)
- **Language:** TypeScript 5, React 18
- **Styling:** Tailwind CSS 3.4.1
- **Charts:** Recharts 3.7.0
- **Database:** SQLite (better-sqlite3) for local snapshots/caching
- **Auth:** NextAuth 4.24.13 (credentials provider)
- **PDF:** Puppeteer Core + @sparticuz/chromium-min
- **AI Insights:** Google Generative AI (Gemini)
- **Storage:** Vercel Blob (QB tokens), Vercel KV (Redis cache)
- **Package manager:** npm (not bun)

## Directory Structure

```
src/
├── app/                        # Next.js App Router
│   ├── page.tsx                # Home/Overview (KPIs, funnel, insights)
│   ├── layout.tsx              # Root layout
│   ├── globals.css             # Global styles
│   ├── ads/page.tsx            # Ad performance (Meta)
│   ├── pipeline/page.tsx       # Pipeline funnel, STL, attribution, aging
│   ├── financials/page.tsx     # P&L, balance sheet, unit economics (QB)
│   ├── marketing/              # Marketing section (GBP, reviews, content, SEO, social)
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── gbp/page.tsx
│   │   ├── reviews/page.tsx
│   │   ├── content/page.tsx
│   │   ├── seo/page.tsx
│   │   └── social/page.tsx
│   ├── telehealth/page.tsx
│   ├── login/page.tsx
│   └── api/                    # API Routes (backend)
│       ├── metrics/
│       │   ├── overview/route.ts     # Leads, CPL, close rate, show rate
│       │   ├── ads/route.ts          # Spend, impressions, CTR, campaigns
│       │   ├── pipeline/route.ts     # Stage distribution, aging, funnel
│       │   ├── financials/route.ts   # P&L, balance sheet, margins
│       │   ├── speed-to-lead/route.ts
│       │   └── attribution/route.ts
│       ├── qb/                       # QuickBooks OAuth flow
│       │   ├── auth/route.ts
│       │   ├── callback/route.ts
│       │   ├── token-status/route.ts
│       │   ├── classes/route.ts
│       │   ├── class-by-name/route.ts
│       │   ├── debug/route.ts
│       │   ├── clear/route.ts
│       │   └── test-blob/route.ts
│       ├── sync/route.ts            # Daily cron (1:05 PM UTC)
│       ├── insights/route.ts        # AI insights (Gemini)
│       ├── generate-pdf/route.ts    # PDF export
│       ├── healthcheck/route.ts
│       └── auth/[...nextauth]/route.ts
├── components/                 # React components
│   ├── Layout.tsx              # Page wrapper with nav
│   ├── Nav.tsx                 # Navigation sidebar
│   ├── Providers.tsx           # NextAuth session provider
│   ├── KPICard.tsx             # Metric card with target comparison
│   ├── FunnelChart.tsx         # Pipeline funnel visualization
│   ├── BottleneckFunnel.tsx    # Lead-to-appointment bottleneck
│   ├── StageDistribution.tsx   # Stage breakdown chart
│   ├── TrendChart.tsx          # Line/area time series chart
│   ├── CampaignTable.tsx       # Campaign-level ad data table
│   ├── DateRangePicker.tsx     # Period selector (week/month/quarter/year)
│   ├── AIInsights.tsx          # AI insight cards
│   ├── RosterUpload.tsx        # CSV roster upload
│   └── index.ts                # Barrel export
├── lib/                        # Shared utilities & API clients
│   ├── ghl.ts                  # GoHighLevel API client
│   ├── meta.ts                 # Meta/Facebook Ads API client
│   ├── quickbooks.ts           # QuickBooks Online API (OAuth, P&L, balance sheet)
│   ├── db.ts                   # SQLite (snapshots, caching)
│   ├── apiAuth.ts              # Bearer token + NextAuth route protection
│   ├── authOptions.ts          # NextAuth config
│   ├── kpi.ts                  # KPI calculation formulas
│   └── targets.ts              # Weekly/monthly KPI targets
├── types/
│   ├── index.ts                # TypeScript interfaces (OverviewMetrics, PipelineMetrics, etc.)
│   └── intuit-oauth.d.ts       # QB type defs
└── middleware.ts               # Route protection middleware
```

## Key Config Files

- `package.json` — deps and scripts (dev, build, start, lint)
- `tsconfig.json` — strict mode, `@/*` path alias to `./src/*`
- `tailwind.config.ts` — custom colors: pv-sky, pv-charcoal, pv-tan, pv-brown
- `vercel.json` — cron schedule + function memory limits
- `next.config.mjs` — Next.js config
- `SPEC.md` — data sources, API contracts, constraints
- `GHL_API_REFERENCE.md` — GHL endpoint docs
- `DASHBOARD_TODO.md` — roadmap (completed + Phase 4)

## Commands

```bash
cd "C:/Users/derek/Projects/pv-dashboard"
npm run dev        # localhost:3000
npm run build      # production build (catches type errors)
npm run lint       # ESLint
```

## Environment Variables

Stored in Vercel project settings (not .env file in repo). Key vars:
- `GHL_API_TOKEN` — GoHighLevel Private Integration Token
- `GHL_LOCATION_ID` — PCdXIc8QjGmy4JmuiMrs
- `META_ACCESS_TOKEN` — Meta Graph API token
- `META_AD_ACCOUNT_ID` — act_908446474041797
- `INTERNAL_API_TOKEN` — Bearer token for API route auth (Atlas uses this)
- `NEXTAUTH_SECRET` — NextAuth session encryption
- `GEMINI_API_KEY` — Google AI insights
- QB OAuth tokens stored in Vercel Blob (not env vars)

For local dev, create `.env.local` with these values.

## Data Sources (All READ-ONLY)

### GoHighLevel (CRM)
- Base: https://services.leadconnectorhq.com
- Auth: Bearer GHL_API_TOKEN, Version: 2021-07-28
- Contacts, opportunities, pipelines, conversations, messages

### Meta/Facebook Ads
- Base: https://graph.facebook.com/v21.0
- Ad account: act_908446474041797
- Spend, impressions, clicks, CTR, CPL, campaigns

### QuickBooks Online
- OAuth2 flow (tokens in Vercel Blob)
- Revenue, COGS, expenses, balance sheet, monthly trends
- Class filtering for Weight Loss program

### Key Pipeline IDs
- Weight Loss Patient Journey: `zi2YOdmjJwNYebkCMkVv`
- Current Weight Loss Member: `BydcHaaFTHMHNN1Icdva`

## Atlas Integration

Atlas calls the dashboard via REST from `src/dashboard.ts`:
- Base URL: `DASHBOARD_URL` env var (defaults to Vercel URL)
- Auth: `DASHBOARD_API_TOKEN` as Bearer header
- Endpoints: `/api/metrics/overview`, `/api/metrics/pipeline`, `/api/metrics/financials`, etc.
- Telegram commands: /finance, /pipeline, /scorecard, /leads, /stl

When changing API response shapes, keep backward compatibility with Atlas's TypeScript interfaces in `C:\Users\derek\Projects\atlas\src\dashboard.ts`.

## Common Patterns

### Adding a new metric endpoint
1. Add types to `src/types/index.ts`
2. Create route at `src/app/api/metrics/<name>/route.ts`
3. Use `authenticateRequest()` from `src/lib/apiAuth.ts`
4. Fetch from upstream API (ghl.ts, meta.ts, or quickbooks.ts)
5. Use `Promise.allSettled` for partial-failure resilience
6. Add snapshot logic in `src/app/api/sync/route.ts` if needed

### Adding a new page
1. Create `src/app/<route>/page.tsx`
2. Use `"use client"` directive (all pages are client components)
3. Fetch from `/api/metrics/<endpoint>` with Bearer token
4. Use existing components (KPICard, TrendChart, DateRangePicker)
5. Add nav link in `src/components/Nav.tsx`

### Adding a new component
1. Create in `src/components/<Name>.tsx`
2. Export from `src/components/index.ts`
3. Follow existing patterns: props interface, Tailwind classes, Recharts for charts

## Git Workflow

```bash
cd "C:/Users/derek/Projects/pv-dashboard"
git add <specific files>
git commit -m "description of change"
git push origin main
```

Vercel auto-deploys on push. Check deploy status at vercel.com or via `vercel` CLI.

**Always `npm run build` before pushing** to catch TypeScript/build errors locally.

## Safety Rules

- All upstream APIs are READ-ONLY. Never create, edit, or delete CRM/ad/financial records.
- No patient PII in dashboard. Aggregate metrics only.
- Don't break Atlas integration. If changing API response shapes, update Atlas types too.
- Run `npm run build` before committing. Type errors break Vercel deploys.
- Draft PRs for large changes. Direct push to main for small fixes is fine.

## Handling $ARGUMENTS

**If $ARGUMENTS describes a bug:**
1. Read the relevant page/component/route files
2. Identify the issue
3. Fix it, run build to verify
4. Commit and push

**If $ARGUMENTS describes a feature:**
1. Read SPEC.md and DASHBOARD_TODO.md for context
2. Check existing patterns in similar pages/components
3. Implement following the patterns above
4. Run build, commit, push

**If $ARGUMENTS is empty:**
1. Run `npm run build` to check current health
2. Read DASHBOARD_TODO.md for pending work
3. Ask Derek what needs fixing

**If $ARGUMENTS mentions "deploy" or "push":**
1. Check git status for uncommitted changes
2. Run build
3. Commit and push (Vercel auto-deploys)
