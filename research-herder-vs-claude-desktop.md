# Herder / herdr Research Report
**Research date:** September 2026  
**Context:** Solo operator, Windows 11, $200/mo Claude Max plan, evaluating in the Claude Code / Claude Desktop ecosystem

---

## Candidate Identification

Three products match the name "Herder" in the AI agent space. The primary candidate is almost certainly **herdr**.

### C1 — herdr (herdr.dev) ← PRIMARY CANDIDATE
Terminal multiplexer written in Rust, specifically for AI coding agents. 22K+ GitHub stars as of August 2026, YC Fall 2026 batch. This is what developers in the Claude Code / multi-agent space are evaluating.

### C2 — CodeHerder (codeherder.com)
A web-based orchestration dashboard for managing agents across machines and repositories. Requires users to bring their own API keys ("you're never billed for tokens" through CodeHerder). Positioned more for teams managing agents at scale. **Not Max plan compatible** — it bypasses OAuth entirely and needs API keys for billing.

### C3 — AgentHerder (agentherder.com)
Not a tool. It is a training program and 6-week bootcamp for developers who want to run 10+ parallel Claude Code sessions. The underlying tool it teaches is called **cctabs** (open source). The program offers paid coaching and certification. Not directly evaluable as software.

**Verdict:** A solo operator running Claude Code + Claude Desktop in September 2026 is almost certainly asking about **herdr**. The rest of this report covers herdr exclusively.

---

## What herdr Actually Is

herdr is an **AI-native terminal multiplexer** — think tmux, but purpose-built to understand coding agents. It runs as a background Rust daemon with a TUI (terminal UI) client that surfaces all your agent sessions in one view.

**Core value proposition in one sentence:** herdr shows you which of your parallel Claude Code sessions is blocked waiting for input, which is still working, and which is done — without switching windows or tabs.

### Architecture
- Single Rust binary (~10MB, no dependencies)
- Client-server model: herdr server runs in background, `herdr` client attaches
- Each terminal pane is a real PTY, not a simulation — full-screen TUI apps work correctly
- Persistent sessions survive terminal disconnects; reattach via SSH from anywhere
- Local Unix socket (or named pipe on Windows) for inter-agent communication
- 500+ community plugins as of August 2026

### Key Capabilities
| Feature | Details |
|---|---|
| Agent state tracking | Sidebar shows blocked / working / done / idle per pane |
| Parallel pane management | Unlimited panes, tabbed workspaces per project |
| Session persistence | Sessions survive client disconnect, laptop close, SSH drop |
| SSH remote reattach | Connect from another machine and resume sessions |
| Git worktree integration | `herdr worktree create` makes a checkout and groups it with the parent repo |
| Inter-agent socket API | `herdr agent prompt`, `herdr agent wait`, `herdr agent read` — one agent can drive another |
| Plugin ecosystem | 500+ community tools including notification bridges, Telegram bots, automation scripts |
| MCP (community) | Community-built MCP servers expose herdr pane control to Claude Code |

### What herdr Does NOT Have (Built-in)
- No GUI, no browser, no artifacts
- No scheduling / cron (community plugin `herdr-automations` fills this partially)
- No persistent memory layer
- No mobile app (SSH client on phone is the workaround)
- No built-in diff review or code browser
- No official Anthropic support or integration

---

## Who Makes It / Licensing / Pricing

| Item | Status |
|---|---|
| Creator | Can Celik (founder), solo developer turned YC-backed startup |
| Company | herdr (YC Fall 2026, announced August 6, 2026) |
| License | **Apache 2.0** (switched from AGPL on July 22, 2026) |
| Open source | Yes — the runtime is permanently open source per founder pledge |
| Price | Free (no paid tier exists as of September 2026) |
| Commercial license | Available for enterprise; no public pricing |
| Future monetization | Stated plan: paid hosted features / premium clients layered above the open runtime |

**License history matters:** herdr launched under AGPL-3.0, which requires any modifications to be open-sourced. The switch to Apache 2.0 before YC eliminates that obligation for corporate users. The community on Hacker News noted concern about the bait-and-switch trajectory ("open source until traction, then enshittification"), citing Warp terminal as a cautionary example. The developer's explicit pledge: "The runtime, what you use right now, stays free."

