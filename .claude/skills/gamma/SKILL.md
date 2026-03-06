---
name: gamma
description: >-
  Generate polished presentations, documents, social posts, or web pages via
  Gamma.app API. Use when Derek says "make a deck", "create a presentation",
  "gamma this", "build slides", or wants visual content from notes.
allowed-tools:
  - Bash
  - Read
  - Write
context: fork
user-invocable: true
argument-hint: "[topic or path to content file]"
---
# Gamma Document & Presentation Generator

Generate polished documents, presentations, social posts, or web pages via the Gamma.app public API. Gamma takes text/markdown input and produces beautifully designed visual output.

## Authentication

- **API Key**: Stored as Windows User environment variable `GAMMA_API_KEY` (also in `.env`)
- **Header**: `X-API-KEY: <key>`
- **Key format**: `sk-gamma-*`

Read the key at runtime:
```powershell
$apiKey = [System.Environment]::GetEnvironmentVariable('GAMMA_API_KEY', 'User')
```

## API Reference

**Base URL**: `https://public-api.gamma.app/v1.0`

### POST /generations — Create Content

```json
{
  "inputText": "string (1-100k tokens, markdown supported)",
  "textMode": "generate | condense | preserve",
  "format": "presentation | document | webpage | social",
  "exportAs": "pdf | pptx",
  "numCards": 1-60,
  "additionalInstructions": "string (max 2000 chars)",
  "textOptions": {
    "amount": "brief | medium | detailed | extensive",
    "tone": "string (max 500 chars)",
    "audience": "string (max 500 chars)",
    "language": "en"
  },
  "imageOptions": {
    "source": "aiGenerated | pictographic | unsplash | noImages",
    "style": "string (max 500 chars)"
  },
  "cardOptions": {
    "dimensions": "fluid | letter | a4 | pageless | 16x9 | 4x3 | 1x1 | 4x5 | 9x16"
  }
}
```

**textMode explained:**
- `generate` — Expands brief content into elaborate material
- `condense` — Summarizes lengthy text to fit
- `preserve` — Keeps original text, optionally restructures

**Dimensions by format:**
- Presentation: `fluid` (default), `16x9`, `4x3`
- Document: `fluid`, `pageless`, `letter`, `a4`
- Social: `1x1`, `4x5` (default), `9x16`

**Response**: `{ "generationId": "string" }`

### GET /generations/{generationId} — Check Status

Poll every 5-10 seconds until status is not `pending`.

**Completed response:**
```json
{
  "generationId": "string",
  "status": "completed",
  "gammaUrl": "string",
  "pdfUrl": "string",
  "pptxUrl": "string",
  "credits": { "deducted": 0, "remaining": 0 }
}
```

**Important**: Export URLs (pdfUrl/pptxUrl) may not appear on the first completed response. Do one additional GET after completion to retrieve final URLs. URLs expire. Download immediately.

### GET /themes — List workspace themes
### GET /folders — List workspace folders

## Rate Limits

- 50 generations per hour
- Input text: 1-100,000 tokens (~400k chars)
- Max cards: 60 (Pro), 75 (Ultra)

## Existing Scripts

Reusable PowerShell scripts already exist in `scripts/`:
- `gamma-generate.ps1` — Single document generation with polling (provider-facing defaults)
- `gamma-check.ps1` — Check status of a generation by ID
- `gamma-batch.ps1` — Build multi-file inputs from course modules
- `gamma-run-all.ps1` — Batch run all queued documents

## Workflow

### Quick generation (use existing script):
```powershell
& scripts/gamma-generate.ps1 -Title "My Document" -InputFile "path/to/content.md"
```

### Custom generation (for different audiences/formats):

1. **Read input content** (markdown, notes, outline)
2. **Choose parameters**:
   - `format`: document for handouts/reports, presentation for decks, social for posts
   - `textMode`: preserve for well-structured content, generate for brief notes, condense for long content
   - `tone`: match the audience (clinical education, patient-friendly, marketing, etc.)
   - `exportAs`: pdf or pptx as needed
3. **Submit via POST /generations**
4. **Poll GET /generations/{id}** every 5s until completed
5. **Download export file** immediately (URLs expire)

### Patient-facing documents:
```json
{
  "textMode": "preserve",
  "format": "document",
  "exportAs": "pdf",
  "textOptions": {
    "amount": "detailed",
    "tone": "Warm, clear, encouraging. Written for patients, not providers. 6th grade reading level.",
    "audience": "Adult patients on GLP-1 weight loss medication",
    "language": "en"
  },
  "imageOptions": { "source": "pictographic" },
  "cardOptions": { "dimensions": "letter" }
}
```

### Provider-facing documents:
```json
{
  "textMode": "preserve",
  "format": "document",
  "textOptions": {
    "amount": "detailed",
    "tone": "Professional, evidence-based, clinical education",
    "audience": "Physicians, NPs, PAs prescribing GLP-1 medications",
    "language": "en"
  },
  "imageOptions": { "source": "noImages" },
  "cardOptions": { "dimensions": "letter" }
}
```

### Presentations:
```json
{
  "textMode": "generate",
  "format": "presentation",
  "exportAs": "pptx",
  "textOptions": {
    "amount": "medium",
    "tone": "Professional, engaging",
    "language": "en"
  },
  "imageOptions": { "source": "aiGenerated", "style": "modern, clean, professional" },
  "cardOptions": { "dimensions": "16x9" }
}
```

## Error Handling

| Code | Meaning | Action |
|------|---------|--------|
| 400 | Bad request | Check required fields, char limits, enum values |
| 401 | Unauthorized | Check API key in X-API-KEY header |
| 403 | Out of credits | Need to purchase more at gamma.app/settings/billing |
| 429 | Rate limited | Wait and retry (50/hr limit) |
| 500/502 | Server error | Retry with backoff |

## Natural Language Mapping

| User says | Action |
|-----------|--------|
| "make a deck about X" | Generate presentation, export PPTX |
| "gamma this" / "gamma that" | Generate document from provided content |
| "create slides for X" | Generate presentation |
| "make a patient handout" | Generate document, patient-friendly tone, PDF export |
| "turn this into a doc" | Generate document from provided content |
| "make a social post" | Generate social format |

## Example Interaction

**User**: Make a deck about our GLP-1 weight loss program for a provider lunch-and-learn

**Atlas**: I'll create a presentation via Gamma.

[CODE_TASK: cwd=C:\Users\derek\Projects\atlas | PROMPT: Generate a Gamma presentation about PV MediSpa's GLP-1 weight loss program for a provider lunch-and-learn. Use format=presentation, textMode=generate, exportAs=pptx, 16x9 dimensions, professional tone targeting referring providers. Include program overview, medication options, patient selection, outcomes data, and referral process.]

**User**: Turn these notes into a clean PDF

**Atlas**: Sending your notes to Gamma as a document.

[CODE_TASK: cwd=C:\Users\derek\Projects\atlas | PROMPT: Generate a Gamma document from the provided notes. Use format=document, textMode=preserve, exportAs=pdf, letter dimensions.]
