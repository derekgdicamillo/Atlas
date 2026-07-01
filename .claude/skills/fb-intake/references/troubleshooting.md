# Troubleshooting Guide

## Issue: "No BREVO_API_KEY set"

**Cause**: Environment variable not configured in `.env`

**Solution**:
1. Check `.env` file exists at repo root
2. Add: `BREVO_API_KEY=your_key_here`
3. Restart Atlas for changes to take effect

**Test**:
```bash
echo $BREVO_API_KEY
```

## Issue: Subagent hangs or times out

**Cause**: Image too large, network issue, or agent processing time exceeded

**Solution**:
1. Check image file sizes (aim for <5MB per image)
2. Re-spawn the failed chunk manually
3. Check that the output path is writable: `ls -la tmp/fb-intake/`

**Prevention**:
- Keep images compressed (JPEG, not TIFF)
- Reduce resolution if very high-res screenshots

## Issue: Missing chunk file after subagent completes

**Cause**: Subagent crashed before writing output, or Bash heredoc failed

**Solution**:
1. Check if partial file exists: `ls -la tmp/fb-intake/chunk-NN.json`
2. If empty or corrupted, delete it
3. Re-spawn the subagent for that chunk only
4. Merge again

**Debug**: Ask the subagent to manually verify the write:
```bash
ls -la tmp/fb-intake/chunk-00.json
head tmp/fb-intake/chunk-00.json
```

## Issue: "Invalid email" for valid-looking emails

**Cause**: Regex validation is strict: `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$`

**Examples that fail**:
- `jane@localhost` (no TLD)
- `jane@example` (TLD too short)
- `jane @example.com` (space in local part)

**Solution**:
- Transcribe email exactly as shown in screenshot
- If email is cut off or unreadable, leave empty (details field explains why)
- Do NOT guess or autocomplete

## Issue: "Duplicate email in batch"

**Cause**: Same email appears in multiple screenshots within this batch

**Solution**:
1. Check audit file for which images have the duplicate
2. Verify which is correct (name match, credentials, location)
3. Next batch: only screenshot the correct one

**Prevention**: Coordinate screenshot collection to avoid overlap

## Issue: Contact added but not updating

**Cause**: Contact already on List 6; `updateEnabled=true` applies only if record exists

**Expected**: If contact not on any list, they are `added` (status 201)
If contact already on List 6, they are `updated` (status 204) or skipped if unchanged

**Verify**:
1. Check audit file for status
2. Search Brevo UI for contact email
3. If on List 6, verify attributes (FIRSTNAME, LASTNAME, SOURCE) are correct

## Issue: "Already a member" for someone who should be added

**Cause**: Email is on List 4 (Free) or List 5 (Pro)

**Why**: TMAA members (Free or Pro) are protected — never moved to FB Group Leads

**Solution**:
- Confirm if this person is actually a TMAA member
- If yes, they should NOT be in FB Group Leads (expected behavior)
- If no, check Brevo manually for email variations (case, extra spaces, etc.)

## Issue: Merge command produces empty JSON

**Cause**: No chunk files exist or all are empty

**Solution**:
1. Check directory: `ls tmp/fb-intake/chunk-*.json`
2. If empty, re-run extraction for all chunks
3. If only some missing, re-run those chunks and merge again

**Debug**:
```bash
cat tmp/fb-intake/chunk-00.json | jq length  # count entries
```

## Issue: Brevo API returns 429 (rate limit)

**Cause**: Too many requests in short time

**Built-in**: Script adds 120ms delay between uploads (automatic)

**If still hitting limit**:
- Increase delay in upload script: `setTimeout(r, 240)` instead of 120
- Split batch into smaller uploads
- Contact Brevo support for higher limits

## Issue: "No images found in folder"

**Cause**: Folder path is wrong, or images are in subfolder

**Solution**:
1. Verify folder path: `ls /path/to/folder/`
2. Check image extensions: must be .jpg, .jpeg, .png, or .webp
3. If images in subfolder, glob that: `/fb-intake /path/to/folder/subdir/`

## Issue: Audit file not created

**Cause**: Disk write permission issue, or bad output path

**Solution**:
1. Check directory exists: `mkdir -p data/fb-intake`
2. Check permissions: `ls -la data/`
3. Check disk space: `df -h .`

## Issue: Email transcription is wrong (Subagent error)

**Cause**: OCR misread, or handwriting quality in screenshot

**Solution**:
1. Check audit file for the contact with wrong email
2. Re-screenshot that member's entry (clearer crop)
3. Re-run extraction for just that screenshot (or manually correct merged.json)
4. Re-upload: `bun scripts/fb-intake-upload.ts tmp/fb-intake/merged.json`

**Manual correction**:
```bash
# Edit merged.json with correct email
vim tmp/fb-intake/merged.json
# Re-upload (will attempt to create/update)
```

## Verification Checklist

After upload completes:

- [ ] Check summary: Added > 0 or no new contacts expected?
- [ ] Check audit file: any skipped members who should be added?
- [ ] Check FB Group Leads total: did count increase?
- [ ] Check errors array: empty or acceptable?
- [ ] Verify in Brevo: spot-check a few added contacts

## Getting Help

If stuck:

1. **Check the audit file**: `cat data/fb-intake/audit-latest.json | jq .`
2. **Check a chunk file**: `cat tmp/fb-intake/chunk-00.json | jq .[0]`
3. **Check merged**: `cat tmp/fb-intake/merged.json | jq length`
4. **Test script directly**: `bun scripts/fb-intake-upload.ts tmp/fb-intake/merged.json --dry-run`
