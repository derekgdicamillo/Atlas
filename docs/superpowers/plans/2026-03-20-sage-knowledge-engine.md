# S.A.G.E. Knowledge Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken MAA scraper with a modular, self-learning knowledge engine that keeps S.A.G.E.'s 15-category knowledge base fresh across 50 states and national topics, driven by user conversation analysis.

**Architecture:** Three research tracks (state sweep, national sweep, demand-driven) feed knowledge through a quality gate into Supabase `maa_knowledge`. A weekly conversation analyzer mines `maa_conversations` for gaps and trends, prioritizing research targets. RAG retrieval upgraded with weighted scoring across scope, category, quality, and demand signals.

**Tech Stack:** Bun/TypeScript (Atlas), Cloudflare Workers (maa-advisor), Supabase Postgres + pgvector, Anthropic Messages API with web_search tool, Vitest (maa-advisor tests)

**Spec:** `docs/superpowers/specs/2026-03-20-sage-knowledge-engine-design.md`

**Deploy order:** Migration first (Task 1) -> Edge Function + RPC (Task 2) -> Worker RAG update (Task 3) -> Atlas modules (Tasks 4-8)

---

## File Structure

### New Files (Atlas)
| File | Responsibility |
|------|---------------|
| `src/sage-topics.ts` | Topic registry: 15 category configs with prompts, criteria, keywords |
| `src/sage-research.ts` | Research engine: state sweep, national sweep, demand research, quality gate, web search API calls |
| `src/sage-analyzer.ts` | Weekly conversation analyzer: classification, quality scoring, gap detection, trend writing |

### Modified Files (Atlas)
| File | Changes |
|------|---------|
| `src/cron.ts` | Add 4 new cron jobs, add job timeouts, remove maa-scrape from night-shift instruction |
| `src/night-shift.ts` | Remove `maa-scrape` type from NightShiftTaskType union and worker handler |
| Any file importing `getScraperStatus` from `maa-scraper.ts` | Switch to `getResearchStatus` from `sage-research.ts` |

### Deleted Files (Atlas)
| File | Reason |
|------|--------|
| `src/maa-scraper.ts` | Replaced entirely by `sage-research.ts` |

### New Files (maa-advisor)
| File | Responsibility |
|------|---------------|
| `db/004_sage_engine.sql` | Schema migration: rename topic->category, add columns, new table, new RPCs |

### Modified Files (maa-advisor)
| File | Changes |
|------|---------|
| `worker/src/rag.ts` | Update KnowledgeChunk interface (topic->category), pass categories to searchKnowledge |
| `worker/src/index.ts` | Pass intents to searchKnowledge call |

### Modified Files (Supabase)
| File | Changes |
|------|---------|
| Edge Function `maa-search` | Switch to `maa_search_knowledge_v2` RPC, accept categories param |

---

## Task 1: Database Migration

**Files:**
- Create: `C:\Users\derek\Projects\maa-advisor\db\004_sage_engine.sql`

This is the foundation. Everything else depends on these schema changes.

- [ ] **Step 1: Create migration file**

```sql
-- 004_sage_engine.sql
-- S.A.G.E. Knowledge Engine schema changes
-- Expands maa_knowledge for 15-category taxonomy with multi-chunk support
-- Adds sage_question_trends for conversation analysis

-- ============================================================
-- 1. RENAME topic -> category IN maa_knowledge
-- ============================================================
ALTER TABLE maa_knowledge RENAME COLUMN topic TO category;

-- ============================================================
-- 2. ADD NEW COLUMNS TO maa_knowledge
-- ============================================================
ALTER TABLE maa_knowledge
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'state',
  ADD COLUMN IF NOT EXISTS quality_score REAL,
  ADD COLUMN IF NOT EXISTS refresh_cadence_days INTEGER DEFAULT 17,
  ADD COLUMN IF NOT EXISTS demand_score REAL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flagged BOOLEAN DEFAULT FALSE;

-- ============================================================
-- 2b. BACKFILL chunk_hash for any NULL rows and set NOT NULL
-- ============================================================
UPDATE maa_knowledge SET chunk_hash = md5(content) WHERE chunk_hash IS NULL;
ALTER TABLE maa_knowledge ALTER COLUMN chunk_hash SET NOT NULL;

-- ============================================================
-- 3. REPLACE UNIQUE CONSTRAINT (allow multiple chunks per category)
-- ============================================================
DROP INDEX IF EXISTS idx_maa_knowledge_state_topic;

-- Dedup by content hash. NULLS NOT DISTINCT ensures national chunks
-- (state_code IS NULL) are properly deduped instead of treated as always-unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_maa_knowledge_chunk_dedup
  ON maa_knowledge (state_code, category, chunk_hash) NULLS NOT DISTINCT;

-- Refresh scheduling
CREATE INDEX IF NOT EXISTS idx_maa_knowledge_refresh
  ON maa_knowledge (last_verified_at, refresh_cadence_days);

-- Category + scope for retrieval
CREATE INDEX IF NOT EXISTS idx_maa_knowledge_category_scope
  ON maa_knowledge (category, scope);

-- ============================================================
-- 4. NEW TABLE: sage_question_trends
-- ============================================================
CREATE TABLE IF NOT EXISTS sage_question_trends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL,
  category TEXT NOT NULL,
  state_code TEXT,
  question_count INTEGER DEFAULT 0,
  sample_questions TEXT[],
  avg_answer_quality REAL,
  knowledge_gap_detected BOOLEAN DEFAULT FALSE,
  gap_description TEXT,
  research_priority INTEGER,
  researched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint for PostgREST upsert (one trend per week+category+state)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sage_trends_week_category_state
  ON sage_question_trends (week_start, category, state_code) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_sage_trends_gaps
  ON sage_question_trends (knowledge_gap_detected, researched_at)
  WHERE knowledge_gap_detected = TRUE;

-- ============================================================
-- 5. ADD category COLUMN TO maa_conversations
-- ============================================================
ALTER TABLE maa_conversations ADD COLUMN IF NOT EXISTS category TEXT;

-- ============================================================
-- 6. REPLACE maa_upsert_knowledge RPC
-- ============================================================
CREATE OR REPLACE FUNCTION maa_upsert_knowledge(
  p_state_code TEXT,
  p_category TEXT,
  p_title TEXT,
  p_content TEXT,
  p_source_url TEXT DEFAULT NULL,
  p_source_name TEXT DEFAULT NULL,
  p_embedding VECTOR(1536) DEFAULT NULL,
  p_chunk_hash TEXT DEFAULT NULL,
  p_scope TEXT DEFAULT 'state',
  p_quality_score REAL DEFAULT NULL,
  p_demand_score REAL DEFAULT 0,
  p_source_count INTEGER DEFAULT 0,
  p_flagged BOOLEAN DEFAULT FALSE,
  p_refresh_cadence_days INTEGER DEFAULT 17
)
RETURNS UUID AS $$
DECLARE
  result_id UUID;
BEGIN
  INSERT INTO maa_knowledge (
    state_code, category, title, content, source_url, source_name,
    embedding, chunk_hash, scope, quality_score, demand_score,
    source_count, flagged, refresh_cadence_days,
    last_verified_at, updated_at
  ) VALUES (
    p_state_code, p_category, p_title, p_content, p_source_url, p_source_name,
    p_embedding, p_chunk_hash, p_scope, p_quality_score, p_demand_score,
    p_source_count, p_flagged, p_refresh_cadence_days,
    NOW(), NOW()
  )
  ON CONFLICT (state_code, category, chunk_hash)
  DO UPDATE SET
    title = EXCLUDED.title,
    content = EXCLUDED.content,
    source_url = EXCLUDED.source_url,
    source_name = EXCLUDED.source_name,
    embedding = EXCLUDED.embedding,
    scope = EXCLUDED.scope,
    quality_score = EXCLUDED.quality_score,
    demand_score = EXCLUDED.demand_score,
    source_count = EXCLUDED.source_count,
    flagged = EXCLUDED.flagged,
    refresh_cadence_days = EXCLUDED.refresh_cadence_days,
    last_verified_at = NOW(),
    updated_at = NOW()
  RETURNING id INTO result_id;
  RETURN result_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 7. REPLACE maa_search_knowledge RPC (weighted retrieval)
-- ============================================================
CREATE OR REPLACE FUNCTION maa_search_knowledge_v2(
  query_embedding VECTOR(1536),
  p_state_code TEXT DEFAULT NULL,
  p_categories TEXT[] DEFAULT NULL,
  match_count INT DEFAULT 8,
  match_threshold FLOAT DEFAULT 0.45
)
RETURNS TABLE (
  id UUID,
  state_code TEXT,
  category TEXT,
  title TEXT,
  content TEXT,
  source_url TEXT,
  source_name TEXT,
  similarity FLOAT,
  final_score FLOAT
) AS $$
BEGIN
  RETURN QUERY
  WITH scored AS (
    SELECT
      mk.id,
      mk.state_code,
      mk.category,
      mk.title,
      mk.content,
      mk.source_url,
      mk.source_name,
      (1 - (mk.embedding <=> query_embedding))::FLOAT AS vector_sim,
      CASE
        WHEN mk.state_code = p_state_code THEN 0.15
        WHEN mk.state_code IS NULL THEN 0.05
        ELSE -0.3
      END AS scope_boost,
      CASE
        WHEN p_categories IS NOT NULL AND mk.category = ANY(p_categories) THEN 0.10
        ELSE 0
      END AS category_boost,
      COALESCE(mk.quality_score, 0.5) * 0.05 AS quality_boost,
      LEAST(mk.demand_score * 0.02, 0.10) AS demand_boost
    FROM maa_knowledge mk
    WHERE mk.flagged IS NOT TRUE
  )
  SELECT
    s.id,
    s.state_code,
    s.category,
    s.title,
    s.content,
    s.source_url,
    s.source_name,
    s.vector_sim AS similarity,
    (s.vector_sim + s.scope_boost + s.category_boost + s.quality_boost + s.demand_boost) AS final_score
  FROM scored s
  WHERE s.vector_sim >= match_threshold
  ORDER BY (s.vector_sim + s.scope_boost + s.category_boost + s.quality_boost + s.demand_boost) DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;
```

