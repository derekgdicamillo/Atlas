---
name: besafe
description: >-
  Work on the Be Safe Healthcare CCM platform. Use when Derek mentions "Be Safe",
  "BeSafe", "Byron", "Param", "joy-flow-unfold", "CCM platform", "chronic care
  management", "BHI", "eligibility", "X12", "care plan", or wants to work on the
  Be Safe Healthcare product (features, schema, HIPAA compliance, go-live).
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
  version: 2.0.0
  verified: 2026-08-27
---
# Be Safe Healthcare - CCM Platform

## WHICH REPO (read this first)

There are three Be Safe directories. Only one is live.

| Path | What it is | Status |
|---|---|---|
| `C:\Users\Derek DiCamillo\Projects\joy-flow-unfold` | **THE live platform.** GitHub `psinghny-besafe/joy-flow-unfold` (Param Singh's repo). | ACTIVE - commits most days |
| `C:\Users\Derek DiCamillo\Projects\besafe-ccm` | Derek's earlier independent build. GitHub org `Be-Safe-Healthcare`, deployed at ccm.besafehealthcare.com. | LEGACY - last commit 2026-08-17 |
| `C:\Users\Derek DiCamillo\Projects\besafe-website` | Astro marketing site, besafehealthcare.com. | STABLE - rarely touched |

**Default to `joy-flow-unfold` unless Derek names another.** Confirm before acting if ambiguous.
Do not assume `besafe-ccm` is current. That mistake was made on 2026-08-27.

## joy-flow-unfold (the live platform)

HIPAA-bound CCM platform. Its own `CLAUDE.md` and `README.md` are the binding source of
truth - read them before changing anything. `.lovable/` holds ~30 QA checklists, compliance
posture docs, the go-live blocker list, and the production cutover runbook.

**Stack:** Vite + React + TypeScript + shadcn/ui (Radix), Supabase (Postgres + Auth + RLS +
Edge Functions in Deno), Capacitor for iOS/Android, Lovable.dev cloud auth.
Scale as of 2026-08-27: ~779 TS/TSX files, ~162k LOC, 242 SQL migrations.

**Not Next.js. Not Vercel.** (The old version of this skill said both. Both were wrong.)

**Test scripts are granular and worth using.** `npm run test:x12`, `test:bhi-rls`,
`test:ccm-plan`, `test:care-plan-qa`, `test:vbc-qa`, `test:roster-import`, `test:emr-projection`,
plus `smoke`, `smoke:quick`, and `verify:prod`. Run the narrow one that matches the change.

**Working conventions:** it is a shared repo with a collaborator. Never commit or push without
Derek's explicit say-so. For local-only artifacts use `.git/info/exclude`, not `.gitignore`,
so Param's repo shows no spurious diff.

## Code knowledge graph (Graphify)

`joy-flow-unfold/graphify-out/` holds a queryable map of the codebase: 7,926 nodes and
17,405 edges across 1,173 files, including all 242 migrations. Excluded via
`.git/info/exclude`. Query it BEFORE grepping around:

```
graphify query "<question>" --budget 1500   # BFS over the graph
graphify affected "<symbol>" --depth 2      # what breaks if this changes
graphify explain "<symbol>"                 # plain-language node summary
graphify god-nodes --top 10                 # architectural hubs
graphify update .                           # refresh after code changes (seconds, no LLM)
```

The graph goes stale as code changes. Run `graphify update .` at the start of a work session.
Known cosmetic warning: `src/components/carePlan/BillingCodesPanel.tsx` trips the tree-sitter
JSX parser. TypeScript compiles it clean - it is a parser limitation, not a bug.

## Domain model

Be Safe provides embedded CCM services to physician practices. The platform is an
operations layer beside the practice EMR, not inside it. The EMR stays the system of record.
The platform handles staff time tracking, billing recommendations, patient education
delivery, eligibility verification, and compliance reporting.

Active workstreams as of 2026-08-27: BHI (behavioral health integration) enrollment and
rework, patient intake wizard, and X12 270/271 eligibility via clearinghouse + HETS.

**CCM billing thresholds:**

| Monthly minutes | CPT | Reimbursement |
|---|---|---|
| 0-19 | not billable | $0 (carry forward) |
| 20-39 | 99490 | $66 |
| 40-59 | 99490 + 99439 | $116 |
| 60+ complex | 99487, or 99490+99439+99491 | $144 / $155 |

Verify these against the repo before quoting them to anyone. Codes and rates change yearly.

## Handling $ARGUMENTS

- No args: report status of `joy-flow-unfold` (branch, uncommitted work, open PRs, recent commits)
- "graph" / "index": refresh and query the Graphify map
- "schema" / "migration": Supabase migrations under `supabase/migrations/`
- "hipaa" / "compliance": start from `.lovable/compliance-posture.md` and the HIPAA checklists
- "go-live" / "cutover": `.lovable/go-live-checklist.md` and `prod-cutover-runbook.md`
- "legacy" / "besafe-ccm": switch target to the old repo, and say so explicitly
- "website" / "marketing": the Astro site at `besafe-website`
- Anything else: treat as a task description against `joy-flow-unfold`

## Reference documents

- Repo-internal: `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, `.lovable/*`
- Proposals and flowcharts: OneDrive - PV MEDISPA LLC > Be Safe Healthcare > Proposal
  (current version `besafe-ops-proposal-v2.md` / `.pdf`, dated 2026-03-03)
- Byron's source docs: OneDrive > Be Safe Healthcare (MSA, BAA, CCM overview)

## Maintaining this skill

If any path, stack detail, or repo status here turns out to be wrong, fix this file in the
same session. A stale skill file caused a real misdirection on 2026-08-27.