**Risk assessment:** YC-backed means investor pressure to monetize. The most likely path is paid hosted connectivity, premium plugins, or enterprise fleet management — the core terminal runtime itself is the lowest risk. Fork insurance: the Apache 2.0 license allows forking without copyleft obligations, so community forks are viable if enshittification happens.

---

## Authentication: Max Plan vs API Key

**Short answer: herdr has no Anthropic authentication of its own. Zero billing impact on your Max plan.**

herdr is a terminal multiplexer. It runs Claude Code (the official Anthropic CLI) inside its panes. Authentication happens entirely within the Claude Code process, not within herdr. The chain is:

```
Your Max plan → claude.ai OAuth token → Claude Code CLI → runs inside herdr pane
```

This is confirmed by Anthropic's own policy:
> "Running the official CLI on your machine or a remote server is entirely within the ToS. This is not a workaround — it's the intended use."

Anthropic's OAuth restrictions target **third-party clients that directly use your OAuth token** (OpenClaw, Cursor, Roo Code, etc.). A terminal multiplexer that wraps the official `claude` binary is not a third-party client in this sense. Your Max plan billing is unaffected.

**The one real risk:** If herdr (or any plugin/integration) sets the `ANTHROPIC_API_KEY` environment variable in a pane's shell environment, Claude Code will switch from OAuth to pay-per-token API billing silently. This has burned people: there was a confirmed incident where a bug in another harness caused $200+ in unexpected API charges to a Max plan user who had API keys in their environment. Verify that no `ANTHROPIC_API_KEY` is exported in your shell profile when using herdr.

**CodeHerder is different:** If you were evaluating CodeHerder instead, that tool explicitly requires bringing your own API keys. It would NOT work on Max plan subscription billing. This is a hard blocker for your setup.

---

## What herdr Does That Claude Desktop Does Not

| Capability | herdr | Claude Desktop |
|---|---|---|
| **Parallel agent sessions** | ✓ Unlimited panes, sidebar tracks all | ✗ One conversation at a time |
| **Agent state visibility** | ✓ blocked/working/done/idle per session | ✗ None |
| **Session persistence** | ✓ Survives disconnect, reattach from SSH | ✓ Conversation history preserved |
| **Background agent running** | ✓ Agents keep running when client detaches | ✗ Requires active window |
| **Git worktree integration** | ✓ Built-in, one agent per worktree | ✗ None |
| **Inter-agent orchestration** | ✓ Socket API, agents drive other agents | ✗ None |
| **Remote server agents** | ✓ SSH reattach to remote herdr server | ✗ None |
| **MCP support** | Via Claude Code's own MCP config | ✓ Native MCP support |
| **Community plugins** | ✓ 500+, including notification/automation | ✗ Limited extension |
| **Multi-model support** | ✓ Works with Codex, Gemini CLI, Devin, etc. | ✗ Claude only |

**The scenario where herdr wins decisively:** You are running three Claude Code sessions simultaneously — one writing tests, one debugging a separate module, one doing research. Without herdr you are constantly switching terminal tabs wondering which one is waiting for your input. herdr's sidebar tells you immediately. The socket API lets the research agent tell the debugging agent "I found something" without you polling.

---

## What herdr Loses Versus Claude Desktop

| Capability | Claude Desktop | herdr |
|---|---|---|
| **GUI / Artifacts** | ✓ Rich artifacts, rendered output | ✗ Terminal text only |
| **Mobile access** | ✓ iOS app with full capability | ✗ SSH client on phone only |
| **Official Anthropic support** | ✓ First-party app | ✗ Third-party, no Anthropic backing |
| **Stability** | ✓ Production-grade | ✗ Pre-1.0, active breaking changes |
| **MCP configuration** | ✓ Native UI for MCP servers | Delegated to Claude Code config files |
| **Persistent memory** | ✓ claude.ai conversation history | ✗ None built-in (Atlas handles yours) |
| **Artifacts / canvas** | ✓ Code and visual artifacts rendered | ✗ None |
| **Search / web** | ✓ Built-in web search | Via MCP in Claude Code |
| **Non-technical users** | ✓ Accessible GUI | ✗ Terminal-only, not accessible |