- [ ] **Step 2: Run migration against Supabase**

Run against the Supabase project using the SQL editor or `psql`. Verify:

```sql
-- Check maa_knowledge has new columns
SELECT column_name FROM information_schema.columns
WHERE table_name = 'maa_knowledge' ORDER BY ordinal_position;
-- Should include: category (not topic), scope, quality_score, refresh_cadence_days, demand_score, source_count, flagged

-- Check sage_question_trends exists
SELECT count(*) FROM sage_question_trends;
-- Should return 0

-- Check new RPC exists
SELECT proname FROM pg_proc WHERE proname = 'maa_search_knowledge_v2';
-- Should return 1 row
```

- [ ] **Step 3: Commit migration**

```bash
cd C:\Users\derek\Projects\maa-advisor
git add db/004_sage_engine.sql
git commit -m "feat: add SAGE knowledge engine schema (004_sage_engine)"
```

---

## Task 2: Update Edge Function `maa-search`

**Files:**
- Modify: Supabase Edge Function `maa-search/index.ts`

Update the Edge Function to call the new `maa_search_knowledge_v2` RPC and accept categories.

- [ ] **Step 1: Locate and read the current Edge Function**

The Edge Function is in the Supabase dashboard or in a local `supabase/functions/maa-search/` directory. Read it to understand the current structure.

- [ ] **Step 2: Update the Edge Function**

The Edge Function should:
1. Accept `categories` (string array) in the POST body alongside existing params
2. Call `maa_search_knowledge_v2` instead of the old RPC
3. Return the same response shape (array of chunks with similarity)

Key changes to the handler:

```typescript
// Parse request - add categories
const { query, state_code, categories, match_count = 8, match_threshold = 0.45 } = await req.json();

// Embed the query (unchanged)
const embedding = await embedQuery(query);

// Call v2 RPC instead of old one
const { data, error } = await supabase.rpc('maa_search_knowledge_v2', {
  query_embedding: JSON.stringify(embedding),
  p_state_code: state_code || null,
  p_categories: categories || null,
  match_count,
  match_threshold,
});

// Return results (response shape unchanged - id, state_code, category, title, content, source_url, source_name, similarity)
return new Response(JSON.stringify(data || []), {
  headers: { 'Content-Type': 'application/json' },
});
```

- [ ] **Step 3: Deploy and test the Edge Function**

Deploy via Supabase dashboard or CLI. Test with curl:

```bash
curl -X POST "${SUPABASE_URL}/functions/v1/maa-search" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"query": "Texas NP scope of practice", "state_code": "TX", "categories": ["scope_of_practice"], "match_count": 5}'
```

Expected: JSON array (may be empty if maa_knowledge has no data yet, which is fine).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: upgrade maa-search Edge Function to v2 weighted retrieval"
```

---

## Task 3: Update maa-advisor Worker RAG

**Files:**
- Modify: `C:\Users\derek\Projects\maa-advisor\worker\src\rag.ts`
- Modify: `C:\Users\derek\Projects\maa-advisor\worker\src\index.ts`
- Modify: `C:\Users\derek\Projects\maa-advisor\worker\src\__tests__\intent.test.ts` (update if interface change affects tests)

- [ ] **Step 1: Update KnowledgeChunk interface in rag.ts**

In `worker/src/rag.ts`, rename `topic` to `category` in the interface:

```typescript
// Before
interface KnowledgeChunk {
  id: string;
  state_code: string | null;
  topic: string;
  // ...
}

// After
export interface KnowledgeChunk {
  id: string;
  state_code: string | null;
  category: string;
  // ... rest unchanged
}
```

- [ ] **Step 2: Update searchKnowledge to accept categories**

In `worker/src/rag.ts`, add `categories` parameter:

```typescript
// Before
export async function searchKnowledge(
  query: string,
  stateCode: string | null,
  supabaseUrl: string,
  supabaseAnonKey: string,
): Promise<KnowledgeChunk[]>

// After
export async function searchKnowledge(
  query: string,
  stateCode: string | null,
  supabaseUrl: string,
  supabaseAnonKey: string,
  categories?: string[],
): Promise<KnowledgeChunk[]>
```

Update the fetch body inside `searchKnowledge` to include categories:

```typescript
body: JSON.stringify({
  query,
  state_code: stateCode,
  categories: categories || null,  // NEW
  match_count: 8,                  // was 5
  match_threshold: 0.45,           // was 0.5
}),
```

- [ ] **Step 3: Add intent-to-category mapping**

Add a mapping function at the top of `rag.ts`:

```typescript
const INTENT_TO_CATEGORIES: Record<string, string[]> = {
  regulatory: ['scope_of_practice', 'medspa_compliance', 'delegation_supervision', 'marketing_compliance'],
  business: ['business_entity', 'business_strategy', 'insurance_malpractice', 'revenue_optimization'],
  hormozi: ['revenue_optimization', 'business_strategy', 'marketing_strategy'],
  marketing: ['marketing_strategy', 'marketing_compliance'],
  content: ['marketing_strategy'],
  operations: ['hiring_staffing', 'osha_safety', 'hipaa_compliance', 'patient_experience'],
  finance: ['revenue_optimization', 'business_strategy'],
};

export function intentsToCategories(intents: string[]): string[] {
  const categories = new Set<string>();
  for (const intent of intents) {
    const mapped = INTENT_TO_CATEGORIES[intent];
    if (mapped) mapped.forEach(c => categories.add(c));
  }
  return [...categories];
}
```

- [ ] **Step 4: Update worker index.ts to pass categories**

In `worker/src/index.ts`, find where `searchKnowledge` is called and pass the intents:

```typescript
// Before
const chunks = await searchKnowledge(message, stateCode, env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

// After
import { intentsToCategories } from './rag';
// ...
const categories = intentsToCategories(intents);
const chunks = await searchKnowledge(message, stateCode, env.SUPABASE_URL, env.SUPABASE_ANON_KEY, categories);
```

- [ ] **Step 5: Verify no remaining .topic references in worker**

The `formatRagContext` function in `rag.ts` only uses `chunk.state_code`, `chunk.title`, `chunk.content`, `chunk.source_name`, and `chunk.source_url`. It does NOT reference `.topic`, so no changes needed in the formatting logic. Just verify with a search:

```bash
cd C:\Users\derek\Projects\maa-advisor
grep -rn "\.topic" worker/src/ --include="*.ts" | grep -v node_modules | grep -v ".test."
```

Only the `KnowledgeChunk` interface definition (already updated in Step 1) should reference it. If any other references exist, rename them to `.category`.

- [ ] **Step 6: Run tests and type check**

```bash
cd C:\Users\derek\Projects\maa-advisor\worker
npx tsc --noEmit
npx vitest run
```

Expected: All 44 tests pass. If any test references `topic` on KnowledgeChunk, update it to `category`.

- [ ] **Step 7: Commit**

```bash
cd C:\Users\derek\Projects\maa-advisor
git add worker/src/rag.ts worker/src/index.ts
git commit -m "feat: upgrade RAG to pass categories and support weighted retrieval"
```

---

## Task 4: Topic Registry (`sage-topics.ts`)

**Files:**
- Create: `C:\Users\derek\Projects\atlas\src\sage-topics.ts`

- [ ] **Step 1: Create the topic registry module**

```typescript
/**
 * S.A.G.E. Topic Registry
 *
 * Config-driven definitions for all 15 knowledge categories.
 * Adding a new topic = adding one object to TOPIC_REGISTRY.
 */

export interface TopicConfig {
  category: string;
  label: string;
  scope: 'state' | 'national';
  refreshCadenceDays: number;
  researchPromptTemplate: string;
  qualityCriteria: string[];
  intentKeywords: string[];
  hedgingExemptions?: string[];
}

// All 50 states
export const ALL_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

export const STATE_NAMES: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",
  CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",
  FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",
  IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",
  KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",
  MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",
  MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",
  NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",
  NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",
  OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",
  SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",
  VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",
  WI:"Wisconsin",WY:"Wyoming",
};

export const PRIORITY_STATES = ["TX", "CA", "FL", "NY", "AZ"];

function statePrompt(topic: string, details: string): string {
  return `You are researching medical aesthetics regulations and practice guidance for {{state_name}} ({{state_code}}).

Topic: ${topic}

${details}

## Output Format
Return ONLY valid JSON (no markdown fences):
{
  "state_code": "{{state_code}}",
  "chunks": [
    {
      "title": "Descriptive title",
      "content": "Detailed content (400-800 words). Include specific statute citations, board rule numbers, URLs, dollar figures, dates.",
      "source_name": "Source organization name",
      "source_url": "https://source.url"
    }
  ]
}

You may return multiple chunks if the topic has distinct sub-sections (e.g., one chunk per provider type). Each chunk should be self-contained.
Be factual. Include actual statute numbers, board URLs, and dates. If you cannot find specific information, note what is unknown.`;
}

function nationalPrompt(topic: string, details: string): string {
  return `You are researching current information for the S.A.G.E. Practice Advisor knowledge base, which serves aesthetic practitioners (NPs, RNs, PAs, estheticians) starting or running medical aesthetics practices.

Topic: ${topic}

${details}

## Output Format
Return ONLY valid JSON (no markdown fences):
{
  "chunks": [
    {
      "title": "Descriptive title",
      "content": "Detailed content (400-800 words). Include specific data, statistics, pricing, regulatory citations, URLs.",
      "source_name": "Source organization name",
      "source_url": "https://source.url"
    }
  ]
}

You may return multiple chunks if the topic has distinct sub-sections. Each chunk should be self-contained.
Use current data from 2025-2026. Cite specific numbers, studies, and organizations. No vague generalities.`;
}

