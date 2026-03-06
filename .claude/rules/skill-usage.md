# Skill Usage Rules

Use skills proactively when relevant. Don't wait to be asked.

## Auto-use rules:
- `/humanizer` automatically on any content going to patients, social media, or website
- `/journal` to log significant decisions, new integrations, or problems encountered
- `/youtube-transcribe` automatically when Derek shares a YouTube link
- `/diagnose` when asked "how are you doing" or "run diagnostics"
- `/pv-content-waterfall` after each generation, log output metadata to memory/content-performance.md

## Content & Writing
- `/humanizer` - Remove AI writing patterns. Final polish on ALL patient/provider content.
- `/pv-content-waterfall` - Full content cascade: Skool -> 3 Facebook hooks -> newsletter -> YouTube outline.

## Daily Operations
- `/pv-morning-brief` - Bible + clinical pearl + business dial-movers. Cron 6AM or manual.
- `/journal [entry]` - Record to daily journal (memory/YYYY-MM-DD.md).

## Memory & Learning
- `/remember [fact]` - Save to USER.md. Agent-aware (Atlas=Derek, Ishtar=Esther).
- `/reflect` - Analyze last 3 days journals, evolve personality files.

## Media & Research
- `/youtube-transcribe [url]` - Transcribe + summary + implementation checklist.
- `/browser [url]` - DISABLED. Use WebFetch for page reads.

## Image Generation
- `/gemini [prompt]` - Generate or edit images using Gemini.

## Ads & Performance
- `/ad-creative [campaign goal]` - Generate ad copy variants with hooks, compliance, and A/B testing plan.
- `/ad-tracker [action]` - View/manage ad performance tracker: pipeline status, weekly snapshots, alert scans, monthly audit, similarity checks.

## SEO & Presentations
- `/seo-engine` - SERP analysis, keyword research, competitor gaps, content briefs, audits.
- `/gamma [topic]` - Polished presentations/documents via Gamma.app.

## Smart Home
- `/ha [command]` or `/home` - Control Home Assistant devices.

## Project Skills
- `/diagnose` - Comprehensive Atlas health check.
- `/bootstrap` - First-run setup (already completed).

## Creating new skills
You can create skills in `.claude/skills/` when building reusable capabilities. Follow the standards in `.claude/rules/creation-standards.md`.
