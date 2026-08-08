# Buzz Family System — Design Spec

Date: 2026-08-08
Status: Approved (Derek), research-validated
Replaces: initial conversational design (same day)

## Purpose

One workspace where the whole family and the whole agent team live: Derek + Atlas,
Esther + Ishtar, Eden + Annabeth, plus Coach, Atlas Medicine, ToxTray, and worker
agents. Self-hosted Buzz relay as identity/audit/collaboration substrate; Claude
Code (Max plan) as the agent engine. Goals: AI-native household + business, code
from any device including phone, unified stack on an always-on machine, flat spend.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Interface | Full Buzz migration; everyone on Buzz mobile |
| Workspaces | PV MediSpa, TMAA, Prairie D Ranch (home), YouTube AI |
| Agent architecture | Bridge now, go native gradually |
| Agent engine | Claude Code CLI on Max plan (no API keys, no metered billing) |
| Relay home | Self-hosted (Docker on this machine). Hosted `prairiedranch.communities.buzz.xyz` = disposable sandbox only |
| Telegram | Stays as the notification/pager surface until Buzz ships mobile push (gate, not date; est. 3–6 mo) |

## Research findings that shaped the design (2026-08-08)

- **No mobile push in Buzz.** Not implemented (badge + foreground WebSocket only).
  Store apps exist and can join any relay via invite deep links, but nobody gets
  notified. → Telegram remains the pager until push ships.
- **Domain and relay private key are permanent.** Changing domain = new community;
  key rotation invalidates all history. → Choose forever-domain deliberately;
  back up keys from day one. Hosted-community history cannot migrate to self-host.
- **`buzz-acp` is a production-grade harness** (per-channel sessions, mention
  routing, mid-turn steering, `!cancel`/`!shutdown`, engram memory injection,
  typing/reactions, crash recovery, desktop observer view). Claude Code is a
  first-class runtime via `@agentclientprotocol/claude-agent-acp`
  (`BUZZ_ACP_AGENT_COMMAND=claude-agent-acp`). → Build far less custom bridge.
- **VERIFY EARLY:** claude-agent-acp must run on Max-plan claude.ai login, not
  demand ANTHROPIC_API_KEY. Fallback: wrap Claude Code CLI ourselves.
  (Desktop onboarding already set `preferred_runtime: claude` with no API key —
  promising signal.)
- **Buzz git hosting works today** (NIP-98 signed clone/push, e2e-tested).
  Branch-channels, PR review UI, CI = vision/preview only. → Relay is canonical
  remote, GitHub stays as mirror; don't design around unbuilt forge features.
- **Claude Code Remote Control** (official): steer a session on the always-on
  machine from the phone via URL/QR, Max plan included. → Phone-coding starts
  day one, independent of Buzz.
- **Buzz maturity:** 2.5 weeks post-launch, near-daily releases, Block dogfoods
  it internally; agent-permission bugs still churning (e.g., agents creating
  owner-hidden channels). → Pin image versions; clinical content stays out.
- NIP-OA owner attestation is a ~15-line offline signing step (or
  `cargo run --example compute_auth_tag`). No OAuth server involved.
- Message content limit 64 KiB (SDK) / 256 KB (relay); long output goes to
  canvas (kind 40100), threads, Blossom media, or git.
- Relay requires `BUZZ_ALLOW_NIP_OA_AUTH=true` for owner-attested agents;
  membership via `run.sh add-member` (sleep 1 between adds) or invite links.

## Architecture

### Relay (the home)
- `deploy/compose/` bundle: relay + Postgres 17 + Redis 7 + MinIO, via Docker
  Desktop (WSL2). Native Windows relay: not viable.
- Config: `RELAY_OWNER_PUBKEY` (Derek), `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`,
  `BUZZ_REQUIRE_AUTH_TOKEN=true`, `BUZZ_ALLOW_NIP_OA_AUTH=true`,
  `BUZZ_PUSH_GATEWAY_DELIVERY_URL=""` (don't talk to Block's push infra),
  image pinned to sha/semver tag.
- TLS: Caddy overlay (`BUZZ_COMPOSE_TLS=true`), real domain, DNS A record,
  80/443 open. Domain = forever choice (subdomain of a domain Derek owns and
  will never let lapse; "prairiedranch" naming).
- Backups (self-written script + Task Scheduler, nightly, same window):
  pg_dump, MinIO bucket (media + git packs), `deploy/compose/.env` secrets,
  relay key, owner key, every human/agent keypair. No tooling ships; we write it.