**These are not the same product class.** herdr and Claude Desktop are not alternatives to each other. Claude Desktop is a conversational AI interface with artifact generation. herdr is a process manager for running multiple coding agents in a terminal. The realistic comparison is herdr vs tmux, not herdr vs Claude Desktop.

---

## Real User Reports (Last 90 Days)

### Hacker News (July–August 2026)

**Positive signals:**
- "It's like zellij without the bloat" — performance praised, memory stays under 15MB with 6 panes
- "This works much better than tmux" for native scroll and mouse support
- Significant community adoption: 22K+ stars, 500+ plugins, Show HN and YC announcement both active threads
- "I love this tool so much I'd pay for it"
- One user reports using herdr on a stack of 10+ Claude Code sessions daily

**Skeptical signals:**
- "Another layer of keyboard shortcuts over my terminal...I don't see what it's doing that Wezterm and a bunch of splits does anyway?" — skepticism about the value add for one-agent workflows
- "Do people really run that many agents in parallel that they cannot comfortably multiplex them using just a terminal emulator?" — legitimate question for solo operators who are not power users
- YC announcement thread: multiple concerns about enshittification ("a lot of these products started open source...but after the early traction phase...the incentives seem to change"), with Warp terminal cited as cautionary example

### GitHub Issues (Open, September 2026)

