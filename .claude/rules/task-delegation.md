# Task Delegation Rules

## Philosophy
You have full tool access. Use your judgment on what to handle inline vs delegate.
- **Inline**: quick edits, simple queries, single-file fixes, fast web lookups, file reads.
- **Delegate**: multi-file coding tasks, deep research, audits, anything that would take 3+ minutes.
- The main session blocks while running. Stay responsive. If something is genuinely quick, just do it. If it's going to take a while, delegate and get back to the user.

## Background Tasks (Research)
Delegate research/analysis: `[TASK: description | OUTPUT: file.md | PROMPT: instructions]`
Subagent runs independently (opus), output to data/task-output/.

RULES:
- Multi-source research (competitor analysis, regulatory deep-dives, market reports) should be delegated via [TASK:] tags. These genuinely take time.
- Analytical/audit tasks (CRO audits, landing page analysis, SEO audits, competitive analysis, content audits) should be delegated via [TASK:] tags.
- Simple web lookups (fact checks, single-source questions like "what's the latest on tirzepatide?") are fine to handle inline with WebSearch/WebFetch.
- When you say "research is running" or "spinning up agents", you MUST emit actual [TASK:] tags in that same response. Talking about delegation without tags = zero agents spawned.
- Spawn multiple [TASK:] tags in a single response for parallel research (they run concurrently).
- "run the nightly" / "run evolution" -> Tell Derek to use `/evolve` or `/nightly`. The evolution pipeline requires in-process execution. Only the `/evolve` slash command can trigger it properly.

## Code Tasks
For complex coding (3+ files, new features, architectural changes), delegate via code agents.
For quick fixes (typos, single-line changes, config tweaks), just do them inline.

**Primary (TodoWrite):** Call TodoWrite with CODE_TASK: prefixed entries. Most reliable method.

```
TodoWrite({todos: [
  {content: "CODE_TASK: cwd=C:\\Users\\derek\\Projects\\atlas | PROMPT: <detailed instructions>", status: "in_progress", activeForm: "<short description>"}
]})
```

**Secondary (text tags):** Also emit in your response text as backup:
`[CODE_TASK: cwd=<dir> | PROMPT: instructions]` or `[CODE_TASK: cwd=<dir> | TIMEOUT: 120m | PROMPT: instructions]`

RULES:
- For delegated code tasks, use BOTH TodoWrite AND text tags. Belt and suspenders.
- When spawning multiple code agents, put ALL entries in ONE TodoWrite call (they run in parallel).
- BEFORE delegating, spend 1-3 tool calls (Read, Grep, Glob) to understand the current state of the code being changed. Include relevant context in your CODE_TASK prompt. A well-informed prompt = a successful code agent.
- NEVER describe dispatching agents without actually calling TodoWrite and emitting tags.
- Known dirs: Atlas=C:\Users\derek\Projects\atlas, PV Dashboard=C:\Users\derek\Projects\pv-dashboard, OpenClaw=C:\Users\derek\.openclaw
- Code agent: opus, 500 tools, 180 min (custom timeout via TIMEOUT field).
- When any code agent modifies an integration module (ghl.ts, google.ts, dashboard.ts, gbp.ts, analytics.ts, meta.ts, search.ts, graph.ts, supervisor.ts, modes.ts), it MUST also update the matching capabilities section in `.claude/rules/capabilities.md`.

### Routing examples:
- "fix the typo in relay.ts" -> Read the section, fix it inline (quick)
- "change the timeout from 5 to 10" -> Read, edit inline (single change)
- "add a /health command" -> Delegate via [CODE_TASK:] (new feature, multiple files)
- "refactor the supervisor system" -> Delegate via [CODE_TASK:] (multi-file, architectural)
- "what does the webhook handler do?" -> Read the file, answer directly
- "run a CRO audit on this page" -> [TASK:] (analytical, multi-step)
- "compare us to competitors" -> [TASK:] (multi-source research)
- "what's tirzepatide's latest price?" -> WebSearch inline (quick fact check)
- "research GLP-1 market trends" -> [TASK:] (deep research)

## Document Ingestion
When asked to analyze, review, or find content in documents/folders, ALWAYS ingest into the knowledge base first, then search. NEVER spawn a code agent to read PDF/DOCX files directly.

Tag: `[INGEST_FOLDER: path=<absolute_path> | SOURCE: <source_name> | QUERY: <what to search after>]`
Known paths: OneDrive: C:\Users\derek\OneDrive - PV MEDISPA LLC, Atlas: C:\Users\derek\Projects\atlas, Training: C:\Users\derek\Projects\atlas\data\training

Routing:
- "Analyze the PDFs on OneDrive" -> [INGEST_FOLDER:] then search. NOT [CODE_TASK:]
- "Fix the code in relay.ts" -> Fix inline or [CODE_TASK:] depending on complexity
