# FB Intake Skill v2

Bulk-ingest Facebook group screenshots and upload extracted contacts to the Brevo FB Group Leads list.

## Quick Start

### Basic Usage
```bash
/fb-intake /path/to/screenshots/folder
```

### With Direct Paths
```bash
/fb-intake image1.jpg image2.jpg image3.jpg
```

## What It Does

1. **Accepts screenshots** (folder or direct paths)
2. **Extracts member info** in parallel (name, email, details)
3. **Deduplicates** against TMAA member lists
4. **Uploads to Brevo** List 6 (FB Group Leads)
5. **Reports** summary statistics

## Philosophy

- **No screening**: All valid emails are ingested (pre-screened by humans before reaching this skill)
- **Pure ingest**: No gatekeeping, no credential checks
- **Fast parallel extraction**: Processes 100+ screenshots efficiently via chunked subagents
- **Audit trail**: Full audit file saved for every run

## Files

### Core
- **SKILL.md** - Main skill definition (frontmatter + workflow)
- **IMPLEMENTATION.md** - Execution steps and architecture

### References
- **api-reference.md** - API schema, summary format, field definitions
- **subagent-template.md** - Instructions for extraction subagents
- **troubleshooting.md** - Error handling and common issues

### Supporting
- **execute.ts** - TypeScript execution skeleton (reference)
- **impl.md** - Implementation notes

## Architecture

```
Main Skill (fork context)
  ↓
Parse Args → Collect Images
  ↓
Chunk Images (size 8)
  ↓
Spawn Agents (parallel)
  ├→ Agent 0: extract chunk-00.json
  ├→ Agent 1: extract chunk-01.json
  └→ Agent N: extract chunk-NN.json
  ↓
Merge Results
  ↓
Upload to Brevo (bun script)
  ↓
Report Summary
```

## Key Constraints

- **Tool access** (fork): Read, Glob, Grep, Bash, Agent only
- **No screenshots in main context**: Always delegate to subagents
- **Disk-only data**: Contact JSON never returned in replies
- **No confirmation gate**: Upload immediately after extraction
- **No screening**: Accept all valid emails

## Brevo Integration

**Target List**: List 6 (FB Group Leads)

**Protected Lists**:
- List 4 (TMAA Free Members) — never add
- List 5 (TMAA Pro Members) — never add

**Behavior**:
- Dedup against all three lists
- Only upload NEW contacts to List 6
- Update existing List 6 contacts if email matches
- Skip if already on Free/Pro lists

## Workflow Steps

### 1. Image Collection
- Glob folder for *.{jpg,jpeg,png,webp}
- Or use direct file paths
- Report count and chunk breakdown

### 2. Chunked Extraction (Parallel)
- Split N images into chunks of ⌈N/8⌉
- Each chunk → separate Agent
- Each Agent reads images, extracts, writes JSON
- Each Agent returns only the extraction count

### 3. Merge
- Combine all chunk-*.json files
- Sanity check for missing files
- Re-spawn any missing chunks

### 4. Upload
- Call `bun scripts/fb-intake-upload.ts tmp/fb-intake/merged.json`
- Script handles dedup and Brevo API
- Audit file created automatically

### 5. Report
- Display summary: Added | Updated | Already | No email | Errors
- Show FB Group Leads total
- Show audit file path
- List any contacts that need re-screenshot (no email, errors)

## Dependencies

- **Bun** (runtime for upload script)
- **BREVO_API_KEY** (environment variable)
- **Brevo API** (v3)
- **scripts/fb-intake-upload.ts** (backend upload)

## Testing

### Dry Run
```bash
bun scripts/fb-intake-upload.ts tmp/fb-intake/merged.json --dry-run
```

Validates without uploading.

### Single Chunk
Test extraction on a small batch:
```bash
# Prepare 2-3 test images
# Run: /fb-intake /path/to/test/images
```

### Manual Upload
```bash
# Edit tmp/fb-intake/merged.json
vim tmp/fb-intake/merged.json
bun scripts/fb-intake-upload.ts tmp/fb-intake/merged.json
```

## Success Indicators

✓ All images processed without subagent errors
✓ Merged JSON contains expected contact count
✓ Upload completes with 0 API errors
✓ Audit file created in `data/fb-intake/`
✓ `fbGroupLeadsTotal` increased by `added` count
✓ No unexpected "skipped_member_*" entries

## Common Issues

**No images found**
- Check folder path is correct
- Verify image extensions (.jpg, .png, .webp)

**Subagent hangs**
- Image file too large
- Retry the chunk

**"Already a member"**
- Email is on Free or Pro list (expected, never add)

**Invalid email**
- Transcription error or incomplete email in screenshot
- Mark in audit, re-shoot if needed

See **references/troubleshooting.md** for detailed troubleshooting.

## Performance

- **Chunk size**: 8 images per agent
- **Parallel**: All chunks run simultaneously
- **Upload rate**: 120ms between API calls (built-in)
- **Typical end-to-end**: 25 images → ~2-3 minutes

## Audit & Compliance

Every upload produces an audit file at `data/fb-intake/audit-TIMESTAMP.json` containing:
- Full input contact list
- Per-contact dedup decision (why skipped)
- Upload results (added, updated, errors)
- Brevo API response times

Audit files are retained indefinitely for compliance.

## Author
Atlas (v2.0.0)
