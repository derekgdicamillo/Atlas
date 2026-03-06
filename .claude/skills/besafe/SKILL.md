---
name: besafe
description: >-
  Build and manage the Be Safe Healthcare CCM operations platform. Use when
  Derek mentions "Be Safe", "Byron", "CCM platform", "chronic care management",
  "besafe-website", or wants to work on the Be Safe Healthcare project
  (architecture, proposals, HIPAA compliance, feature planning).
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - WebSearch
  - WebFetch
context: fork
user-invocable: true
argument-hint: "<task description or component to work on>"
metadata:
  author: Atlas
  version: 1.0.0
---
# Be Safe Healthcare - CCM Operations Platform

Build and manage Byron's Be Safe Healthcare chronic care management (CCM) operations platform.

## Project Context

Be Safe Healthcare (Byron's company) provides embedded CCM services to physician practices. The platform is an operations layer that sits alongside (not inside) the practice EMR.

**Key architectural decision:** The EMR is the system of record. Be Safe's platform handles staff time tracking, billing recommendations, patient education delivery, and compliance reporting. No clinical notes or full medical records.

**De-identification strategy:** Platform uses initials + birth year + practice ID (e.g., JD-1985-BYR001) instead of full patient names/DOB. This passes HIPAA Safe Harbor, eliminating the need for BAAs with subprocessors.

## Tech Stack

- **Frontend:** Next.js 14 (App Router) on Vercel
- **Backend:** Supabase (Postgres + Auth + RLS)
- **Styling:** Tailwind CSS
- **Project repo:** C:\Users\derek\Projects\besafe-website

## Handling $ARGUMENTS

- No args: Show project status, recent changes, next priorities
- "proposal": Work on the platform proposal document
- "schema": Database schema design and migrations
- "website": Frontend development on besafe-website
- "hipaa" or "compliance": HIPAA compliance planning and documentation
- Any other text: Interpret as a task description and execute

## Key Documents

- Proposal: `data/task-output/besafe-proposal.md` (and .pdf)
- Flowcharts: `data/task-output/besafe-*.dot` and `.png` (enrollment, billing, care plan review, incident response)
- Byron's source docs: OneDrive > Be Safe Healthcare folder (MSA, BAA, CCM overview)

## Database Schema Principles

- De-identified patient records (initials + birth year + practice ID)
- Practice-level RLS (staff sees only their practice's patients)
- Byron/admin role sees all practices
- Audit logging on all patient-facing tables
- Time tracking with activity type categorization
- Billing recommendation engine based on cumulative monthly minutes
- CPT code mapping: 99490 (20+ min, $66), 99439 (each additional 20 min, $50), 99487 (60+ complex, $144)

## Billing Logic

| Monthly Minutes | CPT Codes | Reimbursement |
|---|---|---|
| 0-19 min | Not billable | $0 (carry forward) |
| 20-39 min | 99490 | $66 |
| 40-59 min | 99490 + 99439 | $116 |
| 60+ min (complex) | 99487 or 99490+99439+99491 | $144 or $155 |

## Workflow

1. Staff logs time entries (type, minutes, description)
2. System tracks cumulative minutes per patient per month
3. At month-end, generate billing recommendations based on thresholds
4. Practice reviews and submits claims
5. Track payment/denial status for reconciliation

## Troubleshooting

### Vercel deploy fails
- Check `besafe-website` build: `cd C:\Users\derek\Projects\besafe-website && npm run build`
- Common issues: missing env vars, TypeScript errors, Supabase client config

### Supabase connection issues
- Verify NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local
- Check RLS policies if queries return empty results unexpectedly

### Proposal generation
- Source markdown at `data/task-output/besafe-proposal.md`
- PDF generated via `data/task-output/md-to-pdf.mjs`
- Flowchart PNGs rendered from DOT files via Graphviz
