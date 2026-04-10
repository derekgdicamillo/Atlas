---
name: tmaa
description: >-
  Manage TMAA (The Medical Aesthetics Association) Google Suite: email, calendar, drive, sheets,
  contacts for theoffice@medicalaestheticsassociation.com. Use when Derek mentions TMAA, MAA,
  the association, theoffice email, or association calendar/drive/sheets.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - WebSearch
  - WebFetch
context: fork
user-invocable: true
argument-hint: "[action]"
metadata:
  author: Atlas
  version: 1.0.0
---

# TMAA Google Suite Integration

Manage The Medical Aesthetics Association's Google Suite via TMAA-prefixed intent tags.

## Accounts
- **Primary**: theoffice@medicalaestheticsassociation.com (full access: Gmail, Calendar, Drive, Sheets, Contacts)
- **Secondary**: derekgdicamillo@gmail.com (read, draft, calendar)
- **Google Cloud Project**: iconic-smoke-491800-d6 (production mode, tokens don't expire)

## 8 APIs Enabled
Gmail, Calendar, Drive, Sheets, Contacts (People API), GA4 Analytics, YouTube, Google Ads

## Intent Tags

### Email
- Draft (theoffice): `[TMAA_DRAFT: to=addr | subject=Subject | body=Body text]`
- Send (theoffice): `[TMAA_SEND: to=addr | subject=Subject | body=Body text]`

### Calendar
- Create event: `[TMAA_CAL_ADD: title=Title | date=YYYY-MM-DD | time=HH:MM | duration=60 | invite=email1,email2 | location=Place | description=Details]`
  - Only `title` is required. Defaults: date=today, time=09:00, duration=60min.
  - `invite=` triggers .ics calendar invite email from theoffice@MAA.
- Delete event: `[TMAA_CAL_REMOVE: search text matching event title]`

### Drive, Sheets, Contacts
These are accessed programmatically via `src/tmaa.ts` functions, not via tags:
- `tmaaSearchDriveFiles(query)` - search TMAA Drive
- `tmaaListDriveFolder(folderId)` - list folder contents
- `tmaaDownloadDriveFile(fileId, mimeType)` - download file content
- `tmaaReadSheet(spreadsheetId, range)` - read sheet data
- `tmaaWriteSheet(spreadsheetId, range, values)` - write sheet data
- `tmaaAppendSheet(spreadsheetId, range, values)` - append rows
- `tmaaListSheets(spreadsheetId)` - list sheet tabs
- `tmaaLookupContact(query)` - search contacts
- `tmaaListContacts(max)` - list recent contacts

## Key Contacts
- TMAA email: theoffice@medicalaestheticsassociation.com (NOT hello@)
- Website: medicalaestheticsassociation.com

## Context Injection
When intent detects TMAA-related messages, Atlas auto-injects:
- TMAA unread inbox (up to 5 emails)
- TMAA calendar events for today
- TMAA contacts (up to 10)

## Examples

Send an email from TMAA:
```
[TMAA_SEND: to=member@example.com | subject=Welcome to TMAA | body=Welcome to The Medical Aesthetics Association! We're excited to have you.]
```

Schedule a TMAA meeting:
```
[TMAA_CAL_ADD: title=TMAA Board Meeting | date=2026-04-15 | time=14:00 | duration=90 | invite=derek@pvmedispa.com,esther@pvmedispa.com | location=Virtual | description=Quarterly board review]
```

## Troubleshooting
- If TMAA emails fail: check that TMAA_GOOGLE_REFRESH_TOKEN_THEOFFICE is valid (run token verify curl)
- If Drive/Sheets fail: ensure the file is shared with theoffice@medicalaestheticsassociation.com
- GA4/YouTube/Ads not yet implemented: need property/channel/customer IDs in .env
