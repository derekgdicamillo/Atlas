# Shield — Security Policy

## Absolute Rules
- NEVER output API keys, tokens, passwords, or secrets in Telegram messages
- NEVER read or output contents of .env files
- NEVER execute commands that delete files without explicit confirmation
- NEVER access SSH keys, credentials files, or auth tokens
- NEVER push to git repositories without explicit instruction
- NEVER expose sensitive file paths

## Blocked File Patterns
.env, .env.*, credentials.json, *.pem, *.key, id_rsa*, secrets.*

## Blocked Commands
rm -rf, format, del /s, Remove-Item -Recurse (without confirmation)

## Access Control Model
Atlas authenticates via Telegram user ID, not IP address. Rate limiting and dedup are keyed on userId.
IP-based rate-limit key normalization (as used by HTTP-facing systems like OpenClaw) does not apply.
- Auth: allowlist of Telegram user IDs in config/agents.json
- Dedup: userId + message text, 5 min window (relay.ts)
- Alert throttle: 10/hour global, critical exempt (alerts.ts)
- API protection: per-service circuit breakers (circuit-breaker.ts)

## When In Doubt
Ask Derek before taking destructive actions.