export const TOPIC_REGISTRY: TopicConfig[] = [
  // ============================================================
  // STATE-SPECIFIC (6)
  // ============================================================
  {
    category: "scope_of_practice",
    label: "Scope of Practice",
    scope: "state",
    refreshCadenceDays: 30,
    researchPromptTemplate: statePrompt("NP/PA Scope of Practice in Medical Aesthetics", `Research:
- NP practice authority level in {{state_name}} (full/reduced/restricted)
- Collaborative or supervisory agreement requirements
- What aesthetic procedures NPs can perform independently vs. under supervision
- PA scope of practice for aesthetic procedures
- Board of nursing URL and relevant practice act citations
- APRN compact participation status
- Recent legislative changes affecting aesthetic practice scope`),
    qualityCriteria: ["statute_citation", "board_url", "practice_authority_level", "provider_type_distinction"],
    intentKeywords: ["scope", "practice authority", "can I perform", "NP allowed", "collaborative agreement", "independent practice", "APRN"],
    hedgingExemptions: ["varies by state", "check with your board", "consult a healthcare attorney", "subject to change"],
  },
  {
    category: "medspa_compliance",
    label: "MedSpa Compliance & CPOM",
    scope: "state",
    refreshCadenceDays: 30,
    researchPromptTemplate: statePrompt("MedSpa Compliance & Corporate Practice of Medicine", `Research:
- Can an NP/PA own a medspa in {{state_name}}?
- Corporate Practice of Medicine (CPOM) doctrine applicability
- Medical Director requirements (proximity, availability, compensation ranges)
- MSO/management company structure requirements and restrictions
- Key board rules and statute citations
- Recent enforcement actions or guidance changes
- Common compliance pitfalls in {{state_name}}`),
    qualityCriteria: ["statute_citation", "board_url", "cpom_applicability", "medical_director_requirements"],
    intentKeywords: ["CPOM", "medical director", "compliance", "own a medspa", "corporate practice", "MSO", "management company"],
    hedgingExemptions: ["varies by state", "check with your board", "consult a healthcare attorney"],
  },
  {
    category: "delegation_supervision",
    label: "Delegation & Supervision",
    scope: "state",
    refreshCadenceDays: 30,
    researchPromptTemplate: statePrompt("Delegation & Supervision Rules for Aesthetic Procedures", `Research:
- What can be delegated to RNs, LPNs, medical assistants, estheticians in {{state_name}}
- Supervision requirements by procedure type (on-site, available, general)
- Training/certification requirements for delegated procedures
- Specific rules for: injectables (neurotoxin, filler), lasers/IPL, chemical peels, microneedling
- Who can operate laser devices by class
- Documentation requirements for delegation
- Recent changes or board guidance`),
    qualityCriteria: ["statute_citation", "provider_type_distinction", "procedure_specificity", "supervision_level"],
    intentKeywords: ["delegate", "supervision", "who can", "RN perform", "esthetician", "medical assistant", "laser operator"],
    hedgingExemptions: ["varies by state", "check with your board"],
  },
  {
    category: "business_entity",
    label: "Business Entity & Formation",
    scope: "state",
    refreshCadenceDays: 45,
    researchPromptTemplate: statePrompt("MedSpa Business Entity Formation", `Research:
- Required entity type for medical practices in {{state_name}} (LLC, PLLC, PC, Corp)
- State registration and licensing requirements for medical practices
- Professional licensing requirements for business entities
- Tax considerations specific to {{state_name}} (franchise tax, state income tax)
- Business license and permit requirements
- Zoning considerations for medical aesthetic practices
- Annual filing and renewal requirements`),
    qualityCriteria: ["entity_types", "registration_url", "tax_info", "licensing_requirements"],
    intentKeywords: ["LLC", "PLLC", "entity", "incorporate", "business formation", "register", "business license", "EIN"],
  },
  {
    category: "marketing_compliance",
    label: "Marketing Compliance",
    scope: "state",
    refreshCadenceDays: 30,
    researchPromptTemplate: statePrompt("Medical Aesthetics Marketing Compliance", `Research:
- {{state_name}} rules on before/after photo advertising for medical procedures
- Testimonial and review solicitation restrictions
- Social media advertising rules for medical practices
- Required disclaimers for aesthetic procedure advertising
- Board of medicine advertising guidelines
- FTC compliance as applied in {{state_name}}
- Restrictions on pricing claims, guarantees, or "best" claims
- Rules on advertising specific brand names (Botox, Juvederm, etc.)
- Recent enforcement actions for marketing violations`),
    qualityCriteria: ["statute_citation", "board_url", "specific_restrictions", "disclaimer_requirements"],
    intentKeywords: ["advertising", "before after photo", "testimonial", "marketing rules", "social media compliance", "disclaimer", "can I advertise"],
    hedgingExemptions: ["varies by state", "consult a healthcare attorney"],
  },
  {
    category: "insurance_malpractice",
    label: "Insurance & Malpractice",
    scope: "state",
    refreshCadenceDays: 45,
    researchPromptTemplate: statePrompt("Insurance & Malpractice Coverage for MedSpas", `Research:
- Required malpractice insurance minimums in {{state_name}} for NPs/PAs
- General liability requirements for medical practices
- Professional liability (errors & omissions) requirements
- Workers' compensation requirements
- Tail coverage considerations
- Common exclusions in medspa policies
- Typical premium ranges for aesthetic practices in {{state_name}}
- Cyber liability and HIPAA breach coverage requirements
- Product liability considerations for injectables and devices`),
    qualityCriteria: ["coverage_minimums", "premium_ranges", "requirement_citations"],
    intentKeywords: ["insurance", "malpractice", "liability", "coverage", "premium", "tail coverage", "workers comp"],
  },

  // ============================================================
  // NATIONAL (9)
  // ============================================================
  {
    category: "osha_safety",
    label: "OSHA & Workplace Safety",
    scope: "national",
    refreshCadenceDays: 30,
    researchPromptTemplate: nationalPrompt("OSHA Compliance for Medical Aesthetic Practices", `Research:
- Bloodborne Pathogens Standard (29 CFR 1910.1030) requirements for medspas
- Sharps disposal and biohazard waste management
- Infection control protocols for aesthetic procedures
- Personal protective equipment (PPE) requirements
- Exposure control plan requirements
- Employee training and recordkeeping obligations
- OSHA inspection process and common citations for medical practices
- Hazard communication for chemicals used in aesthetics (peels, disinfectants)
- Emergency action plan requirements
- Recent OSHA guidance or rule changes affecting healthcare settings`),
    qualityCriteria: ["cfr_citation", "specific_requirements", "training_obligations"],
    intentKeywords: ["OSHA", "bloodborne", "sharps", "infection control", "biohazard", "PPE", "workplace safety", "exposure"],
  },
  {
    category: "hipaa_compliance",
    label: "HIPAA Compliance",
    scope: "national",
    refreshCadenceDays: 30,
    researchPromptTemplate: nationalPrompt("HIPAA Compliance for Medical Aesthetic Practices", `Research:
- HIPAA Privacy Rule requirements for medspas (PHI handling, minimum necessary)
- Security Rule requirements (administrative, physical, technical safeguards)
- Breach notification requirements and timelines
- Business Associate Agreement (BAA) requirements and who needs one
- Patient consent and authorization for photos, marketing, social media
- Telehealth-specific HIPAA considerations
- Employee training requirements and documentation
- Common HIPAA violations in aesthetic practices
- Electronic health record (EHR) compliance requirements
- Social media do's and don'ts with patient information
- Recent HHS enforcement actions and guidance updates`),
    qualityCriteria: ["regulation_citation", "specific_requirements", "penalty_info"],
    intentKeywords: ["HIPAA", "privacy", "PHI", "breach", "BAA", "consent", "patient photos", "security rule"],
  },
  {
    category: "treatment_technology",
    label: "Treatment Technology & Devices",
    scope: "national",
    refreshCadenceDays: 14,
    researchPromptTemplate: nationalPrompt("Latest Aesthetic Treatment Technologies & Devices", `Research the CURRENT state of aesthetic treatment technology (2025-2026):
- New FDA-cleared devices and treatments in the past 12 months
- Emerging technologies in non-surgical aesthetics (exosomes, polynucleotides, skin boosters)
- RF microneedling advances and new devices
- Body contouring technology updates (CoolSculpting Elite, Emsculpt NEO, etc.)
- Laser technology advances (picosecond, fractional, vascular)
- Injectable trends (longer-lasting fillers, biostimulators, toxin developments)
- Regenerative aesthetics (PRP/PRF, stem cells, growth factors)
- Skin analysis and diagnostic technology
- Energy-based device comparison and ROI analysis
- What's gaining traction vs. what's losing relevance`),
    qualityCriteria: ["fda_clearance_status", "clinical_evidence", "device_names", "treatment_specifics"],
    intentKeywords: ["new treatment", "device", "technology", "FDA", "laser", "RF microneedling", "body contouring", "filler", "biostimulator", "exosome"],
  },
  {
    category: "standards_of_care",
    label: "Standards of Care & Protocols",
    scope: "national",
    refreshCadenceDays: 21,
    researchPromptTemplate: nationalPrompt("Standards of Care for Medical Aesthetic Procedures", `Research:
- Current clinical protocols for common aesthetic procedures (neurotoxin injection, dermal fillers, chemical peels, microneedling, laser treatments)
- Safety guidelines and emergency protocols for aesthetic complications
- Complication management (vascular occlusion, allergic reaction, infection, scarring)
- Pre-treatment assessment and contraindication screening
- Post-treatment care protocols and patient instructions
- Documentation standards and medical record requirements
- Informed consent best practices and required elements
- Product storage, handling, and expiration management
- Combination treatment protocols and safety intervals
- Quality assurance and adverse event reporting`),
    qualityCriteria: ["clinical_protocol", "safety_guidelines", "complication_management"],
    intentKeywords: ["protocol", "standard of care", "complication", "emergency", "consent", "contraindication", "adverse event", "safety"],
  },
  {
    category: "hiring_staffing",
    label: "Hiring & Staffing",
    scope: "national",
    refreshCadenceDays: 30,
    researchPromptTemplate: nationalPrompt("Hiring & Staffing for Medical Aesthetic Practices", `Research:
- Current compensation benchmarks for aesthetic practice roles (NP injectors, estheticians, front desk, practice managers) by region
- Credentialing and privileging processes for aesthetic providers
- Onboarding best practices for clinical and non-clinical staff
- Independent contractor vs. employee classification (IRS guidelines, common pitfalls)
- Non-compete and non-solicitation agreements in healthcare
- Performance metrics and KPIs for aesthetic staff
- Training programs and continuing education requirements
- Team structure models for practices at different revenue levels
- Recruitment strategies for aesthetic NPs and estheticians
- Retention and culture-building in small practices`),
    qualityCriteria: ["compensation_data", "legal_requirements", "specific_benchmarks"],
    intentKeywords: ["hire", "staff", "salary", "compensation", "credential", "onboard", "contractor", "employee", "non-compete", "team structure"],
  },
  {
    category: "business_strategy",
    label: "Business Strategy & Scaling",
    scope: "national",
    refreshCadenceDays: 21,
    researchPromptTemplate: nationalPrompt("Business Strategy & Scaling for Medical Aesthetic Practices", `Research:
- Revenue benchmarks by practice size and geography (solo, small group, multi-location)
- Membership and subscription models for aesthetic practices (structure, pricing, retention)
- KPIs every medspa should track (with benchmark ranges)
- Scaling strategies: when to add providers, services, locations
- Exit planning and practice valuation methods for medspas
- Cash flow management in seasonal aesthetics businesses
- Vendor negotiation strategies for injectables and devices
- Equipment financing and leasing best practices
- Strategic partnerships and referral networks
- Current industry M&A trends and valuations`),
    qualityCriteria: ["revenue_benchmarks", "specific_strategies", "industry_data"],
    intentKeywords: ["strategy", "scale", "grow", "membership", "KPI", "benchmark", "valuation", "exit", "cash flow", "vendor"],
  },
  {
    category: "marketing_strategy",
    label: "Marketing Strategy & Patient Acquisition",
    scope: "national",
    refreshCadenceDays: 21,
    researchPromptTemplate: nationalPrompt("Marketing Strategy & Patient Acquisition for MedSpas", `Research current best practices (2025-2026):
- Facebook/Meta advertising strategies for medspas (audience targeting, ad formats, budgets, CPL benchmarks)
- Google Ads and local SEO for aesthetic practices
- Social media content strategy (Instagram, TikTok, YouTube) for practitioners
- Email marketing and patient nurture sequences
- Referral program structures that work
- Google Business Profile optimization for medspas
- Review generation and reputation management
- Website conversion optimization for aesthetic practices
- Patient acquisition cost benchmarks by channel
- Seasonal marketing calendar and promotional strategies
- Content marketing for authority building`),
    qualityCriteria: ["specific_benchmarks", "platform_specifics", "cost_data", "actionable_tactics"],
    intentKeywords: ["marketing", "Facebook ad", "Instagram", "SEO", "Google ad", "patient acquisition", "referral", "reviews", "content marketing", "social media"],
  },
  {
    category: "revenue_optimization",
    label: "Revenue Optimization",
    scope: "national",
    refreshCadenceDays: 30,
    researchPromptTemplate: nationalPrompt("Revenue Optimization for Medical Aesthetic Practices", `Research:
- Treatment packaging and bundling strategies with pricing examples
- Upselling and cross-selling frameworks for aesthetic consultations
- Inventory management and COGS optimization for injectables
- Pricing strategy (premium positioning, value-based pricing, anchor pricing)
- Average revenue per patient benchmarks by service category
- Treatment plan compliance and rebooking strategies
- Gift card and prepaid package programs
- Seasonal promotion strategies and their ROI
- Product retail as a revenue stream (skincare lines, at-home devices)
- Financial metrics: profit margins by service, break-even analysis, contribution margin`),
    qualityCriteria: ["pricing_examples", "margin_data", "specific_strategies"],
    intentKeywords: ["pricing", "package", "bundle", "upsell", "revenue", "profit margin", "inventory", "retail", "gift card", "average ticket"],
  },
  {
    category: "patient_experience",
    label: "Patient Experience & Retention",
    scope: "national",
    refreshCadenceDays: 30,
    researchPromptTemplate: nationalPrompt("Patient Experience & Retention for Aesthetic Practices", `Research:
- Patient intake and consultation process best practices
- Informed consent workflow and documentation
- Patient communication (pre-treatment, post-treatment, follow-up cadence)
- Retention metrics and benchmarks for aesthetic practices
- Loyalty and rewards program structures
- Patient satisfaction measurement (NPS, surveys, review monitoring)
- Handling negative reviews and patient complaints
- Patient education and expectation management
- Rebooking and recall systems that improve retention
- Technology: patient portals, online booking, text reminders
- VIP and membership experience design`),
    qualityCriteria: ["retention_benchmarks", "specific_workflows", "communication_templates"],
    intentKeywords: ["patient experience", "retention", "loyalty", "satisfaction", "intake", "follow up", "rebook", "recall", "complaint", "review response"],
  },
];

