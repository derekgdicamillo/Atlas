# Midas Self-Learning System — Implementation Plan

## Overview

Transform Midas from a smart reporter into an adaptive learning system. Six components:
1. **Recommendation Outcome Tracker** — track if recs were followed and what happened
2. **Adaptive Thresholds** — thresholds evolve from actual data distribution
3. **Creative Lifecycle** — ad age awareness, fatigue prediction, decay curves
4. **UTM Attribution** — join Meta spend to GHL leads via campaign IDs
5. **Playbook Verification** — test existing claims, evidence-based updates
6. **Data Gap Fixes** — real LP views, real booked counts, form submit divergence

All recommend-only, no auto-actions. One new file (`src/midas-learner.ts`), one new data file (`data/midas-learner.json`), one new cron job (`midas-outcome-check` at 9:15 PM daily), and modifications to existing modules.

---

## Architecture

### New File: `src/midas-learner.ts` (~800-1000 lines)

Single module containing all learning logic. Exports functions consumed by cron.ts and marketing.ts.

### State File: `data/midas-learner.json`

```typescript
interface LearnerState {
  // Section 1: Outcome tracking
  outcomes: RecommendationOutcome[];

  // Section 2: Adaptive thresholds
  computedThresholds: {
    date: string;
    pause: { cpl: number; percentile: number };
    scale: { cpl: number; ctr: number; percentile: number };
    refresh: { frequency: number; stdDevs: number };
    watch: { ctr: number; percentile: number };
  } | null;

  // Section 3: Creative lifecycle
  adFirstSeen: Record<string, string>;   // adId -> YYYY-MM-DD
  decayCurve: DecayBucket[];             // aggregate performance by age bucket

  // Section 4: UTM mapping
  utmMap: Record<string, string>;        // utmCampaign -> Meta campaign name

  // Section 5: Playbook health
  lastPlaybookAudit: string | null;      // ISO date
  playbookClaims: PlaybookClaim[];

  // Metadata
  lastUpdated: string;
}
```

### Cron Integration

One new cron job registered in `cron.ts`:

```
midas-outcome-check  |  9:15 PM daily  |  Outcome tracking + follow-through detection
```

Existing jobs get modifications:
- `midas-digest` (9:30 PM) — reads adaptive thresholds, includes lifecycle/fatigue data
- `midas-attribution` (Sunday 9 AM) — uses UTM join for better source matching
- `midas-monthly` (1st of month) — includes playbook verification, outcome summary, threshold evolution report
- `midas-funnel` (9 AM) — uses real LP views + real booked counts

---

## Implementation Steps

### Step 1: Scaffold `src/midas-learner.ts` with types and state persistence

**Create** `src/midas-learner.ts` with:

```typescript
// Types
interface RecommendationOutcome {
  id: string;                    // `${date}-${adId}-${type}`
  date: string;                  // recommendation date
  adId: string;
  adName: string;
  type: "pause" | "scale" | "refresh" | "watch";
  reason: string;
  baseline: { cpl: number; ctr: number; frequency: number; spend: number };
  followed: boolean | null;      // null = pending detection
  followedDate: string | null;
  outcome: {
    cpl: number; ctr: number; frequency: number; spend: number;
    verdict: "positive" | "neutral" | "negative";
  } | null;
  outcomeDate: string | null;
  lessonExtracted: boolean;
}

interface DecayBucket {
  ageDays: string;               // "1-3", "4-7", "8-14", "15-21", "22-30", "30+"
  avgCpl: number;
  avgCtr: number;
  avgFrequency: number;
  sampleSize: number;
}

interface PlaybookClaim {
  line: string;                  // original text
  metric: string;                // extracted metric name
  claimedValue: number;
  currentValue: number | null;
  status: "verified" | "stale" | "contradicted" | "untestable";
  lastChecked: string;
}
```

