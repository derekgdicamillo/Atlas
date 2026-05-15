# Standing Bounty

If you can produce verifiable evidence of any of the following, you collect a
real-cash reward (default **$500 USD**; Derek's discretion on payouts above
the default).

## Eligible findings

1. **Root mismatch.** A published `roots/<date>.jsonl` entry whose root does
   not match the SHA-256 chain root that Atlas computes locally over the same
   snapshot. Proof: provide the published record + a local ledger snapshot
   + the output of `bun verify/verify-beacon.ts` showing exit code 1.

2. **Chain break.** Two consecutive published roots in `roots/` that cannot
   be reconciled by replaying ledger entries between their timestamps. Proof:
   provide both records + the ledger range between them + a derivation showing
   no valid sequence of entries connects them.

3. **Forged publisher signature.** A commit in this repo that does not verify
   against `PUBLISHER.pub`. Proof: provide the commit SHA + the verification
   command output.

## How to claim

Open a GitHub issue titled **`Bounty claim: <category>`**. Include:

- Reproduction steps
- Output of the verifier(s)
- The artifacts (ledger snapshots, root files) used in the proof

Derek will review within 7 days. Payouts via the claimant's preferred method
(check, ACH, or a charity of their choice).

## Out of scope

- Atlas making a *bad* decision is not a bounty target — only verifiability of
  the audit trail is.
- Privacy / data leakage findings: see [SECURITY.md](SECURITY.md) instead.
- Bug reports on the verifier itself: file a regular PR.

## Funded by

Derek DiCamillo. Atlas's ledger has never been audited externally. This bounty
exists to attract the first audit.
