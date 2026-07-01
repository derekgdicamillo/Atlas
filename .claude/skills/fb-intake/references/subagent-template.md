# Subagent Extraction Template

## What the Subagent Does

1. Receives 8 image file paths
2. Reads each image
3. Extracts member information visible in screenshots
4. Writes JSON to disk
5. Returns only the extraction count

## Input Format

The main skill passes:
- Array of up to 8 image paths (absolute paths)
- Chunk number (00, 01, 02, etc.)
- Output path template: `tmp/fb-intake/chunk-NN.json`

## Extraction Rules

For EACH member entry visible in the screenshot:
- **Name**: Full name as shown (e.g., "Jane Marie Doe")
- **Email**: Exact transcription, character-for-character
  - If partially cut off or unreadable: **omit and set to empty string**
  - Never guess or autocomplete
  - Only include valid email format
- **Details**: Visible role/credential, location, employer
  - Format: "RN at Phoenix Hospital, Arizona"
  - Include all visible info
- **SourceImage**: Filename of the screenshot this entry came from

## Output Format

JSON array, written via Bash heredoc:

```json
[
  {
    "name": "Jane Doe",
    "email": "jane@example.com",
    "details": "RN, Emergency Department, Phoenix Arizona",
    "sourceImage": "IMG_001.jpg"
  },
  {
    "name": "John Smith",
    "email": "",
    "details": "aesthetician (location not visible)",
    "sourceImage": "IMG_002.jpg"
  }
]
```

## Output Path

Write to: `tmp/fb-intake/chunk-NN.json` where NN is zero-padded chunk number.

Example: `tmp/fb-intake/chunk-00.json` for chunk 0, `tmp/fb-intake/chunk-01.json` for chunk 1.

## Write Method

Use Bash heredoc, NOT the Write tool:

```bash
cat > "tmp/fb-intake/chunk-00.json" << 'EOF'
[
  {"name":"Jane","email":"jane@example.com",...}
]
EOF
```

## Return Message

Return ONLY a one-line message with the count:

```
Extracted 12 contacts from 8 images
```

Do NOT include the contact data in your response. The data goes to disk only.

## Error Handling

- If image is unreadable/blank: note in details ("image unreadable"), set email to empty
- If screenshot format unknown: extract what you can, note in details
- If text is blurry: transcribe best effort, note uncertainty in details

## Validation

- Email format check happens downstream in the upload script
- No screening/approval: extract everything
- Include partial/unclear entries with empty email field
- The upload script will handle dedup and list checking