### Identity
- Humans: Derek, Esther, Eden — keys generated on their devices via invite links.
- Agents: one keypair each (Atlas, Ishtar, Coach, Annabeth, Medicine, ToxTray,
  workers), NIP-OA owner-attested: Atlas/Medicine/Coach ← Derek; Ishtar ← Esther;
  Annabeth ← Derek+Esther decision, attested by one owner.
- Eden's key joins Prairie D Ranch channels only.

### Channel map
- **PV MediSpa**: #general (Derek, Esther, Atlas, Ishtar — Joint Protocol becomes
  a real room), #metrics, #marketing (Midas output), #content.
  ⚠ #clinical / Atlas Medicine: NOT in Buzz until agent-permission layer settles.
- **TMAA**: #general, #newsletter (approval flow), #website
- **Prairie D Ranch**: #family, #eden (Annabeth), #fitness (Coach), #home (HA)
- **YouTube AI**: #channel-ops, #content-pipeline
- Per-repo/project channels created manually as needed (no auto branch-channels yet).

### Agents (hybrid bridge)
- **Path B — buzz-acp per persona** (coding + simpler personas): install
  claude-agent-acp; 6 env vars per persona (`BUZZ_PRIVATE_KEY`, `BUZZ_AUTH_TAG`,
  `BUZZ_RELAY_URL`, `BUZZ_ACP_AGENT_COMMAND`, `BUZZ_ACP_SYSTEM_PROMPT_FILE`,
  respond policy). ~half day per persona. Free: sessions, steering, memory,
  presence, desktop integration.
- **Path A — Bun bridge** (Atlas + Ishtar, whose value is TS-side logic: memory,
  crons, GHL/Google/Meta, metrics): small WS client per persona; port
  `web/src/shared/lib/{nostr-client,nostr-signer,nip98}.ts` + `kinds.ts`
  constants; NIP-OA tag in TS (~15 lines, test vectors in `docs/nips/NIP-OA.md`).
  HTTP bridge (`POST /events|/query|/count` + NIP-98) for non-realtime writes;
  or shell out to `buzz` CLI. ~1 week with shared client lib.
  Gotchas: always send explicit `kinds` in REQ (p-gate), ±15 min clock drift,
  64 KiB content cap, mention needs @DisplayName text AND p-tag.
- Atlas/Ishtar keep Telegram transport in parallel until push gate clears.

### Coding anywhere
- Now: Claude Code Remote Control on always-on machine (URL/QR from phone).
- Buzz path: repo channels + buzz-acp coding agents steered by mentions.
- Repos: relay = canonical remote (git-credential-nostr + git-sign-nostr),
  GitHub mirror retained while Buzz is pre-1.0.

### Native migration (gated, not dated)
- MCP-ify Atlas tool families one at a time (GHL → Google → dashboard/metrics).
- Persona-pack authoring for portability/validation (runtime loading not yet
  implemented in Buzz — content ports via system-prompt files today).
- Adopt push, workflows (approval gates), forge features, remote agents as they
  land in code.
- Telegram retires when: push ships AND mobile stabilizes for Esther/Eden.

## Phases

- **Phase 0 (weekend):** Reboot → Docker Desktop. Choose forever-domain. Stand up
  deploy/compose + Caddy TLS. Backup script + scheduled task. Derek's desktop app
  pointed at own relay. Verify claude-agent-acp uses Max login (kill criterion:
  if it demands API key and CLI-wrap fallback also fails, revisit engine choice).
- **Phase 1 (wk 1–2):** Channel map. Invite Esther + Eden (store mobile apps via
  invite links; sideload Android build only if store app fails against own relay).
  Mint + attest agent keys. Coding/worker personas on buzz-acp. Bun bridge for
  Atlas/Ishtar. Telegram parallel.
- **Phase 2 (wk 2–3):** Remote Control wired. Repos to relay (GitHub mirror).
  Per-project channels; agents mentioned into work.
- **Phase 3 (months):** MCP-ification, native personas, push-gated Telegram
  retirement, clinical channel revisit after permission layer settles.

## Risks

- Buzz pre-1.0 churn → pin versions, upgrade deliberately, GitHub mirror.
- No push → Telegram pager retained (primary UX risk neutralized).
- Single-machine SPOF → auto-start services, nightly backups; remote agents later.
- Agent permission bugs → conservative respond policies (`owner-only` first),
  no clinical data, review agent channel memberships weekly.
- Hosted sandbox history is disposable by design — don't invest in it.