State load/save follows exact Atlas pattern:
- `loadLearnerState(): LearnerState` — try/catch existsSync + JSON.parse, fallback to defaults
- `saveLearnerState(state: LearnerState): void` — mkdirSync recursive, writeFileSync, 90-day retention on outcomes

**Files touched:** Create `src/midas-learner.ts`

---

### Step 2: Recommendation Outcome Tracker — Recording

**In `src/midas-learner.ts`**, add:

```typescript
export function recordRecommendations(recs: AdRecommendation[], snapshots: AdSnapshot[]): void
```

Called from `cron.ts` right after `analyzeAdPerformance()` returns. For each recommendation:
1. Check if outcome already exists for this `${date}-${adId}-${type}` (dedup)
2. Build baseline from today's snapshot data for the ad
3. Push to `state.outcomes` with `followed: null`, `outcome: null`

**Files touched:** `src/midas-learner.ts`, `src/cron.ts` (after ad-tracker analyze call)

---

### Step 3: Recommendation Outcome Tracker — Follow-Through Detection

**In `src/midas-learner.ts`**, add:

```typescript
export async function checkFollowThrough(): Promise<string[]>
```

Runs in the new `midas-outcome-check` cron (9:15 PM daily). For pending outcomes (followed === null):

- **PAUSE recs**: Call `getAdCreativeInsights(adId)` from `meta.ts`. If ad status is "PAUSED" or "ARCHIVED", mark `followed: true`. If still "ACTIVE" after 3 days, mark `followed: false` (ignored).
- **SCALE recs**: Check if ad's 7-day spend increased >20% vs baseline spend. If yes, `followed: true`. After 7 days with no spend increase, `followed: false`.
- **REFRESH recs**: Check if ad status changed to "PAUSED"/"ARCHIVED" AND a new ad exists in the same adset (via `listAdsInAdSet()`). If yes, `followed: true`. After 7 days, `followed: false`.
- **WATCH recs**: No action expected. Auto-mark `followed: null` → skip (watches are informational).

Returns array of status change messages for logging.

**Import needed:** `getAdCreativeInsights`, `listAdsInAdSet` from `meta.ts`

**Files touched:** `src/midas-learner.ts`

---

### Step 4: Recommendation Outcome Tracker — Outcome Measurement

**In `src/midas-learner.ts`**, add:

```typescript
export function measureOutcomes(snapshots: AdSnapshot[]): string[]
```

For outcomes where `followed !== null` and `outcomeDate === null` and recommendation is 7+ days old:

1. Get the ad's performance from snapshots in the 7 days after the recommendation
2. Compare to baseline:
   - CPL improved >15% = "positive"
   - CPL worsened >15% = "negative"
   - Otherwise = "neutral"
3. For PAUSE recs that were followed: measure account-level CPL change (did pausing help overall?)
4. Write outcome back to state
5. Return summary messages

**Files touched:** `src/midas-learner.ts`

---

### Step 5: Register `midas-outcome-check` cron job

**In `src/cron.ts`**, add new cron job after the existing midas jobs block (~line 2240):

```typescript
// Midas Outcome Check: 9:15 PM daily
// Detects follow-through on recommendations and measures 7-day outcomes.
// Runs after ad-tracker snapshot (9 PM) so today's data is fresh.
jobs.push(
  CronJob.from({
    cronTime: "15 21 * * *",
    onTick: safeTick("midas-outcome-check", async () => {
      // 1. Record today's recommendations
      // 2. Check follow-through on pending recs
      // 3. Measure outcomes on mature recs
      // 4. Log summary
    }),
    timeZone: TIMEZONE,
  })
);
```

Also update the import line at top of cron.ts to include new functions from midas-learner.ts.

**Files touched:** `src/cron.ts`

---

### Step 6: Adaptive Thresholds — Computation

**In `src/midas-learner.ts`**, add:

```typescript
export function computeAdaptiveThresholds(snapshots: AdSnapshot[]): ComputedThresholds
```