// Helpers
export function getStateTopics(): TopicConfig[] {
  return TOPIC_REGISTRY.filter(t => t.scope === "state");
}

export function getNationalTopics(): TopicConfig[] {
  return TOPIC_REGISTRY.filter(t => t.scope === "national");
}

export function getTopicByCategory(category: string): TopicConfig | undefined {
  return TOPIC_REGISTRY.find(t => t.category === category);
}

export function getAllCategories(): string[] {
  return TOPIC_REGISTRY.map(t => t.category);
}
```

- [ ] **Step 2: Verify the module compiles**

```bash
cd C:\Users\derek\Projects\atlas
bun run --bun src/sage-topics.ts 2>&1 | head -5
```

Should not error (module has no side effects, just exports).

- [ ] **Step 3: Commit**

```bash
cd C:\Users\derek\Projects\atlas
git add src/sage-topics.ts
git commit -m "feat: add SAGE topic registry with 15 knowledge categories"
```

---

## Task 5: Research Engine (`sage-research.ts`)

**Files:**
- Create: `C:\Users\derek\Projects\atlas\src\sage-research.ts`

This is the largest module. It contains: direct Anthropic API caller with web search, quality gate, state selection, and the three research track functions.

- [ ] **Step 1: Create sage-research.ts with imports and config**

```typescript
/**
 * S.A.G.E. Research Engine
 *
 * Orchestrates knowledge acquisition through three tracks:
 * 1. State regulatory sweep (daily 10:30 PM)
 * 2. National topic rotation (daily 10:45 PM)
 * 3. Demand-driven research (Sunday 11 PM)
 *
 * Uses direct Anthropic API with web search for factual research.
 * Quality gate via Haiku before database insertion.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { info, warn, error as logError } from "./logger.ts";
import {
  TOPIC_REGISTRY,
  ALL_STATES,
  STATE_NAMES,
  PRIORITY_STATES,
  getStateTopics,
  getNationalTopics,
  getTopicByCategory,
  type TopicConfig,
} from "./sage-topics.ts";
import { MODELS } from "./constants.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const STATE_FILE = join(DATA_DIR, "sage-research-state.json");
const GAP_REPORT_FILE = join(DATA_DIR, "sage-gap-report.json");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const LOG_TAG = "sage-research";
```

- [ ] **Step 2: Add state persistence**

```typescript
// ============================================================
// STATE PERSISTENCE
// ============================================================

interface ResearchState {
  stateLastVerified: Record<string, Record<string, string>>; // state_code -> category -> ISO date
  nationalLastVerified: Record<string, string>;               // category -> ISO date
  stateRoundRobinIndex: number;
  nationalRoundRobinIndex: number;
  totalUpdates: number;
  totalVerified: number;
  totalRejected: number;
  lastRunAt: string | null;
}

async function loadState(): Promise<ResearchState> {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(await readFile(STATE_FILE, "utf-8"));
    }
  } catch {}
  return {
    stateLastVerified: {},
    nationalLastVerified: {},
    stateRoundRobinIndex: 0,
    nationalRoundRobinIndex: 0,
    totalUpdates: 0,
    totalVerified: 0,
    totalRejected: 0,
    lastRunAt: null,
  };
}

async function saveState(state: ResearchState): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}
```

- [ ] **Step 3: Add Anthropic API web search caller**

```typescript
// ============================================================
// ANTHROPIC API WITH WEB SEARCH
// ============================================================

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: any }>;
}

async function runResearchPrompt(prompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05",
    },
    body: JSON.stringify({
      model: MODELS.sonnet,
      max_tokens: 8192,
      tools: [{ type: "web_search_20250305" }],
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000), // 2 min timeout per research call
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic API ${response.status}: ${body.substring(0, 300)}`);
  }

  const data = await response.json();

  // Extract text from content blocks (may include tool_use results)
  const textBlocks = (data.content || [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text);

  return textBlocks.join("\n").trim();
}
```

- [ ] **Step 4: Add quality gate**

```typescript
// ============================================================
// QUALITY GATE
// ============================================================

interface QualityEval {
  score: number;
  has_citations: boolean;
  has_specific_data: boolean;
  content_depth: "thin" | "adequate" | "comprehensive";
  issues: string[];
}

async function evaluateChunkQuality(
  content: string,
  title: string,
  category: string,
  stateCode: string | null,
): Promise<QualityEval> {
  const topicConfig = getTopicByCategory(category);
  const criteria = topicConfig?.qualityCriteria?.join(", ") || "accuracy, specificity, depth";

  const prompt = `You are a fact-checker for a medical aesthetics knowledge base.
Evaluate this content chunk for quality.

Category: ${category}
Scope: ${stateCode ? `State (${stateCode})` : "National"}
Quality criteria to check: ${criteria}

Title: ${title}
Content:
${content}

Score 0-1 on:
1. Source citations (statute numbers, board URLs, org references)
2. Specificity (concrete numbers, dates, requirements vs vague guidance)
3. Depth (covers the topic thoroughly vs surface-level)
4. Accuracy signals (consistent terminology, plausible requirements)

Return ONLY valid JSON:
{"score":0.0,"has_citations":false,"has_specific_data":false,"content_depth":"thin","issues":["issue1"]}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODELS.haiku,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) throw new Error(`Haiku ${response.status}`);

    const data = await response.json();
    const text = (data.content || []).find((b: any) => b.type === "text")?.text || "";
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    warn(LOG_TAG, `Quality gate error for ${category}/${stateCode || "national"}: ${err}`);
    return { score: 0.5, has_citations: false, has_specific_data: false, content_depth: "adequate", issues: ["quality gate error"] };
  }
}
```

- [ ] **Step 5: Add embedding and upsert functions**

```typescript
// ============================================================
// EMBEDDING & UPSERT
// ============================================================

async function embedText(text: string): Promise<number[]> {
  const url = `${SUPABASE_URL}/functions/v1/embed`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ text: text.substring(0, 2000) }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Embed failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.embedding;
}

interface ChunkInput {
  stateCode: string | null;
  category: string;
  title: string;
  content: string;
  sourceName: string | null;
  sourceUrl: string | null;
  scope: "state" | "national";
  qualityScore: number;
  flagged: boolean;
  refreshCadenceDays: number;
}

async function upsertChunk(chunk: ChunkInput): Promise<{ action: "updated" | "verified" | "rejected" }> {
  const contentHash = createHash("sha256").update(chunk.content).digest("hex");

  // Check if identical content already exists
  const checkUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge?category=eq.${chunk.category}&chunk_hash=eq.${contentHash}${chunk.stateCode ? `&state_code=eq.${chunk.stateCode}` : "&state_code=is.null"}&select=id`;
  const checkRes = await fetch(checkUrl, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  const existing = await checkRes.json();

  if (Array.isArray(existing) && existing.length > 0) {
    // Content unchanged, just update last_verified_at
    const updateUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge?id=eq.${existing[0].id}`;
    await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ last_verified_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
    return { action: "verified" };
  }

  // New or changed content. Generate embedding.
  const embeddingInput = `${chunk.title}\n${chunk.content.substring(0, 1800)}`;
  const embedding = await embedText(embeddingInput);

  const row = {
    state_code: chunk.stateCode,
    category: chunk.category,
    title: chunk.title,
    content: chunk.content,
    source_url: chunk.sourceUrl,
    source_name: chunk.sourceName,
    embedding: JSON.stringify(embedding),
    chunk_hash: contentHash,
    scope: chunk.scope,
    quality_score: chunk.qualityScore,
    demand_score: 0,
    source_count: (chunk.sourceUrl ? 1 : 0),
    flagged: chunk.flagged,
    refresh_cadence_days: chunk.refreshCadenceDays,
    last_verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const upsertUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge`;
  const res = await fetch(upsertUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Upsert failed: ${res.status} ${await res.text()}`);
  return { action: "updated" };
}
```

- [ ] **Step 6: Add research pipeline (per-topic research + parse + quality gate + upsert)**

```typescript
// ============================================================
// RESEARCH PIPELINE
// ============================================================

interface ResearchResult {
  chunksUpdated: number;
  chunksVerified: number;
  chunksRejected: number;
  errors: string[];
}

async function researchTopic(
  topicConfig: TopicConfig,
  stateCode: string | null,
): Promise<ResearchResult> {
  const result: ResearchResult = { chunksUpdated: 0, chunksVerified: 0, chunksRejected: 0, errors: [] };
  const label = stateCode ? `${stateCode}/${topicConfig.category}` : `national/${topicConfig.category}`;

  try {
    // Build prompt from template
    let prompt = topicConfig.researchPromptTemplate;
    if (stateCode) {
      const stateName = STATE_NAMES[stateCode] || stateCode;
      prompt = prompt.replace(/\{\{state_name\}\}/g, stateName).replace(/\{\{state_code\}\}/g, stateCode);
    }

    info(LOG_TAG, `Researching: ${label}`);
    const output = await runResearchPrompt(prompt);

    // Parse JSON response
    let parsed: any;
    try {
      const cleaned = output.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      result.errors.push(`${label}: JSON parse failed`);
      warn(LOG_TAG, `${label} parse error: ${parseErr}`);
      return result;
    }

    const chunks = parsed.chunks || [];
    if (!Array.isArray(chunks) || chunks.length === 0) {
      result.errors.push(`${label}: No chunks in output`);
      return result;
    }

    // Process each chunk through quality gate and upsert
    for (const chunk of chunks) {
      try {
        const quality = await evaluateChunkQuality(
          chunk.content || "",
          chunk.title || "",
          topicConfig.category,
          stateCode,
        );

        if (quality.score < 0.4) {
          result.chunksRejected++;
          warn(LOG_TAG, `  Rejected: ${label} "${chunk.title}" (score ${quality.score.toFixed(2)}: ${quality.issues.join(", ")})`);
          continue;
        }

        const { action } = await upsertChunk({
          stateCode,
          category: topicConfig.category,
          title: chunk.title || `${topicConfig.label} - ${stateCode || "National"}`,
          content: chunk.content,
          sourceName: chunk.source_name || null,
          sourceUrl: chunk.source_url || null,
          scope: topicConfig.scope,
          qualityScore: quality.score,
          flagged: quality.score < 0.7,
          refreshCadenceDays: topicConfig.refreshCadenceDays,
        });

        if (action === "updated") {
          result.chunksUpdated++;
          info(LOG_TAG, `  Updated: ${label} "${chunk.title}" (quality ${quality.score.toFixed(2)})`);
        } else {
          result.chunksVerified++;
        }
      } catch (chunkErr) {
        result.errors.push(`${label}/${chunk.title}: ${chunkErr}`);
        warn(LOG_TAG, `  Chunk error: ${chunkErr}`);
      }
    }
  } catch (err) {
    result.errors.push(`${label}: ${err}`);
    logError(LOG_TAG, `Error researching ${label}: ${err}`);
  }

  return result;
}
```

- [ ] **Step 7: Add state selection logic**

```typescript
// ============================================================
// STATE SELECTION
// ============================================================

function pickStatesForTonight(state: ResearchState, count: number = 3): string[] {
  const now = Date.now();
  const selected: string[] = [];

  // 1. Check gap report for states needing research
  try {
    if (existsSync(GAP_REPORT_FILE)) {
      const gaps = JSON.parse(readFileSync(GAP_REPORT_FILE, "utf-8"));
      const stateGaps = (gaps.gaps || [])
        .filter((g: any) => g.state_code && g.research_priority <= 2)
        .map((g: any) => g.state_code);

      for (const code of stateGaps) {
        if (selected.length >= count) break;
        if (!selected.includes(code)) selected.push(code);
      }
    }
  } catch {}

  // 2. Priority states not verified in 14 days
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
  for (const code of PRIORITY_STATES) {
    if (selected.length >= count) break;
    if (selected.includes(code)) continue;

    const stateVerified = state.stateLastVerified[code] || {};
    const oldestVerification = Object.values(stateVerified)
      .map(d => new Date(d).getTime())
      .sort()[0] || 0;

    if (oldestVerification < fourteenDaysAgo) {
      selected.push(code);
    }
  }

  // 3. Round-robin remaining states
  const nonPriority = ALL_STATES.filter(s => !PRIORITY_STATES.includes(s));
  let idx = state.stateRoundRobinIndex % nonPriority.length;

  while (selected.length < count) {
    const candidate = nonPriority[idx];
    if (!selected.includes(candidate)) {
      selected.push(candidate);
    }
    idx = (idx + 1) % nonPriority.length;
  }

  state.stateRoundRobinIndex = idx;
  return selected;
}

function pickNationalTopicsForTonight(state: ResearchState, count: number = 3): TopicConfig[] {
  const nationalTopics = getNationalTopics();
  const now = Date.now();
  const selected: TopicConfig[] = [];

  // Topics past their refresh cadence go first
  const stale = nationalTopics.filter(t => {
    const lastVerified = state.nationalLastVerified[t.category];
    if (!lastVerified) return true;
    const age = now - new Date(lastVerified).getTime();
    return age > t.refreshCadenceDays * 24 * 60 * 60 * 1000;
  });

  for (const topic of stale) {
    if (selected.length >= count) break;
    selected.push(topic);
  }

  // Round-robin remaining
  let idx = state.nationalRoundRobinIndex % nationalTopics.length;
  while (selected.length < count) {
    const candidate = nationalTopics[idx];
    if (!selected.find(s => s.category === candidate.category)) {
      selected.push(candidate);
    }
    idx = (idx + 1) % nationalTopics.length;
  }

  state.nationalRoundRobinIndex = idx;
  return selected;
}
```

- [ ] **Step 8: Add the three track functions**

```typescript
// ============================================================
// TRACK 1: STATE REGULATORY SWEEP
// ============================================================

export interface SweepResult {
  statesProcessed: string[];
  topicsResearched: number;
  chunksUpdated: number;
  chunksVerified: number;
  chunksRejected: number;
  errors: string[];
}

export async function runStateSweep(): Promise<SweepResult> {
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statesProcessed: [], topicsResearched: 0, chunksUpdated: 0, chunksVerified: 0, chunksRejected: 0, errors: ["Missing env vars"] };
  }

  const state = await loadState();
  const states = pickStatesForTonight(state, 3);
  const stateTopics = getStateTopics();

  info(LOG_TAG, `State sweep: ${states.join(", ")} (${stateTopics.length} topics each)`);

  const result: SweepResult = {
    statesProcessed: [],
    topicsResearched: 0,
    chunksUpdated: 0,
    chunksVerified: 0,
    chunksRejected: 0,
    errors: [],
  };

  for (const stateCode of states) {
    for (const topic of stateTopics) {
      // Rate limit: 2s delay between API calls to avoid hitting Anthropic rate limits
      await new Promise(r => setTimeout(r, 2000));
      const res = await researchTopic(topic, stateCode);
      result.topicsResearched++;
      result.chunksUpdated += res.chunksUpdated;
      result.chunksVerified += res.chunksVerified;
      result.chunksRejected += res.chunksRejected;
      result.errors.push(...res.errors);

      // Track verification
      if (!state.stateLastVerified[stateCode]) state.stateLastVerified[stateCode] = {};
      state.stateLastVerified[stateCode][topic.category] = new Date().toISOString();
    }
    result.statesProcessed.push(stateCode);
  }

  state.totalUpdates += result.chunksUpdated;
  state.totalVerified += result.chunksVerified;
  state.totalRejected += result.chunksRejected;
  state.lastRunAt = new Date().toISOString();
  await saveState(state);

  info(LOG_TAG, `State sweep done: ${result.statesProcessed.length} states, ${result.chunksUpdated} updated, ${result.chunksVerified} verified, ${result.chunksRejected} rejected`);
  return result;
}

// ============================================================
// TRACK 2: NATIONAL TOPIC ROTATION
// ============================================================

export async function runNationalSweep(): Promise<SweepResult> {
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statesProcessed: [], topicsResearched: 0, chunksUpdated: 0, chunksVerified: 0, chunksRejected: 0, errors: ["Missing env vars"] };
  }

  const state = await loadState();
  const topics = pickNationalTopicsForTonight(state, 3);

  info(LOG_TAG, `National sweep: ${topics.map(t => t.category).join(", ")}`);

  const result: SweepResult = {
    statesProcessed: [],
    topicsResearched: 0,
    chunksUpdated: 0,
    chunksVerified: 0,
    chunksRejected: 0,
    errors: [],
  };

  for (const topic of topics) {
    const res = await researchTopic(topic, null);
    result.topicsResearched++;
    result.chunksUpdated += res.chunksUpdated;
    result.chunksVerified += res.chunksVerified;
    result.chunksRejected += res.chunksRejected;
    result.errors.push(...res.errors);

    state.nationalLastVerified[topic.category] = new Date().toISOString();
  }

  state.totalUpdates += result.chunksUpdated;
  state.totalVerified += result.chunksVerified;
  state.totalRejected += result.chunksRejected;
  state.lastRunAt = new Date().toISOString();
  await saveState(state);

  info(LOG_TAG, `National sweep done: ${result.topicsResearched} topics, ${result.chunksUpdated} updated, ${result.chunksVerified} verified, ${result.chunksRejected} rejected`);
  return result;
}

// ============================================================
// TRACK 3: DEMAND-DRIVEN RESEARCH
// ============================================================

export async function runDemandResearch(): Promise<SweepResult> {
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { statesProcessed: [], topicsResearched: 0, chunksUpdated: 0, chunksVerified: 0, chunksRejected: 0, errors: ["Missing env vars"] };
  }

  const result: SweepResult = {
    statesProcessed: [],
    topicsResearched: 0,
    chunksUpdated: 0,
    chunksVerified: 0,
    chunksRejected: 0,
    errors: [],
  };

  // Read gap report
  if (!existsSync(GAP_REPORT_FILE)) {
    info(LOG_TAG, "No gap report found, skipping demand research");
    return result;
  }

  let gaps: any;
  try {
    gaps = JSON.parse(await readFile(GAP_REPORT_FILE, "utf-8"));
  } catch {
    info(LOG_TAG, "Could not parse gap report");
    return result;
  }

  const priorityGaps = (gaps.gaps || [])
    .filter((g: any) => g.research_priority <= 2)
    .sort((a: any, b: any) => a.research_priority - b.research_priority)
    .slice(0, 5); // Max 5 gaps per session

  info(LOG_TAG, `Demand research: ${priorityGaps.length} priority gaps`);

  for (const gap of priorityGaps) {
    const topicConfig = getTopicByCategory(gap.category);
    if (!topicConfig) {
      result.errors.push(`Unknown category: ${gap.category}`);
      continue;
    }

    const res = await researchTopic(topicConfig, gap.state_code || null);
    result.topicsResearched++;
    result.chunksUpdated += res.chunksUpdated;
    result.chunksVerified += res.chunksVerified;
    result.chunksRejected += res.chunksRejected;
    result.errors.push(...res.errors);

    if (gap.state_code) result.statesProcessed.push(gap.state_code);

    // Mark gap as researched in Supabase
    try {
      const updateUrl = `${SUPABASE_URL}/rest/v1/sage_question_trends?id=eq.${gap.id}`;
      await fetch(updateUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ researched_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {}
  }

  const state = await loadState();
  state.totalUpdates += result.chunksUpdated;
  state.totalVerified += result.chunksVerified;
  state.totalRejected += result.chunksRejected;
  state.lastRunAt = new Date().toISOString();
  await saveState(state);

  info(LOG_TAG, `Demand research done: ${result.topicsResearched} topics, ${result.chunksUpdated} updated, ${result.chunksRejected} rejected`);
  return result;
}
```

- [ ] **Step 9: Add status reporting function**

```typescript
// ============================================================
// STATUS REPORTING (for morning brief)
// ============================================================

export async function getResearchStatus(): Promise<string> {
  const state = await loadState();
  const stateCount = Object.keys(state.stateLastVerified).length;
  const nationalCount = Object.keys(state.nationalLastVerified).length;
  const totalNational = getNationalTopics().length;

  const lines = [
    `SAGE KB: ${stateCount}/50 states, ${nationalCount}/${totalNational} national topics`,
    `Totals: ${state.totalUpdates} updated, ${state.totalVerified} verified, ${state.totalRejected} rejected`,
  ];

  if (state.lastRunAt) {
    const ago = Math.round((Date.now() - new Date(state.lastRunAt).getTime()) / 3600000);
    lines.push(`Last run: ${ago}h ago`);
  }

  // Check for stale states (>30 days)
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const staleStates: string[] = [];
  for (const [code, categories] of Object.entries(state.stateLastVerified)) {
    const oldest = Math.min(...Object.values(categories).map(d => new Date(d).getTime()));
    if (oldest < thirtyDaysAgo) staleStates.push(code);
  }

  if (staleStates.length > 0) {
    lines.push(`Stale (>30d): ${staleStates.join(", ")}`);
  }

  // Check for flagged chunks
  try {
    const flaggedUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge?flagged=eq.true&select=id`;
    const res = await fetch(flaggedUrl, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    const flagged = await res.json();
    if (Array.isArray(flagged) && flagged.length > 0) {
      lines.push(`Flagged chunks (review needed): ${flagged.length}`);
    }
  } catch {}

  return lines.join("\n");
}
```

- [ ] **Step 10: Verify module compiles**

```bash
cd C:\Users\derek\Projects\atlas
bun check src/sage-research.ts 2>&1 || bun build --no-bundle src/sage-research.ts 2>&1 | head -20
```

Fix any type errors.

- [ ] **Step 11: Commit**

```bash
cd C:\Users\derek\Projects\atlas
git add src/sage-research.ts
git commit -m "feat: add SAGE research engine with 3 tracks, quality gate, web search"
```

---

## Task 6: Conversation Analyzer (`sage-analyzer.ts`)

**Files:**
- Create: `C:\Users\derek\Projects\atlas\src\sage-analyzer.ts`

- [ ] **Step 1: Create sage-analyzer.ts**

```typescript
/**
 * S.A.G.E. Conversation Analyzer
 *
 * Weekly batch job (Sunday 8 PM) that mines user conversations
 * from maa_conversations to identify knowledge gaps and trends.
 *
 * Pipeline:
 * 1. Pull week's conversations from Supabase
 * 2. Classify by category (keyword-first, Haiku fallback)
 * 3. Score answer quality (heuristic-based)
 * 4. Aggregate into trends
 * 5. Detect gaps and prioritize
 * 6. Write to sage_question_trends + gap report
 */

