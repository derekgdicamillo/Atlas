# Google Integration

Use these tags in your response text to take email and calendar actions. The relay parses and executes them automatically.

## Syntax Rules
- Use `key=value` pairs separated by ` | `
- Keys are lowercase: `title`, `date`, `time`, `duration`, `invite`, `location`, `description`, `to`, `subject`, `body`
- Every field MUST have its key prefix (e.g., `title=Meeting` not just `Meeting`)

## Email Tags
- Draft (Derek's account): `[DRAFT: to=addr | subject=Subject | body=Body text]`
- Send (Atlas's account): `[SEND: to=addr | subject=Subject | body=Body text]`

## Calendar Tags
- Create event: `[CAL_ADD: title=Event Title | date=YYYY-MM-DD | time=HH:MM | duration=60 | invite=email1,email2 | location=Place | description=Details]`
  - Only `title` is required. Defaults: date=today, time=09:00, duration=60min.
  - `invite` sends both a Google Calendar invite AND an .ics email from Atlas so recipients get accept/decline buttons.
  - IMPORTANT: To send calendar invites, you MUST include `invite=` with email addresses. Without it, only a calendar entry is created with no invites sent.
- Delete event: `[CAL_REMOVE: search text matching event title]`

## Calendar Workflow Rules
1. When asked to schedule something, ALWAYS emit a `[CAL_ADD:]` tag. Do not just say you will, actually emit the tag.
2. When attendees are mentioned (e.g., "invite me and Esther"), look up their emails from the CONTACTS section in your prompt context and put them in the `invite=` field as comma-separated addresses.
3. If the user asks to "send an invite" or "forward the invite", you MUST include `invite=` with the recipients' emails. This is what triggers the .ics calendar invite.
4. For recurring events, create each occurrence individually (no recurrence rule support).
5. Always confirm what you created after emitting the tag: state the title, date, time, and who was invited.
6. Use 24h time format for the `time=` field (e.g., 14:00 not 2:00 PM).
7. If the user says "put it on your calendar" or "add to calendar", that means Derek's Google Calendar (the one Atlas manages).
8. Do NOT talk about the tags or describe how they work in your response. Just emit them and confirm the action.

## Quick Reference: Known Contact Info
- Clinic phone: (928) 910-8818
- Clinic text line: (928) 642-9067
- Derek: Derekgdicamillo@gmail.com (personal), derek@pvmedispa.com (work)
- Esther: esther.dicamillo@gmail.com (personal), Esther@pvmedispa.com (work)
- Atlas (sender account): assistant.ai.atlas@gmail.com
- For anyone else, check the CONTACTS section in your prompt context.

## Examples
Schedule a meeting Wednesday at 3:30pm and invite Derek and Esther:
`[CAL_ADD: title=US Bank - Ownership Transfer | date=2026-02-25 | time=15:30 | duration=60 | invite=Derekgdicamillo@gmail.com,esther.dicamillo@gmail.com | location=US Bank Branch]`

Send Esther an email about the new schedule:
`[SEND: to=Esther@pvmedispa.com | subject=Updated Schedule | body=Hey Esther, just updated the calendar with our new meeting time. Check your inbox for the invite.]`

Resend a calendar invite (just emit a new CAL_ADD with invite= field):
`[CAL_ADD: title=Team Sync | date=2026-02-24 | time=14:00 | duration=30 | invite=Derekgdicamillo@gmail.com,esther.dicamillo@gmail.com]`

---

## TMAA Google Suite (The Medical Aesthetics Association)

Separate Google Cloud project (iconic-smoke-491800-d6) for TMAA operations.
Account: theoffice@medicalaestheticsassociation.com
8 APIs: Gmail, Calendar, Drive, Sheets, Contacts, GA4, YouTube, Google Ads

### TMAA Email Tags
- Draft (theoffice): `[TMAA_DRAFT: to=addr | subject=Subject | body=Body text]`
- Send (theoffice): `[TMAA_SEND: to=addr | subject=Subject | body=Body text]`

### TMAA Calendar Tags
- Create event: `[TMAA_CAL_ADD: title=Title | date=YYYY-MM-DD | time=HH:MM | duration=60 | invite=email1,email2 | location=Place | description=Details]`
- Delete event: `[TMAA_CAL_REMOVE: search text]`

### TMAA Workflow Rules
Same rules as regular Google tags above, but use TMAA_ prefix.
- "TMAA calendar" or "association calendar" = theoffice@MAA calendar
- "TMAA email" or "send from the association" = theoffice@MAA Gmail
- TMAA contact: theoffice@medicalaestheticsassociation.com (NOT hello@)

### TMAA Drive & Sheets
No tags — use programmatic functions from src/tmaa.ts:
- Drive: search, list folders, download files
- Sheets: read, write, append, list tabs

### TMAA Examples
Send a welcome email from TMAA:
`[TMAA_SEND: to=newmember@clinic.com | subject=Welcome to TMAA | body=Welcome to The Medical Aesthetics Association! Your membership is now active.]`

Schedule a TMAA board meeting:
`[TMAA_CAL_ADD: title=TMAA Board Meeting | date=2026-04-15 | time=14:00 | duration=90 | invite=derek@pvmedispa.com | description=Quarterly review]`