Uses trailing 30-day ad snapshot data to compute percentile-based thresholds:

1. Aggregate snapshots by adId → compute per-ad avgCPL, avgCTR, avgFrequency over the window
2. Sort by CPL, compute percentiles:
   - `pause.cpl` = 80th percentile CPL (ads worse than 80% of account). Floor: $60
   - `scale.cpl` = 20th percentile CPL. Ceiling: $50
   - `scale.ctr` = 80th percentile CTR. Floor: 1.5%
3. Frequency: mean + 1.5 * stddev. Floor: 2.5
4. CTR watch: 25th percentile CTR. Ceiling: 2.0%
5. Store in `state.computedThresholds` with date

**Guardrail:** Read `memory/marketing/thresholds.md`. If manual thresholds exist and differ from computed by >30%, log a warning ("manual threshold $X diverges from computed $Y — consider updating thresholds.md").

**Files touched:** `src/midas-learner.ts`

---

### Step 7: Adaptive Thresholds — Integration with ad-tracker.ts

**In `src/midas-learner.ts`**, add:

```typescript
export function getActiveThresholds(): { pause: number; scale: number; scaleCtr: number; refresh: number; watch: number }
```

Priority:
1. Read `data/midas-learner.json` computed thresholds (if fresh, <7 days old)
2. Fall back to `memory/marketing/thresholds.md` parsed values
3. Fall back to hardcoded defaults ($80/$40/3.5/1%)

**In `src/ad-tracker.ts`**, replace hardcoded threshold values in `analyzeAdPerformance()`:

```typescript
// Before (hardcoded):
if (avgCPL > 80 && totalSpend > 50) { ... }

// After (adaptive):
import { getActiveThresholds } from "./midas-learner.ts";
const thresholds = getActiveThresholds();
if (avgCPL > thresholds.pause && totalSpend > 50) { ... }
```

Replace all 4 threshold checks (PAUSE, SCALE, REFRESH, WATCH).

**Schedule:** `computeAdaptiveThresholds()` runs weekly (Sunday) as part of `midas-attribution` job, after the attribution report is built.

**Files touched:** `src/ad-tracker.ts` (4 threshold replacements), `src/midas-learner.ts`, `src/cron.ts` (add compute call to midas-attribution job)

---

### Step 8: Creative Lifecycle — Ad Age Tracking

**In `src/midas-learner.ts`**, add:

```typescript
export function updateAdRegistry(snapshots: AdSnapshot[]): void
```

Maintains `state.adFirstSeen` map. For each snapshot, if `adId` not in map, set to today's date.

```typescript
export function getAdAge(adId: string): number | null
```

Returns days since first seen, or null if unknown.

```typescript
export function enrichWithAge(snapshots: AdSnapshot[]): (AdSnapshot & { ageDays: number | null })[]
```

Adds age to each snapshot for downstream analysis.

Called from `midas-outcome-check` cron after recording snapshots.

**Files touched:** `src/midas-learner.ts`, `src/cron.ts` (call updateAdRegistry after snapshot recording)

---

### Step 9: Creative Lifecycle — Decay Curves and Fatigue Prediction

**In `src/midas-learner.ts`**, add:

```typescript
export function buildDecayCurves(snapshots: AdSnapshot[]): DecayBucket[]
```

Groups all ad snapshots by age bucket ("1-3", "4-7", "8-14", "15-21", "22-30", "30+"). Computes average CPL, CTR, frequency per bucket. Requires 20+ unique adIds with 14+ days of data to produce meaningful curves.

```typescript
export function detectFatigue(adId: string, snapshots: AdSnapshot[]): {
  fatiguing: boolean;
  peakCpl: number;
  currentCpl: number;
  ageDays: number;
  predictedDaysToThreshold: number | null;
} | null
```