| Issue | Severity | Platform |
|---|---|---|
| File descriptor leak causing whole-session crash (#3527) | P1 — Critical | macOS |
| Session restore segfault on reconnect (#3492) | High | macOS v0.8.2 |
| Pane click sends bare Escape, interrupts active Claude agent (#3480) | Medium | All |
| Agent status misreports idle while Gemini still generating (#3530) | Medium | All |
| Windows text rendering tearing with WezTerm (#3495) | Medium | Windows |
| IME Korean input loses final syllable (#3499) | Low | All |

**Notable:** The P1 file descriptor leak (#3527) is the most serious — it kills all workspaces and panes periodically on macOS. Not reported on Windows specifically, but worth monitoring.

### Windows-Specific Status
Windows support became "generally available" in v0.8.2 (August 19, 2026). Limitations confirmed:
- Uses ConPTY instead of Unix PTY; some TUI apps (vim, lazygit) have rendering issues
- Cannot be a remote target host (can only be the client connecting to Linux/macOS servers)
- Clipboard image bridge does not work in local panes
- Cursor may flicker or jump during active output
- Unicode/CJK rendering issues in some configurations
- Community workaround: WSL2 gives near-native Linux experience

**For Windows 11 specifically:** herdr works, but "beta minus" is a fair description. The core value (parallel panes, state sidebar) works. The advanced features (remote hosting, live server handoff) don't. Running herdr on WSL2 and connecting from Windows Terminal is the recommended path for the most reliable experience.

---

## Decision Framework

### When herdr wins

- You regularly run **2+ parallel Claude Code sessions** and spend time wondering which one is blocked
- You run Claude Code on a **remote server** and need SSH-reattach with persistent sessions
- You want **one agent to orchestrate other agents** via the socket API
- You already use multiple CLI coding agents (Claude Code + Codex + others) and want a unified view
- You want **git worktree-per-agent** isolation baked into your multiplexer

### When Claude Desktop wins

- You need **GUI artifacts** (rendered code, tables, images, interactive outputs)
- You're on **mobile** and need full capability
- You want **official Anthropic support and stability guarantees**
- You need a tool non-technical collaborators can use
- You are running **one agent at a time** (herdr adds friction without adding value here)

### These are complements, not alternatives

The practically correct answer: **herdr + Claude Desktop + Claude Code CLI** are three different tools for three different jobs.

- Claude Desktop: conversational interface, artifacts, mobile, non-coding work
- herdr: managing 2+ parallel Claude Code terminal sessions
- Claude Code CLI: the actual coding agent

### Switching cost

**Installing herdr:** Low. Single binary install, `brew install herdr` (macOS) or Powershell/curl on Windows. Claude Code integration via hook script takes minutes. No configuration migration needed.

**Switching away from herdr:** Near-zero. herdr is a wrapper; Claude Code sessions are unaffected. You lose nothing in your actual work if you stop using herdr. Your Max plan billing does not change in either direction.

**Risk of staying with herdr long-term:** The YC trajectory is the primary risk. The Apache 2.0 license means the community can fork, but the ecosystem (plugins, integrations) tends to follow the original project. If herdr goes proprietary beyond what you'd pay for, the path is: switch back to tmux or zellij with no data loss, wait for a community fork, or evaluate cmux (macOS-only, more polished GUI).

---

## Summary for a Solo Windows Operator on Max Plan

| Question | Answer |
|---|---|
| What is herdr? | Terminal multiplexer purpose-built for AI coding agents |
| Who makes it? | Can Celik / herdr (YC F26), solo → startup |
| License | Apache 2.0, runtime permanently free per pledge |
| Authentication | Transparent to Max plan — herdr wraps Claude Code CLI which uses your OAuth |
| Will it trigger API billing? | Not inherently. Risk only if `ANTHROPIC_API_KEY` leaks into shell env |
| Windows support | Generally available (v0.8.2) but less mature than macOS; WSL2 more reliable |
| Vs Claude Desktop | Different product class, not a replacement |
| Key gain over Claude Desktop | Parallel sessions, agent state visibility, SSH reattach |
| Key loss vs Claude Desktop | GUI, artifacts, mobile, official support, stability |
| Real issues | P1 file descriptor leak (macOS), Windows rendering quirks, pre-1.0 churn |
| Should you use it? | Yes if you regularly run 2+ parallel Claude Code sessions. No if you mostly run one at a time. |
| Switching cost | Near-zero in both directions |

---

## Sources

- [herdr HN thread: "Agent multiplexer that lives in your terminal"](https://news.ycombinator.com/item?id=48714802)
- [herdr joins Y Combinator announcement](https://herdr.dev/blog/herdr-is-joining-y-combinator/)
- [herdr YC HN thread (218 comments)](https://news.ycombinator.com/item?id=49201003)
- [HN: "I've tried herdr a couple of times..."](https://news.ycombinator.com/item?id=49208385)
- [herdr GitHub issues](https://github.com/herdrdev/herdr/issues)
- [herdr Windows beta docs](https://herdr.dev/docs/windows-beta/)
- [Windows support discussion #436](https://github.com/herdrdev/herdr/discussions/436)
- [Shareuhack: herdr 2026 guide](https://www.shareuhack.com/en/posts/herdr-terminal-agent-multiplexer-guide-2026)
- [herdr review — bitdoze.com](https://www.bitdoze.com/herdr-agent-multiplexer/)
- [tmux vs cmux vs herdr comparison](https://petronellatech.com/blog/tmux-vs-cmux-vs-herdr-2026-terminal-multiplexer-comparison/)
- [Best herdr alternatives — superset.sh](https://superset.sh/compare/herdr-alternative)
- [Anthropic bans subscription OAuth in third-party apps](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)
- [OpenClaw + Claude Code costs — OAuth vs API key](https://www.shareuhack.com/en/posts/openclaw-claude-code-oauth-cost)
- [Anthropic killed third-party Claude access — workarounds](https://kersai.com/anthropic-killed-third-party-claude-access-heres-every-workaround-that-still-works/)
- [awesome-herdr curated ecosystem guide](https://github.com/yigitkonur/awesome-herdr)
- [herdr enterprise DNA: zero-MCP agent messaging](https://enterprisedna.co/resources/ai-pulse/ai-pulse-2026-08-08-herdr-pitches-zero-mcp-agent-messaging-as-the-lighter-answer/)
- [Dotzlaw: herdr parallel agent sessions](https://dotzlaw.com/insights/claude-code-13-herdr-parallel-agent-sessions/)
- [CodeHerder — codeherder.com](https://codeherder.com/)
- [AgentHerder — agentherder.com](https://agentherder.com/)
- [claude -p API billing issue #37686 (Claude Code GitHub)](https://github.com/anthropics/claude-code/issues/37686)
- [herdr — AI Weekly](https://aiweekly.co/alerts/herdr-adds-agent-state-awareness-to-terminal-multiplexing)
- [herdr Rust agent multiplexer — andrew.ooo review](https://andrew.ooo/posts/herdr-agent-multiplexer-terminal-review/)
- [herdr aicoolies feature page](https://aicoolies.com/tools/herdr)
