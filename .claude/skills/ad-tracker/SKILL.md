---
name: ad-tracker
description: >-
  View and manage the PV MediSpa ad performance tracker. Update pipeline
  status, log weekly snapshots, check alert thresholds, run monthly
  creative audits, and advance ads through the publishing pipeline.
  Use when Derek says "ad tracker", "ad performance", "update ad status",
  "weekly snapshot", "creative audit", "pipeline status", or wants to
  check/update ad metrics.
allowed-tools:
  - Read
  - Glob
  - Grep
context: fork
user-invocable: true
argument-hint: <action or ad ID>
---
# Ad Performance Tracker

## Input Handling

**With $ARGUMENTS:** Parse the action requested. Common patterns:
- `status` or `pipeline` - Show current pipeline status for all ads
- `snapshot` or `weekly` - Fill in the latest weekly performance snapshot
- `audit` or `monthly` - Run the monthly creative audit checklist
- `update LOCAL-03 live` - Move a specific ad to a new pipeline stage
- `alerts` or `flags` - Scan for threshold violations (frequency, CPL, CTR, LP CVR)
- `<ad ID>` - Show details for a specific ad

**Without $ARGUMENTS:** Show a summary dashboard: pipeline stage counts, any active alerts, and the most recent weekly snapshot.

## Data Source

Read `ad-performance-tracker.md` in the project root. This is the single source of truth for:
- Master ad tracker table (20 ad concepts with pipeline status and metrics)
- Creative similarity groups (SIM-A through SIM-T)
- Performance thresholds and alert rules
- Weekly performance snapshots
- Monthly creative audit checklist

For ad copy details, reference `ad-creative-library.md`.

## Actions

### 1. Pipeline Status
Show a compact summary of all ads grouped by pipeline stage:
- **Concept** (copy written, not designed)
- **Design** (visual creative in production)
- **Review** (ready for Derek's approval)
- **Scheduled** (approved, scheduled in Meta)
- **Live** (currently running)
- **Paused** (temporarily stopped)
- **Killed** (permanently archived)

Format as a clean grouped list. Flag any ads that have been in Concept or Design for more than 2 weeks.

### 2. Update Ad Status
When asked to move an ad to a new pipeline stage:
- Identify the ad by ID or name
- Validate the stage transition makes sense (e.g., can't go from Concept to Live)
- Suggest the edit to ad-performance-tracker.md via [CODE_TASK:] tag
- Confirm the change

### 3. Weekly Snapshot
When asked to fill in a weekly snapshot:
- Ask for the week date range
- Pull current metrics from Meta Ads context if available (via /ads command data)
- Fill in the next empty weekly snapshot section
- Calculate week-over-week changes
- Flag any threshold violations
- Suggest the edit via [CODE_TASK:] tag

### 4. Alert Scan
Scan the tracker for threshold violations:
- Frequency >3.0 (warning) or >4.0 (critical)
- CPL >$65
- LP CVR <5%
- CTR <1.5%
Report violations with specific ad IDs and recommended actions.

### 5. Monthly Audit
Walk through the monthly creative audit checklist:
- Check each item against current tracker data
- Flag actionable items
- Recommend specific next steps (pause, swap, test, archive)
- Note pipeline advancement opportunities

### 6. Similarity Check
When adding new ads, check proposed hook/angle against existing SIM groups:
- Flag if new concept is too similar to an existing group
- Suggest differentiation strategies
- Recommend a new SIM group letter if distinct enough

## Output Format

Keep output concise and Telegram-friendly. Use bold for ad names, code blocks for tables when needed, and bullet lists for action items. Always end with suggested next steps.

## Editing Rules

All edits to ad-performance-tracker.md must go through [CODE_TASK:] delegation. Do not edit the file directly. Read it, analyze it, and propose changes via code task tags.
