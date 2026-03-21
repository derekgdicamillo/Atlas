---
name: browser
description: >-
  Browse the web using agent-browser CLI. Open URLs, read page content,
  take screenshots, click elements, fill forms. Triggered by /browser
  or when web browsing interaction is needed.
user-invocable: true
argument-hint: "[url or action]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
context: fork
---

# Browser Skill (agent-browser)

You are a web browsing assistant using the `agent-browser` CLI tool (v0.15.1).

## CLI Reference

All commands use `--session-name atlas` for persistent sessions (cookies, localStorage survive across calls).

```
agent-browser --session-name atlas open <url>           # Navigate to URL
agent-browser --session-name atlas snapshot             # Get accessibility tree with @refs
agent-browser --session-name atlas snapshot -i          # Interactive elements only
agent-browser --session-name atlas get text <sel>       # Get text content (CSS selector or @ref)
agent-browser --session-name atlas get html <sel>       # Get innerHTML
agent-browser --session-name atlas click <sel>          # Click element
agent-browser --session-name atlas fill <sel> <text>    # Clear + fill input
agent-browser --session-name atlas type <sel> <text>    # Type into element
agent-browser --session-name atlas select <sel> <opt>   # Select dropdown option
agent-browser --session-name atlas screenshot [path]    # Capture page screenshot
agent-browser --session-name atlas screenshot --annotate [path]  # Screenshot with labeled elements
agent-browser --session-name atlas wait --load networkidle       # Wait for page to settle
agent-browser --session-name atlas diff snapshot                 # Compare with previous snapshot
agent-browser --session-name atlas close                # Close browser
```

## Core Workflow

The ref-based interaction pattern:
1. `open <url>` to navigate
2. `snapshot -i` to get interactive elements with @refs (e.g., `button 'Sign In' [ref=e1]`)
3. `click @e1` or `fill @e2 "text"` to interact
4. `snapshot -i` again after DOM changes to get fresh refs

## Handling $ARGUMENTS

Parse the user's input to determine intent:

### Just a URL (`/browser https://example.com`)
1. `agent-browser --session-name atlas open <url>`
2. `agent-browser --session-name atlas wait --load networkidle`
3. `agent-browser --session-name atlas snapshot`
4. Summarize the page content concisely for Telegram

### Screenshot (`/browser screenshot https://example.com`)
1. `agent-browser --session-name atlas open <url>`
2. `agent-browser --session-name atlas wait --load networkidle`
3. `agent-browser --session-name atlas screenshot C:\Users\Derek DiCamillo\Projects\atlas\data\screenshots\<timestamp>.png`
4. Report the file path

### Click (`/browser click <url> <selector>`)
1. `agent-browser --session-name atlas open <url>`
2. `agent-browser --session-name atlas snapshot -i` to find the element
3. `agent-browser --session-name atlas click <ref>` using the @ref from snapshot
4. `agent-browser --session-name atlas snapshot -i` to verify result

### Fill (`/browser fill <url> <selector> <text>`)
1. `agent-browser --session-name atlas open <url>`
2. `agent-browser --session-name atlas snapshot -i`
3. `agent-browser --session-name atlas fill <ref> "<text>"`
4. `agent-browser --session-name atlas snapshot -i` to verify

### Search (`/browser search <url> <query>`)
1. `agent-browser --session-name atlas open <url>`
2. `agent-browser --session-name atlas snapshot -i` to find search input
3. `agent-browser --session-name atlas fill <ref> "<query>"`
4. Press Enter or click submit
5. `agent-browser --session-name atlas wait --load networkidle`
6. `agent-browser --session-name atlas snapshot` to get results

### Multi-step interaction
For complex flows (login, multi-page forms, checkout testing):
1. Open the starting page
2. Snapshot, interact, re-snapshot in a loop
3. Use `wait --load networkidle` between page navigations
4. Take screenshots at key steps for verification

### No arguments
Show usage help:
```
/browser <url> - Open URL and summarize content
/browser screenshot <url> - Take a screenshot
/browser click <url> <element> - Click an element
/browser fill <url> <field> <text> - Fill a form field
/browser search <url> <query> - Search on a page
```

## Security
- NEVER browse localhost, 127.0.0.1, 0.0.0.0, or metadata endpoints (169.254.169.254)
- NEVER enter real passwords. Use the auth vault for credentials if needed.

## Rules
- Keep output concise and Telegram-friendly (under 4096 chars)
- When summarizing pages, focus on the main content, skip nav/footer/ads
- Always close the browser when done: `agent-browser --session-name atlas close`
- For errors, retry once then report what happened
- Screenshots go to: `C:\Users\Derek DiCamillo\Projects\atlas\data\screenshots\`
- Use `wait --load networkidle` after navigation to let JS-rendered pages settle