For a given ad:
1. Get its age and performance trajectory
2. Find its best 7-day CPL window (the peak)
3. If current CPL > peak * 1.4 AND age > typical peak age from decay curve → fatiguing
4. Extrapolate trajectory to predict when it'll cross the PAUSE threshold

New recommendation type added to `AdRecommendation`: `"fatigue"` (distinct from "pause").

**Files touched:** `src/midas-learner.ts`, `src/ad-tracker.ts` (add "fatigue" to type union)

---

### Step 10: Creative Lifecycle — Fatigue in Digest

**In `src/marketing.ts`**, modify `buildAdDigest()`:

After computing trend for each ad, also check fatigue:

```typescript
import { detectFatigue, getAdAge } from "./midas-learner.ts";

// In the per-ad loop:
const fatigue = detectFatigue(adId, adSnapshots);
if (fatigue?.fatiguing) {
  entry.alerts.push(`FATIGUING: peaked at $${fatigue.peakCpl} CPL, now $${fatigue.currentCpl} (day ${fatigue.ageDays})`);
}
if (fatigue?.predictedDaysToThreshold) {
  entry.alerts.push(`Predicted to hit PAUSE threshold in ~${fatigue.predictedDaysToThreshold} days`);
}
```

Also add a digest summary line: "X ads approaching fatigue within 5 days"

**Files touched:** `src/marketing.ts` (buildAdDigest modifications)

---

### Step 11: UTM Attribution — Mapping

**In `src/midas-learner.ts`**, add:

```typescript
export function extractUTMFromOpportunities(opps: GHLOpportunity[]): void
```

For each opportunity, check if it has attribution data. The GHL API returns opportunities with nested attribution arrays. We need to update `GHLOpportunity` interface to include:

```typescript
// In ghl.ts, add to GHLOpportunity:
attributions?: Array<{
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}>;
```

For each opp with `attributions[0].utmCampaign`:
1. Store mapping: `utmCampaign` → look up campaign name from ad-tracker snapshots (match by campaignName field which contains the Meta campaign ID)
2. Track lead count per utmCampaign

```typescript
export function buildUTMAttribution(days: number): UTMAttributionResult
```

Returns spend-to-lead join by campaign using UTM data:
1. Read ad-tracker snapshots for spend by campaignName (which is Meta campaign ID)
2. Read UTM map for leads by utmCampaign
3. Join on campaign ID → produce per-campaign: spend, leads, CPL
4. Also join at ad level via utmTerm (ad ID) when available

**Files touched:** `src/midas-learner.ts`, `src/ghl.ts` (add attributions to interface)

---

### Step 12: UTM Attribution — Integration with Weekly Report

**In `src/marketing.ts`**, modify `buildWeeklyAttribution()`:

```typescript
import { buildUTMAttribution } from "./midas-learner.ts";

// After existing attribution logic, try UTM-based attribution:
const utmAttribution = buildUTMAttribution(7);
if (utmAttribution.campaigns.length > 0) {
  // Use UTM data to produce more accurate per-campaign rows
  // Merge with existing rows, preferring UTM-joined data
}
```

This provides accurate per-campaign CPL by joining Meta spend data to GHL leads via matching campaign IDs, instead of hoping source strings match.

**Files touched:** `src/marketing.ts` (buildWeeklyAttribution modifications)

---

### Step 13: Playbook Verification — Claim Extraction

**In `src/midas-learner.ts`**, add:

```typescript
export function auditPlaybook(): PlaybookAuditResult
```

1. Read `memory/marketing/playbook.md`
2. Scan each line for testable claims using regex patterns:
   - CPL references: `/CPL\s*\$(\d+)/i`
   - CTR references: `/CTR\s*([\d.]+)%/i`
   - Performance claims: `/#1 performer/i`, `/outperform/i`, `/underperform/i`
   - Hook type claims: `/(ELIG|CURI|PAIN|CRED|FEAR|SKEP|CONV|NOBL|OUTC|MYTH)\s+hooks?\s+(are|is)\s+/i`
