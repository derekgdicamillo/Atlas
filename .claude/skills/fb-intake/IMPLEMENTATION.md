# FB-Intake Skill Implementation

## How It Works

The skill is invoked with `$ARGUMENTS` containing either:
- A folder path: `/fb-intake /path/to/screenshots/`
- Direct image paths: `/fb-intake image1.jpg image2.jpg ...`

## Execution Steps

### 1. Parse Arguments & Collect Images
```bash
# If folder: glob for images
# If direct paths: validate and use
# Report: "Found N screenshots"
```

### 2. Prepare Workspace
```bash
mkdir -p tmp/fb-intake
rm -f tmp/fb-intake/chunk-*.json tmp/fb-intake/merged.json
```

### 3. Calculate Chunks
- Split N images into chunks of 8
- Calculate number of subagents needed (N/8, rounded up)
- Example: 25 images → 4 chunks (chunk-00, chunk-01, chunk-02, chunk-03)

### 4. Spawn Parallel Extraction Agents

For each chunk, spawn an Agent with:
- Image paths for that chunk (up to 8)
- Instructions to extract name, email, details, sourceImage
- Output path: `tmp/fb-intake/chunk-NN.json`
- **Critical**: Agent writes JSON to disk, returns ONLY the count

Example subagent prompt:
```
Read these images: [paths]
Extract every member: name, email (exact), details, sourceImage
Write JSON to tmp/fb-intake/chunk-00.json using Bash heredoc
Return only the count extracted, not the data
```

### 5. Monitor Completion & Merge
```bash
# Wait for all subagents to complete
# Check all chunk files exist
# If missing: re-spawn that chunk
# Merge: cat chunk-*.json | jq -s 'add'
```

### 6. Upload to Brevo
```bash
bun scripts/fb-intake-upload.ts tmp/fb-intake/merged.json
```

### 7. Parse & Report Results
From script output:
- Added count
- Updated count
- Already on list counts
- No email count
- Error details
- FB Group Leads total
- Audit file path

## File Locations

- **Input**: Direct paths or glob from folder argument
- **Temp workspace**: `tmp/fb-intake/`
- **Chunk outputs**: `tmp/fb-intake/chunk-00.json`, `chunk-01.json`, etc.
- **Merged data**: `tmp/fb-intake/merged.json`
- **Upload script**: `scripts/fb-intake-upload.ts`
- **Audit output**: `data/fb-intake/audit-TIMESTAMP.json`

## Error Handling

1. **No images found**: Exit with usage message
2. **Subagent dies**: Detect missing chunk file, re-spawn
3. **Invalid emails**: Script skips them, reports in summary
4. **Brevo API error**: Script reports, audit file still created
5. **No BREVO_API_KEY**: Script fails with clear error

## Validation

- Email regex: `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$`
- Dedup: by normalized email (lowercase)
- Lists checked: 4 (Free), 5 (Pro), 6 (FB Group Leads)
