# atlas-prime-beacon

Public Merkle-root beacon for **Atlas Prime**'s action ledger.

## What this is

Every action Atlas (Derek DiCamillo's personal AI) takes is signed and chained
in a local append-only ledger. Once an hour the chain's current root is
published to this public repository.

The point: any external party can verify that Atlas's local ledger has not
been silently rewritten. If the root in this repo matches a locally-computed
root over the same snapshot of the chain, the chain is internally consistent
and externally attested.

## Files

- `roots/latest.json` — the most recently published root
- `roots/YYYY-MM-DD.jsonl` — one root record per hour for that UTC day
- `verify/verify-beacon.ts` — standalone verifier (Bun / Node, no deps beyond stdlib)
- `BOUNTY.md` — standing bounty for verifiable inconsistencies

## How to verify

```bash
bun verify/verify-beacon.ts --against=<path-to-local-ledger-snapshot>
```

Exit 0 = match. Exit 1 = mismatch (and likely a bounty claim).

## Protocol

Each published record:

```json
{"ts": "2026-05-14T15:00:00.000Z", "root": "<sha256-hex>", "entries": 12345}
```

Roots chain backward: every record in `roots/YYYY-MM-DD.jsonl` must extend the
chain whose root is recorded in the prior file. A break in this chain is itself
a bounty-eligible finding.

## Publisher key

This repo's commits are signed by `data/beacon-publisher.key`. The public half
is in `PUBLISHER.pub`. Any commit not signed by that key is suspect.