3. For each claim, check against current 30-day ad-tracker data:
   - If hook type claim: filter snapshots by ad name containing hook type code, compute avg CPL
   - If CPL claim: compare claimed value to current account average
4. Classify: verified (within 20%), stale (>30 days old and >30% off), contradicted (opposite direction)
5. Store results in `state.playbookClaims`

Returns: `{ verified: number, stale: number, contradicted: number, claims: PlaybookClaim[] }`

**Files touched:** `src/midas-learner.ts`

---

### Step 14: Playbook Verification — Evidence-Based Updates

**In `src/midas-learner.ts`**, add:

```typescript
export function generateLessonsSection(): string | null
```

When outcome tracker has 10+ completed outcomes for a recommendation type:
1. Compute stats: "PAUSE recommendations followed: X/Y. Avg CPL improvement: Z%. Avg weekly savings: $W"
2. Format as markdown section under `## Data-Driven Lessons (auto-generated)`
3. Include date, sample size, and confidence note

```typescript
export function generateThresholdFeedback(): string | null
```

If >50% of PAUSE recs are ignored → "PAUSE threshold may be too aggressive (only X% followed). Consider raising from $Y to $Z."
If >80% of SCALE recs are followed with positive outcomes → "SCALE threshold could be tighter to catch more winners."

**Integration:** Called from `midas-monthly` cron. Output included in the monthly brief context and appended to playbook.md alongside the existing Section 6 auto-update.

**Files touched:** `src/midas-learner.ts`, `src/cron.ts` (midas-monthly job additions)

---

### Step 15: Data Gap Fixes — Real LP Views

**In `src/marketing.ts`**, modify `buildFunnelSnapshot()`:

Replace the hardcoded estimate:
```typescript
// Before:
snapshot.lpViews = Math.round(snapshot.clicks * 0.85);

// After:
// Try to get real LP views from ad-tracker snapshots (which should include lpViews from Meta)
// Fall back to 85% estimate if not available
const realLpViews = daySnapshots.reduce((sum, s) => sum + (s.lpViews || 0), 0);
snapshot.lpViews = realLpViews > 0 ? realLpViews : Math.round(snapshot.clicks * 0.85);
```

**In `src/ad-tracker.ts`**, add `lpViews` field to `AdSnapshot`:

```typescript
export interface AdSnapshot {
  // ... existing fields ...
  lpViews: number;  // NEW: landing page views from Meta (0 if unavailable)
}
```

**In `src/ad-tracker.ts`**, update `insightsToSnapshots()` to accept and pass through lpViews.

**In `src/cron.ts`**, where `getTopAds()` results are converted to snapshots, also fetch `getAccountSummary()` for the `landingPageViews` count and distribute proportionally across ads (or store account-level).

**Files touched:** `src/ad-tracker.ts` (type + converter), `src/marketing.ts` (buildFunnelSnapshot), `src/cron.ts` (pass LP views data)

---

### Step 16: Data Gap Fixes — Real Booked Counts

**In `src/marketing.ts`**, modify `buildFunnelSnapshot()`:

Replace reminder-based booked count with GHL pipeline stage data:

```typescript
// Before:
snapshot.consultationsBooked = dailyStats.remindersTotal || 0;

// After:
// Use GHL pipeline stage counts for more accurate data
// Fall back to show-rate-state if GHL unavailable
import { isGHLReady, getOpsSnapshot } from "./ghl.ts";
if (isGHLReady()) {
  try {
    const ops = await getOpsSnapshot();
    // ops.stages has per-stage counts — extract booked/showed from stage names
    // ... (use same stage name matching as getPipelineAttribution)
  } catch { /* fall through to show-rate-state */ }
}
```

Note: This requires making `buildFunnelSnapshot` async. Check all callers.

**Files touched:** `src/marketing.ts` (buildFunnelSnapshot → async), `src/cron.ts` (await the call)

---

