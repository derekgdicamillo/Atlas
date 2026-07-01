---
name: fb-intake
description: >-
  Bulk-ingest Facebook group screenshots and upload extracted contacts to the Brevo FB Group
  Leads list. Pure ingest + upload, NO screening or gatekeeping (members are pre-screened by
  Derek/Esther). Scales to 100+ screenshots via chunked parallel extraction. Use when Derek or
  Esther drops FB group screenshots or says "add these to the FB list", "process these
  screenshots", "ingest these", "new FB leads".
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Agent
context: fork
model: haiku
user-invocable: true
argument-hint: "[folder path or screenshots]"
metadata:
  author: Atlas
  version: 2.0.0
---

# FB Group Lead Intake v2 — Bulk Ingest

Screenshots → chunked parallel extraction → code-based dedup + bulk upload to Brevo List 6.

**This skill does NOT screen, judge, or gatekeep.** Contacts are pre-screened by humans before
they reach this skill. Never decline a contact for credential/quality reasons. The ONLY reasons
a contact is not uploaded: no email visible, invalid email, or already on a TMAA list.

## Workflow

### Step 1: Collect image paths
- If `$ARGUMENTS` is a folder path: `Glob` for `*.{jpg,jpeg,png,webp}` in it.
- If images were attached to the message: use those file paths directly.
- Report: "Found N screenshots, processing in M chunks." Then proceed without waiting.

### Step 2: Chunked parallel extraction (subagents)
Split paths into chunks of 8. Run `mkdir -p tmp/fb-intake && rm -f tmp/fb-intake/chunk-*.json tmp/fb-intake/merged.json`. 

Spawn **ALL** chunk subagents in parallel via the Agent tool. Each subagent reads 8 images and extracts member entries, writing JSON to `tmp/fb-intake/chunk-NN.json`. 

**Critical:** Do NOT have subagents return contact data in their final message — the data goes to disk only. Each subagent returns only the count of entries extracted.

Each subagent prompt includes:
- Absolute paths to 8 image files
- Instructions to extract: name, email (character-for-character exact), details (role, location, business)
- Write format: JSON array `{"name", "email", "details", "sourceImage"}` to disk via Bash heredoc
- Instruction to return only the count, not the contact data itself

### Step 3: Merge
```bash
bun -e 'const g=new Bun.Glob("tmp/fb-intake/chunk-*.json");let all=[];for(const f of [...g.scanSync()].sort())all=all.concat(JSON.parse(require("fs").readFileSync(f,"utf8")));require("fs").writeFileSync("tmp/fb-intake/merged.json",JSON.stringify(all,null,1));console.log(all.length+" contacts merged from "+[...g.scanSync()].length+" chunks")'
```

Sanity check: if a chunk file is missing (subagent died), re-spawn just that chunk before merging.

### Step 4: Upload (no confirmation gate — pre-screened)
```bash
bun scripts/fb-intake-upload.ts tmp/fb-intake/merged.json
```

The script:
- Dedups against Lists 4/5/6 (Free/Pro/FB Group Leads)
- Uploads new contacts to List 6 with SOURCE="ANE Facebook Group"
- Writes audit file to `data/fb-intake/`
- Prints JSON summary to stdout

### Step 5: Report (one compact message)
From the script's JSON output:
- **Added X | Updated Y | Already on list Z | No email N | Errors E**
- **FB Group Leads total: [count]** (from Brevo)
- Audit file path
- If any no-email or error rows: list just the names so the user can re-shoot those screenshots.

## Rules
- **NEVER screen or decline contacts** for quality/credential reasons. Ingest everything with a valid email.
- **NEVER add to List 4 or 5.** The script enforces this; don't bypass it.
- **NEVER read screenshot images in the main context.** Always delegate to chunk subagents.
- **NEVER have subagents return contact data in replies.** Disk only.
- **No confirmation gate.** Upload, then report.

## Troubleshooting
- **Brevo errors**: script needs `BREVO_API_KEY` in `.env` at repo root
- **Missing chunk file**: subagent died — re-spawn that one chunk, then merge
- **Unreadable screenshot**: subagent notes it in details with empty email; shows up in the no-email list
