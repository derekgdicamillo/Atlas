---
name: record-session
description: >-
  Automated recording session: loads a teleprompter script, starts OBS
  recording, and controls the full workflow. Use when Derek says "record",
  "start recording", "record module 4", "film the CEU", "teleprompter",
  or wants to record a video with script and OBS control.
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - WebFetch
context: fork
user-invocable: true
argument-hint: "[module number or script name]"
metadata:
  author: Atlas
  version: 1.0.0
---
# Recording Session Controller

Automates Derek's recording workflow: teleprompter script loading, OBS recording control, and session management.

## Architecture

- **Teleprompter server**: `teleprompter/server.ts` (Bun, port 8585)
- **Teleprompter UI**: `http://localhost:8585` (open on iPad or Surface)
- **OBS control**: `src/obs.ts` (obs-websocket-js, port 4455)
- **Scripts**: `scripts/gamma-inputs/` (module-00.md through module-10.md, plus docs)

## Usage

`/record` - Show status of teleprompter + OBS, list available scripts
`/record <module>` - Load a module script and prep for recording
`/record start` - Start OBS recording + teleprompter scrolling
`/record stop` - Stop everything, report recording output file
`/record pause` - Pause OBS recording
`/record resume` - Resume OBS recording

## Instructions

### 1. Parse $ARGUMENTS

Determine the action from user input:

| Input | Action |
|-------|--------|
| (empty) | Show status |
| `start` | Start recording + scrolling |
| `stop` | Stop recording + scrolling |
| `pause` | Pause recording |
| `resume` | Resume recording |
| `1`, `01`, `module 1`, `module-01` | Load module script |
| `quickref`, `cheatsheet`, etc. | Load doc script |

### 2. Ensure Teleprompter Server is Running

Check if the teleprompter server is up:

```bash
curl -s http://localhost:8585/api/status
```

If it fails, start it:

```bash
cd C:\Users\derek\Projects\atlas && bun run teleprompter/server.ts &
```

Wait 2 seconds, then verify with status check.

### 3. Action: Show Status (no args)

1. GET `http://localhost:8585/api/status` for teleprompter state
2. Run this to check OBS:
   ```bash
   cd C:\Users\derek\Projects\atlas && bun -e "
     import { getStatus } from './src/obs.ts';
     const s = await getStatus();
     console.log(JSON.stringify(s));
   "
   ```
3. List available scripts:
   ```bash
   ls scripts/gamma-inputs/module-*.md scripts/gamma-inputs/doc-*.md
   ```
4. Report to Derek:
   - Teleprompter: running/stopped, script loaded (title), scrolling state
   - OBS: connected/disconnected, recording state, current scene
   - Available scripts with module numbers

### 4. Action: Load Script

1. Determine the script file from the argument:
   - Number input (e.g., `4`, `04`): map to `module-04.md`
   - Name input (e.g., `quickref`): map to matching file in `scripts/gamma-inputs/`
2. Read the script file to verify it exists
3. POST to teleprompter:
   ```bash
   # Read file content and POST it
   cd C:\Users\derek\Projects\atlas
   bun -e "
     import { readFileSync } from 'fs';
     const text = readFileSync('scripts/gamma-inputs/MODULE_FILE', 'utf-8');
     const res = await fetch('http://localhost:8585/api/load', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ text, title: 'TITLE' })
     });
     console.log(await res.json());
   "
   ```
4. Tell Derek: script loaded, word count, estimated read time (~150 WPM for teleprompter)
5. Remind him to open `http://localhost:8585` on iPad/Surface if not already open

### 5. Action: Start Recording

1. Start OBS recording:
   ```bash
   cd C:\Users\derek\Projects\atlas && bun -e "
     import { startRecording } from './src/obs.ts';
     const r = await startRecording();
     console.log(JSON.stringify(r));
   "
   ```
2. Wait 1 second for OBS to stabilize
3. Start teleprompter scrolling:
   ```bash
   curl -s -X POST http://localhost:8585/api/scroll/start
   ```
4. Report: "Recording started. Teleprompter scrolling. Go time."

### 6. Action: Stop Recording

1. Stop teleprompter scrolling:
   ```bash
   curl -s -X POST http://localhost:8585/api/scroll/stop
   ```
2. Stop OBS recording:
   ```bash
   cd C:\Users\derek\Projects\atlas && bun -e "
     import { stopRecording } from './src/obs.ts';
     const r = await stopRecording();
     console.log(JSON.stringify(r));
   "
   ```
3. Reset teleprompter to top:
   ```bash
   curl -s -X POST http://localhost:8585/api/scroll/reset
   ```
4. Report: recording stopped, output file path if available

### 7. Action: Pause/Resume

For pause:
```bash
cd C:\Users\derek\Projects\atlas && bun -e "
  import { pauseRecording } from './src/obs.ts';
  console.log(JSON.stringify(await pauseRecording()));
"
```
Also stop teleprompter scroll: `curl -s -X POST http://localhost:8585/api/scroll/stop`

For resume:
```bash
cd C:\Users\derek\Projects\atlas && bun -e "
  import { resumeRecording } from './src/obs.ts';
  console.log(JSON.stringify(await resumeRecording()));
"
```
Also restart teleprompter scroll: `curl -s -X POST http://localhost:8585/api/scroll/start`

## Troubleshooting

- **Teleprompter not starting**: Check port 8585 is free. Kill stale process: `cmd /c "for /f \"tokens=5\" %a in ('netstat -ano | findstr :8585 | findstr LISTEN') do taskkill /F /PID %a"`
- **OBS not connecting**: Ensure OBS is open, WebSocket server is enabled (Tools > WebSocket Server Settings), and `OBS_WS_PASSWORD` is set in `.env`
- **Script not found**: Check `scripts/gamma-inputs/` for available files. Module numbers are 00-10.
- **Voice scroll not working on iPad**: WebSpeech API requires Chrome. Safari doesn't support it. Use keyboard/touch controls on iPad, voice on Surface.

## Examples

Derek says: "Record module 4"
1. Check teleprompter server is running
2. Read `scripts/gamma-inputs/module-04.md`
3. POST script to teleprompter
4. Report: "Module 4 loaded on teleprompter (3,847 words, ~25 min read). Open http://localhost:8585 on your iPad. Say 'record start' when you're ready."

Derek says: "/record start"
1. Start OBS recording
2. Start teleprompter scrolling
3. "Recording. Teleprompter rolling. You're live."

Derek says: "/record stop"
1. Stop scroll, stop recording, reset teleprompter
2. "Recording saved to [path]. Teleprompter reset. Nice work."