import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { info, warn, error as logError } from "./logger.ts";
import { TOPIC_REGISTRY, getTopicByCategory, getAllCategories, type TopicConfig } from "./sage-topics.ts";
import { MODELS } from "./constants.ts";

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DATA_DIR = join(PROJECT_DIR, "data");
const GAP_REPORT_FILE = join(DATA_DIR, "sage-gap-report.json");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const LOG_TAG = "sage-analyzer";

// ============================================================
// CATEGORY CLASSIFICATION (keyword-first)
// ============================================================

function classifyByKeywords(message: string): string | null {
  const lower = message.toLowerCase();

  for (const topic of TOPIC_REGISTRY) {
    for (const keyword of topic.intentKeywords) {
      if (lower.includes(keyword.toLowerCase())) {
        return topic.category;
      }
    }
  }

  return null;
}

async function classifyBatchWithHaiku(messages: string[]): Promise<Record<number, string>> {
  if (messages.length === 0 || !ANTHROPIC_API_KEY) return {};

  const categories = getAllCategories();
  const numbered = messages.map((m, i) => `[${i}] ${m.substring(0, 200)}`).join("\n");

  const prompt = `Classify each numbered message into one of these categories for a medical aesthetics practice advisor:
${categories.join(", ")}

If a message doesn't fit any category, use "uncategorized".

Messages:
${numbered}

Return ONLY valid JSON mapping index to category:
{"0":"scope_of_practice","1":"marketing_strategy","2":"uncategorized"}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODELS.haiku,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) throw new Error(`Haiku ${response.status}`);

    const data = await response.json();
    const text = (data.content || []).find((b: any) => b.type === "text")?.text || "";
    const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const result: Record<number, string> = {};
    for (const [key, val] of Object.entries(parsed)) {
      result[parseInt(key)] = val as string;
    }
    return result;
  } catch (err) {
    warn(LOG_TAG, `Haiku classification error: ${err}`);
    return {};
  }
}

// ============================================================
// ANSWER QUALITY SCORING (heuristic-based)
// ============================================================

const HEDGING_PHRASES = [
  "i'm not entirely sure",
  "i'm not sure",
  "i don't have specific",
  "i cannot confirm",
  "i don't have current",
  "i'm unable to",
  "i would need to",
  "i cannot provide specific",
];

function scoreAnswerQuality(
  assistantResponse: string,
  userFollowedUp: boolean,
  category: string,
): number {
  let score = 0.5;
  const lower = assistantResponse.toLowerCase();
  const topicConfig = getTopicByCategory(category);
  const exemptions = topicConfig?.hedgingExemptions || [];

  // Check hedging (skip exempted phrases for regulatory categories)
  for (const phrase of HEDGING_PHRASES) {
    if (lower.includes(phrase)) {
      const isExempted = exemptions.some(ex => lower.includes(ex.toLowerCase()));
      if (!isExempted) {
        score -= 0.3;
        break;
      }
    }
  }

  // Follow-up penalty
  if (userFollowedUp) score -= 0.2;

  // Citation boost
  if (/\b(sec\.|section|§|statute|rule|cfr|usc)\b/i.test(assistantResponse) ||
      /https?:\/\/\S+/.test(assistantResponse) ||
      /according to/i.test(assistantResponse)) {
    score += 0.2;
  }

  // Specificity boost
  if (/\$[\d,]+|\d+%|\b\d{4}\b/.test(assistantResponse)) {
    score += 0.1;
  }

  // Short response penalty
  if (assistantResponse.split(/\s+/).length < 100 && assistantResponse.length > 20) {
    score -= 0.1;
  }

  return Math.max(0, Math.min(1, score));
}

// ============================================================
// MAIN ANALYZER
// ============================================================

interface ConversationRow {
  user_id: number;
  session_id: string;
  role: string;
  content: string;
  intent: string[] | null;
  created_at: string;
}

interface TrendBucket {
  category: string;
  stateCode: string | null;
  questionCount: number;
  sampleQuestions: string[];
  qualityScores: number[];
}

export interface AnalyzerResult {
  conversationsAnalyzed: number;
  questionsClassified: number;
  gapsDetected: number;
  trendsWritten: number;
  errors: string[];
}

export async function runAnalyzer(): Promise<AnalyzerResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { conversationsAnalyzed: 0, questionsClassified: 0, gapsDetected: 0, trendsWritten: 0, errors: ["Missing env vars"] };
  }

  const result: AnalyzerResult = {
    conversationsAnalyzed: 0,
    questionsClassified: 0,
    gapsDetected: 0,
    trendsWritten: 0,
    errors: [],
  };

  // 1. Pull conversations from past 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/maa_conversations?created_at=gte.${weekAgo}&order=user_id,session_id,created_at&select=user_id,session_id,role,content,intent,created_at`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    result.errors.push(`Failed to fetch conversations: ${res.status}`);
    return result;
  }

  const rows: ConversationRow[] = await res.json();
  if (rows.length === 0) {
    info(LOG_TAG, "No conversations in past 7 days");
    return result;
  }

  // 2. Group into sessions and extract user/assistant pairs
  const sessions = new Map<string, ConversationRow[]>();
  for (const row of rows) {
    const key = `${row.user_id}:${row.session_id}`;
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key)!.push(row);
  }

  result.conversationsAnalyzed = sessions.size;

  // 3. Classify each user message and score each assistant response
  const buckets = new Map<string, TrendBucket>();
  const unclassified: { index: number; content: string }[] = [];
  const allUserMessages: { content: string; sessionKey: string; index: number }[] = [];

  for (const [sessionKey, messages] of sessions) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "user") continue;

      const category = classifyByKeywords(msg.content);
      const userFollowedUp = messages.slice(i + 2).some(m => m.role === "user");
      const assistantResponse = messages[i + 1]?.role === "assistant" ? messages[i + 1].content : "";

      if (category) {
        addToBucket(buckets, category, null, msg.content, assistantResponse, userFollowedUp);
        result.questionsClassified++;
      } else {
        unclassified.push({ index: allUserMessages.length, content: msg.content });
      }

      allUserMessages.push({ content: msg.content, sessionKey, index: i });
    }
  }

  // Batch classify unclassified messages with Haiku
  if (unclassified.length > 0) {
    const classifications = await classifyBatchWithHaiku(unclassified.map(u => u.content));
    for (const item of unclassified) {
      const category = classifications[unclassified.indexOf(item)];
      if (category && category !== "uncategorized") {
        addToBucket(buckets, category, null, item.content, "", false);
        result.questionsClassified++;
      }
    }
  }

  info(LOG_TAG, `Classified ${result.questionsClassified} questions into ${buckets.size} buckets`);

  // 4. Detect gaps and write trends
  const weekStart = getWeekStart();
  const gaps: any[] = [];

  for (const [key, bucket] of buckets) {
    const avgQuality = bucket.qualityScores.length > 0
      ? bucket.qualityScores.reduce((a, b) => a + b, 0) / bucket.qualityScores.length
      : 0.5;

    const hasKnowledge = await checkKnowledgeExists(bucket.category, bucket.stateCode);
    let gapDetected = false;
    let priority = 3;
    let gapDescription = "";

    if (avgQuality < 0.5 && bucket.questionCount >= 3) {
      gapDetected = true;
      gapDescription = `Consistently weak answers (avg quality ${avgQuality.toFixed(2)})`;
      priority = bucket.questionCount >= 10 && avgQuality < 0.4 ? 1 : 2;
    } else if (bucket.questionCount >= 5 && !hasKnowledge) {
      gapDetected = true;
      gapDescription = `No knowledge chunks exist for this category${bucket.stateCode ? ` in ${bucket.stateCode}` : ""}`;
      priority = 2;
    }

    if (gapDetected) {
      result.gapsDetected++;
      gaps.push({
        category: bucket.category,
        state_code: bucket.stateCode,
        question_count: bucket.questionCount,
        avg_answer_quality: avgQuality,
        gap_description: gapDescription,
        research_priority: priority,
        sample_questions: bucket.sampleQuestions.slice(0, 5),
      });
    }

    // Write trend to Supabase
    try {
      const trendRow = {
        week_start: weekStart,
        category: bucket.category,
        state_code: bucket.stateCode,
        question_count: bucket.questionCount,
        sample_questions: bucket.sampleQuestions.slice(0, 5),
        avg_answer_quality: avgQuality,
        knowledge_gap_detected: gapDetected,
        gap_description: gapDescription || null,
        research_priority: gapDetected ? priority : null,
      };

      await fetch(`${SUPABASE_URL}/rest/v1/sage_question_trends`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(trendRow),
        signal: AbortSignal.timeout(10_000),
      });
      result.trendsWritten++;
    } catch (err) {
      result.errors.push(`Trend write error: ${err}`);
    }
  }

  // Update demand_score on maa_knowledge for popular categories
  for (const [key, bucket] of buckets) {
    if (bucket.questionCount >= 3) {
      try {
        const demandUrl = `${SUPABASE_URL}/rest/v1/maa_knowledge?category=eq.${bucket.category}${bucket.stateCode ? `&state_code=eq.${bucket.stateCode}` : ""}&select=id,demand_score`;
        const demandRes = await fetch(demandUrl, {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          signal: AbortSignal.timeout(10_000),
        });
        const chunks = await demandRes.json();
        for (const chunk of (chunks || [])) {
          const newScore = Math.min((chunk.demand_score || 0) + bucket.questionCount * 0.1, 10);
          await fetch(`${SUPABASE_URL}/rest/v1/maa_knowledge?id=eq.${chunk.id}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify({ demand_score: newScore }),
            signal: AbortSignal.timeout(10_000),
          });
        }
      } catch {}
    }
  }

  // Write gap report for demand research track
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(GAP_REPORT_FILE, JSON.stringify({
    generated: new Date().toISOString(),
    weekStart,
    conversationsAnalyzed: result.conversationsAnalyzed,
    questionsClassified: result.questionsClassified,
    gaps: gaps.sort((a, b) => a.research_priority - b.research_priority),
  }, null, 2));

  info(LOG_TAG, `Analyzer done: ${result.conversationsAnalyzed} sessions, ${result.questionsClassified} classified, ${result.gapsDetected} gaps`);
  return result;
}

// ============================================================
// HELPERS
// ============================================================

function addToBucket(
  buckets: Map<string, TrendBucket>,
  category: string,
  stateCode: string | null,
  userMessage: string,
  assistantResponse: string,
  userFollowedUp: boolean,
): void {
  const key = `${category}:${stateCode || "national"}`;

  if (!buckets.has(key)) {
    buckets.set(key, {
      category,
      stateCode,
      questionCount: 0,
      sampleQuestions: [],
      qualityScores: [],
    });
  }

  const bucket = buckets.get(key)!;
  bucket.questionCount++;
  if (bucket.sampleQuestions.length < 5) {
    bucket.sampleQuestions.push(userMessage.substring(0, 200));
  }
  if (assistantResponse) {
    bucket.qualityScores.push(scoreAnswerQuality(assistantResponse, userFollowedUp, category));
  }
}

async function checkKnowledgeExists(category: string, stateCode: string | null): Promise<boolean> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/maa_knowledge?category=eq.${category}${stateCode ? `&state_code=eq.${stateCode}` : ""}&select=id&limit=1`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    const data = await res.json();
    return Array.isArray(data) && data.length > 0;
  } catch {
    return true; // Assume exists on error to avoid false gap detection
  }
}

function getWeekStart(): string {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  return weekStart.toISOString().split("T")[0];
}
```

- [ ] **Step 2: Verify module compiles**

```bash
cd C:\Users\derek\Projects\atlas
bun build --no-bundle src/sage-analyzer.ts 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
cd C:\Users\derek\Projects\atlas
git add src/sage-analyzer.ts
git commit -m "feat: add SAGE conversation analyzer with gap detection"
```

---

## Task 7: Wire Cron Jobs

**Files:**
- Modify: `C:\Users\derek\Projects\atlas\src\cron.ts`
- Modify: `C:\Users\derek\Projects\atlas\src\night-shift.ts`

- [ ] **Step 1: Add job timeouts to JOB_TIMEOUTS_MS in cron.ts**

Find the `JOB_TIMEOUTS_MS` object (around line 100) and add:

```typescript
  "sage-state-sweep": 15 * 60 * 1000,   // 15 min — 3 states x 6 topics
  "sage-national-sweep": 10 * 60 * 1000, // 10 min — 3 national topics
  "sage-analyzer":  5 * 60 * 1000,       //  5 min — mostly DB queries + small Haiku batch
  "sage-demand-research": 15 * 60 * 1000,// 15 min — up to 5 priority gap deep-dives
```

- [ ] **Step 2: Add imports to cron.ts**

Near the top of cron.ts, alongside the existing maa-blog import:

```typescript
import { runStateSweep, runNationalSweep, runDemandResearch, getResearchStatus } from "./sage-research.ts";
import { runAnalyzer } from "./sage-analyzer.ts";
```

Remove the maa-scraper import:

```typescript
// DELETE this line:
// import { runMaaScraper } from "./maa-scraper.ts";
```

- [ ] **Step 3: Add the 4 new cron jobs**

Find the MAA Blog section in cron.ts (around line 2346). After the maa-blog job, add:

```typescript
  // ============================================================
  // S.A.G.E. KNOWLEDGE ENGINE
  // ============================================================

  // Track 1: State regulatory sweep - 2-3 states x 6 topics each night
  jobs.push(
    CronJob.from({
      cronTime: "30 22 * * *", // Daily 10:30 PM MST
      onTick: safeTick("sage-state-sweep", async () => {
        log("sage-state-sweep", "Starting nightly state regulatory sweep...");
        const result = await runStateSweep();
        const summary = `SAGE State Sweep: ${result.statesProcessed.join(", ")} | ${result.chunksUpdated} updated, ${result.chunksVerified} verified, ${result.chunksRejected} rejected${result.errors.length > 0 ? ` | ${result.errors.length} errors` : ""}`;
        await sendTelegramMessage(DEREK_CHAT_ID, summary);
        log("sage-state-sweep", summary);
      }),
      timeZone: TIMEZONE,
    })
  );

  // Track 2: National topic rotation - 2-3 national topics each night
  jobs.push(
    CronJob.from({
      cronTime: "45 22 * * *", // Daily 10:45 PM MST
      onTick: safeTick("sage-national-sweep", async () => {
        log("sage-national-sweep", "Starting nightly national topic rotation...");
        const result = await runNationalSweep();
        const summary = `SAGE National Sweep: ${result.topicsResearched} topics | ${result.chunksUpdated} updated, ${result.chunksRejected} rejected`;
        await sendTelegramMessage(DEREK_CHAT_ID, summary);
        log("sage-national-sweep", summary);
      }),
      timeZone: TIMEZONE,
    })
  );

  // Weekly analyzer - mines conversations for knowledge gaps
  jobs.push(
    CronJob.from({
      cronTime: "0 20 * * 0", // Sunday 8 PM MST
      onTick: safeTick("sage-analyzer", async () => {
        log("sage-analyzer", "Starting weekly conversation analysis...");
        const result = await runAnalyzer();
        const summary = `SAGE Analyzer: ${result.conversationsAnalyzed} sessions, ${result.questionsClassified} classified, ${result.gapsDetected} gaps found`;
        await sendTelegramMessage(DEREK_CHAT_ID, summary);
        log("sage-analyzer", summary);
      }),
      timeZone: TIMEZONE,
    })
  );

  // Track 3: Demand-driven research - fills gaps found by analyzer
  jobs.push(
    CronJob.from({
      cronTime: "0 23 * * 0", // Sunday 11 PM MST
      onTick: safeTick("sage-demand-research", async () => {
        log("sage-demand-research", "Starting demand-driven research...");
        const result = await runDemandResearch();
        if (result.topicsResearched > 0) {
          const summary = `SAGE Demand Research: ${result.topicsResearched} gaps researched | ${result.chunksUpdated} updated, ${result.chunksRejected} rejected`;
          await sendTelegramMessage(DEREK_CHAT_ID, summary);
          log("sage-demand-research", summary);
        } else {
          log("sage-demand-research", "No gaps to research tonight");
        }
      }),
      timeZone: TIMEZONE,
    })
  );
```

- [ ] **Step 4: Remove maa-scrape from night-shift.ts**

In `src/night-shift.ts`:

1. Remove the import: `import { runMaaScraper } from "./maa-scraper.ts";`
2. Remove `"maa-scrape"` from the `NightShiftTaskType` union type
3. Remove the `if (task.type === "maa-scrape")` block in the worker function
4. Remove the maa-scrape instruction from the planner prompt

- [ ] **Step 5: Update getScraperStatus references**

Search for any imports of `getScraperStatus` from `maa-scraper.ts` and replace with `getResearchStatus` from `sage-research.ts`:

```bash
cd C:\Users\derek\Projects\atlas
grep -rn "getScraperStatus\|maa-scraper" src/ --include="*.ts" | grep -v "node_modules"
```

Update each reference found.

- [ ] **Step 6: Delete maa-scraper.ts**

```bash
cd C:\Users\derek\Projects\atlas
git rm src/maa-scraper.ts
```

- [ ] **Step 7: Verify Atlas compiles**

```bash
cd C:\Users\derek\Projects\atlas
bun build --no-bundle src/cron.ts 2>&1 | head -20
```

Fix any import or type errors.

- [ ] **Step 8: Update capability-registry.ts**

Per project rules, any cron/integration module changes must update `src/capability-registry.ts`. Find the existing MAA scraper entry (if any) and replace with the SAGE Knowledge Engine capabilities. Add entries describing:
- `sage-state-sweep`: Daily state regulatory research (10:30 PM)
- `sage-national-sweep`: Daily national topic rotation (10:45 PM)
- `sage-analyzer`: Weekly conversation analysis (Sunday 8 PM)
- `sage-demand-research`: Weekly gap-driven research (Sunday 11 PM)

```bash
cd C:\Users\derek\Projects\atlas
grep -n "maa.scraper\|maa-scrape\|getScraperStatus" src/capability-registry.ts
```

Update or add the SAGE entries.

- [ ] **Step 9: Commit**

```bash
cd C:\Users\derek\Projects\atlas
git add src/cron.ts src/night-shift.ts src/sage-research.ts src/sage-analyzer.ts src/sage-topics.ts src/capability-registry.ts
git rm src/maa-scraper.ts
git commit -m "feat: wire SAGE knowledge engine crons, remove old maa-scraper"
```

---

## Task 8: Integration Test & Deploy

**Files:**
- No new files. Testing and deployment of all prior tasks.

- [ ] **Step 1: Run maa-advisor tests**

```bash
cd C:\Users\derek\Projects\maa-advisor\worker
npx tsc --noEmit && npx vitest run
```

All 44 tests should pass. Fix any failures from the topic->category rename.

- [ ] **Step 2: Deploy maa-advisor to staging**

```bash
cd C:\Users\derek\Projects\maa-advisor
git checkout dev
git merge main  # or merge your feature branch
git push origin dev
```

CI deploys to staging automatically. Verify the staging worker health endpoint:

```bash
curl https://maa-advisor-api-staging.theoffice-13d.workers.dev/health
```

- [ ] **Step 3: Smoke test the RAG upgrade**

```bash
curl -X POST "${SUPABASE_URL}/functions/v1/maa-search" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"query":"OSHA compliance for medspa","categories":["osha_safety"],"match_count":5}'
```

May return empty results until the research engine populates data. That's fine.

- [ ] **Step 4: Manually trigger a single state research to verify the pipeline**

From the Atlas project directory, run a quick inline test:

```bash
cd C:\Users\derek\Projects\atlas
bun -e "
import { runStateSweep } from './src/sage-research.ts';
const result = await runStateSweep();
console.log(JSON.stringify(result, null, 2));
" 2>&1 | head -50
```

This will research 3 states with all 6 topics. Verify:
- No API errors
- Chunks are created in maa_knowledge
- Quality scores are populated
- State file is written

- [ ] **Step 5: Restart Atlas to pick up new crons**

```bash
pm2 restart atlas
```

- [ ] **Step 6: Verify new crons are registered**

Check Atlas logs after restart:

```bash
pm2 logs atlas --lines 50 | grep -i "sage"
```

Should see the new cron jobs registered.

- [ ] **Step 7: Deploy maa-advisor to production**

After staging is verified:

```bash
cd C:\Users\derek\Projects\maa-advisor
git checkout main
git merge dev
git push origin main
```

- [ ] **Step 8: Commit any final fixes**

```bash
cd C:\Users\derek\Projects\atlas
git add -A
git commit -m "chore: integration fixes for SAGE knowledge engine"
```
