---
name: demo-recorder
description: >-
  Automated website/app demo recording using Playwright + OBS. Records
  screen interactions with smooth cursor movements for marketing videos.
  Use when Derek asks to record a demo, walkthrough, or product video.
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
context: fork
user-invocable: true
argument-hint: "[step-file | --url URL | --status | --stop]"
metadata:
  author: Atlas
  version: 1.0.0
---

# Demo Recorder

Record automated website/app demos using Playwright (browser automation) + OBS (screen recording) + ghost-cursor (human-like mouse movements).

## Usage

- `/demo-recorder pvmedispa-walkthrough` — Run the PV MediSpa walkthrough
- `/demo-recorder --url https://example.com` — Quick-record any URL (auto scroll)
- `/demo-recorder --status` — Check OBS connection and recording state
- `/demo-recorder --stop` — Stop an active OBS recording

## Instructions

### Parse $ARGUMENTS and run

```bash
cd "C:\Users\Derek DiCamillo\atlas" && bun scripts/record-demo.ts $ARGUMENTS
```

The script handles all CLI modes:
- **Step file**: `bun scripts/record-demo.ts pvmedispa-walkthrough` (resolves from `scripts/demo-steps/`)
- **URL mode**: `bun scripts/record-demo.ts --url https://pvmedispa.com`
- **Status**: `bun scripts/record-demo.ts --status`
- **Stop**: `bun scripts/record-demo.ts --stop`

### Available Step Files

| File | Description |
|------|-------------|
| `pvmedispa-walkthrough.json` | Full PV MediSpa site + weight loss landing page |
| `example.json` | Template showing all step types |

### Creating New Step Files

Write JSON to `scripts/demo-steps/<name>.json`:

```json
{
  "name": "Demo Name",
  "url": "https://target-site.com",
  "viewport": { "width": 1920, "height": 1080 },
  "obs": { "scene": "Demo Scene", "recordOnStart": true },
  "steps": [
    { "action": "wait", "ms": 2000, "label": "Let page load" },
    { "action": "scroll", "y": 500, "smooth": true },
    { "action": "click", "selector": "#cta-button" },
    { "action": "hover", "selector": ".nav-menu" },
    { "action": "type", "selector": "input.search", "text": "weight loss", "delay": 80 },
    { "action": "highlight", "selector": ".testimonial", "color": "red", "duration": 2000 },
    { "action": "scroll-to", "selector": "#pricing" },
    { "action": "screenshot", "name": "pricing-section" },
    { "action": "scene", "sceneName": "Outro" },
    { "action": "navigate", "url": "https://other-page.com" }
  ]
}
```

### Step Types

| Action | Required Fields | Description |
|--------|----------------|-------------|
| `navigate` | `url` | Go to a new URL |
| `click` | `selector` | Human-like cursor move + click |
| `hover` | `selector` | Move cursor to element |
| `type` | `selector`, `text` | Click element then type with delay |
| `scroll` | `y` (and/or `x`) | Smooth pixel scroll (default smooth) |
| `scroll-to` | `selector` | Smooth scroll element into view |
| `wait` | `ms` | Pause for milliseconds |
| `screenshot` | `name` (optional) | Save PNG to demo-steps/ |
| `scene` | `sceneName` | Switch OBS scene |
| `highlight` | `selector` | Flash colored outline around element |

## Prerequisites

- OBS must be running with WebSocket Server enabled (Tools > WebSocket Server Settings)
- `OBS_WS_PASSWORD` must be set in `.env`
- Playwright + ghost-cursor installed (`bun add playwright ghost-cursor`)
- Chromium installed (`npx playwright install chromium`)

## Troubleshooting

- **OBS connection failed**: Check OBS is open and WebSocket server is enabled on port 4455
- **Browser doesn't open**: Run `npx playwright install chromium` to install browser
- **Selector not found**: Use browser DevTools to verify CSS selectors. Script waits 10s before timeout.
- **Recording has no cursor**: ghost-cursor moves the system cursor. Make sure OBS is capturing the screen (not just window).