### Step 17: Data Gap Fixes — Form Submit Divergence

**In `src/midas-learner.ts`**, add:

```typescript
export function checkFormSubmitDivergence(metaFormSubmits: number, ghlLeads: number): string | null
```

Compare Meta form submit conversions (from `getAccountSummary().conversions`) to GHL lead count (from `lead-volume.json`). If divergence > 20%, return alert string: "Form submit divergence: Meta reports X submissions but GHL created only Y leads. Possible webhook failure."

Called from `midas-funnel` cron job. Alert sent to Telegram if triggered.

**Files touched:** `src/midas-learner.ts`, `src/cron.ts` (call in midas-funnel)

---

### Step 18: Learner Digest — Surface Insights in Existing Reports

**In `src/midas-learner.ts`**, add:

```typescript
export function getLearnerDigest(): string
```

Produces a compact summary for inclusion in the nightly digest and monthly brief:

```
--- Midas Learning ---
Outcomes tracked: 47 (32 followed, 12 ignored, 3 pending)
PAUSE accuracy: 78% positive (18/23)
SCALE accuracy: 85% positive (11/13)
Adaptive thresholds: PAUSE $74 (was $80), SCALE $38 (was $40)
Ads approaching fatigue (5d): 2 (Ad_ELIG_04, Ad_CURI_12)
Playbook health: 8 verified, 2 stale, 1 contradicted
```

**Integrate into:**
- `midas-digest` (9:30 PM) — append learner digest to nightly ad digest
- `midas-monthly` (1st) — include full learner report as new section in monthly brief

**Files touched:** `src/midas-learner.ts`, `src/cron.ts` (digest + monthly modifications)

---

## Execution Order

Steps are ordered by dependency. Steps within a group can be parallelized.

| Phase | Steps | Description |
|-------|-------|-------------|
| **A: Foundation** | 1 | Scaffold types, state, load/save |
| **B: Outcome Tracker** | 2, 3, 4, 5 | Record → Detect → Measure → Cron |
| **C: Adaptive Thresholds** | 6, 7 | Compute → Integrate into ad-tracker |
| **D: Creative Lifecycle** | 8, 9, 10 | Age tracking → Decay/fatigue → Digest |
| **E: UTM Attribution** | 11, 12 | Mapping → Weekly report integration |
| **F: Playbook** | 13, 14 | Claim extraction → Evidence updates |
| **G: Data Gaps** | 15, 16, 17 | LP views → Booked counts → Form divergence |
| **H: Surface** | 18 | Learner digest in reports |

**Review checkpoints:** After phases B, D, and H — restart Atlas and verify cron output in logs.

---

## Files Summary

| File | Action | Changes |
|------|--------|---------|
| `src/midas-learner.ts` | **CREATE** | ~800-1000 lines, all learning logic |
| `src/cron.ts` | MODIFY | Add midas-outcome-check job, modify 4 existing midas jobs, add imports |
| `src/ad-tracker.ts` | MODIFY | Replace 4 hardcoded thresholds with adaptive, add "fatigue" type, add lpViews field |
| `src/marketing.ts` | MODIFY | Fatigue in digest, UTM in attribution, real LP views, async buildFunnelSnapshot |
| `src/ghl.ts` | MODIFY | Add attributions to GHLOpportunity interface |
| `data/midas-learner.json` | **CREATE** | Auto-created on first run |

---

## Constraints

- **Recommend-only**: No auto-pause, no auto-scale. All actions require Derek's decision
- **API budget**: Follow-through detection adds ~5-10 Meta API calls/day (one per pending rec). Acceptable
- **No new dependencies**: Uses only native FS, existing Atlas modules, and Meta/GHL APIs already integrated
- **Backward compatible**: Existing midas jobs continue working if learner state is empty. All new features gracefully degrade with insufficient data
- **90-day retention**: Matches existing Atlas pattern. Outcomes older than 90 days are pruned
