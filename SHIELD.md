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

## When In Doubt
Ask Derek before taking destructive actions.
