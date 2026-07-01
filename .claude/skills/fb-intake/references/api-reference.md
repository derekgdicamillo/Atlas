# FB-Intake Skill API Reference

## Skill Invocation

### Direct Usage
```
/fb-intake
```

### With Folder Path
```
/fb-intake /path/to/screenshot/folder
```

### With Direct Image Paths
```
/fb-intake /path/to/image1.jpg /path/to/image2.jpg ...
```

## Workflow Overview

### Step 1: Image Collection
Input: folder path or direct image paths
Output: array of absolute file paths

Supported formats: `.jpg`, `.jpeg`, `.png`, `.webp`

### Step 2: Chunking
Splits N images into chunks of 8
- Chunk 0: images 0-7
- Chunk 1: images 8-15
- Chunk 2: images 16-23
- etc.

### Step 3: Parallel Extraction
Each chunk → separate Agent
- Reads up to 8 images
- Extracts: name, email, details, sourceImage
- Writes: `tmp/fb-intake/chunk-NN.json`
- Returns: extraction count only

### Step 4: Merge
Combines all chunk-*.json files into `tmp/fb-intake/merged.json`

### Step 5: Upload
Calls `bun scripts/fb-intake-upload.ts tmp/fb-intake/merged.json`

### Step 6: Report
Displays summary statistics and audit file path

## JSON Schema

### Extracted Contact (input from subagents)
```json
{
  "name": "Jane Marie Doe",
  "email": "jane@example.com",
  "details": "RN, Emergency Department, Phoenix Arizona",
  "sourceImage": "IMG_001.jpg"
}
```

**Fields:**
- `name` (string): Full name of the member
- `email` (string): Email address (empty if not visible)
- `details` (string): Role, credential, location, business info
- `sourceImage` (string): Filename of the source screenshot

### Upload Summary (output from upload script)
```json
{
  "dryRun": false,
  "inputCount": 25,
  "added": 18,
  "updated": 2,
  "alreadyOnTarget": 1,
  "alreadyFreeMember": 2,
  "alreadyProMember": 1,
  "dupInBatch": 0,
  "noEmail": 1,
  "invalidEmail": 0,
  "errors": [],
  "fbGroupLeadsTotal": 356,
  "auditPath": "data/fb-intake/audit-2026-06-29T17-30-00-dryrun.json"
}
```

**Fields:**
- `added`: New contacts created in List 6
- `updated`: Existing contacts in List 6 that were updated
- `alreadyOnTarget`: Already on List 6, skipped
- `alreadyFreeMember`: On List 4 (Free), never moved
- `alreadyProMember`: On List 5 (Pro), never moved
- `dupInBatch`: Duplicate email within this batch
- `noEmail`: No visible email in screenshot
- `invalidEmail`: Email failed format validation
- `errors`: Array of {email, error} for failed uploads
- `fbGroupLeadsTotal`: Final count of contacts on List 6 (from Brevo)

## Lists (Brevo)

| List ID | Name | Behavior |
|---------|------|----------|
| 4 | TMAA Free Members | Never add; skip if found |
| 5 | TMAA Pro Members | Never add; skip if found |
| 6 | FB Group Leads | Target upload list |

## Error Codes

### Validation Errors (returned in summary)
- `skipped_no_email`: No email visible in screenshot
- `skipped_invalid_email`: Email failed regex validation
- `skipped_dup_in_batch`: Duplicate email in this extraction batch
- `skipped_member_free`: Already on List 4
- `skipped_member_pro`: Already on List 5
- `skipped_already_on_target`: Already on List 6
- `error`: API or processing error (details in `errors` array)

### Runtime Errors
- `No BREVO_API_KEY set`: Missing environment variable
- `No contacts found in input`: Empty or malformed JSON
- `Subagent extraction failed`: Agent died or returned invalid output

## Performance

- **Chunk size**: 8 images per subagent (optimal balance)
- **Parallel agents**: All chunks run simultaneously
- **Upload rate limit**: 120ms between Brevo API calls (built-in)
- **Typical workflow**: 25 images → 3 chunks → ~2-3 minutes end-to-end

## Success Criteria

✓ All images processed
✓ No subagent failures (or caught and re-spawned)
✓ Merged JSON contains all extracted contacts
✓ Upload succeeds with 0 API errors
✓ Audit file created in data/fb-intake/

## Dry Run

To test without uploading:

Use the `--dry-run` flag when calling the script directly:
```bash
bun scripts/fb-intake-upload.ts tmp/fb-intake/merged.json --dry-run
```

This will:
- Validate all contacts
- Check dedup logic
- Simulate uploads (mark as `added`)
- Create audit file with `-dryrun` suffix
- NOT make any Brevo API POST calls
